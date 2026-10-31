import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import YAML from 'yaml';

vi.mock('../../packages/core/src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { ConfigService, renderYaml, type ConfigChangedEvent } from '../../packages/core/src/config/ConfigService';
import { RiskEngine } from '../../packages/core/src/risk/RiskEngine';
import { DEFAULT_LIMITS_YAML, ConfigError } from '../../packages/core/src/config';
import { sha256 } from '../../packages/core/src/config/history';
import { asHuman } from '../../packages/core/src/services/actors';

const HUMAN = asHuman('test');

interface AuditCall {
  actor: string;
  action: string;
  target: unknown;
  payload: any;
  result: unknown;
}

let dir: string;
let calls: AuditCall[];
const audit = { record: (actor: string, action: string, target?: unknown, payload?: unknown, result?: unknown) => void calls.push({ actor, action, target, payload: payload as any, result }) };

function service(opts: { debounceMs?: number } = {}): ConfigService {
  return new ConfigService({ configDir: path.join(dir, 'config'), historyDir: path.join(dir, 'history'), audit: audit as never, ...opts });
}
const limitsPath = () => path.join(dir, 'config', 'limits.yaml');
const edit = (from: string, to: string) => fs.writeFileSync(limitsPath(), fs.readFileSync(limitsPath(), 'utf8').replace(from, to));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-cfg-'));
  calls = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('ConfigService reload', () => {
  it('initial load creates all four files with defaults and records history', () => {
    const s = service();
    const cfg = s.load();
    expect(cfg.limits.global.max_total_exposure_usd).toBe(300);
    for (const f of ['limits', 'mandate', 'fees', 'server']) {
      expect(fs.existsSync(path.join(dir, 'config', `${f}.yaml`))).toBe(true);
      expect(s.history(f as never)).toHaveLength(1);
    }
  });

  it('an invalid edit keeps the previous config, audits config.invalid once and notifies', async () => {
    const s = service();
    s.load();
    const invalid: string[] = [];
    s.onInvalid((e) => invalid.push(e.error));

    edit('max_total_exposure_usd: 300', 'max_total_exposure_usd: -5');
    expect(await s.reload()).toBeNull();
    expect(s.getConfig()!.limits.global.max_total_exposure_usd).toBe(300);
    expect(s.getLastError()).toMatch(/max_total_exposure_usd/);
    expect(invalid).toHaveLength(1);
    expect(calls.filter((c) => c.action === 'config.invalid')).toHaveLength(1);
    expect(calls.find((c) => c.action === 'config.invalid')!.payload.error).toMatch(/limits.yaml/);

    await s.reload(); // same broken file again: no duplicate
    expect(calls.filter((c) => c.action === 'config.invalid')).toHaveLength(1);
    expect(calls.some((c) => c.action === 'config.changed')).toBe(false);
  });

  it('a cross-file violation is invalid and keeps the previous config', async () => {
    const s = service();
    s.load();
    edit('max_total_exposure_usd: 300', 'max_total_exposure_usd: 100'); // mandate budget 300 > 100
    expect(await s.reload()).toBeNull();
    expect(s.getConfig()!.limits.global.max_total_exposure_usd).toBe(300);
    expect(s.getLastError()).toMatch(/budget_usd/);
  });

  it('a deleted file is invalid, not a reset to defaults', async () => {
    const s = service();
    s.load();
    fs.unlinkSync(limitsPath());
    expect(await s.reload()).toBeNull();
    expect(s.getConfig()!.limits.global.max_total_exposure_usd).toBe(300);
    expect(s.getLastError()).toMatch(/missing/);
  });

  it('a valid edit is swapped in, audited with a diff, and reaches a RiskEngine subscriber', async () => {
    const s = service();
    const cfg = s.load();
    const engine = new RiskEngine({ limits: cfg.limits, mandate: cfg.mandate });
    const events: ConfigChangedEvent[] = [];
    s.onChange((e) => {
      engine.setConfig({ limits: e.after.limits, mandate: e.after.mandate });
      events.push(e);
    });
    s.onChange(() => {
      throw new Error('a failing subscriber must not break the others');
    });

    edit('max_open_orders: 50', 'max_open_orders: 80');
    const e = await s.reload();
    expect(e).not.toBeNull();
    expect(engine.getConfig().limits.global.max_open_orders).toBe(80);
    expect(events).toHaveLength(1);
    expect(events[0].raises.map((c) => c.path)).toEqual(['global.max_open_orders']);

    const audited = calls.find((c) => c.action === 'config.changed')!;
    expect(audited.actor).toBe('system'); // detected from the file, not an authenticated write
    expect(audited.target).toBe('limits');
    expect(audited.payload.files.limits).toEqual([{ path: 'global.max_open_orders', old: 50, new: 80, effect: 'raises' }]);
    expect(audited.result).toBe('raises risk');

    expect(await s.reload()).toBeNull(); // nothing new
  });

  it('a comment-only edit changes nothing and emits nothing', async () => {
    const s = service();
    s.load();
    edit('# BotLab hard limits', '# BotLab HARD limits');
    expect(await s.reload()).toBeNull();
    expect(calls.some((c) => c.action === 'config.changed')).toBe(false);
  });

  it('the file watcher picks up an edit (debounced) and ignores unrelated files', async () => {
    const s = service({ debounceMs: 50 });
    s.load();
    s.start();
    try {
      const seen = new Promise<ConfigChangedEvent>((resolve) => s.onChange(resolve));
      await new Promise((r) => setTimeout(r, 300)); // let chokidar finish its initial scan
      fs.writeFileSync(path.join(dir, 'config', 'notes.txt'), 'x');
      edit('max_open_orders: 50', 'max_open_orders: 60');
      const e = await Promise.race([seen, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('watcher did not fire')), 5000))]);
      expect(e.after.limits.global.max_open_orders).toBe(60);
    } finally {
      await s.stop();
    }
  });

  it('a valid first config after an invalid start is delivered to subscribers', async () => {
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(limitsPath(), 'global: { max_open_orders: -1 }\n');
    const s = service();
    expect(() => s.load()).toThrow(ConfigError);
    expect(s.getConfig()).toBeNull();
    const got = vi.fn();
    s.onChange(got);
    fs.writeFileSync(limitsPath(), DEFAULT_LIMITS_YAML);
    // other files were not created by the failed load? they were (create=true writes each before parsing)
    await s.reload();
    expect(s.getConfig()).not.toBeNull();
    expect(got).toHaveBeenCalledTimes(1);
  });
});

describe('ConfigService write / history / restore', () => {
  it('write validates, keeps comments, applies, and a second identical write is a no-op', async () => {
    const s = service();
    const cfg = s.load();
    const next = structuredClone(cfg.limits);
    next.per_bot_defaults.max_order_usd = 20;
    next.per_bot_defaults.min_hold_minutes = 30;
    const events: ConfigChangedEvent[] = [];
    s.onChange((e) => events.push(e));

    const e = await s.write('limits', next, HUMAN);
    expect(e!.changes.map((c) => c.path)).toEqual(['per_bot_defaults.max_order_usd']);
    expect(e!.raises).toHaveLength(0);
    const text = fs.readFileSync(limitsPath(), 'utf8');
    expect(text).toMatch(/min_hold_minutes: 30\s+#/); // comment after an untouched value survives
    expect(text).toContain('# BotLab hard limits'); // header comment kept
    expect(text).toContain('# trips global halt'); // trailing comments kept
    expect(YAML.parse(text).per_bot_defaults.max_order_usd).toBe(20);
    expect(text).toMatch(/max_order_usd: 20\n/);

    expect(await s.write('limits', next, HUMAN)).toBeNull();
    expect(events).toHaveLength(1);
    expect(calls.filter((c) => c.action === 'config.changed')).toHaveLength(1);
  });

  it('rejects invalid values, cross-file violations and non-human actors without touching the file', async () => {
    const s = service();
    const cfg = s.load();
    const before = fs.readFileSync(limitsPath(), 'utf8');

    const bad = structuredClone(cfg.limits);
    bad.global.max_total_exposure_pct = 5;
    await expect(s.write('limits', bad, HUMAN)).rejects.toThrow(ConfigError);

    const cross = structuredClone(cfg.limits);
    cross.global.max_total_exposure_usd = 10;
    await expect(s.write('limits', cross, HUMAN)).rejects.toThrow(/budget_usd/);

    await expect(s.write('limits', cfg.limits, 'agent')).rejects.toThrow(/human/);
    await expect(s.write('limits', cfg.limits, 'bot:b1')).rejects.toThrow(/human/);
    expect(fs.readFileSync(limitsPath(), 'utf8')).toBe(before);
    expect(calls.some((c) => c.action === 'config.write' && String(c.result).startsWith('denied'))).toBe(true);
  });

  it('history records each accepted change and restore round-trips', async () => {
    const s = service();
    const cfg = s.load();
    const original = fs.readFileSync(limitsPath(), 'utf8');
    const v1 = s.history('limits');
    expect(v1).toHaveLength(1);

    const next = structuredClone(cfg.limits);
    next.global.max_open_orders = 70;
    await s.write('limits', next, HUMAN);
    const versions = s.history('limits');
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ actor: 'human', source: 'write' });

    const restored = await s.restore('limits', v1[0].versionId, HUMAN);
    expect(restored!.changes.map((c) => c.path)).toEqual(['global.max_open_orders']);
    expect(s.getConfig()!.limits.global.max_open_orders).toBe(50);
    expect(fs.readFileSync(limitsPath(), 'utf8')).toBe(original);
    expect(s.history('limits')).toHaveLength(3);
    expect(calls.filter((c) => c.action === 'config.changed').pop()!.payload.restoredFrom).toBe(v1[0].versionId);

    await expect(s.restore('limits', 'nope', HUMAN)).rejects.toThrow(/Unknown version/);
    await expect(s.restore('limits', v1[0].versionId, 'agent')).rejects.toThrow(/human/);
  });

  it('the Telegram token is masked for the UI, never audited, and kept when the mask is sent back', async () => {
    const s = service();
    const cfg = s.load();
    const withToken = structuredClone(cfg.server);
    withToken.notify.telegram.bot_token = '123:SECRET';
    withToken.notify.telegram.chat_id = '42';
    await s.write('server', withToken, HUMAN);
    expect(s.getConfig()!.server.notify.telegram.bot_token).toBe('123:SECRET');
    expect(s.getRedacted()!.server.notify.telegram.bot_token).toBe('***');
    expect(JSON.stringify(calls)).not.toContain('SECRET');

    const fromUi = structuredClone(s.getRedacted()!.server);
    fromUi.timezone = 'UTC';
    await s.write('server', fromUi, HUMAN);
    expect(s.getConfig()!.server.notify.telegram.bot_token).toBe('123:SECRET');
    expect(s.getConfig()!.server.timezone).toBe('UTC');
  });
});

describe('ConfigService hot-reload hardening', () => {
  const serverPath = () => path.join(dir, 'config', 'server.yaml');

  it('an empty, whitespace-only, comment-only or truncated file never resets settings to defaults', async () => {
    const s = service();
    const cfg = s.load();
    const tight = structuredClone(cfg.limits);
    tight.global.max_open_orders = 20;
    await s.write('limits', tight, HUMAN);
    expect(s.getConfig()!.limits.global.max_open_orders).toBe(20);

    for (const bad of ['', '   \n\n', '# just a comment\n', 'global:\n  max_open_orders: 20\n']) {
      fs.writeFileSync(limitsPath(), bad);
      expect(await s.reload()).toBeNull();
      expect(s.getConfig()!.limits.global.max_open_orders).toBe(20);
      expect(s.getLastError()).toMatch(/empty|missing section/);
    }
    // the same for mandate (sections required) and fees
    fs.writeFileSync(limitsPath(), fs.readFileSync(path.join(dir, 'history', 'limits', s.history('limits')[0].versionId + '.yaml'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'config', 'mandate.yaml'), 'budget_usd: 10\n');
    expect(await s.reload()).toBeNull();
    expect(s.getConfig()!.mandate.budget_usd).toBe(300);
    fs.writeFileSync(path.join(dir, 'config', 'fees.yaml'), '');
    expect(await s.reload()).toBeNull();
    expect(s.getConfig()!.fees.taker_rates.weather).toBe(0.05);
  });

  it('YAML and validation errors never carry the bot token (message, issues, audit, last error, subscribers)', async () => {
    const s = service();
    const cfg = s.load();
    const server = structuredClone(cfg.server);
    server.notify.telegram.bot_token = 'plainSecretTok';
    await s.write('server', server, HUMAN);
    const seen: string[] = [];
    s.onInvalid((e) => seen.push(e.error, ...e.issues));

    // syntax error on a line after the token, and a token-shaped value in a bad field
    fs.writeFileSync(
      serverPath(),
      'timezone: Mars/Base\nnotify:\n  telegram:\n    bot_token: plainSecretTok\n    chat_id: [unclosed\n'
    );
    await s.reload();
    fs.writeFileSync(
      serverPath(),
      'timezone: 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nnotify:\n  telegram:\n    bot_token: plainSecretTok\n    enabled: nope\n'
    );
    await s.reload();

    const all = JSON.stringify([calls, seen, s.getLastError()]);
    expect(seen.length).toBeGreaterThan(0);
    expect(all).not.toContain('plainSecretTok');
    expect(all).not.toContain('AAAAAAAAAAAA');
    // writes throw scrubbed errors as well
    const bad = structuredClone(s.getConfig()!.server);
    bad.timezone = 'plainSecretTok';
    await expect(s.write('server', bad, HUMAN)).rejects.not.toThrow(/plainSecretTok/);
  });

  it('write refuses when the file changed on disk since the UI loaded it', async () => {
    const s = service();
    const cfg = s.load();
    const hash = s.getFileHashes().limits!;
    const next = structuredClone(cfg.limits);
    next.global.max_open_orders = 40;

    edit('max_open_orders: 50', 'max_open_orders: 55'); // someone edits the file by hand
    await expect(s.write('limits', next, HUMAN, hash)).rejects.toThrow(/changed on disk/);
    expect(fs.readFileSync(limitsPath(), 'utf8')).toContain('max_open_orders: 55');

    await s.reload();
    await s.write('limits', next, HUMAN, s.getFileHashes().limits);
    expect(s.getConfig()!.limits.global.max_open_orders).toBe(40);
    expect(sha256(fs.readFileSync(limitsPath(), 'utf8'))).toBe(s.getFileHashes().limits);
  });

  it('write and restore report an error (and write nothing) when another file on disk is invalid', async () => {
    const s = service();
    const cfg = s.load();
    const oldVersion = s.history('limits')[0].versionId;
    fs.writeFileSync(path.join(dir, 'config', 'mandate.yaml'), 'budget_usd: -1\n');
    const before = fs.readFileSync(limitsPath(), 'utf8');

    const next = structuredClone(cfg.limits);
    next.global.max_open_orders = 40;
    await expect(s.write('limits', next, HUMAN)).rejects.toThrow(/mandate/);
    await expect(s.restore('limits', oldVersion, HUMAN)).rejects.toThrow(/mandate/);
    expect(fs.readFileSync(limitsPath(), 'utf8')).toBe(before);
    expect(s.getConfig()!.limits.global.max_open_orders).toBe(50);
  });

  it('the first valid config after an invalid start is published with its differences from the defaults', async () => {
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(limitsPath(), 'nonsense: [');
    const s = service();
    expect(() => s.load()).toThrow();
    const events: ConfigChangedEvent[] = [];
    s.onChange((e) => events.push(e));
    const tight = DEFAULT_LIMITS_YAML.replace('max_open_orders: 50', 'max_open_orders: 7');
    fs.writeFileSync(limitsPath(), tight);
    await s.reload();
    expect(events).toHaveLength(1);
    expect(events[0].firstValid).toBe(true);
    expect(events[0].changes.filter((c) => c.file === 'limits').map((c) => [c.path, c.new])).toEqual([['global.max_open_orders', 7]]);
    const audited = calls.find((c) => c.action === 'config.changed')!;
    expect(audited.payload.vsDefaults).toBe(true);
    expect(audited.payload.files.limits[0].path).toBe('global.max_open_orders');
  });
});

describe('renderYaml', () => {
  it('keeps comments and quoting, adds missing keys, drops removed ones', () => {
    const text = '# head\na: 1   # one\nb: "x"  # str\nlist: [a, b]\n';
    const out = renderYaml(text, { a: 2, b: 'y', list: ['a', 'b'], c: { d: true } });
    expect(out).toContain('# head');
    expect(out).toMatch(/a: 2\s+# one/);
    expect(out).toMatch(/b: "y"\s+# str/);
    expect(out).toMatch(/list: \[ ?a, b ?\]/);
    expect(YAML.parse(out)).toEqual({ a: 2, b: 'y', list: ['a', 'b'], c: { d: true } });
    expect(YAML.parse(renderYaml(text, { a: 1 }))).toEqual({ a: 1 });
  });

  it('writes cleanly when the existing text is not parseable', () => {
    expect(YAML.parse(renderYaml('a: [unclosed', { a: 1 }))).toEqual({ a: 1 });
  });
});
