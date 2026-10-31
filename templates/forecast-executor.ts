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
 *   2. Ranked by edge per day = edge / max(days to settlement, 1) (spec §3.4); at most `max_markets` markets.
 *   3. Size = kelly_fraction × Kelly × bucket allocation, Kelly = (p − c) / (1 − c) at cost c = bid + fee;
 *      capped by max_per_market_usd (minus what this bot already holds or bids in the market), the risk
 *      budget (remaining allocation and per-market room) and what is left after better-ranked candidates.
 *   4. Orders that still match (same token, forecast and price, similar size, not about to expire) are kept;
 *      every other buy of this bot is cancelled (forecast superseded / withdrawn / no longer tradeable, edge
 *      gone, budget gone); missing ones are placed, tagged with the forecastId and a reason.
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
      max_per_market_usd: {
        type: 'number',
        title: 'Max per market (USD)',
        description: 'Cap on this bot’s cost + open bids in one market',
        default: 25,
        minimum: 1,
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
}

/** Config with defaults and floors (min_edge never below 0.03). */
export function executorConfig(raw: Record<string, any>): ExecutorConfig {
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    minEdge: Math.max(num(raw.min_edge, 0.05), MIN_EDGE_FLOOR),
    kellyFraction: Math.min(Math.max(num(raw.kelly_fraction, 0.25), 0), 1),
    requoteMinutes: Math.max(num(raw.requote_minutes, 10), 1),
    maxPerMarketUsd: Math.max(num(raw.max_per_market_usd, 25), 0),
    maxMarkets: Math.max(Math.floor(num(raw.max_markets, 10)), 1),
  };
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
    const size = Math.floor((usd / q.price) * 100) / 100;
    if (!(size >= MIN_SHARES)) continue;
    const spend = round6(size * q.price);
    markets.add(q.marketId);
    allocated[q.marketId] = already + spend;
    remaining -= spend;
    out.push({ forecastId: q.forecastId, marketId: q.marketId, tokenId: q.tokenId, price: q.price, size, usd: spend, edge: q.edge, edgePerDay: q.edgePerDay });
  }
  return out;
}

/** An open buy is kept when it is the same quote (token, forecast, price) with a similar size and enough life left. */
export function keeps(order: OpenOrder, plan: PlannedOrder, now: number, requoteMinutes: number): boolean {
  const remaining = order.size - order.filledSize;
  const expiresAt = order.expiresAt ? Date.parse(order.expiresAt) : Infinity;
  return (
    order.tokenId === plan.tokenId &&
    order.forecastId === plan.forecastId &&
    Math.abs(order.price - plan.price) < 1e-9 &&
    Math.abs(remaining - plan.size) <= Math.max(plan.size * 0.1, 1) &&
    expiresAt - now > (requoteMinutes + 1) * 60_000
  );
}

/** One full re-quote. Exported for tests; the lifecycle below calls it. */
export async function runExecutorCycle(ctx: BotContext): Promise<{ placed: number; kept: number; cancelled: number; planned: PlannedOrder[] }> {
  const cfg = executorConfig(ctx.config);
  const now = ctx.now;
  const result = { placed: 0, kept: 0, cancelled: 0, planned: [] as PlannedOrder[] };

  const open = (await ctx.polymarket.getOpenOrders()).filter((o) => o.side === 'buy' && o.exchange === 'polymarket' && !o.placedBy);
  const budget = await ctx.risk.getBudget();
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

  // What this bot already holds per market counts against max_per_market_usd
  const marketUsed: Record<string, number> = {};
  for (const p of await ctx.getPositions()) {
    if (p.conditionId) marketUsed[p.conditionId] = (marketUsed[p.conditionId] ?? 0) + p.size * p.avgPrice;
  }

  const forecasts = await ctx.ledger.getActiveForecasts({ tradeableOnly: true });
  const quotes: Quote[] = [];
  for (const f of forecasts) {
    const sides: Array<{ tokenId: string; fair: number }> = [{ tokenId: f.tokenId, fair: f.probability }];
    if (f.complementTokenId) sides.push({ tokenId: f.complementTokenId, fair: 1 - f.probability });
    const days = daysToSettlement(f, now);
    for (const side of sides) {
      try {
        const [book, fee] = await Promise.all([ctx.getOrderBook(side.tokenId), ctx.polymarket.getFee(side.tokenId)]);
        const q = quoteFor(side.fair, bookTop(book), fee, cfg.minEdge);
        if (!q) continue;
        quotes.push({
          forecastId: f.id,
          marketId: f.marketId,
          tokenId: side.tokenId,
          fair: side.fair,
          price: q.price,
          edge: q.edge,
          edgePerDay: q.edge / days,
          days,
          kelly: kellyFraction(side.fair, q.price + q.feePerShare),
          bucketAllocationUsd: f.bucketAllocationUsd ?? 0,
        });
      } catch (err) {
        ctx.log.warn(`executor: no quote for ${side.tokenId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const planned = allocate(quotes, cfg, available, marketUsed);
  result.planned = planned;

  // Keep matching orders, cancel the rest, place what is missing
  const kept = new Set<string>();
  const covered = new Set<number>();
  for (const o of open) {
    const i = planned.findIndex((p, idx) => !covered.has(idx) && keeps(o, p, now, cfg.requoteMinutes));
    if (i >= 0) {
      covered.add(i);
      kept.add(o.orderId);
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

  const ttlMinutes = Math.max(3, Math.ceil(cfg.requoteMinutes * 2 + 2));
  for (let i = 0; i < planned.length; i++) {
    if (covered.has(i)) continue;
    const p = planned[i];
    const r = await ctx.polymarket.placeLimit(p.tokenId, 'buy', p.price, p.size, {
      postOnly: true,
      ttlMinutes,
      forecastId: p.forecastId,
      reason: `executor: fair edge ${p.edge.toFixed(3)} (${p.edgePerDay.toFixed(4)}/day)`,
    });
    if (r.ok) result.placed++;
    else ctx.log.info(`executor: bid ${p.size} @ ${p.price} on ${p.tokenId} not placed: ${r.error ?? r.status}`);
  }
  return result;
}

// ─── Lifecycle ─────────────────────────────────────────────────────────

let lastRunAt = 0;
let dirty = true;
let running = false;

export async function onStart(ctx) {
  lastRunAt = 0;
  dirty = true;
  const wake = () => {
    dirty = true;
  };
  ctx.events.on('forecast_changed', wake);
  ctx.events.on('rules_changed', wake);
  ctx.events.on('halt', wake);
  const cfg = executorConfig(ctx.config);
  ctx.log.info(`Forecast executor started: min_edge ${cfg.minEdge}, kelly ${cfg.kellyFraction}, re-quote ${cfg.requoteMinutes} min, max ${cfg.maxMarkets} markets`);
}

export async function onTick(ctx) {
  const cfg = executorConfig(ctx.config);
  if (running) return;
  if (!dirty && ctx.now - lastRunAt < cfg.requoteMinutes * 60_000) return;
  running = true;
  dirty = false;
  try {
    const r = await runExecutorCycle(ctx);
    lastRunAt = ctx.now;
    if (r.placed || r.cancelled) ctx.log.info(`executor: ${r.planned.length} quotes, placed ${r.placed}, kept ${r.kept}, cancelled ${r.cancelled}`);
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
