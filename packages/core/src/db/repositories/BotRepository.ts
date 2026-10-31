import type Database from 'better-sqlite3';
import { generateId } from '../index';
import type { BotStage } from '../../risk/types';

export interface BotRow {
  id: string;
  name: string;
  script_id: string;
  wallet_id: string;
  config: string; // JSON string
  status: string;
  enabled: number; // SQLite boolean (0/1)
  mode: string; // 'live' | 'paper'
  last_started_at: string | null;
  last_stopped_at: string | null;
  last_heartbeat: string | null;
  error_logs: string; // JSON array string
  // v3 ramp + scoping columns
  stage: string; // 'paper' | 'probation' | 'full' | 'retired'
  allocation_usd: number | null;
  created_by: string; // 'human' | 'agent'
  market_ids: string | null; // JSON array of condition IDs; null = unscoped
  strategy: string | null;
  paused_by: string | null;
  retire_reason: string | null;
  /** scripts.revision the bot was created on */
  template_version: number | null;
  /** When the current stage was entered (null for pre-1c bots: use created_at) */
  stage_changed_at: string | null;
  /** Last runtime error from the bot's worker (ISO) */
  last_error_at: string | null;
  /** Set when the ramp promoted the bot to full (counts toward its template becoming proven) */
  reached_full_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BotFilter {
  scriptId?: string;
  status?: string;
  enabled?: boolean;
  walletId?: string;
}

export class BotRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  findById(id: string): BotRow | undefined {
    return this.db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as BotRow | undefined;
  }

  findAll(filter?: BotFilter): BotRow[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter?.scriptId) {
      conditions.push('script_id = ?');
      values.push(filter.scriptId);
    }
    if (filter?.status) {
      conditions.push('status = ?');
      values.push(filter.status);
    }
    if (filter?.enabled !== undefined) {
      conditions.push('enabled = ?');
      values.push(filter.enabled ? 1 : 0);
    }
    if (filter?.walletId) {
      conditions.push('wallet_id = ?');
      values.push(filter.walletId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM bots ${where} ORDER BY created_at DESC`)
      .all(...values) as BotRow[];
  }

  create(data: {
    name: string;
    scriptId: string;
    walletId: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
    mode?: 'live' | 'paper';
    /** Ramp stage (spec §4.5); callers derive it from the script's trust. Default paper (fail closed). */
    stage?: BotStage;
    templateVersion?: number | null;
    /** Who created it (spec §2.1); default human */
    createdBy?: 'human' | 'agent';
    /** Condition ids the bot is scoped to (null = unscoped) */
    marketIds?: string[] | null;
    strategy?: string | null;
  }): BotRow {
    const id = generateId();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO bots (id, name, script_id, wallet_id, config, enabled, mode, stage, template_version,
           stage_changed_at, created_by, market_ids, strategy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.name,
        data.scriptId,
        data.walletId,
        JSON.stringify(data.config || {}),
        data.enabled !== false ? 1 : 0,
        data.mode || 'live',
        data.stage ?? 'paper',
        data.templateVersion ?? null,
        now,
        data.createdBy ?? 'human',
        data.marketIds ? JSON.stringify(data.marketIds) : null,
        data.strategy ?? null,
        now,
        now
      );

    return this.findById(id)!;
  }

  update(
    id: string,
    data: Partial<{
      name: string;
      scriptId: string;
      walletId: string;
      config: Record<string, unknown>;
      status: string;
      enabled: boolean;
      lastStartedAt: string | null;
      lastStoppedAt: string | null;
      lastHeartbeat: string | null;
      errorLogs: Array<{ message: string; timestamp: string; stack?: string }>;
    }>
  ): BotRow | undefined {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined) { sets.push('name = ?'); values.push(data.name); }
    if (data.scriptId !== undefined) { sets.push('script_id = ?'); values.push(data.scriptId); }
    if (data.walletId !== undefined) { sets.push('wallet_id = ?'); values.push(data.walletId); }
    if (data.config !== undefined) { sets.push('config = ?'); values.push(JSON.stringify(data.config)); }
    if (data.status !== undefined) { sets.push('status = ?'); values.push(data.status); }
    if (data.enabled !== undefined) { sets.push('enabled = ?'); values.push(data.enabled ? 1 : 0); }
    if (data.lastStartedAt !== undefined) { sets.push('last_started_at = ?'); values.push(data.lastStartedAt); }
    if (data.lastStoppedAt !== undefined) { sets.push('last_stopped_at = ?'); values.push(data.lastStoppedAt); }
    if (data.lastHeartbeat !== undefined) { sets.push('last_heartbeat = ?'); values.push(data.lastHeartbeat); }
    if (data.errorLogs !== undefined) { sets.push('error_logs = ?'); values.push(JSON.stringify(data.errorLogs)); }

    if (sets.length === 0) return this.findById(id);

    sets.push("updated_at = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE bots SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    return this.findById(id);
  }

  /** Change the ramp stage (resets stage_changed_at). `reachedFull` marks a ramp promotion to full. */
  setStage(id: string, stage: BotStage, opts: { reachedFull?: boolean } = {}): BotRow | undefined {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE bots SET stage = ?, stage_changed_at = ?,
           reached_full_at = CASE WHEN ? THEN ? ELSE reached_full_at END,
           updated_at = datetime('now') WHERE id = ?`
      )
      .run(stage, now, opts.reachedFull ? 1 : 0, now, id);
    return this.findById(id);
  }

  /** Bots of a script (current revision) that the ramp promoted to full. */
  countReachedFull(scriptId: string, templateVersion: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM bots WHERE script_id = ? AND template_version = ? AND reached_full_at IS NOT NULL')
      .get(scriptId, templateVersion) as { n: number };
    return row.n;
  }

  /** Terminal stage (spec §2.1): retired, with the reason; disabled so nothing restarts it */
  retire(id: string, reason: string): BotRow | undefined {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE bots SET stage = 'retired', retire_reason = ?, enabled = 0, stage_changed_at = ?, updated_at = datetime('now') WHERE id = ?")
      .run(reason, now, id);
    return this.findById(id);
  }

  /** Who paused the bot (null when it is started again) */
  setPausedBy(id: string, pausedBy: string | null): void {
    this.db.prepare("UPDATE bots SET paused_by = ?, updated_at = datetime('now') WHERE id = ?").run(pausedBy, id);
  }

  /** Bots created by `createdBy` since an ISO time (agent daily cap) */
  countCreatedSince(createdBy: 'human' | 'agent', sinceIso: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM bots WHERE created_by = ? AND created_at >= ?').get(createdBy, sinceIso) as { n: number }).n;
  }

  /** Bots created by `createdBy` that are not retired (agent active cap) */
  countActiveCreatedBy(createdBy: 'human' | 'agent'): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM bots WHERE created_by = ? AND stage <> 'retired'").get(createdBy) as { n: number }).n;
  }

  setTemplateVersion(id: string, templateVersion: number | null): void {
    this.db.prepare('UPDATE bots SET template_version = ? WHERE id = ?').run(templateVersion, id);
  }

  recordRuntimeError(id: string, at: string = new Date().toISOString()): void {
    this.db.prepare('UPDATE bots SET last_error_at = ? WHERE id = ?').run(at, id);
  }

  updateStatus(id: string, status: string): void {
    this.db
      .prepare("UPDATE bots SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id);
  }

  updateHeartbeat(id: string): void {
    this.db
      .prepare("UPDATE bots SET last_heartbeat = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(id);
    this.recordRunDay(id);
  }

  /** Mark that the bot was running on this UTC day (ramp: paper days actually run). */
  recordRunDay(id: string, at: Date = new Date()): void {
    this.db.prepare('INSERT OR IGNORE INTO bot_run_days (bot_id, day) VALUES (?, ?)').run(id, at.toISOString().slice(0, 10));
  }

  /** Distinct UTC days (YYYY-MM-DD ≥ fromDay) on which the bot was running. */
  countRunDays(id: string, fromDay: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM bot_run_days WHERE bot_id = ? AND day >= ?').get(id, fromDay) as { n: number };
    return row.n;
  }

  appendError(id: string, message: string, stack?: string): void {
    const bot = this.findById(id);
    if (!bot) return;

    const errors = JSON.parse(bot.error_logs || '[]');
    errors.push({ message, timestamp: new Date().toISOString(), stack });

    // Keep last 100 errors
    const trimmed = errors.slice(-100);

    this.db
      .prepare("UPDATE bots SET error_logs = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(trimmed), id);
  }

  delete(id: string): boolean {
    const bot = this.findById(id);
    if (!bot || bot.status !== 'stopped') return false;

    const result = this.db.prepare('DELETE FROM bots WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
