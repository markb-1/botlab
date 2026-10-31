/**
 * Resolution-rule (spec §9.4) — builtin per-market template: one bot per market where the resolution rules make an
 * outcome cheaper than it should be (the agent's `thesis`).
 *
 * It rests post-only bids on `token_id` up to `target_entry_price` (never above: price + maker fee ≤ target), one tick
 * over the best competing bid (its own bids left out of the book) and below the ask, GTD and re-quoted every
 * `requote_minutes`, until it holds `max_size_usd` worth (cost) — within the risk budget. It holds to resolution and
 * NEVER sells.
 *
 * Invalidation (sticky: once invalid the bot never buys again) — any of:
 *   - the resolution rules changed since the bot first started (`invalidate_on_rules_change`, default true);
 *   - a UMA dispute is recorded;
 *   - the market's ambiguity (after the server raise) is above `max_ambiguity` (default 1);
 *   - a linked forecast (`forecast_id`) was withdrawn (no active forecast prices the token any more) or now values the
 *     token below `target_entry_price`;
 *   - an exit flag (agent / human flag_position_exit) is open on this bot's position in the token;
 *   - less than `invalidate_before_end_minutes` to the market end.
 * On invalidation the bot cancels its bids and stops buying. EXITS ARE THE POSITION MANAGER'S JOB: it already sells
 * on a rules change after the position opened, ambiguity ≥ 2 or a dispute, ambiguity ≥ 1 near the end, and exit
 * flags (risk exits placed as this bot). This bot asks to be retired (ctx.requestRetire) once it is invalid and holds
 * nothing, or when the market is closed (resolved).
 * A token whose market is unassessed (ambiguity null) gets no bids: the risk engine would refuse them (R51).
 */

export const meta = {
  name: 'Resolution Rule',
  description: 'Per-market bot: rests post-only bids up to a target price on an outcome the resolution rules favour (thesis), holds to resolution, stops buying when invalidated',
  version: '1.0.0',
  author: 'BotLab',
  // Builtin strategy role (5b; per market, the agent may create these) and initial trust (§4.5: paper first)
  role: 'resolution-rule',
  trust: 'new',
  configSchema: {
    type: 'object',
    required: ['token_id', 'target_entry_price', 'max_size_usd', 'thesis'],
    properties: {
      token_id: {
        type: 'string',
        title: 'Token',
        description: 'Outcome token to buy (its market must be in the bot’s market_ids)',
        default: '',
        maxLength: 100,
      },
      target_entry_price: {
        type: 'number',
        title: 'Target entry price',
        description: 'Highest price paid per share (bids never go above it)',
        default: 0.5,
        minimum: 0.01,
        maximum: 0.99,
      },
      max_size_usd: {
        type: 'number',
        title: 'Max size (USD)',
        description: 'Total cost this bot may hold in the token',
        default: 20,
        minimum: 1,
      },
      thesis: {
        type: 'string',
        title: 'Thesis',
        description: 'Why the rules make this outcome likely (shown on the bot page)',
        default: '',
        maxLength: 2000,
      },
      forecast_id: {
        type: 'string',
        title: 'Linked forecast (optional)',
        description: 'Ledger forecast backing the thesis: withdrawn, or below the target ⇒ invalidated',
        default: '',
        maxLength: 100,
      },
      invalidate_on_rules_change: {
        type: 'boolean',
        title: 'Invalidate on rules change',
        default: true,
      },
      max_ambiguity: {
        type: 'integer',
        title: 'Max ambiguity',
        description: 'Invalidate when the market’s ambiguity (after the server raise) is above this',
        default: 1,
        minimum: 0,
        maximum: 3,
      },
      invalidate_before_end_minutes: {
        type: 'number',
        title: 'Stop buying before end (minutes)',
        default: 120,
        minimum: 0,
      },
      requote_minutes: {
        type: 'number',
        title: 'Re-quote every (minutes)',
        default: 5,
        minimum: 1,
        maximum: 120,
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
const STATE_KEY = 'resolution:state';

export interface ResolutionConfig {
  tokenId: string;
  target: number;
  maxSizeUsd: number;
  thesis: string;
  forecastId: string | null;
  invalidateOnRulesChange: boolean;
  maxAmbiguity: number;
  invalidateBeforeEndMinutes: number;
  requoteMinutes: number;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const floorTick = (p: number, tick: number): number => round6(Math.floor(p / tick + 1e-9) * tick);
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function resolutionConfig(raw: Record<string, any>): { cfg: ResolutionConfig; errors: string[] } {
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  const errors: string[] = [];
  const tokenId = typeof raw.token_id === 'string' ? raw.token_id.trim() : '';
  if (!tokenId) errors.push('token_id is required');
  const target = num(raw.target_entry_price, NaN);
  if (!(target >= MIN_PRICE && target <= MAX_PRICE)) errors.push('target_entry_price must be between 0.01 and 0.99');
  const maxSizeUsd = num(raw.max_size_usd, NaN);
  if (!(maxSizeUsd > 0)) errors.push('max_size_usd must be positive');
  const thesis = typeof raw.thesis === 'string' ? raw.thesis.trim() : '';
  if (!thesis) errors.push('thesis is required');
  if (thesis.length > 2000) errors.push('thesis must be at most 2000 characters');
  return {
    cfg: {
      tokenId,
      target,
      maxSizeUsd,
      thesis: thesis.slice(0, 2000),
      forecastId: typeof raw.forecast_id === 'string' && raw.forecast_id.trim() ? raw.forecast_id.trim() : null,
      invalidateOnRulesChange: raw.invalidate_on_rules_change !== false && raw.invalidate_on_rules_change !== 'false',
      maxAmbiguity: Math.min(Math.max(Math.floor(num(raw.max_ambiguity, 1)), 0), 3),
      invalidateBeforeEndMinutes: Math.max(num(raw.invalidate_before_end_minutes, 120), 0),
      requoteMinutes: Math.max(num(raw.requote_minutes, 5), 1),
    },
    errors,
  };
}

export interface Top {
  bestBid: number | null;
  bestAsk: number | null;
  tick: number;
}

/** Top of book without this bot's own resting bids. */
export function topWithoutOwn(book: OrderBook, own: Array<{ price: number; size: number; filledSize: number }>): Top {
  const mine = new Map<string, number>();
  for (const o of own) mine.set(o.price.toFixed(6), (mine.get(o.price.toFixed(6)) ?? 0) + Math.max(o.size - o.filledSize, 0));
  let bestBid: number | null = null;
  let bestAsk: number | null = null;
  for (const l of book.bids ?? []) {
    const p = parseFloat(l.price);
    const size = parseFloat(l.size) - (mine.get(p.toFixed(6)) ?? 0);
    if (Number.isFinite(p) && size > 1e-9 && (bestBid === null || p > bestBid)) bestBid = p;
  }
  for (const l of book.asks ?? []) {
    const p = parseFloat(l.price);
    if (Number.isFinite(p) && parseFloat(l.size) > 0 && (bestAsk === null || p < bestAsk)) bestAsk = p;
  }
  const t = parseFloat(String(book.tick_size ?? ''));
  return { bestBid, bestAsk, tick: Number.isFinite(t) && t > 0 && t < 1 ? t : 0.01 };
}

/**
 * The bid price: one tick over the best competing bid, at most the target (minus the maker fee, on the tick grid),
 * below the best ask (post-only), within [0.01, 0.99]; null when no such price exists.
 */
export function bidPrice(top: Top, target: number, fee: FeeRates): number | null {
  const tick = top.tick;
  let price = floorTick(target, tick);
  if (top.bestBid !== null) price = Math.min(price, floorTick(top.bestBid + tick, tick));
  if (top.bestAsk !== null && price >= top.bestAsk - 1e-9) price = floorTick(top.bestAsk - tick, tick);
  const makerFee = (c: number) => ((fee.makerRate || 0) > 0 ? (fee.formula === 'price' ? fee.makerRate * c * (1 - c) : fee.makerRate * c) : 0);
  while (price >= MIN_PRICE && price + makerFee(price) > target + 1e-9) price = round6(price - tick);
  price = round6(price);
  return price >= MIN_PRICE - 1e-9 && price <= MAX_PRICE + 1e-9 ? price : null;
}

export interface Invalidation {
  kind: 'rules' | 'dispute' | 'ambiguity' | 'forecast' | 'flag' | 'end';
  reason: string;
}

export interface Baseline {
  rulesHash: string | null;
  at: number;
}

/** The first invalidation that holds now, or null (pure). */
export function invalidation(
  cfg: ResolutionConfig,
  m: MarketDetail,
  baseline: Baseline,
  forecasts: { own: BotForecast | null; complement: BotForecast | null } | null,
  flags: BotExitFlag[],
  now: number
): Invalidation | null {
  if (cfg.invalidateOnRulesChange) {
    const changedAt = m.rulesChangedAt ? Date.parse(m.rulesChangedAt) : NaN;
    if ((baseline.rulesHash !== null && m.rulesHash !== null && m.rulesHash !== baseline.rulesHash) || (Number.isFinite(changedAt) && changedAt > baseline.at)) {
      return { kind: 'rules', reason: `resolution rules changed${m.rulesChangedAt ? ` at ${m.rulesChangedAt}` : ''}` };
    }
  }
  if (m.disputed) return { kind: 'dispute', reason: 'UMA dispute recorded' };
  if (m.ambiguityScore !== null && m.ambiguityScore > cfg.maxAmbiguity) return { kind: 'ambiguity', reason: `ambiguity ${m.ambiguityScore} > max ${cfg.maxAmbiguity}` };
  if (cfg.forecastId && forecasts) {
    const fair = forecasts.own ? forecasts.own.probability : forecasts.complement ? 1 - forecasts.complement.probability : null;
    if (fair === null) return { kind: 'forecast', reason: `linked forecast ${cfg.forecastId} withdrawn (no active forecast on the token)` };
    if (fair + 1e-9 < cfg.target) return { kind: 'forecast', reason: `forecast now values the token at ${fair.toFixed(3)} < target ${cfg.target}` };
  }
  const flag = flags.find((f) => f.tokenId === cfg.tokenId);
  if (flag) return { kind: 'flag', reason: `exit flag: ${flag.reason.slice(0, 200)}` };
  const end = m.endDate ? Date.parse(m.endDate) : NaN;
  if (Number.isFinite(end) && (end - now) / MIN_MS <= cfg.invalidateBeforeEndMinutes) {
    return { kind: 'end', reason: `${Math.max(Math.round((end - now) / MIN_MS), 0)} min to the market end` };
  }
  return null;
}

export interface RrState {
  baseline: Baseline;
  invalid: (Invalidation & { at: number }) | null;
}

export interface CycleResult {
  action: 'bid' | 'kept' | 'full' | 'waiting' | 'invalidated' | 'invalid' | 'halted' | 'retire' | 'none';
  price?: number;
  size?: number;
  detail?: string;
}

/** One cycle (exported for tests; the lifecycle below calls it). */
export async function runResolutionCycle(ctx: BotContext): Promise<CycleResult> {
  const now = ctx.now;
  const { cfg, errors } = resolutionConfig(ctx.config);
  if (errors.length) return { action: 'invalid', detail: errors.join('; ') };

  const open = (await ctx.polymarket.getOpenOrders()).filter((o) => o.side === 'buy' && !o.placedBy && o.tokenId === cfg.tokenId);
  const cancelAll = async () => {
    let n = 0;
    for (const o of open) {
      try {
        await ctx.polymarket.cancel(o.orderId);
        n++;
      } catch {
        /* filled or gone */
      }
    }
    return n;
  };

  const m = await ctx.polymarket.getMarket(cfg.tokenId);
  if (!m) {
    await cancelAll();
    return { action: 'waiting', detail: 'market unknown to the market cache' };
  }
  const held = (await ctx.getPositions()).find((p) => p.tokenId === cfg.tokenId);
  const heldShares = held?.size ?? 0;

  if (m.closed) {
    await cancelAll();
    return { action: 'retire', detail: 'market closed (resolved)' };
  }

  const saved = await ctx.storage.get<RrState>(STATE_KEY);
  const state: RrState = saved && saved.baseline ? saved : { baseline: { rulesHash: m.rulesHash, at: now }, invalid: null };
  if (!saved) await ctx.storage.set(STATE_KEY, state);

  if (!state.invalid) {
    let forecasts: { own: BotForecast | null; complement: BotForecast | null } | null = null;
    if (cfg.forecastId) {
      forecasts = {
        own: await ctx.ledger.getForecast(cfg.tokenId),
        complement: m.complementTokenId ? await ctx.ledger.getForecast(m.complementTokenId) : null,
      };
    }
    const flags = await ctx.risk.getExitFlags();
    const inv = invalidation(cfg, m, state.baseline, forecasts, flags, now);
    if (inv) {
      state.invalid = { ...inv, at: now };
      await ctx.storage.set(STATE_KEY, state);
      await cancelAll();
      ctx.log.warn(`resolution-rule: invalidated (${inv.kind}): ${inv.reason}; bids cancelled, no more buying (exits: Position Manager)`);
      ctx.emit('resolution_rule', { state: 'invalidated', kind: inv.kind, reason: inv.reason, heldShares });
      return heldShares > 1e-9 ? { action: 'invalidated', detail: inv.reason } : { action: 'retire', detail: `invalidated (${inv.kind}): ${inv.reason}` };
    }
  }
  if (state.invalid) {
    await cancelAll();
    // Nothing left to hold: the opportunity is over
    if (heldShares <= 1e-9) return { action: 'retire', detail: `invalidated (${state.invalid.kind}) and flat` };
    return { action: 'invalidated', detail: state.invalid.reason };
  }

  if (!m.inScope) {
    await cancelAll();
    return { action: 'invalid', detail: `market ${m.marketId} is not in the bot's market_ids` };
  }
  if (m.ambiguityScore === null) {
    await cancelAll();
    return { action: 'waiting', detail: 'market not assessed for ambiguity yet (assess_market): buys would be refused' };
  }

  const budget = await ctx.risk.getBudget();
  if (budget.halted) {
    await cancelAll();
    return { action: 'halted' };
  }

  // Size: what is left of max_size_usd after the cost held, within the budget (our open bids are re-planned)
  const openUsd = open.reduce((n, o) => n + o.price * Math.max(o.size - o.filledSize, 0), 0);
  const heldCost = held ? held.size * held.avgPrice : 0;
  const roomMarket = m.marketId in budget.remainingMarket ? budget.remainingMarket[m.marketId] + openUsd : Infinity;
  const usd = Math.min(cfg.maxSizeUsd - heldCost, budget.remainingAllocation + openUsd, roomMarket);

  let book: OrderBook;
  let fee: FeeRates;
  try {
    [book, fee] = await Promise.all([ctx.getOrderBook(cfg.tokenId), ctx.polymarket.getFee(cfg.tokenId)]);
  } catch (err) {
    return { action: 'waiting', detail: `no book: ${errMsg(err)}` };
  }
  const top = topWithoutOwn(book, open);
  const price = bidPrice(top, cfg.target, fee);
  const size = price !== null ? Math.floor((Math.max(usd, 0) / price) * 100) / 100 : 0;
  if (price === null || size < MIN_SHARES) {
    const n = await cancelAll();
    return { action: 'full', detail: price === null ? 'no bid price at or under the target' : `size left ${usd.toFixed(2)} USD is under the minimum order${n ? ` (${n} bid(s) cancelled)` : ''}` };
  }

  // Keep a bid at the planned price with a similar size and enough life left
  const keep = open.find(
    (o) =>
      Math.abs(o.price - price) < 1e-9 &&
      Math.abs((o.size - o.filledSize) * o.price - size * price) <= Math.max(size * price * 0.15, 1) &&
      (o.expiresAt ? Date.parse(o.expiresAt) : Infinity) - now > (cfg.requoteMinutes + 1) * MIN_MS
  );
  for (const o of open) {
    if (keep && o.orderId === keep.orderId) continue;
    try {
      await ctx.polymarket.cancel(o.orderId);
    } catch {
      /* gone */
    }
  }
  if (keep) return { action: 'kept', price, size };
  const r = await ctx.polymarket.placeLimit(cfg.tokenId, 'buy', price, size, {
    postOnly: true,
    ttlMinutes: Math.max(3, Math.ceil(cfg.requoteMinutes * 2 + 2)),
    // No forecastId tag: this is not a ledger-driven order (no category-rights gate, spec §3.3), the thesis is the edge
    reason: `resolution-rule: bid ≤ target ${cfg.target}`,
  });
  if (!r.ok) ctx.log.info(`resolution-rule: bid ${size} @ ${price} not placed: ${r.error ?? r.status}`);
  return { action: 'bid', price, size, ...(r.ok ? {} : { detail: r.error ?? r.status }) };
}

// ─── Lifecycle ─────────────────────────────────────────────────────────

let lastRunAt = 0;
let dirty = true;
let running = false;
let retiring = false;
let lastAction = '';

export async function onStart(ctx) {
  lastRunAt = 0;
  dirty = true;
  retiring = false;
  const { cfg, errors } = resolutionConfig(ctx.config);
  const all = [...errors];
  if (!errors.length) {
    const m = await ctx.polymarket.getMarket(cfg.tokenId);
    if (!m) all.push(`token ${cfg.tokenId}: market unknown`);
    else if (!m.tokenId) all.push(`token ${cfg.tokenId} is not an outcome token of market ${m.marketId}`);
    else if (!m.inScope) all.push(`token ${cfg.tokenId}: market ${m.marketId} is not in the bot's market_ids`);
  }
  if (all.length) {
    const msg = `invalid resolution-rule config: ${all.join('; ')}`;
    ctx.log.error(msg);
    ctx.emit('resolution_rule', { state: 'error', reason: msg });
    throw new Error(msg);
  }
  const wake = () => {
    dirty = true;
  };
  ctx.events.on('rules_changed', wake);
  ctx.events.on('forecast_changed', wake);
  ctx.events.on('halt', wake);
  ctx.log.info(`Resolution-rule bot started: ${cfg.tokenId} up to ${cfg.target}, max $${cfg.maxSizeUsd}. Thesis: ${cfg.thesis.slice(0, 200)}`);
}

export async function onTick(ctx) {
  const { cfg } = resolutionConfig(ctx.config);
  if (running || retiring) return;
  if (!dirty && ctx.now - lastRunAt < cfg.requoteMinutes * MIN_MS) return;
  running = true;
  dirty = false;
  try {
    const r = await runResolutionCycle(ctx);
    lastRunAt = ctx.now;
    if (r.action !== lastAction) {
      ctx.emit('resolution_rule', { state: r.action, ...(r.price !== undefined ? { price: r.price, size: r.size } : {}), ...(r.detail ? { reason: r.detail } : {}) });
      if (r.action !== 'kept' && r.action !== 'bid') ctx.log.info(`resolution-rule: ${r.action}${r.detail ? ` — ${r.detail}` : ''}`);
      lastAction = r.action;
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
  return { role: 'resolution-rule', lastRunAt, state: lastAction };
}
