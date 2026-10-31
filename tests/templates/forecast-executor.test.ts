/**
 * Forecast executor template (spec §9.1): sizing (Kelly fraction × bucket allocation, caps, edge after fee),
 * ranking by edge per day, NO-token pricing, requote / cancel on supersede / withdraw / lost edge, never a
 * buy without edge. Pure helpers and the cycle against a fake ctx (no network).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  allocate,
  allocatePlan,
  DEFAULT_MIN_EDGE_PER_DAY,
  executorConfig,
  kellyFraction,
  quoteFor,
  runExecutorCycle,
  type Quote,
} from '../../templates/forecast-executor';
import { typecheckScript } from '../../packages/core/src/runtime/typecheckScript';
import { managerConfig, runManagerCycle } from '../../templates/position-manager';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const DAY = 86_400_000;
const NO_FEE = { takerRate: 0.05, makerRate: 0, formula: 'price' as const, source: 'market' as const };

const book = (bid: number, ask: number) => ({ bids: [{ price: String(bid), size: '500' }], asks: [{ price: String(ask), size: '500' }], tick_size: '0.01' });

function forecast(over: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    marketId: 'm1',
    tokenId: 'yes1',
    complementTokenId: 'no1',
    eventId: 'e1',
    category: 'economics',
    probability: 0.6,
    marketPriceAtForecast: 0.5,
    bestBid: 0.49,
    bestAsk: 0.51,
    ambiguityScore: 0,
    tradeable: true,
    tradeableAtForecast: true,
    bucketState: 'trading',
    horizonBucket: 'short',
    daysToResolutionAtForecast: 5,
    status: 'active',
    rationale: '',
    sources: [],
    createdAt: new Date(NOW - DAY).toISOString(),
    endDate: new Date(NOW + 4 * DAY).toISOString(),
    bucketAllocationUsd: 200,
    ...over,
  };
}

function fakeCtx(opts: {
  forecasts: ReturnType<typeof forecast>[];
  books: Record<string, ReturnType<typeof book>>;
  open?: Array<Record<string, unknown>>;
  budget?: { remainingAllocation: number; remainingMarket: Record<string, number>; halted: boolean };
  positions?: Array<Record<string, unknown>>;
  config?: Record<string, unknown>;
  fee?: Record<string, unknown>;
  history?: Array<Record<string, unknown>>;
}) {
  const placeLimit = vi.fn().mockResolvedValue({ ok: true, status: 'open', orderId: 'new' });
  const cancel = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    config: opts.config ?? {},
    now: NOW,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    storage: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined), delete: vi.fn() },
    getPositions: vi.fn().mockResolvedValue(opts.positions ?? []),
    getOrderBook: vi.fn(async (t: string) => opts.books[t] ?? book(0.01, 0.99)),
    ledger: { getActiveForecasts: vi.fn().mockResolvedValue(opts.forecasts) },
    risk: { getBudget: vi.fn().mockResolvedValue(opts.budget ?? { remainingAllocation: 1000, remainingMarket: {}, halted: false }) },
    polymarket: {
      getOpenOrders: vi.fn().mockResolvedValue(opts.open ?? []),
      getOrderHistory: vi.fn().mockResolvedValue(opts.history ?? []),
      getFee: vi.fn().mockResolvedValue(opts.fee ?? NO_FEE),
      placeLimit,
      cancel,
    },
  };
  return { ctx: ctx as never, placeLimit, cancel, storage: ctx.storage };
}

describe('forecast executor: pure rules', () => {
  it('config floors min_edge at 0.03 and defaults kelly_fraction to 0.25', () => {
    expect(executorConfig({ min_edge: 0.01 })).toMatchObject({ minEdge: 0.03, kellyFraction: 0.25, requoteMinutes: 10, maxPerMarketUsd: 25, maxMarkets: 10 });
  });

  it('bids min(best bid + tick, p − min_edge), below the ask, only with edge after the maker fee', () => {
    const top = { bestBid: 0.49, bestAsk: 0.52, tick: 0.01 };
    expect(quoteFor(0.6, top, NO_FEE, 0.05)).toMatchObject({ price: 0.5, edge: expect.closeTo(0.1, 9) });
    // The ask must leave min_edge + the taker fee (0.58 − 0.52 − 0.05·0.52·0.48 < 0.05): no quote
    expect(quoteFor(0.58, top, NO_FEE, 0.05)).toBeNull();
    expect(quoteFor(0.59, top, NO_FEE, 0.05)!.price).toBe(0.5);
    // No edge: nothing
    expect(quoteFor(0.5, top, NO_FEE, 0.05)).toBeNull();
    // One-tick spread: never at or through the ask
    expect(quoteFor(0.9, { bestBid: 0.5, bestAsk: 0.51, tick: 0.01 }, NO_FEE, 0.05)!.price).toBe(0.5);
    // A maker fee (unusual schedule) is deducted from the edge
    const makerFee = { ...NO_FEE, makerRate: 0.5 };
    expect(quoteFor(0.6, top, makerFee, 0.05)).toBeNull(); // ask passes, but 0.6 − 0.5 − 0.5·0.5·0.5 < 0.05
  });

  it('Kelly for a binary share: (p − c) / (1 − c), 0 without edge', () => {
    expect(kellyFraction(0.6, 0.5)).toBeCloseTo(0.2);
    expect(kellyFraction(0.5, 0.5)).toBe(0);
    expect(kellyFraction(0.4, 0.5)).toBe(0);
  });

  const q = (over: Partial<Quote>): Quote => ({
    forecastId: 'f',
    marketId: 'm',
    tokenId: 't',
    fair: 0.6,
    price: 0.5,
    edge: 0.1,
    edgePerDay: 0.1,
    days: 1,
    kelly: 0.2,
    bucketAllocationUsd: 200,
    ...over,
  });
  const cfg = executorConfig({ max_per_market_usd: 1000 });

  it('sizes kelly_fraction × Kelly × bucket allocation, capped by max_per_market_usd and the budget', () => {
    // 0.25 × 0.2 × 200 = $10 ⇒ 20 shares at 0.5
    expect(allocate([q({})], cfg, { remainingAllocation: 1000, remainingMarket: {} }, {})[0]).toMatchObject({ size: 20, usd: 10 });
    // max_per_market_usd 6, $2 already held there ⇒ $4 ⇒ 8 shares
    expect(allocate([q({})], executorConfig({ max_per_market_usd: 6 }), { remainingAllocation: 1000, remainingMarket: {} }, { m: 2 })[0]).toMatchObject({ size: 8 });
    // per-market budget room $3 ⇒ 6 shares
    expect(allocate([q({})], cfg, { remainingAllocation: 1000, remainingMarket: { m: 3 } }, {})[0]).toMatchObject({ size: 6 });
    // under 5 shares ⇒ nothing
    expect(allocate([q({})], cfg, { remainingAllocation: 2, remainingMarket: {} }, {})).toEqual([]);
  });

  it('ranks by edge per day when the budget cannot cover everything; max_markets caps markets', () => {
    const long = q({ marketId: 'long', tokenId: 'L', edge: 0.2, edgePerDay: 0.2 / 30 });
    const short = q({ marketId: 'short', tokenId: 'S', edge: 0.08, edgePerDay: 0.08 / 2 });
    const plan = allocate([long, short], cfg, { remainingAllocation: 10, remainingMarket: {} }, {});
    expect(plan.map((p) => p.tokenId)).toEqual(['S']); // the short market wins with the same budget
    const capped = allocate([long, short], executorConfig({ max_markets: 1, max_per_market_usd: 1000 }), { remainingAllocation: 1000, remainingMarket: {} }, {});
    expect(capped.map((p) => p.tokenId)).toEqual(['S']);
  });
});

describe('forecast executor: cycle', () => {
  it('quotes the YES token at p and the NO token at 1 − p, tagged with the forecast', async () => {
    // p = 0.6 on YES (book 0.49/0.52); NO fair 0.4 (book 0.3/0.33)
    const { ctx, placeLimit } = fakeCtx({ forecasts: [forecast()], books: { yes1: book(0.49, 0.52), no1: book(0.3, 0.33) } });
    const r = await runExecutorCycle(ctx);
    expect(r.planned.map((p) => [p.tokenId, p.price])).toEqual(expect.arrayContaining([['yes1', 0.5], ['no1', 0.31]]));
    for (const call of placeLimit.mock.calls) {
      expect(call[1]).toBe('buy');
      expect(call[4]).toMatchObject({ postOnly: true, forecastId: 'f1' });
      expect(call[4].ttlMinutes).toBeGreaterThanOrEqual(3);
    }
    expect(placeLimit).toHaveBeenCalledTimes(2);
  });

  it('never buys without edge', async () => {
    const { ctx, placeLimit } = fakeCtx({ forecasts: [forecast({ probability: 0.52 })], books: { yes1: book(0.5, 0.51), no1: book(0.48, 0.5) } });
    const r = await runExecutorCycle(ctx);
    expect(r.planned).toEqual([]);
    expect(placeLimit).not.toHaveBeenCalled();
  });

  it('keeps a matching order, replaces one tagged with a superseded forecast, cancels when the forecast is gone', async () => {
    const live = { orderId: 'o1', exchange: 'polymarket', marketId: 'm1', tokenId: 'yes1', side: 'buy', orderType: 'limit', price: 0.5, size: 20, filledSize: 0, status: 'open', expiresAt: new Date(NOW + 60 * 60_000).toISOString(), createdAt: '', forecastId: 'f1', placedBy: null };
    const books = { yes1: book(0.49, 0.52), no1: book(0.45, 0.47) }; // NO side has no edge
    // Same forecast, same quote ⇒ kept
    let f = fakeCtx({ forecasts: [forecast()], books, open: [live] });
    expect(await runExecutorCycle(f.ctx)).toMatchObject({ kept: 1, cancelled: 0, placed: 0 });

    // Superseded: the new forecast id ⇒ the old order is cancelled and re-placed with the new tag
    f = fakeCtx({ forecasts: [forecast({ id: 'f2' })], books, open: [live] });
    expect(await runExecutorCycle(f.ctx)).toMatchObject({ kept: 0, cancelled: 1, placed: 1 });
    expect(f.cancel).toHaveBeenCalledWith('o1');
    expect(f.placeLimit.mock.calls[0][4].forecastId).toBe('f2');

    // Withdrawn / no longer tradeable (not returned by tradeableOnly) ⇒ cancelled, nothing placed
    f = fakeCtx({ forecasts: [], books, open: [live] });
    expect(await runExecutorCycle(f.ctx)).toMatchObject({ cancelled: 1, placed: 0 });

    // Edge gone (price moved up to the forecast) ⇒ cancelled
    f = fakeCtx({ forecasts: [forecast()], books: { yes1: book(0.58, 0.59), no1: book(0.4, 0.42) }, open: [live] });
    expect(await runExecutorCycle(f.ctx)).toMatchObject({ cancelled: 1, placed: 0 });

    // Never touches sells or orders another bot (the position manager) placed for it
    const exit = { ...live, orderId: 'x1', side: 'sell' };
    const pmBuy = { ...live, orderId: 'x2', placedBy: 'pm' };
    f = fakeCtx({ forecasts: [], books, open: [exit, pmBuy] });
    await runExecutorCycle(f.ctx);
    expect(f.cancel).not.toHaveBeenCalled();
  });

  it('a halted budget cancels its bids and places nothing', async () => {
    const live = { orderId: 'o1', exchange: 'polymarket', marketId: 'm1', tokenId: 'yes1', side: 'buy', orderType: 'limit', price: 0.5, size: 20, filledSize: 0, status: 'open', expiresAt: null, createdAt: '', forecastId: 'f1', placedBy: null };
    const f = fakeCtx({ forecasts: [forecast()], books: { yes1: book(0.49, 0.52) }, open: [live], budget: { remainingAllocation: 100, remainingMarket: {}, halted: true } });
    expect(await runExecutorCycle(f.ctx)).toMatchObject({ cancelled: 1, placed: 0 });
  });

  const liveBid = (over: Record<string, unknown> = {}) => ({
    orderId: 'o1', exchange: 'polymarket', marketId: 'm1', tokenId: 'yes1', side: 'buy', orderType: 'limit', price: 0.5, size: 20, filledSize: 0,
    status: 'open', expiresAt: new Date(NOW + 60 * 60_000).toISOString(), createdAt: '', forecastId: 'f1', placedBy: null, ...over,
  });

  it('does not step over its own bid: its resting order is left out of the book and kept while still best', async () => {
    // The book shows our own 0.50 bid (20 shares) on top of a competitor at 0.49
    const withOwn = { bids: [{ price: '0.5', size: '20' }, { price: '0.49', size: '100' }], asks: [{ price: '0.52', size: '100' }], tick_size: '0.01' };
    const noNo = book(0.45, 0.47);
    for (let i = 0; i < 3; i++) {
      const f = fakeCtx({ forecasts: [forecast()], books: { yes1: withOwn, no1: noNo }, open: [liveBid()] });
      expect(await runExecutorCycle(f.ctx)).toMatchObject({ kept: 1, placed: 0, cancelled: 0 });
    }
    // Others joined our level: still kept (at the best competing bid)
    const joined = { ...withOwn, bids: [{ price: '0.5', size: '70' }] };
    let f = fakeCtx({ forecasts: [forecast()], books: { yes1: joined, no1: noNo }, open: [liveBid()] });
    expect(await runExecutorCycle(f.ctx)).toMatchObject({ kept: 1, placed: 0 });
    // A competitor above us: replaced one tick above the competitor
    const outbid = { ...withOwn, bids: [{ price: '0.51', size: '50' }, { price: '0.5', size: '20' }], asks: [{ price: '0.53', size: '100' }] };
    f = fakeCtx({ forecasts: [forecast()], books: { yes1: outbid, no1: noNo }, open: [liveBid()] });
    expect(await runExecutorCycle(f.ctx)).toMatchObject({ kept: 0, cancelled: 1, placed: 1 });
    expect(f.placeLimit.mock.calls[0][2]).toBe(0.52);
  });

  it("counts existing paper holdings against max_per_market_usd even without a conditionId (forecast token map)", async () => {
    const f = fakeCtx({
      forecasts: [forecast()],
      books: { yes1: book(0.49, 0.52), no1: book(0.45, 0.47) },
      positions: [{ tokenId: 'yes1', size: 40, avgPrice: 0.5, currentValue: 20 }],
      config: { max_per_market_usd: 25 },
    });
    const r = await runExecutorCycle(f.ctx);
    // $25 cap − $20 held ⇒ $5 ⇒ 10 shares at 0.50
    expect(r.planned).toEqual([expect.objectContaining({ tokenId: 'yes1', size: 10 })]);
  });

  it('after a position-manager stop skips the token until the forecast is renewed', async () => {
    const stop = { orderId: 'x', tokenId: 'yes1', marketId: 'm1', side: 'sell', orderType: 'limit', price: 0.3, size: 20, filledSize: 20, status: 'filled', reason: 'position manager: stop: bid 0.3 <= entry', forecastId: null, placedBy: 'pm', createdAt: new Date(NOW - 3600_000).toISOString() };
    const books = { yes1: book(0.49, 0.52), no1: book(0.45, 0.47) };
    let f = fakeCtx({ forecasts: [forecast()], books, history: [stop] }); // forecast created a day ago, before the stop
    expect((await runExecutorCycle(f.ctx)).planned).toEqual([]);
    // Other exits (take-profit) do not block
    f = fakeCtx({ forecasts: [forecast()], books, history: [{ ...stop, reason: 'position manager: take_profit: converged' }] });
    expect((await runExecutorCycle(f.ctx)).planned).toHaveLength(1);
    // A forecast renewed after the stop
    f = fakeCtx({ forecasts: [forecast({ id: 'f2', createdAt: new Date(NOW - 60_000).toISOString() })], books, history: [stop] });
    expect((await runExecutorCycle(f.ctx)).planned).toHaveLength(1);
  });

  it('skips quotes below min_edge_per_day (shared default with the position manager) and records unfunded demand', async () => {
    expect(DEFAULT_MIN_EDGE_PER_DAY).toBe(managerConfig({}).minHoldEdgePerDay);
    // 80 days out, edge 0.07 ⇒ 0.000875/day < 0.001: not bought (the reviewer's churn case)
    const far = forecast({ probability: 0.6, endDate: new Date(NOW + 80 * DAY).toISOString() });
    let f = fakeCtx({ forecasts: [far], books: { yes1: book(0.52, 0.53), no1: book(0.45, 0.47) } });
    expect((await runExecutorCycle(f.ctx)).planned).toEqual([]);
    // Budget for one of two: the unfunded one's edge per day is reported
    const plan = allocatePlan(
      [
        { forecastId: 'a', marketId: 'ma', tokenId: 'A', fair: 0.6, price: 0.5, edge: 0.1, edgePerDay: 0.05, days: 2, kelly: 0.2, bucketAllocationUsd: 200 },
        { forecastId: 'b', marketId: 'mb', tokenId: 'B', fair: 0.6, price: 0.5, edge: 0.1, edgePerDay: 0.02, days: 5, kelly: 0.2, bucketAllocationUsd: 200 },
      ],
      executorConfig({ max_per_market_usd: 1000 }),
      { remainingAllocation: 10, remainingMarket: {} },
      {}
    );
    expect(plan.orders.map((o) => o.tokenId)).toEqual(['A']);
    expect(plan.unmetEdgePerDay).toBe(0.02);
    f = fakeCtx({ forecasts: [forecast()], books: { yes1: book(0.49, 0.52), no1: book(0.45, 0.47) } });
    await runExecutorCycle(f.ctx);
    expect(f.storage.set).toHaveBeenCalledWith('executor:demand', { bestUnmetEdgePerDay: null, at: new Date(NOW).toISOString() });
  });

  it('executor + position manager on a market more than 30 days out: what the executor buys is not churned', async () => {
    // 40 days, p = 0.62, ask 0.52 ⇒ bid 0.50, edge 0.12 ⇒ 0.003/day (above the shared 0.001)
    const end = new Date(NOW + 40 * DAY).toISOString();
    const f = fakeCtx({ forecasts: [forecast({ probability: 0.62, endDate: end })], books: { yes1: book(0.49, 0.52), no1: book(0.3, 0.33) } });
    const r = await runExecutorCycle(f.ctx);
    const buy = r.planned.find((p) => p.tokenId === 'yes1')!;
    expect(buy).toBeDefined();
    // The bid fills; one minute later the manager looks at the position (bid 0.50, still 0.12 from fair)
    const position = {
      botId: 'exec', botName: 'exec', tokenId: 'yes1', marketId: 'm1', size: buy.size, openSellSize: 0, available: buy.size, avgPrice: buy.price,
      costBasis: buy.usd, openedAt: new Date(NOW).toISOString(), entryForecastId: 'f1', entryForecastStatus: 'active',
      forecast: { id: 'f1', probability: 0.62, onComplement: false, tradeable: true, createdAt: new Date(NOW - DAY).toISOString() },
      market: { question: 'Q', outcome: 'Yes', category: 'economics', endDate: end, ambiguityScore: 0, rulesChangedAt: null, disputed: false, closed: false },
      exitOrders: [], exitFlag: null,
    };
    const exit = vi.fn();
    const pm = {
      config: {}, now: NOW + 60_000,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      getOrderBook: vi.fn(async () => book(0.5, 0.52)),
      storage: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() },
      portfolio: {
        getAllPositions: vi.fn().mockResolvedValue([position]),
        getExitFlags: vi.fn().mockResolvedValue([]),
        getCapitalDemand: vi.fn().mockResolvedValue({ bestUnmetEdgePerDay: null, at: null }),
        ackExitFlag: vi.fn(),
        exit,
        cancelExit: vi.fn(),
      },
    };
    expect((await runManagerCycle(pm as never)).exits).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('typechecks against botlab-sdk.d.ts (the agent can fork it)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'forecast-executor.ts'), 'utf8');
    expect(typecheckScript(src).diagnostics).toEqual([]);
  });
});
