import fs from 'fs';
import os from 'os';
import path from 'path';
import YAML from 'yaml';
import type { z } from 'zod';
import {
  LimitsSchema,
  MandateSchema,
  validateCrossFile,
  type BotLabConfig,
  type LimitsConfig,
  type MandateConfig,
} from './schema';
import { DEFAULT_LIMITS_YAML, DEFAULT_MANDATE_YAML } from './defaults';

/**
 * Loads config/limits.yaml and config/mandate.yaml (spec §3).
 *
 * - Missing file ⇒ written with the spec defaults, then loaded.
 * - Invalid file (YAML syntax, schema, or cross-file rule) or any fs error ⇒ throws ConfigError.
 *   Callers keep their previously loaded config in that case.
 *
 * Hot reload and the other files (fees, server) live in ConfigService.
 */

export const LIMITS_FILE = 'limits.yaml';
export const MANDATE_FILE = 'mandate.yaml';
export const FEES_FILE_NAME = 'fees.yaml';
export const SERVER_FILE = 'server.yaml';
export const CATEGORIES_FILE = 'categories.yaml';

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly file: string | null,
    public readonly issues: string[]
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Config directory (spec §15.2):
 * - BOTLAB_CONFIG_DIR if set
 * - production with BOTLAB_DATA_DIR set: `<data dir>/config` (the config follows a custom data dir)
 * - production (NODE_ENV=production): the OS app-data dir —
 *   macOS ~/Library/Application Support/BotLab/config, Windows %APPDATA%\BotLab\config,
 *   Linux ~/.local/share/botlab/config
 * - otherwise <cwd>/config
 */
export function resolveConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir()
): string {
  if (env.BOTLAB_CONFIG_DIR) return env.BOTLAB_CONFIG_DIR;
  if (env.NODE_ENV !== 'production') return path.join(process.cwd(), 'config');
  if (env.BOTLAB_DATA_DIR) return path.join(path.resolve(env.BOTLAB_DATA_DIR), 'config');

  switch (platform) {
    case 'darwin':
      return path.join(homeDir, 'Library', 'Application Support', 'BotLab', 'config');
    case 'win32':
      return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'BotLab', 'config');
    default:
      return path.join(homeDir, '.local', 'share', 'botlab', 'config');
  }
}

/**
 * Upgrade check for R127: in production, a config dir that now follows BOTLAB_DATA_DIR may leave the
 * YAML files a previous version wrote to the OS app-data config dir behind. Returns a warning when the
 * old dir has YAML files and the new one has none (the server would otherwise start on fresh defaults).
 */
export function legacyConfigDirWarning(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir()
): string | null {
  if (env.NODE_ENV !== 'production' || !env.BOTLAB_DATA_DIR || env.BOTLAB_CONFIG_DIR) return null;
  const current = resolveConfigDir(env, platform, homeDir);
  const { BOTLAB_DATA_DIR: _ignored, ...withoutData } = env;
  const legacy = resolveConfigDir(withoutData, platform, homeDir);
  if (path.resolve(legacy) === path.resolve(current)) return null;
  const yamls = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f) && !/\.example\.ya?ml$/i.test(f));
    } catch {
      return [];
    }
  };
  const old = yamls(legacy);
  if (old.length === 0 || yamls(current).length > 0) return null;
  return (
    `Config dir is now ${current} (it follows BOTLAB_DATA_DIR), but your existing config files ` +
    `(${old.join(', ')}) are in ${legacy}. BotLab will start with DEFAULT limits/mandate there. ` +
    `Move or copy them to ${current}, or set BOTLAB_CONFIG_DIR=${legacy}.`
  );
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
}

/**
 * Parse and validate one YAML document against a schema.
 * `source` is used only for error messages (usually the file path).
 */
export interface ParseOptions {
  /**
   * Hot-reload mode: an empty/comment-only file is an error and every section in `requiredSections`
   * must be present, so a truncated file can never fall back to defaults. Defaults apply only to
   * a newly created file and to keys missing inside a present section.
   */
  strict?: boolean;
  requiredSections?: readonly string[];
}

export function parseConfigYaml<T extends z.ZodType>(schema: T, text: string, source: string, opts: ParseOptions = {}): z.infer<T> {
  let raw: unknown;
  try {
    // prettyErrors: false keeps the offending source line (which may hold a secret) out of the message
    raw = YAML.parse(text, { prettyErrors: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new ConfigError(`Invalid YAML in ${source}: ${msg}`, source, [msg]);
  }

  if (opts.strict) {
    const isObject = typeof raw === 'object' && raw !== null && !Array.isArray(raw);
    if (!isObject) {
      const issues = ['file is empty or not a mapping (an empty file never resets to defaults)'];
      throw new ConfigError(`Invalid config in ${source}:\n  ${issues.join('\n  ')}`, source, issues);
    }
    const missing = (opts.requiredSections ?? []).filter((k) => !(k in (raw as Record<string, unknown>)));
    if (missing.length > 0) {
      const issues = missing.map((k) => `missing section "${k}" (truncated file?)`);
      throw new ConfigError(`Invalid config in ${source}:\n  ${issues.join('\n  ')}`, source, issues);
    }
  }

  // An empty file means "all defaults" (initial creation only)
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = formatIssues(result.error);
    throw new ConfigError(`Invalid config in ${source}:\n  ${issues.join('\n  ')}`, source, issues);
  }
  return result.data;
}

/** Read a config file, creating it with default contents if it does not exist. Throws ConfigError. */
export function readOrCreate(filePath: string, defaultText: string): string {
  try {
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, defaultText, 'utf8');
      console.log(`[Config] Created ${filePath} with defaults`);
      return defaultText;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Cannot read or create ${filePath}: ${msg}`, filePath, [msg]);
  }
}

export function loadLimits(configDir: string = resolveConfigDir()): LimitsConfig {
  const file = path.join(configDir, LIMITS_FILE);
  return parseConfigYaml(LimitsSchema, readOrCreate(file, DEFAULT_LIMITS_YAML), file);
}

export function loadMandate(configDir: string = resolveConfigDir()): MandateConfig {
  const file = path.join(configDir, MANDATE_FILE);
  return parseConfigYaml(MandateSchema, readOrCreate(file, DEFAULT_MANDATE_YAML), file);
}

/** Load and cross-validate both files. Throws ConfigError on any problem. */
export function loadConfig(configDir: string = resolveConfigDir()): BotLabConfig {
  const limits = loadLimits(configDir);
  const mandate = loadMandate(configDir);

  const issues = validateCrossFile(limits, mandate);
  if (issues.length > 0) {
    throw new ConfigError(`Inconsistent config in ${configDir}:\n  ${issues.join('\n  ')}`, null, issues);
  }

  return { limits, mandate };
}
