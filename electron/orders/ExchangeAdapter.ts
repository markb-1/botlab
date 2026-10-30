/**
 * Exchange adapters used by OrderService. The live implementations here are the only
 * code that may import the order-posting functions (choke-point test). Tests inject fakes.
 */

import type { ClobClient } from '@polymarket/clob-client';
import {
  cancelOrders,
  fetchOrder,
  postLimitOrder,
  postMarketOrder,
  type PostOrderOutcome,
} from '../exchange/polymarket/orders';
import {
  executeBinanceBuy,
  executeBinanceSell,
  type BinanceCredentials,
  type BinanceTradeResult,
} from '../sdk/binance';

export type { PostOrderOutcome };

export interface PolymarketAdapter {
  /** BUY: amount = USDC; SELL: amount = shares. Fill-or-kill at `price` or better. */
  postMarketOrder(args: { tokenId: string; side: 'buy' | 'sell'; amount: number; price: number }): Promise<PostOrderOutcome>;
  postLimitOrder(args: {
    tokenId: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    expiresAtMs: number;
  }): Promise<PostOrderOutcome>;
  /** Returns the exchange ids confirmed cancelled; throws if the request failed. */
  cancelOrders(exchangeOrderIds: string[]): Promise<string[]>;
  getOrder(exchangeOrderId: string): Promise<{ status: string; sizeMatched: number; originalSize: number; price: number } | null>;
}

export interface BinanceAdapter {
  marketBuy(symbol: string, quoteAmount: number, clientOrderId: string): Promise<BinanceTradeResult>;
  marketSell(symbol: string, quantity: number, clientOrderId: string): Promise<BinanceTradeResult>;
}

export function createPolymarketAdapter(clob: ClobClient): PolymarketAdapter {
  return {
    postMarketOrder: (args) => postMarketOrder(clob, args),
    postLimitOrder: (args) => postLimitOrder(clob, args),
    cancelOrders: (ids) => cancelOrders(clob, ids),
    getOrder: (id) => fetchOrder(clob, id),
  };
}

export function createBinanceAdapter(creds: BinanceCredentials): BinanceAdapter {
  return {
    marketBuy: (symbol, quoteAmount, clientOrderId) => executeBinanceBuy(creds, symbol, quoteAmount, clientOrderId),
    marketSell: (symbol, quantity, clientOrderId) => executeBinanceSell(creds, symbol, quantity, clientOrderId),
  };
}
