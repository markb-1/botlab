/**
 * Consistency (spec §9.3) — builtin per-opportunity template: one bot per relationship between markets.
 *
 * The config declares a logical constraint between binary markets (the YES token of each):
 *   - implies:       tokens [A, B]  — A implies B, so P(A) ≤ P(B)
 *   - date_ladder:   tokens [t1, t2, …] ordered by deadline (earliest first) — "by date 1" implies "by date 2",
 *                    so prices must be non-decreasing; every pair i < j is an `implies`
 *   - exclusive_sum: tokens [t1 … tn] — at most `max_sum` (an integer, default 1) of them resolve YES, so
 *                    Σ P(ti) ≤ max_sum. With `exhaustive: true` (exactly one resolves YES; max_sum must be 1)
 *                    the sum must also be ≥ 1. Exhaustiveness is NEVER assumed: "Other" outcomes, ties and
 *                    voids break it — set it only when the market rules guarantee exactly one winner.
 *
 * Polymarket has no shorting: "selling" the overpriced leg means BUYING ITS COMPLEMENT (the market's NO token,
 * read from ctx.polymarket.getMarket). Every trade is a basket of buys whose payoff floor follows from the constraint
 * — IF THE CONSTRAINT ACTUALLY HOLDS at resolution:
 *   - implies A ⇒ B violated (A priced above B):   buy B YES + A NO — pays ≥ 1
 *   - exclusive_sum violated (Σ YES > max_sum):      buy NO on all n legs — pays ≥ n − max_sum
 *   - exhaustive sum < 1:                            buy YES on all legs — pays exactly 1
 * The floor is not a guarantee: a wrongly declared constraint, rules that differ between the markets, or a 50-50 /
 * void ("unknown") resolution of any leg pays a fraction and can turn the basket into a loss. Declare only constraints
 * the resolution rules make certain. exclusive_sum legs must be markets of one event (all negRisk when any is);
 * `exhaustive` needs a negRisk event whose markets are exactly the configured legs.
 * The gap is payoff − Σ(best ask + taker fee at the ask) per share of each leg (fees per R125, on every leg), i.e.
 * measured at executable prices as if every leg were taken. A basket trades only when gap ≥ `min_gap`.
 *
 * Execution (one basket at a time):
 *   1. Every leg rests post-only one tick inside its ask (maker, no fee): s shares each, s bounded by `max_pair_usd`,
 *      the unhedged cap (s × (basket cost − cheapest leg) ≤ `max_unhedged_usd`: the worst case of all legs but
 *      one filling), the risk budget (remaining allocation, per-market room) and ≥ 5 shares.
 *   2. All legs filled ⇒ hedged; the next basket may open on a later cycle.
 *   3. After `hedge_timeout_minutes` with some legs filled and others not: the resting orders are cancelled and each
 *      missing leg is bought marketable up to its ask at opening + `max_slippage`, only while the hedged sets still
 *      cost ≤ the payoff (never a locked-in loss).
 *   4. Escalation impossible or unfilled ⇒ the basket is UNHEDGED: no new baskets. With `flatten_unhedged` (default)
 *      the bot sells the excess of the filled legs it holds (its own holdings, marketable at best bid −
 *      `max_slippage`; the risk engine's hold time may delay it); otherwise it keeps retrying the hedge and the
 *      Position Manager handles any risk exit (rules change, ambiguity, flags). No risk exits from this bot.
 * Before opening a basket it checks every leg against the Position Manager's risk triggers (ctx.risk.getExitPolicy):
 * an open exit flag, ambiguity ≥ its exit score (2) or unassessed, a dispute, a rules change in the last 7 days, or
 * ambiguity ≥ 1 inside its `exit_before_end_minutes` ⇒ no basket (the manager would sell a leg at once). A sell the
 * Position Manager placed on any constraint token (`placedBy` in the bot's orders) stops new baskets for good and
 * turns an open basket unhedged (handled as a failed hedge); the bot then asks to be retired once no basket is open.
 * Leftover imbalances under the 5-share order minimum are tracked across baskets; above `max_residual_usd` of naked
 * cost no new basket opens until they are flattened.
 * Retirement: the bot asks the server to retire it (ctx.requestRetire) when any market is closed (resolved) or the
 * gap stayed below `min_gap` for `idle_days` with no basket open. Every order passes the risk engine (markets must be
 * assessed for ambiguity, in the bot's market_ids, in allowed categories).
 * A config error (tokens not distinct, not YES tokens of binary markets, outside the bot's market_ids, ladder not
 * ordered by end date or with an unknown end date, exclusive_sum legs not one event) is logged and the bot does not
 * start.
 */

export const meta = {
  name: 'Consistency',
  description: 'Per-opportunity bot: trades violations of a declared constraint between markets (implies, date ladder, exclusive sum) with hedged baskets of buys (NO token = short)',
  version: '1.0.0',
  author: 'BotLab',
  // Builtin strategy role (5b; per opportunity, the agent may create these) and initial trust (§4.5: paper first)
  role: 'consistency',
  trust: 'new',
  configSchema: {
    type: 'object',
    required: ['constraint', 'tokens'],
    properties: {
      constraint: {
        type: 'string',
        title: 'Constraint',
        description: 'implies: tokens [A, B], P(A) ≤ P(B). date_ladder: tokens ordered by deadline, earliest first. exclusive_sum: Σ P ≤ max_sum',
        enum: ['implies', 'date_ladder', 'exclusive_sum'],
        default: 'implies',
      },
      tokens: {
        type: 'array',
        title: 'YES tokens',
        description: 'YES token ids of binary markets (one per line), in constraint order; every market must be in the bot’s market_ids',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 10,
        default: [],
      },
      max_sum: {
        type: 'integer',
        title: 'Max sum (exclusive_sum)',
        description: 'At most this many of the outcomes resolve YES (1 = mutually exclusive)',
        default: 1,
        minimum: 1,
        maximum: 9,
      },
      exhaustive: {
        type: 'boolean',
        title: 'Exhaustive (exclusive_sum)',
        description: 'Exactly one outcome resolves YES (rules guarantee it: no "Other", no void). Enables buying all YES when Σ < 1',
        default: false,
      },
      min_gap: {
        type: 'number',
        title: 'Minimum gap after fees',
        description: 'Guaranteed profit per basket share after taker fees at the asks',
        default: 0.03,
        minimum: 0.01,
        maximum: 0.5,
      },
      max_pair_usd: {
        type: 'number',
        title: 'Max per basket (USD)',
        description: 'Cost cap of one basket (all legs)',
        default: 20,
        minimum: 1,
      },
      max_unhedged_usd: {
        type: 'number',
        title: 'Max unhedged (USD)',
        description: 'Cap on the cost of legs that can be filled without their hedge (sizes the basket)',
        default: 10,
        minimum: 1,
      },
      hedge_timeout_minutes: {
        type: 'number',
        title: 'Hedge timeout (minutes)',
        description: 'After this, missing legs are bought marketable within max_slippage (or the basket is unhedged)',
        default: 15,
        minimum: 3,
        maximum: 240,
      },
      max_slippage: {
        type: 'number',
        title: 'Max slippage',
        description: 'Escalated legs pay at most their ask at opening plus this; flattening sells down to best bid minus this',
        default: 0.02,
        minimum: 0,
        maximum: 0.1,
      },
      flatten_unhedged: {
        type: 'boolean',
        title: 'Flatten unhedged legs',
        description: 'Sell the unhedged excess this bot holds (else keep retrying the hedge; the Position Manager handles risk exits)',
        default: true,
      },
      max_residual_usd: {
        type: 'number',
        title: 'Max residual imbalance (USD)',
        description: 'Leftover unhedged legs below the 5-share minimum, summed across baskets: above this no new basket opens',
        default: 2,
        minimum: 0,
      },
      idle_days: {
        type: 'number',
        title: 'Retire after idle (days)',
        description: 'Ask to be retired when the gap stayed below min_gap this long with no basket open',
        default: 7,
        minimum: 1,
        maximum: 90,
      },
      check_minutes: {
        type: 'number',
        title: 'Check every (minutes)',
        default: 2,
        minimum: 1,
        maximum: 60,
      },
      pollingIntervalMs: {
        type: 'number',
        title: 'Tick interval (ms)',
        default: 30000,
        minimum: 5000,
      },
    },
  },
};

const MIN_SHARES = 5;
const MIN_PRICE = 0.01;
const MAX_PRICE = 0.99;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
/** After a basket failed to open, wait this long before the next attempt (avoids rejection storms) */
const OPEN_RETRY_MS = 15 * MIN_MS;
/** Marketable escalation orders live this long (GTD minimum) */
const ESCALATE_TTL_MINUTES = 3;
const STATE_KEY = 'consistency:state';
const EPS = 1e-6;

export type ConstraintType = 'implies' | 'date_ladder' | 'exclusive_sum';

export interface ConsistencyConfig {
  constraint: ConstraintType;
  tokens: string[];
  maxSum: number;
  exhaustive: boolean;
  minGap: number;
  maxPairUsd: number;
  maxUnhedgedUsd: number;
  hedgeTimeoutMinutes: number;
  maxSlippage: number;
  flattenUnhedged: boolean;
  maxResidualUsd: number;
  idleDays: number;
  checkMinutes: number;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const floorTick = (p: number, tick: number): number => round6(Math.floor(p / tick + 1e-9) * tick);
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Config with defaults and bounds, plus the structural errors (markets are checked by resolveLegs). */
export function consistencyConfig(raw: Record<string, any>): { cfg: ConsistencyConfig; errors: string[] } {
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : d);
  const errors: string[] = [];
  const constraint = raw.constraint;
  if (constraint !== 'implies' && constraint !== 'date_ladder' && constraint !== 'exclusive_sum') {
    errors.push(`constraint must be implies, date_ladder or exclusive_sum (got ${JSON.stringify(constraint)})`);
  }
  const rawTokens: unknown[] = Array.isArray(raw.tokens) ? raw.tokens : [];
  const tokens = rawTokens.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim());
  if (tokens.length !== rawTokens.length) errors.push('tokens must be non-empty token id strings');
  if (new Set(tokens).size !== tokens.length) errors.push('tokens must be distinct');
  if (constraint === 'implies' && tokens.length !== 2) errors.push('implies needs exactly 2 tokens [A, B] (A implies B)');
  if ((constraint === 'date_ladder' || constraint === 'exclusive_sum') && (tokens.length < 2 || tokens.length > 10)) errors.push(`${constraint} needs 2 to 10 tokens`);
  const maxSum = num(raw.max_sum, 1);
  const exhaustive = bool(raw.exhaustive, false);
  if (constraint === 'exclusive_sum') {
    if (!Number.isInteger(maxSum) || maxSum < 1 || maxSum > tokens.length - 1) errors.push(`max_sum must be an integer from 1 to ${Math.max(tokens.length - 1, 1)}`);
    if (exhaustive && maxSum !== 1) errors.push('exhaustive needs max_sum 1 (exactly one outcome resolves YES)');
  } else if (exhaustive) {
    errors.push('exhaustive applies to exclusive_sum only');
  }
  const cfg: ConsistencyConfig = {
    constraint: (constraint as ConstraintType) ?? 'implies',
    tokens,
    maxSum,
    exhaustive,
    minGap: Math.max(num(raw.min_gap, 0.03), 0.01),
    maxPairUsd: Math.max(num(raw.max_pair_usd, 20), 0),
    maxUnhedgedUsd: Math.max(num(raw.max_unhedged_usd, 10), 0),
    hedgeTimeoutMinutes: Math.max(num(raw.hedge_timeout_minutes, 15), 3),
    maxSlippage: Math.min(Math.max(num(raw.max_slippage, 0.02), 0), 0.1),
    flattenUnhedged: bool(raw.flatten_unhedged, true),
    maxResidualUsd: Math.max(num(raw.max_residual_usd, 2), 0),
    idleDays: Math.max(num(raw.idle_days, 7), 1),
    checkMinutes: Math.max(num(raw.check_minutes, 2), 1),
  };
  return { cfg, errors };
}

/** One market of the constraint: its YES token (from the config) and NO token (its complement), and its risk state. */
export interface LegMarket {
  marketId: string;
  eventId: string;
  negRisk: boolean;
  yes: string;
  no: string;
  question: string;
  endDate: string | null;
  closed: boolean;
  ambiguityScore: number | null;
  disputed: boolean;
  rulesChangedAt: string | null;
}

/**
 * Resolve the config's tokens to markets and check them: each must be the YES token of a binary market the bot is
 * scoped to, all in distinct markets; a date ladder needs every end date, ordered (earliest first); exclusive_sum legs
 * must be markets of one event (all negRisk when any is); `exhaustive` needs a negRisk event whose markets
 * (`eventMarkets`, every market of the event) are exactly the legs — an "Other" or sibling outcome breaks it.
 */
export function checkLegs(
  cfg: ConsistencyConfig,
  markets: Array<MarketDetail | null>,
  eventMarkets: string[] | null = null
): { legs: LegMarket[]; errors: string[] } {
  const errors: string[] = [];
  const legs: LegMarket[] = [];
  cfg.tokens.forEach((t, i) => {
    const m = markets[i];
    if (!m) return errors.push(`token ${t}: market unknown`);
    if (m.tokens.length !== 2 || !m.complementTokenId) return errors.push(`token ${t}: not a binary market (${m.tokens.length} outcomes)`);
    if (!/^yes$/i.test(m.outcome ?? '')) return errors.push(`token ${t}: outcome "${m.outcome}" is not the YES token of "${m.question}"`);
    if (!m.inScope) return errors.push(`token ${t}: market ${m.marketId} is not in the bot's market_ids`);
    legs.push({
      marketId: m.marketId,
      eventId: m.eventId,
      negRisk: m.negRisk,
      yes: t,
      no: m.complementTokenId,
      question: m.question,
      endDate: m.endDate,
      closed: m.closed,
      ambiguityScore: m.ambiguityScore,
      disputed: m.disputed,
      rulesChangedAt: m.rulesChangedAt,
    });
  });
  if (new Set(legs.map((l) => l.marketId)).size !== legs.length) errors.push('every token must be in a different market');
  if (legs.length !== cfg.tokens.length) return { legs, errors };
  if (cfg.constraint === 'date_ladder') {
    for (const l of legs) if (!l.endDate || !Number.isFinite(Date.parse(l.endDate))) errors.push(`date_ladder: "${l.question}" has no known end date (the order cannot be checked)`);
    for (let i = 1; i < legs.length; i++) {
      const a = legs[i - 1].endDate ? Date.parse(legs[i - 1].endDate as string) : NaN;
      const b = legs[i].endDate ? Date.parse(legs[i].endDate as string) : NaN;
      if (Number.isFinite(a) && Number.isFinite(b) && a > b) errors.push(`date_ladder tokens must be ordered by deadline: "${legs[i - 1].question}" ends after "${legs[i].question}"`);
    }
  }
  if (cfg.constraint === 'exclusive_sum') {
    if (new Set(legs.map((l) => l.eventId)).size !== 1) errors.push('exclusive_sum: every token must be a market of the same event (mutually exclusive outcomes)');
    else if (legs.some((l) => l.negRisk) && !legs.every((l) => l.negRisk)) errors.push('exclusive_sum: mixed negRisk and plain markets in one event');
    if (cfg.exhaustive) {
      if (!legs.every((l) => l.negRisk)) errors.push('exhaustive: the legs must be the markets of one negRisk event');
      else if (!eventMarkets) errors.push('exhaustive: the event\'s market list is unknown (cannot check that the legs cover every outcome)');
      else {
        const legSet = new Set(legs.map((l) => l.marketId));
        const outside = eventMarkets.filter((id) => !legSet.has(id));
        if (outside.length > 0 || eventMarkets.length !== legs.length) {
          errors.push(`exhaustive: the event has ${eventMarkets.length} markets but ${legs.length} legs (an outcome outside tokens, e.g. "Other", would break exhaustiveness)`);
        }
      }
    }
  }
  return { legs, errors };
}

/**
 * Why no basket may open now because the Position Manager would exit a leg at once (5b review), or null: an open
 * exit flag on a constraint token, ambiguity unassessed or ≥ its exit score, a dispute, a rules change in the last
 * 7 days (also when the risk engine refuses buys), or ambiguity ≥ 1 inside its exit window before the end.
 */
export function openBlocker(legs: LegMarket[], policy: ExitPolicy, flags: BotExitFlag[], now: number): string | null {
  const tokens = new Set(legs.flatMap((l) => [l.yes, l.no]));
  const flag = flags.find((f) => tokens.has(f.tokenId));
  if (flag) return `exit flag open on ${flag.tokenId}`;
  for (const l of legs) {
    if (l.ambiguityScore === null) return `"${l.question}" is not assessed for ambiguity`;
    if (l.ambiguityScore >= policy.ambiguityExitScore) return `"${l.question}" ambiguity ${l.ambiguityScore} ≥ ${policy.ambiguityExitScore}`;
    if (l.disputed) return `"${l.question}" is disputed`;
    const changed = l.rulesChangedAt ? Date.parse(l.rulesChangedAt) : NaN;
    if (Number.isFinite(changed) && now - changed < 7 * DAY_MS) return `"${l.question}" rules changed ${l.rulesChangedAt}`;
    const end = l.endDate ? Date.parse(l.endDate) : NaN;
    if (l.ambiguityScore >= 1 && Number.isFinite(end) && (end - now) / MIN_MS <= policy.exitBeforeEndMinutes) {
      return `"${l.question}" ambiguity ${l.ambiguityScore} within ${policy.exitBeforeEndMinutes} min of the end (Position Manager exit window)`;
    }
  }
  return null;
}

/** A basket of buys whose payoff (per share of every leg) the constraint guarantees. */
export interface Basket {
  label: string;
  legs: Array<{ tokenId: string; marketId: string }>;
  payoff: number;
}

/** The baskets that profit from a violation of the constraint (spec §9.3; no shorting ⇒ complement tokens). */
export function basketsFor(cfg: ConsistencyConfig, legs: LegMarket[]): Basket[] {
  const out: Basket[] = [];
  const pairFor = (a: LegMarket, b: LegMarket, ia: number, ib: number): Basket => ({
    // A implies B, A overpriced vs B: buy B YES (the underpriced leg) and A NO (the complement of the overpriced one)
    label: `buy #${ib + 1} YES + #${ia + 1} NO`,
    legs: [
      { tokenId: b.yes, marketId: b.marketId },
      { tokenId: a.no, marketId: a.marketId },
    ],
    payoff: 1,
  });
  if (cfg.constraint === 'implies' && legs.length === 2) out.push(pairFor(legs[0], legs[1], 0, 1));
  if (cfg.constraint === 'date_ladder') {
    for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) out.push(pairFor(legs[i], legs[j], i, j));
  }
  if (cfg.constraint === 'exclusive_sum' && legs.length >= 2) {
    // At most max_sum YES ⇒ at least n − max_sum NO tokens pay 1
    out.push({ label: `buy NO on all ${legs.length}`, legs: legs.map((l) => ({ tokenId: l.no, marketId: l.marketId })), payoff: legs.length - cfg.maxSum });
    // Exactly one YES (only when declared exhaustive) ⇒ the YES basket pays exactly 1
    if (cfg.exhaustive && cfg.maxSum === 1) out.push({ label: `buy YES on all ${legs.length}`, legs: legs.map((l) => ({ tokenId: l.yes, marketId: l.marketId })), payoff: 1 });
  }
  return out;
}

export interface Top {
  bestBid: number | null;
  bestAsk: number | null;
  tick: number;
}

export function topOf(book: OrderBook): Top {
  let bestBid: number | null = null;
  let bestAsk: number | null = null;
  for (const l of book.bids ?? []) {
    const p = parseFloat(l.price);
    if (Number.isFinite(p) && parseFloat(l.size) > 0 && (bestBid === null || p > bestBid)) bestBid = p;
  }
  for (const l of book.asks ?? []) {
    const p = parseFloat(l.price);
    if (Number.isFinite(p) && parseFloat(l.size) > 0 && (bestAsk === null || p < bestAsk)) bestAsk = p;
  }
  const t = parseFloat(String(book.tick_size ?? ''));
  return { bestBid, bestAsk, tick: Number.isFinite(t) && t > 0 && t < 1 ? t : 0.01 };
}

/** Fee per share at price c (R125): 'price' ⇒ rate × c × (1 − c); 'notional' ⇒ rate × c. */
export function feePerShare(rate: number, formula: string, c: number): number {
  return formula === 'price' ? rate * c * (1 - c) : rate * c;
}

/** Executable price of one token: best ask + taker fee at it (what buying it now costs per share). */
export interface LegPrice {
  top: Top;
  fee: FeeRates;
}

export interface Opportunity {
  basket: Basket;
  /** Σ (ask + taker fee) per share of each leg; null when a leg has no ask */
  cost: number | null;
  /** payoff − cost (after fees); null when a leg has no ask */
  gap: number | null;
  /** Per leg: ask, taker fee per share at the ask, resting price (one tick inside the ask) */
  legs: Array<{ tokenId: string; marketId: string; ask: number | null; takerFee: number; restPrice: number | null; tick: number }>;
}

/** Price every basket at executable prices (asks + taker fee per leg). */
export function evaluate(baskets: Basket[], prices: Record<string, LegPrice>): Opportunity[] {
  return baskets.map((b) => {
    let cost: number | null = 0;
    const legs = b.legs.map((l) => {
      const p = prices[l.tokenId];
      const ask = p?.top.bestAsk ?? null;
      const tick = p?.top.tick ?? 0.01;
      const takerFee = ask !== null && p ? feePerShare(p.fee.takerRate || 0, p.fee.formula, ask) : 0;
      if (ask === null) cost = null;
      else if (cost !== null) cost += ask + takerFee;
      const rest = ask !== null ? floorTick(ask - tick, tick) : null;
      return { tokenId: l.tokenId, marketId: l.marketId, ask, takerFee, restPrice: rest !== null && rest >= MIN_PRICE - 1e-9 ? rest : null, tick };
    });
    const c = cost as number | null;
    return { basket: b, cost: c === null ? null : round6(c), gap: c === null ? null : round6(b.payoff - c), legs };
  });
}

/** The best opportunity (largest gap), or null when no basket can be priced. */
export function bestOpportunity(opps: Opportunity[]): Opportunity | null {
  let best: Opportunity | null = null;
  for (const o of opps) if (o.gap !== null && (best === null || (best.gap as number) < o.gap)) best = o;
  return best;
}

/**
 * Shares per leg for a basket: s × cost ≤ max_pair_usd; s × (cost − cheapest leg) ≤ max_unhedged_usd (all legs but
 * one filled); s × ask ≤ the budget's room in each leg's market; s × cost ≤ remaining allocation. 0 when < 5 shares
 * or a leg cannot rest.
 */
export function basketSize(
  opp: Opportunity,
  cfg: ConsistencyConfig,
  budget: { remainingAllocation: number; remainingMarket: Record<string, number> }
): number {
  if (opp.cost === null || opp.legs.some((l) => l.ask === null || l.restPrice === null)) return 0;
  const legCosts = opp.legs.map((l) => (l.ask as number) + l.takerFee);
  const cost = opp.cost;
  const unhedgedPerShare = cost - Math.min(...legCosts);
  let s = Math.min(cfg.maxPairUsd / cost, unhedgedPerShare > 0 ? cfg.maxUnhedgedUsd / unhedgedPerShare : Infinity, Math.max(budget.remainingAllocation, 0) / cost);
  // Two legs in one market (not possible after checkLegs) would share the room; sum per market to be safe
  const perMarket: Record<string, number> = {};
  opp.legs.forEach((l, i) => (perMarket[l.marketId] = (perMarket[l.marketId] ?? 0) + legCosts[i]));
  for (const [m, c] of Object.entries(perMarket)) if (m in budget.remainingMarket) s = Math.min(s, Math.max(budget.remainingMarket[m], 0) / c);
  const shares = Math.floor(s * 100 + 1e-6) / 100;
  return shares >= MIN_SHARES ? shares : 0;
}

// ─── Basket state ──────────────────────────────────────────────────────

export interface LegState {
  tokenId: string;
  marketId: string;
  /** Resting (post-only) price */
  price: number;
  /** Ask when the basket opened (escalation bound: + max_slippage) */
  askAtOpen: number;
  /** This leg's buy orders (resting, re-placed, escalated) */
  orderIds: string[];
  /** Flattening sells of this leg's excess */
  sellIds: string[];
  /** Net shares held from this basket: bought − sold */
  filled: number;
  escalated: boolean;
}

export interface BasketState {
  openedAt: number;
  label: string;
  payoff: number;
  /** Shares per leg */
  target: number;
  phase: 'resting' | 'escalating' | 'unhedged';
  escalatedAt: number | null;
  legs: LegState[];
}

export interface BotState {
  startedAt: number;
  /** Last cycle with a gap ≥ min_gap (or a basket open) */
  lastActiveAt: number;
  basket: BasketState | null;
  retryAfter: number;
  baskets: number;
  hedged: number;
  lastGap: number | null;
  lastLabel: string | null;
  lastEmit: { gap: number | null; phase: string; at: number } | null;
  /** Set (for good) when the Position Manager sold a constraint token of this bot: no new baskets */
  pmExit?: string | null;
  /** Leftover imbalances under the order minimum, per token: shares and cost per share (naked exposure) */
  residual?: Record<string, { shares: number; price: number }>;
}

export function freshState(now: number): BotState {
  return { startedAt: now, lastActiveAt: now, basket: null, retryAfter: 0, baskets: 0, hedged: 0, lastGap: null, lastLabel: null, lastEmit: null, pmExit: null, residual: {} };
}

/**
 * Highest price each missing leg may be bought at when escalating, or null when the hedge is impossible: ask now ≤
 * ask at opening + max_slippage, and the fully hedged basket (filled legs at their resting price, missing legs at
 * that limit + taker fee) still costs ≤ the payoff.
 */
export function escalationLimits(
  basket: BasketState,
  prices: Record<string, LegPrice>,
  cfg: ConsistencyConfig
): Record<string, number> | null {
  const maxFilled = Math.max(...basket.legs.map((l) => l.filled));
  const out: Record<string, number> = {};
  let cost = 0;
  for (const l of basket.legs) {
    const missing = maxFilled - l.filled > EPS;
    if (!missing) {
      cost += l.price;
      continue;
    }
    const p = prices[l.tokenId];
    const ask = p?.top.bestAsk ?? null;
    if (ask === null) return null;
    const limit = floorTick(Math.min(l.askAtOpen + cfg.maxSlippage, MAX_PRICE), p.top.tick);
    if (ask > limit + 1e-9) return null;
    out[l.tokenId] = limit;
    cost += limit + feePerShare(p.fee.takerRate || 0, p.fee.formula, limit);
  }
  return cost <= basket.payoff + 1e-9 ? out : null;
}

export interface CycleResult {
  action: 'none' | 'opened' | 'resting' | 'hedged' | 'escalated' | 'unhedged' | 'flattened' | 'abandoned' | 'retire' | 'halted' | 'invalid';
  gap: number | null;
  label: string | null;
  detail?: string;
}

async function cancelQuietly(ctx: BotContext, orderId: string): Promise<void> {
  try {
    await ctx.polymarket.cancel(orderId);
  } catch {
    /* filled, expired or gone */
  }
}

/** Resolve and check the config's markets (throws nothing; errors are returned). */
export async function loadLegs(ctx: BotContext, cfg: ConsistencyConfig): Promise<{ legs: LegMarket[]; errors: string[] }> {
  const markets: Array<MarketDetail | null> = [];
  for (const t of cfg.tokens) {
    try {
      markets.push(await ctx.polymarket.getMarket(t));
    } catch {
      markets.push(null);
    }
  }
  let eventMarkets: string[] | null = null;
  const first = markets[0];
  if (cfg.constraint === 'exclusive_sum' && cfg.exhaustive && first) {
    try {
      eventMarkets = await ctx.polymarket.getEventMarketIds(first.eventId);
    } catch {
      eventMarkets = null;
    }
  }
  return checkLegs(cfg, markets, eventMarkets);
}

async function priceTokens(ctx: BotContext, tokens: string[]): Promise<Record<string, LegPrice>> {
  const out: Record<string, LegPrice> = {};
  for (const t of [...new Set(tokens)]) {
    try {
      const [book, fee] = await Promise.all([ctx.getOrderBook(t), ctx.polymarket.getFee(t)]);
      out[t] = { top: topOf(book), fee };
    } catch (err) {
      ctx.log.warn(`consistency: no price for ${t}: ${errMsg(err)}`);
    }
  }
  return out;
}

/** This bot's orders: open ones and the last 30 days of history (fills, Position Manager sells). */
interface OrderView {
  open: OpenOrder[];
  history: OrderHistoryEntry[];
}

async function readOrders(ctx: BotContext): Promise<OrderView> {
  return { open: await ctx.polymarket.getOpenOrders(), history: await ctx.polymarket.getOrderHistory(30) };
}

/** Sells the Position Manager placed on this bot's positions (`placedBy` set) in any of `tokens`. */
export function pmSells(view: OrderView, tokens: Set<string>): Array<{ orderId: string; tokenId: string; filled: number; createdAt: number }> {
  const out = new Map<string, { orderId: string; tokenId: string; filled: number; createdAt: number }>();
  for (const o of [...view.history, ...view.open]) {
    if (!o.placedBy || o.side !== 'sell' || !tokens.has(o.tokenId)) continue;
    const prev = out.get(o.orderId);
    const at = Date.parse(o.createdAt);
    out.set(o.orderId, { orderId: o.orderId, tokenId: o.tokenId, filled: Math.max(prev?.filled ?? 0, o.filledSize), createdAt: Number.isFinite(at) ? at : 0 });
  }
  return [...out.values()];
}

/**
 * Set each leg's net filled shares (bought − own flattening sells − Position Manager sells since the basket opened)
 * and return the ids of the basket's still-open buy orders and whether the Position Manager sold one of its legs.
 */
export function applyFills(basket: BasketState, view: OrderView): { openIds: Set<string>; pmHit: boolean } {
  const openIds = new Set(view.open.filter((o) => !o.placedBy).map((o) => o.orderId));
  const filledOf = (id: string) => Math.max(view.history.find((x) => x.orderId === id)?.filledSize ?? 0, view.open.find((x) => x.orderId === id)?.filledSize ?? 0);
  const pm = pmSells(view, new Set(basket.legs.map((l) => l.tokenId))).filter((x) => x.createdAt >= basket.openedAt - 1000);
  for (const leg of basket.legs) {
    const bought = leg.orderIds.reduce((n, id) => n + filledOf(id), 0);
    const sold = (leg.sellIds ?? []).reduce((n, id) => n + filledOf(id), 0);
    const pmSold = pm.filter((x) => x.tokenId === leg.tokenId).reduce((n, x) => n + x.filled, 0);
    leg.filled = round6(Math.max(bought - sold - pmSold, 0));
  }
  return { openIds: new Set(basket.legs.flatMap((l) => l.orderIds).filter((id) => openIds.has(id))), pmHit: pm.length > 0 };
}

/** One cycle (exported for tests; the lifecycle below calls it). State is read from and saved to ctx.storage. */
export async function runConsistencyCycle(ctx: BotContext): Promise<CycleResult> {
  const now = ctx.now;
  const { cfg, errors } = consistencyConfig(ctx.config);
  if (errors.length) return { action: 'invalid', gap: null, label: null, detail: errors.join('; ') };
  const state: BotState = (await ctx.storage.get<BotState>(STATE_KEY)) ?? freshState(now);
  const save = () => ctx.storage.set(STATE_KEY, state);

  const { legs, errors: legErrors } = await loadLegs(ctx, cfg);
  if (legErrors.length) {
    ctx.log.error(`consistency: ${legErrors.join('; ')}`);
    return { action: 'invalid', gap: null, label: null, detail: legErrors.join('; ') };
  }

  // A resolved (closed) market ends the opportunity: drop resting orders and ask to be retired
  const closed = legs.find((l) => l.closed);
  if (closed) {
    if (state.basket) for (const l of state.basket.legs) for (const id of l.orderIds) await cancelQuietly(ctx, id);
    await save();
    return { action: 'retire', gap: state.lastGap, label: state.lastLabel, detail: `market closed: ${closed.question}` };
  }

  const budget = await ctx.risk.getBudget();
  const baskets = basketsFor(cfg, legs);
  const allTokens = [...new Set([...baskets.flatMap((b) => b.legs.map((l) => l.tokenId)), ...(state.basket?.legs.map((l) => l.tokenId) ?? [])])];
  const prices = await priceTokens(ctx, allTokens);
  const best = bestOpportunity(evaluate(baskets, prices));
  state.lastGap = best?.gap ?? null;
  state.lastLabel = best?.basket.label ?? null;
  const result = (action: CycleResult['action'], detail?: string): CycleResult => ({ action, gap: state.lastGap, label: state.lastLabel, ...(detail ? { detail } : {}) });

  if (budget.halted) {
    // Halted: the server refuses orders; drop our resting legs (the basket state and its timer stay)
    if (state.basket) for (const l of state.basket.legs) for (const id of l.orderIds) await cancelQuietly(ctx, id);
    await save();
    return result('halted');
  }

  // A sell the Position Manager placed on any constraint token: it is exiting on a risk trigger — stop for good
  let view = await readOrders(ctx);
  const constraintTokens = new Set(legs.flatMap((l) => [l.yes, l.no]));
  const pmAny = pmSells(view, constraintTokens);
  if (pmAny.length > 0 && !state.pmExit) {
    state.pmExit = `position manager sold ${pmAny[0].tokenId}`;
    ctx.log.warn(`consistency: ${state.pmExit}; no new baskets`);
  }
  state.residual = state.residual ?? {};

  /** Record what is left unbalanced below the order minimum as naked residual, and close the basket */
  const acceptDust = (bk: BasketState): number => {
    const min = Math.min(...bk.legs.map((l) => l.filled));
    let shares = 0;
    for (const l of bk.legs) {
      const excess = round6(l.filled - min);
      if (excess <= EPS) continue;
      const r = state.residual![l.tokenId] ?? { shares: 0, price: 0 };
      const total = r.shares + excess;
      state.residual![l.tokenId] = { shares: round6(total), price: round6((r.shares * r.price + excess * l.price) / total) };
      shares += excess;
    }
    state.basket = null;
    if (min > EPS) state.hedged++;
    return round6(shares);
  };

  const b = state.basket;
  if (b) {
    state.lastActiveAt = now;
    let fills = applyFills(b, view);
    let openIds = fills.openIds;
    const cancelOpen = async () => {
      for (const id of openIds) await cancelQuietly(ctx, id);
    };
    const refresh = async () => {
      view = await readOrders(ctx);
      fills = applyFills(b, view);
      openIds = fills.openIds;
    };
    // The Position Manager sold a leg of this basket: it is no longer hedged — handle it as a failed hedge
    if (fills.pmHit && b.phase !== 'unhedged') {
      await cancelOpen();
      await refresh();
      b.phase = 'unhedged';
      ctx.log.warn(`consistency: position manager exit on ${b.label}; basket unhedged`);
    }
    let maxF = Math.max(...b.legs.map((l) => l.filled));
    let minF = Math.min(...b.legs.map((l) => l.filled));

    // Every leg filled to the target, or every leg level after the timeout: hedged
    if (minF >= b.target - EPS || (b.phase !== 'resting' && maxF - minF < EPS && maxF > EPS)) {
      await cancelOpen();
      state.basket = null;
      state.hedged++;
      await save();
      return result('hedged', `${b.label}: ${minF} shares per leg`);
    }

    if (b.phase === 'resting' && now - b.openedAt < cfg.hedgeTimeoutMinutes * MIN_MS) {
      // Re-place legs whose resting order expired / was cancelled, at the same price or lower
      for (const leg of b.legs) {
        if (leg.orderIds.some((id) => openIds.has(id)) || leg.filled >= b.target - EPS) continue;
        const p = prices[leg.tokenId];
        const ask = p?.top.bestAsk ?? null;
        const price = ask !== null ? Math.min(leg.price, floorTick(ask - p.top.tick, p.top.tick)) : leg.price;
        const size = Math.floor((b.target - leg.filled) * 100) / 100;
        if (size < MIN_SHARES || price < MIN_PRICE) continue;
        const ttl = Math.max(3, Math.ceil(cfg.hedgeTimeoutMinutes - (now - b.openedAt) / MIN_MS) + 2);
        const r = await ctx.polymarket.placeLimit(leg.tokenId, 'buy', price, size, { postOnly: true, ttlMinutes: ttl, reason: `consistency: ${b.label} (re-placed leg)` });
        if (r.ok && r.orderId) leg.orderIds.push(r.orderId);
        else ctx.log.info(`consistency: re-placing leg ${leg.tokenId} failed: ${r.error ?? r.status}`);
      }
      await save();
      return result('resting');
    }

    // Timeout passed (or escalation already tried)
    if (maxF < EPS) {
      // Nothing filled: no exposure, drop the basket
      await cancelOpen();
      state.basket = null;
      state.retryAfter = now + OPEN_RETRY_MS;
      await save();
      return result('abandoned', b.phase === 'resting' ? `${b.label}: no leg filled within ${cfg.hedgeTimeoutMinutes} min` : `${b.label}: nothing held any more`);
    }
    if (maxF - minF < MIN_SHARES) {
      // Imbalance below the exchange minimum order size: cannot be traded either way, keep it as tracked residual
      await cancelOpen();
      const dust = acceptDust(b);
      await save();
      return result('hedged', `${b.label}: ${minF} hedged, ${dust} shares of residual imbalance (below the minimum order)`);
    }

    if (b.phase === 'resting' || (b.phase === 'unhedged' && !cfg.flattenUnhedged)) {
      await cancelOpen();
      // A leg may have filled while it was being cancelled: re-read the fills before sizing the hedge
      await refresh();
      maxF = Math.max(...b.legs.map((l) => l.filled));
      minF = Math.min(...b.legs.map((l) => l.filled));
      if (maxF - minF < MIN_SHARES) {
        const dust = acceptDust(b);
        await save();
        return result('hedged', `${b.label}: legs level after the cancel (${minF} per leg${dust > 0 ? `, ${dust} shares residual` : ''})`);
      }
      const limits = escalationLimits(b, prices, cfg);
      if (!limits) {
        b.phase = 'unhedged';
        await save();
        return result('unhedged', `${b.label}: hedge not available within max_slippage at break-even`);
      }
      let placed = 0;
      for (const leg of b.legs) {
        const need = Math.floor((maxF - leg.filled) * 100) / 100;
        if (need < MIN_SHARES || limits[leg.tokenId] === undefined) continue;
        const r = await ctx.polymarket.placeLimit(leg.tokenId, 'buy', limits[leg.tokenId], need, {
          postOnly: false,
          ttlMinutes: ESCALATE_TTL_MINUTES,
          reason: `consistency: ${b.label} (hedge escalated)`,
        });
        if (r.ok && r.orderId) {
          leg.orderIds.push(r.orderId);
          leg.escalated = true;
          // Conservative cost for later break-even checks: the escalated part may have paid up to the limit
          leg.price = Math.max(leg.price, limits[leg.tokenId]);
          placed++;
        } else ctx.log.warn(`consistency: escalation of ${leg.tokenId} failed: ${r.error ?? r.status}`);
      }
      b.phase = placed > 0 ? 'escalating' : 'unhedged';
      b.escalatedAt = now;
      await save();
      return result(placed > 0 ? 'escalated' : 'unhedged', b.label);
    }

    if (b.phase === 'escalating') {
      // Escalation orders still working: wait for them (they expire after a few minutes)
      if (openIds.size > 0 && now - (b.escalatedAt ?? now) < (ESCALATE_TTL_MINUTES + 2) * MIN_MS) {
        await save();
        return result('escalated', `${b.label}: waiting for the escalated legs`);
      }
      await cancelOpen();
      b.phase = 'unhedged';
      await save();
      return result('unhedged', `${b.label}: escalated legs did not fill`);
    }

    // Unhedged with flatten: sell the excess of the filled legs (own holdings only, never a risk exit)
    await cancelOpen();
    const positions = await ctx.getPositions();
    let sold = 0;
    for (const leg of b.legs) {
      const excess = leg.filled - minF;
      const held = positions.find((p) => p.tokenId === leg.tokenId)?.size ?? 0;
      const size = Math.floor(Math.min(excess, held) * 100) / 100;
      if (size < MIN_SHARES) continue;
      const top = prices[leg.tokenId]?.top;
      if (!top || top.bestBid === null) continue;
      const price = Math.max(floorTick(top.bestBid - cfg.maxSlippage, top.tick), MIN_PRICE);
      const r = await ctx.polymarket.placeLimit(leg.tokenId, 'sell', price, size, { postOnly: false, ttlMinutes: ESCALATE_TTL_MINUTES, reason: `consistency: flatten unhedged ${b.label}` });
      if (r.orderId) leg.sellIds = [...(leg.sellIds ?? []), r.orderId];
      if (r.ok && r.filledSize > 0) {
        leg.filled = round6(leg.filled - r.filledSize);
        sold++;
      } else if (!r.ok) ctx.log.info(`consistency: flatten of ${leg.tokenId} not done yet: ${r.error ?? r.status}`);
      if (r.ok && r.orderId && r.filledSize < size) await cancelQuietly(ctx, r.orderId);
    }
    if (Math.max(...b.legs.map((l) => l.filled)) - minF < MIN_SHARES) {
      acceptDust(b);
      state.retryAfter = now + OPEN_RETRY_MS;
    }
    await save();
    return result('flattened', `${b.label}: sold ${sold} leg(s)`);
  }

  // No basket open. After a Position Manager exit this bot is done: ask to be retired
  if (state.pmExit) {
    await save();
    return result('retire', `${state.pmExit}: stopped opening baskets`);
  }

  // Residual imbalances: flatten what reaches the order minimum (own holdings), refuse new baskets above the cap
  if (cfg.flattenUnhedged) {
    let positions: Position[] | null = null;
    for (const [tokenId, r] of Object.entries(state.residual)) {
      if (r.shares < MIN_SHARES) continue;
      positions = positions ?? (await ctx.getPositions());
      const held = positions.find((p) => p.tokenId === tokenId)?.size ?? 0;
      const size = Math.floor(Math.min(r.shares, held) * 100) / 100;
      const top = prices[tokenId]?.top;
      if (size < MIN_SHARES || !top || top.bestBid === null) continue;
      const price = Math.max(floorTick(top.bestBid - cfg.maxSlippage, top.tick), MIN_PRICE);
      const res = await ctx.polymarket.placeLimit(tokenId, 'sell', price, size, { postOnly: false, ttlMinutes: ESCALATE_TTL_MINUTES, reason: 'consistency: flatten residual imbalance' });
      if (res.ok && res.filledSize > 0) r.shares = round6(Math.max(r.shares - res.filledSize, 0));
      if (res.ok && res.orderId && res.filledSize < size) await cancelQuietly(ctx, res.orderId);
    }
    for (const [tokenId, r] of Object.entries(state.residual)) if (r.shares <= EPS) delete state.residual[tokenId];
  }
  const residualUsd = Object.values(state.residual).reduce((n, r) => n + r.shares * r.price, 0);

  if (best && best.gap !== null && best.gap + 1e-9 >= cfg.minGap) {
    state.lastActiveAt = now;
    if (now < state.retryAfter) {
      await save();
      return result('none', 'waiting after a failed basket');
    }
    if (residualUsd > cfg.maxResidualUsd + 1e-9) {
      await save();
      return result('none', `residual imbalance $${residualUsd.toFixed(2)} > max_residual_usd ${cfg.maxResidualUsd}: flatten it first`);
    }
    // Do not buy what the Position Manager would sell at once (its triggers, its exit window)
    const blocker = openBlocker(legs, await ctx.risk.getExitPolicy(), await ctx.risk.getExitFlags(), now);
    if (blocker) {
      await save();
      return result('none', `no basket: ${blocker}`);
    }
    const shares = basketSize(best, cfg, budget);
    if (shares <= 0) {
      await save();
      return result('none', 'gap found but no size (budget, caps or minimum order)');
    }
    const basket: BasketState = {
      openedAt: now,
      label: best.basket.label,
      payoff: best.basket.payoff,
      target: shares,
      phase: 'resting',
      escalatedAt: null,
      legs: best.legs.map((l) => ({ tokenId: l.tokenId, marketId: l.marketId, price: l.restPrice as number, askAtOpen: l.ask as number, orderIds: [], sellIds: [], filled: 0, escalated: false })),
    };
    const ttl = Math.max(3, Math.ceil(cfg.hedgeTimeoutMinutes) + 2);
    for (const leg of basket.legs) {
      const r = await ctx.polymarket.placeLimit(leg.tokenId, 'buy', leg.price, shares, {
        postOnly: true,
        ttlMinutes: ttl,
        reason: `consistency: ${best.basket.label}, gap ${(best.gap as number).toFixed(3)} after fees`,
      });
      if (r.ok && r.orderId) {
        leg.orderIds.push(r.orderId);
        continue;
      }
      // A leg could not be placed: withdraw the others (nothing should have filled yet: post-only)
      ctx.log.warn(`consistency: leg ${leg.tokenId} not placed (${r.error ?? r.status}); basket withdrawn`);
      for (const l of basket.legs) for (const id of l.orderIds) await cancelQuietly(ctx, id);
      state.basket = basket.legs.some((l) => l.orderIds.length > 0) ? { ...basket, phase: 'resting', openedAt: now - cfg.hedgeTimeoutMinutes * MIN_MS } : null;
      state.retryAfter = now + OPEN_RETRY_MS;
      await save();
      return result('abandoned', `leg not placed: ${r.error ?? r.status}`);
    }
    state.basket = basket;
    state.baskets++;
    await save();
    return result('opened', `${basket.label}: ${shares} shares per leg`);
  }

  // Idle: gap closed for idle_days ⇒ retire
  if (now - Math.max(state.lastActiveAt, state.startedAt) >= cfg.idleDays * DAY_MS) {
    await save();
    return result('retire', `gap below min_gap ${cfg.minGap} for ${cfg.idleDays} days`);
  }
  await save();
  return result('none');
}

// ─── Lifecycle ─────────────────────────────────────────────────────────

let lastRunAt = 0;
let dirty = true;
let running = false;
let retiring = false;
let last: CycleResult | null = null;

export function constraintText(cfg: ConsistencyConfig): string {
  switch (cfg.constraint) {
    case 'implies':
      return `#1 implies #2: P(#1) ≤ P(#2)`;
    case 'date_ladder':
      return `date ladder of ${cfg.tokens.length}: P non-decreasing by deadline`;
    default:
      return `exclusive sum of ${cfg.tokens.length}: Σ P ≤ ${cfg.maxSum}${cfg.exhaustive ? ' and ≥ 1 (exhaustive)' : ''}`;
  }
}

export async function onStart(ctx) {
  lastRunAt = 0;
  dirty = true;
  retiring = false;
  const { cfg, errors } = consistencyConfig(ctx.config);
  const legErrors = errors.length ? [] : (await loadLegs(ctx, cfg)).errors;
  const all = [...errors, ...legErrors];
  if (all.length) {
    // Rejected config: log it clearly and do not start (the start call fails with this message)
    const msg = `invalid consistency config: ${all.join('; ')}`;
    ctx.log.error(msg);
    ctx.emit('consistency', { error: msg });
    throw new Error(msg);
  }
  // Idle time counts from this start at the earliest (a long stop does not retire the bot on its first cycle)
  const state = (await ctx.storage.get('consistency:state')) as BotState | null;
  await ctx.storage.set('consistency:state', state ? { ...state, startedAt: ctx.now } : freshState(ctx.now));
  const wake = () => {
    dirty = true;
  };
  ctx.events.on('rules_changed', wake);
  ctx.events.on('halt', wake);
  ctx.log.info(`Consistency bot started: ${constraintText(cfg)}, min_gap ${cfg.minGap}, max basket $${cfg.maxPairUsd}, max unhedged $${cfg.maxUnhedgedUsd}`);
}

export async function onTick(ctx) {
  const { cfg } = consistencyConfig(ctx.config);
  if (running || retiring) return;
  if (!dirty && ctx.now - lastRunAt < cfg.checkMinutes * MIN_MS) return;
  running = true;
  dirty = false;
  try {
    const r = await runConsistencyCycle(ctx);
    last = r;
    lastRunAt = ctx.now;
    if (r.action !== 'none' && r.action !== 'resting') ctx.log.info(`consistency: ${r.action}${r.detail ? ` — ${r.detail}` : ''}`);
    // Current gap for the bot page: on a phase change, a gap move ≥ 0.005, or every 30 minutes
    const state = (await ctx.storage.get('consistency:state')) as BotState | null;
    const phase = state?.basket?.phase ?? (r.action === 'retire' ? 'retiring' : 'watching');
    const prev = state?.lastEmit ?? null;
    const moved = !prev || prev.phase !== phase || (prev.gap === null) !== (r.gap === null) || Math.abs((prev.gap ?? 0) - (r.gap ?? 0)) >= 0.005 || ctx.now - prev.at >= 30 * MIN_MS;
    if (moved && state) {
      ctx.emit('consistency', {
        constraint: constraintText(cfg),
        gap: r.gap,
        minGap: cfg.minGap,
        basket: r.label,
        phase,
        action: r.action,
        baskets: state.baskets,
        hedged: state.hedged,
        ...(r.detail ? { detail: r.detail } : {}),
      });
      state.lastEmit = { gap: r.gap, phase, at: ctx.now };
      await ctx.storage.set('consistency:state', state);
    }
    if (r.action === 'retire') {
      retiring = true;
      await ctx.requestRetire(r.detail ?? 'opportunity over');
    }
  } finally {
    running = false;
  }
}

export async function onStop(ctx) {
  // Resting legs expire on their own (GTD); cancel them now so nothing rests while the bot is off
  for (const o of await ctx.polymarket.getOpenOrders()) {
    if (o.side !== 'buy' || o.placedBy) continue;
    try {
      await ctx.polymarket.cancel(o.orderId);
    } catch {
      /* expires on its own */
    }
  }
}

export function onHeartbeat(ctx) {
  return { role: 'consistency', lastRunAt, gap: last?.gap ?? '', action: last?.action ?? '' };
}
