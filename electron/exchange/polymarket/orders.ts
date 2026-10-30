/**
 * Polymarket order adapter — the only module that signs and posts CLOB orders.
 *
 * Callers: electron/orders/ExchangeAdapter.ts only (enforced by tests/orders/choke-point.test.ts).
 * Every live order must go through OrderService, which runs the RiskEngine first.
 *
 * The CLOB client returns `{ error, status }` instead of throwing on HTTP errors; these
 * helpers normalise that into `PostOrderOutcome`, distinguishing a definite rejection
 * (the exchange answered with an error) from an unknown outcome (no answer), because an
 * order with an unknown outcome may be live and must keep counting toward exposure.
 */

import { OrderType, Side, type ClobClient } from '@polymarket/clob-client';

/**
 * Polymarket applies a one-minute security threshold to GTD expirations: an order
 * meant to live N seconds must be sent with expiration = now + 60 + N (CLOB docs,
 * "GTD orders"). VERIFY against current docs before live trading.
 */
export const GTD_SECURITY_BUFFER_SECONDS = 60;

export type PostOrderOutcome =
  | {
      kind: 'accepted';
      exchangeOrderId: string | null;
      /** CLOB status: 'matched' (filled), 'live' (resting), 'delayed', 'unmatched' */
      status: string;
      /** Shares filled (if the response says) */
      filledSize: number | null;
      /** USDC exchanged for the filled shares (if the response says) */
      filledNotional: number | null;
    }
  | { kind: 'rejected'; error: string }
  | { kind: 'unknown'; error: string };

function parseNum(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function errorText(resp: Record<string, unknown>): string {
  const e = resp.error ?? resp.errorMsg ?? resp.message;
  return typeof e === 'string' ? e : JSON.stringify(e ?? resp);
}

/** Map a postOrder response (or thrown error) to an outcome. */
export function interpretPostResponse(resp: unknown, side: 'buy' | 'sell'): PostOrderOutcome {
  if (!resp || typeof resp !== 'object') return { kind: 'unknown', error: `Unexpected response: ${String(resp)}` };
  const r = resp as Record<string, unknown>;

  const orderId = typeof r.orderID === 'string' && r.orderID ? r.orderID : null;
  if (r.success === true || (orderId && !r.error && !r.errorMsg)) {
    // BUY: making = USDC paid, taking = shares received. SELL: the reverse.
    const making = parseNum(r.makingAmount);
    const taking = parseNum(r.takingAmount);
    const filledSize = side === 'buy' ? taking : making;
    const filledNotional = side === 'buy' ? making : taking;
    return {
      kind: 'accepted',
      exchangeOrderId: orderId,
      status: typeof r.status === 'string' ? r.status : 'unknown',
      filledSize: filledSize && filledSize > 0 ? filledSize : null,
      filledNotional: filledNotional && filledNotional > 0 ? filledNotional : null,
    };
  }

  // An HTTP status means the exchange answered: the order was not accepted
  if (typeof r.status === 'number' || r.success === false || typeof r.errorMsg === 'string') {
    return { kind: 'rejected', error: errorText(r) };
  }
  return { kind: 'unknown', error: errorText(r) };
}

/**
 * Marketable order, fill-or-kill at `price` or better.
 * BUY: `amount` is USDC to spend. SELL: `amount` is shares to sell.
 */
export async function postMarketOrder(
  clob: ClobClient,
  args: { tokenId: string; side: 'buy' | 'sell'; amount: number; price: number }
): Promise<PostOrderOutcome> {
  let signed;
  try {
    signed = await clob.createMarketOrder({
      tokenID: args.tokenId,
      side: args.side === 'buy' ? Side.BUY : Side.SELL,
      amount: args.amount,
      price: args.price,
    });
  } catch (err) {
    // Nothing was sent
    return { kind: 'rejected', error: `Could not build order: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return interpretPostResponse(await clob.postOrder(signed, OrderType.FOK), args.side);
  } catch (err) {
    return { kind: 'unknown', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Resting limit order, good-till-date. `expiresAtMs` is when the order should stop being live. */
export async function postLimitOrder(
  clob: ClobClient,
  args: { tokenId: string; side: 'buy' | 'sell'; price: number; size: number; expiresAtMs: number }
): Promise<PostOrderOutcome> {
  let signed;
  try {
    signed = await clob.createOrder({
      tokenID: args.tokenId,
      side: args.side === 'buy' ? Side.BUY : Side.SELL,
      price: args.price,
      size: args.size,
      expiration: Math.floor(args.expiresAtMs / 1000) + GTD_SECURITY_BUFFER_SECONDS,
    });
  } catch (err) {
    return { kind: 'rejected', error: `Could not build order: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return interpretPostResponse(await clob.postOrder(signed, OrderType.GTD), args.side);
  } catch (err) {
    return { kind: 'unknown', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Cancel orders by exchange id. Returns the ids the exchange confirmed as cancelled. */
export async function cancelOrders(clob: ClobClient, exchangeOrderIds: string[]): Promise<string[]> {
  if (exchangeOrderIds.length === 0) return [];
  const resp = (await clob.cancelOrders(exchangeOrderIds)) as { canceled?: unknown; error?: unknown } | undefined;
  if (!resp || resp.error) {
    throw new Error(`Cancel failed: ${resp ? JSON.stringify(resp.error) : 'no response'}`);
  }
  return Array.isArray(resp.canceled) ? resp.canceled.filter((x): x is string => typeof x === 'string') : [];
}

/** Current exchange state of one order; null if the exchange did not return it. */
export async function fetchOrder(
  clob: ClobClient,
  exchangeOrderId: string
): Promise<{ status: string; sizeMatched: number; originalSize: number; price: number } | null> {
  const o = (await clob.getOrder(exchangeOrderId)) as unknown as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || o.error || typeof o.status !== 'string') return null;
  const sizeMatched = parseNum(o.size_matched);
  const originalSize = parseNum(o.original_size);
  const price = parseNum(o.price);
  if (sizeMatched === null || originalSize === null || price === null) return null;
  return { status: o.status, sizeMatched, originalSize, price };
}
