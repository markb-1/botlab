/**
 * Polymarket snapshot backtest (spec §10): replays recorded order-book snapshots (orderbook_snapshots).
 *
 * - Steps: snapshots are read oldest first; a new step starts when a token re-appears (one recorder cycle
 *   ≈ one step). Sim time = the newest snapshot in the step. The bot only ever sees, per token, the latest
 *   snapshot with ts ≤ sim time (no look-ahead).
 * - Each step: books are updated, then resting orders are checked against the new snapshots (only
 *   snapshots taken after the order was placed), then `onTick` runs.
 * - Marketable orders (ctx.buy / ctx.sell) are fill-or-kill against the visible book with depth, up to the
 *   worst price (maxPrice/minPrice or best ± maxSlippage); liquidity taken is removed from that book until
 *   the token's next snapshot. Taker fee per the market's fee model (feeModel.ts: shares × rate × p × (1 − p),
 *   or rate × notional when `formula` is `notional` / absent; R125).
 * - Resting limit orders (ctx.polymarket.placeLimit): post-only by default (rejected if crossing). A
 *   resting buy fills in full at its price when a later snapshot's best ask ≤ its price; a resting sell
 *   when the best bid ≥ its price. Maker fee rate. GTD expiry after `ttlMinutes` (capped like live).
 *   A non-post-only crossing limit takes what it can at its price or better and rests the rest.
 * - Cash is reserved for resting buys and shares for resting sells.
 *
 * Deterministic: no clock, no randomness; ids are counters.
 */

import { evaluateScript } from '../runtime/sandbox';
import type { BotContext, OrderBook } from '../sdk/types';
import type { BookSnapshot, Level } from '../recorder/snapshotCodec';
import { InMemoryStorageRepo, type SimulatedTrade, type SimulationOutput } from './simulate';
import { feeForFill, type FeeFormula, type FeeRates } from '../orders/feeModel';
import { GTD_MIN_TTL_MINUTES } from '../exchange/polymarket/gtd';

const EPS = 1e-9;
export const DEFAULT_TTL_MINUTES = 240;

export interface FeeRatesInput {
  takerRate: number;
  makerRate: number;
  /** Default `notional` (rate × notional, the conservative bound) */
  formula?: FeeFormula;
}

function asRates(r: FeeRatesInput): FeeRates {
  return { takerRate: r.takerRate, makerRate: r.makerRate, formula: r.formula ?? 'notional', source: 'market' };
}

export interface SnapshotSimulationInput {
  source: 'polymarket-snapshots';
  compiledScript: string;
  /** Sorted by ts then token id */
  snapshots: BookSnapshot[];
  tokenIds: string[];
  initialBalance: number;
  config: Record<string, unknown>;
  runId: string;
  /** Per token; missing ⇒ `defaultFees` */
  fees: Record<string, FeeRatesInput>;
  defaultFees: FeeRatesInput;
  /** Max resting order TTL (limits.orders.resting_order_ttl_minutes) */
  maxTtlMinutes?: number;
}

export interface SnapshotSimulationOutput extends SimulationOutput {
  steps: number;
  /** Mean ms between steps (for the Sharpe annualisation) */
  stepIntervalMs: number;
  feesPaid: number;
}

interface RestingOrder {
  orderId: string;
  tokenId: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  filled: number;
  placedAt: number;
  expiresAt: number;
  status: 'open' | 'filled' | 'cancelled' | 'expired';
}

/** Group sorted snapshots into steps: a token re-appearing starts a new step. */
export function groupSteps(snapshots: BookSnapshot[]): BookSnapshot[][] {
  const steps: BookSnapshot[][] = [];
  let current: BookSnapshot[] = [];
  let seen = new Set<string>();
  for (const s of snapshots) {
    if (seen.has(s.tokenId)) {
      steps.push(current);
      current = [];
      seen = new Set();
    }
    current.push(s);
    seen.add(s.tokenId);
  }
  if (current.length > 0) steps.push(current);
  return steps;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Market state + accounting for one backtest. Exposed for tests. */
export class SnapshotMarket {
  cash: number;
  readonly positions = new Map<string, { size: number; cost: number }>();
  readonly orders: RestingOrder[] = [];
  readonly trades: SimulatedTrade[] = [];
  feesPaid = 0;
  simTime = 0;
  private books = new Map<string, { bids: Level[]; asks: Level[]; ts: number; mid: number | null }>();
  private lastMid = new Map<string, number>();
  private seq = 0;

  constructor(
    initialBalance: number,
    private fees: (tokenId: string) => FeeRatesInput,
    private maxTtlMinutes = DEFAULT_TTL_MINUTES
  ) {
    this.cash = initialBalance;
  }

  /** Advance to a step: install its snapshots, then settle resting orders against them. */
  applyStep(step: BookSnapshot[]): void {
    for (const s of step) {
      this.simTime = Math.max(this.simTime, s.ts);
      this.books.set(s.tokenId, { bids: s.bids.map((l) => [...l] as Level), asks: s.asks.map((l) => [...l] as Level), ts: s.ts, mid: s.mid });
      if (s.mid !== null) this.lastMid.set(s.tokenId, s.mid);
    }
    for (const s of step) this.settleResting(s);
    for (const o of this.orders) {
      if (o.status === 'open' && this.simTime >= o.expiresAt) o.status = 'expired';
    }
  }

  private settleResting(s: BookSnapshot): void {
    for (const o of this.orders) {
      if (o.status !== 'open' || o.tokenId !== s.tokenId || s.ts <= o.placedAt || s.ts >= o.expiresAt) continue;
      // Trade-through: the opposite best price reached our price at a later snapshot
      const through = o.side === 'buy' ? s.bestAsk !== null && s.bestAsk <= o.price + EPS : s.bestBid !== null && s.bestBid >= o.price - EPS;
      if (!through) continue;
      const qty = o.size - o.filled;
      // The order fills in full at its price; the recorded liquidity at or through it is used up for this
      // step, so a marketable order in the same step cannot take it again
      this.take(o.tokenId, o.side, o.price, { qty }, true);
      this.fill(o.tokenId, o.side, qty, qty * o.price, this.fees(o.tokenId), false, s.ts);
      o.filled = o.size;
      o.status = 'filled';
    }
  }

  book(tokenId: string): { bids: Level[]; asks: Level[]; ts: number; mid: number | null } {
    const b = this.books.get(tokenId);
    if (!b) throw new Error(`No snapshot for token ${tokenId} at or before the simulation time`);
    return b;
  }

  orderBook(tokenId: string): OrderBook {
    const b = this.book(tokenId);
    const lv = (ls: Level[]) => ls.map(([p, s]) => ({ price: String(p), size: String(r6(s)) }));
    return { bids: lv(b.bids), asks: lv(b.asks) } as OrderBook;
  }

  private reservedCash(): number {
    return this.orders.filter((o) => o.status === 'open' && o.side === 'buy').reduce((n, o) => n + (o.size - o.filled) * o.price, 0);
  }

  private reservedShares(tokenId: string): number {
    return this.orders.filter((o) => o.status === 'open' && o.side === 'sell' && o.tokenId === tokenId).reduce((n, o) => n + o.size - o.filled, 0);
  }

  freeCash(): number {
    return this.cash - this.reservedCash();
  }

  private fill(tokenId: string, side: 'buy' | 'sell', qty: number, notional: number, rates: FeeRatesInput, taker: boolean, ts: number): number {
    const fee = feeForFill(asRates(rates), qty, notional, taker);
    this.feesPaid += fee;
    const pos = this.positions.get(tokenId) ?? { size: 0, cost: 0 };
    if (side === 'buy') {
      this.cash -= notional + fee;
      pos.size += qty;
      pos.cost += notional;
    } else {
      const avg = pos.size > 0 ? pos.cost / pos.size : 0;
      this.cash += notional - fee;
      pos.cost -= avg * qty;
      pos.size -= qty;
      if (pos.size <= EPS) {
        pos.size = 0;
        pos.cost = 0;
      }
    }
    this.positions.set(tokenId, pos);
    this.trades.push({
      side: side === 'buy' ? 'BUY' : 'SELL',
      symbol: tokenId,
      price: qty > 0 ? notional / qty : 0,
      quantity: qty,
      quoteAmount: notional,
      timestamp: ts,
      balanceAfter: this.cash,
    });
    return fee;
  }

  /** Walk the opposite side up to `limit`; returns [qty, notional] available, optionally consuming it. */
  private take(tokenId: string, side: 'buy' | 'sell', limit: number, want: { usd?: number; qty?: number }, consume: boolean): [number, number] {
    const b = this.book(tokenId);
    const levels = side === 'buy' ? b.asks : b.bids;
    let qty = 0;
    let notional = 0;
    for (const l of levels) {
      const [p, size] = l;
      if (side === 'buy' ? p > limit + EPS : p < limit - EPS) break;
      let take = size;
      if (want.usd !== undefined) take = Math.min(take, (want.usd - notional) / p);
      if (want.qty !== undefined) take = Math.min(take, want.qty - qty);
      if (take <= EPS) break;
      qty += take;
      notional += take * p;
      if (consume) l[1] = size - take;
      if ((want.usd !== undefined && notional >= want.usd - 1e-7) || (want.qty !== undefined && qty >= want.qty - EPS)) break;
    }
    if (consume) {
      const kept = levels.filter((l) => l[1] > EPS);
      levels.length = 0;
      levels.push(...kept);
    }
    return [qty, notional];
  }

  /** ctx.buy / ctx.sell: fill-or-kill at the recorded book. */
  marketable(tokenId: string, side: 'buy' | 'sell', amount: number, opts: { maxPrice?: number; minPrice?: number; maxSlippage?: number } = {}) {
    const fail = (error: string) => ({ success: false, executedAmount: 0, price: 0, tokenAmount: 0, error, status: 'cancelled', orderId: null });
    if (!(amount > 0) || !Number.isFinite(amount)) return { ...fail('amount must be a positive number'), status: 'invalid' };
    const b = this.book(tokenId);
    const slip = opts.maxSlippage ?? 0;
    const best = side === 'buy' ? (b.asks[0]?.[0] ?? null) : (b.bids[0]?.[0] ?? null);
    if (best === null) return fail(`No ${side === 'buy' ? 'asks' : 'bids'} in the book`);
    const limit = side === 'buy' ? (opts.maxPrice ?? Math.min(best + slip, 0.99)) : (opts.minPrice ?? Math.max(best - slip, 0.01));
    const rate = this.fees(tokenId).takerRate;
    if (side === 'buy') {
      if (this.freeCash() < amount * (1 + rate) - 1e-7) return fail('Insufficient balance');
      const [q, n] = this.take(tokenId, 'buy', limit, { usd: amount }, false);
      if (n < amount - 1e-7) return fail('Not enough depth within the price limit (fill-or-kill)');
      this.take(tokenId, 'buy', limit, { usd: amount }, true);
      this.fill(tokenId, 'buy', q, n, this.fees(tokenId), true, this.simTime);
      return { success: true, executedAmount: n, price: n / q, tokenAmount: q, status: 'filled', orderId: `bt-${++this.seq}` };
    }
    const held = (this.positions.get(tokenId)?.size ?? 0) - this.reservedShares(tokenId);
    if (held < amount - EPS) return fail('Insufficient position');
    const [q, n] = this.take(tokenId, 'sell', limit, { qty: amount }, false);
    if (q < amount - EPS) return fail('Not enough depth within the price limit (fill-or-kill)');
    this.take(tokenId, 'sell', limit, { qty: amount }, true);
    this.fill(tokenId, 'sell', q, n, this.fees(tokenId), true, this.simTime);
    return { success: true, executedAmount: n, price: n / q, tokenAmount: q, status: 'filled', orderId: `bt-${++this.seq}` };
  }

  /** ctx.polymarket.placeLimit */
  placeLimit(tokenId: string, side: 'buy' | 'sell', price: number, size: number, opts: { postOnly?: boolean; ttlMinutes?: number } = {}) {
    const res = (ok: boolean, status: string, extra: Record<string, unknown> = {}) => ({
      ok,
      orderId: null as string | null,
      status,
      filledSize: 0,
      avgFillPrice: null as number | null,
      filledNotionalUsd: 0,
      feeUsd: 0,
      expiresAt: null as string | null,
      ...extra,
    });
    if (side !== 'buy' && side !== 'sell') return res(false, 'invalid', { error: 'side must be buy or sell' });
    if (!(price > 0 && price < 1)) return res(false, 'invalid', { error: 'price must be between 0 and 1' });
    if (!(size > 0) || !Number.isFinite(size)) return res(false, 'invalid', { error: 'size must be a positive number' });
    if (opts.ttlMinutes !== undefined && !(opts.ttlMinutes >= GTD_MIN_TTL_MINUTES)) {
      return res(false, 'invalid', { error: `ttlMinutes must be at least ${GTD_MIN_TTL_MINUTES} (Polymarket refuses GTD orders expiring sooner)` });
    }
    const b = this.book(tokenId);
    const postOnly = opts.postOnly !== false;
    const crosses = side === 'buy' ? b.asks.length > 0 && price >= b.asks[0][0] - EPS : b.bids.length > 0 && price <= b.bids[0][0] + EPS;
    if (postOnly && crosses) return res(false, 'rejected_risk', { failedCheck: 'post_only', error: `Post-only ${side} at ${price} would cross the book` });

    const rates = this.fees(tokenId);
    if (side === 'buy' && this.freeCash() < price * size * (1 + (crosses ? rates.takerRate : 0)) - 1e-7) return res(false, 'rejected_risk', { error: 'Insufficient balance' });
    if (side === 'sell' && (this.positions.get(tokenId)?.size ?? 0) - this.reservedShares(tokenId) < size - EPS) {
      return res(false, 'rejected_risk', { error: 'Insufficient position' });
    }
    const ttl = Math.max(Math.min(opts.ttlMinutes ?? this.maxTtlMinutes, this.maxTtlMinutes), GTD_MIN_TTL_MINUTES);
    const order: RestingOrder = {
      orderId: `bt-${++this.seq}`,
      tokenId,
      side,
      price,
      size,
      filled: 0,
      placedAt: this.simTime,
      expiresAt: this.simTime + ttl * 60_000,
      status: 'open',
    };
    let feeUsd = 0;
    let notional = 0;
    if (crosses) {
      const [q, n] = this.take(tokenId, side, price, { qty: size }, true);
      if (q > EPS) {
        feeUsd = this.fill(tokenId, side, q, n, rates, true, this.simTime);
        order.filled = q;
        notional = n;
      }
    }
    if (order.filled >= size - EPS) order.status = 'filled';
    this.orders.push(order);
    const status = order.status === 'filled' ? 'filled' : order.filled > 0 ? 'partially_filled' : 'open';
    return res(true, status, {
      orderId: order.orderId,
      filledSize: order.filled,
      avgFillPrice: order.filled > 0 ? notional / order.filled : null,
      filledNotionalUsd: notional,
      feeUsd,
      expiresAt: new Date(order.expiresAt).toISOString(),
    });
  }

  cancel(orderId: string): void {
    const o = this.orders.find((x) => x.orderId === orderId);
    if (!o) throw new Error(`Order not found: ${orderId}`);
    if (o.status !== 'open') throw new Error(`Order ${orderId} is not open (status ${o.status})`);
    o.status = 'cancelled';
  }

  cancelAll(): { cancelled: number; failed: number; unknownOutcome: number } {
    let n = 0;
    for (const o of this.orders) {
      if (o.status === 'open') {
        o.status = 'cancelled';
        n++;
      }
    }
    return { cancelled: n, failed: 0, unknownOutcome: 0 };
  }

  openOrders() {
    return this.orders
      .filter((o) => o.status === 'open')
      .map((o) => ({
        orderId: o.orderId,
        exchange: 'polymarket' as const,
        marketId: '',
        tokenId: o.tokenId,
        side: o.side,
        orderType: 'limit' as const,
        price: o.price,
        size: o.size,
        filledSize: o.filled,
        status: o.filled > 0 ? 'partially_filled' : 'open',
        expiresAt: new Date(o.expiresAt).toISOString(),
        createdAt: new Date(o.placedAt).toISOString(),
      }));
  }

  /** Mark: visible mid, else last known mid, else average cost. */
  mark(tokenId: string): number {
    const pos = this.positions.get(tokenId);
    const b = this.books.get(tokenId);
    if (b?.mid !== null && b?.mid !== undefined) return b.mid;
    const last = this.lastMid.get(tokenId);
    if (last !== undefined) return last;
    return pos && pos.size > 0 ? pos.cost / pos.size : 0;
  }

  equity(): number {
    let v = this.cash;
    for (const [t, p] of this.positions) if (p.size > 0) v += p.size * this.mark(t);
    return v;
  }

  positionList() {
    return [...this.positions.entries()]
      .filter(([, p]) => p.size > EPS)
      .map(([tokenId, p]) => ({ tokenId, size: p.size, avgPrice: p.cost / p.size, currentValue: p.size * this.mark(tokenId) }));
  }
}

const disabled = (what: string) => async () => {
  throw new Error(`${what} is not available in snapshot backtests`);
};

function buildCtx(market: SnapshotMarket, mem: InMemoryStorageRepo, input: SnapshotSimulationInput): BotContext {
  const botId = `backtest-${input.runId}`;
  const known = new Set(input.tokenIds);
  const check = (tokenId: string) => {
    if (!known.has(tokenId)) throw new Error(`Token ${tokenId} is not part of this backtest`);
  };
  return {
    config: Object.freeze({ ...input.config }),
    botId,
    botName: 'Backtest',
    now: market.simTime,
    buy: async (tokenId: string, amountUsd: number, opts?: { maxPrice?: number; maxSlippage?: number }) => {
      check(tokenId);
      return market.marketable(tokenId, 'buy', amountUsd, opts ?? {});
    },
    sell: async (tokenId: string, shares: number, opts?: { minPrice?: number; maxSlippage?: number }) => {
      check(tokenId);
      return market.marketable(tokenId, 'sell', shares, opts ?? {});
    },
    getOrderBook: async (tokenId: string) => {
      check(tokenId);
      return market.orderBook(tokenId);
    },
    getPositions: async () => market.positionList(),
    getBalance: async () => market.freeCash(),
    getMarketPrice: async (tokenId: string) => {
      check(tokenId);
      const b = market.book(tokenId);
      const bid = b.bids[0]?.[0] ?? 0;
      const ask = b.asks[0]?.[0] ?? 0;
      return { bid, ask, mid: b.mid ?? (bid + ask) / 2, spread: ask && bid ? ask - bid : 0 };
    },
    getMarkets: disabled('getMarkets'),
    getEvent: disabled('getEvent'),
    fetch: disabled('fetch()'),
    setInterval: () => {
      throw new Error('setInterval() is not available in backtest mode');
    },
    setTimeout: () => {
      throw new Error('setTimeout() is not available in backtest mode');
    },
    clearInterval: () => {},
    clearTimeout: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    emit: () => {},
    storage: {
      get: async <T = unknown>(key: string): Promise<T | null> => mem.get(botId, key) as T | null,
      set: async (key: string, value: unknown) => mem.set(botId, key, value),
      delete: async (key: string) => {
        mem.delete(botId, key);
      },
    },
    wallet: { address: '0x0000000000000000000000000000000000000000', proxyAddress: undefined },
    binance: Object.fromEntries(['buy', 'sell', 'getBalance', 'getOrderBook', 'getPrice', 'getPositions'].map((k) => [k, disabled('Binance')])),
    polymarket: {
      placeLimit: async (tokenId: string, side: 'buy' | 'sell', price: number, size: number, opts?: { postOnly?: boolean; ttlMinutes?: number }) => {
        check(tokenId);
        return market.placeLimit(tokenId, side, price, size, opts ?? {});
      },
      cancel: async (orderId: string) => market.cancel(orderId),
      cancelAll: async () => market.cancelAll(),
      getOpenOrders: async () => market.openOrders(),
      getFee: async (tokenId: string) => input.fees[tokenId] ?? input.defaultFees,
      getMarket: disabled('getMarket'),
    },
    risk: { getBudget: async () => ({ remainingAllocation: market.freeCash(), remainingMarket: {}, halted: false }), getExitFlags: async () => [] },
    requestRetire: async () => ({ accepted: false }),
    ledger: { getActiveForecasts: async () => [], getForecast: async () => null },
  } as unknown as BotContext;
}

export async function runSnapshotSimulation(input: SnapshotSimulationInput): Promise<SnapshotSimulationOutput> {
  const steps = groupSteps(input.snapshots);
  if (steps.length === 0) throw new Error('No order-book snapshots for these tokens in the time range');
  const market = new SnapshotMarket(input.initialBalance, (t) => input.fees[t] ?? input.defaultFees, input.maxTtlMinutes ?? DEFAULT_TTL_MINUTES);
  const mem = new InMemoryStorageRepo();

  // Script load sees the first step only
  market.applyStep(steps[0]);
  const exports = evaluateScript(input.compiledScript, buildCtx(market, mem, input));
  const onTick = exports.onTick as ((ctx: BotContext) => Promise<void> | void) | undefined;
  const onStart = exports.onStart as ((ctx: BotContext) => Promise<void> | void) | undefined;
  if (typeof onTick !== 'function' && typeof onStart !== 'function') throw new Error('Script must export at least one of: onStart, onTick');

  let tickErrors = 0;
  let firstTickError: string | undefined;
  const noteError = (err: unknown) => {
    tickErrors++;
    if (!firstTickError) firstTickError = err instanceof Error ? err.message : String(err);
  };
  if (typeof onStart === 'function') {
    try {
      await onStart(buildCtx(market, mem, input));
    } catch (err) {
      noteError(err);
    }
  }

  const equityCurve: number[] = [input.initialBalance];
  const tradeReturns: number[] = [];
  let winCount = 0;
  let loseCount = 0;
  let prev = input.initialBalance;
  for (let i = 0; i < steps.length; i++) {
    if (i > 0) market.applyStep(steps[i]);
    if (typeof onTick === 'function') {
      try {
        await onTick(buildCtx(market, mem, input));
      } catch (err) {
        noteError(err);
      }
    }
    const eq = market.equity();
    equityCurve.push(eq);
    const delta = eq - prev;
    if (Math.abs(delta) > 0.01) {
      if (delta > 0) winCount++;
      else loseCount++;
      if (prev > 0) tradeReturns.push(delta / prev);
    }
    prev = eq;
  }

  const first = steps[0][steps[0].length - 1].ts;
  const last = market.simTime;
  return {
    trades: market.trades,
    equityCurve,
    tradeReturns,
    winCount,
    loseCount,
    tickErrors,
    firstTickError,
    steps: steps.length,
    stepIntervalMs: steps.length > 1 ? (last - first) / (steps.length - 1) : 60_000,
    feesPaid: market.feesPaid,
  };
}
