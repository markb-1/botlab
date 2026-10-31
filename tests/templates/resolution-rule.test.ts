/**
 * Resolution-rule template (spec §9.4, 5b): bids only at or under the target (one tick over the competing bid,
 * below the ask, own bids left out), sized to max_size_usd minus what is held, never sells, and stops buying on each
 * invalidation (rules change, dispute, ambiguity above max, linked forecast withdrawn / below target, exit flag,
 * near the end) — sticky, asking for retirement once flat. Fake ctx, no network.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { bidPrice, resolutionConfig, runResolutionCycle } from '../../templates/resolution-rule';
import { typecheckScript } from '../../packages/core/src/runtime/typecheckScript';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;
const FEE = { takerRate: 0.05, makerRate: 0, formula: 'price' as const, source: 'market' as const };

const book = (bid: number | null, ask: number | null) => ({
  bids: bid === null ? [] : [{ price: String(bid), size: '500' }],
  asks: ask === null ? [] : [{ price: String(ask), size: '500' }],
  tick_size: '0.01',
});

function market(over: Record<string, unknown> = {}) {
  return {
    marketId: '0xm1',
    eventId: 'e1',
    question: 'Will X happen?',
    category: 'economics',
    endDate: new Date(NOW + 10 * DAY).toISOString(),
    active: true,
    closed: false,
    negRisk: false,
    tokens: [
      { tokenId: 'yes', outcome: 'Yes' },
      { tokenId: 'no', outcome: 'No' },
    ],
    tokenId: 'yes',
    outcome: 'Yes',
    complementTokenId: 'no',
    ambiguityScore: 0,
    rulesHash: 'h1',
    rulesChangedAt: null,
    disputed: false,
    umaResolutionStatus: null,
    inScope: true,
    updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

function fakeCtx(opts: { config?: Record<string, unknown>; market?: any; book?: any; positions?: any[]; open?: any[]; forecast?: any; flags?: any[]; budget?: any } = {}) {
  const store = new Map<string, unknown>();
  let now = NOW;
  const state = { market: opts.market ?? market(), book: opts.book ?? book(0.4, 0.6), open: opts.open ?? [], forecast: opts.forecast ?? null, flags: opts.flags ?? [] };
  const placeLimit = vi.fn(async () => ({ ok: true, orderId: 'new', status: 'open', filledSize: 0 }));
  const cancel = vi.fn(async () => undefined);
  const ctx: any = {
    config: { token_id: 'yes', target_entry_price: 0.45, max_size_usd: 20, thesis: 'Rules count only official data; the market misreads them.', ...opts.config },
    get now() {
      return now;
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emit: vi.fn(),
    storage: {
      get: vi.fn(async (k: string) => (store.has(k) ? structuredClone(store.get(k)) : null)),
      set: vi.fn(async (k: string, v: unknown) => void store.set(k, structuredClone(v))),
      delete: vi.fn(),
    },
    getOrderBook: vi.fn(async () => state.book),
    getPositions: vi.fn(async () => opts.positions ?? []),
    sell: vi.fn(),
    risk: { getBudget: vi.fn(async () => opts.budget ?? { remainingAllocation: 1000, remainingMarket: {}, halted: false }), getExitFlags: vi.fn(async () => state.flags) },
    ledger: { getForecast: vi.fn(async (t: string) => (state.forecast && state.forecast.tokenId === t ? state.forecast : null)) },
    requestRetire: vi.fn(),
    polymarket: {
      getMarket: vi.fn(async () => state.market),
      getFee: vi.fn(async () => FEE),
      getOpenOrders: vi.fn(async () => state.open),
      placeLimit,
      cancel,
    },
  };
  return { ctx, state, placeLimit, cancel, advance: (ms: number) => (now += ms) };
}

const openBid = (price: number, size: number) => ({
  orderId: 'b1',
  exchange: 'polymarket',
  marketId: '0xm1',
  tokenId: 'yes',
  side: 'buy',
  orderType: 'limit',
  price,
  size,
  filledSize: 0,
  status: 'open',
  expiresAt: new Date(NOW + 60 * MIN).toISOString(),
  createdAt: new Date(NOW).toISOString(),
  forecastId: null,
  placedBy: null,
});

describe('resolution-rule bids', () => {
  it('bids one tick over the competing bid, never above the target, always below the ask', () => {
    expect(bidPrice({ bestBid: 0.4, bestAsk: 0.6, tick: 0.01 }, 0.45, FEE)).toBe(0.41);
    expect(bidPrice({ bestBid: 0.5, bestAsk: 0.6, tick: 0.01 }, 0.45, FEE)).toBe(0.45);
    expect(bidPrice({ bestBid: 0.3, bestAsk: 0.44, tick: 0.01 }, 0.45, FEE)).toBe(0.31);
    expect(bidPrice({ bestBid: 0.43, bestAsk: 0.44, tick: 0.01 }, 0.45, FEE)).toBe(0.43);
    expect(bidPrice({ bestBid: null, bestAsk: null, tick: 0.01 }, 0.457, FEE)).toBe(0.45);
    // A maker fee counts against the target
    expect(bidPrice({ bestBid: 0.5, bestAsk: 0.6, tick: 0.01 }, 0.45, { ...FEE, makerRate: 0.1 })).toBe(0.42);
  });

  it('places a post-only GTD bid ≤ target sized to max_size_usd minus the cost held, never sells', async () => {
    const s = fakeCtx({ book: book(0.5, 0.6), positions: [{ tokenId: 'yes', size: 20, avgPrice: 0.4, currentValue: 9 }] });
    const r = await runResolutionCycle(s.ctx);
    expect(r).toMatchObject({ action: 'bid', price: 0.45 });
    // 20 − 8 held = 12 USD ⇒ 26.66 shares at 0.45
    expect(s.placeLimit).toHaveBeenCalledWith('yes', 'buy', 0.45, 26.66, expect.objectContaining({ postOnly: true }));
    const opts = s.placeLimit.mock.calls[0][4] as { ttlMinutes: number; forecastId?: string };
    expect(opts.ttlMinutes).toBeGreaterThanOrEqual(3);
    expect(opts.forecastId).toBeUndefined();
    expect(s.ctx.sell).not.toHaveBeenCalled();
  });

  it('keeps its own matching bid (own size left out of the book), re-quotes a stale one, stops at max size', async () => {
    const own = openBid(0.41, 48.78);
    const s = fakeCtx({ book: { bids: [{ price: '0.41', size: '48.78' }, { price: '0.4', size: '100' }], asks: [{ price: '0.6', size: '100' }], tick_size: '0.01' }, open: [own] });
    expect((await runResolutionCycle(s.ctx)).action).toBe('kept');
    expect(s.placeLimit).not.toHaveBeenCalled();
    // Someone outbids at 0.43: re-quote to 0.44
    s.state.book = { bids: [{ price: '0.43', size: '10' }, { price: '0.41', size: '48.78' }], asks: [{ price: '0.6', size: '100' }], tick_size: '0.01' };
    expect(await runResolutionCycle(s.ctx)).toMatchObject({ action: 'bid', price: 0.44 });
    expect(s.cancel).toHaveBeenCalledWith('b1');
    // Holding max_size_usd: nothing more
    const full = fakeCtx({ positions: [{ tokenId: 'yes', size: 50, avgPrice: 0.4, currentValue: 20 }] });
    expect((await runResolutionCycle(full.ctx)).action).toBe('full');
    expect(full.placeLimit).not.toHaveBeenCalled();
  });

  it('no bids while the market is unassessed (the risk engine would refuse them) or during a halt', async () => {
    const u = fakeCtx({ market: market({ ambiguityScore: null }) });
    expect((await runResolutionCycle(u.ctx)).action).toBe('waiting');
    const h = fakeCtx({ budget: { remainingAllocation: 0, remainingMarket: {}, halted: true }, open: [openBid(0.41, 20)] });
    expect((await runResolutionCycle(h.ctx)).action).toBe('halted');
    expect(h.cancel).toHaveBeenCalledWith('b1');
    expect(u.placeLimit).not.toHaveBeenCalled();
    expect(h.placeLimit).not.toHaveBeenCalled();
  });
});

describe('resolution-rule invalidation', () => {
  const held = [{ tokenId: 'yes', size: 20, avgPrice: 0.4, currentValue: 9 }];
  const cases: Array<[string, (s: ReturnType<typeof fakeCtx>) => void, Record<string, unknown>?]> = [
    ['rules change (hash)', (s) => (s.state.market = market({ rulesHash: 'h2' }))],
    ['rules change (time)', (s) => (s.state.market = market({ rulesChangedAt: new Date(NOW + 5 * MIN).toISOString() }))],
    ['dispute', (s) => (s.state.market = market({ disputed: true }))],
    ['ambiguity above max', (s) => (s.state.market = market({ ambiguityScore: 2 }))],
    ['forecast withdrawn', (s) => (s.state.forecast = null), { forecast_id: 'f1' }],
    ['forecast below target', (s) => (s.state.forecast = { id: 'f2', tokenId: 'no', probability: 0.6 }), { forecast_id: 'f1' }],
    ['exit flag', (s) => (s.state.flags = [{ id: 'x', tokenId: 'yes', marketId: '0xm1', reason: 'agent: thesis broken', createdBy: 'agent', createdAt: '' }])],
    ['near the end', (s) => (s.state.market = market({ endDate: new Date(NOW + 60 * MIN).toISOString() }))],
  ];

  for (const [name, breakIt, config] of cases) {
    it(`stops buying on ${name}: bids cancelled, sticky, never sells`, async () => {
      // Holds $8 of $20: a bid of $12 at 0.41 is the plan and is kept
      const s = fakeCtx({ config, positions: held, forecast: { id: 'f1', tokenId: 'yes', probability: 0.7 }, open: [openBid(0.41, 29.26)] });
      expect((await runResolutionCycle(s.ctx)).action).toBe('kept');
      breakIt(s);
      s.advance(10 * MIN);
      const r = await runResolutionCycle(s.ctx);
      expect(r.action).toBe('invalidated');
      expect(s.cancel).toHaveBeenCalledWith('b1');
      expect(s.ctx.emit).toHaveBeenCalledWith('resolution_rule', expect.objectContaining({ state: 'invalidated' }));
      // Sticky: even with everything back to normal, no new bid
      s.state.market = market();
      s.state.flags = [];
      s.state.forecast = { id: 'f1', tokenId: 'yes', probability: 0.7 };
      s.state.open = [];
      s.advance(10 * MIN);
      expect((await runResolutionCycle(s.ctx)).action).toBe('invalidated');
      expect(s.placeLimit).not.toHaveBeenCalled();
      expect(s.ctx.sell).not.toHaveBeenCalled();
    });
  }

  it('invalid and flat, or market closed ⇒ asks for retirement', async () => {
    const flat = fakeCtx();
    await runResolutionCycle(flat.ctx);
    flat.state.market = market({ disputed: true });
    expect((await runResolutionCycle(flat.ctx)).action).toBe('retire');
    const closed = fakeCtx({ positions: held, market: market({ closed: true }) });
    expect((await runResolutionCycle(closed.ctx)).action).toBe('retire');
  });

  it('config: required fields and bounds', () => {
    expect(resolutionConfig({}).errors).toEqual(expect.arrayContaining(['token_id is required', 'thesis is required']));
    expect(resolutionConfig({ token_id: 't', target_entry_price: 1.2, max_size_usd: 5, thesis: 'x' }).errors[0]).toMatch(/target_entry_price/);
    expect(resolutionConfig({ token_id: 't', target_entry_price: 0.5, max_size_usd: 5, thesis: 'x'.repeat(2001) }).errors[0]).toMatch(/2000/);
    expect(resolutionConfig({ token_id: 't', target_entry_price: 0.5, max_size_usd: 5, thesis: 'x' }).cfg).toMatchObject({ maxAmbiguity: 1, invalidateOnRulesChange: true });
  });

  it('typechecks against the SDK and never calls a sell API', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../templates/resolution-rule.ts'), 'utf8');
    expect(typecheckScript(src).diagnostics).toEqual([]);
    expect(src).not.toMatch(/ctx\.sell\(|'sell'/);
    expect(src).toMatch(/role: 'resolution-rule'/);
  });
});
