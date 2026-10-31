import type Database from 'better-sqlite3';

export const GLOBAL_SCOPE = 'global';

export interface RiskStateRow {
  scope: string; // 'global' or a bot id
  halted: number; // SQLite boolean (0/1)
  halted_reason: string | null;
  halted_at: string | null; // ISO
  day_start_equity: number | null;
  day_realized_pnl: number;
  day_unrealized_pnl: number;
  orders_last_hour: number;
  updated_at: string; // ISO
  /** Global row: ISO start (00:00 UTC) of the day the marks below belong to */
  day_start: string | null;
  /** Global row: JSON { "exchange:symbol": mid } captured at the first monitor run of the day */
  day_start_marks: string | null;
  /** Global row: JSON { "exchange:symbol": { price, at } } last mid seen per symbol */
  last_marks: string | null;
  /** Last time a halt was set (kept when the halt is cleared; used by the ramp) */
  last_halted_at: string | null;
  /** Bot rows: probation drawdown tracking since this stage change (bots.stage_changed_at) */
  ramp_since: string | null;
  ramp_pnl_peak: number | null;
  ramp_max_drawdown_usd: number | null;
  /** Today's total P&L of live / paper fills (global row: live only) */
  day_live_pnl: number | null;
  day_paper_pnl: number | null;
  /** JSON LossBaseline: P&L at the moment a human cleared a halt; the loss limit counts from there */
  loss_baseline: string | null;
}

export interface LossBaseline {
  /** ISO day start the baseline belongs to; ignored on other days */
  day: string;
  live: number;
  paper: number;
  at: string;
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

  all(): RiskStateRow[] {
    return this.db.prepare('SELECT * FROM risk_state').all() as RiskStateRow[];
  }

  /**
   * Set or clear a halt. Clearing is a human-only action (enforced by HaltService).
   * Setting a halt on an already halted scope keeps the original reason and time.
   */
  setHalted(scope: string, halted: boolean, reason: string | null = null): void {
    const now = new Date().toISOString();
    if (halted && this.isHalted(scope)) return;
    this.db
      .prepare(
        `INSERT INTO risk_state (scope, halted, halted_reason, halted_at, last_halted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           halted = excluded.halted,
           halted_reason = excluded.halted_reason,
           halted_at = excluded.halted_at,
           last_halted_at = COALESCE(excluded.last_halted_at, risk_state.last_halted_at),
           updated_at = excluded.updated_at`
      )
      .run(scope, halted ? 1 : 0, halted ? reason : null, halted ? now : null, halted ? now : null, now);
  }

  /** Global row: mark maps for the daily P&L (see RiskMonitor). */
  setMarks(data: Partial<{ dayStart: string; dayStartMarks: Record<string, number>; lastMarks: Record<string, { price: number; at: string }> }>): void {
    const now = new Date().toISOString();
    this.db.prepare('INSERT OR IGNORE INTO risk_state (scope, updated_at) VALUES (?, ?)').run(GLOBAL_SCOPE, now);
    const sets: string[] = [];
    const values: unknown[] = [];
    if (data.dayStart !== undefined) { sets.push('day_start = ?'); values.push(data.dayStart); }
    if (data.dayStartMarks !== undefined) { sets.push('day_start_marks = ?'); values.push(JSON.stringify(data.dayStartMarks)); }
    if (data.lastMarks !== undefined) { sets.push('last_marks = ?'); values.push(JSON.stringify(data.lastMarks)); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(now, GLOBAL_SCOPE);
    this.db.prepare(`UPDATE risk_state SET ${sets.join(', ')} WHERE scope = ?`).run(...values);
  }

  setLossBaseline(scope: string, baseline: LossBaseline | null): void {
    const now = new Date().toISOString();
    this.db.prepare('INSERT OR IGNORE INTO risk_state (scope, updated_at) VALUES (?, ?)').run(scope, now);
    this.db
      .prepare('UPDATE risk_state SET loss_baseline = ?, updated_at = ? WHERE scope = ?')
      .run(baseline ? JSON.stringify(baseline) : null, now, scope);
  }

  getLossBaseline(scope: string): LossBaseline | null {
    const text = this.get(scope)?.loss_baseline;
    if (!text) return null;
    try {
      const b = JSON.parse(text) as LossBaseline;
      return typeof b.day === 'string' && Number.isFinite(b.live) && Number.isFinite(b.paper) ? b : null;
    } catch {
      return null;
    }
  }

  /** Bot rows: probation drawdown tracking. */
  setRampTracking(scope: string, data: { since: string | null; peak: number | null; maxDrawdownUsd: number | null }): void {
    const now = new Date().toISOString();
    this.db.prepare('INSERT OR IGNORE INTO risk_state (scope, updated_at) VALUES (?, ?)').run(scope, now);
    this.db
      .prepare('UPDATE risk_state SET ramp_since = ?, ramp_pnl_peak = ?, ramp_max_drawdown_usd = ?, updated_at = ? WHERE scope = ?')
      .run(data.since, data.peak, data.maxDrawdownUsd, now, scope);
  }

  updateDaily(
    scope: string,
    data: Partial<{
      dayStartEquity: number | null;
      dayRealizedPnl: number;
      dayUnrealizedPnl: number;
      ordersLastHour: number;
      dayLivePnl: number;
      dayPaperPnl: number;
    }>
  ): void {
    const now = new Date().toISOString();
    this.db.prepare('INSERT OR IGNORE INTO risk_state (scope, updated_at) VALUES (?, ?)').run(scope, now);

    const sets: string[] = [];
    const values: unknown[] = [];
    if (data.dayStartEquity !== undefined) { sets.push('day_start_equity = ?'); values.push(data.dayStartEquity); }
    if (data.dayRealizedPnl !== undefined) { sets.push('day_realized_pnl = ?'); values.push(data.dayRealizedPnl); }
    if (data.dayUnrealizedPnl !== undefined) { sets.push('day_unrealized_pnl = ?'); values.push(data.dayUnrealizedPnl); }
    if (data.ordersLastHour !== undefined) { sets.push('orders_last_hour = ?'); values.push(data.ordersLastHour); }
    if (data.dayLivePnl !== undefined) { sets.push('day_live_pnl = ?'); values.push(data.dayLivePnl); }
    if (data.dayPaperPnl !== undefined) { sets.push('day_paper_pnl = ?'); values.push(data.dayPaperPnl); }
    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    values.push(now, scope);
    this.db.prepare(`UPDATE risk_state SET ${sets.join(', ')} WHERE scope = ?`).run(...values);
  }
}
