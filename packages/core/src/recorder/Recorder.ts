/**
 * Order-book recorder (spec §10). Every `server.yaml recorder.interval_seconds` (default 60) it snapshots
 * the top 10 levels of every watched token into `orderbook_snapshots`, for Polymarket snapshot backtests.
 *
 * Watched tokens (in this priority order, capped at `recorder.max_tokens`): held by any bot (live or
 * paper), with an active forecast, in a non-retired bot's `market_ids`, on the `recorder_watchlist`.
 *
 * At most 4 book requests in flight; a cycle is skipped while the previous one runs. Failures are logged
 * and counted, never thrown: the recorder never affects trading. Retention (hourly): rows older than 180
 * days keep only the last snapshot per token per 15 minutes.
 */

import type { OrderbookSnapshotRepository } from '../db/repositories/OrderbookSnapshotRepository';
import { snapshotFromBook, type BookSnapshot } from './snapshotCodec';
import logger from '../utils/logger';

export const DEFAULT_INTERVAL_SECONDS = 60;
export const MAX_IN_FLIGHT = 4;
export const RETENTION_FULL_MS = 180 * 86_400_000;
export const DOWNSAMPLE_BUCKET_MS = 15 * 60_000;
const RETENTION_EVERY_MS = 3_600_000;
/** Rows deleted per statement; the event loop runs between batches */
export const RETENTION_BATCH = 5_000;
const CUTOFF_KEY = 'downsample_cutoff_ms';
const BOOK_TIMEOUT_MS = 10_000;

export interface RecorderSettings {
  enabled: boolean;
  interval_seconds: number;
  max_tokens: number;
}

export interface WatchSetInput {
  /** Tokens held by any bot (order-linked positions, live or paper) */
  heldTokens: string[];
  /** Tokens with an active forecast */
  forecastTokens: string[];
  /** market_ids (condition ids) of non-retired bots */
  botMarketIds: string[];
  /** Tokens of a market, null if unknown (not cached) */
  marketTokens: (marketId: string) => string[] | null;
  watchlist: string[];
  maxTokens: number;
}

/** Ordered, de-duplicated watch set (held first, so the cap never drops a held token before a watchlist one). */
export function computeWatchSet(input: WatchSetInput): { tokens: string[]; dropped: number; unknownMarkets: string[] } {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    if (typeof t !== 'string' || !t || seen.has(t)) return;
    seen.add(t);
    ordered.push(t);
  };
  input.heldTokens.forEach(add);
  input.forecastTokens.forEach(add);
  const unknownMarkets: string[] = [];
  for (const m of new Set(input.botMarketIds)) {
    const tokens = input.marketTokens(m);
    if (tokens === null) unknownMarkets.push(m);
    else tokens.forEach(add);
  }
  input.watchlist.forEach(add);
  const max = Math.max(0, Math.floor(input.maxTokens));
  return { tokens: ordered.slice(0, max), dropped: Math.max(0, ordered.length - max), unknownMarkets };
}

export interface RecorderDeps {
  repo: Pick<OrderbookSnapshotRepository, 'insert' | 'downsampleBatch' | 'getState' | 'setState' | 'watchlist'>;
  getSettings: () => RecorderSettings | null;
  heldTokens: () => string[];
  forecastTokens: () => string[];
  botMarketIds: () => string[];
  /** Tokens of a market from the market cache (may refresh it); null if unknown */
  marketTokens: (marketId: string) => Promise<string[] | null>;
  /** CLOB `/book` response for a token */
  fetchBook: (tokenId: string) => Promise<{ bids?: Array<{ price: unknown; size: unknown }>; asks?: Array<{ price: unknown; size: unknown }>; last_trade_price?: unknown }>;
  now?: () => number;
}

export interface RecorderCycleResult {
  tokens: number;
  recorded: number;
  failed: number;
  dropped: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export class Recorder {
  private deps: RecorderDeps;
  private now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private running: Promise<RecorderCycleResult | null> | null = null;
  private lastRetention = 0;
  private lastFailureLog = 0;

  constructor(deps: RecorderDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(5_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick();
      // Interval re-read every cycle (server.yaml hot reload)
      const s = this.deps.getSettings();
      this.schedule(Math.max(10, s?.interval_seconds ?? DEFAULT_INTERVAL_SECONDS) * 1000);
    }, delayMs);
    this.timer.unref?.();
  }

  private tick(): void {
    if (this.running) {
      logger.warning('[Recorder] Previous cycle still running; skipping this one');
      return;
    }
    this.running = this.runCycle()
      .catch((err) => {
        logger.error(`[Recorder] Cycle failed: ${err instanceof Error ? err.message : err}`);
        return null;
      })
      .finally(() => {
        this.running = null;
      });
  }

  /** Current watch set (also used by IPC to show what is recorded). */
  async watchSet(maxTokens: number): Promise<ReturnType<typeof computeWatchSet>> {
    const marketIds = [...new Set(this.deps.botMarketIds())];
    const known = new Map<string, string[] | null>();
    await mapLimited(marketIds, MAX_IN_FLIGHT, async (m) => {
      try {
        known.set(m, await this.deps.marketTokens(m));
      } catch {
        known.set(m, null);
      }
    });
    return computeWatchSet({
      heldTokens: this.deps.heldTokens(),
      forecastTokens: this.deps.forecastTokens(),
      botMarketIds: marketIds,
      marketTokens: (m) => known.get(m) ?? null,
      watchlist: this.deps.repo.watchlist().map((w) => w.token_id),
      maxTokens,
    });
  }

  /** One snapshot cycle (+ retention when due). Never throws for a single token. */
  async runCycle(): Promise<RecorderCycleResult> {
    const settings = this.deps.getSettings();
    if (!settings || !settings.enabled) return { tokens: 0, recorded: 0, failed: 0, dropped: 0 };
    const set = await this.watchSet(settings.max_tokens);
    if (set.dropped > 0) logger.warning(`[Recorder] ${set.dropped} token(s) over recorder.max_tokens not recorded`);

    let recorded = 0;
    const failures: string[] = [];
    await mapLimited(set.tokens, MAX_IN_FLIGHT, async (tokenId) => {
      try {
        const book = await withTimeout(this.deps.fetchBook(tokenId), BOOK_TIMEOUT_MS);
        const snap: BookSnapshot = snapshotFromBook(tokenId, this.now(), book ?? {});
        this.deps.repo.insert(snap);
        recorded++;
      } catch (err) {
        failures.push(`${tokenId.slice(0, 12)}…: ${err instanceof Error ? err.message : err}`);
      }
    });
    if (failures.length > 0 && this.now() - this.lastFailureLog > 10 * 60_000) {
      this.lastFailureLog = this.now();
      logger.warning(`[Recorder] ${failures.length}/${set.tokens.length} book(s) failed: ${failures.slice(0, 3).join('; ')}`);
    }
    await this.runRetentionIfDue();
    return { tokens: set.tokens.length, recorded, failed: failures.length, dropped: set.dropped };
  }

  /**
   * Downsample rows older than 180 days to one per token per 15 minutes (hourly). Only rows newer than the
   * previous cutoff minus one bucket are looked at (that bucket may have been split by the old cutoff); the
   * cutoff is persisted. Deletes in batches of 5 000 rows, yielding to the event loop between batches.
   */
  async runRetentionIfDue(force = false): Promise<number> {
    const now = this.now();
    if (!force && now - this.lastRetention < RETENTION_EVERY_MS) return 0;
    this.lastRetention = now;
    const cutoff = now - RETENTION_FULL_MS;
    let total = 0;
    try {
      const prev = Number(this.deps.repo.getState(CUTOFF_KEY));
      const from = Number.isFinite(prev) && prev > 0 ? prev - DOWNSAMPLE_BUCKET_MS : 0;
      for (;;) {
        const n = this.deps.repo.downsampleBatch(from, cutoff, DOWNSAMPLE_BUCKET_MS, RETENTION_BATCH);
        total += n;
        if (n < RETENTION_BATCH) break;
        await new Promise<void>((r) => setImmediate(r));
      }
      this.deps.repo.setState(CUTOFF_KEY, String(cutoff));
      if (total > 0) logger.info(`[Recorder] Retention: downsampled ${total} snapshot(s) older than 180 days`);
    } catch (err) {
      logger.error(`[Recorder] Retention failed: ${err instanceof Error ? err.message : err}`);
    }
    return total;
  }
}
