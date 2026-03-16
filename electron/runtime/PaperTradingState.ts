/**
 * PaperTradingState - In-memory simulation of trading for paper mode.
 * Uses real orderbook data for realistic pricing but never places actual trades.
 * State persists to bot_storage so it survives bot restarts.
 */

import type { BotStorageRepository } from '../database/repositories/BotStorageRepository';
import type { TradeResult, OrderBook, Position, OrderOpts, BinanceTradeResult, BinanceOrderBook, BinancePosition } from '../sdk/types';

const STORAGE_KEY = '__paper_state';

interface PaperPosition {
  tokenId: string;
  size: number;
  avgPrice: number;
  market?: string;
  outcome?: string;
}

interface PaperStateSnapshot {
  balance: number;
  positions: PaperPosition[];
  binanceBalances?: Record<string, number>;
}

export class PaperTradingState {
  private botId: string;
  private balance: number;
  private positions: Map<string, PaperPosition> = new Map();
  private binanceBalances: Record<string, number> = {};
  private storageRepo: BotStorageRepository;
  private initialBalance: number;

  constructor(botId: string, initialBalance: number, storageRepo: BotStorageRepository) {
    this.botId = botId;
    this.balance = initialBalance;
    this.initialBalance = initialBalance;
    this.storageRepo = storageRepo;
    // Initialize Binance paper USDT balance to match initial balance
    this.binanceBalances = { USDT: initialBalance };
  }

  /**
   * Load persisted state from bot_storage. Falls back to initial balance if none found.
   */
  load(): void {
    const saved = this.storageRepo.get(this.botId, STORAGE_KEY) as PaperStateSnapshot | null;
    if (saved && typeof saved.balance === 'number') {
      this.balance = saved.balance;
      this.positions.clear();
      if (Array.isArray(saved.positions)) {
        for (const pos of saved.positions) {
          this.positions.set(pos.tokenId, pos);
        }
      }
      if (saved.binanceBalances && typeof saved.binanceBalances === 'object') {
        this.binanceBalances = { ...saved.binanceBalances };
      }
    }
  }

  /**
   * Persist current state to bot_storage.
   */
  private save(): void {
    const snapshot: PaperStateSnapshot = {
      balance: this.balance,
      positions: Array.from(this.positions.values()),
      binanceBalances: { ...this.binanceBalances },
    };
    this.storageRepo.set(this.botId, STORAGE_KEY, snapshot);
  }

  /**
   * Simulate a buy order using the real orderbook for pricing.
   */
  simulateBuy(
    tokenId: string,
    amountUsd: number,
    orderBook: OrderBook,
    opts?: OrderOpts
  ): TradeResult {
    if (amountUsd <= 0) {
      return { success: false, executedAmount: 0, price: 0, tokenAmount: 0, error: 'Invalid amount' };
    }

    if (amountUsd > this.balance) {
      return { success: false, executedAmount: 0, price: 0, tokenAmount: 0, error: 'Insufficient paper balance' };
    }

    if (!orderBook.asks || orderBook.asks.length === 0) {
      return { success: false, executedAmount: 0, price: 0, tokenAmount: 0, error: 'No asks available in order book' };
    }

    // Find best ask
    const bestAsk = orderBook.asks.reduce((min, ask) =>
      parseFloat(ask.price) < parseFloat(min.price) ? ask : min
    , orderBook.asks[0]);
    const askPrice = parseFloat(bestAsk.price);

    // Slippage / maxPrice checks
    if (opts?.maxPrice && askPrice > opts.maxPrice) {
      return {
        success: false, executedAmount: 0, price: 0, tokenAmount: 0,
        error: `Ask price ${askPrice} exceeds max price ${opts.maxPrice}`,
      };
    }

    if (opts?.maxSlippage && opts.maxPrice && askPrice > opts.maxPrice + opts.maxSlippage) {
      return {
        success: false, executedAmount: 0, price: 0, tokenAmount: 0,
        error: `Price slippage too high: ${askPrice} vs max ${opts.maxPrice + opts.maxSlippage}`,
      };
    }

    // Simulate fill against available liquidity
    const availableLiquidity = parseFloat(bestAsk.size) * askPrice;
    const fillAmount = Math.min(amountUsd, availableLiquidity);
    const tokensBought = fillAmount / askPrice;

    // Update state
    this.balance -= fillAmount;
    const existing = this.positions.get(tokenId);
    if (existing) {
      const totalCost = existing.avgPrice * existing.size + fillAmount;
      existing.size += tokensBought;
      existing.avgPrice = totalCost / existing.size;
    } else {
      this.positions.set(tokenId, {
        tokenId,
        size: tokensBought,
        avgPrice: askPrice,
      });
    }

    this.save();

    return {
      success: true,
      executedAmount: fillAmount,
      price: askPrice,
      tokenAmount: tokensBought,
    };
  }

  /**
   * Simulate a sell order using the real orderbook for pricing.
   */
  simulateSell(
    tokenId: string,
    amountTokens: number,
    orderBook: OrderBook,
    opts?: OrderOpts
  ): TradeResult {
    if (amountTokens <= 0) {
      return { success: false, executedAmount: 0, price: 0, tokenAmount: 0, error: 'Invalid amount' };
    }

    const position = this.positions.get(tokenId);
    if (!position || position.size < amountTokens) {
      return {
        success: false, executedAmount: 0, price: 0, tokenAmount: 0,
        error: `Insufficient paper position: have ${position?.size ?? 0}, need ${amountTokens}`,
      };
    }

    if (!orderBook.bids || orderBook.bids.length === 0) {
      return { success: false, executedAmount: 0, price: 0, tokenAmount: 0, error: 'No bids available in order book' };
    }

    // Find best bid
    const bestBid = orderBook.bids.reduce((max, bid) =>
      parseFloat(bid.price) > parseFloat(max.price) ? bid : max
    , orderBook.bids[0]);
    const bidPrice = parseFloat(bestBid.price);

    // Simulate fill
    const availableTokens = parseFloat(bestBid.size);
    const fillTokens = Math.min(amountTokens, availableTokens);
    const receivedUsd = fillTokens * bidPrice;

    // Update state
    this.balance += receivedUsd;
    position.size -= fillTokens;
    if (position.size <= 0.0001) {
      this.positions.delete(tokenId);
    }

    this.save();

    return {
      success: true,
      executedAmount: receivedUsd,
      price: bidPrice,
      tokenAmount: fillTokens,
    };
  }

  /**
   * Update a position's market metadata (title + outcome label).
   * Called after resolving a tokenId to its market info.
   */
  updatePositionMeta(tokenId: string, market: string, outcome: string): void {
    const pos = this.positions.get(tokenId);
    if (pos) {
      pos.market = market;
      pos.outcome = outcome;
      this.save();
    }
  }

  getBalance(): number {
    return this.balance;
  }

  getPositions(): Position[] {
    return Array.from(this.positions.values()).map((p) => ({
      tokenId: p.tokenId,
      market: p.market,
      outcome: p.outcome,
      size: p.size,
      currentValue: p.size * p.avgPrice,
      avgPrice: p.avgPrice,
    }));
  }

  getInitialBalance(): number {
    return this.initialBalance;
  }

  // ======================================================================
  // Binance Paper Trading
  // ======================================================================

  /**
   * Extract the base asset from a USDT-quoted symbol (e.g., BTCUSDT -> BTC).
   */
  private parseBaseAsset(symbol: string): string {
    const upper = symbol.toUpperCase();
    if (!upper.endsWith('USDT')) {
      throw new Error(`Only USDT-quoted pairs supported for paper trading: ${symbol}`);
    }
    return upper.slice(0, -4);
  }

  /**
   * Simulate a Binance market buy (spend USDT, receive base asset).
   */
  simulateBinanceBuy(
    symbol: string,
    quoteAmount: number,
    orderBook: BinanceOrderBook
  ): BinanceTradeResult {
    const upper = symbol.toUpperCase();
    const baseAsset = this.parseBaseAsset(upper);

    if (quoteAmount <= 0) {
      return { success: false, symbol: upper, side: 'BUY', executedQty: 0, cummulativeQuoteQty: 0, avgPrice: 0, error: 'Invalid amount' };
    }

    const usdtBalance = this.binanceBalances['USDT'] || 0;
    if (quoteAmount > usdtBalance) {
      return { success: false, symbol: upper, side: 'BUY', executedQty: 0, cummulativeQuoteQty: 0, avgPrice: 0, error: `Insufficient USDT: have ${usdtBalance}, need ${quoteAmount}` };
    }

    if (!orderBook.asks || orderBook.asks.length === 0) {
      return { success: false, symbol: upper, side: 'BUY', executedQty: 0, cummulativeQuoteQty: 0, avgPrice: 0, error: 'No asks in order book' };
    }

    // Best ask (lowest price)
    const bestAsk = orderBook.asks.reduce((min, a) =>
      parseFloat(a.price) < parseFloat(min.price) ? a : min
    , orderBook.asks[0]);
    const askPrice = parseFloat(bestAsk.price);
    const askQty = parseFloat(bestAsk.quantity);
    const availableLiquidity = askQty * askPrice;
    const fillQuote = Math.min(quoteAmount, availableLiquidity);
    const fillBase = fillQuote / askPrice;

    // Update balances
    this.binanceBalances['USDT'] = usdtBalance - fillQuote;
    this.binanceBalances[baseAsset] = (this.binanceBalances[baseAsset] || 0) + fillBase;

    this.save();

    return {
      success: true,
      symbol: upper,
      side: 'BUY',
      executedQty: fillBase,
      cummulativeQuoteQty: fillQuote,
      avgPrice: askPrice,
    };
  }

  /**
   * Simulate a Binance market sell (sell base asset, receive USDT).
   */
  simulateBinanceSell(
    symbol: string,
    quantity: number,
    orderBook: BinanceOrderBook
  ): BinanceTradeResult {
    const upper = symbol.toUpperCase();
    const baseAsset = this.parseBaseAsset(upper);

    if (quantity <= 0) {
      return { success: false, symbol: upper, side: 'SELL', executedQty: 0, cummulativeQuoteQty: 0, avgPrice: 0, error: 'Invalid quantity' };
    }

    const assetBalance = this.binanceBalances[baseAsset] || 0;
    if (quantity > assetBalance) {
      return { success: false, symbol: upper, side: 'SELL', executedQty: 0, cummulativeQuoteQty: 0, avgPrice: 0, error: `Insufficient ${baseAsset}: have ${assetBalance}, need ${quantity}` };
    }

    if (!orderBook.bids || orderBook.bids.length === 0) {
      return { success: false, symbol: upper, side: 'SELL', executedQty: 0, cummulativeQuoteQty: 0, avgPrice: 0, error: 'No bids in order book' };
    }

    // Best bid (highest price)
    const bestBid = orderBook.bids.reduce((max, b) =>
      parseFloat(b.price) > parseFloat(max.price) ? b : max
    , orderBook.bids[0]);
    const bidPrice = parseFloat(bestBid.price);
    const bidQty = parseFloat(bestBid.quantity);
    const fillBase = Math.min(quantity, bidQty);
    const fillQuote = fillBase * bidPrice;

    // Update balances
    this.binanceBalances[baseAsset] = assetBalance - fillBase;
    if (this.binanceBalances[baseAsset] < 0.00000001) {
      delete this.binanceBalances[baseAsset];
    }
    this.binanceBalances['USDT'] = (this.binanceBalances['USDT'] || 0) + fillQuote;

    this.save();

    return {
      success: true,
      symbol: upper,
      side: 'SELL',
      executedQty: fillBase,
      cummulativeQuoteQty: fillQuote,
      avgPrice: bidPrice,
    };
  }

  /**
   * Get paper Binance balance for a specific asset.
   */
  getBinanceBalance(asset: string = 'USDT'): number {
    return this.binanceBalances[asset.toUpperCase()] || 0;
  }

  /**
   * Get all non-zero Binance paper positions.
   */
  getBinancePositions(): BinancePosition[] {
    return Object.entries(this.binanceBalances)
      .filter(([, amount]) => amount > 0.00000001)
      .map(([asset, amount]) => ({
        asset,
        free: amount,
        locked: 0,
        total: amount,
      }));
  }
}
