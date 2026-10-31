/**
 * Copy Trading v2 template (spec §9.5, 5c): de-dup by tx hash + log index across pages and restarts (state in
 * ctx.storage), TRADE rows only, oldest first; sizing (fraction / fixed, capped by max order, budget and market room);
 * sells mirror the leader's sold fraction capped at holdings net of open sells; buy limit = leader fill + max_chase
 * (skipped when the book is beyond it, TTL ≥ 3); leader filters (min size, trades per day, market making); market
 * filters (mandate, near end, Position Manager sells, exit flags); dropped leaders not bought. Fake ctx, no network.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  availableToSell,
  buyUsd,
  copyConfig,
  copySellSize,
  fetchNewTrades,
  isMarketMaking,
  marketSkipReason,
  planBuyPrice,
  planSellPrice,
  runCopyCycle,
  tradeKeys,
} from '../../templates/copy-trading';
import { typecheckScript } from '../../packages/core/src/runtime/typecheckScript';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;
const L = '0x' + 'ab'.repeat(20);
const L2 = '0x' + 'cd'.repeat(20);
const POLICY = { exitBeforeEndMinutes: 180, ambiguityExitScore: 2, source: 'position-manager' as const };
const MANDATE = {
  categoriesAllow: ['economics'],
  resolvesWithinDays: [0, 30] as [number, number],
  longHorizonDays: [30, 90] as [number, number],
  minLiquidityUsd: 5000,
  maxAmbiguityScore: 1,
  strategiesAllow: ['copy'],
};

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
    liquidityUsd: 20_000,
    updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

let seq = 0;
/** An activity row (the data API shape) */
function row(
  o: Partial<{
    side: string;
    asset: string;
    price: number;
    size: number;
    ts: number;
    conditionId: string;
    outcomeIndex: number;
    tx: string;
    logIndex: number | null;
    type: string;
    usdcSize: number;
  }> = {}
) {
  seq++;
  const price = o.price ?? 0.5;
  const size = o.size ?? 100;
  return {
    type: o.type ?? 'TRADE',
    side: o.side ?? 'BUY',
    asset: o.asset ?? 'yes',
    conditionId: o.conditionId ?? '0xm1',
    outcomeIndex: o.outcomeIndex ?? 0,
    price,
    size,
    usdcSize: o.usdcSize ?? price * size,
    timestamp: Math.floor((o.ts ?? NOW - MIN) / 1000),
    transactionHash: o.tx ?? `0xtx${seq}`,
    ...(o.logIndex === null ? {} : { logIndex: o.logIndex ?? 0 }),
  };
}

const book = (bid: number | null, ask: number | null) => ({
  bids: bid === null ? [] : [{ price: String(bid), size: '500' }],
  asks: ask === null ? [] : [{ price: String(ask), size: '500' }],
  tick_size: '0.01',
});

function fakeCtx(opts: { config?: Record<string, unknown> } = {}) {
  const store = new Map<string, unknown>();
  const state = {
    now: NOW,
    /** Per leader, newest first (as the API answers) */
    activity: { [L]: [] as any[], [L2]: [] as any[] } as Record<string, any[]>,
    leaderPositions: [] as any[],
    statuses: {} as Record<string, string>,
    market: market() as any,
    book: book(0.49, 0.5) as any,
    positions: [] as any[],
    open: [] as any[],
    history: [] as any[],
    flags: [] as any[],
    mandate: MANDATE as any,
    budget: { remainingAllocation: 1000, remainingMarket: {} as Record<string, number>, halted: false },
  };
  const fetchUrls: string[] = [];
  const placeLimit = vi.fn(async () => ({ ok: true, orderId: `o${seq++}`, status: 'open', filledSize: 0 }));
  const ctx: any = {
    config: { leaders: [L], ...opts.config },
    get now() {
      return state.now;
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emit: vi.fn(),
    storage: {
      get: vi.fn(async (k: string) => (store.has(k) ? structuredClone(store.get(k)) : null)),
      set: vi.fn(async (k: string, v: unknown) => void store.set(k, structuredClone(v))),
      delete: vi.fn(),
    },
    fetch: vi.fn(async (url: string) => {
      fetchUrls.push(url);
      const u = new URL(url);
      if (u.pathname === '/activity') {
        const rows = state.activity[u.searchParams.get('user')!] ?? [];
        const offset = Number(u.searchParams.get('offset') ?? 0);
        const limit = Number(u.searchParams.get('limit') ?? 100);
        return { ok: true, status: 200, json: async () => structuredClone(rows.slice(offset, offset + limit)) };
      }
      return { ok: true, status: 200, json: async () => structuredClone(state.leaderPositions) };
    }),
    copy: { getLeaders: vi.fn(async (addrs: string[]) => addrs.map((a) => ({ address: a, status: state.statuses[a] ?? 'active', droppedReason: null }))) },
    risk: {
      getBudget: vi.fn(async () => structuredClone(state.budget)),
      getMandateSummary: vi.fn(async () => state.mandate),
      getExitPolicy: vi.fn(async () => POLICY),
      getExitFlags: vi.fn(async () => state.flags),
    },
    getPositions: vi.fn(async () => state.positions),
    getOrderBook: vi.fn(async () => state.book),
    getMarketPrice: vi.fn(async () => ({ bid: 0.5, ask: 0.52, mid: 0.51, spread: 0.02 })),
    polymarket: {
      getOrderHistory: vi.fn(async () => state.history),
      getOpenOrders: vi.fn(async () => state.open),
      getMarket: vi.fn(async () => state.market),
      placeLimit,
      cancel: vi.fn(),
    },
  };
  return { ctx, state, placeLimit, fetchUrls, store };
}

/** First cycle: the cursor starts at what the leader already did (nothing copied) */
async function primed(opts: { config?: Record<string, unknown> } = {}, history: any[] = [row({ ts: NOW - 2 * DAY })]) {
  const s = fakeCtx(opts);
  s.state.activity[L] = history;
  const r = await runCopyCycle(s.ctx);
  expect(r.copied).toBe(0);
  expect(s.placeLimit).not.toHaveBeenCalled();
  return s;
}

describe('copy trading v2: activity', () => {
  it('keys trades by tx hash + log index; without a log index by the fill, numbering identical fills', () => {
    expect(tradeKeys([{ transactionHash: '0xAA', logIndex: 3 }])).toEqual(['0xaa:3']);
    const a = { transactionHash: '0xbb', asset: 't', side: 'BUY', size: 5, price: 0.5 };
    expect(tradeKeys([a, a, { ...a, size: 6 }])).toEqual(['0xbb:t:BUY:5:0.5', '0xbb:t:BUY:5:0.5#2', '0xbb:t:BUY:6:0.5']);
  });

  it('paginates until the last seen trade, de-duplicates across pages and restarts, oldest first, TRADE rows only', async () => {
    const s = await primed();
    // 150 new rows (newest first) + a REDEEM, then the already-seen one: two pages of 100
    const fresh = Array.from({ length: 150 }, (_, i) => row({ ts: NOW - (150 - i) * 1000, size: 1, tx: `0xn${i}` })).reverse();
    s.state.activity[L] = [row({ type: 'REDEEM', ts: NOW - 500 }), ...fresh, ...s.state.activity[L]];
    const cursor = (await s.ctx.storage.get('copy:state')).cursors[L];
    const got = await fetchNewTrades(s.ctx, L, cursor);
    expect(got.trades).toHaveLength(150);
    expect(got.trades.map((t) => t.key)).toEqual(Array.from({ length: 150 }, (_, i) => `0xn${i}:0`)); // oldest first
    expect(
      s.fetchUrls
        .filter((u) => u.includes('/activity'))
        .slice(-2)
        .map((u) => new URL(u).searchParams.get('offset'))
    ).toEqual(['0', '100']);

    // A full cycle processes them once (all tiny: skipped as below min size), state persisted in ctx.storage
    await runCopyCycle(s.ctx);
    // "Restart": same storage, fresh read of the same activity ⇒ nothing new
    const again = await fetchNewTrades(s.ctx, L, (await s.ctx.storage.get('copy:state')).cursors[L]);
    expect(again.trades).toHaveLength(0);
    // Same-second rows with distinct log indexes are distinct trades
    const ts = NOW - 10;
    s.state.activity[L] = [row({ ts, tx: '0xsame', logIndex: 2, size: 1 }), row({ ts, tx: '0xsame', logIndex: 1, size: 1 }), ...s.state.activity[L]];
    const same = await fetchNewTrades(s.ctx, L, (await s.ctx.storage.get('copy:state')).cursors[L]);
    expect(same.trades.map((t) => t.key)).toEqual(['0xsame:1', '0xsame:2']);
  });

  it('a trade arriving between two page reads (offsets shift) is not copied twice (review)', async () => {
    const s = await primed();
    const fresh = Array.from({ length: 150 }, (_, i) => row({ ts: NOW - (150 - i) * 1000, size: 1, tx: `0xp${i}`, logIndex: null })).reverse();
    s.state.activity[L] = [...fresh, ...s.state.activity[L]];
    const orig = s.ctx.fetch.getMockImplementation();
    let pages = 0;
    s.ctx.fetch.mockImplementation(async (url: string) => {
      const r = await orig(url);
      // After page 1 is read the leader trades again: every row moves one place down
      if (url.includes('/activity') && pages++ === 0)
        s.state.activity[L] = [row({ ts: NOW - 100, size: 1, tx: '0xlate', logIndex: null }), ...s.state.activity[L]];
      return r;
    });
    const got = await fetchNewTrades(s.ctx, L, (await s.ctx.storage.get('copy:state')).cursors[L]);
    const keys = got.trades.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some((k) => k.includes('#2'))).toBe(false);
    expect(keys).toHaveLength(150);
  });

  it('the first poll of a leader copies no backlog', async () => {
    const s = fakeCtx();
    s.state.activity[L] = [row({ ts: NOW - 10_000, usdcSize: 500 })];
    const r = await runCopyCycle(s.ctx);
    expect(r.copied).toBe(0);
    expect(s.placeLimit).not.toHaveBeenCalled();
  });
});

describe('copy trading v2: sizing and prices', () => {
  const cfg = copyConfig({ leaders: [L] }).cfg;
  const budget = { remainingAllocation: 1000, remainingMarket: {}, halted: false };

  it('size = copy_fraction × leader USD or fixed, capped by max order, budget and market room', () => {
    expect(buyUsd(cfg, 100, budget, 'm')).toEqual({ usd: 10, cappedBy: null });
    expect(buyUsd({ ...cfg, sizing: 'fixed', fixedUsd: 7 }, 1000, budget, 'm')).toEqual({ usd: 7, cappedBy: null });
    expect(buyUsd(cfg, 1000, budget, 'm')).toEqual({ usd: 25, cappedBy: 'max_order_usd' });
    expect(buyUsd(cfg, 1000, { ...budget, remainingAllocation: 12 }, 'm')).toEqual({ usd: 12, cappedBy: 'risk budget' });
    expect(buyUsd(cfg, 1000, { ...budget, remainingMarket: { m: 4 } }, 'm')).toEqual({ usd: 4, cappedBy: 'market room' });
    // No small-trade boost: a $5 leader trade copies 10 %
    expect(buyUsd(cfg, 5, budget, 'm').usd).toBe(0.5);
  });

  it('buy limit = leader fill + max_chase; skipped when the book is already beyond; sells rest at fill − chase', () => {
    expect(planBuyPrice(0.5, 0.01, 0.5, 0.01)).toEqual({ price: 0.51 });
    expect(planBuyPrice(0.5, 0.01, 0.51, 0.01)).toEqual({ price: 0.51 });
    expect(planBuyPrice(0.5, 0.01, 0.52, 0.01)).toMatchObject({ skip: expect.stringMatching(/book moved/) });
    expect(planBuyPrice(0.5, 0.01, null, 0.01)).toEqual({ price: 0.51 });
    expect(planBuyPrice(0.985, 0.01, 0.99, 0.001)).toEqual({ price: 0.99 });
    expect(planSellPrice(0.5, 0.01, 0.01)).toBe(0.49);
    expect(planSellPrice(0.005, 0.01, 0.01)).toBe(0.01);
  });

  it('TTL is at least 3 minutes (GTD minimum); legacy keys still read', () => {
    expect(copyConfig({ leaders: [L], ttl_minutes: 2 }).errors.join()).toMatch(/at least 3/);
    expect(copyConfig({ leaders: [L] }).cfg.ttlMinutes).toBe(10);
    expect(copyConfig({ traders: [L], baseMultiplier: 0.2 }).cfg).toMatchObject({ leaders: [L], copyFraction: 0.2 });
    expect(copyConfig({ leaders: ['nope'] }).errors.join()).toMatch(/not a 0x address/);
  });

  it('sells mirror the leader fraction, capped at holdings net of open sells', () => {
    expect(copySellSize({ heldTokens: 50, leaderSoldTokens: 40, leaderRemainingTokens: 60, copyUsd: 5, price: 0.5 })).toEqual({
      tokens: 20,
      basis: 'fraction',
    });
    expect(copySellSize({ heldTokens: 33.337, leaderSoldTokens: 10, leaderRemainingTokens: 0, copyUsd: 1, price: 0.5 })).toEqual({
      tokens: 33.33,
      basis: 'fraction',
    });
    expect(copySellSize({ heldTokens: 100, leaderSoldTokens: 40, leaderRemainingTokens: null, copyUsd: 10, price: 0.4 })).toEqual({ tokens: 25, basis: 'usd' });
    const open = [
      { tokenId: 'yes', side: 'sell' as const, size: 30, filledSize: 10 },
      { tokenId: 'yes', side: 'buy' as const, size: 50, filledSize: 0 },
      { tokenId: 'no', side: 'sell' as const, size: 50, filledSize: 0 },
    ];
    expect(availableToSell(80, open, 'yes')).toBe(60);
    expect(copySellSize({ heldTokens: availableToSell(80, open, 'yes'), leaderSoldTokens: 100, leaderRemainingTokens: 0, copyUsd: 1 }).tokens).toBe(60);
    expect(availableToSell(10, open, 'yes')).toBe(0);
  });
});

describe('copy trading v2: cycle', () => {
  it('copies a leader buy as a limit at fill + chase, tagged with the leader, TTL ≥ 3', async () => {
    const s = await primed();
    s.state.activity[L] = [row({ price: 0.5, size: 200, ts: NOW - MIN }), ...s.state.activity[L]];
    const r = await runCopyCycle(s.ctx);
    expect(r.copied).toBe(1);
    // 10 % of $100 = $10 at 0.51 ⇒ 19.6 shares
    expect(s.placeLimit).toHaveBeenCalledWith(
      'yes',
      'buy',
      0.51,
      19.6,
      expect.objectContaining({ postOnly: false, ttlMinutes: 10, copy: expect.objectContaining({ leader: L, leaderPrice: 0.5 }) })
    );
    // Not copied twice
    await runCopyCycle(s.ctx);
    expect(s.placeLimit).toHaveBeenCalledTimes(1);
  });

  it('skips when the book moved beyond leader + chase (never chases)', async () => {
    const s = await primed();
    s.state.book = book(0.53, 0.55);
    s.state.activity[L] = [row({ price: 0.5, size: 200 }), ...s.state.activity[L]];
    const r = await runCopyCycle(s.ctx);
    expect(r.copied).toBe(0);
    expect(s.placeLimit).not.toHaveBeenCalled();
    expect(Object.keys(r.skipped).join()).toMatch(/book moved/);
  });

  it('leader filters: min trade size, max trades per day, market making (buys only)', async () => {
    const s = await primed({ config: { min_leader_trade_usd: 20, max_leader_trades_per_day: 3, mm_window_minutes: 30 } });
    // $10 leader buy < $20 ⇒ skipped
    s.state.activity[L] = [row({ price: 0.5, size: 20, ts: NOW - 50 * MIN }), ...s.state.activity[L]];
    await runCopyCycle(s.ctx);
    expect(s.placeLimit).not.toHaveBeenCalled();

    // Leader sells the market, then buys it again 10 min later ⇒ market making, the buy is skipped
    s.state.activity[L] = [
      row({ side: 'BUY', price: 0.5, size: 200, ts: NOW - 30 * MIN }),
      row({ side: 'SELL', price: 0.5, size: 200, ts: NOW - 40 * MIN }),
      ...s.state.activity[L],
    ];
    const mm = await runCopyCycle(s.ctx);
    expect(Object.keys(mm.skipped).join()).toMatch(/market making/);
    expect(s.placeLimit).not.toHaveBeenCalled();

    // Fourth trade of the day > max 3 ⇒ skipped (a different market, no MM)
    s.state.activity[L] = [row({ asset: 'yes', conditionId: '0xother', price: 0.5, size: 200, ts: NOW - MIN }), ...s.state.activity[L]];
    const busy = await runCopyCycle(s.ctx);
    expect(Object.keys(busy.skipped).join()).toMatch(/max_leader_trades_per_day/);
    expect(s.placeLimit).not.toHaveBeenCalled();

    // Buying the other outcome counts as the opposite direction too
    expect(
      isMarketMaking(
        [['0xm1', 1, NOW - 5 * MIN]],
        { key: 'k', ts: NOW, side: 'BUY', tokenId: 'no', conditionId: '0xm1', outcomeIndex: 1, size: 1, price: 0.5, usd: 0.5 },
        30 * MIN
      )
    ).toBe(true);
    expect(
      isMarketMaking(
        [['0xm1', 1, NOW - 50 * MIN]],
        { key: 'k', ts: NOW, side: 'BUY', tokenId: 'no', conditionId: '0xm1', outcomeIndex: 1, size: 1, price: 0.5, usd: 0.5 },
        30 * MIN
      )
    ).toBe(false);
  });

  it('market filters: mandate, near end, Position Manager sold, exit flag, dropped leader', async () => {
    const t = NOW;
    expect(marketSkipReason(market() as any, MANDATE, POLICY, t)).toBeNull();
    expect(marketSkipReason(market({ category: 'sports' }) as any, MANDATE, POLICY, t)).toMatch(/category sports/);
    expect(marketSkipReason(market({ liquidityUsd: 100 }) as any, MANDATE, POLICY, t)).toMatch(/liquidity/);
    expect(marketSkipReason(market({ ambiguityScore: null }) as any, MANDATE, POLICY, t)).toMatch(/not assessed/);
    expect(marketSkipReason(market({ ambiguityScore: 2 }) as any, { ...MANDATE, maxAmbiguityScore: 3 }, POLICY, t)).toMatch(/exit score/);
    expect(marketSkipReason(market({ endDate: new Date(t + 60 * DAY).toISOString() }) as any, { ...MANDATE, longHorizonDays: [30, 45] }, POLICY, t)).toMatch(
      /horizons/
    );
    expect(marketSkipReason(market({ endDate: new Date(t + 2 * 3_600_000).toISOString() }) as any, MANDATE, POLICY, t)).toMatch(/exit window/);
    expect(marketSkipReason(market({ disputed: true }) as any, MANDATE, POLICY, t)).toMatch(/dispute/);
    expect(marketSkipReason(market({ rulesChangedAt: new Date(t - 3_600_000).toISOString() }) as any, MANDATE, POLICY, t)).toMatch(/rules changed/);
    expect(marketSkipReason(market() as any, null, POLICY, t)).toMatch(/mandate unavailable/);
    expect(marketSkipReason(market() as any, { ...MANDATE, strategiesAllow: ['forecast'] }, POLICY, t)).toMatch(/copy trading is off/);

    const s = await primed();
    const leaderBuy = () => (s.state.activity[L] = [row({ price: 0.5, size: 200, ts: NOW - MIN }), ...s.state.activity[L]]);
    s.state.history = [{ placedBy: 'pm', side: 'sell', tokenId: 'yes', createdAt: new Date(NOW - DAY).toISOString() }];
    leaderBuy();
    expect(Object.keys((await runCopyCycle(s.ctx)).skipped).join()).toMatch(/Position Manager sold/);
    s.state.history = [];
    s.state.flags = [{ id: 'f', tokenId: 'yes', marketId: '0xm1', reason: 'thesis broken', createdBy: 'agent', createdAt: '' }];
    leaderBuy();
    expect(Object.keys((await runCopyCycle(s.ctx)).skipped).join()).toMatch(/exit flag/);
    s.state.flags = [];
    s.state.statuses[L] = 'dropped';
    leaderBuy();
    expect(Object.keys((await runCopyCycle(s.ctx)).skipped).join()).toMatch(/leader dropped/);
    s.state.statuses[L] = 'active';
    s.state.market = market({ category: 'sports' });
    leaderBuy();
    expect(Object.keys((await runCopyCycle(s.ctx)).skipped).join()).toMatch(/category sports/);
    expect(s.placeLimit).not.toHaveBeenCalled();
  });

  it('a leader sell mirrors their sold fraction of our holdings net of open sells, as a resting limit', async () => {
    const s = await primed();
    s.state.positions = [{ tokenId: 'yes', size: 100, avgPrice: 0.4, currentValue: 40 }];
    s.state.open = [{ orderId: 'x', tokenId: 'yes', side: 'sell', size: 20, filledSize: 0, placedBy: 'pm' }];
    // Leader sold 30 and keeps 90 ⇒ 25 % of our 80 available
    s.state.leaderPositions = [{ asset: 'yes', conditionId: '0xm1', size: 90 }];
    s.state.statuses[L] = 'dropped'; // sells are mirrored for a dropped leader too (unwinding)
    s.state.activity[L] = [row({ side: 'SELL', price: 0.6, size: 30 }), ...s.state.activity[L]];
    await runCopyCycle(s.ctx);
    expect(s.placeLimit).toHaveBeenCalledWith(
      'yes',
      'sell',
      0.59,
      20,
      expect.objectContaining({ ttlMinutes: 10, copy: expect.objectContaining({ leader: L }) })
    );
  });

  it("a leader's sell unwinds only what the bot bought copying that leader; no attribution ⇒ whole holding (review)", async () => {
    const s = await primed();
    s.state.positions = [{ tokenId: 'yes', size: 100, avgPrice: 0.4, currentValue: 40 }];
    s.state.leaderPositions = [{ asset: 'yes', conditionId: '0xm1', size: 0 }]; // the leader exits completely
    // 70 shares were bought copying another leader, 30 copying L
    s.ctx.copy.getHoldings = vi.fn(async () => ({ byLeader: { [L]: 30, [L2]: 70 }, attributed: 100 }));
    s.state.activity[L] = [row({ side: 'SELL', price: 0.6, size: 30 }), ...s.state.activity[L]];
    await runCopyCycle(s.ctx);
    expect(s.placeLimit).toHaveBeenLastCalledWith('yes', 'sell', 0.59, 30, expect.anything());
    // Nothing attributed to L ⇒ nothing sold
    s.ctx.copy.getHoldings = vi.fn(async () => ({ byLeader: { [L2]: 70 }, attributed: 70 }));
    s.state.activity[L] = [row({ side: 'SELL', price: 0.6, size: 30 }), ...s.state.activity[L]];
    await runCopyCycle(s.ctx);
    expect(s.placeLimit).toHaveBeenCalledTimes(1);
    // No attribution for the token at all ⇒ the whole holding, logged
    s.ctx.copy.getHoldings = vi.fn(async () => ({ byLeader: {}, attributed: 0 }));
    s.state.activity[L] = [row({ side: 'SELL', price: 0.6, size: 30 }), ...s.state.activity[L]];
    await runCopyCycle(s.ctx);
    expect(s.placeLimit).toHaveBeenLastCalledWith('yes', 'sell', 0.59, 100, expect.anything());
    expect(s.ctx.log.info).toHaveBeenCalledWith(expect.stringMatching(/no leader attribution/));
  });

  it('builtin template typechecks against the SDK', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'copy-trading.ts'), 'utf8');
    expect(typecheckScript(src).diagnostics).toEqual([]);
  });
});
