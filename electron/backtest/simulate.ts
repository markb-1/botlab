/**
 * Backtest simulation (spec §5.1, §10): runs a compiled script against klines with PaperTradingState.
 * Pure and synchronous-safe to run inside a worker thread (backtest-worker.ts); no DB access — trades are
 * returned and written by BacktestEngine on the main thread.
 */

import { PaperTradingState } from '../runtime/PaperTradingState';
import { evaluateScript } from '../runtime/sandbox';
import type { BinanceKline, BinanceOrderBook } from '../sdk/binance';
import type { BotContext, BinanceTradeResult } from '../sdk/types';

export interface SimulationInput {
  compiledScript: string;
  klines: BinanceKline[];
  symbol: string;
  initialBalance: number;
  config: Record<string, unknown>;
  runId: string;
}

export interface SimulatedTrade {
  side: string;
  symbol: string;
  price: number;
  quantity: number;
  quoteAmount: number;
  timestamp: number;
  balanceAfter: number;
}

export interface SimulationOutput {
  trades: SimulatedTrade[];
  equityCurve: number[];
  tradeReturns: number[];
  /** Win/lose counts from equity changes (used when there are no trades) */
  winCount: number;
  loseCount: number;
  tickErrors: number;
  firstTickError?: string;
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
// Simulation loop
// ============================================================================

export async function runBacktestSimulation(input: SimulationInput): Promise<SimulationOutput> {
  const { compiledScript, klines, symbol, initialBalance, config, runId } = input;
  const trades: SimulatedTrade[] = [];

  // Set up simulation state (fresh in-memory storage per run)
  const memStorage = new InMemoryStorageRepo();
  const paperState = new PaperTradingState(
    `backtest-${runId}`,
    initialBalance,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    memStorage as any // InMemoryStorageRepo matches the interface
  );

  // Load the compiled script (scripts may reference ctx during load)
  const dummyCtx = buildCtx(paperState, memStorage, klines[0], symbol, config, runId, trades);
  const exports = evaluateScript(compiledScript, dummyCtx);
  const onTick = exports.onTick as ((ctx: BotContext) => Promise<void> | void) | undefined;
  const onStart = exports.onStart as ((ctx: BotContext) => Promise<void> | void) | undefined;

  if (typeof onTick !== 'function' && typeof onStart !== 'function') {
    throw new Error('Script must export at least one of: onStart, onTick');
  }

  // Run onStart if it exists (initialization logic)
  if (typeof onStart === 'function') {
    try {
      await onStart(buildCtx(paperState, memStorage, klines[0], symbol, config, runId, trades));
    } catch (err) {
      console.error(`[Backtest] onStart error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Main loop — iterate through each kline
  const equityCurve: number[] = [initialBalance];
  const tradeReturns: number[] = [];
  let winCount = 0;
  let loseCount = 0;
  let tickErrors = 0;
  let firstTickError: string | undefined;
  let prevBalance = initialBalance;

  for (let i = 0; i < klines.length; i++) {
    const kline = klines[i];
    const ctx = buildCtx(paperState, memStorage, kline, symbol, config, runId, trades);

    if (typeof onTick === 'function') {
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

    // Track equity after this tick, including position value at the close
    const currentBalance = paperState.getBinanceBalance('USDT');
    let positionValue = 0;
    for (const pos of paperState.getBinancePositions()) {
      if (pos.asset !== 'USDT') positionValue += pos.total * kline.close;
    }
    const totalEquity = currentBalance + positionValue;
    equityCurve.push(totalEquity);

    // Detect if a trade happened this tick (balance changed)
    const balanceDelta = totalEquity - prevBalance;
    if (Math.abs(currentBalance - prevBalance) > 0.001 || Math.abs(balanceDelta) > 0.01) {
      if (balanceDelta > 0) winCount++;
      else if (balanceDelta < 0) loseCount++;
      tradeReturns.push(balanceDelta / prevBalance);
    }
    prevBalance = totalEquity;
  }

  return { trades, equityCurve, tradeReturns, winCount, loseCount, tickErrors, firstTickError };
}

// ============================================================================
// Backtest ctx
// ============================================================================

/**
 * Build a BotContext-like object for a single tick.
 * Only exposes Binance methods, storage, and logging.
 * Polymarket, fetch, and timers are disabled.
 */
function buildCtx(
  paperState: PaperTradingState,
  memStorage: InMemoryStorageRepo,
  kline: BinanceKline,
  symbol: string,
  config: Record<string, unknown>,
  runId: string,
  trades: SimulatedTrade[]
): BotContext {
  const botId = `backtest-${runId}`;
  const upperSymbol = symbol.toUpperCase();
  const orderBook = buildSyntheticOrderBook(kline);

  // Helper to record a trade after execution
  const recordTrade = (side: string, result: BinanceTradeResult) => {
    if (result.success) {
      trades.push({
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
