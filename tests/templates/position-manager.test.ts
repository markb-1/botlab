/**
 * Position manager template (spec §9.2, §3.4): each exit trigger, hold otherwise, post-only first then
 * marketable after escalate_after_minutes, cancels its exits when the trigger is gone, sizes never above what
 * is available (+ its own replaced exits), acknowledges flags of closed positions. Fake ctx, no network.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { exitDecision, managerConfig, runManagerCycle, topOf } from '../../templates/position-manager';
import { typecheckScript } from '../../packages/core/src/runtime/typecheckScript';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const DAY = 86_400_000;
const MIN = 60_000;
const cfg = managerConfig({});

const book = (bid: number, ask: number) => ({ bids: [{ price: String(bid), size: '500' }], asks: [{ price: String(ask), size: '500' }], tick_size: '0.01' });

function position(over: Record<string, any> = {}) {
  return {
    botId: 'b1',
    botName: 'exec',
    tokenId: 'yes1',
    marketId: 'm1',
    size: 20,
    openSellSize: 0,
    available: 20,
    avgPrice: 0.5,
    costBasis: 10,
    openedAt: new Date(NOW - DAY).toISOString(),
    entryForecastId: 'f1',
    entryForecastStatus: 'active',
    forecast: { id: 'f1', probability: 0.65, onComplement: false, tradeable: true, createdAt: new Date(NOW - 2 * DAY).toISOString() },
    market: {
      question: 'Q?',
      outcome: 'Yes',
      category: 'economics',
      endDate: new Date(NOW + 5 * DAY).toISOString(),
      ambiguityScore: 0,
      rulesChangedAt: null,
      disputed: false,
      closed: false,
    },
    exitOrders: [],
    exitFlag: null,
    ...over,
  };
}

const decide = (p: ReturnType<typeof position>, bid: number, ask: number, now = NOW) => exitDecision(p as never, topOf(book(bid, ask) as never), cfg, now);

describe('position manager: exit triggers', () => {
  it('holds a ledger position with edge left', () => {
    expect(decide(position(), 0.55, 0.57)).toBeNull();
  });

  it('take-profit on convergence: bid ≥ fair − margin, resting at max(bid + tick, fair − margin)', () => {
    expect(decide(position(), 0.63, 0.65)).toMatchObject({ kind: 'take_profit', restingPrice: 0.64 });
    // Mirror for a NO token: the fair value is already per token (1 − p from the YES forecast)
    const no = position({ tokenId: 'no1', forecast: { id: 'f1', probability: 0.35, onComplement: true, tradeable: true, createdAt: '' }, avgPrice: 0.25 });
    expect(decide(no, 0.33, 0.36)).toMatchObject({ kind: 'take_profit', restingPrice: 0.34 });
    expect(decide(no, 0.3, 0.32)).toBeNull();
  });

  it('forecast withdrawn (none active) or flipped below the entry price', () => {
    expect(decide(position({ forecast: null, entryForecastStatus: 'withdrawn' }), 0.55, 0.57)).toMatchObject({ kind: 'withdrawn' });
    expect(decide(position({ forecast: { id: 'f2', probability: 0.45, onComplement: false, tradeable: true, createdAt: '' } }), 0.44, 0.46)).toMatchObject({ kind: 'flipped' });
  });

  it('rules changed after the position opened; ambiguity ≥ 2 or a dispute', () => {
    const m = position().market;
    expect(decide(position({ market: { ...m, rulesChangedAt: new Date(NOW - 60 * MIN).toISOString() } }), 0.55, 0.57)).toMatchObject({ kind: 'rules', restingPrice: 0.56 });
    expect(decide(position({ market: { ...m, rulesChangedAt: new Date(NOW - 3 * DAY).toISOString() } }), 0.55, 0.57)).toBeNull(); // before entry
    expect(decide(position({ market: { ...m, ambiguityScore: 2 } }), 0.55, 0.57)).toMatchObject({ kind: 'ambiguity' });
    expect(decide(position({ market: { ...m, disputed: true } }), 0.55, 0.57)).toMatchObject({ kind: 'ambiguity' });
  });

  it('exit flag from the agent, also for positions bought without a forecast', () => {
    const flag = { id: 'x', botId: 'b1', tokenId: 'yes1', marketId: 'm1', reason: 'thesis broken', createdBy: 'agent', createdAt: '' };
    expect(decide(position({ exitFlag: flag, entryForecastId: null, forecast: null }), 0.55, 0.57)).toMatchObject({ kind: 'flag' });
    // Without a forecast and without risk triggers a position is left alone
    expect(decide(position({ entryForecastId: null, forecast: null }), 0.2, 0.22)).toBeNull();
  });

  it('ambiguous market close to its end', () => {
    const m = position().market;
    expect(decide(position({ market: { ...m, ambiguityScore: 1, endDate: new Date(NOW + 100 * MIN).toISOString() } }), 0.55, 0.57)).toMatchObject({ kind: 'end' });
    expect(decide(position({ market: { ...m, ambiguityScore: 0, endDate: new Date(NOW + 100 * MIN).toISOString() } }), 0.55, 0.57)).not.toMatchObject({ kind: 'end' });
  });

  it('low remaining edge per day only when the executor has better unfunded demand', () => {
    const m = position().market;
    const p = position({ market: { ...m, endDate: new Date(NOW + 60 * DAY).toISOString() } });
    const top = topOf(book(0.6, 0.62) as never);
    // (0.65 − 0.6) / 60 days < 0.001, but nothing better is waiting: hold
    expect(exitDecision(p as never, top, cfg, NOW)).toBeNull();
    expect(exitDecision(p as never, top, cfg, NOW, 0.0005)).toBeNull(); // demand worse than this position
    expect(exitDecision(p as never, top, cfg, NOW, 0.01)).toMatchObject({ kind: 'low_edge' });
  });

  it('stop: price moved against by stop_loss_move with no new forecast; a renewed forecast holds', () => {
    expect(decide(position(), 0.34, 0.36)).toMatchObject({ kind: 'stop' });
    const renewed = position({ forecast: { id: 'f2', probability: 0.65, onComplement: false, tradeable: true, createdAt: '' } });
    expect(decide(renewed, 0.34, 0.36)).toBeNull();
  });
});

function fakeCtx(positions: any[], opts: { flags?: any[]; storage?: Record<string, unknown>; now?: number; books?: Record<string, any>; demand?: any } = {}) {
  const store = new Map(Object.entries(opts.storage ?? {}));
  const exit = vi.fn().mockResolvedValue({ ok: true, status: 'open', orderId: 'e1' });
  const cancelExit = vi.fn().mockResolvedValue(undefined);
  const ackExitFlag = vi.fn().mockResolvedValue(true);
  const ctx = {
    config: {},
    now: opts.now ?? NOW,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getOrderBook: vi.fn(async (t: string) => opts.books?.[t] ?? book(0.63, 0.65)),
    storage: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: unknown) => void store.set(k, v)),
      delete: vi.fn(async (k: string) => void store.delete(k)),
    },
    portfolio: {
      getAllPositions: vi.fn().mockResolvedValue(positions),
      getExitFlags: vi.fn().mockResolvedValue(opts.flags ?? []),
      getCapitalDemand: vi.fn().mockResolvedValue(opts.demand ?? { bestUnmetEdgePerDay: null, at: null }),
      ackExitFlag,
      exit,
      cancelExit,
    },
  };
  return { ctx: ctx as never, exit, cancelExit, ackExitFlag, store };
}

describe('position manager: cycle', () => {
  it('places a post-only take-profit for what is available, as a sell of the owning bot', async () => {
    const f = fakeCtx([position()]);
    const r = await runManagerCycle(f.ctx);
    expect(r.exits).toEqual([expect.objectContaining({ kind: 'take_profit', size: 20, marketable: false })]);
    expect(f.exit).toHaveBeenCalledWith(expect.objectContaining({ botId: 'b1', tokenId: 'yes1', size: 20, price: 0.64 }));
    expect(f.exit.mock.calls[0][0].marketable).toBeUndefined();
  });

  it('never asks for more than available: open sells of the owner itself are left alone', async () => {
    const own = { orderId: 'o', orderType: 'limit', price: 0.7, size: 8, filledSize: 0, status: 'open', placedByMe: false, createdAt: '', expiresAt: null };
    const f = fakeCtx([position({ openSellSize: 8, available: 12, exitOrders: [own] })]);
    await runManagerCycle(f.ctx);
    expect(f.exit.mock.calls[0][0].size).toBe(12);
    expect(f.cancelExit).not.toHaveBeenCalled();
  });

  it('keeps an identical resting exit; escalates to marketable after escalate_after_minutes', async () => {
    const mine = { orderId: 'e0', orderType: 'limit', price: 0.64, size: 20, filledSize: 0, status: 'open', placedByMe: true, createdAt: '', expiresAt: null };
    const p = position({ openSellSize: 20, available: 0, exitOrders: [mine] });
    const started = { 'exit:b1:yes1': { startedAt: NOW - 5 * MIN, kind: 'take_profit', openedAt: p.openedAt } };
    let f = fakeCtx([p], { storage: started });
    await runManagerCycle(f.ctx);
    expect(f.exit).not.toHaveBeenCalled();
    expect(f.cancelExit).not.toHaveBeenCalled();

    // 31 minutes later: cancel the resting exit, sell marketable at best bid − slippage
    f = fakeCtx([p], { storage: started, now: NOW + 26 * MIN });
    (f.ctx as any).portfolio.getAllPositions.mockResolvedValueOnce([p]).mockResolvedValueOnce([position()]);
    await runManagerCycle(f.ctx);
    expect(f.cancelExit).toHaveBeenCalledWith('e0');
    expect(f.exit).toHaveBeenCalledWith(expect.objectContaining({ marketable: true, size: 20, price: 0.61 }));
  });

  it('cancels its exits when the trigger is gone', async () => {
    const mine = { orderId: 'e0', orderType: 'limit', price: 0.64, size: 20, filledSize: 0, status: 'open', placedByMe: true, createdAt: '', expiresAt: null };
    const f = fakeCtx([position({ openSellSize: 20, available: 0, exitOrders: [mine] })], { books: { yes1: book(0.55, 0.57) } });
    const r = await runManagerCycle(f.ctx);
    expect(f.cancelExit).toHaveBeenCalledWith('e0');
    expect(r.exits).toEqual([]);
  });

  it('acknowledges flags whose position is closed; acts on open ones', async () => {
    const closed = { id: 'fl1', botId: 'b9', tokenId: 'gone', marketId: null, reason: 'x', createdBy: 'agent', createdAt: '' };
    const live = { id: 'fl2', botId: 'b1', tokenId: 'yes1', marketId: 'm1', reason: 'thesis broken', createdBy: 'agent', createdAt: '' };
    const f = fakeCtx([position({ exitFlag: live })], { flags: [closed, live], books: { yes1: book(0.5, 0.52) } });
    const r = await runManagerCycle(f.ctx);
    expect(f.ackExitFlag).toHaveBeenCalledTimes(1);
    expect(f.ackExitFlag).toHaveBeenCalledWith('fl1', 'position closed');
    expect(r.exits).toEqual([expect.objectContaining({ kind: 'flag', size: 20 })]);
    expect(f.exit.mock.calls[0][0]).toMatchObject({ price: 0.51 }); // one tick inside the ask
  });

  it('low_edge uses a fresh executor demand report only', async () => {
    const m = position().market;
    const p = position({ market: { ...m, endDate: new Date(NOW + 60 * DAY).toISOString() } });
    const books = { yes1: book(0.6, 0.62) };
    let f = fakeCtx([p], { books, demand: { bestUnmetEdgePerDay: 0.01, at: new Date(NOW - 2 * 3600_000).toISOString() } }); // stale
    expect((await runManagerCycle(f.ctx)).exits).toEqual([]);
    f = fakeCtx([p], { books, demand: { bestUnmetEdgePerDay: 0.01, at: new Date(NOW - 60_000).toISOString() } });
    expect((await runManagerCycle(f.ctx)).exits).toEqual([expect.objectContaining({ kind: 'low_edge' })]);
  });

  it('skips closed markets and ignored bots', async () => {
    const m = position().market;
    const f = fakeCtx([position({ market: { ...m, closed: true } }), position({ botId: 'skip' })]);
    (f.ctx as any).config = { ignore_bot_ids: ['skip'] };
    await runManagerCycle(f.ctx);
    expect(f.exit).not.toHaveBeenCalled();
  });

  it('typechecks against botlab-sdk.d.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'position-manager.ts'), 'utf8');
    expect(typecheckScript(src).diagnostics).toEqual([]);
  });
});
