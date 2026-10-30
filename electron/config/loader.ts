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
 * No hot reload yet (chunk 1e).
 */

export const LIMITS_FILE = 'limits.yaml';
export const MANDATE_FILE = 'mandate.yaml';

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

  switch (platform) {
    case 'darwin':
      return path.join(homeDir, 'Library', 'Application Support', 'BotLab', 'config');
    case 'win32':
      return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'BotLab', 'config');
    default:
      return path.join(homeDir, '.local', 'share', 'botlab', 'config');
  }
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
export function parseConfigYaml<T extends z.ZodType>(schema: T, text: string, source: string): z.infer<T> {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Invalid YAML in ${source}: ${msg}`, source, [msg]);
  }

  // An empty file means "all defaults"
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = formatIssues(result.error);
    throw new ConfigError(`Invalid config in ${source}:\n  ${issues.join('\n  ')}`, source, issues);
  }
  return result.data;
}

/** Read a config file, creating it with default contents if it does not exist. */
function readOrCreate(filePath: string, defaultText: string): string {
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
