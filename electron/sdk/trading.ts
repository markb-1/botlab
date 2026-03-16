/**
 * Trading SDK - runs in the main process.
 * Provides the actual implementations that RpcHandler delegates to.
 * Wraps @polymarket/clob-client with a simpler, script-friendly API.
 */

import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import type {
  TradeResult,
  OrderBook,
  Position,
  MarketPrice,
  OrderOpts,
} from './types';

const DEFAULT_RETRIES = 3;
const MIN_ORDER_USD = 1.0;

/**
 * Execute a buy order via CLOB client
 */
export async function executeBuy(
  clobClient: ClobClient,
  tokenId: string,
  amountUsd: number,
  opts?: OrderOpts
): Promise<TradeResult> {
  const maxRetries = opts?.retries ?? DEFAULT_RETRIES;
  let remaining = amountUsd;
  let totalTokens = 0;
  let totalSpent = 0;
  let retry = 0;

  while (remaining > MIN_ORDER_USD && retry < maxRetries) {
    const orderBook = await clobClient.getOrderBook(tokenId);
    if (!orderBook.asks || orderBook.asks.length === 0) {
      return {
        success: totalSpent > 0,
        executedAmount: totalSpent,
        price: totalSpent > 0 ? totalSpent / totalTokens : 0,
        tokenAmount: totalTokens,
        error: totalSpent === 0 ? 'No asks available in order book' : undefined,
      };
    }

    const bestAsk = orderBook.asks.reduce((min, ask) =>
      parseFloat(ask.price) < parseFloat(min.price) ? ask : min
    , orderBook.asks[0]);

    const askPrice = parseFloat(bestAsk.price);

    // Slippage check
    if (opts?.maxSlippage && opts.maxPrice) {
      if (askPrice > opts.maxPrice + opts.maxSlippage) {
        return {
          success: totalSpent > 0,
          executedAmount: totalSpent,
          price: totalSpent > 0 ? totalSpent / totalTokens : 0,
          tokenAmount: totalTokens,
          error: `Price slippage too high: ${askPrice} vs max ${opts.maxPrice + opts.maxSlippage}`,
        };
      }
    }

    if (opts?.maxPrice && askPrice > opts.maxPrice) {
      return {
        success: totalSpent > 0,
        executedAmount: totalSpent,
        price: totalSpent > 0 ? totalSpent / totalTokens : 0,
        tokenAmount: totalTokens,
        error: `Ask price ${askPrice} exceeds max price ${opts.maxPrice}`,
      };
    }

    const maxOrderSize = parseFloat(bestAsk.size) * askPrice;
    const orderSize = Math.min(remaining, maxOrderSize);

    const signedOrder = await clobClient.createMarketOrder({
      side: Side.BUY,
      tokenID: tokenId,
      amount: orderSize,
      price: askPrice,
    });

    const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
    if (resp.success) {
      retry = 0;
      const tokensBought = orderSize / askPrice;
      totalTokens += tokensBought;
      totalSpent += orderSize;
      remaining -= orderSize;
    } else {
      const errorMsg = extractError(resp);
      if (isInsufficientFunds(errorMsg)) {
        return {
          success: totalSpent > 0,
          executedAmount: totalSpent,
          price: totalSpent > 0 ? totalSpent / totalTokens : 0,
          tokenAmount: totalTokens,
          error: errorMsg || 'Insufficient balance',
        };
      }
      retry++;
    }
  }

  return {
    success: totalSpent > 0,
    executedAmount: totalSpent,
    price: totalSpent > 0 ? totalSpent / totalTokens : 0,
    tokenAmount: totalTokens,
  };
}

/**
 * Execute a sell order via CLOB client
 */
export async function executeSell(
  clobClient: ClobClient,
  tokenId: string,
  amountTokens: number,
  opts?: OrderOpts
): Promise<TradeResult> {
  const maxRetries = opts?.retries ?? DEFAULT_RETRIES;
  let remaining = amountTokens;
  let totalTokensSold = 0;
  let totalReceived = 0;
  let retry = 0;

  while (remaining > 0 && retry < maxRetries) {
    const orderBook = await clobClient.getOrderBook(tokenId);
    if (!orderBook.bids || orderBook.bids.length === 0) {
      return {
        success: totalTokensSold > 0,
        executedAmount: totalReceived,
        price: totalTokensSold > 0 ? totalReceived / totalTokensSold : 0,
        tokenAmount: totalTokensSold,
        error: totalTokensSold === 0 ? 'No bids available in order book' : undefined,
      };
    }

    const bestBid = orderBook.bids.reduce((max, bid) =>
      parseFloat(bid.price) > parseFloat(max.price) ? bid : max
    , orderBook.bids[0]);

    const bidPrice = parseFloat(bestBid.price);
    const sellAmount = Math.min(remaining, parseFloat(bestBid.size));

    if (sellAmount < 1.0) {
      break; // Below minimum token amount
    }

    const signedOrder = await clobClient.createMarketOrder({
      side: Side.SELL,
      tokenID: tokenId,
      amount: sellAmount,
      price: bidPrice,
    });

    const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
    if (resp.success) {
      retry = 0;
      totalTokensSold += sellAmount;
      totalReceived += sellAmount * bidPrice;
      remaining -= sellAmount;
    } else {
      const errorMsg = extractError(resp);
      if (isInsufficientFunds(errorMsg)) {
        return {
          success: totalTokensSold > 0,
          executedAmount: totalReceived,
          price: totalTokensSold > 0 ? totalReceived / totalTokensSold : 0,
          tokenAmount: totalTokensSold,
          error: errorMsg || 'Insufficient balance',
        };
      }
      retry++;
    }
  }

  return {
    success: totalTokensSold > 0,
    executedAmount: totalReceived,
    price: totalTokensSold > 0 ? totalReceived / totalTokensSold : 0,
    tokenAmount: totalTokensSold,
  };
}

/**
 * Get order book for a token
 */
export async function getOrderBook(
  clobClient: ClobClient,
  tokenId: string
): Promise<OrderBook> {
  const book = await clobClient.getOrderBook(tokenId);
  return {
    bids: book.bids || [],
    asks: book.asks || [],
  };
}

/**
 * Get market price from order book
 */
export async function getMarketPrice(
  clobClient: ClobClient,
  tokenId: string
): Promise<MarketPrice> {
  const book = await clobClient.getOrderBook(tokenId);

  const bestBid = book.bids?.length
    ? Math.max(...book.bids.map((b) => parseFloat(b.price)))
    : 0;
  const bestAsk = book.asks?.length
    ? Math.min(...book.asks.map((a) => parseFloat(a.price)))
    : 0;

  return {
    bid: bestBid,
    ask: bestAsk,
    mid: bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk,
    spread: bestBid && bestAsk ? bestAsk - bestBid : 0,
  };
}

/**
 * Get positions for a wallet
 */
export async function getPositions(
  clobClient: ClobClient
): Promise<Position[]> {
  try {
    const positions = await clobClient.getBalanceAllowance();
    // The CLOB client returns positions in various formats
    // Map them to our Position type
    if (!positions || typeof positions !== 'object') return [];

    // CLOB getBalanceAllowance returns allowances, not positions
    // For real positions we may need a different endpoint
    return [];
  } catch {
    return [];
  }
}

/**
 * Get USDC balance for a wallet address
 */
export async function getBalance(
  address: string,
  rpcUrl: string,
  usdcContractAddress: string
): Promise<number> {
  const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(usdcContractAddress, USDC_ABI, provider);
  const balance = await contract.balanceOf(address);
  return parseFloat(ethers.utils.formatUnits(balance, 6));
}

// --- Helpers ---

function extractError(response: unknown): string | undefined {
  if (!response) return undefined;
  if (typeof response === 'string') return response;
  if (typeof response === 'object') {
    const data = response as Record<string, unknown>;
    if (typeof data.error === 'string') return data.error;
    if (typeof data.errorMsg === 'string') return data.errorMsg;
    if (typeof data.message === 'string') return data.message;
  }
  return undefined;
}

function isInsufficientFunds(msg: string | undefined): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return lower.includes('not enough balance') || lower.includes('allowance');
}
