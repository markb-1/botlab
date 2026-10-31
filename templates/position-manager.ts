/**
 * Position Manager (spec §9.2, §3.4) — standing builtin template, one instance per mode.
 *
 * Watches every bot's Polymarket positions in its mode (ctx.portfolio, granted by the server only to this
 * builtin template) and exits them as the owning bot with risk-exit SELLS. It cannot buy (the server refuses
 * any buy from this bot) and an exit can never exceed what the bot holds net of its open sells.
 *
 * Exit triggers, checked every `check_minutes` (and at once after a forecast_changed / rules_changed / halt
 * event):
 *   - flag:         an open exit flag (agent / human flag_position_exit, R140); acknowledged when the
 *                   position is closed
 *   - rules:        the market's rules changed after the position was opened
 *   - ambiguity:    ambiguity ≥ 2 (after the server raise) or a UMA dispute
 *   - end:          ambiguity ≥ 1 and less than `exit_before_end_minutes` to the market end
 *   Ledger positions (bought with a forecast) also:
 *   - withdrawn:    no active forecast prices the token any more (withdrawn, resolved, not replaced)
 *   - flipped:      the current forecast values the token below the average entry price
 *   - take-profit:  best bid ≥ fair − `take_profit_margin` (convergence, default exit; mirror for NO tokens
 *                   since the fair value is per token)
 *   - low edge/day: (fair − best bid) / days to end < `min_hold_edge_per_day` (simplified "better use")
 *   - stop:         best bid ≤ entry − `stop_loss_move` and the forecast was not renewed since entry
 * Exits rest post-only first (take-profit at max(best bid + tick, fair − margin), others one tick inside the
 * ask); after `escalate_after_minutes` without a full exit (or with the end closer than the escalation
 * window) they go marketable at best bid − `escalate_slippage`. Exits of positions whose trigger disappeared
 * are cancelled. `ignore_bot_ids` leaves bots alone.
 */

export const meta = {
  name: 'Position Manager',
  description: 'Standing bot (one per mode): exits positions across bots on convergence, forecast changes, rules changes, ambiguity, exit flags, stops and market end',
  version: '1.0.0',
  author: 'BotLab',
  // Standing builtin role and initial trust (seed only): new templates prove themselves in paper first (§4.5)
  role: 'position-manager',
  trust: 'new',
  configSchema: {
    type: 'object',
    properties: {
      take_profit_margin: {
        type: 'number',
        title: 'Take-profit margin',
        description: 'Exit when the best bid reaches fair value minus this',
        default: 0.02,
        minimum: 0,
        maximum: 0.5,
      },
      min_hold_edge_per_day: {
        type: 'number',
        title: 'Min edge per day to hold',
        description: 'Exit when (fair − best bid) / days to end falls below this (0 = off)',
        default: 0.001,
        minimum: 0,
      },
      stop_loss_move: {
        type: 'number',
        title: 'Stop move',
        description: 'Exit when the best bid is this far below the entry price and the forecast was not renewed',
        default: 0.15,
        minimum: 0.01,
        maximum: 0.9,
      },
      exit_before_end_minutes: {
        type: 'number',
        title: 'Exit before end (minutes)',
        description: 'Ambiguous markets (score ≥ 1): exit this long before the market end',
        default: 180,
        minimum: 0,
      },
      escalate_after_minutes: {
        type: 'number',
        title: 'Escalate after (minutes)',
        description: 'Resting exits not done after this become marketable',
        default: 30,
        minimum: 3,
      },
      escalate_slippage: {
        type: 'number',
        title: 'Marketable slippage',
        description: 'Marketable exits accept down to best bid minus this (the risk engine caps slippage too)',
        default: 0.02,
        minimum: 0,
        maximum: 0.1,
      },
      check_minutes: {
        type: 'number',
        title: 'Check every (minutes)',
        default: 2,
        minimum: 1,
        maximum: 60,
      },
      ignore_bot_ids: {
        type: 'array',
        title: 'Ignore bots',
        description: 'Bot ids whose positions this manager leaves alone',
        items: { type: 'string' },
        default: [],
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

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const MIN_PRICE = 0.01;
const MAX_PRICE = 0.99;

export interface ManagerConfig {
  takeProfitMargin: number;
  minHoldEdgePerDay: number;
  stopLossMove: number;
  exitBeforeEndMinutes: number;
  escalateAfterMinutes: number;
  escalateSlippage: number;
  checkMinutes: number;
  ignoreBotIds: string[];
}

export function managerConfig(raw: Record<string, any>): ManagerConfig {
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    takeProfitMargin: Math.max(num(raw.take_profit_margin, 0.02), 0),
    minHoldEdgePerDay: Math.max(num(raw.min_hold_edge_per_day, 0.001), 0),
    stopLossMove: Math.max(num(raw.stop_loss_move, 0.15), 0.01),
    exitBeforeEndMinutes: Math.max(num(raw.exit_before_end_minutes, 180), 0),
    escalateAfterMinutes: Math.max(num(raw.escalate_after_minutes, 30), 3),
    escalateSlippage: Math.min(Math.max(num(raw.escalate_slippage, 0.02), 0), 0.1),
    checkMinutes: Math.max(num(raw.check_minutes, 2), 1),
    ignoreBotIds: Array.isArray(raw.ignore_bot_ids) ? raw.ignore_bot_ids.filter((x: unknown): x is string => typeof x === 'string') : [],
  };
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

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const ceilTick = (p: number, tick: number): number => round6(Math.ceil(p / tick - 1e-9) * tick);
const floorTick = (p: number, tick: number): number => round6(Math.floor(p / tick + 1e-9) * tick);

export type ExitKind = 'flag' | 'rules' | 'ambiguity' | 'end' | 'withdrawn' | 'flipped' | 'take_profit' | 'low_edge' | 'stop';

export interface ExitDecision {
  kind: ExitKind;
  reason: string;
  /** Resting price (null ⇒ marketable at once) */
  restingPrice: number | null;
}

/**
 * Pure exit rule for one position, or null to hold. Risk triggers come first (flag, rules, ambiguity, end),
 * then the ledger triggers (withdrawn, flipped, take-profit, low edge per day, stop).
 */
export function exitDecision(p: PortfolioPosition, top: Top, cfg: ManagerConfig, now: number): ExitDecision | null {
  const m = p.market;
  const openedAt = p.openedAt ? Date.parse(p.openedAt) : NaN;
  const endMs = m?.endDate ? Date.parse(m.endDate) : NaN;
  const minutesToEnd = Number.isFinite(endMs) ? (endMs - now) / MIN_MS : null;
  const { bestBid, bestAsk, tick } = top;

  // Risk exits rest one tick inside the ask (never at or through the bid), else just above the bid
  const riskPrice = (): number | null => {
    let price = bestAsk !== null ? floorTick(bestAsk - tick, tick) : bestBid !== null ? ceilTick(bestBid + tick, tick) : null;
    if (price !== null && bestBid !== null && price <= bestBid + 1e-9) price = ceilTick(bestBid + tick, tick);
    return price === null ? null : Math.min(Math.max(price, MIN_PRICE), MAX_PRICE);
  };
  const risk = (kind: ExitKind, reason: string): ExitDecision => ({ kind, reason, restingPrice: riskPrice() });

  if (p.exitFlag) return risk('flag', `exit flag: ${p.exitFlag.reason.slice(0, 200)}`);
  if (m?.rulesChangedAt && Number.isFinite(openedAt) && Date.parse(m.rulesChangedAt) > openedAt) {
    return risk('rules', `rules changed ${m.rulesChangedAt}`);
  }
  if (m && ((m.ambiguityScore ?? 0) >= 2 || m.disputed)) {
    return risk('ambiguity', m.disputed ? 'UMA dispute' : `ambiguity ${m.ambiguityScore}`);
  }
  if (m && (m.ambiguityScore ?? 0) >= 1 && minutesToEnd !== null && minutesToEnd <= cfg.exitBeforeEndMinutes) {
    return risk('end', `ambiguity ${m.ambiguityScore}, ${Math.max(Math.round(minutesToEnd), 0)} min to end`);
  }

  if (!p.entryForecastId) return null; // not a ledger position: only the risk triggers apply
  const f = p.forecast;
  if (!f) return risk('withdrawn', `forecast ${p.entryForecastId} ${p.entryForecastStatus ?? 'gone'}, none active`);
  const fair = f.probability;
  if (fair < p.avgPrice - 1e-9) return risk('flipped', `forecast now ${fair.toFixed(3)} < entry ${p.avgPrice.toFixed(3)}`);
  if (bestBid !== null && bestBid + 1e-9 >= fair - cfg.takeProfitMargin) {
    const price = Math.min(Math.max(ceilTick(Math.max(bestBid + tick, fair - cfg.takeProfitMargin), tick), MIN_PRICE), MAX_PRICE);
    return { kind: 'take_profit', reason: `converged: bid ${bestBid} >= fair ${fair.toFixed(3)} − ${cfg.takeProfitMargin}`, restingPrice: price };
  }
  if (cfg.minHoldEdgePerDay > 0 && bestBid !== null && minutesToEnd !== null) {
    const days = Math.max(minutesToEnd / (DAY_MS / MIN_MS), 1);
    const perDay = (fair - bestBid) / days;
    if (perDay < cfg.minHoldEdgePerDay) {
      return risk('low_edge', `edge/day ${perDay.toFixed(5)} < ${cfg.minHoldEdgePerDay}`);
    }
  }
  const renewed = f.id !== p.entryForecastId;
  if (!renewed && bestBid !== null && bestBid <= p.avgPrice - cfg.stopLossMove + 1e-9) {
    return risk('stop', `bid ${bestBid} <= entry ${p.avgPrice.toFixed(3)} − ${cfg.stopLossMove}, forecast not renewed`);
  }
  return null;
}

interface ExitState {
  startedAt: number;
  kind: ExitKind;
  /** The position this state belongs to (a later position in the same token starts afresh) */
  openedAt: string | null;
}

const stateKey = (p: { botId: string; tokenId: string }) => `exit:${p.botId}:${p.tokenId}`;

export interface CycleResult {
  exits: Array<{ botId: string; tokenId: string; kind: ExitKind; size: number; marketable: boolean; status: string }>;
  cancelled: number;
  acked: number;
}

/** One full pass over all positions. Exported for tests; the lifecycle below calls it. */
export async function runManagerCycle(ctx: BotContext): Promise<CycleResult> {
  const cfg = managerConfig(ctx.config);
  const now = ctx.now;
  const out: CycleResult = { exits: [], cancelled: 0, acked: 0 };
  const positions = await ctx.portfolio.getAllPositions();

  // Flags on positions that no longer exist were handled (position closed): acknowledge them
  const held = new Set(positions.filter((p) => p.size > 1e-9).map((p) => `${p.botId}|${p.tokenId}`));
  for (const f of await ctx.portfolio.getExitFlags()) {
    if (held.has(`${f.botId}|${f.tokenId}`)) continue;
    try {
      if (await ctx.portfolio.ackExitFlag(f.id, 'position closed')) out.acked++;
    } catch (err) {
      ctx.log.warn(`position manager: could not acknowledge flag ${f.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await ctx.storage.delete(stateKey(f));
  }

  for (const p of positions) {
    if (cfg.ignoreBotIds.includes(p.botId) || p.market?.closed) continue;
    const mine = p.exitOrders.filter((o) => o.placedByMe);
    let top: Top;
    try {
      top = topOf(await ctx.getOrderBook(p.tokenId));
    } catch (err) {
      ctx.log.warn(`position manager: no book for ${p.tokenId}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const decision = exitDecision(p, top, cfg, now);
    const key = stateKey(p);

    if (!decision) {
      // Trigger gone: withdraw our exits
      for (const o of mine) {
        try {
          await ctx.portfolio.cancelExit(o.orderId);
          out.cancelled++;
        } catch {
          /* already filled or gone */
        }
      }
      await ctx.storage.delete(key);
      continue;
    }

    const saved = await ctx.storage.get<ExitState>(key);
    const valid = !!saved && typeof saved.startedAt === 'number' && saved.openedAt === p.openedAt;
    const state: ExitState = valid ? (saved as ExitState) : { startedAt: now, kind: decision.kind, openedAt: p.openedAt };
    if (!valid) await ctx.storage.set(key, state);

    const minutesToEnd = p.market?.endDate ? (Date.parse(p.market.endDate) - now) / MIN_MS : Infinity;
    const escalate =
      decision.restingPrice === null ||
      now - state.startedAt >= cfg.escalateAfterMinutes * MIN_MS ||
      (decision.kind !== 'take_profit' && minutesToEnd <= cfg.escalateAfterMinutes);

    // Everything we can sell: what is free plus what our own exits hold (they are replaced)
    const mineRemaining = mine.reduce((n, o) => n + Math.max(o.size - o.filledSize, 0), 0);
    const size = Math.floor((p.available + mineRemaining) * 100) / 100;
    if (!(size > 0)) continue;

    if (!escalate) {
      const price = decision.restingPrice as number;
      const same = mine.length === 1 && mine[0].orderType === 'limit' && Math.abs(mine[0].price - price) < 1e-9 && Math.abs(mine[0].size - mine[0].filledSize - size) < 0.01;
      if (same) continue;
    }
    for (const o of mine) {
      try {
        await ctx.portfolio.cancelExit(o.orderId);
        out.cancelled++;
      } catch {
        /* filled or gone; the server refuses an oversized exit anyway */
      }
    }
    const fresh = mine.length ? (await ctx.portfolio.getAllPositions()).find((x) => x.botId === p.botId && x.tokenId === p.tokenId) : p;
    const sellable = fresh ? Math.floor(fresh.available * 100) / 100 : 0;
    if (!(sellable > 0)) continue;

    const r = escalate
      ? await ctx.portfolio.exit({
          botId: p.botId,
          tokenId: p.tokenId,
          size: sellable,
          marketable: true,
          ...(top.bestBid !== null ? { price: Math.max(floorTick(top.bestBid - cfg.escalateSlippage, top.tick), MIN_PRICE) } : {}),
          reason: `${decision.kind} (marketable): ${decision.reason}`,
        })
      : await ctx.portfolio.exit({
          botId: p.botId,
          tokenId: p.tokenId,
          size: sellable,
          price: decision.restingPrice as number,
          ttlMinutes: Math.max(3, cfg.checkMinutes * 3),
          reason: `${decision.kind}: ${decision.reason}`,
        });
    out.exits.push({ botId: p.botId, tokenId: p.tokenId, kind: decision.kind, size: sellable, marketable: escalate, status: r.status });
    if (!r.ok) ctx.log.warn(`position manager: exit of ${p.botName ?? p.botId} ${p.tokenId} (${decision.kind}) not placed: ${r.error ?? r.status}`);
  }
  return out;
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
  ctx.log.info('Position manager started');
}

export async function onTick(ctx) {
  const cfg = managerConfig(ctx.config);
  if (running) return;
  if (!dirty && ctx.now - lastRunAt < cfg.checkMinutes * MIN_MS) return;
  running = true;
  dirty = false;
  try {
    const r = await runManagerCycle(ctx);
    lastRunAt = ctx.now;
    for (const e of r.exits) ctx.log.info(`position manager: ${e.kind} exit of ${e.size} ${e.tokenId} (bot ${e.botId})${e.marketable ? ' marketable' : ''}: ${e.status}`);
  } finally {
    running = false;
  }
}

export function onHeartbeat(ctx) {
  return { role: 'position-manager', lastRunAt };
}
