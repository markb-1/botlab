import type Database from 'better-sqlite3';

/** `human` (UI/IPC), `agent` (MCP, later), `system` (server jobs), or `bot:<id>`. */
export type AuditActor = 'human' | 'agent' | 'system' | `bot:${string}`;

export interface AuditRow {
  id: number;
  ts: string; // ISO
  actor: string;
  action: string;
  target: string | null;
  payload: string | null; // JSON
  result: string | null;
}

export interface AuditEntry {
  actor: AuditActor;
  action: string;
  target?: string | null;
  payload?: unknown;
  result?: string | null;
}

/**
 * audit_log (spec §2.2): append-only. There is deliberately no update or delete method,
 * and database triggers abort any UPDATE/DELETE on the table.
 */
export class AuditRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  append(entry: AuditEntry, ts: string = new Date().toISOString()): AuditRow {
    const info = this.db
      .prepare('INSERT INTO audit_log (ts, actor, action, target, payload, result) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        ts,
        entry.actor,
        entry.action,
        entry.target ?? null,
        entry.payload !== undefined ? JSON.stringify(entry.payload) : null,
        entry.result ?? null
      );
    return this.db.prepare('SELECT * FROM audit_log WHERE id = ?').get(info.lastInsertRowid) as AuditRow;
  }

  /** Newest first. `beforeId` pages backwards (ids below it); `untilIso` is exclusive. */
  list(
    filter: {
      action?: string;
      actionPrefix?: string;
      actor?: string;
      target?: string;
      sinceIso?: string;
      untilIso?: string;
      beforeId?: number;
      limit?: number;
    } = {}
  ): AuditRow[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter.action) { conditions.push('action = ?'); values.push(filter.action); }
    if (filter.actionPrefix) { conditions.push("action LIKE ? ESCAPE '\\'"); values.push(`${filter.actionPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
    if (filter.actor) { conditions.push('actor = ?'); values.push(filter.actor); }
    if (filter.target) { conditions.push('target = ?'); values.push(filter.target); }
    if (filter.sinceIso) { conditions.push('ts >= ?'); values.push(filter.sinceIso); }
    if (filter.untilIso) { conditions.push('ts < ?'); values.push(filter.untilIso); }
    if (filter.beforeId !== undefined) { conditions.push('id < ?'); values.push(filter.beforeId); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(filter.limit ?? 200);
    return this.db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`).all(...values) as AuditRow[];
  }

  /** Distinct action names (audit page filter) */
  actions(): string[] {
    return (this.db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all() as Array<{ action: string }>).map((r) => r.action);
  }
}
