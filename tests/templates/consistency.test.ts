/**
 * Consistency template (spec §9.3, 5b): constraint math (implies, date ladder, exclusive sum with the NO basket and
 * the exhaustive flag), complement-token pricing, taker fees on every leg, min_gap, no trade without a violation,
 * config checks, sizing caps (basket, unhedged, budget), and leg risk: post-only legs, no new basket while one is
 * open or unhedged, escalation after the timeout bounded by max_slippage and break-even, flattening own holdings,
 * retirement when a market closes or the gap stays closed. Fake ctx, no network.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  basketSize,
  basketsFor,
  bestOpportunity,
  checkLegs,
  consistencyConfig,
  evaluate,
  runConsistencyCycle,
  type LegPrice,
} from '../../templates/consistency';
import { typecheckScript } from '../../packages/core/src/runtime/typecheckScript';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;
const ZERO_FEE = { takerRate: 0, makerRate: 0, formula: 'price' as const, source: 'market' as const };
const FEE5 = { takerRate: 0.05, makerRate: 0, formula: 'price' as const, source: 'market' as const };

/** Binary market i: YES token `y<i>`, NO token `n<i>`, condition id `0xm<i>` */
function market(i: number, over: Record<string, unknown> = {}) {
  return {
    marketId: `0xm${i}`,
    eventId: 'e1',
    question: `Q${i}`,
    category: 'economics',
    endDate: new Date(NOW + (10 + i) * DAY).toISOString(),
    active: true,
    closed: false,
    negRisk: false,
    tokens: [
      { tokenId: `y${i}`, outcome: 'Yes' },
      { tokenId: `n${i}`, outcome: 'No' },
    ],
    tokenId: `y${i}`,
    outcome: 'Yes',
    complementTokenId: `n${i}`,
    ambiguityScore: 0,
    rulesHash: 'h',
    rulesChangedAt: null,
    disputed: false,
    umaResolutionStatus: null,
    inScope: true,
    updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

const book = (bid: number | null, ask: number | null, size = 500) => ({
  bids: bid === null ? [] : [{ price: String(bid), size: String(size) }],
  asks: ask === null ? [] : [{ price: String(ask), size: String(size) }],
  tick_size: '0.01',
});

const priced = (asks: Record<string, number | null>, fee = ZERO_FEE): Record<string, LegPrice> =>
  Object.fromEntries(Object.entries(asks).map(([t, a]) => [t, { top: { bestBid: a === null ? null : a - 0.02, bestAsk: a, tick: 0.01 }, fee }]));

interface Order {
  orderId: string;
  tokenId: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  filledSize: number;
  status: string;
  postOnly: boolean;
  placedBy?: string | null;
  createdAt?: string;
}

/** A fake ctx with stateful storage and a tiny order store; tests fill orders by hand */
function fakeCtx(opts: { config: Record<string, unknown>; markets: Record<string, any>; books: Record<string, any>; fee?: any; budget?: any }) {
  const store = new Map<string, unknown>();
  const orders: Order[] = [];
  let seq = 0;
  let now = NOW;
  const books = { ...opts.books };
  const markets = { ...opts.markets };
  const positions: Array<{ tokenId: string; size: number; avgPrice: number }> = [];
  const flags: Array<Record<string, unknown>> = [];
  // The Position Manager's exit policy as the server would publish it (window from its config, not the default)
  const policy = { exitBeforeEndMinutes: 180, ambiguityExitScore: 2, source: 'position-manager' };
  const eventMarkets: { ids: string[] | null } = { ids: null };
  const placeLimit = vi.fn(async (tokenId: string, side: 'buy' | 'sell', price: number, size: number, o: any = {}) => {
    const order: Order = { orderId: `o${++seq}`, tokenId, side, price, size, filledSize: 0, status: 'open', postOnly: o.postOnly !== false };
    orders.push(order);
    return { ok: true, orderId: order.orderId, status: 'open', filledSize: 0, avgFillPrice: null, filledNotionalUsd: 0, feeUsd: 0, expiresAt: null };
  });
  const cancel = vi.fn(async (id: string) => {
    const o = orders.find((x) => x.orderId === id);
    if (o && o.status === 'open') o.status = 'cancelled';
  });
  const ctx: any = {
    config: opts.config,
    get now() {
      return now;
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emit: vi.fn(),
    storage: {
      get: vi.fn(async (k: string) => (store.has(k) ? structuredClone(store.get(k)) : null)),
      set: vi.fn(async (k: string, v: unknown) => void store.set(k, structuredClone(v))),
      delete: vi.fn(async (k: string) => void store.delete(k)),
    },
    getOrderBook: vi.fn(async (t: string) => books[t] ?? book(null, null)),
    getPositions: vi.fn(async () => positions.map((p) => ({ ...p, currentValue: 0 }))),
    risk: {
      getBudget: vi.fn(async () => opts.budget ?? { remainingAllocation: 1000, remainingMarket: {}, halted: false }),
      getExitFlags: vi.fn(async () => flags),
      getExitPolicy: vi.fn(async () => policy),
    },
    requestRetire: vi.fn(async () => ({ accepted: true })),
    polymarket: {
      getMarket: vi.fn(async (t: string) => markets[t] ?? null),
      getEventMarketIds: vi.fn(async () => eventMarkets.ids),
      getFee: vi.fn(async () => opts.fee ?? ZERO_FEE),
      placeLimit,
      cancel,
      getOpenOrders: vi.fn(async () =>
        orders
          .filter((o) => o.status === 'open')
          .map((o) => ({ exchange: 'polymarket', marketId: '', orderType: 'limit', expiresAt: null, createdAt: '', forecastId: null, placedBy: null, ...o }))
      ),
      getOrderHistory: vi.fn(async () => orders.map((o) => ({ marketId: '', orderType: 'limit', reason: null, forecastId: null, placedBy: null, createdAt: '', ...o }))),
    },
  };
  const fill = (orderId: string, size?: number) => {
    const o = orders.find((x) => x.orderId === orderId)!;
    o.filledSize = size ?? o.size;
    if (o.filledSize >= o.size) o.status = 'filled';
    const p = positions.find((x) => x.tokenId === o.tokenId);
    if (p) p.size += o.side === 'buy' ? o.filledSize : -o.filledSize;
    else positions.push({ tokenId: o.tokenId, size: o.filledSize, avgPrice: o.price });
  };
  return { ctx, orders, placeLimit, cancel, books, markets, fill, advance: (ms: number) => (now += ms), positions, store, flags, policy, eventMarkets };
}

/** implies y1 ⇒ y2: y1 YES bid 0.63 (its NO ask 0.37), y2 YES ask 0.55 ⇒ basket "buy y2 YES + y1 NO" costs 0.92 */
function impliesSetup(over: { config?: Record<string, unknown>; books?: Record<string, any>; fee?: any; budget?: any } = {}) {
  return fakeCtx({
    config: { constraint: 'implies', tokens: ['y1', 'y2'], ...over.config },
    markets: { y1: market(1), y2: market(2) },
    books: { y1: book(0.63, 0.65), n1: book(0.35, 0.37), y2: book(0.53, 0.55), n2: book(0.45, 0.47), ...over.books },
    fee: over.fee,
    budget: over.budget,
  });
}

describe('consistency math', () => {
  const cfgOf = (raw: Record<string, unknown>) => consistencyConfig(raw).cfg;
  const legs = (n: number) => checkLegs(cfgOf({ constraint: 'date_ladder', tokens: Array.from({ length: n }, (_, i) => `y${i + 1}`) }), Array.from({ length: n }, (_, i) => market(i + 1) as any)).legs;

  it('implies: buys the underpriced YES and the complement (NO) of the overpriced leg; gap after taker fees on each leg', () => {
    const cfg = cfgOf({ constraint: 'implies', tokens: ['y1', 'y2'] });
    const [b] = basketsFor(cfg, legs(2));
    expect(b.legs.map((l) => l.tokenId)).toEqual(['y2', 'n1']);
    expect(b.payoff).toBe(1);
    const noFee = evaluate([b], priced({ y2: 0.55, n1: 0.37 }))[0];
    expect(noFee.cost).toBeCloseTo(0.92, 9);
    expect(noFee.gap).toBeCloseTo(0.08, 9);
    // R125: fee per share = rate × p × (1 − p), on every leg
    const withFee = evaluate([b], priced({ y2: 0.55, n1: 0.37 }, FEE5))[0];
    expect(withFee.cost).toBeCloseTo(0.92 + 0.05 * 0.55 * 0.45 + 0.05 * 0.37 * 0.63, 6);
    // Resting price one tick inside the ask
    expect(withFee.legs.map((l) => l.restPrice)).toEqual([0.54, 0.36]);
  });

  it('no violation ⇒ negative gap; a missing ask ⇒ no gap', () => {
    const cfg = cfgOf({ constraint: 'implies', tokens: ['y1', 'y2'] });
    const b = basketsFor(cfg, legs(2));
    expect(evaluate(b, priced({ y2: 0.7, n1: 0.37 }))[0].gap).toBeCloseTo(-0.07, 9);
    expect(evaluate(b, priced({ y2: null, n1: 0.37 }))[0].gap).toBeNull();
  });

  it('date ladder: every earlier ⇒ later pair is a basket; the best gap wins', () => {
    const cfg = cfgOf({ constraint: 'date_ladder', tokens: ['y1', 'y2', 'y3'] });
    const b = basketsFor(cfg, legs(3));
    expect(b.map((x) => x.legs.map((l) => l.tokenId))).toEqual([
      ['y2', 'n1'],
      ['y3', 'n1'],
      ['y3', 'n2'],
    ]);
    // y2 is priced below y1 (violation of 2 cents), y3 far below y2 (violation of 15 cents)
    const best = bestOpportunity(evaluate(b, priced({ y2: 0.6, y3: 0.45, n1: 0.42, n2: 0.4 })));
    expect(best!.basket.legs.map((l) => l.tokenId)).toEqual(['y3', 'n2']);
    expect(best!.gap).toBeCloseTo(0.15, 9);
  });

  it('exclusive_sum: NO basket pays n − max_sum; the YES basket exists only when declared exhaustive', () => {
    const three = legs(3);
    const plain = basketsFor(cfgOf({ constraint: 'exclusive_sum', tokens: ['y1', 'y2', 'y3'] }), three);
    expect(plain).toHaveLength(1);
    expect(plain[0].legs.map((l) => l.tokenId)).toEqual(['n1', 'n2', 'n3']);
    expect(plain[0].payoff).toBe(2);
    // YES asks 0.42 + 0.42 + 0.32 > 1 ⇒ NO asks 0.6 + 0.6 + 0.7 = 1.9 < 2 − 0.03: gap 0.1
    const o = evaluate(plain, priced({ n1: 0.6, n2: 0.6, n3: 0.7 }))[0];
    expect(o.gap).toBeCloseTo(0.1, 9);
    // NO asks summing to 1.98 leave only 0.02: below a 0.03 min_gap
    expect(evaluate(plain, priced({ n1: 0.66, n2: 0.66, n3: 0.66 }))[0].gap).toBeCloseTo(0.02, 9);
    // YES asks summing to 0.9 < 1: only with exhaustive: true
    const yesCheap = priced({ y1: 0.3, y2: 0.3, y3: 0.3, n1: 0.72, n2: 0.72, n3: 0.72 });
    expect(bestOpportunity(evaluate(plain, yesCheap))!.gap).toBeLessThan(0);
    const exhaustive = basketsFor(cfgOf({ constraint: 'exclusive_sum', tokens: ['y1', 'y2', 'y3'], exhaustive: true }), three);
    const best = bestOpportunity(evaluate(exhaustive, yesCheap))!;
    expect(best.basket.legs.map((l) => l.tokenId)).toEqual(['y1', 'y2', 'y3']);
    expect(best.basket.payoff).toBe(1);
    expect(best.gap).toBeCloseTo(0.1, 9);
    // max_sum 2 ⇒ NO basket pays n − 2
    expect(basketsFor(cfgOf({ constraint: 'exclusive_sum', tokens: ['y1', 'y2', 'y3'], max_sum: 2 }), three)[0].payoff).toBe(1);
  });

  it('config errors: structure, YES tokens of binary markets, scope, distinct markets, ladder order', () => {
    expect(consistencyConfig({ constraint: 'nope', tokens: ['a', 'b'] }).errors[0]).toMatch(/constraint must be/);
    expect(consistencyConfig({ constraint: 'implies', tokens: ['a', 'a'] }).errors).toContain('tokens must be distinct');
    expect(consistencyConfig({ constraint: 'implies', tokens: ['a', 'b', 'c'] }).errors[0]).toMatch(/exactly 2/);
    expect(consistencyConfig({ constraint: 'exclusive_sum', tokens: ['a', 'b'], max_sum: 2 }).errors[0]).toMatch(/max_sum/);
    expect(consistencyConfig({ constraint: 'exclusive_sum', tokens: ['a', 'b', 'c'], max_sum: 2, exhaustive: true }).errors[0]).toMatch(/exhaustive needs max_sum 1/);
    expect(consistencyConfig({ constraint: 'implies', tokens: ['a', 'b'], exhaustive: true }).errors[0]).toMatch(/exclusive_sum only/);
    const cfg = cfgOf({ constraint: 'date_ladder', tokens: ['y1', 'y2'] });
    expect(checkLegs(cfg, [market(1) as any, market(2, { inScope: false }) as any]).errors[0]).toMatch(/not in the bot's market_ids/);
    expect(checkLegs(cfg, [market(1) as any, market(2, { outcome: 'No', tokenId: 'n2', complementTokenId: 'y2' }) as any]).errors[0]).toMatch(/not the YES token/);
    expect(checkLegs(cfg, [market(1) as any, market(2, { tokens: [{ tokenId: 'y2', outcome: 'Yes' }, { tokenId: 'a', outcome: 'B' }, { tokenId: 'c', outcome: 'C' }] }) as any]).errors[0]).toMatch(
      /not a binary market/
    );
    expect(checkLegs(cfg, [market(1) as any, market(1) as any]).errors).toContain('every token must be in a different market');
    expect(checkLegs(cfg, [market(1, { endDate: new Date(NOW + 30 * DAY).toISOString() }) as any, market(2) as any]).errors[0]).toMatch(/ordered by deadline/);
    expect(checkLegs(cfg, [market(1) as any, null]).errors[0]).toMatch(/market unknown/);
  });

  it('sizing: basket cap, unhedged cap (all legs but the cheapest), budget room per market, ≥ 5 shares', () => {
    const cfg = cfgOf({ constraint: 'implies', tokens: ['y1', 'y2'], max_pair_usd: 20, max_unhedged_usd: 10 });
    const opp = evaluate(basketsFor(cfg, legs(2)), priced({ y2: 0.55, n1: 0.37 }))[0];
    // 20 / 0.92 = 21.7 shares; unhedged: (0.92 − 0.37) = 0.55 per share ⇒ 10 / 0.55 = 18.18
    expect(basketSize(opp, cfg, { remainingAllocation: 1000, remainingMarket: {} })).toBe(18.18);
    expect(basketSize(opp, cfg, { remainingAllocation: 9.2, remainingMarket: {} })).toBe(10);
    expect(basketSize(opp, cfg, { remainingAllocation: 1000, remainingMarket: { '0xm2': 5.5 } })).toBe(10);
    expect(basketSize(opp, cfg, { remainingAllocation: 4, remainingMarket: {} })).toBe(0);
  });
});

describe('consistency cycle and leg risk', () => {
  it('no trade without a violation or below min_gap', async () => {
    const none = impliesSetup({ books: { y2: book(0.6, 0.7) } });
    expect((await runConsistencyCycle(none.ctx)).action).toBe('none');
    // gap 0.02 < min_gap 0.03
    const small = impliesSetup({ books: { y2: book(0.6, 0.61) } });
    const r = await runConsistencyCycle(small.ctx);
    expect(r.gap).toBeCloseTo(0.02, 9);
    expect(r.action).toBe('none');
    expect(small.placeLimit).not.toHaveBeenCalled();
  });

  it('opens a basket with post-only legs one tick inside the asks; no second basket while it is open', async () => {
    const s = impliesSetup();
    const r = await runConsistencyCycle(s.ctx);
    expect(r.action).toBe('opened');
    expect(s.placeLimit).toHaveBeenCalledTimes(2);
    expect(s.orders.map((o) => [o.tokenId, o.side, o.price, o.size, o.postOnly])).toEqual([
      ['y2', 'buy', 0.54, 18.18, true],
      ['n1', 'buy', 0.36, 18.18, true],
    ]);
    // Still violated: no new basket, the open one rests
    s.advance(2 * MIN);
    expect((await runConsistencyCycle(s.ctx)).action).toBe('resting');
    expect(s.placeLimit).toHaveBeenCalledTimes(2);
    // Both legs fill ⇒ hedged; the next cycle may open a new basket
    s.fill('o1');
    s.fill('o2');
    expect((await runConsistencyCycle(s.ctx)).action).toBe('hedged');
    expect((await runConsistencyCycle(s.ctx)).action).toBe('opened');
  });

  it('one leg filled, the other not: rests until the timeout, then escalates the missing leg within max_slippage', async () => {
    const s = impliesSetup({ config: { hedge_timeout_minutes: 15, max_slippage: 0.02 } });
    await runConsistencyCycle(s.ctx);
    s.fill('o1'); // y2 YES filled, n1 NO not
    s.advance(10 * MIN);
    expect((await runConsistencyCycle(s.ctx)).action).toBe('resting');
    expect(s.placeLimit).toHaveBeenCalledTimes(2);
    // NO ask moved up a cent: still within ask at open (0.37) + 0.02
    s.books.n1 = book(0.36, 0.38);
    s.advance(6 * MIN);
    const r = await runConsistencyCycle(s.ctx);
    expect(r.action).toBe('escalated');
    expect(s.cancel).toHaveBeenCalledWith('o2');
    const esc = s.orders[2];
    expect([esc.tokenId, esc.side, esc.price, esc.size, esc.postOnly]).toEqual(['n1', 'buy', 0.39, 18.18, false]);
    // Break-even guard: filled leg at 0.54 + escalated 0.39 ≤ payoff 1
    s.fill('o3');
    expect((await runConsistencyCycle(s.ctx)).action).toBe('hedged');
  });

  it('escalation refused beyond max_slippage ⇒ unhedged: no new baskets, flattens its own excess (never a risk exit)', async () => {
    const s = impliesSetup({ config: { hedge_timeout_minutes: 15, max_slippage: 0.02 } });
    await runConsistencyCycle(s.ctx);
    s.fill('o1');
    s.books.n1 = book(0.4, 0.42); // NO ask now 0.42 > 0.37 + 0.02
    s.advance(16 * MIN);
    const r = await runConsistencyCycle(s.ctx);
    expect(r.action).toBe('unhedged');
    expect(s.placeLimit).toHaveBeenCalledTimes(2); // nothing escalated
    // The gap is still there (y2 ask 0.55, n1 ask 0.42 ⇒ 0.03), but no new basket opens while unhedged: it flattens
    s.advance(2 * MIN);
    const f = await runConsistencyCycle(s.ctx);
    expect(f.action).toBe('flattened');
    const sell = s.orders[2];
    expect([sell.tokenId, sell.side, sell.size, sell.postOnly]).toEqual(['y2', 'sell', 18.18, false]);
    // best bid 0.53 − 0.02 slippage
    expect(sell.price).toBe(0.51);
    expect(s.orders.filter((o) => o.side === 'buy')).toHaveLength(2);
  });

  it('without flatten_unhedged it keeps the leg and retries the hedge only within bounds; never opens a new basket meanwhile', async () => {
    const s = impliesSetup({ config: { hedge_timeout_minutes: 15, flatten_unhedged: false } });
    await runConsistencyCycle(s.ctx);
    s.fill('o1');
    s.books.n1 = book(0.4, 0.45);
    s.advance(16 * MIN);
    expect((await runConsistencyCycle(s.ctx)).action).toBe('unhedged');
    s.advance(2 * MIN);
    expect((await runConsistencyCycle(s.ctx)).action).toBe('unhedged');
    expect(s.placeLimit).toHaveBeenCalledTimes(2);
    expect(s.orders.some((o) => o.side === 'sell')).toBe(false);
    // The NO ask comes back: hedge now
    s.books.n1 = book(0.36, 0.38);
    s.advance(2 * MIN);
    expect((await runConsistencyCycle(s.ctx)).action).toBe('escalated');
  });

  it('nothing filled by the timeout ⇒ the basket is dropped (no exposure)', async () => {
    const s = impliesSetup();
    await runConsistencyCycle(s.ctx);
    s.advance(16 * MIN);
    expect((await runConsistencyCycle(s.ctx)).action).toBe('abandoned');
    expect(s.cancel).toHaveBeenCalledTimes(2);
  });

  it('a leg the risk engine refuses withdraws the basket', async () => {
    const s = impliesSetup();
    s.placeLimit.mockImplementationOnce(async () => ({ ok: true, orderId: 'o1', status: 'open', filledSize: 0 } as any));
    s.orders.push({ orderId: 'o1', tokenId: 'y2', side: 'buy', price: 0.54, size: 18.18, filledSize: 0, status: 'open', postOnly: true });
    s.placeLimit.mockImplementationOnce(async () => ({ ok: false, orderId: 'x', status: 'rejected_risk', error: 'ambiguity unknown', filledSize: 0 } as any));
    const r = await runConsistencyCycle(s.ctx);
    expect(r.action).toBe('abandoned');
    expect(s.cancel).toHaveBeenCalledWith('o1');
  });

  it('halt cancels resting legs; a closed market asks for retirement; idle_days without a gap too', async () => {
    const h = impliesSetup();
    await runConsistencyCycle(h.ctx);
    h.ctx.risk.getBudget.mockResolvedValue({ remainingAllocation: 0, remainingMarket: {}, halted: true });
    expect((await runConsistencyCycle(h.ctx)).action).toBe('halted');
    expect(h.cancel).toHaveBeenCalledTimes(2);

    const c = impliesSetup();
    c.markets.y1 = market(1, { closed: true });
    expect((await runConsistencyCycle(c.ctx)).action).toBe('retire');

    const idle = impliesSetup({ config: { idle_days: 3 }, books: { y2: book(0.6, 0.7) } });
    expect((await runConsistencyCycle(idle.ctx)).action).toBe('none');
    idle.advance(3 * DAY + MIN);
    expect((await runConsistencyCycle(idle.ctx)).action).toBe('retire');
  });

  it('exclusive_sum trades the NO basket on all legs', async () => {
    const s = fakeCtx({
      config: { constraint: 'exclusive_sum', tokens: ['y1', 'y2', 'y3'], max_pair_usd: 40, max_unhedged_usd: 40 },
      markets: { y1: market(1), y2: market(2), y3: market(3) },
      books: { y1: book(0.38, 0.42), y2: book(0.38, 0.42), y3: book(0.28, 0.32), n1: book(0.58, 0.6), n2: book(0.58, 0.6), n3: book(0.68, 0.7) },
    });
    const r = await runConsistencyCycle(s.ctx);
    expect(r.action).toBe('opened');
    expect(r.gap).toBeCloseTo(0.1, 9);
    expect(s.orders.map((o) => [o.tokenId, o.price])).toEqual([
      ['n1', 0.59],
      ['n2', 0.59],
      ['n3', 0.69],
    ]);
  });

  it('typechecks against the SDK and is seeded with the consistency role, trust new', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../templates/consistency.ts'), 'utf8');
    expect(typecheckScript(src).diagnostics).toEqual([]);
    expect(src).toMatch(/role: 'consistency'/);
    expect(src).toMatch(/trust: 'new'/);
  });

  it('opens no basket into the Position Manager’s triggers: exit flag, ambiguity ≥ its exit score, ambiguity 1 inside its exit window', async () => {
    const flagged = impliesSetup();
    flagged.flags.push({ id: 'f', tokenId: 'n1', marketId: '0xm1', reason: 'agent', createdBy: 'agent', createdAt: '' });
    const r1 = await runConsistencyCycle(flagged.ctx);
    expect(r1).toMatchObject({ action: 'none' });
    expect(r1.detail).toMatch(/exit flag open on n1/);
    expect(flagged.placeLimit).not.toHaveBeenCalled();

    // Ambiguity 1, 200 min to the end: the manager's window is 240 here (its config, not the 180 default)
    const window = impliesSetup();
    window.policy.exitBeforeEndMinutes = 240;
    window.markets.y2 = market(2, { ambiguityScore: 1, endDate: new Date(NOW + 200 * MIN).toISOString() });
    const r2 = await runConsistencyCycle(window.ctx);
    expect(r2.detail).toMatch(/within 240 min of the end/);
    expect(window.placeLimit).not.toHaveBeenCalled();
    // Outside the window it trades
    window.policy.exitBeforeEndMinutes = 120;
    expect((await runConsistencyCycle(window.ctx)).action).toBe('opened');

    for (const over of [{ ambiguityScore: 2 }, { ambiguityScore: null }, { disputed: true }, { rulesChangedAt: new Date(NOW - DAY).toISOString() }]) {
      const s = impliesSetup();
      s.markets.y1 = market(1, over);
      expect((await runConsistencyCycle(s.ctx)).action).toBe('none');
      expect(s.placeLimit).not.toHaveBeenCalled();
    }
  });

  it('a leg that fills while it is being cancelled is re-read before the hedge is sized', async () => {
    const s = impliesSetup({ config: { hedge_timeout_minutes: 15 } });
    await runConsistencyCycle(s.ctx);
    s.fill('o1');
    // The cancel of the NO leg races a fill of 10 shares
    s.cancel.mockImplementation(async (id: string) => {
      const o = s.orders.find((x) => x.orderId === id)!;
      if (id === 'o2' && o.status === 'open') {
        o.filledSize = 10;
        s.positions.push({ tokenId: 'n1', size: 10, avgPrice: 0.36 });
      }
      if (o.status === 'open') o.status = 'cancelled';
    });
    s.advance(16 * MIN);
    expect((await runConsistencyCycle(s.ctx)).action).toBe('escalated');
    expect(s.orders[2]).toMatchObject({ tokenId: 'n1', side: 'buy', size: 8.18, postOnly: false });

    // Fully filled during the cancel: level, no escalation at all
    const t = impliesSetup({ config: { hedge_timeout_minutes: 15 } });
    await runConsistencyCycle(t.ctx);
    t.fill('o1');
    t.cancel.mockImplementation(async (id: string) => {
      const o = t.orders.find((x) => x.orderId === id)!;
      if (o.status === 'open') {
        o.filledSize = o.size;
        o.status = 'filled';
      }
    });
    t.advance(16 * MIN);
    expect((await runConsistencyCycle(t.ctx)).action).toBe('hedged');
    expect(t.placeLimit).toHaveBeenCalledTimes(2);
  });

  it('a Position Manager sell on a basket token unhedges the basket (flattened like a failed hedge) and stops new baskets', async () => {
    const s = impliesSetup();
    await runConsistencyCycle(s.ctx);
    s.fill('o1');
    s.fill('o2');
    // Before the next cycle the manager exits the NO leg as this bot (placedBy set)
    s.orders.push({ orderId: 'pm1', tokenId: 'n1', side: 'sell', price: 0.3, size: 18.18, filledSize: 18.18, status: 'filled', postOnly: false, placedBy: 'pm-bot', createdAt: new Date(NOW + MIN).toISOString() });
    s.advance(2 * MIN);
    // Both legs had filled, but the NO leg is gone: the YES excess is flattened
    const r = await runConsistencyCycle(s.ctx);
    expect(r.action).toBe('flattened');
    const own = s.orders.find((o) => o.side === 'sell' && !o.placedBy)!;
    expect(own).toMatchObject({ tokenId: 'y2', size: 18.18 });
    s.fill(own.orderId);
    s.advance(2 * MIN);
    expect((await runConsistencyCycle(s.ctx)).action).toBe('abandoned'); // flat: basket closed
    // No new basket after a manager exit even though the gap is there: the bot asks to be retired instead
    s.advance(20 * MIN);
    expect((await runConsistencyCycle(s.ctx)).action).toBe('retire');
    expect(s.orders.filter((o) => o.side === 'buy')).toHaveLength(2);
  });

  it('residual imbalances under 5 shares add up across baskets; above max_residual_usd no new basket opens', async () => {
    const s = impliesSetup({ config: { hedge_timeout_minutes: 15, max_residual_usd: 2 } });
    for (let i = 0; i < 2; i++) {
      await runConsistencyCycle(s.ctx);
      const [yes, no] = s.orders.slice(-2);
      s.fill(yes.orderId);
      s.fill(no.orderId, no.size - 4); // 4 shares of YES (0.54) left naked: $2.16 per basket
      s.advance(16 * MIN);
      expect((await runConsistencyCycle(s.ctx)).action).toBe('hedged');
      if (i === 0) {
        // $2.16 > $2 already, but the 8-share total (≥ 5) is not reached yet: blocked
        const r = await runConsistencyCycle(s.ctx);
        expect(r.detail).toMatch(/residual imbalance \$2\.16 > max_residual_usd 2/);
        // Allow a second basket to build up the residual
        s.ctx.config.max_residual_usd = 10;
      }
    }
    // 8 residual shares ≥ the order minimum: flattened (own holdings) before anything else
    s.ctx.config.max_residual_usd = 2;
    const sellsBefore = s.orders.filter((o) => o.side === 'sell').length;
    await runConsistencyCycle(s.ctx);
    const sells = s.orders.filter((o) => o.side === 'sell');
    expect(sells.length).toBe(sellsBefore + 1);
    expect(sells[sells.length - 1]).toMatchObject({ tokenId: 'y2', size: 8 });
  });

  it('exclusivity checks: one event, negRisk for exhaustive with no market outside tokens; ladder end dates required', async () => {
    const cfgX = consistencyConfig({ constraint: 'exclusive_sum', tokens: ['y1', 'y2'], exhaustive: true }).cfg;
    const neg = (i: number, over: Record<string, unknown> = {}) => market(i, { negRisk: true, eventId: 'ev', ...over }) as any;
    expect(checkLegs(cfgX, [neg(1), neg(2, { eventId: 'other' })], ['0xm1', '0xm2']).errors[0]).toMatch(/same event/);
    expect(checkLegs(cfgX, [neg(1), neg(2)], ['0xm1', '0xm2', '0xm3']).errors[0]).toMatch(/event has 3 markets but 2 legs/);
    expect(checkLegs(cfgX, [neg(1), neg(2)], null).errors[0]).toMatch(/market list is unknown/);
    expect(checkLegs(cfgX, [market(1) as any, market(2) as any], ['0xm1', '0xm2']).errors[0]).toMatch(/negRisk event/);
    expect(checkLegs(cfgX, [neg(1), neg(2)], ['0xm1', '0xm2']).errors).toEqual([]);
    const cfgS = consistencyConfig({ constraint: 'exclusive_sum', tokens: ['y1', 'y2'] }).cfg;
    expect(checkLegs(cfgS, [market(1) as any, market(2, { eventId: 'e2' }) as any]).errors[0]).toMatch(/same event/);
    expect(checkLegs(cfgS, [neg(1), market(2, { eventId: 'ev' }) as any]).errors[0]).toMatch(/mixed negRisk/);
    const cfgL = consistencyConfig({ constraint: 'date_ladder', tokens: ['y1', 'y2'] }).cfg;
    expect(checkLegs(cfgL, [market(1) as any, market(2, { endDate: null }) as any]).errors[0]).toMatch(/no known end date/);

    // At start: an exhaustive set whose event has another market refuses to start
    const s = fakeCtx({
      config: { constraint: 'exclusive_sum', tokens: ['y1', 'y2'], exhaustive: true },
      markets: { y1: neg(1), y2: neg(2) },
      books: {},
    });
    s.eventMarkets.ids = ['0xm1', '0xm2', '0xother'];
    const mod = await import('../../templates/consistency');
    await expect(mod.onStart(s.ctx)).rejects.toThrow(/event has 3 markets but 2 legs/);
  });
});
