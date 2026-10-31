/**
 * Backtests run in a sandboxed worker with an overall timeout (spec §5.1).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import path from 'path';

const klines = Array.from({ length: 5 }, (_, i) => ({
  openTime: 1_700_000_000_000 + i * 3_600_000,
  open: 100 + i,
  high: 101 + i,
  low: 99 + i,
  close: 100 + i,
  volume: 1000,
  closeTime: 1_700_000_000_000 + (i + 1) * 3_600_000 - 1,
}));

vi.mock('../../electron/backtest/klineCache', () => ({
  fetchKlines: vi.fn(async () => klines),
}));

import { BacktestEngine } from '../../electron/backtest/BacktestEngine';
import { compileScript } from '../../electron/runtime/compileScript';
import { buildWorker, ROOT } from './buildWorker';
import { escapeProbe } from './escapeProbe';

function fakeRepo() {
  const trades: Array<Record<string, unknown>> = [];
  return {
    trades,
    updates: [] as Array<Record<string, unknown>>,
    createRun: vi.fn(() => ({ id: 'run-1' })),
    addTrade: vi.fn((t: Record<string, unknown>) => trades.push(t)),
    getTradesForRun: vi.fn(() => trades.map((t) => ({ ...t, balance_after: t.balanceAfter }))),
    updateRun: vi.fn(),
  };
}

const fakeDb = { transaction: (fn: () => void) => fn } as never;

async function compile(src: string): Promise<string> {
  const r = await compileScript(src);
  if ('error' in r) throw new Error(r.error);
  return r.code;
}

describe('BacktestEngine worker', () => {
  let workerPath: string;

  beforeAll(async () => {
    workerPath = await buildWorker(path.join(ROOT, 'electron', 'backtest', 'backtest-worker.ts'));
  }, 30_000);

  function engine(compiledScript: string, repo: ReturnType<typeof fakeRepo>, timeoutMs = 2000) {
    return new BacktestEngine({
      db: fakeDb,
      backtestRepo: repo as never,
      compiledScript,
      symbol: 'BTCUSDT',
      interval: '1h',
      startTime: klines[0].openTime,
      endTime: klines[4].closeTime,
      initialBalance: 1000,
      config: {},
      scriptId: 's1',
      scriptName: 'test',
      workerPath,
      timeoutMs,
    });
  }

  it('runs a script and records its trades', async () => {
    const code = await compile(`
      let bought = false;
      export async function onTick(ctx) {
        if (!bought) { bought = true; await ctx.binance.buy('BTCUSDT', 100); }
      }
    `);
    const repo = fakeRepo();
    const result = await engine(code, repo).run();
    expect(result.status).toBe('completed');
    expect(result.stats.klinesProcessed).toBe(5);
    expect(repo.trades).toHaveLength(1);
    expect(repo.trades[0]).toMatchObject({ runId: 'run-1', side: 'BUY', symbol: 'BTCUSDT' });
  });

  it('times out an infinite loop without blocking the main thread', async () => {
    const code = await compile('export function onTick(ctx) { while (true) {} }');
    const repo = fakeRepo();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const started = Date.now();
    const result = await engine(code, repo, 500).run();
    clearInterval(timer);
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(ticks).toBeGreaterThan(5); // the main event loop kept running
    expect(repo.updateRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'error' }));
  });

  it('gives the script no require or process and closes the known escapes', async () => {
    // The probe throws its results from onStart; onStart errors are logged, so report through a trade-free path:
    // onTick throws if anything escaped, which shows up as a tick error.
    const code = escapeProbe(
      "globalThis.__escaped = Object.keys(results).filter((k) => results[k] === 'ESCAPED' || !/^(blocked|nothing)/.test(results[k]));"
    ).replace(
      'module.exports.onTick = async function (ctx) {};',
      "module.exports.onTick = async function (ctx) { if (!globalThis.__escaped) throw new Error('probe did not run'); if (globalThis.__escaped.length) throw new Error('escaped: ' + globalThis.__escaped.join(',')); };"
    );
    const result = await engine(code, fakeRepo()).run();
    expect(result.status).toBe('completed');
    expect(result.stats.firstTickError).toBeUndefined();
    expect(result.stats.tickErrors).toBe(0);
  });
});
