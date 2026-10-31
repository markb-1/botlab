import type Database from 'better-sqlite3';
import { generateId, sourceHash } from '../index';
import { AuditRepository, type AuditActor } from './AuditRepository';
import { lowerStage } from '../../risk/ramp';
import type { BotStage } from '../../risk/types';

export type ScriptOrigin = 'builtin' | 'human' | 'agent';
export type ScriptTrust = 'new' | 'proven';
export type ScriptKind = 'template' | 'custom';

export interface ScriptRow {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  source: string;
  compiled: string | null;
  config_schema: string; // JSON string
  is_template: number; // SQLite boolean (0/1)
  // v3 ramp columns (spec §2.1)
  kind: ScriptKind;
  origin: ScriptOrigin;
  /** Integer source version; +1 on every source change (the `version` column is legacy semver text) */
  revision: number;
  trust: ScriptTrust;
  source_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScriptVersionRow {
  id: string;
  script_id: string;
  version: number;
  source: string;
  compiled: string | null;
  source_hash: string;
  created_at: string;
  created_by: string;
}

export class ScriptRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  findById(id: string): ScriptRow | undefined {
    return this.db.prepare('SELECT * FROM scripts WHERE id = ?').get(id) as ScriptRow | undefined;
  }

  findAll(): ScriptRow[] {
    return this.db
      .prepare('SELECT * FROM scripts ORDER BY is_template DESC, created_at DESC')
      .all() as ScriptRow[];
  }

  findTemplates(): ScriptRow[] {
    return this.db
      .prepare('SELECT * FROM scripts WHERE is_template = 1 ORDER BY name ASC')
      .all() as ScriptRow[];
  }

  /** Every script of kind template: builtin and agent/human templates (spec §2.1) */
  findByKind(kind: ScriptKind): ScriptRow[] {
    return this.db.prepare('SELECT * FROM scripts WHERE kind = ? ORDER BY name ASC').all(kind) as ScriptRow[];
  }

  findByNameAndVersion(name: string, version: string): ScriptRow | undefined {
    return this.db
      .prepare('SELECT * FROM scripts WHERE name = ? AND version = ?')
      .get(name, version) as ScriptRow | undefined;
  }

  create(data: {
    name: string;
    description?: string;
    version?: string;
    author?: string;
    source: string;
    compiled?: string;
    configSchema?: Record<string, unknown> | string;
    isTemplate?: boolean;
    /** Default `human`. Builtin scripts are seeded as proven templates. */
    origin?: ScriptOrigin;
    /** Default: proven for builtin, new otherwise */
    trust?: ScriptTrust;
    /** Recorded on the script_versions row (default derived from origin) */
    createdBy?: string;
    /** Default: template for builtin templates (isTemplate), else custom. Agent templates are kind template, not isTemplate. */
    kind?: ScriptKind;
  }): ScriptRow {
    const id = generateId();
    const now = new Date().toISOString();
    const configSchema =
      typeof data.configSchema === 'string'
        ? data.configSchema
        : JSON.stringify(data.configSchema || {});
    const origin: ScriptOrigin = data.origin ?? 'human';
    const trust: ScriptTrust = data.trust ?? (origin === 'builtin' ? 'proven' : 'new');
    const kind: ScriptKind = data.kind ?? (data.isTemplate ? 'template' : 'custom');
    const hash = sourceHash(data.source);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO scripts (id, name, description, version, author, source, compiled, config_schema, is_template,
             kind, origin, revision, trust, source_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
        )
        .run(
          id,
          data.name,
          data.description || '',
          data.version || '1.0.0',
          data.author || '',
          data.source,
          data.compiled || null,
          configSchema,
          data.isTemplate ? 1 : 0,
          kind,
          origin,
          trust,
          hash,
          now,
          now
        );
      this.insertVersion(id, 1, data.source, data.compiled || null, hash, data.createdBy ?? defaultCreatedBy(origin), now);
    })();

    return this.findById(id)!;
  }

  private insertVersion(scriptId: string, version: number, source: string, compiled: string | null, hash: string, createdBy: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO script_versions (id, script_id, version, source, compiled, source_hash, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(generateId(), scriptId, version, source, compiled, hash, at, createdBy);
  }

  findVersions(scriptId: string): ScriptVersionRow[] {
    return this.db
      .prepare('SELECT * FROM script_versions WHERE script_id = ? ORDER BY version DESC')
      .all(scriptId) as ScriptVersionRow[];
  }

  /**
   * Changed code must re-earn its stage (spec §4.5): every bot on the script goes back to paper
   * (retired stays retired), audited per bot. Runs inside the caller's transaction.
   */
  private demoteBots(scriptId: string, fromRevision: number, toRevision: number, changedBy: string): void {
    const bots = this.db.prepare('SELECT id, stage FROM bots WHERE script_id = ?').all(scriptId) as Array<{ id: string; stage: BotStage }>;
    const audit = new AuditRepository(this.db);
    const now = new Date().toISOString();
    const actor: AuditActor = changedBy === 'human' || changedBy === 'agent' ? changedBy : 'system';
    for (const bot of bots) {
      const to = lowerStage(bot.stage, 'paper');
      if (to === bot.stage) continue;
      this.db
        .prepare("UPDATE bots SET stage = ?, stage_changed_at = ?, updated_at = datetime('now') WHERE id = ?")
        .run(to, now, bot.id);
      audit.append(
        { actor, action: 'bot.stage', target: bot.id, payload: { from: bot.stage, to, reason: `script ${scriptId} source changed (r${fromRevision} → r${toRevision})` } },
        now
      );
    }
  }

  setTrust(id: string, trust: ScriptTrust): void {
    this.db.prepare("UPDATE scripts SET trust = ?, updated_at = datetime('now') WHERE id = ?").run(trust, id);
  }

  update(
    id: string,
    data: Partial<{
      name: string;
      description: string;
      version: string;
      author: string;
      source: string;
      compiled: string | null;
      configSchema: Record<string, unknown> | string;
    }>,
    /** Who changed it (script_versions.created_by), default human */
    createdBy = 'human'
  ): ScriptRow | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;
    const sets: string[] = [];
    const values: unknown[] = [];

    // A source change is a new version: bump revision, store the version row, and (except for
    // builtin templates) the changed code must earn trust again.
    const newHash = data.source !== undefined ? sourceHash(data.source) : null;
    const sourceChanged = newHash !== null && newHash !== existing.source_hash;
    const revision = sourceChanged ? existing.revision + 1 : existing.revision;
    if (sourceChanged) {
      sets.push('revision = ?', 'source_hash = ?');
      values.push(revision, newHash);
      if (existing.origin !== 'builtin') { sets.push("trust = 'new'"); }
    }

    if (data.name !== undefined) { sets.push('name = ?'); values.push(data.name); }
    if (data.description !== undefined) { sets.push('description = ?'); values.push(data.description); }
    if (data.version !== undefined) { sets.push('version = ?'); values.push(data.version); }
    if (data.author !== undefined) { sets.push('author = ?'); values.push(data.author); }
    if (data.source !== undefined) { sets.push('source = ?'); values.push(data.source); }
    if (data.compiled !== undefined) { sets.push('compiled = ?'); values.push(data.compiled); }
    if (data.configSchema !== undefined) {
      sets.push('config_schema = ?');
      values.push(
        typeof data.configSchema === 'string'
          ? data.configSchema
          : JSON.stringify(data.configSchema)
      );
    }

    if (sets.length === 0) return this.findById(id);

    sets.push("updated_at = datetime('now')");
    values.push(id);

    this.db.transaction(() => {
      this.db.prepare(`UPDATE scripts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      if (sourceChanged) {
        const compiled = data.compiled !== undefined ? data.compiled : null;
        this.insertVersion(id, revision, data.source!, compiled, newHash!, createdBy, new Date().toISOString());
        this.demoteBots(id, existing.revision, revision, createdBy);
      }
    })();

    return this.findById(id);
  }

  delete(id: string): boolean {
    // Don't delete templates
    const script = this.findById(id);
    if (!script || script.is_template) return false;

    // Check if any bots reference this script
    const botCount = this.db
      .prepare('SELECT COUNT(*) as count FROM bots WHERE script_id = ?')
      .get(id) as { count: number };
    if (botCount.count > 0) return false;

    const result = this.db.prepare('DELETE FROM scripts WHERE id = ? AND is_template = 0').run(id);
    return result.changes > 0;
  }
}

function defaultCreatedBy(origin: ScriptOrigin): string {
  return origin === 'builtin' ? 'system' : origin;
}
