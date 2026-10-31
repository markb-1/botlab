/**
 * ConfigService — owns the current validated config (limits, mandate, fees, server) (spec §3).
 *
 * - Watches the config dir with chokidar (debounced; editors that save atomically — write a temp
 *   file and rename — produce a burst of events that collapses into one reload).
 * - On any change every file is loaded and validated together (including cross-file rules).
 *   Invalid ⇒ the previous config stays active, `config.invalid` is audited, subscribers are told.
 *   Valid ⇒ swapped in one assignment, `config.changed` audited with a per-key before/after diff,
 *   then subscribers (RiskEngine, FeeService, fetch allowlist, notifier…) are called.
 * - `write` / `restore` (human only) go through the same validate → atomic write → reload path;
 *   the reload happens inside the same lock, so the watcher event for our own write finds nothing
 *   new and produces no duplicate.
 * - A file that disappears is an error, not a reset to defaults (a deleted limits file must never
 *   loosen anything). Missing files are created with defaults only by the initial `load()`.
 */

import fs from 'fs';
import path from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import writeFileAtomic from 'write-file-atomic';
import YAML, { isMap, isScalar } from 'yaml';
import type { z } from 'zod';
import type { AuditActor, AuditService } from '../audit/AuditService';
import { FeesSchema, DEFAULT_FEES_YAML } from '../orders/FeeService';
import { CATEGORIES_FILE, ConfigError, FEES_FILE_NAME, LIMITS_FILE, MANDATE_FILE, SERVER_FILE, parseConfigYaml, resolveConfigDir } from './loader';
import { DEFAULT_LIMITS_YAML, DEFAULT_MANDATE_YAML } from './defaults';
import { LimitsSchema, MandateSchema, validateCrossFile } from './schema';
import { DEFAULT_SERVER_YAML, ServerSchema } from './serverSchema';
import { CategoriesSchema, DEFAULT_CATEGORIES_YAML } from './categoriesSchema';
import {
  CONFIG_FILE_NAMES,
  REDACTED,
  classifyChange,
  deepEqual,
  isSecretPath,
  redactChange,
  redactSecrets,
  describeChange,
  type AppConfig,
  type ClassifiedChange,
  type ConfigFileName,
} from './changes';
import { ConfigHistory, sha256, type ConfigVersion } from './history';
import logger from '../../src/utils/logger';

export const CONFIG_CHANGED_EVENT = 'config:changed';

const FILE_NAMES: Record<ConfigFileName, string> = {
  limits: LIMITS_FILE,
  mandate: MANDATE_FILE,
  fees: FEES_FILE_NAME,
  server: SERVER_FILE,
  categories: CATEGORIES_FILE,
};
const SCHEMAS: Record<ConfigFileName, z.ZodType> = {
  limits: LimitsSchema,
  mandate: MandateSchema,
  fees: FeesSchema,
  server: ServerSchema,
  categories: CategoriesSchema,
};
const DEFAULT_TEXT: Record<ConfigFileName, string> = {
  limits: DEFAULT_LIMITS_YAML,
  mandate: DEFAULT_MANDATE_YAML,
  fees: DEFAULT_FEES_YAML,
  server: DEFAULT_SERVER_YAML,
  categories: DEFAULT_CATEGORIES_YAML,
};

/** Sections that must be present in a reloaded file (a truncated file must not fall back to defaults). */
const shapeKeys = (schema: unknown): string[] => Object.keys((schema as { shape: Record<string, unknown> }).shape);
const REQUIRED_SECTIONS: Record<ConfigFileName, readonly string[]> = {
  limits: shapeKeys(LimitsSchema),
  mandate: shapeKeys(MandateSchema).filter((k) => k !== 'notes'),
  fees: shapeKeys(FeesSchema),
  server: [],
  categories: ['rules'],
};

export type ConfigSource = 'initial' | 'file' | 'write' | 'restore';

export interface ConfigChangedEvent {
  before: AppConfig;
  /** The config now in force */
  after: AppConfig;
  /** Secrets already redacted */
  changes: ClassifiedChange[];
  /** Subset of `changes` that raise risk */
  raises: ClassifiedChange[];
  actor: AuditActor;
  source: ConfigSource;
  /**
   * The first valid config after an invalid start: `before` is the built-in defaults and `changes`
   * the differences from them (informational, not classified as a raise).
   */
  firstValid?: boolean;
}

export interface ConfigInvalidEvent {
  error: string;
  issues: string[];
}

export interface ConfigServiceOptions {
  configDir?: string;
  audit?: Pick<AuditService, 'record'>;
  /** Where snapshots are kept; without it history/restore are unavailable */
  historyDir?: string;
  debounceMs?: number;
}

function defaultConfig(): AppConfig {
  return { limits: LimitsSchema.parse({}), mandate: MandateSchema.parse({}), fees: FeesSchema.parse({}), server: ServerSchema.parse({}), categories: CategoriesSchema.parse({}) };
}

export type Unsubscribe = () => void;

/** Rewrite `existingText` so it holds `value`, keeping comments and formatting where possible. */
export function renderYaml(existingText: string | null, value: Record<string, unknown>): string {
  const doc = existingText !== null ? YAML.parseDocument(existingText) : null;
  if (!doc || doc.errors.length > 0 || !isMap(doc.contents)) {
    return YAML.stringify(value);
  }
  applyValue(doc, [], value);
  return doc.toString();
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function applyValue(doc: YAML.Document, keyPath: string[], value: unknown): void {
  const node = keyPath.length === 0 ? doc.contents : doc.getIn(keyPath, true);
  if (isPlain(value)) {
    if (!isMap(node)) {
      if (keyPath.length === 0) doc.contents = doc.createNode(value) as never;
      else doc.setIn(keyPath, doc.createNode(value));
      return;
    }
    node.items = node.items.filter((item) => {
      const k = isScalar(item.key) ? String(item.key.value) : String(item.key);
      return k in value;
    });
    for (const [k, v] of Object.entries(value)) applyValue(doc, [...keyPath, k], v);
    return;
  }
  if (isScalar(node) && (typeof value !== 'object' || value === null)) {
    if (node.value !== value) node.value = value; // keeps the trailing comment and quoting
    return;
  }
  const current = node && typeof (node as { toJSON?: unknown }).toJSON === 'function' ? (node as { toJSON(): unknown }).toJSON() : undefined;
  if (!deepEqual(current, value)) doc.setIn(keyPath, doc.createNode(value));
}

export class ConfigService {
  readonly configDir: string;
  private audit?: Pick<AuditService, 'record'>;
  private store: ConfigHistory | null;
  private debounceMs: number;
  private current: AppConfig | null = null;
  private lastError: ConfigInvalidEvent | null = null;
  private lastReportedError: string | null = null;
  private hashes: Partial<Record<ConfigFileName, string>> = {};
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private changeListeners = new Set<(e: ConfigChangedEvent) => void>();
  private invalidListeners = new Set<(e: ConfigInvalidEvent) => void>();

  constructor(opts: ConfigServiceOptions = {}) {
    this.configDir = opts.configDir ?? resolveConfigDir();
    this.audit = opts.audit;
    this.store = opts.historyDir ? new ConfigHistory(opts.historyDir) : null;
    this.debounceMs = opts.debounceMs ?? 500;
  }

  // ── Reading ───────────────────────────────────────────────────────

  /** The config in force; null until a valid config was loaded. */
  getConfig(): AppConfig | null {
    return this.current;
  }

  /** The config in force or a throw (for code that cannot run without one). */
  requireConfig(): AppConfig {
    if (!this.current) throw new Error(`Config not loaded: ${this.lastError?.error ?? 'not loaded'}`);
    return this.current;
  }

  /** Why the config is not usable (or the latest rejected edit), or null. */
  getLastError(): string | null {
    return this.lastError?.error ?? null;
  }

  /** Config for the renderer: secrets masked. */
  getRedacted(): AppConfig | null {
    if (!this.current) return null;
    const copy = structuredClone(this.current);
    if (copy.server.notify.telegram.bot_token) copy.server.notify.telegram.bot_token = REDACTED;
    return copy;
  }

  filePath(file: ConfigFileName): string {
    return path.join(this.configDir, FILE_NAMES[file]);
  }

  // ── Subscriptions ─────────────────────────────────────────────────

  /** Called after a valid change was swapped in. Listener errors are logged, never propagated. */
  onChange(listener: (e: ConfigChangedEvent) => void): Unsubscribe {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Called when an edit was rejected (the previous config stays active). */
  onInvalid(listener: (e: ConfigInvalidEvent) => void): Unsubscribe {
    this.invalidListeners.add(listener);
    return () => this.invalidListeners.delete(listener);
  }

  // ── Loading and watching ──────────────────────────────────────────

  /**
   * Initial load: missing files are created with the defaults. Throws ConfigError when invalid
   * (the watcher can still be started; a later valid edit becomes the first config).
   */
  load(): AppConfig {
    try {
      const { config, texts } = this.readAll(true);
      this.current = config;
      this.lastError = null;
      for (const f of CONFIG_FILE_NAMES) this.hashes[f] = sha256(texts[f]);
      this.snapshot(texts, 'system', 'initial', CONFIG_FILE_NAMES);
      return config;
    } catch (err) {
      const scrubbed = this.scrubError(err);
      this.lastError = { error: scrubbed.message, issues: scrubbed instanceof ConfigError ? scrubbed.issues : [] };
      throw scrubbed;
    }
  }

  /** Start watching the config directory (idempotent). */
  start(): void {
    if (this.watcher) return;
    try {
      fs.mkdirSync(this.configDir, { recursive: true });
      this.watcher = chokidar.watch(this.configDir, {
        ignoreInitial: true,
        depth: 0,
        persistent: true,
        // Only the config files we own; editor temp/swap files are noise
        // Wait for editors that write in several steps (partial/truncated content is never read)
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
        ignored: (p, stats) => !!stats?.isFile() && !Object.values(FILE_NAMES).includes(path.basename(p)),
      });
      const schedule = () => this.scheduleReload();
      this.watcher.on('add', schedule).on('change', schedule).on('unlink', schedule);
      this.watcher.on('error', (err) => logger.error(`[Config] Watcher error: ${err instanceof Error ? err.message : err}`));
    } catch (err) {
      logger.error(`[Config] Could not watch ${this.configDir}: ${err instanceof Error ? err.message : err}`);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const w = this.watcher;
    this.watcher = null;
    if (w) await w.close().catch(() => undefined);
    await this.lock.catch(() => undefined);
  }

  private scheduleReload(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reload('file').catch((err) => logger.error(`[Config] Reload failed: ${err instanceof Error ? err.message : err}`));
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /**
   * Re-read all files. Returns the applied event, or null when nothing changed or the files are
   * invalid (previous config kept).
   */
  reload(source: ConfigSource = 'file', actor: AuditActor = 'system'): Promise<ConfigChangedEvent | null> {
    return this.exclusive(async () => this.reloadLocked(source, actor));
  }

  /** `strict`: a rejected reload throws (write/restore must not report success for a config that was not applied). */
  private reloadLocked(source: ConfigSource, actor: AuditActor, extra: Record<string, unknown> = {}, strict = false): ConfigChangedEvent | null {
    let read: ReturnType<ConfigService['readAll']>;
    try {
      read = this.readAll(false);
    } catch (err) {
      const scrubbed = this.reportInvalid(err);
      if (strict) throw scrubbed;
      return null;
    }
    this.lastError = null;
    this.lastReportedError = null;

    const { config, texts } = read;
    const before = this.current;
    this.current = config; // one assignment: readers see the old or the new config, never a mix
    const changed = CONFIG_FILE_NAMES.filter((f) => this.hashes[f] !== sha256(texts[f]));
    for (const f of changed) this.hashes[f] = sha256(texts[f]);
    this.snapshot(texts, actor, source, changed);

    if (!before) {
      // First valid config after an invalid start: report the differences from the defaults
      const defaults = defaultConfig();
      const changes = classifyChange(defaults, config).map(redactChange);
      return this.notifyChanged({ before: defaults, after: config, changes, raises: [], actor, source, firstValid: true }, { ...extra, firstValidAfterInvalidStart: true, vsDefaults: true }, false);
    }
    const changes = classifyChange(before, config).map(redactChange);
    if (changes.length === 0) return null; // comment/whitespace edit, or our own write seen again

    const raises = changes.filter((c) => c.effect === 'raises');
    return this.notifyChanged({ before, after: config, changes, raises, actor, source }, extra, false);
  }

  private notifyChanged(event: ConfigChangedEvent, extra: Record<string, unknown>, initial: boolean): ConfigChangedEvent {
    if (!initial) {
      const files: Record<string, unknown[]> = {};
      for (const c of event.changes) (files[c.file] ??= []).push({ path: c.path, old: c.old, new: c.new, effect: c.effect });
      this.audit?.record(
        event.actor,
        'config.changed',
        Object.keys(files).join(','),
        { source: event.source, files, raises: event.raises.map((c) => `${c.file}.${c.path}`), ...extra },
        event.raises.length > 0 ? 'raises risk' : 'ok'
      );
      logger.info(`[Config] Changed (${event.source}): ${event.changes.map(describeChange).join('; ')}`);
    }
    for (const l of this.changeListeners) {
      try {
        l(event);
      } catch (err) {
        logger.error(`[Config] Subscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return event;
  }

  /** Records and publishes a rejected config; returns the scrubbed error. */
  private reportInvalid(err: unknown): Error {
    const scrubbed = this.scrubError(err);
    const error = scrubbed.message;
    const issues = scrubbed instanceof ConfigError ? scrubbed.issues : [];
    this.lastError = { error, issues };
    if (error === this.lastReportedError) return scrubbed; // same broken state seen again (editor re-saves)
    this.lastReportedError = error;
    logger.error(`[Config] Edit rejected, previous config stays active: ${error}`);
    this.audit?.record('system', 'config.invalid', this.configDir, { error, issues }, 'rejected');
    for (const l of this.invalidListeners) {
      try {
        l({ error, issues });
      } catch (e) {
        logger.error(`[Config] Subscriber failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return scrubbed;
  }

  private secrets(): string[] {
    return [this.current?.server.notify.telegram.bot_token ?? '', process.env.TELEGRAM_BOT_TOKEN ?? ''];
  }

  /** Remove bot tokens from text that may be logged, audited, sent over IPC or to Telegram. */
  private scrub(text: string): string {
    return redactSecrets(text, this.secrets());
  }

  private scrubError(err: unknown): Error {
    if (err instanceof ConfigError) {
      return new ConfigError(this.scrub(err.message), err.file, err.issues.map((i) => this.scrub(i)));
    }
    return new Error(this.scrub(err instanceof Error ? err.message : String(err)));
  }

  /** Read, parse and validate every file plus cross-file rules. Throws one ConfigError listing all problems. */
  private readAll(create: boolean, override?: { file: ConfigFileName; text: string }): { config: AppConfig; texts: Record<ConfigFileName, string> } {
    const texts = {} as Record<ConfigFileName, string>;
    const parsed: Partial<Record<ConfigFileName, unknown>> = {};
    const issues: string[] = [];
    for (const f of CONFIG_FILE_NAMES) {
      const file = this.filePath(f);
      try {
        if (!fs.existsSync(file)) {
          if (!create) throw new ConfigError(`${FILE_NAMES[f]} is missing`, file, ['file is missing (a deleted file never resets to defaults)']);
          fs.mkdirSync(this.configDir, { recursive: true });
          fs.writeFileSync(file, DEFAULT_TEXT[f], 'utf8');
          logger.info(`[Config] Created ${file} with defaults`);
        }
        texts[f] = override && override.file === f ? override.text : fs.readFileSync(file, 'utf8');
        parsed[f] = parseConfigYaml(SCHEMAS[f], texts[f], file, create ? {} : { strict: true, requiredSections: REQUIRED_SECTIONS[f] });
      } catch (err) {
        if (err instanceof ConfigError) issues.push(...err.issues.map((i) => `${FILE_NAMES[f]}: ${i}`));
        else issues.push(`${FILE_NAMES[f]}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (issues.length === 0) {
      issues.push(...validateCrossFile(parsed.limits as AppConfig['limits'], parsed.mandate as AppConfig['mandate']));
    }
    if (issues.length > 0) {
      const clean = issues.map((i) => this.scrub(i));
      throw new ConfigError(`Invalid config in ${this.configDir}:\n  ${clean.join('\n  ')}`, null, clean);
    }
    return { config: parsed as unknown as AppConfig, texts };
  }

  private snapshot(texts: Record<ConfigFileName, string>, actor: string, source: string, files: readonly ConfigFileName[]): void {
    if (!this.store) return;
    for (const f of files) {
      try {
        this.store.record(f, texts[f], actor, source);
      } catch (err) {
        logger.error(`[Config] Could not record history for ${f}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // ── Writing (human only) ──────────────────────────────────────────

  /**
   * Validate `newValue` against the file's schema and the cross-file rules, write the YAML
   * atomically (comments kept where possible) and apply it. Throws ConfigError when invalid.
   * Only a human may write config (it is never writable by the agent).
   */
  write(file: ConfigFileName, newValue: unknown, actor: AuditActor, expectedSha256?: string): Promise<ConfigChangedEvent | null> {
    return this.exclusive(async () => {
      this.assertHuman(actor, 'config.write', file);
      if (!CONFIG_FILE_NAMES.includes(file)) throw new Error(`Unknown config file: ${String(file)}`);
      const current = this.requireConfig();

      if (expectedSha256 !== undefined) {
        let onDisk = '';
        try {
          onDisk = fs.readFileSync(this.filePath(file), 'utf8');
        } catch {
          /* missing file: hash mismatch below */
        }
        if (sha256(onDisk) !== expectedSha256) {
          throw new Error(`${FILE_NAMES[file]} changed on disk since it was loaded; reload it and apply your edit again`);
        }
      }

      const unmasked = this.unmask(file, newValue, current);
      const result = SCHEMAS[file].safeParse(unmasked);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
        throw new ConfigError(`Invalid ${FILE_NAMES[file]}:\n  ${issues.join('\n  ')}`, FILE_NAMES[file], issues);
      }
      const candidate = { ...current, [file]: result.data } as AppConfig;
      const cross = validateCrossFile(candidate.limits, candidate.mandate);
      if (cross.length > 0) throw new ConfigError(`Inconsistent config:\n  ${cross.join('\n  ')}`, null, cross);

      let existing: string | null = null;
      try {
        existing = fs.readFileSync(this.filePath(file), 'utf8');
      } catch {
        /* missing: write clean */
      }
      const text = renderYaml(existing, result.data as Record<string, unknown>);
      // The rendered text must itself parse to the validated value (guards the comment-preserving edit)
      const reparsed = parseConfigYaml(SCHEMAS[file], text, FILE_NAMES[file]);
      if (!deepEqual(reparsed, result.data)) throw new Error(`Internal error: rendered ${FILE_NAMES[file]} does not match the validated value`);

      // Everything on disk (the other files too) plus this text must be valid before anything is written
      this.readAll(false, { file, text });

      await writeFileAtomic(this.filePath(file), text);
      return this.reloadLocked('write', actor, {}, true);
    }).catch((err) => {
      throw this.scrubError(err);
    });
  }

  /** Previous versions, newest first. */
  history(file: ConfigFileName): ConfigVersion[] {
    return this.store?.list(file) ?? [];
  }

  /** Re-apply the file text of a previous version (validated like any edit). */
  restore(file: ConfigFileName, versionId: string, actor: AuditActor): Promise<ConfigChangedEvent | null> {
    return this.exclusive(async () => {
      this.assertHuman(actor, 'config.restore', file);
      if (!this.store) throw new Error('Config history is not available');
      if (!CONFIG_FILE_NAMES.includes(file)) throw new Error(`Unknown config file: ${String(file)}`);
      const text = this.store.read(file, versionId);
      if (text === null) throw new Error(`Unknown version ${versionId} of ${FILE_NAMES[file]}`);

      const current = this.requireConfig();
      const value = parseConfigYaml(SCHEMAS[file], text, `${FILE_NAMES[file]}@${versionId}`, { strict: true, requiredSections: REQUIRED_SECTIONS[file] });
      const candidate = { ...current, [file]: value } as AppConfig;
      const cross = validateCrossFile(candidate.limits, candidate.mandate);
      if (cross.length > 0) throw new ConfigError(`Version ${versionId} is inconsistent with the other files:\n  ${cross.join('\n  ')}`, null, cross);

      this.readAll(false, { file, text });

      await writeFileAtomic(this.filePath(file), text);
      return this.reloadLocked('restore', actor, { restoredFrom: versionId }, true);
    }).catch((err) => {
      throw this.scrubError(err);
    });
  }

  /** sha256 of each file's text as last loaded (the UI sends it back to `write` to detect concurrent edits). */
  getFileHashes(): Partial<Record<ConfigFileName, string>> {
    return { ...this.hashes };
  }

  private assertHuman(actor: AuditActor, action: string, file: string): void {
    if (actor !== 'human') {
      this.audit?.record(actor, action, file, undefined, 'denied: human only');
      throw new Error('Only a human can change config');
    }
  }

  /** The UI sends masked secrets back unchanged; keep the stored value in that case. */
  private unmask(file: ConfigFileName, value: unknown, current: AppConfig): unknown {
    if (!isPlain(value)) return value;
    const copy = structuredClone(value) as Record<string, unknown>;
    for (const secret of ['server:notify.telegram.bot_token']) {
      const [f, p] = secret.split(':');
      if (f !== file || !isSecretPath(f, p)) continue;
      const keys = p.split('.');
      let node: unknown = copy;
      for (const k of keys.slice(0, -1)) node = isPlain(node) ? node[k] : undefined;
      const last = keys[keys.length - 1];
      if (isPlain(node) && node[last] === REDACTED) node[last] = current.server.notify.telegram.bot_token;
    }
    return copy;
  }
}
