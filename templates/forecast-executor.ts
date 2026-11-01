/**
 * Forecast Executor (spec §9.1) — standing builtin template, one instance per mode.
 *
 * Trades the forecast ledger: for every tradeable active forecast it rests post-only bids on the forecast's
 * token (fair value p) and on the other token of a binary market (fair value 1 − p) wherever the price leaves
 * at least `min_edge` after the maker fee.
 *
 * Each cycle (every `requote_minutes`, or at once after a forecast_changed / rules_changed / halt event):
 *   1. Candidates where p − best_ask ≥ min_edge + taker fee: bid = min(best_bid + tick, p − min_edge) on the
 *      tick grid, never at or through the best ask (post-only); edge = p − bid − maker fee ≥ min_edge.
 *      This bot's own resting bids are left out of the book first (it never outbids itself). Quotes below
 *      `min_edge_per_day` (keep equal to the Position Manager's `min_hold_edge_per_day`) are skipped, and so is
 *      a token the Position Manager stopped out of (on any bot's position in this mode, ctx.risk.getRecentStops)
 *      until its forecast is renewed, and a forecast whose token or complement has an open exit flag on any
 *      bot's position (ctx.risk.getFlaggedTokens): its bids there are cancelled.
 *   2. Ranked by edge per day = edge / max(days to settlement, 1) (spec §3.4); at most `max_markets` markets,
 *      and no more than the per-bot order rate can keep quoted (ctx.risk.getBudget().ordersPerHour: each quoted
 *      market costs about 60 / (bid_ttl_minutes − refresh window) + 1 orders per hour).
 *   3. Size = kelly_fraction × Kelly × bucket allocation, Kelly = (p − c) / (1 − c) at cost c = bid + fee;
 *      capped by max_per_market_usd (minus what this bot already holds or bids in the market), the risk
 *      budget (remaining allocation and per-market room) and what is left after better-ranked candidates.
 *   4. Orders that still match (same token and forecast, at or above the best competing bid and within
 *      fair − min_edge, similar size, more than min(5 min, bid_ttl_minutes / 2) of life left) are kept; bids
 *      rest for `bid_ttl_minutes` (default 60) and are re-placed only near expiry or when the price / size
 *      must change; every other buy of this bot is cancelled (forecast superseded / withdrawn / no longer
 *      tradeable, edge gone, budget gone, exit flag); missing ones are placed, tagged with the forecastId and
 *      a reason, at most as many as `ordersRemainingThisHour` allows (best ranked first).
 * The best edge per day it could not fund is stored (`executor:demand`) for the Position Manager's low-edge exit.
 * The server re-checks every order (RiskEngine: edge ≥ 0.03 floor, category rights, exposure caps). The
 * executor never sells: exits belong to the Position Manager. It only cancels its own BUY orders.
 */

export const meta = {
  name: 'Forecast Executor',
  description: 'Standing bot (one per mode): rests post-only bids on tradeable ledger forecasts with edge after fees, Kelly-sized, ranked by edge per day',
  version: '1.0.0',
  author: 'BotLab',
  // Standing builtin role and initial trust (seed only): new templates prove themselves in paper first (§4.5)
  role: 'forecast-executor',
  trust: 'new',
  configSchema: {
    type: 'object',
    properties: {
      min_edge: {
        type: 'number',
        title: 'Minimum edge',
        description: 'Required edge after fees (fair value − price − fee); never below 0.03',
        default: 0.05,
        minimum: 0.03,
        maximum: 0.5,
      },
      kelly_fraction: {
        type: 'number',
        title: 'Kelly fraction',
        description: 'Fraction of full Kelly applied to the bucket allocation',
        default: 0.25,
        minimum: 0.01,
        maximum: 1,
      },
      requote_minutes: {
        type: 'number',
        title: 'Re-quote every (minutes)',
        description: 'How often quotes are recomputed (also on forecast / rules / halt events)',
        default: 10,
        minimum: 1,
        maximum: 120,
      },
      bid_ttl_minutes: {
        type: 'number',
        title: 'Bid lifetime (minutes)',
        description: 'Resting bids expire after this (GTD) and are re-placed shortly before; longer = fewer orders against max_orders_per_hour',
        default: 60,
        minimum: 3,
        maximum: 240,
      },
      max_per_market_usd: {
        type: 'number',
        title: 'Max per market (USD)',
        description: 'Cap on this bot’s cost + open bids in one market',
        default: 25,
        minimum: 1,
      },
      min_edge_per_day: {
        type: 'number',
        title: 'Minimum edge per day',
        description: 'Skip quotes whose edge / days to settlement is below this. Keep it equal to the Position Manager’s min_hold_edge_per_day (both default 0.001), or it would exit what this bot buys',
        default: 0.001,
        minimum: 0,
      },
      max_markets: {
        type: 'number',
        title: 'Max markets',
        description: 'Markets quoted at once (best edge per day first)',
        default: 10,
        minimum: 1,
        maximum: 50,
      },
      pollingIntervalMs: {
        type: 'number',
        title: 'Check interval (ms)',
        description: 'How often the bot checks whether a re-quote is due',
        default: 30000,
        minimum: 5000,
      },
    },
  },
};

const MIN_EDGE_FLOOR = 0.03;
const DAY_MS = 86_400_000;
/** Polymarket's minimum order size (shares) */
const MIN_SHARES = 5;
const MIN_PRICE = 0.01;
const MAX_PRICE = 0.99;

export interface ExecutorConfig {
  minEdge: number;
  kellyFraction: number;
  requoteMinutes: number;
  maxPerMarketUsd: number;
  maxMarkets: number;
  minEdgePerDay: number;
  bidTtlMinutes: number;
}

/**
 * Shared with the Position Manager's `min_hold_edge_per_day` default: the executor never buys below the edge per
 * day the manager holds for (R165 amended). If you change one, change the other.
 */
export const DEFAULT_MIN_EDGE_PER_DAY = 0.001;
/** Bot storage key where each cycle records the best edge per day it could not fund (read by the Position Manager) */
export const DEMAND_KEY = 'executor:demand';

/** Config with defaults and floors (min_edge never below 0.03). */
export function executorConfig(raw: Record<string, any>): ExecutorConfig {
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    minEdge: Math.max(num(raw.min_edge, 0.05), MIN_EDGE_FLOOR),
    kellyFraction: Math.min(Math.max(num(raw.kelly_fraction, 0.25), 0), 1),
    requoteMinutes: Math.max(num(raw.requote_minutes, 10), 1),
    maxPerMarketUsd: Math.max(num(raw.max_per_market_usd, 25), 0),
    maxMarkets: Math.max(Math.floor(num(raw.max_markets, 10)), 1),
    minEdgePerDay: Math.max(num(raw.min_edge_per_day, DEFAULT_MIN_EDGE_PER_DAY), 0),
    bidTtlMinutes: Math.max(num(raw.bid_ttl_minutes, DEFAULT_BID_TTL_MINUTES), 3),
  };
}

/** Default resting-bid lifetime (Mac test F1: 2 × requote_minutes cost 3 orders per market per hour) */
export const DEFAULT_BID_TTL_MINUTES = 60;
/** A resting bid is re-placed once this little of its life is left (min(5 min, half the TTL)) */
export function refreshWindowMs(cfg: Pick<ExecutorConfig, 'bidTtlMinutes'>): number {
  return Math.min(5, cfg.bidTtlMinutes / 2) * 60_000;
}

/** Bid lifetime actually used: bid_ttl_minutes capped by the server's resting-order TTL (when known), at least 3. */
export function effectiveBidTtl(cfg: Pick<ExecutorConfig, 'bidTtlMinutes'>, maxRestingTtlMinutes: number | null | undefined): number {
  const cap = typeof maxRestingTtlMinutes === 'number' && Number.isFinite(maxRestingTtlMinutes) ? maxRestingTtlMinutes : Infinity;
  return Math.max(Math.min(cfg.bidTtlMinutes, cap), 3);
}

/**
 * Markets the per-bot order rate can keep quoted: each costs about one re-placement per (TTL − refresh window)
 * plus one re-price an hour. Infinity when the rate is unknown.
 */
export function sustainableMarkets(cfg: Pick<ExecutorConfig, 'bidTtlMinutes'>, ordersPerHour: number | null | undefined): number {
  if (typeof ordersPerHour !== 'number' || !Number.isFinite(ordersPerHour)) return Infinity;
  const lifeMinutes = Math.max(cfg.bidTtlMinutes - refreshWindowMs(cfg) / 60_000, 1);
  const perMarket = 60 / lifeMinutes + 1;
  return Math.max(Math.floor(ordersPerHour / perMarket), 1);
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Round onto the tick grid (down for bids, so a bid is never higher than intended). */
export function floorTick(p: number, tick: number): number {
  return round6(Math.floor(p / tick + 1e-9) * tick);
}

/** Fee per share at price c for a rate (formula 'price': rate × c × (1 − c); 'notional': rate × c). */
function feePerShareAt(rate: number, formula: string, c: number): number {
  return formula === 'price' ? rate * c * (1 - c) : rate * c;
}

/** Fee per share for a maker (resting) order at price c (0 on Polymarket unless the market says otherwise). */
export function makerFeePerShare(fee: FeeRates, c: number): number {
  return feePerShareAt(fee.makerRate || 0, fee.formula, c);
}

/** Fee per share for a taker at price c. */
export function takerFeePerShare(fee: FeeRates, c: number): number {
  return feePerShareAt(fee.takerRate || 0, fee.formula, c);
}

/** Kelly fraction for buying a share paying 1 with probability p at all-in cost c: (p − c) / (1 − c). */
export function kellyFraction(p: number, c: number): number {
  if (!(c > 0 && c < 1) || !(p > c)) return 0;
  return (p - c) / (1 - c);
}

export interface BookTop {
  bestBid: number | null;
  bestAsk: number | null;
  tick: number;
}

export function bookTop(book: OrderBook): BookTop {
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

/** One side of a forecast we could bid on. */
export interface Quote {
  forecastId: string;
  marketId: string;
  tokenId: string;
  /** Fair value of this token (p, or 1 − p for the other token) */
  fair: number;
  price: number;
  /** Edge per share after the maker fee */
  edge: number;
  edgePerDay: number;
  days: number;
  /** Full Kelly at cost price + fee */
  kelly: number;
  bucketAllocationUsd: number;
  /** Best bid of everyone else; null if none */
  competingBid?: number | null;
  /** Highest price still leaving min_edge after the maker fee */
  maxPrice?: number;
}

/**
 * The bid for one token at fair value `fair`, or null when there is no opportunity (spec §9.1): only when the
 * ask itself leaves the edge (fair − ask ≥ min_edge + taker fee), then a post-only bid at
 * min(best bid + tick, fair − min_edge) on the tick grid, below the best ask, within [0.01, 0.99], with
 * fair − bid − maker fee ≥ min_edge.
 */
export function quoteFor(
  fair: number,
  top: BookTop,
  fee: FeeRates,
  minEdge: number
): { price: number; edge: number; feePerShare: number } | null {
  if (!(fair > 0 && fair < 1)) return null;
  if (top.bestAsk === null || fair - top.bestAsk - takerFeePerShare(fee, top.bestAsk) + 1e-9 < minEdge) return null;
  const tick = top.tick;
  let price = floorTick(fair - minEdge, tick);
  if (top.bestBid !== null) price = Math.min(price, floorTick(top.bestBid + tick, tick));
  if (top.bestAsk !== null && price >= top.bestAsk - 1e-9) price = floorTick(top.bestAsk - tick, tick);
  price = round6(price);
  if (price < MIN_PRICE - 1e-9 || price > MAX_PRICE + 1e-9) return null;
  const feePerShare = makerFeePerShare(fee, price);
  const edge = fair - price - feePerShare;
  if (edge + 1e-9 < minEdge) return null;
  return { price, edge, feePerShare };
}

/** Highest price on the tick grid that still leaves min_edge after the maker fee. */
export function maxKeepPrice(fair: number, fee: FeeRates, minEdge: number, tick: number): number {
  let p = floorTick(fair - minEdge, tick);
  while (p >= MIN_PRICE && fair - p - makerFeePerShare(fee, p) + 1e-9 < minEdge) p = round6(p - tick);
  return p;
}

/** Days to settlement now, at least 1 (spec §3.4); from the end date, else the days at forecast minus elapsed time. */
export function daysToSettlement(f: BotForecast, now: number): number {
  const end = f.endDate ? Date.parse(f.endDate) : NaN;
  const days = Number.isFinite(end)
    ? (end - now) / DAY_MS
    : f.daysToResolutionAtForecast - (now - Date.parse(f.createdAt)) / DAY_MS;
  return Math.max(Number.isFinite(days) ? days : 1, 1);
}

export interface PlannedOrder {
  forecastId: string;
  marketId: string;
  tokenId: string;
  price: number;
  size: number;
  usd: number;
  edge: number;
  edgePerDay: number;
  /** Best bid of everyone else (this bot's own bids removed); null if none */
  competingBid: number | null;
  /** Highest price that still leaves min_edge after the maker fee */
  maxPrice: number;
}

/**
 * Allocation (pure): quotes ranked by edge per day, at most `maxMarkets` markets, each sized
 * kelly_fraction × Kelly × bucket allocation, capped by max_per_market_usd minus `marketUsed` (what this bot
 * already has in the market outside the orders being re-planned), the budget's per-market room and the
 * remaining allocation (shared across quotes in rank order). Orders under 5 shares are dropped.
 */
export function allocate(
  quotes: Quote[],
  cfg: ExecutorConfig,
  budget: { remainingAllocation: number; remainingMarket: Record<string, number> },
  marketUsed: Record<string, number>
): PlannedOrder[] {
  return allocatePlan(quotes, cfg, budget, marketUsed).orders;
}

/**
 * allocate() plus the best edge per day among quotes the remaining allocation could not fund (at least 5 shares
 * short because the budget ran out, not because of per-market caps): the "better use of capital" the Position
 * Manager may free capital for (spec §9.2). null when every quote was funded.
 */
export function allocatePlan(
  quotes: Quote[],
  cfg: ExecutorConfig,
  budget: { remainingAllocation: number; remainingMarket: Record<string, number> },
  marketUsed: Record<string, number>
): { orders: PlannedOrder[]; unmetEdgePerDay: number | null } {
  let unmet: number | null = null;
  const ranked = [...quotes].sort((a, b) => b.edgePerDay - a.edgePerDay || b.edge - a.edge);
  const markets = new Set<string>();
  const allocated: Record<string, number> = {};
  let remaining = Math.max(budget.remainingAllocation, 0);
  const out: PlannedOrder[] = [];
  for (const q of ranked) {
    if (!markets.has(q.marketId) && markets.size >= cfg.maxMarkets) continue;
    const already = allocated[q.marketId] ?? 0;
    const want = cfg.kellyFraction * q.kelly * Math.max(q.bucketAllocationUsd, 0);
    const capRoom = cfg.maxPerMarketUsd - (marketUsed[q.marketId] ?? 0) - already;
    const budgetRoom = q.marketId in budget.remainingMarket ? budget.remainingMarket[q.marketId] - already : Infinity;
    const usd = Math.min(want, capRoom, budgetRoom, remaining);
    const unfunded = Math.min(want, capRoom, budgetRoom) - Math.max(remaining, 0);
    if (unfunded >= q.price * MIN_SHARES && (unmet === null || q.edgePerDay > unmet)) unmet = q.edgePerDay;
    const size = Math.floor((usd / q.price) * 100) / 100;
    if (!(size >= MIN_SHARES)) continue;
    const spend = round6(size * q.price);
    markets.add(q.marketId);
    allocated[q.marketId] = already + spend;
    remaining -= spend;
    out.push({
      forecastId: q.forecastId,
      marketId: q.marketId,
      tokenId: q.tokenId,
      price: q.price,
      size,
      usd: spend,
      edge: q.edge,
      edgePerDay: q.edgePerDay,
      competingBid: q.competingBid ?? null,
      maxPrice: q.maxPrice ?? q.price,
    });
  }
  return { orders: out, unmetEdgePerDay: unmet };
}

/**
 * An open buy is kept (no re-quote, so the bot never steps over its own bid) while it is on the same token and
 * forecast, still at or above the best competing bid and at most the highest price leaving min_edge, with a
 * similar USD size (± 15 %, at least $1) and more than `refreshMs` of life left.
 */
export function keeps(order: OpenOrder, plan: PlannedOrder, now: number, refreshMs: number): boolean {
  const remaining = order.size - order.filledSize;
  const expiresAt = order.expiresAt ? Date.parse(order.expiresAt) : Infinity;
  return (
    order.tokenId === plan.tokenId &&
    order.forecastId === plan.forecastId &&
    (plan.competingBid === null || order.price >= plan.competingBid - 1e-9) &&
    order.price <= plan.maxPrice + 1e-9 &&
    Math.abs(remaining * order.price - plan.usd) <= Math.max(plan.usd * 0.15, 1) &&
    expiresAt - now > refreshMs
  );
}

/** The book without this bot's own resting bids (its remaining size subtracted from its price level). */
export function withoutOwnBids(book: OrderBook, own: OpenOrder[]): OrderBook {
  const mine = new Map<string, number>();
  for (const o of own) {
    const key = o.price.toFixed(6);
    mine.set(key, (mine.get(key) ?? 0) + Math.max(o.size - o.filledSize, 0));
  }
  const bids = (book.bids ?? [])
    .map((l) => {
      const key = parseFloat(l.price).toFixed(6);
      const take = Math.min(mine.get(key) ?? 0, parseFloat(l.size));
      if (take > 0) mine.set(key, (mine.get(key) ?? 0) - take);
      return { price: l.price, size: String(parseFloat(l.size) - take) };
    })
    .filter((l) => parseFloat(l.size) > 1e-9);
  return { ...book, bids };
}

/**
 * Tokens the Position Manager stopped out of (its exits with reason "position manager: stop…"), latest time each,
 * from this bot's own order history: the fallback when ctx.risk.getRecentStops (any bot, server-side) is missing.
 */
export function stoppedTokens(history: OrderHistoryEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const h of history) {
    if (!h.placedBy || h.side !== 'sell' || !/^position manager: stop\b/.test(h.reason ?? '')) continue;
    const at = Date.parse(h.createdAt);
    if (Number.isFinite(at) && at > (out.get(h.tokenId) ?? -Infinity)) out.set(h.tokenId, at);
  }
  return out;
}

/** One full re-quote. Exported for tests; the lifecycle below calls it. */
export interface CycleResult {
  placed: number;
  kept: number;
  cancelled: number;
  planned: PlannedOrder[];
  unmetEdgePerDay: number | null;
  /** Plans not placed because the hourly order budget ran out */
  deferred: number;
  /** When the earliest kept / placed bid enters its refresh window (the next cycle is due then at the latest); null if none */
  refreshAt: number | null;
}

export async function runExecutorCycle(ctx: BotContext): Promise<CycleResult> {
  const cfg = executorConfig(ctx.config);
  const now = ctx.now;
  const result: CycleResult = { placed: 0, kept: 0, cancelled: 0, planned: [], unmetEdgePerDay: null, deferred: 0, refreshAt: null };
  // Effective bid lifetime set below, once the server's resting-order cap is known
  let refreshMs = refreshWindowMs(cfg);

  const open = (await ctx.polymarket.getOpenOrders()).filter((o) => o.side === 'buy' && o.exchange === 'polymarket' && !o.placedBy);
  const budget = await ctx.risk.getBudget();
  // The server caps GTD lifetimes at limits.yaml orders.resting_order_ttl_minutes: plan with the effective TTL
  const ttlCfg = { ...cfg, bidTtlMinutes: effectiveBidTtl(cfg, budget.maxRestingTtlMinutes) };
  refreshMs = refreshWindowMs(ttlCfg);
  if (budget.halted) {
    // Halted: the server refuses orders and cancels resting ones; drop ours too
    for (const o of open) {
      try {
        await ctx.polymarket.cancel(o.orderId);
        result.cancelled++;
      } catch {
        /* already gone */
      }
    }
    return result;
  }

  // Our open bids are part of the budget's exposure: add them back, they are being re-planned
  const openUsd = (o: OpenOrder) => o.price * Math.max(o.size - o.filledSize, 0);
  const remainingMarket: Record<string, number> = { ...budget.remainingMarket };
  for (const o of open) if (o.marketId in remainingMarket) remainingMarket[o.marketId] += openUsd(o);
  const available = { remainingAllocation: budget.remainingAllocation + open.reduce((n, o) => n + openUsd(o), 0), remainingMarket };

  const forecasts = await ctx.ledger.getActiveForecasts({ tradeableOnly: true });
  // Token → market from the forecasts, for positions whose market is unknown
  const tokenMarket = new Map<string, string>();
  for (const f of forecasts) {
    tokenMarket.set(f.tokenId, f.marketId);
    if (f.complementTokenId) tokenMarket.set(f.complementTokenId, f.marketId);
  }

  // What this bot already holds per market counts against max_per_market_usd
  const marketUsed: Record<string, number> = {};
  for (const p of await ctx.getPositions()) {
    const m = p.conditionId || tokenMarket.get(p.tokenId);
    if (m) marketUsed[m] = (marketUsed[m] ?? 0) + p.size * p.avgPrice;
  }

  // After a stop by the Position Manager (on any bot's position in this mode) a token is skipped until its forecast
  // is renewed (R166 amended, Mac test F4); without the server call, this bot's own history
  const stops = new Map<string, number>();
  if (typeof ctx.risk.getRecentStops === 'function') {
    for (const s of await ctx.risk.getRecentStops()) {
      const at = Date.parse(s.stoppedAt);
      if (Number.isFinite(at)) stops.set(s.tokenId, at);
    }
  } else {
    for (const [t, at] of stoppedTokens(await ctx.polymarket.getOrderHistory(30))) stops.set(t, at);
  }
  // Tokens (and markets) with an open exit flag on any bot's position: never buy what the manager must sell (F3)
  const flaggedTokens = new Set<string>();
  const flaggedMarkets = new Set<string>();
  if (typeof ctx.risk.getFlaggedTokens === 'function') {
    for (const f of await ctx.risk.getFlaggedTokens()) {
      flaggedTokens.add(f.tokenId);
      if (f.marketId) flaggedMarkets.add(f.marketId);
    }
  }

  // Markets under the trading floor (24h volume < min_liquidity_usd): the risk engine would refuse the bid. Forecasts
  // may be recorded below it (mandate min_forecast_volume_usd, R209), so skip them instead of collecting rejections.
  // Unknown volume is left to the risk engine; without these calls (backtests) nothing is skipped
  const thinMarkets = new Set<string>();
  if (typeof ctx.risk.getMandateSummary === 'function' && typeof ctx.polymarket.getMarket === 'function') {
    const mandate = await ctx.risk.getMandateSummary();
    if (mandate) {
      for (const marketId of new Set(forecasts.map((f) => f.marketId))) {
        const volume = (await ctx.polymarket.getMarket(marketId))?.volume24hUsd;
        if (typeof volume === 'number' && volume < mandate.minLiquidityUsd) thinMarkets.add(marketId);
      }
    }
  }

  const quotes: Quote[] = [];
  for (const f of forecasts) {
    if (thinMarkets.has(f.marketId)) continue;
    if (flaggedMarkets.has(f.marketId) || flaggedTokens.has(f.tokenId) || (f.complementTokenId && flaggedTokens.has(f.complementTokenId))) continue;
    const sides: Array<{ tokenId: string; fair: number }> = [{ tokenId: f.tokenId, fair: f.probability }];
    if (f.complementTokenId) sides.push({ tokenId: f.complementTokenId, fair: 1 - f.probability });
    const days = daysToSettlement(f, now);
    for (const side of sides) {
      const stoppedAt = stops.get(side.tokenId);
      if (stoppedAt !== undefined && !(Date.parse(f.createdAt) > stoppedAt)) continue;
      try {
        const [book, fee] = await Promise.all([ctx.getOrderBook(side.tokenId), ctx.polymarket.getFee(side.tokenId)]);
        // Our own resting bids are not competition: leave them out before looking at the best bid
        const top = bookTop(withoutOwnBids(book, open.filter((o) => o.tokenId === side.tokenId)));
        const q = quoteFor(side.fair, top, fee, cfg.minEdge);
        if (!q) continue;
        const edgePerDay = q.edge / days;
        // Below the edge per day the Position Manager holds for: it would only churn (R165 amended)
        if (edgePerDay < cfg.minEdgePerDay) continue;
        quotes.push({
          forecastId: f.id,
          marketId: f.marketId,
          tokenId: side.tokenId,
          fair: side.fair,
          price: q.price,
          edge: q.edge,
          edgePerDay,
          days,
          kelly: kellyFraction(side.fair, q.price + q.feePerShare),
          bucketAllocationUsd: f.bucketAllocationUsd ?? 0,
          competingBid: top.bestBid,
          maxPrice: Math.min(maxKeepPrice(side.fair, fee, cfg.minEdge, top.tick), top.bestAsk !== null ? top.bestAsk - top.tick : MAX_PRICE),
        });
      } catch (err) {
        ctx.log.warn(`executor: no quote for ${side.tokenId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // No more markets than the hourly order rate can keep quoted (F1)
  const sustainable = sustainableMarkets(ttlCfg, budget.ordersPerHour);
  const plan = allocatePlan(quotes, { ...cfg, maxMarkets: Math.min(cfg.maxMarkets, sustainable) }, available, marketUsed);
  const planned = plan.orders;
  result.planned = planned;
  result.unmetEdgePerDay = plan.unmetEdgePerDay;
  // Unfunded demand for the Position Manager's "better use of capital" check (spec §9.2)
  await ctx.storage.set(DEMAND_KEY, { bestUnmetEdgePerDay: plan.unmetEdgePerDay, at: new Date(now).toISOString() });

  // Keep matching orders, cancel the rest, place what is missing
  const kept = new Set<string>();
  const covered = new Set<number>();
  for (const o of open) {
    const i = planned.findIndex((p, idx) => !covered.has(idx) && keeps(o, p, now, refreshMs));
    if (i >= 0) {
      covered.add(i);
      kept.add(o.orderId);
      const exp = o.expiresAt ? Date.parse(o.expiresAt) : NaN;
      if (Number.isFinite(exp)) result.refreshAt = Math.min(result.refreshAt ?? Infinity, exp - refreshMs);
    }
  }
  for (const o of open) {
    if (kept.has(o.orderId)) continue;
    try {
      await ctx.polymarket.cancel(o.orderId);
      result.cancelled++;
    } catch (err) {
      ctx.log.warn(`executor: cancel ${o.orderId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  result.kept = kept.size;

  const ttlMinutes = Math.max(3, Math.round(ttlCfg.bidTtlMinutes));
  // Hourly order budget (own submissions; rejections and Position Manager exits do not count)
  let ordersLeft = typeof budget.ordersRemainingThisHour === 'number' ? budget.ordersRemainingThisHour : Infinity;
  for (let i = 0; i < planned.length; i++) {
    if (covered.has(i)) continue;
    const p = planned[i];
    if (ordersLeft <= 0) {
      result.deferred++;
      continue;
    }
    ordersLeft--;
    const r = await ctx.polymarket.placeLimit(p.tokenId, 'buy', p.price, p.size, {
      postOnly: true,
      ttlMinutes,
      forecastId: p.forecastId,
      reason: `executor: fair edge ${p.edge.toFixed(3)} (${p.edgePerDay.toFixed(4)}/day)`,
    });
    if (r.ok) {
      result.placed++;
      // The server's expiry (it may have capped the TTL), else what was asked for
      const exp = r.expiresAt ? Date.parse(r.expiresAt) : NaN;
      result.refreshAt = Math.min(result.refreshAt ?? Infinity, (Number.isFinite(exp) ? exp : now + ttlMinutes * 60_000) - refreshMs);
    } else ctx.log.info(`executor: bid ${p.size} @ ${p.price} on ${p.tokenId} not placed: ${r.error ?? r.status}`);
  }
  return result;
}

// ─── Lifecycle ─────────────────────────────────────────────────────────

let lastRunAt = 0;
let dirty = true;
let running = false;
/** The earliest resting bid's refresh time: a cycle runs then even between re-quotes */
let refreshAt: number | null = null;

export async function onStart(ctx) {
  lastRunAt = 0;
  dirty = true;
  refreshAt = null;
  const wake = () => {
    dirty = true;
  };
  ctx.events.on('forecast_changed', wake);
  ctx.events.on('rules_changed', wake);
  ctx.events.on('halt', wake);
  const cfg = executorConfig(ctx.config);
  ctx.log.info(`Forecast executor started: min_edge ${cfg.minEdge}, kelly ${cfg.kellyFraction}, re-quote ${cfg.requoteMinutes} min, bids rest ${cfg.bidTtlMinutes} min, max ${cfg.maxMarkets} markets`);
}

export async function onTick(ctx) {
  const cfg = executorConfig(ctx.config);
  if (running) return;
  const refreshDue = refreshAt !== null && ctx.now >= refreshAt;
  if (!dirty && !refreshDue && ctx.now - lastRunAt < cfg.requoteMinutes * 60_000) return;
  running = true;
  dirty = false;
  try {
    const r = await runExecutorCycle(ctx);
    lastRunAt = ctx.now;
    refreshAt = r.refreshAt;
    if (r.placed || r.cancelled || r.deferred) {
      ctx.log.info(`executor: ${r.planned.length} quotes, placed ${r.placed}, kept ${r.kept}, cancelled ${r.cancelled}${r.deferred ? `, ${r.deferred} deferred (hourly order budget)` : ''}`);
    }
  } finally {
    running = false;
  }
}

export async function onStop(ctx) {
  // Resting bids expire on their own (GTD); cancel them now so nothing rests while the bot is off
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
  return { role: 'forecast-executor', lastRunAt };
}
