/**
 * RpcHandler - runs in the main process.
 * Receives RPC requests from worker threads and dispatches to trading SDK,
 * storage repository, and logging.
 * In paper mode, buy/sell/getBalance/getPositions are intercepted by PaperTradingState.
 */

import type { ClobClient } from '@polymarket/clob-client';
import type { BotStorageRepository } from '../database/repositories/BotStorageRepository';
import type { BotTradeRepository } from '../database/repositories/BotTradeRepository';
import type { RpcRequest, RpcResponse, RpcMethod } from '../sdk/types';
import type { PaperTradingState } from './PaperTradingState';
import {
  executeBuy,
  executeSell,
  getOrderBook,
  getMarketPrice,
  getPositions,
  getBalance,
} from '../sdk/trading';
import {
  executeBinanceBuy,
  executeBinanceSell,
  getBinanceBalance,
  getBinanceOrderBook,
  getBinancePrice,
  getBinancePositions,
} from '../sdk/binance';
import type { BinanceCredentials } from '../sdk/binance';
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
}

export class RpcHandler {
  private deps: RpcHandlerDeps;
  private paperState: PaperTradingState | null;
  private tokenInfoCache: Map<string, { market: string; outcome: string }> = new Map();

  constructor(deps: RpcHandlerDeps, paperState?: PaperTradingState) {
    this.deps = deps;
    this.paperState = paperState || null;
  }

  /**
   * Resolve a Polymarket tokenId to its market title and outcome label.
   * Results are cached to avoid repeated API calls.
   */
  private async resolveTokenInfo(tokenId: string): Promise<{ market: string; outcome: string } | null> {
    const cached = this.tokenInfoCache.get(tokenId);
    if (cached) return cached;

    try {
      const resp = await fetch(
        `https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`
      );
      if (!resp.ok) return null;
      const markets = await resp.json();
      if (!Array.isArray(markets) || markets.length === 0) return null;

      const mkt = markets[0];
      // Find which outcome this token corresponds to
      let outcomeLabel = '';
      try {
        const tokenIds: string[] = typeof mkt.clobTokenIds === 'string'
          ? JSON.parse(mkt.clobTokenIds)
          : (mkt.clobTokenIds || []);
        const outcomes: string[] = typeof mkt.outcomes === 'string'
          ? JSON.parse(mkt.outcomes)
          : (mkt.outcomes || []);
        const tokenIndex = tokenIds.indexOf(tokenId);
        outcomeLabel = tokenIndex >= 0 && outcomes[tokenIndex] ? outcomes[tokenIndex] : outcomes[0] || '';
      } catch {
        outcomeLabel = '';
      }

      const info = { market: mkt.question || mkt.title || '', outcome: outcomeLabel };
      if (info.market) {
        this.tokenInfoCache.set(tokenId, info);
      }
      return info;
    } catch {
      return null;
    }
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

  /**
   * Auto-record a successful trade to the bot_trades table.
   * Wrapped in try/catch — recording failures must never break trade execution.
   * For Polymarket trades, resolves the tokenId to a human-readable market title.
   */
  private async recordTradeIfSuccessful(
    exchange: 'polymarket' | 'binance',
    side: 'BUY' | 'SELL',
    symbol: string,
    result: any
  ): Promise<void> {
    try {
      if (!result?.success) return;

      if (exchange === 'polymarket') {
        // Resolve tokenId to market title + outcome
        const info = await this.resolveTokenInfo(symbol);
        this.deps.tradeRepo.create({
          botId: this.deps.botId,
          botName: this.deps.botName,
          scriptName: this.deps.scriptName,
          exchange: 'polymarket',
          side,
          symbol,
          market: info?.market,
          outcome: info?.outcome,
          price: result.price,
          quantity: result.tokenAmount,
          quoteAmount: result.executedAmount,
          simulated: this.isPaper ? 1 : 0,
        });
      } else {
        this.deps.tradeRepo.create({
          botId: this.deps.botId,
          botName: this.deps.botName,
          scriptName: this.deps.scriptName,
          exchange: 'binance',
          side,
          symbol: result.symbol || symbol,
          price: result.avgPrice,
          quantity: result.executedQty,
          quoteAmount: result.cummulativeQuoteQty,
          simulated: this.isPaper ? 1 : 0,
        });
      }
    } catch (err) {
      logger.error(`Failed to auto-record trade: ${err instanceof Error ? err.message : err}`);
    }
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

      case 'polymarket:buy': {
        const tokenId = args[0] as string;
        let result;
        if (this.isPaper) {
          const book = await getOrderBook(this.deps.clobClient, tokenId);
          result = this.paperState!.simulateBuy(
            tokenId,
            args[1] as number,
            book,
            args[2] as any
          );
          // Enrich paper position with market metadata (fire-and-forget)
          if (result.success) {
            this.resolveTokenInfo(tokenId).then(info => {
              if (info) this.paperState!.updatePositionMeta(tokenId, info.market, info.outcome);
            }).catch(() => {});
          }
        } else {
          result = await executeBuy(
            this.deps.clobClient,
            tokenId,
            args[1] as number,
            args[2] as any
          );
        }
        this.recordTradeIfSuccessful('polymarket', 'BUY', tokenId, result);
        return result;
      }

      case 'polymarket:sell': {
        const tokenId = args[0] as string;
        let result;
        if (this.isPaper) {
          const book = await getOrderBook(this.deps.clobClient, tokenId);
          result = this.paperState!.simulateSell(
            tokenId,
            args[1] as number,
            book,
            args[2] as any
          );
        } else {
          result = await executeSell(
            this.deps.clobClient,
            tokenId,
            args[1] as number,
            args[2] as any
          );
        }
        this.recordTradeIfSuccessful('polymarket', 'SELL', tokenId, result);
        return result;
      }

      case 'polymarket:getOrderBook':
        return getOrderBook(
          this.deps.clobClient,
          args[0] as string
        );

      case 'polymarket:getPositions':
        if (this.isPaper) {
          return this.paperState!.getPositions();
        }
        return getPositions(this.deps.clobClient);

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

      case 'recordTrade':
        return this.deps.tradeRepo.create({
          botId: this.deps.botId,
          botName: this.deps.botName,
          scriptName: this.deps.scriptName,
          ...(args[0] as Record<string, unknown>),
          ...(this.isPaper ? { simulated: 1 } : {}),
        });

      // === Binance Spot Trading ===

      case 'binance:buy': {
        const symbol = args[0] as string;
        const quoteAmount = args[1] as number;
        let result;
        if (this.isPaper) {
          const book = await getBinanceOrderBook(symbol);
          result = this.paperState!.simulateBinanceBuy(symbol, quoteAmount, book);
        } else {
          result = await executeBinanceBuy(this.requireBinanceCreds(), symbol, quoteAmount);
        }
        this.recordTradeIfSuccessful('binance', 'BUY', symbol, result);
        return result;
      }

      case 'binance:sell': {
        const symbol = args[0] as string;
        const quantity = args[1] as number;
        let result;
        if (this.isPaper) {
          const book = await getBinanceOrderBook(symbol);
          result = this.paperState!.simulateBinanceSell(symbol, quantity, book);
        } else {
          result = await executeBinanceSell(this.requireBinanceCreds(), symbol, quantity);
        }
        this.recordTradeIfSuccessful('binance', 'SELL', symbol, result);
        return result;
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
