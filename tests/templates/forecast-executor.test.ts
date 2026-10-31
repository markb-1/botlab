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
  executorConfig,
  kellyFraction,
  quoteFor,
  runExecutorCycle,
  type Quote,
} from '../../templates/forecast-executor';
import { typecheckScript } from '../../packages/core/src/runtime/typecheckScript';

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
}) {
  const placeLimit = vi.fn().mockResolvedValue({ ok: true, status: 'open', orderId: 'new' });
  const cancel = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    config: opts.config ?? {},
    now: NOW,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getPositions: vi.fn().mockResolvedValue(opts.positions ?? []),
    getOrderBook: vi.fn(async (t: string) => opts.books[t] ?? book(0.01, 0.99)),
    ledger: { getActiveForecasts: vi.fn().mockResolvedValue(opts.forecasts) },
    risk: { getBudget: vi.fn().mockResolvedValue(opts.budget ?? { remainingAllocation: 1000, remainingMarket: {}, halted: false }) },
    polymarket: {
      getOpenOrders: vi.fn().mockResolvedValue(opts.open ?? []),
      getFee: vi.fn().mockResolvedValue(opts.fee ?? NO_FEE),
      placeLimit,
      cancel,
    },
  };
  return { ctx: ctx as never, placeLimit, cancel };
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

  it('typechecks against botlab-sdk.d.ts (the agent can fork it)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'forecast-executor.ts'), 'utf8');
    expect(typecheckScript(src).diagnostics).toEqual([]);
  });
});
