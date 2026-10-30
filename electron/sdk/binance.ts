/**
 * Binance REST API client.
 * Zero-dependency wrapper using built-in Node.js crypto for HMAC-SHA256 signing.
 * Supports spot trading only (market orders).
 */

import crypto from 'crypto';

const BASE_URL = 'https://api.binance.com';

// ============================================================================
// Types
// ============================================================================

export interface BinanceCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface BinanceTradeResult {
  success: boolean;
  orderId?: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  executedQty: number;
  cummulativeQuoteQty: number;
  avgPrice: number;
  error?: string;
  /**
   * Set on failure when Binance did not give a definite answer (network error or HTTP 5xx,
   * which Binance documents as "execution status unknown"). The order may have executed.
   */
  outcomeUnknown?: boolean;
}

/** HTTP error from the Binance API; `status` is undefined for network failures. */
export class BinanceHttpError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'BinanceHttpError';
  }
}

/** True unless Binance answered with a 4xx (a definite rejection). */
function isUnknownOutcome(err: unknown): boolean {
  return !(err instanceof BinanceHttpError && err.status !== undefined && err.status >= 400 && err.status < 500);
}

export interface BinanceOrderBook {
  bids: Array<{ price: string; quantity: string }>;
  asks: Array<{ price: string; quantity: string }>;
}

export interface BinanceBalance {
  asset: string;
  free: number;
  locked: number;
}

export interface BinancePosition {
  asset: string;
  free: number;
  locked: number;
  total: number;
  estimatedValueUsdt?: number;
}

export interface BinancePrice {
  symbol: string;
  price: number;
}

export interface BinanceKline {
  openTime: number;   // ms timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;  // ms timestamp
}

// ============================================================================
// Signing
// ============================================================================

/**
 * Create HMAC-SHA256 signature for Binance API requests.
 */
export function signQuery(queryString: string, apiSecret: string): string {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

/**
 * Build a signed query string with timestamp and signature.
 */
function buildSignedQuery(
  params: Record<string, string | number>,
  apiSecret: string
): string {
  const timestamp = Date.now();
  const entries = { ...params, timestamp };
  const queryString = Object.entries(entries)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const signature = signQuery(queryString, apiSecret);
  return `${queryString}&signature=${signature}`;
}

// ============================================================================
// HTTP helpers
// ============================================================================

async function publicGet<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  let url = `${BASE_URL}${path}`;
  if (params) {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    url += `?${qs}`;
  }
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Binance API ${path}: HTTP ${resp.status} - ${body}`);
  }
  return resp.json() as Promise<T>;
}

async function signedGet<T>(
  path: string,
  creds: BinanceCredentials,
  params?: Record<string, string | number>
): Promise<T> {
  const query = buildSignedQuery(params || {}, creds.apiSecret);
  const url = `${BASE_URL}${path}?${query}`;
  const resp = await fetch(url, {
    headers: { 'X-MBX-APIKEY': creds.apiKey },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Binance API ${path}: HTTP ${resp.status} - ${body}`);
  }
  return resp.json() as Promise<T>;
}

async function signedPost<T>(
  path: string,
  creds: BinanceCredentials,
  params: Record<string, string | number>
): Promise<T> {
  const query = buildSignedQuery(params, creds.apiSecret);
  const url = `${BASE_URL}${path}?${query}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': creds.apiKey },
    });
  } catch (err) {
    throw new BinanceHttpError(err instanceof Error ? err.message : String(err));
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new BinanceHttpError(`Binance API ${path}: HTTP ${resp.status} - ${body}`, resp.status);
  }
  return resp.json() as Promise<T>;
}

// ============================================================================
// Public Endpoints (no credentials needed)
// ============================================================================

/**
 * Get current price for a symbol.
 */
export async function getBinancePrice(symbol: string): Promise<BinancePrice> {
  const data = await publicGet<{ symbol: string; price: string }>(
    '/api/v3/ticker/price',
    { symbol: symbol.toUpperCase() }
  );
  return {
    symbol: data.symbol,
    price: parseFloat(data.price),
  };
}

/**
 * Get order book depth for a symbol.
 */
export async function getBinanceOrderBook(
  symbol: string,
  limit: number = 20
): Promise<BinanceOrderBook> {
  const data = await publicGet<{ bids: string[][]; asks: string[][] }>(
    '/api/v3/depth',
    { symbol: symbol.toUpperCase(), limit }
  );
  return {
    bids: data.bids.map(([price, quantity]) => ({ price, quantity })),
    asks: data.asks.map(([price, quantity]) => ({ price, quantity })),
  };
}

/**
 * Get historical kline/candlestick data for a symbol.
 * Auto-paginates in batches of 1000 (Binance max) to fetch the full range.
 */
export async function getBinanceKlines(
  symbol: string,
  interval: string = '1m',
  startTime: number,
  endTime: number
): Promise<BinanceKline[]> {
  const allKlines: BinanceKline[] = [];
  let currentStart = startTime;
  const BATCH_SIZE = 1000;

  while (currentStart < endTime) {
    const data = await publicGet<Array<(string | number)[]>>(
      '/api/v3/klines',
      {
        symbol: symbol.toUpperCase(),
        interval,
        startTime: currentStart,
        endTime,
        limit: BATCH_SIZE,
      }
    );

    if (data.length === 0) break;

    for (const k of data) {
      allKlines.push({
        openTime: k[0] as number,
        open: parseFloat(k[1] as string),
        high: parseFloat(k[2] as string),
        low: parseFloat(k[3] as string),
        close: parseFloat(k[4] as string),
        volume: parseFloat(k[5] as string),
        closeTime: k[6] as number,
      });
    }

    // Move start to after the last kline's close time
    const lastCloseTime = data[data.length - 1][6] as number;
    currentStart = lastCloseTime + 1;

    // If we got fewer than BATCH_SIZE, we've reached the end
    if (data.length < BATCH_SIZE) break;
  }

  return allKlines;
}

// ============================================================================
// Authenticated Endpoints
// ============================================================================

/**
 * Test connectivity and validate API key/secret.
 * Returns true if valid, throws on error.
 */
export async function testConnection(creds: BinanceCredentials): Promise<boolean> {
  await signedGet('/api/v3/account', creds);
  return true;
}

/**
 * Get all non-zero balances for the account.
 */
export async function getBinanceBalances(creds: BinanceCredentials): Promise<BinanceBalance[]> {
  const data = await signedGet<{
    balances: Array<{ asset: string; free: string; locked: string }>;
  }>('/api/v3/account', creds);

  return data.balances
    .map((b) => ({
      asset: b.asset,
      free: parseFloat(b.free),
      locked: parseFloat(b.locked),
    }))
    .filter((b) => b.free > 0 || b.locked > 0);
}

/**
 * Get balance for a specific asset (default: USDT).
 */
export async function getBinanceBalance(
  creds: BinanceCredentials,
  asset: string = 'USDT'
): Promise<number> {
  const balances = await getBinanceBalances(creds);
  const found = balances.find((b) => b.asset === asset.toUpperCase());
  return found ? found.free : 0;
}

/**
 * Get all non-zero positions (balances excluding USDT as quote).
 */
export async function getBinancePositions(creds: BinanceCredentials): Promise<BinancePosition[]> {
  const balances = await getBinanceBalances(creds);
  return balances.map((b) => ({
    asset: b.asset,
    free: b.free,
    locked: b.locked,
    total: b.free + b.locked,
  }));
}

/**
 * Execute a market buy order (spend quoteAmount of USDT).
 * Only electron/orders/ExchangeAdapter.ts may call this (OrderService choke point).
 * `clientOrderId` (our orders.id) makes retries idempotent on Binance's side.
 */
export async function executeBinanceBuy(
  creds: BinanceCredentials,
  symbol: string,
  quoteAmount: number,
  clientOrderId?: string
): Promise<BinanceTradeResult> {
  try {
    const data = await signedPost<{
      orderId: number;
      symbol: string;
      side: string;
      executedQty: string;
      cummulativeQuoteQty: string;
      status: string;
    }>('/api/v3/order', creds, {
      symbol: symbol.toUpperCase(),
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty: quoteAmount.toFixed(2),
      ...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
    });

    const executedQty = parseFloat(data.executedQty);
    const quoteQty = parseFloat(data.cummulativeQuoteQty);
    const avgPrice = executedQty > 0 ? quoteQty / executedQty : 0;

    return {
      success: true,
      orderId: data.orderId,
      symbol: data.symbol,
      side: 'BUY',
      executedQty,
      cummulativeQuoteQty: quoteQty,
      avgPrice,
    };
  } catch (err) {
    return {
      success: false,
      symbol: symbol.toUpperCase(),
      side: 'BUY',
      executedQty: 0,
      cummulativeQuoteQty: 0,
      avgPrice: 0,
      error: err instanceof Error ? err.message : String(err),
      outcomeUnknown: isUnknownOutcome(err),
    };
  }
}

/**
 * Execute a market sell order (sell quantity of base asset).
 * Only electron/orders/ExchangeAdapter.ts may call this (OrderService choke point).
 */
export async function executeBinanceSell(
  creds: BinanceCredentials,
  symbol: string,
  quantity: number,
  clientOrderId?: string
): Promise<BinanceTradeResult> {
  try {
    const data = await signedPost<{
      orderId: number;
      symbol: string;
      side: string;
      executedQty: string;
      cummulativeQuoteQty: string;
      status: string;
    }>('/api/v3/order', creds, {
      symbol: symbol.toUpperCase(),
      side: 'SELL',
      type: 'MARKET',
      quantity: quantity.toString(),
      ...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
    });

    const executedQty = parseFloat(data.executedQty);
    const quoteQty = parseFloat(data.cummulativeQuoteQty);
    const avgPrice = executedQty > 0 ? quoteQty / executedQty : 0;

    return {
      success: true,
      orderId: data.orderId,
      symbol: data.symbol,
      side: 'SELL',
      executedQty,
      cummulativeQuoteQty: quoteQty,
      avgPrice,
    };
  } catch (err) {
    return {
      success: false,
      symbol: symbol.toUpperCase(),
      side: 'SELL',
      executedQty: 0,
      cummulativeQuoteQty: 0,
      avgPrice: 0,
      error: err instanceof Error ? err.message : String(err),
      outcomeUnknown: isUnknownOutcome(err),
    };
  }
}
