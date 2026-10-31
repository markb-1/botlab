/**
 * Polymarket snapshot backtests (spec §10): no look-ahead, post-only fill rule, depth, fees, determinism,
 * and the engine path (worker + IPC source) with the Binance path unchanged.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import path from 'path';
import { compileScript } from '../../electron/runtime/compileScript';
import { groupSteps, runSnapshotSimulation, SnapshotMarket, type SnapshotSimulationInput } from '../../electron/backtest/snapshotSimulate';
import { BacktestEngine } from '../../electron/backtest/BacktestEngine';
import type { BookSnapshot, Level } from '../../electron/recorder/snapshotCodec';
import { buildWorker, ROOT } from '../sandbox/buildWorker';

function snap(tokenId: string, ts: number, bids: Level[], asks: Level[]): BookSnapshot {
  const bestBid = bids[0]?.[0] ?? null;
  const bestAsk = asks[0]?.[0] ?? null;
  return { tokenId, ts, bestBid, bestAsk, mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null, bids, asks, lastTradePrice: null };
}

async function compile(src: string): Promise<string> {
  const r = await compileScript(src);
  if ('error' in r) throw new Error(r.error);
  return r.code;
}

const FEES = { takerRate: 0.02, makerRate: 0 };

function input(compiledScript: string, snapshots: BookSnapshot[], tokenIds = ['t1', 't2']): SnapshotSimulationInput {
  return {
    source: 'polymarket-snapshots',
    compiledScript,
    snapshots,
    tokenIds,
    initialBalance: 100,
    config: {},
    runId: 'r1',
    fees: Object.fromEntries(tokenIds.map((t) => [t, FEES])),
    defaultFees: FEES,
  };
}

const SERIES: BookSnapshot[] = [
  snap('t1', 1000, [[0.38, 100]], [[0.4, 100]]),
  snap('t1', 2000, [[0.43, 100]], [[0.45, 100]]),
  snap('t2', 2500, [[0.2, 100]], [[0.22, 100]]),
  snap('t1', 3000, [[0.48, 100]], [[0.5, 100]]),
  snap('t2', 3500, [[0.25, 100]], [[0.27, 100]]),
];

describe('snapshot backtest', () => {
  it('groups one recorder cycle per step', () => {
    expect(groupSteps(SERIES).map((s) => s.map((x) => `${x.tokenId}@${x.ts}`))).toEqual([['t1@1000'], ['t1@2000', 't2@2500'], ['t1@3000', 't2@3500']]);
  });

  it('the bot only sees snapshots with ts ≤ sim time (no look-ahead)', async () => {
    const code = await compile(`
      export async function onTick(ctx) {
        await ctx.buy('t1', 1);
        try {
          await ctx.getOrderBook('t2');
          await ctx.buy('t2', 1);
        } catch (e) {
          // t2 has no snapshot yet at this sim time
        }
      }
    `);
    const out = await runSnapshotSimulation(input(code, SERIES));
    expect(out.trades.map((t) => [t.symbol, t.timestamp, Math.round(t.price * 1e6) / 1e6])).toEqual([
      ['t1', 1000, 0.4],
      ['t1', 2500, 0.45],
      ['t2', 2500, 0.22],
      ['t1', 3500, 0.5],
      ['t2', 3500, 0.27],
    ]);
    expect(out.feesPaid).toBeCloseTo(5 * 0.02);
    expect(out.steps).toBe(3);
  });

  it('resting post-only orders fill only when a later snapshot trades through, at their price', () => {
    const m = new SnapshotMarket(100, () => FEES);
    m.applyStep([snap('t1', 1000, [[0.4, 50]], [[0.5, 50]])]);
    expect(m.placeLimit('t1', 'buy', 0.5, 10)).toMatchObject({ ok: false, failedCheck: 'post_only' }); // would cross
    const buy = m.placeLimit('t1', 'buy', 0.45, 10);
    expect(buy).toMatchObject({ ok: true, status: 'open' });
    expect(m.freeCash()).toBeCloseTo(95.5); // reserved

    m.applyStep([snap('t1', 2000, [[0.41, 50]], [[0.47, 50]])]);
    expect(m.openOrders()).toHaveLength(1); // ask 0.47 > 0.45: no fill

    m.applyStep([snap('t1', 3000, [[0.42, 50]], [[0.45, 50]])]);
    expect(m.openOrders()).toHaveLength(0);
    expect(m.trades).toEqual([expect.objectContaining({ side: 'BUY', price: 0.45, quantity: 10, timestamp: 3000 })]);
    expect(m.cash).toBeCloseTo(95.5); // maker fee 0

    const sell = m.placeLimit('t1', 'sell', 0.55, 10);
    expect(sell.ok).toBe(true);
    expect(m.placeLimit('t1', 'sell', 0.6, 1)).toMatchObject({ ok: false, error: 'Insufficient position' }); // shares reserved
    m.applyStep([snap('t1', 4000, [[0.54, 50]], [[0.56, 50]])]);
    expect(m.openOrders()).toHaveLength(1);
    m.applyStep([snap('t1', 5000, [[0.55, 50]], [[0.57, 50]])]);
    expect(m.openOrders()).toHaveLength(0);
    expect(m.cash).toBeCloseTo(95.5 + 5.5);
  });

  it('a resting fill uses up the recorded depth it filled against within the step', () => {
    const m = new SnapshotMarket(100, () => FEES);
    m.applyStep([snap('t1', 1000, [[0.4, 50]], [[0.5, 50]])]);
    m.placeLimit('t1', 'buy', 0.45, 10);
    m.applyStep([snap('t1', 2000, [[0.4, 50]], [[0.45, 10], [0.6, 50]])]);
    expect(m.openOrders()).toHaveLength(0);
    expect(m.marketable('t1', 'buy', 1, { maxPrice: 0.45 })).toMatchObject({ success: false }); // 0.45 level consumed
    expect(m.orderBook('t1').asks).toEqual([{ price: '0.6', size: '50' }]);
  });

    it('resting orders expire after their TTL', () => {
    const m = new SnapshotMarket(100, () => FEES, 1);
    m.applyStep([snap('t1', 0, [[0.4, 50]], [[0.5, 50]])]);
    m.placeLimit('t1', 'buy', 0.45, 10, { ttlMinutes: 30 }); // capped at 1 minute
    m.applyStep([snap('t1', 61_000, [[0.4, 50]], [[0.44, 50]])]);
    expect(m.trades).toEqual([]);
    expect(m.freeCash()).toBe(100);
  });

  it('marketable orders walk the recorded depth, fill-or-kill, and consume it within the step', () => {
    const m = new SnapshotMarket(100, () => FEES);
    m.applyStep([snap('t1', 1000, [[0.4, 50]], [[0.5, 10], [0.52, 10], [0.6, 100]])]);
    expect(m.marketable('t1', 'buy', 20, { maxPrice: 0.55 })).toMatchObject({ success: false }); // only $10.2 within 0.55
    const r = m.marketable('t1', 'buy', 10.2, { maxPrice: 0.55 });
    expect(r).toMatchObject({ success: true, tokenAmount: 20 });
    expect(r.price).toBeCloseTo(0.51);
    expect(m.cash).toBeCloseTo(100 - 10.2 * 1.02);
    expect(m.marketable('t1', 'buy', 1, { maxPrice: 0.55 })).toMatchObject({ success: false }); // that depth is gone
  });

  it('is deterministic', async () => {
    const code = await compile(`
      export async function onTick(ctx) {
        const p = await ctx.getMarketPrice('t1');
        if (p.ask < 0.46) await ctx.buy('t1', 5);
        else await ctx.polymarket.placeLimit('t1', 'sell', 0.49, 1, { ttlMinutes: 60 });
      }
    `);
    const a = await runSnapshotSimulation(input(code, SERIES));
    const b = await runSnapshotSimulation(input(code, SERIES));
    expect(a).toEqual(b);
    expect(a.trades.length).toBeGreaterThan(0);
  });
});

describe('BacktestEngine with polymarket-snapshots', () => {
  let workerPath: string;
  beforeAll(async () => {
    workerPath = await buildWorker(path.join(ROOT, 'electron', 'backtest', 'backtest-worker.ts'));
  }, 30_000);

  it('replays snapshots in the sandboxed worker and stores trades', async () => {
    const trades: Array<Record<string, unknown>> = [];
    const repo = {
      createRun: vi.fn(() => ({ id: 'run-1' })),
      addTrade: vi.fn((t: Record<string, unknown>) => trades.push(t)),
      getTradesForRun: vi.fn(() => trades.map((t) => ({ ...t, balance_after: t.balanceAfter }))),
      updateRun: vi.fn(),
    };
    const loadSnapshots = vi.fn(() => SERIES);
    const engine = new BacktestEngine({
      db: { transaction: (fn: () => void) => fn } as never,
      backtestRepo: repo as never,
      compiledScript: await compile(`export async function onTick(ctx) { if (ctx.now === 1000) await ctx.buy('t1', 10); }`),
      symbol: '',
      interval: '1h',
      startTime: 0,
      endTime: 10_000,
      initialBalance: 100,
      config: {},
      scriptId: 's',
      scriptName: 's',
      source: 'polymarket-snapshots',
      tokenIds: ['t1', 't2'],
      loadSnapshots,
      getFeeRates: () => FEES,
      workerPath,
      timeoutMs: 10_000,
    });
    const r = await engine.run();
    expect(r.status).toBe('completed');
    expect(loadSnapshots).toHaveBeenCalledWith(['t1', 't2'], 0, 10_000);
    expect(repo.createRun).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'polymarket:t1,t2', interval: 'snapshots' }));
    expect(trades).toHaveLength(1);
    expect(r.stats.klinesProcessed).toBe(3);
    // 25 shares bought for $10.20 incl. fee, marked at the last mid 0.49
    expect(r.stats.finalBalance).toBeCloseTo(100 - 10.2 + 25 * 0.49);
  });
});
