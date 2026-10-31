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
  PolymarketContext,
  RiskContext,
  BotForecast,
  LedgerContext,
  LimitOrderOpts,
  OrderResult,
  OpenOrder,
  FeeRates,
  MarketDetail,
  BotExitFlag,
  ExitPolicy,
  RiskBudget,
  RpcRequest,
  RpcResponse,
  ScriptFetchInit,
  ScriptResponse,
  BotPushEventName,
  BotPushEventHandler,
  EventsContext,
  PortfolioContext,
  PortfolioPosition,
  PortfolioExitFlag,
  ExitRequest,
  OrderHistoryEntry,
  CapitalDemand,
  MandateSummary,
  CopyContext,
  CopyLeaderStatus,
} from '../sdk/types';
import { calculateKelly, DEFAULT_KELLY_CONFIG } from '../utils/kellyCalculator';

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

// ─── Push events (ctx.events, spec §5.2) ───────────────────────────────
const PUSH_EVENTS: readonly BotPushEventName[] = ['forecast_changed', 'rules_changed', 'halt'];
const eventHandlers = new Map<BotPushEventName, Set<BotPushEventHandler>>();

const eventsContext: EventsContext = {
  on(name, handler) {
    if (!PUSH_EVENTS.includes(name)) throw new Error(`Unknown event ${String(name)} (expected ${PUSH_EVENTS.join(', ')})`);
    if (typeof handler !== 'function') throw new Error('handler must be a function');
    let set = eventHandlers.get(name);
    if (!set) eventHandlers.set(name, (set = new Set()));
    set.add(handler);
  },
  off(name, handler) {
    eventHandlers.get(name)?.delete(handler);
  },
};

/** Called by the bootstrap for a 'bot-event' message: runs the script's handlers; errors go to the bot log. */
export async function dispatchBotEvent(name: BotPushEventName, data: Record<string, unknown>): Promise<void> {
  const handlers = [...(eventHandlers.get(name) ?? [])];
  for (const h of handlers) {
    try {
      await h(data ?? {});
    } catch (err) {
      void rpcCall('log', 'error', `ctx.events ${name} handler failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
    }
  }
}

interface FetchResultWire {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** ctx.fetch: the request runs in the main process; the result is wrapped in a Response-like object. */
async function scriptFetchProxy(url: unknown, init?: ScriptFetchInit): Promise<ScriptResponse> {
  // Only plain data crosses the boundary (URL objects, Headers, streams are not supported)
  const wireInit = init
    ? { method: init.method, headers: init.headers ? { ...init.headers } : undefined, body: init.body }
    : undefined;
  const r = (await rpcCall('fetch', String(url), wireInit)) as FetchResultWire;
  const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: r.ok,
    status: r.status,
    statusText: r.statusText,
    url: r.url,
    headers: { get: (name: string) => headers.get(String(name).toLowerCase()) ?? null },
    text: async () => r.body,
    json: async <T = unknown>() => JSON.parse(r.body) as T,
  };
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

    // HTTP: proxied to the main process (allowlisted hosts only, see scriptFetch.ts)
    fetch: (url: string, init?: ScriptFetchInit) => scriptFetchProxy(url, init),

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

    // Polymarket orders v2: every call goes through OrderService + RiskEngine in the main process
    polymarket: {
      placeLimit: (tokenId: string, side: 'buy' | 'sell', price: number, size: number, opts?: LimitOrderOpts) =>
        rpcCall('polymarket:placeLimit', tokenId, side, price, size, opts) as Promise<OrderResult>,
      cancel: (orderId: string) => rpcCall('polymarket:cancel', orderId) as Promise<void>,
      cancelAll: () => rpcCall('polymarket:cancelAll') as ReturnType<PolymarketContext['cancelAll']>,
      getOpenOrders: () => rpcCall('polymarket:getOpenOrders') as Promise<OpenOrder[]>,
      getOrderHistory: (days?: number) => rpcCall('polymarket:getOrderHistory', days) as Promise<OrderHistoryEntry[]>,
      getFee: (tokenId: string) => rpcCall('polymarket:getFee', tokenId) as Promise<FeeRates>,
      getMarket: (idOrTokenId: string) => rpcCall('polymarket:getMarket', idOrTokenId) as Promise<MarketDetail | null>,
      getEventMarketIds: (eventId: string) => rpcCall('polymarket:getEventMarketIds', eventId) as Promise<string[] | null>,
    } as PolymarketContext,

    risk: {
      getBudget: () => rpcCall('risk:getBudget') as Promise<RiskBudget>,
      getExitFlags: () => rpcCall('risk:getExitFlags') as Promise<BotExitFlag[]>,
      getExitPolicy: () => rpcCall('risk:getExitPolicy') as Promise<ExitPolicy>,
      getMandateSummary: () => rpcCall('risk:getMandateSummary') as Promise<MandateSummary | null>,
    } as RiskContext,

    // Copy Trading template only: the server refuses it for any other bot
    copy: {
      getLeaders: (addresses: string[]) => rpcCall('copy:getLeaders', addresses) as Promise<CopyLeaderStatus[]>,
    } as CopyContext,

    // Retire this bot (server-side, audited as the bot); the worker is stopped shortly after
    requestRetire: (reason: string) => rpcCall('bot:requestRetire', reason) as Promise<{ accepted: boolean }>,

    // Forecast ledger: read-only
    ledger: {
      getActiveForecasts: (filter?: { category?: string; tradeableOnly?: boolean }) =>
        rpcCall('ledger:getActiveForecasts', filter) as Promise<BotForecast[]>,
      getForecast: (tokenId: string) => rpcCall('ledger:getForecast', tokenId) as Promise<BotForecast | null>,
    } as LedgerContext,

    events: eventsContext,

    // Position manager only: the server refuses these RPCs for any other bot
    portfolio: {
      getAllPositions: () => rpcCall('portfolio:getAllPositions') as Promise<PortfolioPosition[]>,
      getExitFlags: () => rpcCall('portfolio:getExitFlags') as Promise<PortfolioExitFlag[]>,
      getCapitalDemand: () => rpcCall('portfolio:getCapitalDemand') as Promise<CapitalDemand>,
      ackExitFlag: (flagId: string, note: string) => rpcCall('portfolio:ackExitFlag', flagId, note) as Promise<boolean>,
      exit: (req: ExitRequest) => rpcCall('portfolio:exit', req) as Promise<OrderResult>,
      cancelExit: (orderId: string) => rpcCall('portfolio:cancelExit', orderId) as Promise<void>,
    } as PortfolioContext,

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
