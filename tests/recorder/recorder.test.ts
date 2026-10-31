/**
 * Order-book recorder (spec §10): watch set, snapshot encoding, retention downsampling.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../packages/core/src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { sqliteAvailable, openTestDb, type TestDb } from '../orders/db';
import { OrderbookSnapshotRepository } from '../../packages/core/src/db/repositories/OrderbookSnapshotRepository';
import { computeWatchSet, Recorder, DOWNSAMPLE_BUCKET_MS, RETENTION_FULL_MS } from '../../packages/core/src/recorder/Recorder';
import { snapshotFromBook, type BookSnapshot } from '../../packages/core/src/recorder/snapshotCodec';

describe('computeWatchSet', () => {
  const marketTokens = (m: string) => ({ m1: ['a1', 'a2'], m2: ['b1', 'b2'] })[m] ?? null;

  it('unions held, forecast, bot-scope and watchlist tokens, held first, de-duplicated', () => {
    const r = computeWatchSet({
      heldTokens: ['h1', 'a1'],
      forecastTokens: ['f1', 'h1'],
      botMarketIds: ['m1', 'm2', 'm1', 'unknown'],
      marketTokens,
      watchlist: ['w1', 'b2'],
      maxTokens: 100,
    });
    expect(r.tokens).toEqual(['h1', 'a1', 'f1', 'a2', 'b1', 'b2', 'w1']);
    expect(r.unknownMarkets).toEqual(['unknown']);
    expect(r.dropped).toBe(0);
  });

  it('caps the set without dropping held tokens first', () => {
    const r = computeWatchSet({ heldTokens: ['h1', 'h2'], forecastTokens: ['f1'], botMarketIds: [], marketTokens, watchlist: ['w1'], maxTokens: 3 });
    expect(r.tokens).toEqual(['h1', 'h2', 'f1']);
    expect(r.dropped).toBe(1);
  });
});

describe('snapshotFromBook', () => {
  it('keeps the top 10 levels per side, best first, with mid and last trade price', () => {
    const bids = Array.from({ length: 15 }, (_, i) => ({ price: String(0.3 + i * 0.01), size: '10' }));
    const asks = Array.from({ length: 15 }, (_, i) => ({ price: String(0.6 - i * 0.01), size: '5' }));
    const s = snapshotFromBook('t', 1000, { bids, asks: [...asks, { price: '0.5', size: '0' }], last_trade_price: '0.47' });
    expect(s.bids).toHaveLength(10);
    expect(s.asks).toHaveLength(10);
    expect(s.bestBid).toBeCloseTo(0.44);
    expect(s.bestAsk).toBeCloseTo(0.46);
    expect(s.mid).toBeCloseTo(0.45);
    expect(s.lastTradePrice).toBe(0.47);
    expect(s.asks[0][0]).toBeLessThan(s.asks[1][0]);
  });
});

describe.skipIf(!sqliteAvailable)('Recorder storage and retention', () => {
  let t: TestDb;
  afterEach(() => t.close());

  const snap = (tokenId: string, ts: number): BookSnapshot => snapshotFromBook(tokenId, ts, { bids: [{ price: '0.4', size: String(ts % 97) }], asks: [{ price: '0.5', size: '1' }] });

  it('stores compressed levels and reads them back', () => {
    t = openTestDb();
    const repo = new OrderbookSnapshotRepository(t.db);
    repo.insert(snap('t1', 60_000));
    const [row] = repo.range(['t1'], 0, 120_000);
    expect(row.bids).toEqual([[0.4, 60_000 % 97]]);
    const blob = t.db.prepare('SELECT bids FROM orderbook_snapshots').get() as { bids: Buffer };
    expect(Buffer.isBuffer(blob.bids)).toBe(true);
  });

  it('downsamples rows older than 180 days to the last snapshot per 15-minute bucket', async () => {
    t = openTestDb();
    const repo = new OrderbookSnapshotRepository(t.db);
    const now = Date.UTC(2026, 9, 31);
    const old = now - RETENTION_FULL_MS - 3_600_000; // an hour beyond the cutoff
    const bucketStart = Math.floor(old / DOWNSAMPLE_BUCKET_MS) * DOWNSAMPLE_BUCKET_MS;
    // two buckets × 15 one-minute snapshots, two tokens; plus recent rows
    for (const token of ['t1', 't2']) {
      for (let i = 0; i < 30; i++) repo.insert(snap(token, bucketStart + i * 60_000));
      for (let i = 0; i < 5; i++) repo.insert(snap(token, now - i * 60_000));
    }
    const rec = new Recorder({
      repo,
      getSettings: () => null,
      heldTokens: () => [],
      forecastTokens: () => [],
      botMarketIds: () => [],
      marketTokens: async () => null,
      fetchBook: async () => ({}),
      now: () => now,
    });
    const deleted = await rec.runRetentionIfDue(true);
    expect(deleted).toBe(2 * 28);
    const kept = repo.range(['t1'], 0, now).map((s) => s.ts);
    expect(kept).toEqual([
      bucketStart + 14 * 60_000,
      bucketStart + 29 * 60_000,
      ...Array.from({ length: 5 }, (_, i) => now - (4 - i) * 60_000),
    ]);
    expect(await rec.runRetentionIfDue(true)).toBe(0); // idempotent
  });

  function recorderFor(repo: OrderbookSnapshotRepository, clock: { now: number }): Recorder {
    return new Recorder({
      repo,
      getSettings: () => null,
      heldTokens: () => [],
      forecastTokens: () => [],
      botMarketIds: () => [],
      marketTokens: async () => null,
      fetchBook: async () => ({}),
      now: () => clock.now,
    });
  }

  it('a year of rows for 3 tokens is downsampled in bounded time, in batches, and later runs only look at new rows', async () => {
    t = openTestDb();
    const repo = new OrderbookSnapshotRepository(t.db);
    const now = Date.UTC(2026, 9, 31);
    const step = 60_000;
    const start = now - 365 * 86_400_000;
    const blob = Buffer.from([1, 2, 3]);
    const ins = t.db.prepare('INSERT INTO orderbook_snapshots (token_id, ts, best_bid, best_ask, mid, bids, asks) VALUES (?, ?, 0.4, 0.5, 0.45, ?, ?)');
    t.db.transaction(() => {
      for (const token of ['t1', 't2', 't3']) for (let ts = start; ts < now; ts += step) ins.run(token, ts, blob, blob);
    })();
    const rowsBefore = repo.count();
    expect(rowsBefore).toBeGreaterThan(1_500_000);

    const clock = { now };
    const rec = recorderFor(repo, clock);
    const spy = vi.spyOn(repo, 'downsampleBatch');
    const t0 = Date.now();
    const deleted = await rec.runRetentionIfDue(true);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(60_000); // generous: CI machines vary
    expect(spy.mock.calls.length).toBeGreaterThan(100); // batched (5 000 rows per statement)

    const cutoff = now - RETENTION_FULL_MS;
    const oldPerBucket = t.db
      .prepare('SELECT MAX(n) AS m, COUNT(*) AS buckets FROM (SELECT COUNT(*) AS n FROM orderbook_snapshots WHERE ts < ? GROUP BY token_id, ts / ?)')
      .get(cutoff, DOWNSAMPLE_BUCKET_MS) as { m: number; buckets: number };
    expect(oldPerBucket.m).toBe(1);
    expect(deleted).toBe(rowsBefore - repo.count());
    expect(repo.count('t1')).toBe(t.db.prepare('SELECT COUNT(*) AS n FROM orderbook_snapshots WHERE token_id = ? AND ts >= ?').pluck().get('t1', cutoff) as number + oldPerBucket.buckets / 3);

    // An hour later only the newly expired hour (plus one bucket) is examined
    clock.now += 3_600_000;
    spy.mockClear();
    const t1 = Date.now();
    const more = await rec.runRetentionIfDue(true);
    expect(Date.now() - t1).toBeLessThan(5_000);
    expect(more).toBe(3 * (60 - 4)); // 4 buckets of 15 one-minute rows keep 1 each
    expect(spy.mock.calls[0][0]).toBe(cutoff - DOWNSAMPLE_BUCKET_MS);
  }, 180_000);

  it('records each watched token once per cycle with at most 4 requests in flight; failures do not throw', async () => {
    t = openTestDb();
    const repo = new OrderbookSnapshotRepository(t.db);
    repo.addWatch('w9', null, null, 'human');
    let inFlight = 0;
    let maxInFlight = 0;
    const rec = new Recorder({
      repo,
      getSettings: () => ({ enabled: true, interval_seconds: 60, max_tokens: 100 }),
      heldTokens: () => ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      forecastTokens: () => [],
      botMarketIds: () => [],
      marketTokens: async () => null,
      fetchBook: async (tokenId) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        if (tokenId === 'h3') throw new Error('HTTP 500');
        return { bids: [{ price: '0.4', size: '1' }], asks: [{ price: '0.6', size: '1' }] };
      },
      now: () => 1_000_000,
    });
    const r = await rec.runCycle();
    expect(r).toEqual({ tokens: 7, recorded: 6, failed: 1, dropped: 0 });
    expect(maxInFlight).toBe(4);
    expect(repo.count()).toBe(6);
  });
});
