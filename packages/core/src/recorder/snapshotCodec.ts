/**
 * Order-book snapshot encoding (spec §2.2, §10): top-N levels as JSON `[[price, size], …]`, zlib-deflated
 * for the `orderbook_snapshots.bids/asks` BLOBs. Bids best (highest) first, asks best (lowest) first.
 */

import zlib from 'zlib';

export const SNAPSHOT_DEPTH = 10;

export type Level = [price: number, size: number];

export interface BookSnapshot {
  tokenId: string;
  /** ms since epoch */
  ts: number;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  bids: Level[];
  asks: Level[];
  lastTradePrice: number | null;
}

const num = (v: unknown): number => (typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN);

/** Normalise raw CLOB levels: finite, positive size, sorted best first, merged by price, top `depth`. */
export function topLevels(raw: Array<{ price: unknown; size: unknown }> | undefined, side: 'bid' | 'ask', depth = SNAPSHOT_DEPTH): Level[] {
  const byPrice = new Map<number, number>();
  for (const l of raw ?? []) {
    const p = num(l?.price);
    const s = num(l?.size);
    if (!Number.isFinite(p) || !Number.isFinite(s) || p <= 0 || s <= 0) continue;
    byPrice.set(p, (byPrice.get(p) ?? 0) + s);
  }
  return [...byPrice.entries()].sort((a, b) => (side === 'bid' ? b[0] - a[0] : a[0] - b[0])).slice(0, depth);
}

/** Build a snapshot from a CLOB `/book` response. */
export function snapshotFromBook(
  tokenId: string,
  ts: number,
  book: { bids?: Array<{ price: unknown; size: unknown }>; asks?: Array<{ price: unknown; size: unknown }>; last_trade_price?: unknown }
): BookSnapshot {
  const bids = topLevels(book.bids, 'bid');
  const asks = topLevels(book.asks, 'ask');
  const bestBid = bids.length > 0 ? bids[0][0] : null;
  const bestAsk = asks.length > 0 ? asks[0][0] : null;
  const ltp = num(book.last_trade_price);
  return {
    tokenId,
    ts,
    bestBid,
    bestAsk,
    mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
    bids,
    asks,
    lastTradePrice: Number.isFinite(ltp) && ltp > 0 ? ltp : null,
  };
}

export function encodeLevels(levels: Level[]): Buffer {
  return zlib.deflateSync(Buffer.from(JSON.stringify(levels), 'utf8'));
}

export function decodeLevels(blob: Buffer | Uint8Array | null): Level[] {
  if (!blob) return [];
  const v = JSON.parse(zlib.inflateSync(blob).toString('utf8')) as unknown;
  return Array.isArray(v) ? v.filter((l): l is Level => Array.isArray(l) && l.length === 2 && l.every((x) => typeof x === 'number')) : [];
}
