/**
 * MarketService — cached market view and human ambiguity assessment (spec §6, §7.4), over
 * MarketCacheService. Forecasts and category rights are served by LedgerService directly
 * (`core.services.ledger`), whose methods already take plain inputs and an actor.
 */

import { GammaHttpError, type GammaSearchHit, type MarketCacheService } from '../ledger/MarketCacheService';
import type { HumanActor } from './actors';
import { invalidInput, ServiceError } from './errors';
import { publicLookupError } from './redact';

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

  constructor(
    private markets: MarketCacheService,
    private now: () => number = Date.now
  ) {}

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

  /** Live Polymarket search via Gamma (text, open markets only by default, BotLab category filter) */
  async searchLive(input: { q?: unknown; active?: unknown; category?: unknown; limit?: unknown }) {
    const q = typeof input.q === 'string' ? input.q : '';
    const category = typeof input.category === 'string' && input.category.trim() ? input.category.trim() : undefined;
    const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : 50;
    const opts = { q: q.trim().toLowerCase(), active: input.active !== false, ...(category ? { category } : {}), limit };
    const key = JSON.stringify(opts);
    const now = this.now();
    const hit = this.searchCache.get(key);
    if (hit && now - hit.at < SEARCH_CACHE_MS) return hit.hits;
    if (now < this.searchBlockedUntil) {
      throw new ServiceError('unavailable', `Polymarket search is rate-limited; try again in ${Math.ceil((this.searchBlockedUntil - now) / 1000)} s`);
    }
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
    }
  }

  /** Ambiguity 0–3 (buys need an assessed market, R51). Human only (agents assess through forecasts). */
  async setAmbiguity(marketId: string, score: number, actor: HumanActor, note?: string | null) {
    return this.markets.setAmbiguity(marketId, score, actor, note ?? null);
  }
}
