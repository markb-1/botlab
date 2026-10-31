/**
 * Copy Trading v2 (spec §9.5) — builtin, optional strategy (`copy` in mandate.strategies.allow; off by default).
 *
 * Follows a few Polymarket wallets ("leaders", config `leaders`) and mirrors their trades:
 *   - Activity: the data API `activity` of each leader, paginated (100 per page) until the last trade already seen;
 *     only `type === 'TRADE'` rows; de-duplicated by transaction hash + log index (persisted in ctx.storage); processed
 *     oldest first. The first poll of a leader only records what is there (no backlog is copied).
 *   - Buys: a limit order at the leader's fill price + `max_chase` (default 1¢), GTD `ttl_minutes` (default 10, ≥ 3).
 *     It takes what the book offers up to that price and rests the rest; when the best ask is already above that
 *     price the trade is skipped — never a market order, never a chase.
 *     Size = `copy_fraction` × the leader's USD (or `fixed_usd`), capped by `max_order_usd`, the risk budget
 *     (ctx.risk.getBudget: allocation and per-market room). No small-trade boost.
 *   - Sells: the same fraction of our position as the leader sold of theirs (their position read from the data API;
 *     else USD ÷ bid), capped at what we hold net of open sells, as a limit at the leader's price − `max_chase`
 *     (rests when the bid is lower; reducing a position, so it is not skipped).
 *   - Leader filters (buys only; sells always mirror): leader trade ≥ `min_leader_trade_usd`; at most
 *     `max_leader_trades_per_day` leader trades per UTC day (more ⇒ a high-frequency wallet, its buys are skipped for
 *     the day); a buy within `mm_window_minutes` of an opposite-direction trade by the same leader in the same market
 *     (selling it, or buying the other outcome) is market making and skipped; trades older than
 *     `max_trade_age_minutes` are not copied.
 *   - Off unless `copy` is in mandate.strategies.allow: without it no buys (sells still mirror to unwind).
 *   - Market filters (buys only): the market must pass the mandate (ctx.risk.getMandateSummary: category allowed,
 *     liquidity, settlement horizon, assessed ambiguity ≤ max), have no dispute and no rules change in the last 24 h,
 *     and not be inside the Position Manager's exit window (ctx.risk.getExitPolicy) or at its ambiguity exit score.
 *     A token with an open exit flag, or one the Position Manager sold (placedBy) in the last `pm_cooldown_days`, is
 *     not bought again.
 *   - Leaders: the server scores each leader's copies (copy_leaders; ctx.copy.getLeaders) and drops one whose last 20
 *     closed copied trades lost money with a hit rate under 50 % (audited + Telegram). A dropped leader is not copied
 *     again (its sells are still mirrored to unwind); only a human re-activates it. Orders carry the leader
 *     (LimitOrderOpts.copy) so fills are attributed. Leader changes in the config apply at the next start.
 * All state lives in ctx.storage (`copy:state`); limits are the risk engine's.
 */

export const meta = {
  name: 'Copy Trading',
  description:
    'Copies selected Polymarket leaders with resting limits near their fill (never chasing), mandate-filtered markets, sells mirroring their sold fraction; leaders are scored and dropped when their copies lose',
  version: '2.0.0',
  author: 'BotLab',
  // Builtin strategy role (5c; the agent may create these when the mandate allows `copy`); new code ⇒ paper first
  role: 'copy',
  trust: 'new',
  configSchema: {
    type: 'object',
    required: ['leaders'],
    properties: {
      leaders: {
        type: 'array',
        title: 'Leader addresses',
        description: 'Polymarket wallets (0x…) to copy; changes apply at the next start',
        items: { type: 'string', maxLength: 42 },
        maxItems: 20,
        default: [],
      },
      sizing: {
        type: 'string',
        title: 'Sizing',
        description: 'fraction: copy_fraction × the leader’s trade; fixed: fixed_usd per trade',
        enum: ['fraction', 'fixed'],
        default: 'fraction',
      },
      copy_fraction: {
        type: 'number',
        title: 'Copy fraction',
        description: 'Fraction of the leader’s USD trade size (0.1 = 10 %)',
        default: 0.1,
        minimum: 0.001,
        maximum: 1,
      },
      fixed_usd: {
        type: 'number',
        title: 'Fixed size (USD)',
        default: 5,
        minimum: 1,
      },
      max_order_usd: {
        type: 'number',
        title: 'Max order (USD)',
        default: 25,
        minimum: 1,
      },
      max_chase: {
        type: 'number',
        title: 'Max chase',
        description: 'Highest price above the leader’s fill we pay (buys) / lowest below it we accept (sells)',
        default: 0.01,
        minimum: 0,
        maximum: 0.05,
      },
      ttl_minutes: {
        type: 'number',
        title: 'Order lifetime (minutes)',
        default: 10,
        minimum: 3,
        maximum: 60,
      },
      min_leader_trade_usd: {
        type: 'number',
        title: 'Min leader trade (USD)',
        description: 'Leader buys smaller than this are noise and not copied',
        default: 10,
        minimum: 0,
      },
      max_leader_trades_per_day: {
        type: 'integer',
        title: 'Max leader trades per day',
        description: 'A leader trading more than this in a UTC day is high-frequency: its buys are skipped for the day',
        default: 40,
        minimum: 1,
      },
      mm_window_minutes: {
        type: 'number',
        title: 'Market-making window (minutes)',
        description: 'Skip a leader buy within this many minutes of an opposite trade by the leader in the same market',
        default: 30,
        minimum: 0,
        maximum: 1440,
      },
      max_trade_age_minutes: {
        type: 'number',
        title: 'Max trade age (minutes)',
        description: 'Leader trades older than this are not copied',
        default: 30,
        minimum: 1,
        maximum: 1440,
      },
      pm_cooldown_days: {
        type: 'number',
        title: 'Position Manager cooldown (days)',
        description: 'Do not buy back a token the Position Manager sold within this many days',
        default: 7,
        minimum: 0,
        maximum: 30,
      },
      pollingIntervalMs: {
        type: 'number',
        title: 'Polling interval (ms)',
        default: 15000,
        minimum: 5000,
      },
    },
  },
};

const DATA_API = 'https://data-api.polymarket.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MIN_SHARES = 5;
const MIN_PRICE = 0.01;
const MAX_PRICE = 0.99;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
/** Seen keys are kept this long behind the newest processed trade (re-listed rows inside it are recognised) */
const SEEN_RETENTION_MS = 6 * 3_600_000;
const MAX_SEEN = 3000;
const STATE_KEY = 'copy:state';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface CopyConfig {
  leaders: string[];
  sizing: 'fraction' | 'fixed';
  copyFraction: number;
  fixedUsd: number;
  maxOrderUsd: number;
  maxChase: number;
  ttlMinutes: number;
  minLeaderTradeUsd: number;
  maxLeaderTradesPerDay: number;
  mmWindowMinutes: number;
  maxTradeAgeMinutes: number;
  pmCooldownDays: number;
  pollingIntervalMs: number;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Parse the config (pre-v2 keys `traders`, `baseMultiplier`, `maxOrderSizeUsd`, `pollingIntervalMs` still read). */
export function copyConfig(raw: Record<string, any>): { cfg: CopyConfig; errors: string[] } {
  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d;
  const errors: string[] = [];
  const list = Array.isArray(raw.leaders) ? raw.leaders : Array.isArray(raw.traders) ? raw.traders : [];
  const leaders: string[] = [];
  for (const v of list) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!ADDRESS_RE.test(s)) errors.push(`leader ${String(v).slice(0, 50)} is not a 0x address`);
    else if (!leaders.includes(s.toLowerCase())) leaders.push(s.toLowerCase());
  }
  if (leaders.length === 0 && errors.length === 0) errors.push('leaders: add at least one leader address');
  if (leaders.length > 20) errors.push('at most 20 leaders');
  const ttl = num(raw.ttl_minutes, 10);
  if (ttl < 3) errors.push('ttl_minutes must be at least 3 (Polymarket GTD minimum)');
  return {
    cfg: {
      leaders,
      sizing: raw.sizing === 'fixed' ? 'fixed' : 'fraction',
      copyFraction: Math.min(Math.max(num(raw.copy_fraction, num(raw.baseMultiplier, 0.1)), 0), 1),
      fixedUsd: Math.max(num(raw.fixed_usd, 5), 0),
      maxOrderUsd: Math.max(num(raw.max_order_usd, num(raw.maxOrderSizeUsd, 25)), 0),
      maxChase: Math.min(Math.max(num(raw.max_chase, 0.01), 0), 0.05),
      ttlMinutes: Math.min(Math.max(ttl, 3), 60),
      minLeaderTradeUsd: Math.max(num(raw.min_leader_trade_usd, 10), 0),
      maxLeaderTradesPerDay: Math.max(Math.floor(num(raw.max_leader_trades_per_day, 40)), 1),
      mmWindowMinutes: Math.min(Math.max(num(raw.mm_window_minutes, 30), 0), 1440),
      maxTradeAgeMinutes: Math.min(Math.max(num(raw.max_trade_age_minutes, 30), 1), 1440),
      pmCooldownDays: Math.min(Math.max(num(raw.pm_cooldown_days, 7), 0), 30),
      pollingIntervalMs: Math.max(num(raw.pollingIntervalMs, 15000), 5000),
    },
    errors,
  };
}

// ─── Leader activity ───────────────────────────────────────────────────

/** A leader's TRADE row, normalised */
export interface LeaderTrade {
  key: string;
  ts: number;
  side: 'BUY' | 'SELL';
  tokenId: string;
  conditionId: string | null;
  outcomeIndex: number | null;
  size: number;
  price: number;
  usd: number;
}

const tsOf = (row: any): number => {
  const t = Number(row?.timestamp);
  return Number.isFinite(t) ? (t < 1e12 ? t * 1000 : t) : 0;
};

/**
 * De-duplication key of an activity row: transaction hash + log index. Rows without a log index (the data API does
 * not always return one) use the fill's asset / side / size / price in the transaction, plus `#n` for the n-th
 * identical fill in it.
 */
export function tradeKeys(rows: any[]): string[] {
  const counts = new Map<string, number>();
  return rows.map((r) => {
    const tx = String(r?.transactionHash ?? r?.transaction_hash ?? '').toLowerCase();
    const log = r?.logIndex ?? r?.log_index;
    if (tx && log !== undefined && log !== null && String(log) !== '') return `${tx}:${String(log)}`;
    const base = `${tx || `t${tsOf(r)}`}:${String(r?.asset ?? '')}:${String(r?.side ?? '')}:${String(r?.size ?? '')}:${String(r?.price ?? '')}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

function normalise(row: any, key: string): LeaderTrade | null {
  if (!row || row.type !== 'TRADE') return null;
  const side = row.side === 'BUY' || row.side === 'SELL' ? row.side : null;
  const tokenId = String(row.asset ?? row.tokenId ?? '');
  const size = parseFloat(String(row.size ?? '0')) || 0;
  const price = parseFloat(String(row.price ?? '0')) || 0;
  if (!side || !tokenId || !(size > 0)) return null;
  const usd = parseFloat(String(row.usdcSize ?? '')) || size * price;
  const oi = Number(row.outcomeIndex);
  return {
    key,
    ts: tsOf(row),
    side,
    tokenId,
    conditionId: row.conditionId ? String(row.conditionId) : null,
    outcomeIndex: Number.isInteger(oi) ? oi : null,
    size,
    price,
    usd,
  };
}

/** Oldest first: the API lists newest first, so reverse, then a stable sort by time keeps same-second rows in order (R36). */
export function oldestFirst<T extends { ts: number }>(rows: T[]): T[] {
  return rows
    .slice()
    .reverse()
    .sort((a, b) => a.ts - b.ts);
}

export interface LeaderCursor {
  /** Newest processed trade time (ms) */
  lastTs: number;
  /** Seen trade keys with their time, newest last */
  seen: Array<[string, number]>;
}

/**
 * New TRADE rows of a leader since its cursor, oldest first. Pages of 100 are read until a page holds a trade already
 * seen or older than the cursor (or a short page, or 10 pages). Without a cursor only the first page is read and
 * nothing is returned as new (the cursor starts there).
 */
export async function fetchNewTrades(
  ctx: BotContext,
  leader: string,
  cursor: LeaderCursor | null
): Promise<{ trades: LeaderTrade[]; cursor: LeaderCursor; truncated: boolean }> {
  const seen = new Set((cursor?.seen ?? []).map(([k]) => k));
  const rows: any[] = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await ctx.fetch(`${DATA_API}/activity?user=${leader}&type=TRADE&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
    if (!resp.ok) throw new Error(`activity API HTTP ${resp.status}`);
    const batch = await resp.json<any[]>();
    if (!Array.isArray(batch)) throw new Error('activity API: unexpected answer');
    rows.push(...batch);
    if (!cursor || batch.length < PAGE_SIZE) break;
    const keys = tradeKeys(rows).slice(rows.length - batch.length);
    if (batch.some((r, i) => seen.has(keys[i]) || tsOf(r) < cursor.lastTs)) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  const keys = tradeKeys(rows);
  const all = rows.map((r, i) => normalise(r, keys[i])).filter((t): t is LeaderTrade => t !== null);
  if (!cursor) {
    const lastTs = all.reduce((n, t) => Math.max(n, t.ts), 0);
    return { trades: [], cursor: { lastTs, seen: all.map((t) => [t.key, t.ts] as [string, number]).slice(-MAX_SEEN) }, truncated: false };
  }
  // Rows older than the seen window cannot be told apart from processed ones: not new
  const floor = cursor.lastTs - SEEN_RETENTION_MS;
  const fresh = oldestFirst(all.filter((t) => !seen.has(t.key) && t.ts >= floor));
  return { trades: fresh, cursor, truncated };
}

/** Record a processed trade in the cursor (keys kept for SEEN_RETENTION_MS behind the newest) */
export function markSeen(cursor: LeaderCursor, t: LeaderTrade): void {
  cursor.lastTs = Math.max(cursor.lastTs, t.ts);
  cursor.seen.push([t.key, t.ts]);
  const floor = cursor.lastTs - SEEN_RETENTION_MS;
  cursor.seen = cursor.seen.filter(([, ts]) => ts >= floor).slice(-MAX_SEEN);
}

// ─── Leader filters ────────────────────────────────────────────────────

/** +1: long the market's first outcome (buy it / sell the other); −1: the opposite. Selling outcome i ≈ buying the other. */
export function directionOf(t: Pick<LeaderTrade, 'side' | 'outcomeIndex'>): number {
  return (t.side === 'BUY' ? 1 : -1) * (t.outcomeIndex === 1 ? -1 : 1);
}

/** The leader traded the other direction of the same market within the window (market making) */
export function isMarketMaking(recent: Array<[string, number, number]>, t: LeaderTrade, windowMs: number): boolean {
  if (!t.conditionId || windowMs <= 0) return false;
  const dir = directionOf(t);
  return recent.some(([cid, d, ts]) => cid === t.conditionId && d === -dir && Math.abs(t.ts - ts) <= windowMs);
}

// ─── Sizing and prices ─────────────────────────────────────────────────

/** USD to buy: copy_fraction × leader USD (or fixed), capped by max_order_usd, the allocation left and the market room. */
export function buyUsd(cfg: CopyConfig, leaderUsd: number, budget: RiskBudget, marketId: string): { usd: number; cappedBy: string | null } {
  const base = cfg.sizing === 'fixed' ? cfg.fixedUsd : cfg.copyFraction * Math.max(leaderUsd, 0);
  let usd = base;
  let cappedBy: string | null = null;
  const cap = (v: number, why: string) => {
    if (v < usd) {
      usd = v;
      cappedBy = why;
    }
  };
  cap(cfg.maxOrderUsd, 'max_order_usd');
  cap(Math.max(budget.remainingAllocation, 0), 'risk budget');
  if (marketId in budget.remainingMarket) cap(Math.max(budget.remainingMarket[marketId], 0), 'market room');
  return { usd: round6(Math.max(usd, 0)), cappedBy };
}

/** Buy limit = leader fill + max_chase on the tick grid; skipped when the best ask is already above it. */
export function planBuyPrice(leaderPrice: number, maxChase: number, bestAsk: number | null, tick: number): { price: number } | { skip: string } {
  const limit = round6(Math.floor((Math.min(leaderPrice + maxChase, MAX_PRICE) + 1e-9) / tick) * tick);
  if (!(limit >= MIN_PRICE)) return { skip: 'leader price below the minimum' };
  if (bestAsk !== null && bestAsk > limit + 1e-9) return { skip: `book moved: best ask ${bestAsk} > leader ${leaderPrice} + chase ${maxChase}` };
  return { price: limit };
}

/** Sell limit = leader fill − max_chase on the tick grid (rests when the bid is lower: no chase). */
export function planSellPrice(leaderPrice: number, maxChase: number, tick: number): number {
  return round6(Math.min(Math.max(Math.ceil((Math.max(leaderPrice - maxChase, MIN_PRICE) - 1e-9) / tick) * tick, MIN_PRICE), MAX_PRICE));
}

/**
 * Token amount to sell when copying a leader's sell. Pure (unit-tested).
 * - Leader's sold fraction known (sold tokens + leader's remaining position): sell that fraction of ours.
 * - Otherwise: copy size in USD converted to tokens at `price`.
 * Always capped at `heldTokens` (pass what is held net of open sells); rounded down to 0.01 tokens.
 */
export function copySellSize(p: {
  heldTokens: number;
  leaderSoldTokens?: number | null;
  leaderRemainingTokens?: number | null;
  copyUsd: number;
  price?: number | null;
}): { tokens: number; basis: 'fraction' | 'usd' | 'none'; reason?: string } {
  const held = Number(p.heldTokens);
  if (!(held > 0)) return { tokens: 0, basis: 'none', reason: 'no position held (net of open sells)' };

  let tokens: number;
  let basis: 'fraction' | 'usd';
  const sold = Number(p.leaderSoldTokens);
  const remaining = p.leaderRemainingTokens === null || p.leaderRemainingTokens === undefined ? NaN : Number(p.leaderRemainingTokens);
  if (sold > 0 && Number.isFinite(sold) && remaining >= 0 && Number.isFinite(remaining)) {
    tokens = held * Math.min(1, sold / (sold + remaining));
    basis = 'fraction';
  } else if (Number(p.price) > 0 && Number(p.copyUsd) > 0) {
    tokens = Number(p.copyUsd) / Number(p.price);
    basis = 'usd';
  } else {
    return { tokens: 0, basis: 'none', reason: 'leader fraction and price unknown' };
  }

  tokens = Math.floor(Math.min(tokens, held) * 100 + 1e-9) / 100;
  if (!(tokens > 0)) return { tokens: 0, basis, reason: 'size rounds to zero' };
  return { tokens, basis };
}

/** Shares held minus what open sells (own or the Position Manager's) already commit. */
export function availableToSell(heldTokens: number, open: Array<Pick<OpenOrder, 'tokenId' | 'side' | 'size' | 'filledSize'>>, tokenId: string): number {
  const committed = open.filter((o) => o.side === 'sell' && o.tokenId === tokenId).reduce((n, o) => n + Math.max(o.size - o.filledSize, 0), 0);
  return Math.max(round6(heldTokens - committed), 0);
}

// ─── Market filters ────────────────────────────────────────────────────

/**
 * Why a market may not be bought (null = it may): the mandate's filters as the risk engine applies them, plus the
 * Position Manager's exit triggers (no point buying what it would sell at once).
 */
export function marketSkipReason(m: MarketDetail | null, mandate: MandateSummary | null, policy: ExitPolicy, now: number): string | null {
  if (!m) return 'market unknown';
  if (m.closed || !m.active) return 'market closed';
  if (!m.inScope) return "market outside the bot's market_ids";
  if (!mandate) return 'mandate unavailable (config invalid)';
  if (!mandate.strategiesAllow.includes('copy')) return 'copy is not in mandate.strategies.allow (copy trading is off)';
  if (!mandate.categoriesAllow.includes(m.category)) return `category ${m.category} not allowed by the mandate`;
  if (m.liquidityUsd === null || m.liquidityUsd < mandate.minLiquidityUsd) return `liquidity ${m.liquidityUsd ?? 'unknown'} < ${mandate.minLiquidityUsd}`;
  if (m.ambiguityScore === null) return 'market not assessed for ambiguity (buys are refused)';
  if (m.ambiguityScore > mandate.maxAmbiguityScore) return `ambiguity ${m.ambiguityScore} > mandate max ${mandate.maxAmbiguityScore}`;
  if (m.ambiguityScore >= policy.ambiguityExitScore) return `ambiguity ${m.ambiguityScore} ≥ Position Manager exit score`;
  if (m.disputed) return 'UMA dispute';
  const changed = m.rulesChangedAt ? Date.parse(m.rulesChangedAt) : NaN;
  if (Number.isFinite(changed) && now - changed < DAY_MS) return 'resolution rules changed in the last 24 h';
  const end = m.endDate ? Date.parse(m.endDate) : NaN;
  if (!Number.isFinite(end)) return 'end date unknown';
  const days = (end - now) / DAY_MS;
  const [s0, s1] = mandate.resolvesWithinDays;
  const [l0, l1] = mandate.longHorizonDays;
  if (!((days >= s0 && days <= s1) || (days >= l0 && days <= l1))) return `settles in ${days.toFixed(1)} days (outside the mandate horizons)`;
  if ((end - now) / MIN_MS <= policy.exitBeforeEndMinutes) return `inside the Position Manager's ${policy.exitBeforeEndMinutes}-min exit window before the end`;
  return null;
}

// ─── State ─────────────────────────────────────────────────────────────

export interface CopyState {
  v: 2;
  cursors: Record<string, LeaderCursor>;
  /** Leader trades per UTC day (all TRADE rows seen) */
  daily: Record<string, { day: string; count: number }>;
  /** Recent leader trades [conditionId, direction, ts] for market-maker detection */
  recent: Record<string, Array<[string, number, number]>>;
  copied: number;
}

async function loadState(ctx: BotContext): Promise<CopyState> {
  const s = await ctx.storage.get<CopyState>(STATE_KEY);
  return s && s.v === 2 && s.cursors ? s : { v: 2, cursors: {}, daily: {}, recent: {}, copied: 0 };
}

/** Leader's remaining position in `tokenId` after their sell, from the data API; null if unknown. */
async function fetchLeaderRemaining(ctx: BotContext, leader: string, conditionId: string | null, tokenId: string): Promise<number | null> {
  if (!conditionId) return null;
  try {
    const resp = await ctx.fetch(`${DATA_API}/positions?user=${leader}&market=${conditionId}&sizeThreshold=0`);
    if (!resp.ok) return null;
    const positions = await resp.json<any[]>();
    if (!Array.isArray(positions)) return null;
    // An unfiltered answer would make "absent" meaningless: treat it as unknown
    if (positions.some((x) => x.conditionId && String(x.conditionId).toLowerCase() !== String(conditionId).toLowerCase())) return null;
    const pos = positions.find((x) => String(x.asset) === String(tokenId));
    // Absent from the market's positions ⇒ the leader exited completely
    return pos ? Math.max(0, parseFloat(pos.size) || 0) : 0;
  } catch {
    return null;
  }
}

function topOfBook(book: OrderBook): { bestBid: number | null; bestAsk: number | null; tick: number } {
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

// ─── One cycle ─────────────────────────────────────────────────────────

export interface CopyCycleResult {
  action: 'polled' | 'invalid' | 'halted';
  copied: number;
  skipped: Record<string, number>;
  leaders: Record<string, string>;
  detail?: string;
}

/** One poll of every leader (exported for tests; the lifecycle below calls it). */
export async function runCopyCycle(ctx: BotContext): Promise<CopyCycleResult> {
  const now = ctx.now;
  const { cfg, errors } = copyConfig(ctx.config);
  const result: CopyCycleResult = { action: 'polled', copied: 0, skipped: {}, leaders: {} };
  if (errors.length) return { ...result, action: 'invalid', detail: errors.join('; ') };
  const skip = (why: string, t: LeaderTrade, leader: string) => {
    const k = why.replace(/[\d.]+/g, 'n').slice(0, 60);
    result.skipped[k] = (result.skipped[k] ?? 0) + 1;
    ctx.log.debug(`copy: skip ${t.side} ${t.tokenId.slice(0, 10)}… from ${short(leader)}: ${why}`);
  };

  // Leader status from the server (dropped ones are not bought again). A fork without ctx.copy copies every leader;
  // any other failure blocks buys this cycle (sells still mirror).
  let statuses: Record<string, string> = {};
  let buysAllowed = true;
  try {
    for (const s of await ctx.copy.getLeaders(cfg.leaders)) statuses[s.address] = s.status;
  } catch (err) {
    if (/only available/.test(errMsg(err))) statuses = Object.fromEntries(cfg.leaders.map((l) => [l, 'active']));
    else {
      buysAllowed = false;
      ctx.log.warn(`copy: leader status unavailable (${errMsg(err)}): sells only this cycle`);
    }
  }
  result.leaders = Object.fromEntries(cfg.leaders.map((l) => [l, statuses[l] ?? 'unknown']));

  const budget = await ctx.risk.getBudget();
  if (budget.halted) return { ...result, action: 'halted' };
  const mandate = await ctx.risk.getMandateSummary();
  const policy = await ctx.risk.getExitPolicy();
  const flags = await ctx.risk.getExitFlags();
  const history = await ctx.polymarket.getOrderHistory(30);
  const state = await loadState(ctx);
  const day = new Date(now).toISOString().slice(0, 10);
  const mmWindow = cfg.mmWindowMinutes * MIN_MS;
  const markets = new Map<string, MarketDetail | null>();

  for (const leader of cfg.leaders) {
    const status = statuses[leader] ?? 'unknown';
    let fetched: Awaited<ReturnType<typeof fetchNewTrades>>;
    try {
      fetched = await fetchNewTrades(ctx, leader, state.cursors[leader] ?? null);
    } catch (err) {
      ctx.log.warn(`copy: activity of ${short(leader)} unavailable: ${errMsg(err)}`);
      continue;
    }
    const first = !state.cursors[leader];
    state.cursors[leader] = fetched.cursor;
    if (first) {
      await ctx.storage.set(STATE_KEY, state);
      ctx.log.info(`copy: following ${short(leader)} from now (${fetched.cursor.seen.length} earlier trades not copied)`);
      continue;
    }
    if (fetched.truncated) ctx.log.warn(`copy: ${short(leader)} made more than ${PAGE_SIZE * MAX_PAGES} trades since the last poll; older ones are not copied`);
    const trades = fetched.trades;

    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      // Per-leader bookkeeping for every trade (filters below read it), then persist BEFORE any order: a crash
      // after this point can miss a copy, never double one
      const d = state.daily[leader]?.day === day ? state.daily[leader] : { day, count: 0 };
      d.count++;
      state.daily[leader] = d;
      const recent = (state.recent[leader] ?? []).filter(([, , ts]) => t.ts - ts <= Math.max(mmWindow, 0));
      const mm = isMarketMaking(recent, t, mmWindow);
      if (t.conditionId) recent.push([t.conditionId, directionOf(t), t.ts]);
      state.recent[leader] = recent.slice(-200);
      markSeen(state.cursors[leader], t);
      await ctx.storage.set(STATE_KEY, state);

      const tag = { leader, key: t.key, leaderPrice: t.price, leaderUsd: round6(t.usd) };
      if (t.side === 'SELL') {
        // Sells mirror the leader's sold fraction (any leader status: unwinding only reduces risk)
        const held = (await ctx.getPositions()).find((p) => p.tokenId === t.tokenId);
        if (!held || !(held.size > 0)) continue;
        const open = await ctx.polymarket.getOpenOrders();
        const available = availableToSell(held.size, open, t.tokenId);
        let laterNet = 0;
        for (const later of trades.slice(i + 1)) if (later.tokenId === t.tokenId) laterNet += later.side === 'BUY' ? later.size : -later.size;
        const leaderNow = await fetchLeaderRemaining(ctx, leader, t.conditionId, t.tokenId);
        const leaderRemaining = leaderNow === null ? null : Math.max(0, leaderNow - laterNet);
        let price: number | null = null;
        if (leaderRemaining === null) {
          try {
            const mp = await ctx.getMarketPrice(t.tokenId);
            price = mp.bid > 0 ? mp.bid : mp.mid;
          } catch {
            price = null;
          }
        }
        const sizing = copySellSize({
          heldTokens: available,
          leaderSoldTokens: t.size,
          leaderRemainingTokens: leaderRemaining,
          copyUsd: cfg.sizing === 'fixed' ? cfg.fixedUsd : cfg.copyFraction * t.usd,
          price,
        });
        if (sizing.tokens <= 0) {
          skip(sizing.reason ?? 'nothing to sell', t, leader);
          continue;
        }
        let tick = 0.01;
        try {
          tick = topOfBook(await ctx.getOrderBook(t.tokenId)).tick;
        } catch {
          /* default tick */
        }
        const sellPrice = planSellPrice(t.price, cfg.maxChase, tick);
        const r = await ctx.polymarket.placeLimit(t.tokenId, 'sell', sellPrice, sizing.tokens, {
          postOnly: false,
          ttlMinutes: cfg.ttlMinutes,
          reason: `copy ${short(leader)}: sell ${sizing.basis} (leader sold ${t.size} @ ${t.price})`,
          copy: tag,
        });
        if (r.ok) {
          result.copied++;
          state.copied++;
          ctx.log.info(`copy: SELL ${sizing.tokens} of ${available} @ ≥ ${sellPrice} (${sizing.basis}) after ${short(leader)}`);
        } else skip(`sell refused: ${r.error ?? r.status}`, t, leader);
        continue;
      }

      // BUY: leader filters, then market filters, then the book
      if (!buysAllowed) {
        skip('leader status unavailable', t, leader);
        continue;
      }
      if (status !== 'active') {
        skip(`leader ${status}`, t, leader);
        continue;
      }
      if (now - t.ts > cfg.maxTradeAgeMinutes * MIN_MS) {
        skip('leader trade too old', t, leader);
        continue;
      }
      if (t.usd < cfg.minLeaderTradeUsd) {
        skip('leader trade below min_leader_trade_usd', t, leader);
        continue;
      }
      if (d.count > cfg.maxLeaderTradesPerDay) {
        skip('leader over max_leader_trades_per_day', t, leader);
        continue;
      }
      if (mm) {
        skip('leader trades both sides of the market (market making)', t, leader);
        continue;
      }
      if (flags.some((f) => f.tokenId === t.tokenId)) {
        skip('exit flag open on the token', t, leader);
        continue;
      }
      const cooldownFrom = now - cfg.pmCooldownDays * DAY_MS;
      if (history.some((h) => h.placedBy && h.side === 'sell' && h.tokenId === t.tokenId && Date.parse(h.createdAt) >= cooldownFrom)) {
        skip('the Position Manager sold this token recently', t, leader);
        continue;
      }
      if (!markets.has(t.tokenId)) {
        try {
          markets.set(t.tokenId, await ctx.polymarket.getMarket(t.tokenId));
        } catch {
          markets.set(t.tokenId, null);
        }
      }
      const m = markets.get(t.tokenId) ?? null;
      const why = marketSkipReason(m, mandate, policy, now);
      if (why) {
        skip(why, t, leader);
        continue;
      }
      const sizing = buyUsd(cfg, t.usd, budget, m!.marketId);
      let top: ReturnType<typeof topOfBook>;
      try {
        top = topOfBook(await ctx.getOrderBook(t.tokenId));
      } catch (err) {
        skip(`no book: ${errMsg(err)}`, t, leader);
        continue;
      }
      const plan = planBuyPrice(t.price, cfg.maxChase, top.bestAsk, top.tick);
      if ('skip' in plan) {
        skip(plan.skip, t, leader);
        continue;
      }
      const shares = Math.floor((sizing.usd / plan.price) * 100) / 100;
      if (shares < MIN_SHARES) {
        skip(`size ${sizing.usd.toFixed(2)} USD below the minimum order${sizing.cappedBy ? ` (capped by ${sizing.cappedBy})` : ''}`, t, leader);
        continue;
      }
      const r = await ctx.polymarket.placeLimit(t.tokenId, 'buy', plan.price, shares, {
        postOnly: false,
        ttlMinutes: cfg.ttlMinutes,
        reason: `copy ${short(leader)}: leader bought ${t.size} @ ${t.price}`,
        copy: tag,
      });
      if (r.ok) {
        result.copied++;
        state.copied++;
        budget.remainingAllocation -= shares * plan.price;
        if (m!.marketId in budget.remainingMarket) budget.remainingMarket[m!.marketId] -= shares * plan.price;
        ctx.log.info(`copy: BUY ${shares} @ ≤ ${plan.price} after ${short(leader)} (${t.size} @ ${t.price})`);
      } else skip(`buy refused: ${r.failedCheck ?? r.error ?? r.status}`, t, leader);
    }
    await ctx.storage.set(STATE_KEY, state);
  }
  await ctx.storage.set(STATE_KEY, state);
  return result;
}

// ─── Lifecycle ─────────────────────────────────────────────────────────

let lastRunAt = 0;
let running = false;
let lastSummary: Record<string, unknown> = {};

export async function onStart(ctx) {
  lastRunAt = 0;
  const { cfg, errors } = copyConfig(ctx.config);
  if (errors.length) {
    const msg = `invalid copy-trading config: ${errors.join('; ')}`;
    ctx.log.error(msg);
    ctx.emit('copy', { state: 'error', reason: msg });
    throw new Error(msg);
  }
  ctx.log.info(
    `Copy Trading v2 started: ${cfg.leaders.length} leader(s), ${cfg.sizing === 'fixed' ? `$${cfg.fixedUsd} per trade` : `${cfg.copyFraction * 100}% of the leader`}, ` +
      `max $${cfg.maxOrderUsd}, chase ${cfg.maxChase}, TTL ${cfg.ttlMinutes} min`
  );
}

// onTick runs every `pollingIntervalMs` (the runner's tick)
export async function onTick(ctx) {
  if (running) return;
  running = true;
  try {
    const r = await runCopyCycle(ctx);
    lastRunAt = ctx.now;
    lastSummary = { state: r.action, copied: r.copied, skipped: r.skipped, leaders: r.leaders, ...(r.detail ? { reason: r.detail } : {}) };
    if (r.copied > 0 || Object.keys(r.skipped).length > 0 || r.action !== 'polled') ctx.emit('copy', lastSummary);
  } catch (err) {
    ctx.log.error(`copy: cycle failed: ${errMsg(err)}`);
  } finally {
    running = false;
  }
}

export async function onStop(ctx) {
  // Resting copy buys are short-lived (GTD); cancel them so nothing is bought while the bot is off
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
  return { role: 'copy', lastRunAt, ...lastSummary };
}
