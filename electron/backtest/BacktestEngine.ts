/**
 * BacktestEngine - Runs a compiled bot script against historical kline data.
 *
 * Reuses PaperTradingState for trade simulation with synthetic orderbooks
 * derived from candle OHLCV data. Each run gets fresh in-memory storage
 * so there's zero state leakage between backtests.
 */

import type Database from 'better-sqlite3';
import { PaperTradingState } from '../runtime/PaperTradingState';
import { BacktestRepository } from '../database/repositories/BacktestRepository';
import { fetchKlines } from './klineCache';
import type { BinanceKline, BinanceOrderBook } from '../sdk/binance';
import type { BotContext, BinanceTradeResult } from '../sdk/types';

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
  onProgress?: (pct: number) => void;
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
// InMemoryStorageRepo — implements BotStorageRepository interface without DB
// ============================================================================

class InMemoryStorageRepo {
  private store = new Map<string, Map<string, unknown>>();

  get(botId: string, key: string): unknown | null {
    const botStore = this.store.get(botId);
    if (!botStore) return null;
    const val = botStore.get(key);
    return val !== undefined ? val : null;
  }

  set(botId: string, key: string, value: unknown): void {
    if (!this.store.has(botId)) {
      this.store.set(botId, new Map());
    }
    this.store.get(botId)!.set(key, value);
  }

  delete(botId: string, key: string): boolean {
    const botStore = this.store.get(botId);
    if (!botStore) return false;
    return botStore.delete(key);
  }

  getAllForBot(botId: string): Record<string, unknown> {
    const botStore = this.store.get(botId);
    if (!botStore) return {};
    const result: Record<string, unknown> = {};
    for (const [k, v] of botStore) {
      result[k] = v;
    }
    return result;
  }

  deleteAllForBot(botId: string): void {
    this.store.delete(botId);
  }
}

// ============================================================================
// Synthetic Orderbook
// ============================================================================

/**
 * Build a realistic-looking orderbook from a kline candle.
 * Spread: 0.05% of close price. 5 depth levels each side.
 */
function buildSyntheticOrderBook(kline: BinanceKline): BinanceOrderBook {
  const close = kline.close;
  const spreadPct = 0.0005; // 0.05%
  const halfSpread = close * spreadPct / 2;

  const bidBase = close - halfSpread;
  const askBase = close + halfSpread;

  // Volume split across 5 levels (decreasing)
  const volumePerLevel = kline.volume / 15; // total across 5 levels

  const bids: Array<{ price: string; quantity: string }> = [];
  const asks: Array<{ price: string; quantity: string }> = [];

  for (let i = 0; i < 5; i++) {
    const levelOffset = close * 0.0001 * (i + 1); // 0.01% per level
    const levelVol = volumePerLevel * (5 - i); // more volume near top of book

    bids.push({
      price: (bidBase - levelOffset).toFixed(8),
      quantity: (levelVol / bidBase).toFixed(8),
    });

    asks.push({
      price: (askBase + levelOffset).toFixed(8),
      quantity: (levelVol / askBase).toFixed(8),
    });
  }

  return { bids, asks };
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
      initialBalance, config, scriptId, scriptName, onProgress,
    } = this.params;

    // 1. Create run record
    const run = backtestRepo.createRun({
      scriptId,
      scriptName,
      symbol: symbol.toUpperCase(),
      interval,
      startTime,
      endTime,
      initialBalance,
      config,
    });

    try {
      // 2. Fetch klines (from cache or API) at the user-selected interval
      const klines = await fetchKlines(db, symbol, startTime, endTime, interval);

      if (klines.length === 0) {
        throw new Error(`No kline data available for ${symbol} in the specified time range`);
      }

      // 3. Set up simulation state
      const memStorage = new InMemoryStorageRepo();
      const paperState = new PaperTradingState(
        `backtest-${run.id}`,
        initialBalance,
        memStorage as any // InMemoryStorageRepo matches the interface
      );

      // 4. Load the compiled script
      const moduleExports: Record<string, unknown> = {};
      const moduleObj = { exports: moduleExports };

      // Build a dummy ctx for module loading (scripts may reference ctx during load)
      const dummyCtx = this.buildCtx(
        paperState,
        memStorage,
        klines[0],
        symbol,
        config,
        run.id,
        backtestRepo
      );

      // eslint-disable-next-line no-new-func
      const factory = new Function('module', 'exports', 'require', 'ctx', compiledScript);
      factory(moduleObj, moduleExports, () => {
        throw new Error('require() is not available in backtest mode');
      }, dummyCtx);

      const exports = moduleObj.exports as Record<string, unknown>;
      const onTick = exports.onTick as ((ctx: BotContext) => Promise<void> | void) | undefined;
      const onStart = exports.onStart as ((ctx: BotContext) => Promise<void> | void) | undefined;

      if (!onTick && !onStart) {
        throw new Error('Script must export at least one of: onStart, onTick');
      }

      // 5. Run onStart if it exists (initialization logic)
      console.log(`[Backtest] Script loaded. onStart: ${!!onStart}, onTick: ${!!onTick}, klines: ${klines.length}`);
      if (onStart) {
        try {
          const startCtx = this.buildCtx(
            paperState, memStorage, klines[0], symbol, config, run.id, backtestRepo
          );
          await onStart(startCtx);
          console.log('[Backtest] onStart completed successfully');
        } catch (err) {
          console.error(`[Backtest] onStart error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 6. Main loop — iterate through each kline
      const equityCurve: number[] = [initialBalance];
      const tradeReturns: number[] = [];
      let tradeCount = 0;
      let winCount = 0;
      let loseCount = 0;
      let tickErrors = 0;
      let firstTickError: string | undefined;
      let prevBalance = initialBalance;

      for (let i = 0; i < klines.length; i++) {
        const kline = klines[i];

        // Build ctx for this tick
        const ctx = this.buildCtx(
          paperState,
          memStorage,
          kline,
          symbol,
          config,
          run.id,
          backtestRepo
        );

        // Call onTick
        if (onTick) {
          try {
            await onTick(ctx);
          } catch (err) {
            // Track tick errors — surface to user for debugging
            tickErrors++;
            if (!firstTickError) {
              firstTickError = err instanceof Error ? err.message : String(err);
              console.error(`[Backtest] First onTick error (tick ${i}): ${firstTickError}`);
            }
          }
        }

        // Track equity after this tick
        const currentBalance = paperState.getBinanceBalance('USDT');
        // Include position value at current close price
        const positions = paperState.getBinancePositions();
        let positionValue = 0;
        for (const pos of positions) {
          if (pos.asset !== 'USDT') {
            positionValue += pos.total * kline.close;
          }
        }
        const totalEquity = currentBalance + positionValue;
        equityCurve.push(totalEquity);

        // Detect if a trade happened this tick (balance changed)
        const balanceDelta = totalEquity - prevBalance;
        if (Math.abs(currentBalance - prevBalance) > 0.001 || Math.abs(balanceDelta) > 0.01) {
          // A trade likely happened
          if (balanceDelta > 0) winCount++;
          else if (balanceDelta < 0) loseCount++;
          tradeReturns.push(balanceDelta / prevBalance);
        }

        prevBalance = totalEquity;

        // Report progress
        if (onProgress && i % 100 === 0) {
          onProgress(Math.round((i / klines.length) * 100));
        }
      }

      console.log(`[Backtest] Loop complete: ${klines.length} klines, ${tickErrors} tick errors`);

      // 7. Count actual trades from the repository
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

      // 8. Compute final stats
      const finalEquity = equityCurve[equityCurve.length - 1];
      const totalPnl = finalEquity - initialBalance;
      const maxDrawdown = computeMaxDrawdown(equityCurve);
      const sharpeRatio = computeSharpeRatio(tradeReturns, getIntervalMs(interval));
      const durationMs = Date.now() - startMs;

      // 9. Update run record
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
          klinesProcessed: klines.length,
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

  /**
   * Build a BotContext-like object for a single tick.
   * Only exposes Binance methods, storage, and logging.
   * Polymarket, fetch, and timers are disabled.
   */
  private buildCtx(
    paperState: PaperTradingState,
    memStorage: InMemoryStorageRepo,
    kline: BinanceKline,
    symbol: string,
    config: Record<string, unknown>,
    runId: string,
    backtestRepo: BacktestRepository
  ): BotContext {
    const botId = `backtest-${runId}`;
    const upperSymbol = symbol.toUpperCase();
    const orderBook = buildSyntheticOrderBook(kline);

    // Helper to record a trade after execution
    const recordTrade = (side: string, result: BinanceTradeResult) => {
      if (result.success) {
        backtestRepo.addTrade({
          runId,
          side,
          symbol: result.symbol,
          price: result.avgPrice,
          quantity: result.executedQty,
          quoteAmount: result.cummulativeQuoteQty,
          timestamp: kline.openTime,
          balanceAfter: paperState.getBinanceBalance('USDT'),
        });
      }
    };

    const ctx = {
      config: Object.freeze({ ...config }),
      botId,
      botName: 'Backtest',
      now: kline.openTime,

      // === Polymarket (disabled in backtest) ===
      buy: async () => { throw new Error('Polymarket trading is not available in backtest mode'); },
      sell: async () => { throw new Error('Polymarket trading is not available in backtest mode'); },
      getOrderBook: async () => { throw new Error('Polymarket is not available in backtest mode'); },
      getPositions: async () => { throw new Error('Polymarket is not available in backtest mode'); },
      getBalance: async () => { throw new Error('Polymarket is not available in backtest mode'); },
      getMarkets: async () => { throw new Error('Polymarket is not available in backtest mode'); },
      getMarketPrice: async () => { throw new Error('Polymarket is not available in backtest mode'); },
      getEvent: async () => { throw new Error('Polymarket is not available in backtest mode'); },

      // === HTTP (disabled) ===
      fetch: async () => { throw new Error('fetch() is not available in backtest mode'); },

      // === Scheduling (disabled — backtest is synchronous) ===
      setInterval: () => { throw new Error('setInterval() is not available in backtest mode'); },
      setTimeout: () => { throw new Error('setTimeout() is not available in backtest mode'); },
      clearInterval: () => {},
      clearTimeout: () => {},

      // === Logging (no-op, just collect) ===
      log: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },

      // === Events (no-op) ===
      emit: () => {},

      // === Storage (in-memory) ===
      storage: {
        get: async <T = unknown>(key: string): Promise<T | null> => {
          return memStorage.get(botId, key) as T | null;
        },
        set: async (key: string, value: unknown): Promise<void> => {
          memStorage.set(botId, key, value);
        },
        delete: async (key: string): Promise<void> => {
          memStorage.delete(botId, key);
        },
      },

      // === Wallet (dummy) ===
      wallet: {
        address: '0x0000000000000000000000000000000000000000',
        proxyAddress: undefined,
      },

      // === Binance (simulated via PaperTradingState) ===
      binance: {
        buy: async (sym: string, quoteAmountUsdt: number): Promise<BinanceTradeResult> => {
          const ob = sym.toUpperCase() === upperSymbol ? orderBook : buildSyntheticOrderBook(kline);
          const result = paperState.simulateBinanceBuy(sym, quoteAmountUsdt, ob);
          recordTrade('BUY', result);
          return result;
        },
        sell: async (sym: string, quantity: number): Promise<BinanceTradeResult> => {
          const ob = sym.toUpperCase() === upperSymbol ? orderBook : buildSyntheticOrderBook(kline);
          const result = paperState.simulateBinanceSell(sym, quantity, ob);
          recordTrade('SELL', result);
          return result;
        },
        getBalance: async (asset?: string): Promise<number> => {
          return paperState.getBinanceBalance(asset || 'USDT');
        },
        getOrderBook: async (sym: string): Promise<BinanceOrderBook> => {
          return sym.toUpperCase() === upperSymbol ? orderBook : buildSyntheticOrderBook(kline);
        },
        getPrice: async (sym: string) => {
          return { symbol: sym.toUpperCase(), price: kline.close };
        },
        getPositions: async () => {
          return paperState.getBinancePositions();
        },
      },
    } as unknown as BotContext;

    return ctx;
  }
}
