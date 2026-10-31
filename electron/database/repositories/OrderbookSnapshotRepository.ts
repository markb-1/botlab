import type Database from 'better-sqlite3';
import { decodeLevels, encodeLevels, type BookSnapshot } from '../../recorder/snapshotCodec';

export interface OrderbookSnapshotRow {
  token_id: string;
  ts: number;
  best_bid: number | null;
  best_ask: number | null;
  mid: number | null;
  bids: Buffer;
  asks: Buffer;
  last_trade_price: number | null;
}

export interface WatchlistRow {
  token_id: string;
  market_id: string | null;
  note: string | null;
  added_by: string;
  added_at: string;
}

export function rowToSnapshot(r: OrderbookSnapshotRow): BookSnapshot {
  return {
    tokenId: r.token_id,
    ts: r.ts,
    bestBid: r.best_bid,
    bestAsk: r.best_ask,
    mid: r.mid,
    bids: decodeLevels(r.bids),
    asks: decodeLevels(r.asks),
    lastTradePrice: r.last_trade_price,
  };
}

/** orderbook_snapshots + recorder_watchlist (spec §2.2, §10). */
export class OrderbookSnapshotRepository {
  constructor(private db: Database.Database) {}

  insert(s: BookSnapshot): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO orderbook_snapshots (token_id, ts, best_bid, best_ask, mid, bids, asks, last_trade_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(s.tokenId, Math.round(s.ts), s.bestBid, s.bestAsk, s.mid, encodeLevels(s.bids), encodeLevels(s.asks), s.lastTradePrice);
  }

  /** Snapshots of the tokens in [fromMs, toMs], oldest first (ties by token id: deterministic). */
  range(tokenIds: string[], fromMs: number, toMs: number): BookSnapshot[] {
    if (tokenIds.length === 0) return [];
    const marks = tokenIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM orderbook_snapshots WHERE token_id IN (${marks}) AND ts >= ? AND ts <= ? ORDER BY ts, token_id`)
      .all(...tokenIds, fromMs, toMs) as OrderbookSnapshotRow[];
    return rows.map(rowToSnapshot);
  }

  count(tokenId?: string): number {
    const row = (tokenId
      ? this.db.prepare('SELECT COUNT(*) AS n FROM orderbook_snapshots WHERE token_id = ?').get(tokenId)
      : this.db.prepare('SELECT COUNT(*) AS n FROM orderbook_snapshots').get()) as { n: number };
    return row.n;
  }

  /**
   * Retention: rows older than `cutoffMs` keep only the last snapshot per token per `bucketMs` bucket.
   * Returns the number of rows deleted.
   */
  downsample(cutoffMs: number, bucketMs: number): number {
    const r = this.db
      .prepare(
        `DELETE FROM orderbook_snapshots
         WHERE ts < @cutoff AND EXISTS (
           SELECT 1 FROM orderbook_snapshots t
           WHERE t.token_id = orderbook_snapshots.token_id AND t.ts < @cutoff
             AND CAST(t.ts / @bucket AS INTEGER) = CAST(orderbook_snapshots.ts / @bucket AS INTEGER)
             AND t.ts > orderbook_snapshots.ts
         )`
      )
      .run({ cutoff: Math.floor(cutoffMs), bucket: Math.floor(bucketMs) });
    return r.changes;
  }

  // ── Watchlist ──

  watchlist(): WatchlistRow[] {
    return this.db.prepare('SELECT * FROM recorder_watchlist ORDER BY added_at').all() as WatchlistRow[];
  }

  addWatch(tokenId: string, marketId: string | null, note: string | null, addedBy: string): void {
    this.db
      .prepare(
        `INSERT INTO recorder_watchlist (token_id, market_id, note, added_by, added_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(token_id) DO UPDATE SET market_id = excluded.market_id, note = excluded.note`
      )
      .run(tokenId, marketId, note, addedBy, new Date().toISOString());
  }

  removeWatch(tokenId: string): boolean {
    return this.db.prepare('DELETE FROM recorder_watchlist WHERE token_id = ?').run(tokenId).changes > 0;
  }
}
