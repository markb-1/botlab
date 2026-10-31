import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LimitsSchema,
  MandateSchema,
  validateCrossFile,
  loadConfig,
  loadLimits,
  resolveConfigDir,
  ConfigError,
  DEFAULT_LIMITS_YAML,
  DEFAULT_MANDATE_YAML,
  DEFAULT_SERVER_YAML,
  ServerSchema,
  parseConfigYaml,
} from '../../electron/config';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-config-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text, 'utf8');

describe('config schema defaults', () => {
  it('empty input yields the spec §3.1 limits', () => {
    const limits = LimitsSchema.parse({});
    expect(limits.global).toEqual({
      max_total_exposure_usd: 300,
      max_total_exposure_pct: 0.6,
      max_long_horizon_pct: 0.25,
      daily_loss_limit_usd: 100,
      max_open_orders: 50,
    });
    expect(limits.per_bot_defaults.max_order_usd).toBe(25);
    expect(limits.per_market.max_spread).toBe(0.06);
    expect(limits.ramp.probation_allocation_usd).toBe(20);
    expect(limits.approvals.new_template_live).toBe(false);
  });

  it('empty input yields the spec §3.2 mandate', () => {
    const mandate = MandateSchema.parse({});
    expect(mandate.budget_usd).toBe(300);
    expect(mandate.categories.allow).toEqual(['weather-climate', 'economics', 'politics-non-us']);
    expect(mandate.categories.later).toEqual(['geopolitics', 'science-tech']);
    expect(mandate.markets.resolves_within_days).toEqual([0, 30]);
    expect(mandate.markets.long_horizon_days).toEqual([30, 90]);
    expect(mandate.markets.max_ambiguity_score).toBe(1);
  });

  it('default YAML files parse to the same values as the schema defaults', () => {
    expect(parseConfigYaml(LimitsSchema, DEFAULT_LIMITS_YAML, 'limits')).toEqual(LimitsSchema.parse({}));
    const mandate = parseConfigYaml(MandateSchema, DEFAULT_MANDATE_YAML, 'mandate');
    expect({ ...mandate, notes: '' }).toEqual(MandateSchema.parse({}));
  });

  it('committed example files match the built-in defaults', () => {
    const configDir = path.join(__dirname, '..', '..', 'config');
    expect(fs.readFileSync(path.join(configDir, 'limits.example.yaml'), 'utf8')).toBe(DEFAULT_LIMITS_YAML);
    expect(fs.readFileSync(path.join(configDir, 'mandate.example.yaml'), 'utf8')).toBe(DEFAULT_MANDATE_YAML);
    expect(fs.readFileSync(path.join(configDir, 'server.example.yaml'), 'utf8').replace(/\r\n/g, '\n')).toBe(DEFAULT_SERVER_YAML);
    expect(parseConfigYaml(ServerSchema, DEFAULT_SERVER_YAML, 'server')).toEqual(ServerSchema.parse({}));
  });

  it('a partial file keeps defaults for missing fields', () => {
    write('limits.yaml', 'global:\n  max_total_exposure_usd: 200\n');
    const limits = loadLimits(dir);
    expect(limits.global.max_total_exposure_usd).toBe(200);
    expect(limits.global.max_open_orders).toBe(50);
    expect(limits.per_bot_defaults.max_order_usd).toBe(25);
  });
});

describe('config loader', () => {
  it('writes default files when missing and returns defaults', () => {
    const cfg = loadConfig(dir);
    expect(fs.existsSync(path.join(dir, 'limits.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'mandate.yaml'))).toBe(true);
    expect(cfg.limits).toEqual(LimitsSchema.parse({}));
    expect(cfg.mandate.budget_usd).toBe(300);
  });

  it('creates a missing config directory', () => {
    const nested = path.join(dir, 'a', 'b');
    loadConfig(nested);
    expect(fs.existsSync(path.join(nested, 'limits.yaml'))).toBe(true);
  });

  describe('resolveConfigDir', () => {
    const home = path.join(path.sep, 'home', 'me');

    it('uses BOTLAB_CONFIG_DIR when set, even in production', () => {
      expect(resolveConfigDir({ BOTLAB_CONFIG_DIR: dir, NODE_ENV: 'production' }, 'linux', home)).toBe(dir);
    });

    it('defaults to <cwd>/config outside production', () => {
      expect(resolveConfigDir({}, 'darwin', home)).toBe(path.join(process.cwd(), 'config'));
    });

    it.each([
      ['darwin', {}, path.join(home, 'Library', 'Application Support', 'BotLab', 'config')],
      ['win32', { APPDATA: path.join(home, 'AppData', 'Roaming') }, path.join(home, 'AppData', 'Roaming', 'BotLab', 'config')],
      ['linux', {}, path.join(home, '.local', 'share', 'botlab', 'config')],
    ] as const)('uses the OS app-data dir in production on %s', (platform, env, expected) => {
      expect(resolveConfigDir({ ...env, NODE_ENV: 'production' }, platform, home)).toBe(expected);
    });
  });

  it('wraps filesystem errors in ConfigError', () => {
    // A regular file where the config directory should be
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    expect(() => loadConfig(path.join(blocker, 'config'))).toThrow(ConfigError);
  });

  it.each([
    ['negative limit', 'global:\n  max_total_exposure_usd: -1\n', 'global.max_total_exposure_usd'],
    ['wrong type', 'per_bot_defaults:\n  max_order_usd: lots\n', 'per_bot_defaults.max_order_usd'],
    ['unknown key (typo)', 'per_bot_defaults:\n  max_order_ud: 1000\n', 'per_bot_defaults'],
    ['pct above 1', 'global:\n  max_total_exposure_pct: 1.5\n', 'global.max_total_exposure_pct'],
    ['YAML syntax error', 'global: [unclosed\n', 'Invalid YAML'],
  ])('rejects an invalid limits file: %s', (_name, text, expected) => {
    write('limits.yaml', text);
    let err: unknown;
    try {
      loadLimits(dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain(expected);
    expect((err as ConfigError).message).toContain(path.join(dir, 'limits.yaml'));
  });

  it('rejects a mandate with a category in two lists', () => {
    write('mandate.yaml', 'categories:\n  allow: [sports]\n  deny: [sports]\n');
    expect(() => loadConfig(dir)).toThrow(/sports/);
  });

  it('rejects mandate horizons beyond 90 days', () => {
    write('mandate.yaml', 'markets:\n  long_horizon_days: [30, 120]\n');
    expect(() => loadConfig(dir)).toThrow(/90 days/);
  });

  it.each([
    ['default horizon past 30 days (would disable the long-horizon cap)', 'markets:\n  resolves_within_days: [0, 90]\n', 'resolves_within_days'],
    ['long horizon starting before 30 days', 'markets:\n  long_horizon_days: [20, 60]\n', 'long_horizon_days'],
  ])('rejects %s', (_name, text, expected) => {
    write('mandate.yaml', text);
    expect(() => loadConfig(dir)).toThrow(expected);
  });

  it('accepts narrower horizons within the fixed bounds', () => {
    write('mandate.yaml', 'markets:\n  resolves_within_days: [1, 14]\n  long_horizon_days: [45, 60]\n');
    expect(loadConfig(dir).mandate.markets.long_horizon_days).toEqual([45, 60]);
  });
});

describe('cross-file validation', () => {
  it('accepts the defaults', () => {
    expect(validateCrossFile(LimitsSchema.parse({}), MandateSchema.parse({}))).toEqual([]);
  });

  it('rejects mandate budget above the global exposure limit', () => {
    write('mandate.yaml', 'budget_usd: 301\n');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/budget_usd/);
  });

  it('accepts mandate budget exactly at the global exposure limit', () => {
    write('limits.yaml', 'global:\n  max_total_exposure_usd: 250\n');
    write('mandate.yaml', 'budget_usd: 250\n');
    expect(loadConfig(dir).mandate.budget_usd).toBe(250);
  });

  it('rejects max_order_usd above allocation_usd', () => {
    const limits = LimitsSchema.parse({ per_bot_defaults: { max_order_usd: 150, allocation_usd: 100 } });
    const errors = validateCrossFile(limits, MandateSchema.parse({}));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('max_order_usd');
  });
});
