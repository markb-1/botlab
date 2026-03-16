/**
 * BotContextProxy - runs inside the worker thread.
 * Provides the BotContext interface to user scripts.
 * Trading/storage/logging calls are proxied to the main process via RPC.
 * Scheduling (setInterval/setTimeout) runs locally in the worker but is tracked for cleanup.
 */

import { parentPort } from 'worker_threads';
import type {
  BotContext,
  BotLogger,
  BotStorage,
  WalletInfo,
  TradeResult,
  OrderBook,
  Position,
  MarketPrice,
  Market,
  PolymarketEvent,
  OrderOpts,
  MarketQuery,
  BinanceContext,
  BinanceTradeResult,
  BinanceOrderBook,
  BinancePosition,
  BinancePrice,
  KellyContext,
  RpcRequest,
  RpcResponse,
} from '../sdk/types';
import { calculateKelly, DEFAULT_KELLY_CONFIG } from '../../src/utils/kellyCalculator';

let rpcIdCounter = 0;
const pendingRpcs = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/**
 * Send an RPC request to the main process and wait for the response
 */
function rpcCall(method: string, ...args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `rpc_${++rpcIdCounter}`;
    pendingRpcs.set(id, { resolve, reject });

    const request: RpcRequest = {
      id,
      method: method as RpcRequest['method'],
      args,
    };

    parentPort!.postMessage({ type: 'rpc-request', request });
  });
}

/**
 * Handle RPC response from main process
 */
export function handleRpcResponse(response: RpcResponse): void {
  const pending = pendingRpcs.get(response.id);
  if (pending) {
    pendingRpcs.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error));
    } else {
      pending.resolve(response.result);
    }
  }
}

/**
 * Create a BotContext for user scripts
 */
export function createBotContext(params: {
  botId: string;
  botName: string;
  config: Record<string, unknown>;
  walletAddress: string;
  proxyAddress?: string;
}): BotContext {
  // Track timers for cleanup
  const intervals = new Map<string, ReturnType<typeof globalThis.setInterval>>();
  const timeouts = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
  let timerCounter = 0;

  const log: BotLogger = {
    info: (...args: unknown[]) => rpcCall('log', 'info', ...args),
    warn: (...args: unknown[]) => rpcCall('log', 'warn', ...args),
    error: (...args: unknown[]) => rpcCall('log', 'error', ...args),
    debug: (...args: unknown[]) => rpcCall('log', 'debug', ...args),
  };

  const storage: BotStorage = {
    get: <T = unknown>(key: string) => rpcCall('storage:get', key) as Promise<T | null>,
    set: (key: string, value: unknown) => rpcCall('storage:set', key, value) as Promise<void>,
    delete: (key: string) => rpcCall('storage:delete', key) as Promise<void>,
  };

  const wallet: WalletInfo = {
    address: params.walletAddress,
    proxyAddress: params.proxyAddress,
  };

  const ctx: BotContext = {
    config: Object.freeze({ ...params.config }),
    botId: params.botId,
    botName: params.botName,
    get now() { return Date.now(); },

    // Polymarket Trading
    buy: (tokenId: string, amountUsd: number, opts?: OrderOpts) =>
      rpcCall('polymarket:buy', tokenId, amountUsd, opts) as Promise<TradeResult>,
    sell: (tokenId: string, amountTokens: number, opts?: OrderOpts) =>
      rpcCall('polymarket:sell', tokenId, amountTokens, opts) as Promise<TradeResult>,
    getOrderBook: (tokenId: string) =>
      rpcCall('polymarket:getOrderBook', tokenId) as Promise<OrderBook>,
    getPositions: () => rpcCall('polymarket:getPositions') as Promise<Position[]>,
    getBalance: () => rpcCall('polymarket:getBalance') as Promise<number>,

    // Polymarket Market Data
    getMarkets: (query?: MarketQuery) =>
      rpcCall('polymarket:getMarkets', query) as Promise<Market[]>,
    getMarketPrice: (tokenId: string) =>
      rpcCall('polymarket:getMarketPrice', tokenId) as Promise<MarketPrice>,
    getEvent: (eventSlug: string) =>
      rpcCall('polymarket:getEvent', eventSlug) as Promise<PolymarketEvent>,

    // HTTP (runs directly in worker - full autonomy)
    fetch: globalThis.fetch,

    // Scheduling (local in worker, tracked for cleanup)
    setInterval: (fn: () => void | Promise<void>, ms: number): string => {
      const handle = `interval_${++timerCounter}`;
      const id = globalThis.setInterval(async () => {
        try {
          await fn();
        } catch (err) {
          log.error(`Interval error: ${err instanceof Error ? err.message : err}`);
        }
      }, ms);
      intervals.set(handle, id);
      return handle;
    },

    setTimeout: (fn: () => void | Promise<void>, ms: number): string => {
      const handle = `timeout_${++timerCounter}`;
      const id = globalThis.setTimeout(async () => {
        timeouts.delete(handle);
        try {
          await fn();
        } catch (err) {
          log.error(`Timeout error: ${err instanceof Error ? err.message : err}`);
        }
      }, ms);
      timeouts.set(handle, id);
      return handle;
    },

    clearInterval: (handle: string) => {
      const id = intervals.get(handle);
      if (id !== undefined) {
        globalThis.clearInterval(id);
        intervals.delete(handle);
      }
    },

    clearTimeout: (handle: string) => {
      const id = timeouts.get(handle);
      if (id !== undefined) {
        globalThis.clearTimeout(id);
        timeouts.delete(handle);
      }
    },

    log,
    emit: (type: string, data?: Record<string, unknown>) => {
      rpcCall('emit', type, data);
    },
    storage,
    wallet,

    // Binance spot trading
    binance: {
      buy: (symbol: string, quoteAmountUsdt: number) =>
        rpcCall('binance:buy', symbol, quoteAmountUsdt) as Promise<BinanceTradeResult>,
      sell: (symbol: string, quantity: number) =>
        rpcCall('binance:sell', symbol, quantity) as Promise<BinanceTradeResult>,
      getBalance: (asset?: string) =>
        rpcCall('binance:getBalance', asset) as Promise<number>,
      getOrderBook: (symbol: string, limit?: number) =>
        rpcCall('binance:getOrderBook', symbol, limit) as Promise<BinanceOrderBook>,
      getPrice: (symbol: string) =>
        rpcCall('binance:getPrice', symbol) as Promise<BinancePrice>,
      getPositions: () =>
        rpcCall('binance:getPositions') as Promise<BinancePosition[]>,
    } as BinanceContext,

    // Kelly Criterion (pure math, runs locally in worker)
    kelly: {
      calculate: calculateKelly,
      DEFAULT_CONFIG: DEFAULT_KELLY_CONFIG,
    } as KellyContext,
  };

  return ctx;
}

/**
 * Clear all tracked timers (called on stop)
 */
export function clearAllTimers(ctx: BotContext): void {
  // We can't access internal maps from outside, but on stop the worker exits
  // and all timers are automatically cleaned up. This is a no-op placeholder.
}
