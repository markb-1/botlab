/**
 * Copy-trading sell hotfix (spec §9.5 row 1): ctx.sell takes tokens, not USD.
 * Tests the template's own sizing function and the sell path with a fake ctx.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { compileScript } from '../../packages/core/src/runtime/compileScript';
import { evaluateScript } from '../../packages/core/src/runtime/sandbox';

type SellSize = (p: {
  heldTokens: number;
  leaderSoldTokens?: number | null;
  leaderRemainingTokens?: number | null;
  copyUsd: number;
  price?: number | null;
}) => { tokens: number; basis: string; reason?: string };

let copySellSize: SellSize;
let compiled: string;

beforeAll(async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'copy-trading.ts'), 'utf-8');
  const r = await compileScript(source);
  if ('error' in r) throw new Error(r.error);
  compiled = r.code;
  copySellSize = evaluateScript(compiled, {}).copySellSize as SellSize;
});

describe('copySellSize', () => {
  it('mirrors the fraction of their position the leader sold', () => {
    // Leader sold 40 of 100 ⇒ we sell 40% of our 50
    expect(copySellSize({ heldTokens: 50, leaderSoldTokens: 40, leaderRemainingTokens: 60, copyUsd: 5, price: 0.5 }))
      .toEqual({ tokens: 20, basis: 'fraction' });
  });

  it('sells everything when the leader exited completely', () => {
    expect(copySellSize({ heldTokens: 33.337, leaderSoldTokens: 10, leaderRemainingTokens: 0, copyUsd: 1, price: 0.5 }))
      .toEqual({ tokens: 33.33, basis: 'fraction' });
  });

  it('falls back to USD / price when the leader fraction is unknown', () => {
    expect(copySellSize({ heldTokens: 100, leaderSoldTokens: 40, leaderRemainingTokens: null, copyUsd: 10, price: 0.4 }))
      .toEqual({ tokens: 25, basis: 'usd' });
  });

  it('never sells more than held', () => {
    expect(copySellSize({ heldTokens: 12, leaderRemainingTokens: null, copyUsd: 50, price: 0.5 })).toEqual({ tokens: 12, basis: 'usd' });
  });

  it('sells nothing without a position or a usable price', () => {
    expect(copySellSize({ heldTokens: 0, leaderSoldTokens: 10, leaderRemainingTokens: 0, copyUsd: 5, price: 0.5 }).tokens).toBe(0);
    expect(copySellSize({ heldTokens: 10, leaderRemainingTokens: null, copyUsd: 5, price: 0 })).toMatchObject({ tokens: 0, basis: 'none' });
  });
});

describe('copy-trading template sell path', () => {
  it('only copies TRADE rows and passes tokens (not USD) to ctx.sell', async () => {
    const now = Date.now();
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    let interval: (() => Promise<void>) | null = null;
    const activity = [
      // newest first, as the API returns them
      { type: 'TRADE', side: 'SELL', asset: 'tok', conditionId: '0xc', size: 30, usdcSize: 15, price: 0.5, timestamp: Math.floor(now / 1000) - 5 },
      { type: 'REDEEM', side: '', asset: 'tok2', conditionId: '0xd', size: 100, usdcSize: 100, timestamp: Math.floor(now / 1000) - 6 },
    ];
    const ctx = {
      config: { traders: ['0xleader'], pollingIntervalMs: 1000, baseMultiplier: 0.1 },
      now,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
      storage: { get: async () => null, set: async () => undefined },
      getBalance: async () => 100,
      getPositions: async () => [{ tokenId: 'tok', size: 80, currentValue: 40 }],
      getMarketPrice: async () => ({ bid: 0.5, ask: 0.52, mid: 0.51, spread: 0.02 }),
      fetch: async (url: string) => {
        calls.push({ fn: 'fetch', args: [url] });
        const body = url.includes('/activity') ? activity : [{ asset: 'tok', size: 90 }]; // leader keeps 90 after selling 30
        return { ok: true, status: 200, json: async () => body };
      },
      buy: async (...args: unknown[]) => {
        calls.push({ fn: 'buy', args });
        return { success: true, executedAmount: 1, price: 0.5 };
      },
      sell: async (...args: unknown[]) => {
        calls.push({ fn: 'sell', args });
        return { success: true, executedAmount: 10, price: 0.5 };
      },
      emit: () => undefined,
      setInterval: (fn: () => Promise<void>) => {
        interval = fn;
        return 'i1';
      },
    };
    const mod = evaluateScript(compiled, ctx);
    await (mod.onStart as (c: unknown) => Promise<void>)(ctx);
    expect(interval).not.toBeNull();
    await interval!();

    const sells = calls.filter((c) => c.fn === 'sell');
    expect(sells).toHaveLength(1);
    // Leader sold 30 of 120 (25%) ⇒ 25% of our 80 tokens
    expect(sells[0].args).toEqual(['tok', 20]);
    expect(calls.filter((c) => c.fn === 'buy')).toHaveLength(0);
    expect(calls.some((c) => c.fn === 'fetch' && String(c.args[0]).includes('/positions?user=0xleader&market=0xc'))).toBe(true);
  });

  it('same-second rows: later trades in the batch are found by index after the oldest-first reorder', async () => {
    const now = Date.now();
    const ts = Math.floor(now / 1000) - 5;
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    let interval: (() => Promise<void>) | null = null;
    // Newest first, same second: the leader sold 30, then bought 10 back; they now hold 90
    const activity = [
      { type: 'TRADE', side: 'BUY', asset: 'tok', conditionId: '0xc', size: 10, usdcSize: 5, price: 0.5, timestamp: ts },
      { type: 'TRADE', side: 'SELL', asset: 'tok', conditionId: '0xc', size: 30, usdcSize: 15, price: 0.5, timestamp: ts },
    ];
    const ctx = {
      config: { traders: ['0xleader'], pollingIntervalMs: 1000, baseMultiplier: 0.1 },
      now,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
      storage: { get: async () => null, set: async () => undefined },
      getBalance: async () => 100,
      getPositions: async () => [{ tokenId: 'tok', size: 80, currentValue: 40 }],
      getMarketPrice: async () => ({ bid: 0.5, ask: 0.52, mid: 0.51, spread: 0.02 }),
      fetch: async (url: string) => ({ ok: true, status: 200, json: async () => (url.includes('/activity') ? activity : [{ asset: 'tok', conditionId: '0xc', size: 90 }]) }),
      buy: async (...args: unknown[]) => {
        calls.push({ fn: 'buy', args });
        return { success: true, executedAmount: 1, price: 0.5 };
      },
      sell: async (...args: unknown[]) => {
        calls.push({ fn: 'sell', args });
        return { success: true, executedAmount: 10, price: 0.5 };
      },
      emit: () => undefined,
      setInterval: (fn: () => Promise<void>) => {
        interval = fn;
        return 'i1';
      },
    };
    const mod = evaluateScript(compiled, ctx);
    await (mod.onStart as (c: unknown) => Promise<void>)(ctx);
    await interval!();
    // Sell processed first; leader held 90 - 10 = 80 right after it ⇒ sold 30 of 110 ⇒ 80 × 30/110 = 21.81
    expect(calls.map((c) => c.fn)).toEqual(['sell', 'buy']);
    expect(calls[0].args).toEqual(['tok', 21.81]);
  });
});
