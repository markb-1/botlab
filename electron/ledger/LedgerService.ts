/**
 * LedgerService — the forecast ledger (spec §6): writing forecasts, the hourly scorer, category
 * statistics and category-rights transitions.
 *
 * - `submitForecast`: validates, captures the market snapshot (CLOB best bid/ask → mid, Gamma
 *   liquidity) server-side — the caller cannot supply prices — computes the horizon bucket from the
 *   market end date, supersedes the token's active forecast, sets `tradeable` from the bucket's
 *   rights, and records the forecast's ambiguity score as the market's assessment.
 * - Scorer (`runOnce`, hourly): refreshes markets with unscored forecasts, scores resolved ones
 *   (superseded and withdrawn included), voids 50-50 markets, captures the 7-day convergence price,
 *   then re-evaluates every bucket's rights (pure `decideRights`).
 * - Read side for OrderService (ForecastSource, CategoryBucketSource) and bots (`ctx.ledger`).
 *
 * Agent submission arrives with MCP in Phase 4; until then forecasts come from the human IPC.
 */

import { z } from 'zod';
import type { AuditActor, AuditService } from '../audit/AuditService';
import type { LimitsConfig, MandateConfig } from '../config/schema';
import { MAX_HORIZON_DAYS } from '../config/schema';
import { generateId } from '../database/index';
import type { CategoryRightsRepository, CategoryRightsRow } from '../database/repositories/CategoryRightsRepository';
import type { ForecastFilter, ForecastRepository, ForecastRow } from '../database/repositories/ForecastRepository';
import type { CategoryBucketSource } from '../orders/DbRiskStateProvider';
import type { ForecastSource } from '../orders/OrderService';
import { horizonBucket } from '../risk/RiskEngine';
import type { CategoryRightsState, ForecastEdgeInfo, HorizonBucket } from '../risk/types';
import { AUTO_RAISE_MIN_SCORE, autoRaiseReason } from './ambiguity';
import type { MarketCacheService, MarketView } from './MarketCacheService';
import {
  activeWeight,
  convergenceScore,
  decideRights,
  MIN_STATS_DISAGREEMENT,
  eventVotes,
  expectedThresholdDate,
  mandateListing,
  parseResolution,
  requiredEvents,
  scoreForecast,
  seedFrom,
  INITIAL_MAX_ALLOCATION_USD,
  type EventVote,
  type ScoredItem,
  type ThresholdEstimate,
} from './scoring';
import logger from '../../src/utils/logger';

export const SCORER_INTERVAL_MS = 3_600_000;
export const MIN_HOURS_BEFORE_END = 6;
export const MAX_RATIONALE_CHARS = 4000;
export const CONVERGENCE_DAYS = 7;
/** A token's forecast can be replaced at most this often (withdrawing is always allowed) */
export const MIN_SUPERSEDE_INTERVAL_MS = 6 * 3_600_000;
/** Forecasts need a tight book: the mid is the skill baseline */
export const MAX_FORECAST_SPREAD = 0.1;
/** Without a settled UMA status, a final price must be seen on two runs this far apart before scoring */
export const RESOLUTION_CONFIRM_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;
const LOOKUP_TIMEOUT_MS = 10_000;
const BUCKET_ORDER: HorizonBucket[] = ['short', 'medium', 'long'];
const RIGHTS_STATES: CategoryRightsState[] = ['shadow', 'trading', 'suspended', 'deprioritised'];

export const FORECAST_CHANGED_EVENT = 'ledger:forecastChanged';

/** What a caller may send. Prices are not accepted: the server captures them. */
export const SubmitForecastSchema = z.strictObject({
  tokenId: z.string().min(1).max(200),
  probability: z.number().finite().min(0.01).max(0.99),
  rationale: z.string().trim().min(1, 'rationale is required').max(MAX_RATIONALE_CHARS, `rationale must be at most ${MAX_RATIONALE_CHARS} characters`),
  sources: z
    .array(
      z
        .string()
        .max(2000)
        .refine((u) => {
          try {
            const url = new URL(u);
            return url.protocol === 'https:' || url.protocol === 'http:';
          } catch {
            return false;
          }
        }, 'each source must be an http(s) URL')
    )
    .max(50),
  ambiguityScore: z.number().int().min(0).max(3),
});

export type SubmitForecastInput = z.infer<typeof SubmitForecastSchema>;

export class LedgerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerValidationError';
  }
}

export interface ForecastView {
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
  status: ForecastRow['status'];
  supersededBy: string | null;
  tradeable: boolean;
  daysToResolutionAtForecast: number;
  horizonBucket: HorizonBucket;
  priceAt7d: number | null;
  convergence: number | null;
  createdBy: string;
  createdAt: string;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  resolvedAt: string | null;
  outcome: number | null;
  brierAgent: number | null;
  brierMarket: number | null;
  skill: number | null;
}

export function toForecastView(r: ForecastRow): ForecastView {
  let sources: string[] = [];
  try {
    const v = JSON.parse(r.sources) as unknown;
    if (Array.isArray(v)) sources = v.map(String);
  } catch {
    /* keep [] */
  }
  return {
    id: r.id,
    marketId: r.market_id,
    tokenId: r.token_id,
    eventId: r.event_id,
    category: r.category,
    probability: r.probability,
    marketPriceAtForecast: r.market_price_at_forecast,
    bestBid: r.best_bid,
    bestAsk: r.best_ask,
    liquidityUsd: r.liquidity_usd,
    rationale: r.rationale,
    sources,
    ambiguityScore: r.ambiguity_score,
    status: r.status,
    supersededBy: r.superseded_by,
    tradeable: r.tradeable === 1,
    daysToResolutionAtForecast: r.days_to_resolution_at_forecast,
    horizonBucket: r.horizon_bucket,
    priceAt7d: r.price_at_7d,
    convergence: r.convergence,
    createdBy: r.created_by,
    createdAt: r.created_at,
    withdrawnAt: r.withdrawn_at,
    withdrawnReason: r.withdrawn_reason,
    resolvedAt: r.resolved_at,
    outcome: r.outcome,
    brierAgent: r.brier_agent,
    brierMarket: r.brier_market,
    skill: r.skill,
  };
}

export interface BucketStatsView {
  category: string;
  horizonBucket: HorizonBucket;
  state: CategoryRightsState;
  forced: boolean;
  nScored: number;
  skillMean: number | null;
  skillLowerBound: number | null;
  nConvergence: number;
  convergenceMean: number | null;
  convergenceLowerBound: number | null;
  maxAllocationUsd: number;
  changedAt: string;
  changedReason: string | null;
  lastEvaluatedAt: string | null;
  /** Mandate listing of the category (only `allow` can trade) */
  mandate: string;
  threshold: ThresholdEstimate;
}

export interface ScorerRunResult {
  scored: number;
  voided: number;
  convergence: number;
  rightsChanges: Array<{ category: string; bucket: HorizonBucket; from: CategoryRightsState; to: CategoryRightsState; reason: string }>;
  marketsFailed: number;
  /** Markets with a final price waiting for confirmation */
  pendingConfirmation: number;
}

export interface LedgerDeps {
  forecastRepo: ForecastRepository;
  rightsRepo: CategoryRightsRepository;
  marketCache: Pick<MarketCacheService, 'getMarketByToken' | 'getCached' | 'refreshMany' | 'recordForecastAmbiguity' | 'setResolutionSeen'>;
  audit?: Pick<AuditService, 'record'>;
  /** CLOB top of book for the snapshot; throw when unavailable */
  getTopOfBook: (tokenId: string) => Promise<{ bestBid: number | null; bestAsk: number | null }>;
  /** Mid for the 7-day convergence price; null/throw = unavailable (retried next run) */
  getMid: (tokenId: string) => Promise<number | null>;
  /** Mandate in force; null = config unavailable (rights are not changed) */
  getMandate: () => MandateConfig | null;
  /** Limits in force (max_spread, min_liquidity_usd for the forecast gate); null = use the mandate / fixed caps only */
  getLimits?: () => LimitsConfig | null;
  /** Called after a forecast is written/withdrawn (bots' ctx.events later) */
  onForecastChanged?: (f: ForecastView) => void;
  now?: () => number;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const parseTime = (iso: string | null): number => (iso ? Date.parse(iso) : NaN);

/**
 * Forecasts of one bucket → skill and convergence votes (one per event). Each version is weighted by
 * its active time (creation → superseded / withdrawn / resolved, capped at the market end) within its
 * token; versions within 0.02 of the market price are left out (no information, not tradeable).
 */
export function bucketVotes(rows: readonly ForecastRow[]): { skill: EventVote[]; convergence: EventVote[] } {
  const skill: ScoredItem[] = [];
  const conv: ScoredItem[] = [];
  for (const r of rows) {
    if (r.status === 'void') continue;
    if (Math.abs(r.probability - r.market_price_at_forecast) < MIN_STATS_DISAGREEMENT) continue;
    const created = parseTime(r.created_at);
    const end = created + r.days_to_resolution_at_forecast * DAY_MS;
    const until = parseTime(r.active_until ?? null);
    const weight = Number.isNaN(created) ? 1 : activeWeight(created, Number.isNaN(until) ? null : until, end);
    if (r.outcome !== null && r.skill !== null) {
      const at = parseTime(r.resolved_at);
      skill.push({ eventId: r.event_id, tokenId: r.token_id, value: r.skill, weight, at: Number.isNaN(at) ? 0 : at });
    }
    if (r.convergence !== null) {
      const at = parseTime(r.price_at_7d_at);
      conv.push({ eventId: r.event_id, tokenId: r.token_id, value: r.convergence, weight, at: Number.isNaN(at) ? 0 : at });
    }
  }
  return { skill: eventVotes(skill), convergence: eventVotes(conv) };
}

export class LedgerService implements ForecastSource, CategoryBucketSource {
  private deps: LedgerDeps;
  private now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<ScorerRunResult | null> | null = null;

  constructor(deps: LedgerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  // ── Writing ──────────────────────────────────────────────────────

  /** Validate and record a forecast (spec §6.1). Throws LedgerValidationError on bad input or market state. */
  async submitForecast(input: unknown, actor: AuditActor): Promise<ForecastView> {
    const parsed = SubmitForecastSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(input)'}: ${i.message}`);
      throw new LedgerValidationError(`Invalid forecast: ${issues.join('; ')}`);
    }
    const f = parsed.data;

    let market: MarketView | null;
    try {
      market = await this.deps.marketCache.getMarketByToken(f.tokenId, { maxAgeMs: 60_000 });
    } catch (err) {
      throw new LedgerValidationError(`Market lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!market) throw new LedgerValidationError(`Unknown token ${f.tokenId}`);
    if (market.closed || !market.active) throw new LedgerValidationError('Market is not open');
    // Any UMA activity means resolution has started (or is contested): the market price is no baseline
    if (market.umaResolutionStatus || market.disputed) {
      throw new LedgerValidationError(`Market has a UMA resolution status (${market.umaResolutionStatus ?? 'disputed'}); no new forecasts`);
    }
    const mandateNow = this.deps.getMandate();
    if (!mandateNow) throw new LedgerValidationError('Mandate unavailable (config invalid); cannot check the market');
    const limitsNow = this.deps.getLimits?.() ?? null;
    const minLiquidity = Math.max(mandateNow.markets.min_liquidity_usd, limitsNow?.per_market.min_liquidity_usd ?? 0);
    if (market.volume24hUsd === null || market.volume24hUsd < minLiquidity) {
      throw new LedgerValidationError(`Market liquidity ${market.volume24hUsd ?? 'unknown'} (24h volume) < ${minLiquidity}`);
    }

    const now = this.now();
    const end = market.endDate ? Date.parse(market.endDate) : NaN;
    if (Number.isNaN(end)) throw new LedgerValidationError('Market end date unknown');
    const days = (end - now) / DAY_MS;
    if (days * 24 < MIN_HOURS_BEFORE_END) throw new LedgerValidationError(`Market ends in less than ${MIN_HOURS_BEFORE_END} hours`);
    if (days > MAX_HORIZON_DAYS) throw new LedgerValidationError(`Market settles in ${days.toFixed(1)} days (> ${MAX_HORIZON_DAYS}); no horizon bucket`);

    // Server-captured snapshot
    let top: { bestBid: number | null; bestAsk: number | null };
    try {
      top = await withTimeout(this.deps.getTopOfBook(f.tokenId), LOOKUP_TIMEOUT_MS, 'order book');
    } catch (err) {
      throw new LedgerValidationError(`Order book unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { bestBid, bestAsk } = top;
    const validPrice = (p: number | null): p is number => p !== null && Number.isFinite(p) && p > 0 && p < 1;
    if (!validPrice(bestBid) || !validPrice(bestAsk) || bestBid > bestAsk) {
      throw new LedgerValidationError('No usable two-sided order book: the market price cannot be captured');
    }
    const maxSpread = Math.min(MAX_FORECAST_SPREAD, limitsNow?.per_market.max_spread ?? MAX_FORECAST_SPREAD);
    if (bestAsk - bestBid > maxSpread + 1e-9) {
      throw new LedgerValidationError(`Spread ${(bestAsk - bestBid).toFixed(3)} > ${maxSpread}: the mid is not a usable market price`);
    }
    const mid = (bestBid + bestAsk) / 2;

    const current = this.deps.forecastRepo.findActiveByToken(f.tokenId);
    if (current) {
      const age = now - parseTime(current.created_at);
      if (!(age >= MIN_SUPERSEDE_INTERVAL_MS)) {
        const nextAt = new Date(parseTime(current.created_at) + MIN_SUPERSEDE_INTERVAL_MS).toISOString();
        throw new LedgerValidationError(`Forecast ${current.id} on this token is less than 6 hours old; it can be replaced from ${nextAt} (withdrawing is allowed now)`);
      }
    }

    const bucket = horizonBucket(days);
    const category = market.category;
    const nowIso = new Date(now).toISOString();
    const rights = this.deps.rightsRepo.ensure(category, bucket, nowIso);
    const tradeable = rights.state === 'trading' && mandateListing(category, mandateNow) === 'allow';

    // Server raise (§7.4) applies to the recorded score; the market keeps the raw assessment
    const raise = autoRaiseReason({ rulesChangedAt: market.rulesChangedAt, disputed: market.disputed }, now);
    const ambiguity = raise ? Math.max(f.ambiguityScore, AUTO_RAISE_MIN_SCORE) : f.ambiguityScore;

    const id = generateId();
    const { supersededId } = this.deps.forecastRepo.insertSuperseding({
      id,
      marketId: market.marketId,
      tokenId: f.tokenId,
      eventId: market.eventId,
      category,
      probability: f.probability,
      marketPriceAtForecast: mid,
      bestBid,
      bestAsk,
      liquidityUsd: market.liquidityUsd,
      rationale: f.rationale,
      sources: f.sources,
      ambiguityScore: ambiguity,
      tradeable,
      daysToResolution: days,
      horizonBucket: bucket,
      createdBy: actor,
      createdAt: nowIso,
    });

    try {
      await this.deps.marketCache.recordForecastAmbiguity(market.marketId, f.ambiguityScore, actor, id);
    } catch (err) {
      logger.error(`[Ledger] Could not record ambiguity for ${market.marketId}: ${err instanceof Error ? err.message : err}`);
    }

    const row = this.deps.forecastRepo.findById(id)!;
    this.deps.audit?.record(actor, 'ledger.forecast', id, {
      marketId: market.marketId,
      tokenId: f.tokenId,
      category,
      bucket,
      probability: f.probability,
      marketPrice: mid,
      bestBid,
      bestAsk,
      ambiguity,
      ...(raise ? { ambiguityRaisedBecause: raise } : {}),
      tradeable,
      supersedes: supersededId,
    }, 'ok');
    const view = toForecastView(row);
    this.notifyChanged(view);
    return view;
  }

  withdrawForecast(id: string, reason: string, actor: AuditActor): ForecastView {
    if (typeof id !== 'string' || !id) throw new LedgerValidationError('forecast id required');
    const why = typeof reason === 'string' ? reason.trim().slice(0, 1000) : '';
    if (!why) throw new LedgerValidationError('reason is required');
    const existing = this.deps.forecastRepo.findById(id);
    if (!existing) throw new LedgerValidationError(`Unknown forecast ${id}`);
    if (existing.status !== 'active') throw new LedgerValidationError(`Forecast ${id} is ${existing.status}, not active`);
    this.deps.forecastRepo.withdraw(id, why, new Date(this.now()).toISOString());
    this.deps.audit?.record(actor, 'ledger.withdraw', id, { reason: why, marketId: existing.market_id, tokenId: existing.token_id }, 'ok');
    const view = toForecastView(this.deps.forecastRepo.findById(id)!);
    this.notifyChanged(view);
    return view;
  }

  private notifyChanged(view: ForecastView): void {
    try {
      this.deps.onForecastChanged?.(view);
    } catch (err) {
      logger.error(`[Ledger] forecast listener failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Reading ──────────────────────────────────────────────────────

  list(filter: ForecastFilter = {}): ForecastView[] {
    return this.deps.forecastRepo.list(filter).map(toForecastView);
  }

  getForecast(id: string): ForecastView | null {
    const r = this.deps.forecastRepo.findById(id);
    return r ? toForecastView(r) : null;
  }

  getActiveForToken(tokenId: string): ForecastView | null {
    const r = this.deps.forecastRepo.findActiveByToken(tokenId);
    return r ? toForecastView(r) : null;
  }

  /** The bucket's current rights state and whether the forecast can be traded now (active, bucket trading, category allowed). */
  liveRights(f: ForecastRow): { bucketState: CategoryRightsState | null; tradeableNow: boolean } {
    const bucketState = this.deps.rightsRepo.get(f.category, f.horizon_bucket)?.state ?? null;
    const mandate = this.deps.getMandate();
    const tradeableNow = f.status === 'active' && bucketState === 'trading' && !!mandate && mandateListing(f.category, mandate) === 'allow';
    return { bucketState, tradeableNow };
  }

  /** ctx.ledger: active forecasts with the bucket's current state and live `tradeable`. */
  botForecasts(filter: { category?: string; tradeableOnly?: boolean } = {}): Array<ForecastView & { bucketState: CategoryRightsState | null; tradeableNow: boolean }> {
    const rows = this.deps.forecastRepo.list({ status: 'active', ...(filter.category ? { category: filter.category } : {}) });
    return rows.map((r) => ({ ...toForecastView(r), ...this.liveRights(r) })).filter((f) => !filter.tradeableOnly || f.tradeableNow);
  }

  botForecast(tokenId: string): (ForecastView & { bucketState: CategoryRightsState | null; tradeableNow: boolean }) | null {
    const r = this.deps.forecastRepo.findActiveByToken(tokenId);
    return r ? { ...toForecastView(r), ...this.liveRights(r) } : null;
  }

  /**
   * ForecastSource (OrderService): only an active forecast that is tradeable now (same live rule as
   * ctx.ledger; the engine re-checks the bucket). The complementary token of a binary market gets 1 − p.
   */
  async get(forecastId: string, tokenId: string): Promise<ForecastEdgeInfo | null> {
    const f = this.deps.forecastRepo.findById(forecastId);
    if (!f || !this.liveRights(f).tradeableNow) return null;
    if (f.token_id === tokenId) return { forecastId, probability: f.probability };
    const tokens = this.deps.marketCache.getCached(f.market_id)?.tokens ?? [];
    if (tokens.length === 2 && tokens.some((t) => t.tokenId === f.token_id) && tokens.some((t) => t.tokenId === tokenId)) {
      return { forecastId, probability: 1 - f.probability };
    }
    return null;
  }

  /** CategoryBucketSource (DbRiskStateProvider). */
  bucketForForecast(forecastId: string): ReturnType<CategoryBucketSource['bucketForForecast']> {
    const f = this.deps.forecastRepo.findById(forecastId);
    if (!f) return null;
    const rights = this.deps.rightsRepo.get(f.category, f.horizon_bucket);
    if (!rights) return null;
    return { category: f.category, horizonBucket: f.horizon_bucket, state: rights.state, maxAllocationUsd: rights.max_allocation_usd };
  }

  ledgerBuyOrders(category: string, bucket: HorizonBucket, simulated: boolean): ReturnType<CategoryBucketSource['ledgerBuyOrders']> {
    return this.deps.forecastRepo.ledgerBuyOrders(category, bucket, simulated);
  }

  /** Per-bucket stats, rights and the expected date to the trading threshold (ledger page). */
  stats(): BucketStatsView[] {
    const now = this.now();
    const mandate = this.deps.getMandate();
    const rows = this.deps.rightsRepo.all();
    const byBucket = this.groupStatsRows();
    return rows.map((r) => {
      const shortTrading = this.deps.rightsRepo.get(r.category, 'short')?.state === 'trading';
      const votes = bucketVotes(byBucket.get(`${r.category}|${r.horizon_bucket}`) ?? []).skill;
      return {
        category: r.category,
        horizonBucket: r.horizon_bucket,
        state: r.state,
        forced: r.forced === 1,
        nScored: r.n_scored,
        skillMean: r.skill_mean,
        skillLowerBound: r.skill_lower_bound,
        nConvergence: r.n_convergence,
        convergenceMean: r.convergence_mean,
        convergenceLowerBound: r.convergence_lower_bound,
        maxAllocationUsd: r.max_allocation_usd,
        changedAt: r.changed_at,
        changedReason: r.changed_reason,
        lastEvaluatedAt: r.last_evaluated_at,
        mandate: mandate ? mandateListing(r.category, mandate) : 'unknown',
        threshold: expectedThresholdDate(votes, requiredEvents(r.horizon_bucket, shortTrading), now),
      };
    });
  }

  private groupStatsRows(): Map<string, ForecastRow[]> {
    const map = new Map<string, ForecastRow[]>();
    for (const r of this.deps.forecastRepo.forStats()) {
      const key = `${r.category}|${r.horizon_bucket}`;
      const list = map.get(key);
      if (list) list.push(r);
      else map.set(key, [r]);
    }
    return map;
  }

  // ── Scoring ──────────────────────────────────────────────────────

  start(intervalMs = SCORER_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref?.();
    void this.runOnce();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** One scorer run (never throws; overlapping calls share the run in progress). */
  runOnce(): Promise<ScorerRunResult | null> {
    if (this.running) return this.running;
    this.running = this.runUnsafe()
      .catch((err) => {
        logger.error(`[Ledger] Scorer run failed: ${err instanceof Error ? err.message : err}`);
        this.deps.audit?.record('system', 'ledger.scorer_error', null, { error: err instanceof Error ? err.message : String(err) }, 'error');
        return null;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async runUnsafe(): Promise<ScorerRunResult> {
    const result: ScorerRunResult = { scored: 0, voided: 0, convergence: 0, rightsChanges: [], marketsFailed: 0, pendingConfirmation: 0 };
    const marketIds = this.deps.forecastRepo.unresolvedMarketIds();
    if (marketIds.length > 0) {
      const r = await this.deps.marketCache.refreshMany(marketIds);
      result.marketsFailed = r.failed;
    }
    const nowIso = new Date(this.now()).toISOString();

    for (const marketId of marketIds) {
      const market = this.deps.marketCache.getCached(marketId);
      if (!market) continue;
      const res = parseResolution(market);
      if (res.kind === 'unresolved') {
        if (market.resolutionSeen !== null) this.deps.marketCache.setResolutionSeen(marketId, null, null);
        continue;
      }
      // Confirmation (R54): a settled UMA status scores at once; otherwise the same final result must be
      // seen on runs at least 24 h apart (the UMA field names are unverified)
      const signature = JSON.stringify(res);
      const umaSettled = /resolved|settled/i.test(market.umaResolutionStatus ?? '');
      if (!umaSettled) {
        const seenAt = parseTime(market.resolutionSeenAt);
        if (market.resolutionSeen !== signature || Number.isNaN(seenAt)) {
          this.deps.marketCache.setResolutionSeen(marketId, signature, nowIso);
          result.pendingConfirmation++;
          continue;
        }
        if (this.now() - seenAt < RESOLUTION_CONFIRM_MS) {
          result.pendingConfirmation++;
          continue;
        }
      }
      // Resolution time = when the final result was first seen
      const resolvedIso = umaSettled || !market.resolutionSeenAt ? nowIso : market.resolutionSeenAt;
      const resolvedMs = parseTime(resolvedIso);
      const forecasts = this.deps.forecastRepo.unscoredForMarket(marketId);
      if (res.kind === 'void') {
        for (const f of forecasts) this.deps.forecastRepo.setVoid(f.id, resolvedIso);
        result.voided += forecasts.length;
        if (forecasts.length) this.deps.audit?.record('system', 'ledger.void', marketId, { forecasts: forecasts.map((f) => f.id) }, 'void');
        continue;
      }
      for (const f of forecasts) {
        const idx = market.tokens.findIndex((t) => t.tokenId === f.token_id);
        if (idx < 0 || idx >= res.payouts.length) {
          logger.warning(`[Ledger] Forecast ${f.id}: token ${f.token_id} not among the market's outcomes; not scored`);
          continue;
        }
        const outcome = res.payouts[idx];
        const s = scoreForecast(f.probability, f.market_price_at_forecast, outcome);
        this.deps.forecastRepo.setScore(f.id, { outcome, brierAgent: s.brierAgent, brierMarket: s.brierMarket, skill: s.skill, resolvedAt: resolvedIso });
        // Resolved before the 7-day mark: the resolution price is the convergence price
        if (f.price_at_7d === null && parseTime(f.created_at) + CONVERGENCE_DAYS * DAY_MS > resolvedMs) {
          this.deps.forecastRepo.setConvergence(f.id, outcome, resolvedIso, convergenceScore(f.probability, f.market_price_at_forecast, outcome));
          result.convergence++;
        }
        result.scored++;
      }
      if (forecasts.length) this.deps.audit?.record('system', 'ledger.scored', marketId, { payouts: res.payouts, forecasts: forecasts.length }, 'ok');
    }

    // 7-day convergence prices for unresolved forecasts
    for (const f of this.deps.forecastRepo.needingConvergence()) {
      const due = parseTime(f.created_at) + CONVERGENCE_DAYS * DAY_MS;
      if (Number.isNaN(due) || due > this.now()) continue;
      // Closed market (resolution pending confirmation): the book is no market price
      if (this.deps.marketCache.getCached(f.market_id)?.closed) continue;
      let mid: number | null = null;
      try {
        mid = await withTimeout(this.deps.getMid(f.token_id), LOOKUP_TIMEOUT_MS, 'mid');
      } catch {
        mid = null;
      }
      if (mid === null || !Number.isFinite(mid)) continue;
      this.deps.forecastRepo.setConvergence(f.id, mid, new Date(this.now()).toISOString(), convergenceScore(f.probability, f.market_price_at_forecast, mid));
      result.convergence++;
    }

    result.rightsChanges = this.evaluateRights();
    return result;
  }

  /** Recompute stats for every bucket and apply rights transitions. Short buckets first (medium relaxation). */
  evaluateRights(): ScorerRunResult['rightsChanges'] {
    const changes: ScorerRunResult['rightsChanges'] = [];
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const mandate = this.deps.getMandate();
    const groups = this.groupStatsRows();
    for (const b of this.deps.forecastRepo.buckets()) this.deps.rightsRepo.ensure(b.category, b.horizon_bucket, nowIso);
    const rows = this.deps.rightsRepo
      .all()
      .sort((a, b) => BUCKET_ORDER.indexOf(a.horizon_bucket) - BUCKET_ORDER.indexOf(b.horizon_bucket));

    for (const row of rows) {
      const votes = bucketVotes(groups.get(`${row.category}|${row.horizon_bucket}`) ?? []);
      const shortTrading = this.deps.rightsRepo.get(row.category, 'short')?.state === 'trading';
      const decision = decideRights({
        bucket: row.horizon_bucket,
        current: {
          state: row.state,
          maxAllocationUsd: row.max_allocation_usd,
          qualifiedN: row.qualified_n,
          forced: row.forced === 1,
          changedAt: parseTime(row.changed_at) || 0,
        },
        skillVotes: votes.skill,
        convergenceVotes: votes.convergence,
        mandate: mandate ? mandateListing(row.category, mandate) : 'none',
        shortBucketTrading: shortTrading,
        budgetUsd: mandate?.budget_usd ?? 0,
        seed: seedFrom(`${row.category}|${row.horizon_bucket}`),
      });
      this.deps.rightsRepo.updateStats(row.category, row.horizon_bucket, {
        nScored: decision.skill.n,
        skillMean: decision.skill.mean,
        skillLowerBound: decision.skill.lowerBound,
        nConvergence: decision.convergence.n,
        convergenceMean: decision.convergence.mean,
        convergenceLowerBound: decision.convergence.lowerBound,
        evaluatedAt: nowIso,
      });
      // No mandate (config unavailable): stats only, never change rights
      if (!mandate || !decision.changed) continue;
      this.deps.rightsRepo.setState(row.category, row.horizon_bucket, {
        state: decision.state,
        maxAllocationUsd: decision.maxAllocationUsd,
        qualifiedN: decision.qualifiedN,
        forced: decision.forced,
        reason: decision.reason,
        at: nowIso,
        stateChanged: decision.stateChanged,
      });
      if (decision.stateChanged) {
        changes.push({ category: row.category, bucket: row.horizon_bucket, from: row.state, to: decision.state, reason: decision.reason });
        this.auditRightsChange('system', row, decision.state, decision.maxAllocationUsd, decision.reason, false);
      } else {
        this.deps.audit?.record('system', 'category_rights.allocation', `${row.category}/${row.horizon_bucket}`, { from: row.max_allocation_usd, to: decision.maxAllocationUsd, reason: decision.reason }, 'ok');
      }
    }
    return changes;
  }

  private auditRightsChange(actor: AuditActor, row: CategoryRightsRow, to: CategoryRightsState, maxAllocationUsd: number, reason: string, forced: boolean): void {
    this.deps.audit?.record(
      actor,
      'category_rights.change',
      `${row.category}/${row.horizon_bucket}`,
      { category: row.category, bucket: row.horizon_bucket, from: row.state, to, maxAllocationUsd, reason, forced, nScored: row.n_scored, skillLowerBound: row.skill_lower_bound },
      'ok'
    );
  }

  /**
   * Human override (spec §6.3 "human can force any state", logged). `auto` hands the bucket back to
   * the automatic rules. A category outside the mandate allow list can never be `trading`.
   */
  forceRightsState(category: string, bucket: HorizonBucket, state: CategoryRightsState | 'auto', reason: string, actor: AuditActor): BucketStatsView | null {
    if (actor !== 'human') {
      this.deps.audit?.record(actor, 'category_rights.force', `${category}/${bucket}`, { state }, 'denied: human only');
      throw new Error('Only a human can force category rights');
    }
    if (!BUCKET_ORDER.includes(bucket)) throw new LedgerValidationError(`Unknown horizon bucket ${String(bucket)}`);
    if (state !== 'auto' && !RIGHTS_STATES.includes(state)) throw new LedgerValidationError(`Unknown state ${String(state)}`);
    if (typeof category !== 'string' || !category) throw new LedgerValidationError('category required');
    const why = typeof reason === 'string' ? reason.trim().slice(0, 1000) : '';
    if (!why) throw new LedgerValidationError('reason is required');

    const nowIso = new Date(this.now()).toISOString();
    const row = this.deps.rightsRepo.ensure(category, bucket, nowIso);
    const mandate = this.deps.getMandate();
    if (state === 'trading') {
      if (!mandate) throw new LedgerValidationError('Mandate unavailable (config invalid); cannot enable trading');
      const listing = mandateListing(category, mandate);
      if (listing !== 'allow') throw new LedgerValidationError(`Category ${category} is ${listing === 'none' ? 'not in the mandate allow list' : `in mandate "${listing}"`}; it cannot trade`);
    }

    if (state === 'auto') {
      this.deps.rightsRepo.setState(category, bucket, { state: row.state, maxAllocationUsd: row.max_allocation_usd, qualifiedN: row.qualified_n, forced: false, reason: why, at: nowIso, stateChanged: false });
      this.deps.audit?.record(actor, 'category_rights.force', `${category}/${bucket}`, { state: 'auto', reason: why }, 'ok');
    } else {
      const alloc = state === 'trading' ? Math.max(row.max_allocation_usd, Math.min(INITIAL_MAX_ALLOCATION_USD, mandate?.budget_usd ?? 0)) : 0;
      const qualifiedN = state === 'trading' ? (row.qualified_n ?? row.n_scored) : row.qualified_n;
      this.deps.rightsRepo.setState(category, bucket, { state, maxAllocationUsd: alloc, qualifiedN, forced: true, reason: `human: ${why}`, at: nowIso, stateChanged: true });
      this.auditRightsChange(actor, row, state, alloc, why, true);
    }
    return this.stats().find((s) => s.category === category && s.horizonBucket === bucket) ?? null;
  }

  /**
   * Hook (spec §6.3): the category's ledger-driven trades breached a loss limit ⇒ suspend the bucket.
   * Not called yet (ledger-driven P&L per category arrives with the forecast executor).
   */
  suspendForLoss(category: string, bucket: HorizonBucket, reason: string): boolean {
    const row = this.deps.rightsRepo.get(category, bucket);
    if (!row || row.state !== 'trading') return false;
    const nowIso = new Date(this.now()).toISOString();
    this.deps.rightsRepo.setState(category, bucket, { state: 'suspended', maxAllocationUsd: 0, qualifiedN: row.qualified_n, forced: false, reason: `loss limit: ${reason}`, at: nowIso, stateChanged: true });
    this.auditRightsChange('system', row, 'suspended', 0, `loss limit: ${reason}`, false);
    return true;
  }
}
