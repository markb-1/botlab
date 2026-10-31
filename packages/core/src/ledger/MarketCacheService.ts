/**
 * MarketCacheService — Polymarket market metadata in `market_cache` (spec §2.2, §7.4).
 *
 * - Refreshes markets from the Gamma API (`/markets?condition_ids=…` or `?clob_token_ids=…`):
 *   question, slug, event, BotLab category (`categorize` with config/categories.yaml), tags, rules
 *   text (description + resolution source), end date, neg_risk, tokens, fee category, liquidity /
 *   volume, closed/outcome prices and UMA status (for the scorer).
 * - `rules_hash` = sha256 of the normalised rules text. A change sets `rules_changed_at`, is audited
 *   (`market.rules_changed`, with the bots holding a live position — Telegram alerts on those) and
 *   emitted as `market:rulesChanged`.
 * - Refresh on demand with a 10-minute TTL (order path, forecasts) and every 30 minutes for markets
 *   that are held, have open orders or active forecasts.
 * - Ambiguity: the assessed score is stored here with its source. A human assessment always wins
 *   until a human changes it; a forecast may only raise a forecast-sourced score. The effective score
 *   adds the server raise (≥ 2 within 7 days of a rules change or on a UMA dispute). Not assessed, or
 *   the row not refreshed for 2 h ⇒ null ⇒ the risk engine rejects buys.
 *
 * Gamma failures never throw into the order path: the cached row (if any) is used and buys of an
 * unassessed / unknown market stay rejected.
 */

import { EventEmitter } from 'events';
import { auditActorOf, humanDenial, isHumanActor, type HumanActor } from '../services/actors';
import type { AuditActor, AuditService } from '../audit/AuditService';
import type { CategoriesConfig } from '../config/categoriesSchema';
import type { MarketCacheRepository, MarketCacheRow, MarketCacheUpsert, MarketToken } from '../db/repositories/MarketCacheRepository';
import { parseTokens } from '../db/repositories/MarketCacheRepository';
import { slugify } from '../orders/FeeService';
import { parseMarketFeeSchedule, parseStoredFeeSchedule, type MarketFeeSchedule } from '../orders/feeModel';
import { GAMMA_API_URL, type MarketInfo, type MarketQuality, type MarketQualityProvider } from '../orders/MarketDataService';
import { autoRaiseReason, effectiveAmbiguity, rulesHash } from './ambiguity';
import { categorize } from './categorize';
import logger from '../utils/logger';

export const MARKET_RULES_CHANGED_EVENT = 'market:rulesChanged';
export const MARKET_CACHE_TTL_MS = 10 * 60_000;
export const MARKET_REFRESH_INTERVAL_MS = 30 * 60_000;
/** Order path: a row not refreshed for this long is too stale to buy on (ambiguity treated as unknown) */
export const MARKET_STALE_FOR_BUYS_MS = 2 * 3_600_000;
const FETCH_TIMEOUT_MS = 10_000;
/** On-demand refresh inside the order path waits at most this long */
const ORDER_PATH_REFRESH_TIMEOUT_MS = 5_000;
const BATCH_SIZE = 20;

export interface RulesChangedEvent {
  marketId: string;
  question: string;
  oldHash: string;
  newHash: string;
  changedAt: string;
  /** Bots holding a live position in the market */
  heldBy: string[];
}

/** Market as the ledger / UI / bots see it. */
export interface MarketView {
  marketId: string;
  eventId: string;
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
  /** The market's own Gamma fee schedule; null ⇒ the category fee table applies */
  feeSchedule: MarketFeeSchedule | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  active: boolean;
  closed: boolean;
  outcomePrices: string[] | null;
  umaResolutionStatus: string | null;
  disputed: boolean;
  /** Assessed score (agent forecast or human); null = not assessed */
  assessedAmbiguity: number | null;
  ambiguitySource: string | null;
  ambiguityNote: string | null;
  /** Assessed score after the server raise; null = not assessed */
  ambiguityScore: number | null;
  ambiguityRaisedBecause: string | null;
  /** First time the scorer saw the current final resolution, and what it was (JSON) */
  resolutionSeenAt: string | null;
  resolutionSeen: string | null;
  updatedAt: string;
}

export interface MarketCacheDeps {
  repo: MarketCacheRepository;
  getCategories: () => CategoriesConfig;
  /** Fee category from Gamma labels (FeeService.feeCategoryFor) */
  feeCategoryFor?: (labels: string[]) => string | null;
  audit?: Pick<AuditService, 'record'>;
  /** Bots holding a live position in a market (rules-change alert) */
  heldBy?: (marketId: string) => string[];
  /** Markets the periodic job refreshes: held, with open orders, with active forecasts */
  watchedMarketIds?: () => string[];
  fetchFn?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
  ttlMs?: number;
}

// ─── Gamma parsing ────────────────────────────────────────────────────

function parseNum(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseList(v: unknown): string[] | null {
  try {
    const arr = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(arr) ? arr.map(String) : null;
  } catch {
    return null;
  }
}

function tagSlugs(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (!t || typeof t !== 'object') continue;
    const { slug, label } = t as { slug?: unknown; label?: unknown };
    if (typeof slug === 'string' && slug) out.push(slugify(slug));
    if (typeof label === 'string' && label) out.push(slugify(label));
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export interface ParsedGammaMarket {
  marketId: string;
  eventId: string | null;
  eventTitle: string | null;
  slug: string | null;
  question: string;
  tags: string[];
  /** null when the response carries no description (rules unknown: keep the previous ones) */
  rulesText: string | null;
  endDate: string | null;
  resolutionSource: string | null;
  negRisk: boolean;
  tokens: MarketToken[];
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  active: boolean;
  closed: boolean;
  outcomePrices: string[] | null;
  umaResolutionStatus: string | null;
  disputed: boolean;
  feeSchedule: MarketFeeSchedule | null;
}

/**
 * One Gamma `/markets` entry. UMA dispute: `umaResolutionStatus` or the `umaResolutionStatuses`
 * history mentioning "disput" (field names VERIFY against live data, PROGRESS Decision R52).
 */
export function parseGammaMarketFull(raw: unknown): ParsedGammaMarket | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const marketId = str(m.conditionId);
  if (!marketId) return null;

  const tokenIds = parseList(m.clobTokenIds) ?? [];
  const outcomes = parseList(m.outcomes) ?? [];
  const events = Array.isArray(m.events) ? (m.events.filter((e) => e && typeof e === 'object') as Array<Record<string, unknown>>) : [];
  const event = events[0] ?? null;

  const tags = [...tagSlugs(m.tags)];
  if (typeof m.category === 'string' && m.category) tags.push(slugify(m.category));
  for (const e of events) {
    tags.push(...tagSlugs(e.tags));
    if (typeof e.category === 'string' && e.category) tags.push(slugify(e.category));
  }

  const description = typeof m.description === 'string' ? m.description : null;
  const resolutionSource = str(m.resolutionSource);
  const rulesText = description === null ? null : [description.trim(), resolutionSource ? `Resolution source: ${resolutionSource}` : ''].filter(Boolean).join('\n\n');

  const umaStatus = str(m.umaResolutionStatus);
  const umaHistory = parseList(m.umaResolutionStatuses) ?? [];
  const disputed = [umaStatus ?? '', ...umaHistory].some((s) => /disput/i.test(s));

  const endDate = str(m.endDate) ?? str(m.endDateIso);
  const eventId = event ? (str(event.id) ?? (typeof event.id === 'number' ? String(event.id) : null)) : null;

  return {
    marketId,
    eventId,
    eventTitle: event ? str(event.title) : null,
    slug: str(m.slug),
    question: typeof m.question === 'string' ? m.question : '',
    tags: [...new Set(tags.filter((t) => t.length > 0))],
    rulesText,
    endDate: endDate && !Number.isNaN(Date.parse(endDate)) ? endDate : null,
    resolutionSource,
    negRisk: m.negRisk === true,
    tokens: tokenIds.map((tokenId, i) => ({ tokenId, outcome: outcomes[i] ?? '' })),
    liquidityUsd: parseNum(m.liquidityNum) ?? parseNum(m.liquidity),
    volume24hUsd: parseNum(m.volume24hr) ?? parseNum(m.volume24hrClob),
    active: m.active !== false,
    closed: m.closed === true,
    outcomePrices: parseList(m.outcomePrices),
    umaResolutionStatus: umaStatus,
    disputed,
    feeSchedule: parseMarketFeeSchedule(m),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function parseJsonArray(text: string | null): string[] | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

export function toMarketView(row: MarketCacheRow, now: number): MarketView {
  const disputed = row.disputed === 1;
  return {
    marketId: row.market_id,
    eventId: row.event_id ?? row.market_id,
    eventTitle: row.event_title,
    slug: row.slug,
    question: row.question,
    category: row.category,
    tags: parseJsonArray(row.tags) ?? [],
    rulesText: row.rules_text,
    rulesHash: row.rules_hash,
    rulesChangedAt: row.rules_changed_at,
    endDate: row.end_date,
    resolutionSource: row.resolution_source,
    negRisk: row.neg_risk === 1,
    tokens: parseTokens(row),
    feeCategory: row.fee_category,
    feeSchedule: parseStoredFeeSchedule(row.fee_schedule),
    liquidityUsd: row.liquidity_usd,
    volume24hUsd: row.volume_24h_usd,
    active: row.active === 1,
    closed: row.closed === 1,
    outcomePrices: parseJsonArray(row.outcome_prices),
    umaResolutionStatus: row.uma_resolution_status,
    disputed,
    assessedAmbiguity: row.market_ambiguity,
    ambiguitySource: row.ambiguity_source,
    ambiguityNote: row.ambiguity_note,
    ambiguityScore: effectiveAmbiguity({ assessed: row.market_ambiguity, rulesChangedAt: row.rules_changed_at, disputed }, now),
    ambiguityRaisedBecause: autoRaiseReason({ rulesChangedAt: row.rules_changed_at, disputed }, now),
    resolutionSeenAt: row.resolution_seen_at ?? null,
    resolutionSeen: row.resolution_seen ?? null,
    updatedAt: row.updated_at,
  };
}

// ─── Service ─────────────────────────────────────────────────────────

export class MarketCacheService extends EventEmitter implements MarketQualityProvider {
  private deps: MarketCacheDeps;
  private fetchFn: typeof fetch;
  private baseUrl: string;
  private now: () => number;
  private ttlMs: number;
  private inflight = new Map<string, Promise<MarketView | null>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private periodic: Promise<void> | null = null;

  constructor(deps: MarketCacheDeps) {
    super();
    this.deps = deps;
    this.fetchFn = deps.fetchFn ?? ((...args) => globalThis.fetch(...args));
    this.baseUrl = deps.baseUrl ?? GAMMA_API_URL;
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? MARKET_CACHE_TTL_MS;
  }

  // ── Reading ──────────────────────────────────────────────────────

  getCached(marketId: string): MarketView | null {
    const row = this.deps.repo.get(marketId);
    return row ? toMarketView(row, this.now()) : null;
  }

  getCachedByToken(tokenId: string): MarketView | null {
    const row = this.deps.repo.findByToken(tokenId);
    return row ? toMarketView(row, this.now()) : null;
  }

  listCached(): MarketView[] {
    const now = this.now();
    return this.deps.repo.all().map((r) => toMarketView(r, now));
  }

  private isFresh(row: MarketCacheRow | undefined): row is MarketCacheRow {
    if (!row) return false;
    const at = Date.parse(row.updated_at);
    return !Number.isNaN(at) && this.now() - at < this.ttlMs;
  }

  /** Cached market, refreshed from Gamma when older than the TTL. Throws when Gamma fails and nothing is cached. */
  async getMarket(marketId: string, opts: { maxAgeMs?: number } = {}): Promise<MarketView | null> {
    const row = this.deps.repo.get(marketId);
    const maxAge = opts.maxAgeMs ?? this.ttlMs;
    const at = row ? Date.parse(row.updated_at) : NaN;
    if (row && !Number.isNaN(at) && this.now() - at < maxAge) return toMarketView(row, this.now());
    return this.refresh(marketId);
  }

  /** Market for a token, refreshed when stale (looked up by token when not cached). */
  async getMarketByToken(tokenId: string, opts: { maxAgeMs?: number } = {}): Promise<MarketView | null> {
    const row = this.deps.repo.findByToken(tokenId);
    if (row) return this.getMarket(row.market_id, opts);
    return this.refreshByToken(tokenId);
  }

  /**
   * MarketQualityProvider for OrderService: category, effective ambiguity and rules change.
   * A stale row is refreshed (bounded wait); on failure the cached row is used. No row ⇒ category from
   * the order's Gamma labels and ambiguity null (buys rejected).
   */
  async get(info: MarketInfo): Promise<MarketQuality> {
    let row = this.deps.repo.get(info.marketId);
    if (!this.isFresh(row)) {
      try {
        await withTimeout(this.refresh(info.marketId), ORDER_PATH_REFRESH_TIMEOUT_MS, 'market cache refresh');
      } catch (err) {
        logger.warning(`[MarketCache] Refresh of ${info.marketId} failed (using cached data): ${err instanceof Error ? err.message : err}`);
      }
      row = this.deps.repo.get(info.marketId);
    }
    if (!row) {
      return {
        category: categorize({ question: info.question, tags: info.labels }, this.deps.getCategories()).category,
        ambiguityScore: null,
        rulesChangedAt: null,
      };
    }
    const view = toMarketView(row, this.now());
    // Refresh failed (or Gamma no longer returns the market) for too long: rules and disputes are unknown,
    // so the ambiguity is treated as unknown ⇒ buys rejected; sells do not depend on it
    const age = this.now() - Date.parse(row.updated_at);
    if (!(age < MARKET_STALE_FOR_BUYS_MS)) {
      return { category: view.category, ambiguityScore: null, rulesChangedAt: view.rulesChangedAt };
    }
    return { category: view.category, ambiguityScore: view.ambiguityScore, rulesChangedAt: view.rulesChangedAt };
  }

  // ── Refreshing ───────────────────────────────────────────────────

  private async gammaMarkets(query: string): Promise<unknown[]> {
    const resp = await this.fetchFn(`${this.baseUrl}/markets?${query}&include_tag=true`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`Gamma HTTP ${resp.status}`);
    const body = (await resp.json()) as unknown;
    if (!Array.isArray(body)) throw new Error('Gamma: unexpected response');
    return body;
  }

  /** Re-fetch one market (single flight per market). null when Gamma does not know it. Throws on network/HTTP errors. */
  refresh(marketId: string): Promise<MarketView | null> {
    const key = `m:${marketId}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      const list = await this.gammaMarkets(`condition_ids=${encodeURIComponent(marketId)}`);
      for (const raw of list) {
        const parsed = parseGammaMarketFull(raw);
        if (parsed && parsed.marketId === marketId) return this.apply(parsed);
      }
      return null;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  refreshByToken(tokenId: string): Promise<MarketView | null> {
    const key = `t:${tokenId}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      const list = await this.gammaMarkets(`clob_token_ids=${encodeURIComponent(tokenId)}`);
      for (const raw of list) {
        const parsed = parseGammaMarketFull(raw);
        if (parsed && parsed.tokens.some((t) => t.tokenId === tokenId)) return this.apply(parsed);
      }
      return null;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Refresh many markets in batches; failures are logged and counted, never thrown. */
  async refreshMany(marketIds: string[]): Promise<{ refreshed: number; failed: number }> {
    const ids = [...new Set(marketIds.filter((id) => typeof id === 'string' && id.length > 0))];
    let refreshed = 0;
    let failed = 0;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      try {
        const list = await this.gammaMarkets(batch.map((id) => `condition_ids=${encodeURIComponent(id)}`).join('&'));
        const seen = new Set<string>();
        for (const raw of list) {
          const parsed = parseGammaMarketFull(raw);
          if (!parsed || !batch.includes(parsed.marketId) || seen.has(parsed.marketId)) continue;
          seen.add(parsed.marketId);
          this.apply(parsed);
          refreshed++;
        }
        failed += batch.length - seen.size;
      } catch (err) {
        failed += batch.length;
        logger.warning(`[MarketCache] Batch refresh failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { refreshed, failed };
  }

  /** Store a parsed Gamma market; detects rules changes and new disputes. */
  apply(parsed: ParsedGammaMarket): MarketView {
    const nowIso = new Date(this.now()).toISOString();
    const prev = this.deps.repo.get(parsed.marketId);
    const rulesText = parsed.rulesText ?? prev?.rules_text ?? null;
    const newHash = parsed.rulesText !== null ? rulesHash(parsed.rulesText) : (prev?.rules_hash ?? null);
    const rulesChanged = !!prev?.rules_hash && !!newHash && prev.rules_hash !== newHash;
    const { category } = categorize({ question: parsed.question, tags: parsed.tags, eventTitle: parsed.eventTitle }, this.deps.getCategories());

    const upsert: MarketCacheUpsert = {
      marketId: parsed.marketId,
      eventId: parsed.eventId,
      eventTitle: parsed.eventTitle,
      slug: parsed.slug,
      question: parsed.question,
      category,
      tags: parsed.tags,
      rulesText,
      rulesHash: newHash,
      rulesChangedAt: rulesChanged ? nowIso : (prev?.rules_changed_at ?? null),
      endDate: parsed.endDate,
      resolutionSource: parsed.resolutionSource,
      negRisk: parsed.negRisk,
      tokens: parsed.tokens,
      feeCategory: this.deps.feeCategoryFor?.(parsed.tags) ?? null,
      feeSchedule: parsed.feeSchedule,
      liquidityUsd: parsed.liquidityUsd,
      volume24hUsd: parsed.volume24hUsd,
      active: parsed.active,
      closed: parsed.closed,
      outcomePrices: parsed.outcomePrices,
      umaResolutionStatus: parsed.umaResolutionStatus,
      // A dispute stays recorded once seen (Gamma may drop it from the current status)
      disputed: parsed.disputed || prev?.disputed === 1,
      updatedAt: nowIso,
    };
    this.deps.repo.upsert(upsert);

    if (rulesChanged && prev?.rules_hash && newHash) {
      const heldBy = this.safeHeldBy(parsed.marketId);
      const event: RulesChangedEvent = { marketId: parsed.marketId, question: parsed.question, oldHash: prev.rules_hash, newHash, changedAt: nowIso, heldBy };
      logger.warning(`[MarketCache] Rules changed for ${parsed.marketId} (${parsed.question})${heldBy.length ? `; held by ${heldBy.join(', ')}` : ''}`);
      this.deps.audit?.record(
        'system',
        'market.rules_changed',
        parsed.marketId,
        { question: parsed.question, oldHash: prev.rules_hash, newHash, heldBy, oldRules: (prev.rules_text ?? '').slice(0, 2000), newRules: (rulesText ?? '').slice(0, 2000) },
        'changed'
      );
      this.emitSafe(MARKET_RULES_CHANGED_EVENT, event);
    }
    if (parsed.disputed && prev && prev.disputed !== 1) {
      this.deps.audit?.record('system', 'market.disputed', parsed.marketId, { question: parsed.question, umaResolutionStatus: parsed.umaResolutionStatus, heldBy: this.safeHeldBy(parsed.marketId) }, 'disputed');
    }
    return toMarketView(this.deps.repo.get(parsed.marketId)!, this.now());
  }

  private safeHeldBy(marketId: string): string[] {
    try {
      return this.deps.heldBy?.(marketId) ?? [];
    } catch {
      return [];
    }
  }

  private emitSafe(event: string, payload: unknown): void {
    try {
      this.emit(event, payload);
    } catch (err) {
      logger.error(`[MarketCache] ${event} listener failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** categories.yaml changed: re-categorize every cached market (no network). */
  recategorizeAll(): number {
    const cfg = this.deps.getCategories();
    let changed = 0;
    for (const row of this.deps.repo.all()) {
      const tags = parseJsonArray(row.tags) ?? [];
      const { category } = categorize({ question: row.question, tags, eventTitle: row.event_title }, cfg);
      if (category !== row.category) {
        this.deps.repo.setCategory(row.market_id, category);
        changed++;
      }
    }
    return changed;
  }

  // ── Ambiguity ────────────────────────────────────────────────────

  private async requireRow(marketId: string): Promise<MarketCacheRow> {
    if (typeof marketId !== 'string' || !marketId) throw new Error('marketId required');
    let row = this.deps.repo.get(marketId);
    if (!row) {
      await this.refresh(marketId);
      row = this.deps.repo.get(marketId);
      if (!row) throw new Error(`Unknown market ${marketId}`);
    }
    return row;
  }

  /**
   * Human assessment (0–3). Always replaces the stored score; from then on forecasts cannot change it
   * until a human sets it again. The market is fetched first when not cached.
   */
  async setAmbiguity(marketId: string, score: number, humanActor: HumanActor, note: string | null = null): Promise<MarketView> {
    const actor = auditActorOf(humanActor);
    if (!Number.isInteger(score) || score < 0 || score > 3) throw new Error('ambiguity score must be an integer 0-3');
    if (!isHumanActor(humanActor)) throw new Error('Only a human can set a market assessment directly (forecasts use recordForecastAmbiguity)');
    const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 2000) : null;
    const row = await this.requireRow(marketId);
    const at = new Date(this.now()).toISOString();
    this.deps.repo.setAmbiguity(marketId, score, 'human', cleanNote, at);
    const view = toMarketView(this.deps.repo.get(marketId)!, this.now());
    this.deps.audit?.record(actor, 'market.ambiguity', marketId, { from: row.market_ambiguity, fromSource: row.ambiguity_source, to: score, source: 'human', effective: view.ambiguityScore, raisedBecause: view.ambiguityRaisedBecause, note: cleanNote }, 'ok');
    return view;
  }

  /**
   * A forecast's ambiguity score. Ignored when a human assessed the market; otherwise it can only
   * raise the stored score (never lower it). Returns whether the stored score changed.
   */
  async recordForecastAmbiguity(marketId: string, score: number, actor: AuditActor, forecastId: string): Promise<boolean> {
    if (!Number.isInteger(score) || score < 0 || score > 3) throw new Error('ambiguity score must be an integer 0-3');
    const row = await this.requireRow(marketId);
    let result: string;
    let changed = false;
    if (row.ambiguity_source === 'human') {
      result = 'kept: human assessment';
    } else if (row.market_ambiguity !== null && score <= row.market_ambiguity) {
      result = 'kept: forecasts can only raise the score';
    } else {
      this.deps.repo.setAmbiguity(marketId, score, 'forecast', `forecast ${forecastId}`, new Date(this.now()).toISOString());
      result = 'ok';
      changed = true;
    }
    this.deps.audit?.record(actor, 'market.ambiguity', marketId, { from: row.market_ambiguity, fromSource: row.ambiguity_source, proposed: score, source: 'forecast', forecastId }, result);
    return changed;
  }

  /** Scorer bookkeeping: the resolution first seen (null clears it). */
  setResolutionSeen(marketId: string, signature: string | null, at: string | null): void {
    this.deps.repo.setResolutionSeen(marketId, signature, at);
  }

  // ── Periodic refresh ─────────────────────────────────────────────

  start(intervalMs = MARKET_REFRESH_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runPeriodic(), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.periodic;
  }

  /** Refresh held / open-order / active-forecast markets once. */
  runPeriodic(): Promise<void> {
    if (this.periodic) return this.periodic;
    this.periodic = (async () => {
      try {
        const ids = this.deps.watchedMarketIds?.() ?? [];
        if (ids.length === 0) return;
        const r = await this.refreshMany(ids);
        if (r.failed > 0) logger.warning(`[MarketCache] Periodic refresh: ${r.refreshed} ok, ${r.failed} failed`);
      } catch (err) {
        logger.error(`[MarketCache] Periodic refresh failed: ${err instanceof Error ? err.message : err}`);
      }
    })().finally(() => {
      this.periodic = null;
    });
    return this.periodic;
  }
}
