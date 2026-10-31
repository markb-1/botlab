import type Database from 'better-sqlite3';
import type { HorizonBucket } from '../../risk/types';

export type ForecastStatus = 'active' | 'superseded' | 'withdrawn' | 'resolved' | 'void';

export interface ForecastRow {
  id: string;
  market_id: string;
  token_id: string;
  event_id: string;
  category: string;
  probability: number;
  market_price_at_forecast: number;
  best_bid: number | null;
  best_ask: number | null;
  liquidity_usd: number | null;
  rationale: string;
  /** JSON string[] */
  sources: string;
  ambiguity_score: number;
  status: ForecastStatus;
  superseded_by: string | null;
  tradeable: number;
  days_to_resolution_at_forecast: number;
  horizon_bucket: HorizonBucket;
  price_at_7d: number | null;
  price_at_7d_at: string | null;
  convergence: number | null;
  created_by: string;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
  created_at: string;
  resolved_at: string | null;
  outcome: number | null;
  brier_agent: number | null;
  brier_market: number | null;
  skill: number | null;
}

export interface ForecastInsert {
  id: string;
  marketId: string;
  tokenId: string;
  eventId: string;
  category: string;
  probability: number;
  marketPriceAtForecast: number;
  bestBid: number | null;
  bestAsk: number | null;
  liquidityUsd: number | null;
  rationale: string;
  sources: string[];
  ambiguityScore: number;
  tradeable: boolean;
  daysToResolution: number;
  horizonBucket: HorizonBucket;
  createdBy: string;
  createdAt: string;
}

export interface ForecastFilter {
  status?: ForecastStatus | ForecastStatus[];
  category?: string;
  horizonBucket?: HorizonBucket;
  marketId?: string;
  tokenId?: string;
  tradeableOnly?: boolean;
  limit?: number;
}

const OPEN_ORDER_SQL = "('submitted','open','partially_filled')";

/** forecasts (spec §2.2, §6). Rows are never deleted. */
export class ForecastRepository {
  constructor(private db: Database.Database) {}

  findById(id: string): ForecastRow | undefined {
    return this.db.prepare('SELECT * FROM forecasts WHERE id = ?').get(id) as ForecastRow | undefined;
  }

  findActiveByToken(tokenId: string): ForecastRow | undefined {
    return this.db.prepare("SELECT * FROM forecasts WHERE token_id = ? AND status = 'active'").get(tokenId) as ForecastRow | undefined;
  }

  list(filter: ForecastFilter = {}): ForecastRow[] {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      values.push(...statuses);
    }
    if (filter.category) { where.push('category = ?'); values.push(filter.category); }
    if (filter.horizonBucket) { where.push('horizon_bucket = ?'); values.push(filter.horizonBucket); }
    if (filter.marketId) { where.push('market_id = ?'); values.push(filter.marketId); }
    if (filter.tokenId) { where.push('token_id = ?'); values.push(filter.tokenId); }
    if (filter.tradeableOnly) where.push('tradeable = 1');
    const limit = filter.limit && filter.limit > 0 ? Math.min(Math.floor(filter.limit), 10_000) : 1000;
    return this.db
      .prepare(`SELECT * FROM forecasts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${limit}`)
      .all(...values) as ForecastRow[];
  }

  /** Insert a new active forecast, superseding the token's current one (one transaction). */
  insertSuperseding(f: ForecastInsert): { supersededId: string | null } {
    return this.db.transaction(() => {
      const prev = this.findActiveByToken(f.tokenId);
      if (prev) this.db.prepare("UPDATE forecasts SET status = 'superseded' WHERE id = ?").run(prev.id);
      this.db
        .prepare(
          `INSERT INTO forecasts (id, market_id, token_id, event_id, category, probability, market_price_at_forecast, best_bid,
             best_ask, liquidity_usd, rationale, sources, ambiguity_score, status, tradeable, days_to_resolution_at_forecast,
             horizon_bucket, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
        )
        .run(
          f.id, f.marketId, f.tokenId, f.eventId, f.category, f.probability, f.marketPriceAtForecast, f.bestBid,
          f.bestAsk, f.liquidityUsd, f.rationale, JSON.stringify(f.sources), f.ambiguityScore, f.tradeable ? 1 : 0,
          f.daysToResolution, f.horizonBucket, f.createdBy, f.createdAt
        );
      if (prev) this.db.prepare('UPDATE forecasts SET superseded_by = ? WHERE id = ?').run(f.id, prev.id);
      return { supersededId: prev?.id ?? null };
    })();
  }

  withdraw(id: string, reason: string, at: string): boolean {
    const r = this.db
      .prepare("UPDATE forecasts SET status = 'withdrawn', withdrawn_at = ?, withdrawn_reason = ? WHERE id = ? AND status = 'active'")
      .run(at, reason, id);
    return r.changes > 0;
  }

  /** Markets with forecasts that are not scored yet (outcome unknown, not void). */
  unresolvedMarketIds(): string[] {
    return (this.db
      .prepare("SELECT DISTINCT market_id FROM forecasts WHERE outcome IS NULL AND status <> 'void'")
      .all() as Array<{ market_id: string }>).map((r) => r.market_id);
  }

  activeMarketIds(): string[] {
    return (this.db.prepare("SELECT DISTINCT market_id FROM forecasts WHERE status = 'active'").all() as Array<{ market_id: string }>).map(
      (r) => r.market_id
    );
  }

  unscoredForMarket(marketId: string): ForecastRow[] {
    return this.db
      .prepare("SELECT * FROM forecasts WHERE market_id = ? AND outcome IS NULL AND status <> 'void'")
      .all(marketId) as ForecastRow[];
  }

  /** Score one forecast. `active` becomes `resolved`; superseded/withdrawn keep their status (they are still scored). */
  setScore(id: string, s: { outcome: 0 | 1; brierAgent: number; brierMarket: number; skill: number; resolvedAt: string }): void {
    this.db
      .prepare(
        `UPDATE forecasts SET outcome = ?, brier_agent = ?, brier_market = ?, skill = ?, resolved_at = ?,
           status = CASE WHEN status = 'active' THEN 'resolved' ELSE status END
         WHERE id = ?`
      )
      .run(s.outcome, s.brierAgent, s.brierMarket, s.skill, s.resolvedAt, id);
  }

  setVoid(id: string, resolvedAt: string): void {
    this.db.prepare("UPDATE forecasts SET status = 'void', resolved_at = ? WHERE id = ?").run(resolvedAt, id);
  }

  /** Unresolved forecasts without a convergence price yet (resolved ones get it from the outcome when scored). */
  needingConvergence(): ForecastRow[] {
    return this.db
      .prepare("SELECT * FROM forecasts WHERE price_at_7d IS NULL AND outcome IS NULL AND status <> 'void'")
      .all() as ForecastRow[];
  }

  setConvergence(id: string, priceAt7d: number, at: string, convergence: number): void {
    this.db
      .prepare('UPDATE forecasts SET price_at_7d = ?, price_at_7d_at = ?, convergence = ? WHERE id = ? AND price_at_7d IS NULL')
      .run(priceAt7d, at, convergence, id);
  }

  /** Every scored (non-void) forecast and every forecast with a convergence value, for category stats. */
  forStats(): ForecastRow[] {
    return this.db
      .prepare("SELECT * FROM forecasts WHERE status <> 'void' AND (outcome IS NOT NULL OR convergence IS NOT NULL)")
      .all() as ForecastRow[];
  }

  /** Every (category, bucket) that has forecasts. */
  buckets(): Array<{ category: string; horizon_bucket: HorizonBucket }> {
    return this.db.prepare('SELECT DISTINCT category, horizon_bucket FROM forecasts').all() as Array<{ category: string; horizon_bucket: HorizonBucket }>;
  }

  /**
   * Ledger-driven buy orders in a (category, bucket): buys with a forecast in that bucket that filled
   * something or are still open. Used for the bucket's exposure.
   */
  ledgerBuyOrders(category: string, bucket: HorizonBucket, simulated: boolean): Array<{ id: string; bot_id: string; token_id: string; filled_size: number; status: string }> {
    return this.db
      .prepare(
        `SELECT o.id, o.bot_id, o.token_id, o.filled_size, o.status FROM orders o
         JOIN forecasts f ON f.id = o.forecast_id
         WHERE o.side = 'buy' AND o.simulated = ? AND f.category = ? AND f.horizon_bucket = ?
           AND (o.filled_size > 0 OR o.status IN ${OPEN_ORDER_SQL})`
      )
      .all(simulated ? 1 : 0, category, bucket) as Array<{ id: string; bot_id: string; token_id: string; filled_size: number; status: string }>;
  }
}
