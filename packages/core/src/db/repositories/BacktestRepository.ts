import type Database from 'better-sqlite3';
import { generateId } from '../index';

// ============================================================================
// Types
// ============================================================================

export interface BacktestRunRow {
  id: string;
  script_id: string;
  script_name: string | null;
  symbol: string;
  interval: string;
  start_time: number;
  end_time: number;
  initial_balance: number;
  final_balance: number | null;
  total_trades: number;
  win_trades: number;
  lose_trades: number;
  total_pnl: number | null;
  max_drawdown: number | null;
  sharpe_ratio: number | null;
  config: string | null;
  status: string;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface BacktestTradeRow {
  id: string;
  run_id: string;
  side: string;
  symbol: string;
  price: number;
  quantity: number;
  quote_amount: number;
  timestamp: number;
  balance_after: number | null;
  created_at: string;
}

// ============================================================================
// Repository
// ============================================================================

export class BacktestRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Create a new backtest run record.
   */
  createRun(data: {
    scriptId: string;
    scriptName?: string;
    symbol: string;
    interval?: string;
    startTime: number;
    endTime: number;
    initialBalance: number;
    config?: Record<string, unknown>;
  }): BacktestRunRow {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO backtest_runs (id, script_id, script_name, symbol, interval, start_time, end_time, initial_balance, config, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`
      )
      .run(
        id,
        data.scriptId,
        data.scriptName || null,
        data.symbol,
        data.interval || '1m',
        data.startTime,
        data.endTime,
        data.initialBalance,
        data.config ? JSON.stringify(data.config) : null
      );

    return this.getRun(id)!;
  }

  /**
   * Update a backtest run with results or error.
   */
  updateRun(
    id: string,
    data: {
      finalBalance?: number;
      totalTrades?: number;
      winTrades?: number;
      loseTrades?: number;
      totalPnl?: number;
      maxDrawdown?: number;
      sharpeRatio?: number;
      status?: string;
      error?: string;
      durationMs?: number;
    }
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (data.finalBalance !== undefined) { sets.push('final_balance = ?'); values.push(data.finalBalance); }
    if (data.totalTrades !== undefined) { sets.push('total_trades = ?'); values.push(data.totalTrades); }
    if (data.winTrades !== undefined) { sets.push('win_trades = ?'); values.push(data.winTrades); }
    if (data.loseTrades !== undefined) { sets.push('lose_trades = ?'); values.push(data.loseTrades); }
    if (data.totalPnl !== undefined) { sets.push('total_pnl = ?'); values.push(data.totalPnl); }
    if (data.maxDrawdown !== undefined) { sets.push('max_drawdown = ?'); values.push(data.maxDrawdown); }
    if (data.sharpeRatio !== undefined) { sets.push('sharpe_ratio = ?'); values.push(data.sharpeRatio); }
    if (data.status !== undefined) { sets.push('status = ?'); values.push(data.status); }
    if (data.error !== undefined) { sets.push('error = ?'); values.push(data.error); }
    if (data.durationMs !== undefined) { sets.push('duration_ms = ?'); values.push(data.durationMs); }

    if (sets.length === 0) return;

    values.push(id);
    this.db
      .prepare(`UPDATE backtest_runs SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values);
  }

  /**
   * Get a single backtest run by ID.
   */
  getRun(id: string): BacktestRunRow | undefined {
    return this.db
      .prepare('SELECT * FROM backtest_runs WHERE id = ?')
      .get(id) as BacktestRunRow | undefined;
  }

  /**
   * List backtest runs, optionally filtered by script ID.
   * Returns most recent first.
   */
  listRuns(scriptId?: string): BacktestRunRow[] {
    if (scriptId) {
      return this.db
        .prepare('SELECT * FROM backtest_runs WHERE script_id = ? ORDER BY created_at DESC')
        .all(scriptId) as BacktestRunRow[];
    }
    return this.db
      .prepare('SELECT * FROM backtest_runs ORDER BY created_at DESC')
      .all() as BacktestRunRow[];
  }

  /**
   * Delete a backtest run and its trades (CASCADE).
   */
  deleteRun(id: string): boolean {
    // Manually delete trades first since SQLite CASCADE requires PRAGMA foreign_keys=ON
    this.db.prepare('DELETE FROM backtest_trades WHERE run_id = ?').run(id);
    const result = this.db.prepare('DELETE FROM backtest_runs WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * Add a trade record to a backtest run.
   */
  addTrade(data: {
    runId: string;
    side: string;
    symbol: string;
    price: number;
    quantity: number;
    quoteAmount: number;
    timestamp: number;
    balanceAfter?: number;
  }): void {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO backtest_trades (id, run_id, side, symbol, price, quantity, quote_amount, timestamp, balance_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.runId,
        data.side,
        data.symbol,
        data.price,
        data.quantity,
        data.quoteAmount,
        data.timestamp,
        data.balanceAfter ?? null
      );
  }

  /**
   * Get all trades for a backtest run, ordered by timestamp.
   */
  getTradesForRun(runId: string): BacktestTradeRow[] {
    return this.db
      .prepare('SELECT * FROM backtest_trades WHERE run_id = ? ORDER BY timestamp ASC')
      .all(runId) as BacktestTradeRow[];
  }
}
