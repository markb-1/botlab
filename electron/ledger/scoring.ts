/**
 * Forecast ledger maths (spec §6.2–6.3). Pure and deterministic: resolution parsing, Brier
 * scores, convergence, one-vote-per-event statistics with a seeded bootstrap, category-rights
 * transitions and the expected date to reach the trading threshold.
 */

import type { CategoryRightsState, HorizonBucket } from '../risk/types';

// ─── Resolution ──────────────────────────────────────────────────────

export type Resolution =
  | { kind: 'unresolved' }
  /** Final price per outcome, same order as the market's tokens (each 0 or 1) */
  | { kind: 'resolved'; payouts: Array<0 | 1> }
  | { kind: 'void' };

const PRICE_EPS = 1e-6;

/**
 * Resolution from Gamma market fields (see PROGRESS Decision R54):
 * - only a `closed` market can be resolved;
 * - a UMA status that says proposed/disputed (not settled) ⇒ still unresolved;
 * - `outcomePrices` all 0 or 1 with exactly one 1 ⇒ resolved;
 * - all prices 0.5 ⇒ 50-50 ⇒ void;
 * - anything else (e.g. 0.9995 while the oracle settles) ⇒ unresolved, checked again next run.
 */
export function parseResolution(m: { closed: boolean; outcomePrices: string[] | null; umaResolutionStatus: string | null }): Resolution {
  if (!m.closed || !m.outcomePrices || m.outcomePrices.length < 2) return { kind: 'unresolved' };
  const uma = (m.umaResolutionStatus ?? '').toLowerCase();
  if (uma && /propos|disput|challeng|pending/.test(uma) && !/resolved|settled/.test(uma)) return { kind: 'unresolved' };
  const prices = m.outcomePrices.map((p) => Number(p));
  if (prices.some((p) => !Number.isFinite(p))) return { kind: 'unresolved' };
  if (prices.every((p) => Math.abs(p - 0.5) < PRICE_EPS)) return { kind: 'void' };
  const binary = prices.every((p) => Math.abs(p) < PRICE_EPS || Math.abs(p - 1) < PRICE_EPS);
  const ones = prices.filter((p) => Math.abs(p - 1) < PRICE_EPS).length;
  if (binary && ones === 1) return { kind: 'resolved', payouts: prices.map((p) => (Math.abs(p - 1) < PRICE_EPS ? 1 : 0)) };
  return { kind: 'unresolved' };
}

// ─── Per-forecast scores ─────────────────────────────────────────────

/** brier_agent = (p − o)², brier_market = (m − o)², skill = brier_market − brier_agent (positive = agent better). */
export function scoreForecast(p: number, m: number, outcome: 0 | 1): { brierAgent: number; brierMarket: number; skill: number } {
  const brierAgent = (p - outcome) ** 2;
  const brierMarket = (m - outcome) ** 2;
  return { brierAgent, brierMarket, skill: brierMarket - brierAgent };
}

/** convergence = sign(p − m) × (price_at_7d − m): positive when the market moved toward the agent. */
export function convergenceScore(p: number, m: number, priceAt7d: number): number {
  return Math.sign(p - m) * (priceAt7d - m);
}

// ─── One vote per event + bootstrap ─────────────────────────────────

export interface ScoredItem {
  eventId: string;
  /** Token the forecast is on; versions of the same token are weighted against each other. Default: one token per event */
  tokenId?: string;
  value: number;
  /** How long this version was the active forecast (ms); default 1 (equal weights) */
  weight?: number;
  /** When the item was scored (ms); for skill the resolution time, for convergence the capture time */
  at: number;
}

export interface EventVote {
  eventId: string;
  /** Mean over the event's tokens of each token's active-time-weighted mean */
  value: number;
  /** Latest `at` among the event's items */
  at: number;
  /** Earliest `at` among the event's items */
  firstAt: number;
}

/**
 * One vote per event (spec §6.2), robust to superseding: within a token each forecast version is
 * weighted by how long it was active, so many quick re-forecasts cannot dilute one call; the event
 * vote is the mean over its tokens. Sorted by time (then id).
 */
export function eventVotes(items: readonly ScoredItem[]): EventVote[] {
  const events = new Map<string, { tokens: Map<string, { sum: number; w: number }>; at: number; firstAt: number }>();
  for (const it of items) {
    if (!Number.isFinite(it.value)) continue;
    const w = it.weight === undefined ? 1 : it.weight;
    if (!Number.isFinite(w) || w <= 0) continue;
    const e = events.get(it.eventId) ?? { tokens: new Map(), at: -Infinity, firstAt: Infinity };
    const key = it.tokenId ?? '';
    const t = e.tokens.get(key) ?? { sum: 0, w: 0 };
    t.sum += it.value * w;
    t.w += w;
    e.tokens.set(key, t);
    e.at = Math.max(e.at, it.at);
    e.firstAt = Math.min(e.firstAt, it.at);
    events.set(it.eventId, e);
  }
  return [...events]
    .map(([eventId, e]) => {
      const means = [...e.tokens.values()].map((t) => t.sum / t.w);
      return { eventId, value: means.reduce((a, b) => a + b, 0) / means.length, at: e.at, firstAt: e.firstAt };
    })
    .sort((a, b) => a.at - b.at || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
}

/** A forecast this close to the market price carries no information and cannot be traded: excluded from stats. */
export const MIN_STATS_DISAGREEMENT = 0.02;

/** Active time of one version (ms): creation until it stopped being active, capped at the market end; at least 1 ms. */
export function activeWeight(createdAt: number, activeUntil: number | null, marketEnd: number): number {
  const until = Math.min(activeUntil ?? marketEnd, marketEnd);
  const w = until - createdAt;
  return Number.isFinite(w) && w > 0 ? w : 1;
}

/** mulberry32: small seeded PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a, used to derive a stable bootstrap seed per bucket. */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Quantile with linear interpolation (type 7) of an ascending array. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export const BOOTSTRAP_RESAMPLES = 1000;
export const LOWER_BOUND_QUANTILE = 0.1;

/** 10th percentile of `resamples` bootstrap means (resampling values with replacement). null when empty. */
export function bootstrapLowerBound(values: readonly number[], seed: number, resamples = BOOTSTRAP_RESAMPLES, q = LOWER_BOUND_QUANTILE): number | null {
  const n = values.length;
  if (n === 0) return null;
  const rand = mulberry32(seed);
  const means = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(rand() * n)];
    means[r] = sum / n;
  }
  means.sort((a, b) => a - b);
  return quantile(means, q);
}

export interface VoteStats {
  n: number;
  mean: number | null;
  lowerBound: number | null;
}

export function voteStats(votes: readonly EventVote[], seed: number): VoteStats {
  if (votes.length === 0) return { n: 0, mean: null, lowerBound: null };
  const values = votes.map((v) => v.value);
  return { n: values.length, mean: values.reduce((s, v) => s + v, 0) / values.length, lowerBound: bootstrapLowerBound(values, seed) };
}

// ─── Category rights (§6.3) ──────────────────────────────────────────

export const QUALIFY_MIN_EVENTS = 30;
/** Medium bucket of a category whose short bucket is trading */
export const MEDIUM_RELAXED_MIN_EVENTS = 20;
export const INITIAL_MAX_ALLOCATION_USD = 50;
export const ALLOCATION_STEP_USD = 50;
export const ALLOCATION_STEP_EVENTS = 20;
export const SUSPEND_WINDOW_EVENTS = 20;
export const DEPRIORITISE_MIN_EVENTS = 20;
/** Entering trading also needs mean skill over the last 20 events ≥ 0 */
export const RECENT_WINDOW_EVENTS = 20;

export type MandateListing = 'allow' | 'later' | 'deny' | 'none';

export function mandateListing(category: string, mandate: { categories: { allow: string[]; later: string[]; deny: string[] } }): MandateListing {
  const c = mandate.categories;
  if (c.deny.includes(category)) return 'deny';
  if (c.later.includes(category)) return 'later';
  if (c.allow.includes(category)) return 'allow';
  return 'none';
}

export function requiredEvents(bucket: HorizonBucket, shortBucketTrading: boolean): number {
  return bucket === 'medium' && shortBucketTrading ? MEDIUM_RELAXED_MIN_EVENTS : QUALIFY_MIN_EVENTS;
}

export interface RightsInput {
  bucket: HorizonBucket;
  current: {
    state: CategoryRightsState;
    maxAllocationUsd: number;
    qualifiedN: number | null;
    forced: boolean;
    /** When the state last changed (ms); for `suspended` this is the suspension time */
    changedAt: number;
  };
  /** One vote per event, sorted by time (see eventVotes) */
  skillVotes: readonly EventVote[];
  convergenceVotes: readonly EventVote[];
  mandate: MandateListing;
  shortBucketTrading: boolean;
  budgetUsd: number;
  seed: number;
}

export interface RightsDecision {
  state: CategoryRightsState;
  maxAllocationUsd: number;
  qualifiedN: number | null;
  /** true when the human-forced flag stays set */
  forced: boolean;
  stateChanged: boolean;
  /** Anything to write (state or allocation) */
  changed: boolean;
  reason: string;
  skill: VoteStats;
  convergence: VoteStats;
}

const mean = (xs: readonly number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
/** Mean of the last 20 votes (null when none). */
export function recentMean(votes: readonly EventVote[]): number | null {
  const last = votes.slice(-RECENT_WINDOW_EVENTS).map((v) => v.value);
  return last.length > 0 ? mean(last) : null;
}
const fmt = (n: number | null) => (n === null ? 'n/a' : n.toFixed(4));

/** Allocation for a trading bucket: 50, +50 per further 20 scored events since qualifying, capped by the budget. */
export function allocationFor(nScored: number, qualifiedN: number, budgetUsd: number): number {
  const steps = Math.floor(Math.max(0, nScored - qualifiedN) / ALLOCATION_STEP_EVENTS);
  return Math.min(budgetUsd, INITIAL_MAX_ALLOCATION_USD + ALLOCATION_STEP_USD * steps);
}

/**
 * Next rights state of one bucket (spec §6.3):
 * - only categories in the mandate allow list can be `trading` (a trading bucket whose category leaves
 *   the allow list goes back to `shadow`);
 * - shadow → trading: n ≥ 30 (medium: 20 if the short bucket trades), skill lower bound > 0 and mean
 *   skill of the last 20 events ≥ 0;
 * - trading: allocation grows +50 per 20 further events while the lower bound is > 0 (never above the
 *   budget); mean skill of the last 20 events < 0 ⇒ suspended;
 * - suspended → trading: re-qualify (same rules) on events whose forecasts all resolved after the suspension;
 * - shadow → deprioritised: ≥ 20 convergence events, convergence lower bound < 0 and mean < 0;
 * - deprioritised is left only by a human. A human-forced state blocks automatic promotion and
 *   deprioritisation; suspension and the mandate rule still apply.
 */
export function decideRights(input: RightsInput): RightsDecision {
  const { current, bucket, budgetUsd } = input;
  const skill = voteStats(input.skillVotes, input.seed);
  const convergence = voteStats(input.convergenceVotes, input.seed ^ 0x5bd1e995);
  const required = requiredEvents(bucket, input.shortBucketTrading);
  const canTrade = input.mandate === 'allow';
  const keep = (reason = 'no change'): RightsDecision => ({
    state: current.state,
    maxAllocationUsd: current.maxAllocationUsd,
    qualifiedN: current.qualifiedN,
    forced: current.forced,
    stateChanged: false,
    changed: false,
    reason,
    skill,
    convergence,
  });
  const to = (state: CategoryRightsState, maxAllocationUsd: number, qualifiedN: number | null, reason: string, forced = false): RightsDecision => ({
    state,
    maxAllocationUsd,
    qualifiedN,
    forced,
    stateChanged: state !== current.state,
    changed: state !== current.state || maxAllocationUsd !== current.maxAllocationUsd || qualifiedN !== current.qualifiedN || forced !== current.forced,
    reason,
    skill,
    convergence,
  });

  switch (current.state) {
    case 'trading': {
      if (!canTrade) return to('shadow', 0, null, `category is ${input.mandate === 'none' ? 'not in the mandate allow list' : `in mandate "${input.mandate}"`}`);
      const last = input.skillVotes.slice(-SUSPEND_WINDOW_EVENTS).map((v) => v.value);
      if (last.length > 0 && mean(last) < 0) {
        return to('suspended', 0, current.qualifiedN, `mean skill over the last ${last.length} scored events ${fmt(mean(last))} < 0`);
      }
      let alloc = Math.min(current.maxAllocationUsd, budgetUsd);
      if (skill.lowerBound !== null && skill.lowerBound > 0) {
        alloc = Math.max(alloc, allocationFor(skill.n, current.qualifiedN ?? skill.n, budgetUsd));
      }
      if (alloc !== current.maxAllocationUsd) {
        return to('trading', alloc, current.qualifiedN, `max allocation ${current.maxAllocationUsd} -> ${alloc} (n=${skill.n}, lower bound ${fmt(skill.lowerBound)})`, current.forced);
      }
      return keep();
    }
    case 'shadow': {
      if (current.forced) return keep('forced by a human');
      const recent = recentMean(input.skillVotes);
      if (canTrade && skill.n >= required && skill.lowerBound !== null && skill.lowerBound > 0 && recent !== null && recent >= 0) {
        return to('trading', Math.min(INITIAL_MAX_ALLOCATION_USD, budgetUsd), skill.n, `qualified: n=${skill.n} >= ${required}, skill lower bound ${fmt(skill.lowerBound)} > 0, recent mean ${fmt(recent)} >= 0`);
      }
      if (convergence.n >= DEPRIORITISE_MIN_EVENTS && convergence.lowerBound !== null && convergence.lowerBound < 0 && convergence.mean !== null && convergence.mean < 0) {
        return to('deprioritised', 0, null, `convergence n=${convergence.n}, mean ${fmt(convergence.mean)} < 0, lower bound ${fmt(convergence.lowerBound)} < 0`);
      }
      return keep();
    }
    case 'suspended': {
      if (current.forced) return keep('forced by a human');
      if (!canTrade) return keep();
      // Only events whose forecasts all resolved after the suspension
      const after = input.skillVotes.filter((v) => v.firstAt > current.changedAt);
      const s = voteStats(after, input.seed);
      const recent = recentMean(after);
      if (s.n >= required && s.lowerBound !== null && s.lowerBound > 0 && recent !== null && recent >= 0) {
        return to('trading', Math.min(INITIAL_MAX_ALLOCATION_USD, budgetUsd), skill.n, `re-qualified on ${s.n} events scored after suspension, lower bound ${fmt(s.lowerBound)} > 0`);
      }
      return keep();
    }
    case 'deprioritised':
      return keep();
  }
}

// ─── Expected date to threshold ──────────────────────────────────────

export interface ThresholdEstimate {
  required: number;
  remaining: number;
  /** Scored events per day over the window */
  ratePerDay: number;
  /** ISO date the threshold is expected to be reached; null when no events were scored recently */
  expectedAt: string | null;
}

/**
 * Expected date a bucket reaches its event threshold from the recent rate of scored events
 * (spec §6.3: shown on the ledger page). `votes` are the bucket's event votes.
 */
export function expectedThresholdDate(votes: readonly EventVote[], required: number, now: number, windowDays = 30): ThresholdEstimate {
  const remaining = Math.max(0, required - votes.length);
  const since = now - windowDays * 86_400_000;
  const recent = votes.filter((v) => v.at > since && v.at <= now).length;
  const ratePerDay = recent / windowDays;
  if (remaining === 0) return { required, remaining, ratePerDay, expectedAt: new Date(now).toISOString() };
  if (ratePerDay <= 0) return { required, remaining, ratePerDay, expectedAt: null };
  return { required, remaining, ratePerDay, expectedAt: new Date(now + (remaining / ratePerDay) * 86_400_000).toISOString() };
}
