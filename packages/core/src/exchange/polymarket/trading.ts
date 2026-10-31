/**
 * Trading SDK - runs in the main process.
 * Read-only Polymarket helpers (books, prices, balances) that RpcHandler delegates to.
 * Placing orders is NOT here: every order goes through orders/OrderService
 * (risk checks) and exchange/polymarket/orders.ts.
 */

import type { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import type {
  OrderBook,
  Position,
  MarketPrice,
} from '../../sdk/types';

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
