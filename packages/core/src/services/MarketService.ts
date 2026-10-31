/**
 * MarketService — cached market view and human ambiguity assessment (spec §6, §7.4), over
 * MarketCacheService. Forecasts and category rights are served by LedgerService directly
 * (`core.services.ledger`), whose methods already take plain inputs and an actor.
 */

import type { MarketCacheService } from '../ledger/MarketCacheService';
import type { AuditActor } from '../audit/AuditService';
import { invalidInput } from './errors';

export class MarketService {
  constructor(private markets: MarketCacheService) {}

  async get(marketId: unknown) {
    if (typeof marketId !== 'string' || !marketId) throw invalidInput('marketId required');
    return this.markets.getMarket(marketId);
  }

  /** Ambiguity 0–3 (buys need an assessed market, R51) */
  async setAmbiguity(marketId: string, score: number, actor: AuditActor, note?: string | null) {
    return this.markets.setAmbiguity(marketId, score, actor, note ?? null);
  }
}
