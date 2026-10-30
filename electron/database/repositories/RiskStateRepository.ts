import type Database from 'better-sqlite3';

export const GLOBAL_SCOPE = 'global';

export interface RiskStateRow {
  scope: string; // 'global' or a bot id
  halted: number; // SQLite boolean (0/1)
  halted_reason: string | null;
  halted_at: string | null;
  day_start_equity: number | null;
  day_realized_pnl: number;
  day_unrealized_pnl: number;
  orders_last_hour: number;
  updated_at: string;
}

/**
 * Halts and daily P&L (spec §2.2): one 'global' row plus one row per bot.
 * Rows are created on first write; a missing bot row means "not halted".
 */
export class RiskStateRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  get(scope: string): RiskStateRow | undefined {
    return this.db.prepare('SELECT * FROM risk_state WHERE scope = ?').get(scope) as RiskStateRow | undefined;
  }

  getGlobal(): RiskStateRow | undefined {
    return this.get(GLOBAL_SCOPE);
  }

  isHalted(scope: string): boolean {
    return this.get(scope)?.halted === 1;
  }

  /** Set or clear a halt. Clearing is a human-only action (enforced by callers). */
  setHalted(scope: string, halted: boolean, reason: string | null = null): void {
    const haltedAt = halted ? new Date().toISOString() : null;
    this.db
      .prepare(
        `INSERT INTO risk_state (scope, halted, halted_reason, halted_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(scope) DO UPDATE SET
           halted = excluded.halted,
           halted_reason = excluded.halted_reason,
           halted_at = excluded.halted_at,
           updated_at = excluded.updated_at`
      )
      .run(scope, halted ? 1 : 0, halted ? reason : null, haltedAt);
  }

  updateDaily(
    scope: string,
    data: Partial<{
      dayStartEquity: number | null;
      dayRealizedPnl: number;
      dayUnrealizedPnl: number;
      ordersLastHour: number;
    }>
  ): void {
    this.db.prepare('INSERT OR IGNORE INTO risk_state (scope) VALUES (?)').run(scope);

    const sets: string[] = [];
    const values: unknown[] = [];
    if (data.dayStartEquity !== undefined) { sets.push('day_start_equity = ?'); values.push(data.dayStartEquity); }
    if (data.dayRealizedPnl !== undefined) { sets.push('day_realized_pnl = ?'); values.push(data.dayRealizedPnl); }
    if (data.dayUnrealizedPnl !== undefined) { sets.push('day_unrealized_pnl = ?'); values.push(data.dayUnrealizedPnl); }
    if (data.ordersLastHour !== undefined) { sets.push('orders_last_hour = ?'); values.push(data.ordersLastHour); }
    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now')");
    values.push(scope);
    this.db.prepare(`UPDATE risk_state SET ${sets.join(', ')} WHERE scope = ?`).run(...values);
  }
}
