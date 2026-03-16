/**
 * Kline cache layer.
 * Fetches historical klines from Binance API and caches them in SQLite
 * so repeated backtests on the same symbol/range are instant.
 */

import type Database from 'better-sqlite3';
import { getBinanceKlines, type BinanceKline } from '../sdk/binance';

/**
 * Fetch klines for the given range, using the kline_cache table as a cache.
 * Identifies gaps in cached data and fetches only what's missing.
 */
export async function fetchKlines(
  db: Database.Database,
  symbol: string,
  startTime: number,
  endTime: number,
  interval: string = '1m'
): Promise<BinanceKline[]> {
  const upperSymbol = symbol.toUpperCase();

  // 1. Check what we already have cached
  const cached = db
    .prepare(
      `SELECT open_time, open, high, low, close, volume, close_time
       FROM kline_cache
       WHERE symbol = ? AND interval = ? AND open_time >= ? AND open_time <= ?
       ORDER BY open_time ASC`
    )
    .all(upperSymbol, interval, startTime, endTime) as Array<{
      open_time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      close_time: number;
    }>;

  // 2. Build a set of cached openTimes for fast lookup
  const cachedTimes = new Set(cached.map((r) => r.open_time));

  // 3. Find gaps — ranges of time that are not in cache
  // For simplicity, if we have at least 95% of expected candles, treat as complete
  const intervalMs = getIntervalMs(interval);
  const expectedCount = Math.floor((endTime - startTime) / intervalMs);
  const cacheHitRate = expectedCount > 0 ? cached.length / expectedCount : 0;

  let allKlines: BinanceKline[];

  if (cacheHitRate >= 0.95 && cached.length > 0) {
    // Cache is mostly complete, use it directly
    allKlines = cached.map(rowToKline);
  } else {
    // Need to fetch from API — find the actual gaps
    const gaps = findGaps(cachedTimes, startTime, endTime, intervalMs);

    // Fetch each gap from API
    const fetched: BinanceKline[] = [];
    for (const gap of gaps) {
      const klines = await getBinanceKlines(upperSymbol, interval, gap.start, gap.end);
      fetched.push(...klines);
    }

    // Insert fetched klines into cache (batch for performance)
    if (fetched.length > 0) {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO kline_cache (symbol, interval, open_time, open, high, low, close, volume, close_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const batchInsert = db.transaction((klines: BinanceKline[]) => {
        for (const k of klines) {
          insert.run(
            upperSymbol,
            interval,
            k.openTime,
            k.open,
            k.high,
            k.low,
            k.close,
            k.volume,
            k.closeTime
          );
        }
      });

      batchInsert(fetched);
    }

    // Merge cached + fetched, deduplicate, sort
    const mergedMap = new Map<number, BinanceKline>();
    for (const row of cached) {
      mergedMap.set(row.open_time, rowToKline(row));
    }
    for (const k of fetched) {
      mergedMap.set(k.openTime, k);
    }
    allKlines = Array.from(mergedMap.values()).sort((a, b) => a.openTime - b.openTime);
  }

  return allKlines;
}

// ============================================================================
// Helpers
// ============================================================================

function rowToKline(row: {
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  close_time: number;
}): BinanceKline {
  return {
    openTime: row.open_time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    closeTime: row.close_time,
  };
}

interface TimeGap {
  start: number;
  end: number;
}

/**
 * Find gaps (missing time ranges) in the cached data.
 */
function findGaps(
  cachedTimes: Set<number>,
  startTime: number,
  endTime: number,
  intervalMs: number
): TimeGap[] {
  if (cachedTimes.size === 0) {
    return [{ start: startTime, end: endTime }];
  }

  const gaps: TimeGap[] = [];
  let gapStart: number | null = null;

  for (let t = startTime; t <= endTime; t += intervalMs) {
    if (!cachedTimes.has(t)) {
      if (gapStart === null) gapStart = t;
    } else {
      if (gapStart !== null) {
        gaps.push({ start: gapStart, end: t - 1 });
        gapStart = null;
      }
    }
  }

  // Close final gap if open
  if (gapStart !== null) {
    gaps.push({ start: gapStart, end: endTime });
  }

  return gaps;
}

/**
 * Get interval duration in milliseconds.
 */
function getIntervalMs(interval: string): number {
  const map: Record<string, number> = {
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000,
    '15m': 900_000,
    '30m': 1_800_000,
    '1h': 3_600_000,
    '4h': 14_400_000,
    '1d': 86_400_000,
  };
  return map[interval] || 60_000;
}
