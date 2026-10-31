/**
 * BacktestEngine - Runs a compiled bot script against historical kline data.
 *
 * Reuses PaperTradingState for trade simulation with synthetic orderbooks
 * derived from candle OHLCV data. Each run gets fresh in-memory storage
 * so there's zero state leakage between backtests.
 *
 * The script runs in a worker thread (simulate.ts via backtest-worker.ts) with the bot sandbox and an
 * overall timeout; klines are fetched and results stored here on the main thread.
 */

import type Database from 'better-sqlite3';
import path from 'path';
import { Worker } from 'worker_threads';
import { BacktestRepository } from '../database/repositories/BacktestRepository';
import { fetchKlines } from './klineCache';
import { SCRIPT_WORKER_RESOURCE_LIMITS } from '../runtime/sandbox';
import type { SimulationInput, SimulationOutput } from './simulate';
import type { FeeRatesInput, SnapshotSimulationInput, SnapshotSimulationOutput } from './snapshotSimulate';
import type { BookSnapshot } from '../recorder/snapshotCodec';

/** A backtest (script load + simulation) is terminated after this (spec §5.1). */
export const BACKTEST_TIMEOUT_MS = 120_000;
/** Snapshots copied to the worker in one run (memory); narrow the range or tokens beyond this */
export const MAX_BACKTEST_SNAPSHOTS = 300_000;

export type BacktestSource = 'binance-klines' | 'polymarket-snapshots';

// ============================================================================
// Types
// ============================================================================

export interface BacktestParams {
  db: Database.Database;
  backtestRepo: BacktestRepository;
  compiledScript: string;
  symbol: string;
  interval: string;
  startTime: number;
  endTime: number;
  initialBalance: number;
  config: Record<string, unknown>;
  scriptId: string;
  scriptName: string;
  /** Data source (default binance-klines: the original path, unchanged) */
  source?: BacktestSource;
  /** polymarket-snapshots: tokens to replay (symbol/interval are ignored) */
  tokenIds?: string[];
  /** polymarket-snapshots: recorded snapshots of the tokens in [from, to], oldest first */
  loadSnapshots?: (tokenIds: string[], fromMs: number, toMs: number) => BookSnapshot[];
  /** polymarket-snapshots: fee rates per token (FeeService; unknown ⇒ highest taker rate) */
  getFeeRates?: (tokenId: string) => FeeRatesInput;
  /** polymarket-snapshots: resting order TTL cap (limits.orders.resting_order_ttl_minutes) */
  maxTtlMinutes?: number;
  /** Overall timeout for the worker (default BACKTEST_TIMEOUT_MS) */
  timeoutMs?: number;
  /** Compiled worker entry (default: backtest-worker.js next to this file; tests pass a bundle) */
  workerPath?: string;
}

export interface BacktestResult {
  runId: string;
  status: 'completed' | 'error';
  error?: string;
  stats: {
    initialBalance: number;
    finalBalance: number;
    totalPnl: number;
    totalPnlPct: number;
    totalTrades: number;
    winTrades: number;
    loseTrades: number;
    winRate: number;
    maxDrawdown: number;
    sharpeRatio: number;
    durationMs: number;
    klinesProcessed: number;
    tickErrors: number;
    firstTickError?: string;
  };
}

// ============================================================================
// Stats Computation
// ============================================================================

function computeMaxDrawdown(equityCurve: number[]): number {
  if (equityCurve.length === 0) return 0;

  let peak = equityCurve[0];
  let maxDd = 0;

  for (const equity of equityCurve) {
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  return maxDd;
}

function computeSharpeRatio(returns: number[], intervalMs: number): number {
  if (returns.length < 2) return 0;

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // Annualize based on candle interval: periods per year = (365.25 * 24 * 60 * 60 * 1000) / intervalMs
  const periodsPerYear = (365.25 * 24 * 60 * 60 * 1000) / intervalMs;
  const annualizationFactor = Math.sqrt(periodsPerYear);
  return (mean / stdDev) * annualizationFactor;
}

function getIntervalMs(interval: string): number {
  const map: Record<string, number> = {
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000,
    '15m': 900_000,
    '30m': 1_800_000,
    '1h': 3_600_000,
    '4h': 14_400_000,
    '1d': 86_400_000,
  };
  return map[interval] || 3_600_000;
}

// ============================================================================
// BacktestEngine
// ============================================================================

export class BacktestEngine {
  private params: BacktestParams;

  constructor(params: BacktestParams) {
    this.params = params;
  }

  async run(): Promise<BacktestResult> {
    const startMs = Date.now();
    const {
      db, backtestRepo, compiledScript, symbol, interval, startTime, endTime,
      initialBalance, config, scriptId, scriptName,
    } = this.params;

    const snapshots = this.params.source === 'polymarket-snapshots';
    const tokenIds = [...new Set((this.params.tokenIds ?? []).filter((t) => typeof t === 'string' && t.length > 0))];

    // 1. Create run record
    const run = backtestRepo.createRun({
      scriptId,
      scriptName,
      symbol: snapshots ? `polymarket:${tokenIds.join(',')}`.slice(0, 500) : symbol.toUpperCase(),
      interval: snapshots ? 'snapshots' : interval,
      startTime,
      endTime,
      initialBalance,
      config,
    });

    try {
      let sim: SimulationOutput;
      let processed: number;
      let intervalMs: number;
      const timeoutMs = this.params.timeoutMs ?? BACKTEST_TIMEOUT_MS;
      const workerPath = this.params.workerPath ?? path.join(__dirname, 'backtest-worker.js');
      if (snapshots) {
        // 2b. Recorded Polymarket order books (spec §10)
        if (tokenIds.length === 0) throw new Error('tokenIds are required for a polymarket-snapshots backtest');
        if (!this.params.loadSnapshots) throw new Error('Order-book snapshots are not available');
        const snaps = this.params.loadSnapshots(tokenIds, startTime, endTime);
        if (snaps.length === 0) throw new Error('No recorded order-book snapshots for these tokens in the time range');
        if (snaps.length > MAX_BACKTEST_SNAPSHOTS) {
          throw new Error(`${snaps.length} snapshots in range (max ${MAX_BACKTEST_SNAPSHOTS}); narrow the time range or tokens`);
        }
        const fees: Record<string, FeeRatesInput> = {};
        for (const t of tokenIds) fees[t] = this.params.getFeeRates ? this.params.getFeeRates(t) : { takerRate: 0, makerRate: 0 };
        const input: SnapshotSimulationInput = {
          source: 'polymarket-snapshots',
          compiledScript,
          snapshots: snaps,
          tokenIds,
          initialBalance,
          config,
          runId: run.id,
          fees,
          defaultFees: fees[tokenIds[0]],
          maxTtlMinutes: this.params.maxTtlMinutes,
        };
        const out = (await runSimulationInWorker(input, timeoutMs, workerPath)) as SnapshotSimulationOutput;
        sim = out;
        processed = out.steps;
        intervalMs = out.stepIntervalMs > 0 ? out.stepIntervalMs : 60_000;
      } else {
        // 2. Fetch klines (from cache or API) at the user-selected interval
        const klines = await fetchKlines(db, symbol, startTime, endTime, interval);

        if (klines.length === 0) {
          throw new Error(`No kline data available for ${symbol} in the specified time range`);
        }

        // 3. Run the script against the klines in a sandboxed worker (timeout ⇒ terminated)
        sim = await runSimulationInWorker({ compiledScript, klines, symbol, initialBalance, config, runId: run.id }, timeoutMs, workerPath);
        processed = klines.length;
        intervalMs = getIntervalMs(interval);
      }
      const { equityCurve, tradeReturns, tickErrors, firstTickError } = sim;
      let { winCount, loseCount } = sim;
      let tradeCount = 0;
      console.log(`[Backtest] Simulation complete: ${processed} ${snapshots ? 'snapshot steps' : 'klines'}, ${tickErrors} tick errors`);

      // 4. Store the simulated trades
      db.transaction(() => {
        for (const t of sim.trades) backtestRepo.addTrade({ runId: run.id, ...t });
      })();

      // 5. Count actual trades from the repository
      const trades = backtestRepo.getTradesForRun(run.id);
      tradeCount = trades.length;

      // Recompute win/lose from actual trades
      if (trades.length > 0) {
        winCount = 0;
        loseCount = 0;
        for (let i = 0; i < trades.length; i++) {
          const trade = trades[i];
          // For buy trades, we can't determine win/lose immediately
          // For sell trades, compare sell price * qty vs what was paid
          // Simplified: use balance change around the trade
          if (i > 0 && trade.balance_after !== null) {
            const prevBal = trades[i - 1].balance_after ?? initialBalance;
            if (trade.balance_after > prevBal) winCount++;
            else if (trade.balance_after < prevBal) loseCount++;
          }
        }
      }

      // 6. Compute final stats
      const finalEquity = equityCurve[equityCurve.length - 1];
      const totalPnl = finalEquity - initialBalance;
      const maxDrawdown = computeMaxDrawdown(equityCurve);
      const sharpeRatio = computeSharpeRatio(tradeReturns, intervalMs);
      const durationMs = Date.now() - startMs;

      // 7. Update run record
      backtestRepo.updateRun(run.id, {
        finalBalance: finalEquity,
        totalTrades: tradeCount,
        winTrades: winCount,
        loseTrades: loseCount,
        totalPnl,
        maxDrawdown,
        sharpeRatio,
        status: 'completed',
        durationMs,
      });

      return {
        runId: run.id,
        status: 'completed',
        stats: {
          initialBalance,
          finalBalance: finalEquity,
          totalPnl,
          totalPnlPct: initialBalance > 0 ? (totalPnl / initialBalance) * 100 : 0,
          totalTrades: tradeCount,
          winTrades: winCount,
          loseTrades: loseCount,
          winRate: tradeCount > 0 ? (winCount / tradeCount) * 100 : 0,
          maxDrawdown,
          sharpeRatio,
          durationMs,
          klinesProcessed: processed,
          tickErrors,
          firstTickError,
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startMs;

      backtestRepo.updateRun(run.id, {
        status: 'error',
        error: errorMsg,
        durationMs,
      });

      return {
        runId: run.id,
        status: 'error',
        error: errorMsg,
        stats: {
          initialBalance,
          finalBalance: initialBalance,
          totalPnl: 0,
          totalPnlPct: 0,
          totalTrades: 0,
          winTrades: 0,
          loseTrades: 0,
          winRate: 0,
          maxDrawdown: 0,
          sharpeRatio: 0,
          durationMs,
          klinesProcessed: 0,
          tickErrors: 0,
        },
      };
    }
  }
}

/** Run the simulation in a worker; terminate it after `timeoutMs`. */
export function runSimulationInWorker(input: SimulationInput | SnapshotSimulationInput, timeoutMs: number, workerPath: string): Promise<SimulationOutput> {
  return new Promise<SimulationOutput>((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: input,
      env: {},
      resourceLimits: SCRIPT_WORKER_RESOURCE_LIMITS,
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Backtest timed out after ${Math.round(timeoutMs / 1000)} s (script terminated)`))),
      timeoutMs
    );
    worker.on('message', (msg: { type: 'result'; output: SimulationOutput } | { type: 'error'; error: string }) => {
      if (msg.type === 'result') finish(() => resolve(msg.output));
      else finish(() => reject(new Error(msg.error)));
    });
    worker.on('error', (err) => finish(() => reject(err)));
    worker.on('exit', (code) => finish(() => reject(new Error(`Backtest worker exited with code ${code}`))));
  });
}
