/**
 * MarketService — cached market view and human ambiguity assessment (spec §6, §7.4), over
 * MarketCacheService. Forecasts and category rights are served by LedgerService directly
 * (`core.services.ledger`), whose methods already take plain inputs and an actor.
 */

import { GammaHttpError, parseGammaMarketFull, type GammaSearchHit, type MarketCacheService, type MarketView } from '../ledger/MarketCacheService';
import { auditActorOf, requireActor, type Actor, type HumanActor } from './actors';
import { invalidInput, notFound, ServiceError } from './errors';
import { publicLookupError } from './redact';
import type { LimitsConfig, MandateConfig } from '../config/schema';
import type { AuditRepository } from '../db/repositories/AuditRepository';
import type { OrderbookSnapshotRepository } from '../db/repositories/OrderbookSnapshotRepository';
import type { FeeRates } from '../orders/feeModel';
import { mandateListing } from '../ledger/scoring';
import { MAX_HORIZON_DAYS } from '../config/schema';
import { GAMMA_API_URL } from '../orders/MarketDataService';
import {
  fetchGammaEvent,
  fetchLeaderboard,
  fetchOrderBook,
  fetchPriceHistory,
  fetchWalletActivity,
  type LeaderboardOrder,
  type LeaderboardPeriod,
  type PriceHistoryInterval,
} from '../ledger/polymarketPublic';

/** What the agent's research tools need beyond the market cache (spec §7.3); all optional for tests */
export interface MarketServiceExtras {
  /** CLOB base URL (settings) */
  clobUrl?: () => string;
  snapshotRepo?: Pick<OrderbookSnapshotRepository, 'range'>;
  auditRepo?: Pick<AuditRepository, 'list'>;
  feeRatesFor?: (tokenId: string) => FeeRates;
  getMandate?: () => MandateConfig | null;
  getLimits?: () => LimitsConfig | null;
  fetchFn?: typeof fetch;
  gammaUrl?: string;
}

/** A live search hit with the mandate / limit checks the agent must respect (spec §7.2 Scan) */
export interface AgentSearchHit extends GammaSearchHit {
  /** allow | later | deny | unknown (mandate.categories) */
  mandate: string;
  daysToEnd: number | null;
  /** Why the market is outside the mandate / limits (empty ⇒ in scope) */
  flags: string[];
}

const DAY_MS = 86_400_000;
const CLOB_DEFAULT = 'https://clob.polymarket.com';

/** Live search results are reused for this long per identical query */
export const SEARCH_CACHE_MS = 60_000;
/** After a Gamma 429 without Retry-After, live search pauses this long */
export const SEARCH_BACKOFF_MS = 60_000;
const SEARCH_CACHE_MAX = 200;

/**
 * Live search is a convenience for people browsing: it has its own cache and its own back-off, so a
 * Gamma 429 here never delays the order path (MarketDataService / MarketCacheService.refresh share no
 * state or budget with it). Per-principal rate limiting is the transport's job (routes/api.ts).
 */
export class MarketService {
  private searchCache = new Map<string, { at: number; hits: GammaSearchHit[] }>();
  private searchBlockedUntil = 0;
  private searchInflight = new Map<string, Promise<GammaSearchHit[]>>();

  constructor(
    private markets: MarketCacheService,
    private now: () => number = Date.now,
    private extras: MarketServiceExtras = {}
  ) {}

  private get fetchFn(): typeof fetch {
    return this.extras.fetchFn ?? globalThis.fetch;
  }

  private clobUrl(): string {
    return this.extras.clobUrl?.() || CLOB_DEFAULT;
  }

  private static tokenId(tokenId: unknown): string {
    if (typeof tokenId !== 'string' || !/^[0-9A-Za-z]{1,100}$/.test(tokenId)) throw invalidInput('tokenId must be a token id');
    return tokenId;
  }

  private async lookup<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ServiceError) throw err;
      throw new ServiceError('unavailable', publicLookupError(err, what));
    }
  }

  async get(marketId: unknown) {
    if (typeof marketId !== 'string' || !marketId) throw invalidInput('marketId required');
    return this.markets.getMarket(marketId);
  }

  /**
   * Search the market cache (markets held, ordered, forecast or looked up before; no Gamma search):
   * substring of question, event title, slug, market id or token id. Newest refreshed first.
   */
  search(q: unknown, limit?: unknown) {
    const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
    const n = typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 200) : 50;
    const all = this.markets.listCached();
    const hits = needle
      ? all.filter(
          (m) =>
            m.question.toLowerCase().includes(needle) ||
            (m.eventTitle ?? '').toLowerCase().includes(needle) ||
            (m.slug ?? '').toLowerCase().includes(needle) ||
            m.marketId.toLowerCase() === needle ||
            m.tokens.some((t) => t.tokenId === needle)
        )
      : all;
    return hits
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, n)
      .map((m) => ({
        marketId: m.marketId,
        question: m.question,
        category: m.category,
        endDate: m.endDate,
        closed: m.closed,
        ambiguityScore: m.ambiguityScore,
        rulesChangedAt: m.rulesChangedAt,
        disputed: m.disputed,
        updatedAt: m.updatedAt,
      }));
  }

  /**
   * Live Polymarket search via Gamma (text, open markets only by default, BotLab category filter). Cached 60 s per
   * query; a category-only search (no text: a fan-out over the category's Gamma tags) is fetched once at the maximum
   * size and sliced per request, so different `limit`s share one fetch; concurrent identical searches share one
   * in-flight request.
   */
  async searchLive(input: { q?: unknown; active?: unknown; category?: unknown; limit?: unknown }) {
    const q = typeof input.q === 'string' ? input.q : '';
    const category = typeof input.category === 'string' && input.category.trim() ? input.category.trim() : undefined;
    const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(Math.floor(input.limit), 100) : 50;
    const fanOut = !q.trim() && !!category;
    const opts = { q: q.trim().toLowerCase(), active: input.active !== false, ...(category ? { category } : {}), limit: fanOut ? 100 : limit };
    const key = JSON.stringify(opts);
    const now = this.now();
    const hit = this.searchCache.get(key);
    if (hit && now - hit.at < SEARCH_CACHE_MS) return hit.hits.slice(0, limit);
    const pending = this.searchInflight.get(key);
    if (pending) return (await pending).slice(0, limit);
    if (now < this.searchBlockedUntil) {
      throw new ServiceError('unavailable', `Polymarket search is rate-limited; try again in ${Math.ceil((this.searchBlockedUntil - now) / 1000)} s`);
    }
    const run = (async () => {
      try {
        const hits = await this.markets.searchGamma(opts);
        if (this.searchCache.size >= SEARCH_CACHE_MAX) {
          for (const [k, v] of this.searchCache) if (now - v.at >= SEARCH_CACHE_MS) this.searchCache.delete(k);
          if (this.searchCache.size >= SEARCH_CACHE_MAX) this.searchCache.delete(this.searchCache.keys().next().value as string);
        }
        this.searchCache.set(key, { at: now, hits });
        return hits;
      } catch (err) {
        if (err instanceof GammaHttpError && err.status === 429) {
          this.searchBlockedUntil = now + Math.min(Math.max(err.retryAfterMs ?? SEARCH_BACKOFF_MS, 5_000), 10 * 60_000);
          throw new ServiceError('unavailable', 'Polymarket search is rate-limited by Polymarket; try again in a minute');
        }
        throw new ServiceError('unavailable', publicLookupError(err, 'Polymarket search'));
      } finally {
        this.searchInflight.delete(key);
      }
    })();
    this.searchInflight.set(key, run);
    return (await run).slice(0, limit);
  }

  /**
   * Weight of a live search against the per-principal search rate limit: 1, or for a category-only search (a
   * fan-out over the category's Gamma tags) one per 4 tags queried, at most 6.
   */
  searchCost(input: { q?: unknown; category?: unknown }): number {
    const q = typeof input.q === 'string' ? input.q.trim() : '';
    const category = typeof input.category === 'string' ? input.category.trim() : '';
    if (q || !category) return 1;
    const tags = this.markets.categorySearchTagCount(category);
    return Math.min(Math.max(Math.ceil(tags / 4), 1), 6);
  }

  /**
   * Live search for the agent (spec §7.3 search_markets): Gamma search (cached 60 s like searchLive), then
   * filters (liquidity, end-date window, YES price range) and mandate flags on every hit: category listing,
   * horizon (`mandate.markets.resolves_within_days` / `long_horizon_days`), minimum liquidity, assessed
   * ambiguity above `max_ambiguity_score`. Flagged markets are returned (so the agent sees why) unless
   * `inMandateOnly`.
   */
  async searchForAgent(input: {
    q?: string;
    category?: string;
    active?: boolean;
    minVolume24hUsd?: number;
    endWithinDays?: [number, number];
    minPrice?: number;
    maxPrice?: number;
    inMandateOnly?: boolean;
    limit?: number;
  }): Promise<AgentSearchHit[]> {
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 25), 1), 100);
    const hits = await this.searchLive({ q: input.q ?? '', active: input.active !== false, category: input.category, limit: 100 });
    const mandate = this.extras.getMandate?.() ?? null;
    const limits = this.extras.getLimits?.() ?? null;
    const minLiq = Math.max(mandate?.markets.min_liquidity_usd ?? 0, limits?.per_market.min_liquidity_usd ?? 0);
    const now = this.now();
    const out: AgentSearchHit[] = [];
    for (const h of hits) {
      const end = h.endDate ? Date.parse(h.endDate) : NaN;
      const daysToEnd = Number.isNaN(end) ? null : (end - now) / DAY_MS;
      const yes = h.outcomePrices?.[0] !== undefined ? parseFloat(h.outcomePrices[0]) : NaN;
      if (input.minVolume24hUsd !== undefined && !((h.volume24hUsd ?? 0) >= input.minVolume24hUsd)) continue;
      if (input.endWithinDays && (daysToEnd === null || daysToEnd < input.endWithinDays[0] || daysToEnd > input.endWithinDays[1])) continue;
      if (input.minPrice !== undefined && !(yes >= input.minPrice)) continue;
      if (input.maxPrice !== undefined && !(yes <= input.maxPrice)) continue;
      const flags: string[] = [];
      const listing = mandate ? mandateListing(h.category, mandate) : 'unknown';
      if (!mandate) flags.push('mandate unavailable');
      else if (listing !== 'allow') flags.push(`category ${h.category} is ${listing} in the mandate`);
      if (daysToEnd === null) flags.push('end date unknown');
      else if (mandate) {
        const [s0, s1] = mandate.markets.resolves_within_days;
        const [l0, l1] = mandate.markets.long_horizon_days;
        const inHorizon = (daysToEnd >= s0 && daysToEnd <= s1) || (daysToEnd >= l0 && daysToEnd <= Math.min(l1, MAX_HORIZON_DAYS));
        if (!inHorizon) flags.push(`settles in ${daysToEnd.toFixed(1)} days (outside the mandate horizons)`);
      }
      if ((h.volume24hUsd ?? 0) < minLiq) flags.push(`24h volume ${h.volume24hUsd ?? 'unknown'} < ${minLiq}`);
      if (mandate && h.ambiguityScore !== null && h.ambiguityScore > mandate.markets.max_ambiguity_score) {
        flags.push(`ambiguity ${h.ambiguityScore} > mandate max ${mandate.markets.max_ambiguity_score}`);
      }
      if (input.inMandateOnly && flags.length > 0) continue;
      out.push({ ...h, mandate: listing, daysToEnd: daysToEnd === null ? null : Math.round(daysToEnd * 10) / 10, flags });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Full market detail for research (spec §7.3 get_market): the cached view (refreshed when stale) with rules
   * text, ambiguity and its source, the rules-hash history (from the audit log), fee rates, and the other
   * markets of the event (Gamma event endpoint, else the cache).
   */
  async detail(marketId: unknown) {
    if (typeof marketId !== 'string' || !marketId) throw invalidInput('marketId required');
    const market = await this.lookup('market lookup', () => this.markets.getMarket(marketId));
    if (!market) throw notFound(`Unknown market ${marketId}`);
    const rulesHistory = (this.extras.auditRepo?.list({ action: 'market.rules_changed', target: marketId, limit: 20 }) ?? []).map((r) => {
      let p: Record<string, unknown> = {};
      try {
        p = JSON.parse(r.payload ?? '{}') as Record<string, unknown>;
      } catch {
        /* keep empty */
      }
      return { at: r.ts, oldHash: p.oldHash ?? null, newHash: p.newHash ?? null };
    });
    const yes = market.tokens[0]?.tokenId;
    const fees = yes && this.extras.feeRatesFor ? this.extras.feeRatesFor(yes) : null;
    let related: Array<{ marketId: string; question: string; endDate: string | null; closed: boolean; outcomePrices: string[] | null; cached: boolean }> = [];
    let relatedSource: 'gamma' | 'cache' = 'cache';
    try {
      if (market.eventId && market.eventId !== market.marketId) {
        const ev = await fetchGammaEvent(this.extras.gammaUrl ?? GAMMA_API_URL, market.eventId, this.fetchFn);
        if (ev) {
          const parsed = ev.markets.map((m) => parseGammaMarketFull(m)).filter((m): m is NonNullable<typeof m> => !!m);
          // Event membership for the consistency checks (exclusive_sum / exhaustive, 5b)
          if (parsed.length > 0) this.markets.recordEventMarkets(market.eventId, parsed.map((m) => m.marketId));
          related = parsed
            .filter((m) => m.marketId !== market.marketId)
            .map((m) => ({ marketId: m.marketId, question: m.question, endDate: m.endDate, closed: m.closed, outcomePrices: m.outcomePrices, cached: !!this.markets.getCached(m.marketId) }));
          relatedSource = 'gamma';
        }
      }
    } catch {
      /* fall back to the cache */
    }
    if (relatedSource === 'cache') {
      related = this.markets
        .listCached()
        .filter((m) => m.eventId === market.eventId && m.marketId !== market.marketId)
        .map((m) => ({ marketId: m.marketId, question: m.question, endDate: m.endDate, closed: m.closed, outcomePrices: m.outcomePrices, cached: true }));
    }
    const mandate = this.extras.getMandate?.() ?? null;
    return {
      ...market,
      mandate: mandate ? mandateListing(market.category, mandate) : 'unknown',
      maxAmbiguityScore: mandate?.markets.max_ambiguity_score ?? null,
      rulesHistory,
      fees,
      related: related.slice(0, 50),
      relatedSource,
    };
  }

  /** CLOB order book, top `depth` levels (spec §7.3 get_orderbook) */
  async orderbook(tokenId: unknown, depth?: number) {
    const id = MarketService.tokenId(tokenId);
    const n = Math.min(Math.max(Math.floor(depth ?? 10), 1), 50);
    return this.lookup('order book', () => fetchOrderBook(this.clobUrl(), id, n, this.fetchFn));
  }

  /**
   * Price history (spec §7.3 get_price_history): Polymarket's prices-history series plus our recorded
   * order-book snapshots (mid / best bid / ask) over the same window. A failed Polymarket call is reported
   * in `polymarketError`, the snapshots are still returned.
   */
  async priceHistory(tokenId: unknown, opts: { interval?: PriceHistoryInterval; fidelityMinutes?: number; maxPoints?: number } = {}) {
    const id = MarketService.tokenId(tokenId);
    const interval = opts.interval ?? '1w';
    const fidelity = Math.min(Math.max(Math.floor(opts.fidelityMinutes ?? 60), 1), 1440);
    const maxPoints = Math.min(Math.max(Math.floor(opts.maxPoints ?? 500), 10), 2000);
    let polymarket: Array<{ t: number; p: number }> = [];
    let polymarketError: string | null = null;
    try {
      polymarket = await fetchPriceHistory(this.clobUrl(), id, { interval, fidelityMinutes: fidelity }, this.fetchFn);
    } catch (err) {
      polymarketError = publicLookupError(err, 'Polymarket price history');
    }
    const windowMs = { '1h': 3_600_000, '6h': 6 * 3_600_000, '1d': DAY_MS, '1w': 7 * DAY_MS, '1m': 30 * DAY_MS, max: 365 * DAY_MS }[interval];
    const now = this.now();
    const snaps = (this.extras.snapshotRepo?.range([id], now - windowMs, now) ?? []).map((s) => ({ t: s.ts, mid: s.mid, bestBid: s.bestBid, bestAsk: s.bestAsk }));
    const thin = <T>(xs: T[]): T[] => (xs.length <= maxPoints ? xs : xs.filter((_, i) => i % Math.ceil(xs.length / maxPoints) === 0));
    return {
      tokenId: id,
      interval,
      fidelityMinutes: fidelity,
      polymarket: thin(polymarket).map((x) => ({ at: new Date(x.t).toISOString(), p: x.p })),
      polymarketError,
      snapshots: thin(snaps).map((x) => ({ at: new Date(x.t).toISOString(), mid: x.mid, bestBid: x.bestBid, bestAsk: x.bestAsk })),
    };
  }

  /**
   * Polymarket leaderboard and optionally one wallet's recent activity (spec §7.3 get_leaderboard, for
   * copy-trading leader proposals). Endpoint shapes: VERIFY (ledger/polymarketPublic.ts).
   */
  async leaderboard(opts: { period?: LeaderboardPeriod; orderBy?: LeaderboardOrder; limit?: number; wallet?: string; activityLimit?: number } = {}) {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 25), 1), 100);
    if (opts.wallet !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(opts.wallet)) throw invalidInput('wallet must be a 0x address');
    const leaders = await this.lookup('Polymarket leaderboard', () => fetchLeaderboard({ period: opts.period ?? 'WEEK', orderBy: opts.orderBy ?? 'PNL', limit }, this.fetchFn));
    const activity = opts.wallet
      ? await this.lookup('Polymarket activity', () => fetchWalletActivity(opts.wallet!, Math.min(Math.max(Math.floor(opts.activityLimit ?? 50), 1), 200), this.fetchFn))
      : null;
    return { period: opts.period ?? 'WEEK', orderBy: opts.orderBy ?? 'PNL', leaders, wallet: opts.wallet ?? null, activity };
  }

  /**
   * The agent's ambiguity assessment of a market without a forecast (MCP assess_market, R136): can set a
   * first score or raise it, never lower it and never override a human assessment.
   */
  async assess(marketId: unknown, score: unknown, rationale: unknown, by: Actor): Promise<{ changed: boolean; result: string; market: MarketView }> {
    const who = requireActor(by, ['agent'], 'markets.assess');
    if (typeof marketId !== 'string' || !marketId) throw invalidInput('marketId required');
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 3) throw invalidInput('score must be an integer 0-3');
    const why = typeof rationale === 'string' ? rationale.trim() : '';
    if (!why) throw invalidInput('rationale is required');
    try {
      return await this.markets.recordAgentAmbiguity(marketId, score, auditActorOf(who), why);
    } catch (err) {
      if (err instanceof Error && /^Unknown market/.test(err.message)) throw notFound(err.message);
      throw new ServiceError('unavailable', publicLookupError(err, 'market lookup'));
    }
  }

  /** Ambiguity 0–3 (buys need an assessed market, R51). Human only (agents assess through forecasts or assess()). */
  async setAmbiguity(marketId: string, score: number, actor: HumanActor, note?: string | null) {
    return this.markets.setAmbiguity(marketId, score, actor, note ?? null);
  }
}
