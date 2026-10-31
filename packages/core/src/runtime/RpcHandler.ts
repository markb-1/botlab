/**
 * RpcHandler - runs in the main process.
 * Receives RPC requests from worker threads and dispatches to trading SDK,
 * storage repository, and logging.
 * Every order (live and paper) goes through OrderService, which runs the RiskEngine;
 * in paper mode OrderService fills against PaperTradingState instead of an exchange.
 * In paper mode getBalance/getPositions read PaperTradingState.
 */

import type { ClobClient } from '@polymarket/clob-client';
import type { BotStorageRepository } from '../db/repositories/BotStorageRepository';
import type { BotTradeRepository } from '../db/repositories/BotTradeRepository';
import type { RpcRequest, RpcResponse, RpcMethod, OrderOpts, LimitOrderOpts, BinanceTradeResult, BotForecast, BotExitFlag, MarketDetail } from '../sdk/types';
import type { MarketView } from '../ledger/MarketCacheService';
import type { ForecastView } from '../ledger/LedgerService';
import type { PaperTradingState } from './PaperTradingState';
import {
  getOrderBook,
  getMarketPrice,
  getBalance,
} from '../exchange/polymarket/trading';
import {
  getBinanceBalance,
  getBinanceOrderBook,
  getBinancePrice,
  getBinancePositions,
} from '../exchange/binance/client';
import type { BinanceCredentials } from '../exchange/binance/client';
import { toTradeResult, type OrderResult, type OrderService } from '../orders/OrderService';
import { scriptFetch } from './scriptFetch';
import type { BuiltinRole } from '../db/repositories/ScriptRepository';
import type { PortfolioAccess } from '../orders/PortfolioService';

/** ctx.fetch requests a bot may have in flight; more are rejected at once (spec §5.1 hardening). */
export const MAX_CONCURRENT_FETCHES = 6;
import logger from '../utils/logger';

/** A forecast with its bucket's current rights (live). */
export type LiveForecast = ForecastView & { bucketState: string | null; tradeableNow: boolean; complementTokenId?: string | null; endDate?: string | null; bucketAllocationUsd?: number | null };

/** Read-only ledger access for bots (spec §5.2: bots may read ledger data, never write it). */
export interface LedgerReader {
  botForecasts(filter?: { category?: string; tradeableOnly?: boolean }): LiveForecast[];
  botForecast(tokenId: string): LiveForecast | null;
}

/** The forecast as a bot sees it: `tradeable` is computed now from the bucket's current state. */
export function toBotForecast(f: LiveForecast): BotForecast {
  return {
    id: f.id,
    marketId: f.marketId,
    tokenId: f.tokenId,
    eventId: f.eventId,
    category: f.category,
    probability: f.probability,
    marketPriceAtForecast: f.marketPriceAtForecast,
    bestBid: f.bestBid,
    bestAsk: f.bestAsk,
    ambiguityScore: f.ambiguityScore,
    tradeable: f.tradeableNow,
    tradeableAtForecast: f.tradeable,
    bucketState: f.bucketState,
    horizonBucket: f.horizonBucket,
    daysToResolutionAtForecast: f.daysToResolutionAtForecast,
    status: f.status,
    rationale: f.rationale,
    sources: f.sources,
    createdAt: f.createdAt,
    complementTokenId: f.complementTokenId ?? null,
    endDate: f.endDate ?? null,
    bucketAllocationUsd: f.bucketAllocationUsd ?? null,
  };
}

export interface RpcHandlerDeps {
  clobClient: ClobClient;
  storageRepo: BotStorageRepository;
  tradeRepo: BotTradeRepository;
  botId: string;
  botName: string;
  scriptName: string;
  walletAddress: string;
  proxyAddress?: string;
  rpcUrl: string;
  usdcContractAddress: string;
  clobHttpUrl: string;
  binanceApiKey?: string;
  binanceApiSecret?: string;
  /**
   * The only route to an exchange order (live) or a paper fill: every buy/sell/limit
   * order goes through OrderService and the RiskEngine. Missing ⇒ order methods fail.
   */
  orderService?: OrderService;
  /** Hosts ctx.fetch may reach (limits.yaml server.script_fetch_allowlist); default list if unset. A function is read on every call (hot reload). */
  fetchAllowlist?: readonly string[] | (() => readonly string[] | undefined);
  /** Test hook: replaces the global fetch used by ctx.fetch */
  fetchImpl?: typeof fetch;
  /** Forecast ledger (ctx.ledger); missing ⇒ ledger calls fail */
  ledger?: LedgerReader;
  /** Standing role of the bot's script (builtin templates only; BotManager reads it from the script row) */
  role?: BuiltinRole | null;
  /** ctx.portfolio bound to this bot: given only to the builtin position manager; missing ⇒ portfolio calls fail */
  portfolio?: PortfolioAccess;
  /** Market cache lookup by condition id or token id (ctx.polymarket.getMarket); missing ⇒ getMarket fails */
  getMarket?: (idOrTokenId: string) => Promise<MarketView | null>;
  /** The bot's market_ids now (null = not market-scoped), for MarketDetail.inScope */
  marketScope?: () => string[] | null;
  /** Open exit flags on this bot's positions in its mode (ctx.risk.getExitFlags) */
  exitFlags?: () => BotExitFlag[];
  /** Retire this bot (ctx.requestRetire): BotManager runs it after the reply, outside the RPC */
  requestRetire?: (reason: string) => void;
}

/** A market cache row as a bot sees it (ctx.polymarket.getMarket). */
export function toMarketDetail(m: MarketView, askedFor: string, scope: string[] | null): MarketDetail {
  const tokens = m.tokens.map((t) => ({ tokenId: t.tokenId, outcome: t.outcome }));
  const asked = tokens.find((t) => t.tokenId === askedFor) ?? null;
  const other = asked && tokens.length === 2 ? (tokens.find((t) => t.tokenId !== asked.tokenId) ?? null) : null;
  return {
    marketId: m.marketId,
    eventId: m.eventId,
    question: m.question,
    category: m.category,
    endDate: m.endDate,
    active: m.active,
    closed: m.closed,
    negRisk: m.negRisk,
    tokens,
    tokenId: asked?.tokenId ?? null,
    outcome: asked?.outcome ?? null,
    complementTokenId: other?.tokenId ?? null,
    ambiguityScore: m.ambiguityScore,
    rulesHash: m.rulesHash,
    rulesChangedAt: m.rulesChangedAt,
    disputed: m.disputed,
    umaResolutionStatus: m.umaResolutionStatus,
    inScope: scope === null || scope.includes(m.marketId),
    updatedAt: m.updatedAt,
  };
}

/** Legacy ctx.binance.buy/sell result from an OrderService result. */
function toBinanceTradeResult(symbol: string, side: 'BUY' | 'SELL', r: OrderResult): BinanceTradeResult {
  return {
    success: r.filledSize > 0,
    symbol: symbol.toUpperCase(),
    side,
    executedQty: r.filledSize,
    cummulativeQuoteQty: r.filledNotionalUsd,
    avgPrice: r.avgFillPrice ?? 0,
    clientOrderId: r.orderId,
    status: r.status,
    ...(r.error ? { error: r.error } : {}),
    ...(r.failedCheck ? { failedCheck: r.failedCheck } : {}),
  };
}

function orderOpts(v: unknown): OrderOpts {
  return v && typeof v === 'object' ? (v as OrderOpts) : {};
}

export class RpcHandler {
  private deps: RpcHandlerDeps;
  private paperState: PaperTradingState | null;
  private fetchesInFlight = 0;
  constructor(deps: RpcHandlerDeps, paperState?: PaperTradingState) {
    this.deps = deps;
    this.paperState = paperState || null;
  }

  private get isPaper(): boolean {
    return this.paperState !== null;
  }

  private get binanceCreds(): BinanceCredentials | null {
    if (this.deps.binanceApiKey && this.deps.binanceApiSecret) {
      return { apiKey: this.deps.binanceApiKey, apiSecret: this.deps.binanceApiSecret };
    }
    return null;
  }

  private requireBinanceCreds(): BinanceCredentials {
    const creds = this.binanceCreds;
    if (!creds) throw new Error('Binance API credentials not configured. Set them in Settings.');
    return creds;
  }

  private get ledger(): LedgerReader {
    if (!this.deps.ledger) throw new Error('Forecast ledger unavailable');
    return this.deps.ledger;
  }

  private get portfolio(): PortfolioAccess {
    if (!this.deps.portfolio) throw new Error('ctx.portfolio is only available to bots running the builtin Position Manager template');
    return this.deps.portfolio;
  }

  /** The position manager only reduces positions: every buy path is refused for it (server-side, 5a). */
  private refuseBuy(what: string): void {
    if (this.deps.role === 'position-manager') throw new Error(`${what}: the position manager cannot buy`);
  }

  private get orders(): OrderService {
    if (!this.deps.orderService) throw new Error('Order service unavailable: orders are disabled');
    return this.deps.orderService;
  }

  async handle(request: RpcRequest): Promise<RpcResponse> {
    try {
      const result = await this.dispatch(request.method, request.args);
      return { id: request.id, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { id: request.id, error: message };
    }
  }

  private async dispatch(method: RpcMethod, args: unknown[]): Promise<unknown> {
    switch (method) {
      // === Polymarket Trading ===

      // All order methods go through OrderService (risk checks; paper fills in paper mode)
      case 'polymarket:buy': {
        this.refuseBuy('buy');
        const opts = orderOpts(args[2]);
        const result = await this.orders.placeMarketable({
          tokenId: args[0] as string,
          side: 'buy',
          amount: args[1] as number,
          maxPrice: opts.maxPrice,
          maxSlippage: opts.maxSlippage,
          reason: opts.reason,
          forecastId: opts.forecastId,
        });
        return toTradeResult(result);
      }

      // A script can never flag its own order as a risk exit (exemptions from hold time, rate, size and stage):
      // only the position manager's PortfolioService sets riskExit (R169)
      case 'polymarket:sell': {
        const opts = orderOpts(args[2]);
        const result = await this.orders.placeMarketable({
          tokenId: args[0] as string,
          side: 'sell',
          amount: args[1] as number,
          minPrice: opts.minPrice,
          maxSlippage: opts.maxSlippage,
          reason: opts.reason,
          forecastId: opts.forecastId,
        });
        return toTradeResult(result);
      }

      case 'polymarket:placeLimit': {
        const opts = (args[4] && typeof args[4] === 'object' ? args[4] : {}) as LimitOrderOpts;
        if (args[1] !== 'sell') this.refuseBuy('placeLimit');
        return this.orders.placeLimit({
          tokenId: args[0] as string,
          side: args[1] as 'buy' | 'sell',
          price: args[2] as number,
          size: args[3] as number,
          postOnly: opts.postOnly,
          ttlMinutes: opts.ttlMinutes,
          reason: opts.reason,
          forecastId: opts.forecastId,
        });
      }

      case 'polymarket:cancel':
        await this.orders.cancel(args[0] as string);
        return;

      case 'polymarket:cancelAll': {
        // Orders with an unknown outcome (no exchange id) are reported, not treated as failures
        const result = await this.orders.cancelAll();
        if (result.failed > 0) throw new Error(`${result.failed} order(s) could not be cancelled`);
        return result;
      }

      case 'polymarket:getOpenOrders':
        return this.orders.getOpenOrders();

      case 'polymarket:getOrderHistory':
        return this.orders.getOrderHistory(typeof args[0] === 'number' ? args[0] : undefined);

      case 'polymarket:getFee':
        return this.orders.getFee(args[0] as string);

      case 'risk:getBudget':
        return this.orders.getBudget();

      case 'risk:getExitFlags':
        return this.deps.exitFlags ? this.deps.exitFlags() : [];

      case 'polymarket:getMarket': {
        const id = args[0];
        if (typeof id !== 'string' || !id.trim() || id.length > 100) throw new Error('getMarket: a condition id or token id is required');
        if (!this.deps.getMarket) throw new Error('getMarket: market data unavailable');
        const m = await this.deps.getMarket(id.trim());
        return m ? toMarketDetail(m, id.trim(), this.deps.marketScope ? this.deps.marketScope() : null) : null;
      }

      case 'bot:requestRetire': {
        const reason = typeof args[0] === 'string' ? args[0].trim().slice(0, 500) : '';
        if (!reason) throw new Error('requestRetire: a reason is required');
        if (!this.deps.requestRetire) return { accepted: false };
        this.deps.requestRetire(reason);
        return { accepted: true };
      }

      case 'ledger:getActiveForecasts': {
        const filter = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as { category?: unknown; tradeableOnly?: unknown };
        return this.ledger
          .botForecasts({
            ...(typeof filter.category === 'string' && filter.category ? { category: filter.category } : {}),
            tradeableOnly: filter.tradeableOnly === true,
          })
          .map(toBotForecast);
      }

      case 'ledger:getForecast': {
        const tokenId = args[0];
        if (typeof tokenId !== 'string' || !tokenId) throw new Error('tokenId required');
        const f = this.ledger.botForecast(tokenId);
        return f ? toBotForecast(f) : null;
      }

      // === Portfolio (builtin position manager only; scoped by the server, not by the script) ===

      case 'portfolio:getAllPositions':
        return this.portfolio.getAllPositions();

      case 'portfolio:getExitFlags':
        return this.portfolio.getExitFlags();

      case 'portfolio:getCapitalDemand':
        return this.portfolio.getCapitalDemand();

      case 'portfolio:ackExitFlag':
        return this.portfolio.ackExitFlag(args[0], args[1]);

      case 'portfolio:exit':
        return this.portfolio.exit(args[0]);

      case 'portfolio:cancelExit':
        await this.portfolio.cancelExit(args[0]);
        return;

      case 'polymarket:getOrderBook':
        return getOrderBook(
          this.deps.clobClient,
          args[0] as string
        );

      case 'polymarket:getPositions': {
        if (this.isPaper) {
          // Paper state does not know markets: take the condition id from the bot's order-linked paper fills
          const markets = new Map(
            this.deps.tradeRepo
              .getRiskPositions({ simulated: true, botId: this.deps.botId, exchange: 'polymarket' })
              .map((p) => [p.symbol, p.condition_id] as const)
          );
          return this.paperState!.getPositions().map((p) => (p.conditionId || !markets.get(p.tokenId) ? p : { ...p, conditionId: markets.get(p.tokenId) ?? undefined }));
        }
        // Live: this bot's order-linked holdings, i.e. exactly what the risk engine lets it sell (R8).
        // Valued at cost (no mark); currentValue = cost basis.
        return this.deps.tradeRepo
          .getRiskPositions({ simulated: false, botId: this.deps.botId, exchange: 'polymarket' })
          .map((p) => ({
            tokenId: p.symbol,
            conditionId: p.condition_id ?? undefined,
            size: p.net_quantity,
            currentValue: p.cost_basis,
            avgPrice: p.net_quantity > 0 ? p.cost_basis / p.net_quantity : 0,
          }));
      }

      case 'polymarket:getBalance': {
        if (this.isPaper) {
          return this.paperState!.getBalance();
        }
        const address = this.deps.proxyAddress || this.deps.walletAddress;
        return getBalance(
          address,
          this.deps.rpcUrl,
          this.deps.usdcContractAddress
        );
      }

      case 'polymarket:getMarkets': {
        const query = args[0] as { search?: string; limit?: number } | undefined;
        try {
          const resp = await this.deps.clobClient.getMarkets(
            undefined
          );
          return resp || [];
        } catch {
          return [];
        }
      }

      case 'polymarket:getMarketPrice':
        return getMarketPrice(
          this.deps.clobClient,
          args[0] as string
        );

      case 'polymarket:getEvent':
        try {
          const slug = args[0] as string;
          const resp = await fetch(`${this.deps.clobHttpUrl}/events/${slug}`);
          if (!resp.ok) throw new Error(`Event not found: ${slug}`);
          return resp.json();
        } catch (err) {
          throw new Error(`Failed to fetch event: ${err instanceof Error ? err.message : err}`);
        }

      // === HTTP (allowlisted, executed here so the worker has no network access of its own) ===

      case 'fetch': {
        if (this.fetchesInFlight >= MAX_CONCURRENT_FETCHES) {
          throw new Error(`fetch: too many concurrent requests (max ${MAX_CONCURRENT_FETCHES} in flight per bot)`);
        }
        this.fetchesInFlight++;
        try {
          return await scriptFetch(args[0], args[1], { allowlist: typeof this.deps.fetchAllowlist === 'function' ? this.deps.fetchAllowlist() : this.deps.fetchAllowlist, fetchImpl: this.deps.fetchImpl });
        } finally {
          this.fetchesInFlight--;
        }
      }

      // === Storage ===

      case 'storage:get':
        return this.deps.storageRepo.get(this.deps.botId, args[0] as string);

      case 'storage:set':
        this.deps.storageRepo.set(this.deps.botId, args[0] as string, args[1]);
        return;

      case 'storage:delete':
        return this.deps.storageRepo.delete(this.deps.botId, args[0] as string);

      // === Logging ===

      case 'log': {
        const level = args[0] as string;
        const logArgs = args.slice(1);
        const modeTag = this.isPaper ? '[PAPER]' : '';
        const prefix = `[Script:${this.deps.botName}]${modeTag}`;
        const msg = logArgs.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
        switch (level) {
          case 'error': logger.error(`${prefix} ${msg}`); break;
          case 'warn': logger.warning(`${prefix} ${msg}`); break;
          case 'debug': logger.info(`${prefix} [DEBUG] ${msg}`); break;
          default: logger.info(`${prefix} ${msg}`);
        }
        // Return structured log for forwarding to UI
        return { __log: true, botId: this.deps.botId, level, message: msg };
      }

      case 'emit':
        return { type: args[0], data: args[1] };

      case 'recordTrade': {
        // Script-written trades are informational: strip fields that would make them count as
        // OrderService fills (positions and exposure come only from rows with an order_id)
        const { orderId: _o, order_id: _oid, feeUsd: _f, ...data } = (args[0] ?? {}) as Record<string, unknown>;
        return this.deps.tradeRepo.create({
          ...data,
          botId: this.deps.botId,
          botName: this.deps.botName,
          scriptName: this.deps.scriptName,
          ...(this.isPaper ? { simulated: 1 } : {}),
        });
      }

      // === Binance Spot Trading ===

      case 'binance:buy': {
        this.refuseBuy('binance.buy');
        const symbol = args[0] as string;
        const result = await this.orders.placeBinance({ symbol, side: 'buy', amount: args[1] as number });
        return toBinanceTradeResult(symbol, 'BUY', result);
      }

      case 'binance:sell': {
        const symbol = args[0] as string;
        const result = await this.orders.placeBinance({ symbol, side: 'sell', amount: args[1] as number });
        return toBinanceTradeResult(symbol, 'SELL', result);
      }

      case 'binance:getBalance': {
        const asset = (args[0] as string) || 'USDT';
        if (this.isPaper) {
          return this.paperState!.getBinanceBalance(asset);
        }
        return getBinanceBalance(this.requireBinanceCreds(), asset);
      }

      case 'binance:getOrderBook':
        return getBinanceOrderBook(args[0] as string, args[1] as number | undefined);

      case 'binance:getPrice':
        return getBinancePrice(args[0] as string);

      case 'binance:getPositions': {
        if (this.isPaper) {
          return this.paperState!.getBinancePositions();
        }
        return getBinancePositions(this.requireBinanceCreds());
      }

      default:
        throw new Error(`Unknown RPC method: ${method}`);
    }
  }
}
