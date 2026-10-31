/**
 * BacktestService — run / list / get / delete backtests (moved out of the Electron
 * `backtestHandlers`). Runs execute in a worker (BacktestEngine); no encryption key needed.
 */

import type Database from 'better-sqlite3';
import type { ScriptRepository } from '../db/repositories/ScriptRepository';
import type { BacktestRepository } from '../db/repositories/BacktestRepository';
import { BacktestEngine, type BacktestSource } from '../backtest/BacktestEngine';
import type { FeeRatesInput } from '../backtest/snapshotSimulate';
import type { OrderbookSnapshotRepository } from '../db/repositories/OrderbookSnapshotRepository';
import { ServiceError, invalidInput, notFound } from './errors';
import type { BacktestRunInput } from './schemas';

/** Polymarket snapshot backtests (spec §10) */
export interface SnapshotBacktestDeps {
  snapshotRepo: Pick<OrderbookSnapshotRepository, 'range'>;
  getFeeRates: (tokenId: string) => FeeRatesInput;
  getMaxTtlMinutes: () => number | undefined;
}

export interface BacktestServiceDeps {
  db: Database.Database;
  scriptRepo: ScriptRepository;
  backtestRepo: BacktestRepository;
  snapshots?: SnapshotBacktestDeps;
  /** Tests: compiled worker entry */
  workerPath?: string;
}

function runRowToView(run: any) {
  return {
    id: run.id as string,
    scriptId: run.script_id as string,
    scriptName: run.script_name as string | null,
    symbol: run.symbol as string,
    interval: run.interval as string,
    startTime: run.start_time as number,
    endTime: run.end_time as number,
    initialBalance: run.initial_balance as number,
    finalBalance: run.final_balance as number | null,
    totalTrades: run.total_trades as number | null,
    winTrades: run.win_trades as number | null,
    loseTrades: run.lose_trades as number | null,
    totalPnl: run.total_pnl as number | null,
    maxDrawdown: run.max_drawdown as number | null,
    sharpeRatio: run.sharpe_ratio as number | null,
    config: run.config ? JSON.parse(run.config) : null,
    status: run.status as string,
    error: run.error as string | null,
    durationMs: run.duration_ms as number | null,
    createdAt: run.created_at as string,
  };
}

export type BacktestRunView = ReturnType<typeof runRowToView>;

export class BacktestService {
  constructor(private deps: BacktestServiceDeps) {}

  /** Run a backtest for a script + symbol (Binance klines) or tokens (recorded Polymarket books) + time range */
  async run(data: BacktestRunInput) {
    const { db, scriptRepo, backtestRepo, snapshots } = this.deps;
    // Validate inputs
    const source = (data.source ?? 'binance-klines') as BacktestSource;
    if (source !== 'binance-klines' && source !== 'polymarket-snapshots') throw invalidInput(`unknown source ${String(source)}`);
    if (!data.scriptId) throw invalidInput('scriptId is required');
    if (source === 'binance-klines' && !data.symbol) throw invalidInput('symbol is required');
    let tokenIds: string[] | undefined;
    if (source === 'polymarket-snapshots') {
      if (!snapshots) throw new ServiceError('unavailable', 'Snapshot backtests are not available');
      if (!Array.isArray(data.tokenIds) || data.tokenIds.length === 0 || data.tokenIds.some((t) => typeof t !== 'string' || !t)) {
        throw invalidInput('tokenIds (non-empty array of token ids) is required');
      }
      if (data.tokenIds.length > 50) throw invalidInput('at most 50 tokens per backtest');
      tokenIds = data.tokenIds as string[];
    }
    if (!data.startTime || !data.endTime) throw invalidInput('startTime and endTime are required');
    if (data.startTime >= data.endTime) throw invalidInput('startTime must be before endTime');
    if (!data.initialBalance || data.initialBalance <= 0) throw invalidInput('initialBalance must be positive');

    // Fetch the script
    const script = scriptRepo.findById(data.scriptId);
    if (!script) throw notFound('Script not found');
    if (!script.compiled) throw invalidInput('Script has not been compiled. Save the script first.');

    // Create and run the engine
    const engine = new BacktestEngine({
      db,
      backtestRepo,
      compiledScript: script.compiled,
      symbol: data.symbol ?? '',
      interval: data.interval || '1h',
      startTime: data.startTime,
      endTime: data.endTime,
      initialBalance: data.initialBalance,
      config: data.config || {},
      scriptId: data.scriptId,
      scriptName: script.name,
      source,
      ...(this.deps.workerPath ? { workerPath: this.deps.workerPath } : {}),
      ...(source === 'polymarket-snapshots' && snapshots
        ? {
            tokenIds,
            loadSnapshots: (tokens: string[], from: number, to: number) => snapshots.snapshotRepo.range(tokens, from, to),
            getFeeRates: snapshots.getFeeRates,
            maxTtlMinutes: snapshots.getMaxTtlMinutes(),
          }
        : {}),
    });

    return engine.run();
  }

  /** Backtest runs, optionally of one script */
  list(scriptId?: string): BacktestRunView[] {
    return this.deps.backtestRepo.listRuns(scriptId).map(runRowToView);
  }

  /** One run with its trades */
  get(runId: string) {
    const { backtestRepo } = this.deps;
    const run = backtestRepo.getRun(runId);
    if (!run) throw notFound('Backtest run not found');

    const trades = backtestRepo.getTradesForRun(runId);

    return {
      run: runRowToView(run),
      trades: trades.map((t) => ({
        id: t.id,
        runId: t.run_id,
        side: t.side,
        symbol: t.symbol,
        price: t.price,
        quantity: t.quantity,
        quoteAmount: t.quote_amount,
        timestamp: t.timestamp,
        balanceAfter: t.balance_after,
        createdAt: t.created_at,
      })),
    };
  }

  /** Delete a run and its trades */
  delete(runId: string): { deleted: true } {
    const deleted = this.deps.backtestRepo.deleteRun(runId);
    if (!deleted) throw notFound('Backtest run not found');
    return { deleted: true };
  }
}
