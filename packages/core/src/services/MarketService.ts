/**
 * MarketService — cached market view and human ambiguity assessment (spec §6, §7.4), over
 * MarketCacheService. Forecasts and category rights are served by LedgerService directly
 * (`core.services.ledger`), whose methods already take plain inputs and an actor.
 */

import type { MarketCacheService } from '../ledger/MarketCacheService';
import type { HumanActor } from './actors';
import { invalidInput } from './errors';

export class MarketService {
  constructor(private markets: MarketCacheService) {}

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

  /** Ambiguity 0–3 (buys need an assessed market, R51). Human only (agents assess through forecasts). */
  async setAmbiguity(marketId: string, score: number, actor: HumanActor, note?: string | null) {
    return this.markets.setAmbiguity(marketId, score, actor, note ?? null);
  }
}
