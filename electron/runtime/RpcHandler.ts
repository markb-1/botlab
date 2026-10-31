/**
 * RpcHandler - runs in the main process.
 * Receives RPC requests from worker threads and dispatches to trading SDK,
 * storage repository, and logging.
 * Every order (live and paper) goes through OrderService, which runs the RiskEngine;
 * in paper mode OrderService fills against PaperTradingState instead of an exchange.
 * In paper mode getBalance/getPositions read PaperTradingState.
 */

import type { ClobClient } from '@polymarket/clob-client';
import type { BotStorageRepository } from '../database/repositories/BotStorageRepository';
import type { BotTradeRepository } from '../database/repositories/BotTradeRepository';
import type { RpcRequest, RpcResponse, RpcMethod, OrderOpts, LimitOrderOpts, BinanceTradeResult } from '../sdk/types';
import type { PaperTradingState } from './PaperTradingState';
import {
  getOrderBook,
  getMarketPrice,
  getBalance,
} from '../sdk/trading';
import {
  getBinanceBalance,
  getBinanceOrderBook,
  getBinancePrice,
  getBinancePositions,
} from '../sdk/binance';
import type { BinanceCredentials } from '../sdk/binance';
import { toTradeResult, type OrderResult, type OrderService } from '../orders/OrderService';
import { scriptFetch } from './scriptFetch';

/** ctx.fetch requests a bot may have in flight; more are rejected at once (spec §5.1 hardening). */
export const MAX_CONCURRENT_FETCHES = 6;
import logger from '../../src/utils/logger';

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
  /** Hosts ctx.fetch may reach (limits.yaml server.script_fetch_allowlist); default list if unset */
  fetchAllowlist?: readonly string[];
  /** Test hook: replaces the global fetch used by ctx.fetch */
  fetchImpl?: typeof fetch;
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
          riskExit: opts.riskExit,
        });
        return toTradeResult(result);
      }

      case 'polymarket:placeLimit': {
        const opts = (args[4] && typeof args[4] === 'object' ? args[4] : {}) as LimitOrderOpts;
        return this.orders.placeLimit({
          tokenId: args[0] as string,
          side: args[1] as 'buy' | 'sell',
          price: args[2] as number,
          size: args[3] as number,
          postOnly: opts.postOnly,
          ttlMinutes: opts.ttlMinutes,
          reason: opts.reason,
          forecastId: opts.forecastId,
          riskExit: opts.riskExit,
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

      case 'polymarket:getFee':
        return this.orders.getFee(args[0] as string);

      case 'risk:getBudget':
        return this.orders.getBudget();

      case 'polymarket:getOrderBook':
        return getOrderBook(
          this.deps.clobClient,
          args[0] as string
        );

      case 'polymarket:getPositions': {
        if (this.isPaper) {
          return this.paperState!.getPositions();
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
          return await scriptFetch(args[0], args[1], { allowlist: this.deps.fetchAllowlist, fetchImpl: this.deps.fetchImpl });
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
