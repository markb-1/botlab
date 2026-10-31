import type Database from 'better-sqlite3';

export interface MarketToken {
  tokenId: string;
  outcome: string;
}

export interface MarketCacheRow {
  market_id: string;
  event_id: string | null;
  event_title: string | null;
  slug: string | null;
  question: string;
  category: string;
  /** JSON string[] of tag slugs */
  tags: string;
  rules_text: string | null;
  rules_hash: string | null;
  rules_changed_at: string | null;
  end_date: string | null;
  resolution_source: string | null;
  neg_risk: number;
  /** JSON MarketToken[] */
  tokens: string;
  fee_category: string | null;
  liquidity_usd: number | null;
  volume_24h_usd: number | null;
  active: number;
  closed: number;
  /** JSON string[] (Gamma outcomePrices, same order as tokens) */
  outcome_prices: string | null;
  uma_resolution_status: string | null;
  disputed: number;
  /** Assessed ambiguity 0–3 (agent forecast or human); null = not assessed */
  market_ambiguity: number | null;
  ambiguity_source: string | null;
  ambiguity_note: string | null;
  ambiguity_at: string | null;
  created_at: string;
  updated_at: string;
  /** First time the scorer saw the current final resolution (see LedgerService) */
  resolution_seen_at: string | null;
  /** JSON of the resolution seen then (to detect a change) */
  resolution_seen: string | null;
}

/** Fields written by a Gamma refresh (ambiguity is never touched by a refresh). */
export interface MarketCacheUpsert {
  marketId: string;
  eventId: string | null;
  eventTitle: string | null;
  slug: string | null;
  question: string;
  category: string;
  tags: string[];
  rulesText: string | null;
  rulesHash: string | null;
  rulesChangedAt: string | null;
  endDate: string | null;
  resolutionSource: string | null;
  negRisk: boolean;
  tokens: MarketToken[];
  feeCategory: string | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  active: boolean;
  closed: boolean;
  outcomePrices: string[] | null;
  umaResolutionStatus: string | null;
  disputed: boolean;
  updatedAt: string;
}

export function parseTokens(row: Pick<MarketCacheRow, 'tokens'>): MarketToken[] {
  try {
    const v = JSON.parse(row.tokens) as unknown;
    return Array.isArray(v)
      ? v.filter((t): t is MarketToken => !!t && typeof (t as MarketToken).tokenId === 'string').map((t) => ({ tokenId: t.tokenId, outcome: String(t.outcome ?? '') }))
      : [];
  } catch {
    return [];
  }
}

/** market_cache (spec §2.2): Polymarket market metadata, refreshed from Gamma. */
export class MarketCacheRepository {
  constructor(private db: Database.Database) {}

  get(marketId: string): MarketCacheRow | undefined {
    return this.db.prepare('SELECT * FROM market_cache WHERE market_id = ?').get(marketId) as MarketCacheRow | undefined;
  }

  findByToken(tokenId: string): MarketCacheRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM market_cache
         WHERE EXISTS (SELECT 1 FROM json_each(market_cache.tokens) WHERE json_extract(value, '$.tokenId') = ?)`
      )
      .get(tokenId) as MarketCacheRow | undefined;
  }

  all(): MarketCacheRow[] {
    return this.db.prepare('SELECT * FROM market_cache ORDER BY updated_at DESC').all() as MarketCacheRow[];
  }

  upsert(m: MarketCacheUpsert): void {
    this.db
      .prepare(
        `INSERT INTO market_cache (market_id, event_id, event_title, slug, question, category, tags, rules_text, rules_hash,
           rules_changed_at, end_date, resolution_source, neg_risk, tokens, fee_category, liquidity_usd, volume_24h_usd,
           active, closed, outcome_prices, uma_resolution_status, disputed, created_at, updated_at)
         VALUES (@marketId, @eventId, @eventTitle, @slug, @question, @category, @tags, @rulesText, @rulesHash,
           @rulesChangedAt, @endDate, @resolutionSource, @negRisk, @tokens, @feeCategory, @liquidityUsd, @volume24hUsd,
           @active, @closed, @outcomePrices, @umaResolutionStatus, @disputed, @updatedAt, @updatedAt)
         ON CONFLICT(market_id) DO UPDATE SET
           event_id = excluded.event_id, event_title = excluded.event_title, slug = excluded.slug,
           question = excluded.question, category = excluded.category, tags = excluded.tags,
           rules_text = excluded.rules_text, rules_hash = excluded.rules_hash, rules_changed_at = excluded.rules_changed_at,
           end_date = excluded.end_date, resolution_source = excluded.resolution_source, neg_risk = excluded.neg_risk,
           tokens = excluded.tokens, fee_category = excluded.fee_category, liquidity_usd = excluded.liquidity_usd,
           volume_24h_usd = excluded.volume_24h_usd, active = excluded.active, closed = excluded.closed,
           outcome_prices = excluded.outcome_prices, uma_resolution_status = excluded.uma_resolution_status,
           disputed = excluded.disputed, updated_at = excluded.updated_at`
      )
      .run({
        ...m,
        tags: JSON.stringify(m.tags),
        negRisk: m.negRisk ? 1 : 0,
        tokens: JSON.stringify(m.tokens),
        active: m.active ? 1 : 0,
        closed: m.closed ? 1 : 0,
        outcomePrices: m.outcomePrices ? JSON.stringify(m.outcomePrices) : null,
        disputed: m.disputed ? 1 : 0,
      });
  }

  /** Re-categorize (categories.yaml changed) without touching anything else. */
  setCategory(marketId: string, category: string): void {
    this.db.prepare('UPDATE market_cache SET category = ? WHERE market_id = ?').run(category, marketId);
  }

  setResolutionSeen(marketId: string, signature: string | null, at: string | null): void {
    this.db.prepare('UPDATE market_cache SET resolution_seen = ?, resolution_seen_at = ? WHERE market_id = ?').run(signature, at, marketId);
  }

  setAmbiguity(marketId: string, score: number, source: string, note: string | null, at: string): void {
    this.db
      .prepare('UPDATE market_cache SET market_ambiguity = ?, ambiguity_source = ?, ambiguity_note = ?, ambiguity_at = ? WHERE market_id = ?')
      .run(score, source, note, at, marketId);
  }
}
