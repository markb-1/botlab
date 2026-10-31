import { describe, it, expect } from 'vitest';
import { computeDailyPnl, utcDayStart, type PnlFill } from '../../electron/risk/dailyPnl';

const DAY_START = Date.parse('2026-06-02T00:00:00Z');
const YESTERDAY = DAY_START - 6 * 3_600_000;
const TODAY = DAY_START + 3_600_000;

const fill = (symbol: string, side: 'BUY' | 'SELL', quantity: number, price: number, at: number, feeUsd = 0): PnlFill => ({
  exchange: 'polymarket',
  symbol,
  side,
  quantity,
  quoteAmount: quantity * price,
  feeUsd,
  executedAt: at,
});

describe('utcDayStart', () => {
  it('returns 00:00 UTC of the same day', () => {
    expect(utcDayStart(Date.parse('2026-06-02T23:59:59.999Z'))).toBe(DAY_START);
    expect(utcDayStart(DAY_START)).toBe(DAY_START);
  });
});

describe('computeDailyPnl', () => {
  // A: 100 held from yesterday at avg 0.40; day-start mark 0.50; today sell 40 @ 0.60 (fee 0.5); now 0.55
  // B: bought today 50 @ 0.20; now 0.10
  const fills = [
    fill('A', 'BUY', 100, 0.4, YESTERDAY),
    fill('A', 'SELL', 40, 0.6, TODAY, 0.5),
    fill('B', 'BUY', 50, 0.2, TODAY + 1000),
  ];
  const dayStartMarks = { 'polymarket:A': 0.5 };

  it('realized today + change in mark-to-market since the day start, multiple positions', () => {
    const r = computeDailyPnl({
      fills,
      dayStartMs: DAY_START,
      dayStartMarks,
      currentMarks: { 'polymarket:A': 0.55, 'polymarket:B': 0.1 },
      lastKnownMarks: {},
    });
    // A: 60×0.55 − 100×0.50 + 24 = 7; B: 50×0.10 − 10 = −5; fees −0.5
    expect(r.totalPnl).toBeCloseTo(1.5);
    // Realized: 24 − 40×0.40 − 0.5
    expect(r.realizedPnl).toBeCloseTo(7.5);
    expect(r.unrealizedChange).toBeCloseTo(-6);
    expect(r.dayStartValue).toBeCloseTo(50);
    // All-time: realized 8 + unrealized (60×0.55 − 24) + (5 − 10) − fees 0.5
    expect(r.cumulativePnl).toBeCloseTo(11.5);
    expect(r.staleMarks).toEqual([]);
    expect(r.positions.find((p) => p.key === 'polymarket:A')).toMatchObject({ qtyStart: 100, qtyNow: 60 });
  });

  it('is order-independent (fills are sorted by time)', () => {
    const a = computeDailyPnl({ fills, dayStartMs: DAY_START, dayStartMarks, currentMarks: { 'polymarket:A': 0.55, 'polymarket:B': 0.1 }, lastKnownMarks: {} });
    const b = computeDailyPnl({
      fills: [...fills].reverse(),
      dayStartMs: DAY_START,
      dayStartMarks,
      currentMarks: { 'polymarket:A': 0.55, 'polymarket:B': 0.1 },
      lastKnownMarks: {},
    });
    expect(b.totalPnl).toBeCloseTo(a.totalPnl);
    expect(b.realizedPnl).toBeCloseTo(a.realizedPnl);
  });

  it('missing current price: uses the last known mark and reports it as stale', () => {
    const r = computeDailyPnl({
      fills,
      dayStartMs: DAY_START,
      dayStartMarks,
      currentMarks: { 'polymarket:A': null, 'polymarket:B': 0.1 },
      lastKnownMarks: { 'polymarket:A': 0.45 },
    });
    // A now valued at 0.45: 27 − 50 + 24 = 1; B −5; fees −0.5
    expect(r.totalPnl).toBeCloseTo(-4.5);
    expect(r.staleMarks).toEqual(['polymarket:A']);
    expect(r.positions.find((p) => p.key === 'polymarket:A')?.markNowSource).toBe('last_known');
  });

  it('no price at all: falls back to day-start mark, then cost, always flagged stale', () => {
    const r = computeDailyPnl({
      fills,
      dayStartMs: DAY_START,
      dayStartMarks,
      currentMarks: {},
      lastKnownMarks: {},
    });
    const a = r.positions.find((p) => p.key === 'polymarket:A')!;
    const b = r.positions.find((p) => p.key === 'polymarket:B')!;
    expect(a).toMatchObject({ markNowSource: 'day_start', markNow: 0.5 });
    expect(b).toMatchObject({ markNowSource: 'cost', markNow: 0.2 });
    expect(r.staleMarks).toEqual(['polymarket:A', 'polymarket:B']);
    // A: 60×0.5 − 50 + 24 = 4; B: 10 − 10 = 0; fees −0.5
    expect(r.totalPnl).toBeCloseTo(3.5);
  });

  it('missing day-start mark: cost basis at the day start, never the moving last-known mark', () => {
    const r = computeDailyPnl({
      fills: [fill('A', 'BUY', 100, 0.4, YESTERDAY)],
      dayStartMs: DAY_START,
      dayStartMarks: {},
      currentMarks: { 'polymarket:A': 0.3 },
      lastKnownMarks: { 'polymarket:A': 0.3 },
    });
    expect(r.totalPnl).toBeCloseTo(100 * (0.3 - 0.4));
    expect(r.positions[0].markStartSource).toBe('cost');
    expect(r.staleMarks).toEqual(['polymarket:A']);
  });

  it('reviewer case: 1000 bought at 0.60, no mark at 00:00, now 0.30 ⇒ about −300', () => {
    const r = computeDailyPnl({
      fills: [fill('A', 'BUY', 1000, 0.6, YESTERDAY)],
      dayStartMs: DAY_START,
      dayStartMarks: {},
      currentMarks: { 'polymarket:A': 0.3 },
      lastKnownMarks: { 'polymarket:A': 0.3 },
    });
    expect(r.totalPnl).toBeCloseTo(-300);
  });

  it('selling more than the recorded holding: the excess contributes zero P&L', () => {
    const r = computeDailyPnl({
      fills: [fill('A', 'BUY', 10, 0.5, TODAY), fill('A', 'SELL', 30, 0.5, TODAY + 1)],
      dayStartMs: DAY_START,
      dayStartMarks: {},
      currentMarks: {},
      lastKnownMarks: {},
    });
    expect(r.totalPnl).toBeCloseTo(0);
    expect(r.realizedPnl).toBeCloseTo(0);
    expect(r.cumulativePnl).toBeCloseTo(0);
  });

  it('a pure price drop on a held position is a loss even with no trades today', () => {
    const r = computeDailyPnl({
      fills: [fill('A', 'BUY', 200, 0.5, YESTERDAY)],
      dayStartMs: DAY_START,
      dayStartMarks: { 'polymarket:A': 0.5 },
      currentMarks: { 'polymarket:A': 0.2 },
      lastKnownMarks: {},
    });
    expect(r.totalPnl).toBeCloseTo(-60);
    expect(r.realizedPnl).toBe(0);
    expect(r.unrealizedChange).toBeCloseTo(-60);
  });

  it('positions closed before today contribute nothing; a round trip today is pure realized', () => {
    const r = computeDailyPnl({
      fills: [
        fill('A', 'BUY', 10, 0.5, YESTERDAY - 1000),
        fill('A', 'SELL', 10, 0.7, YESTERDAY),
        fill('B', 'BUY', 10, 0.5, TODAY),
        fill('B', 'SELL', 10, 0.3, TODAY + 1),
      ],
      dayStartMs: DAY_START,
      dayStartMarks: {},
      currentMarks: {},
      lastKnownMarks: {},
    });
    expect(r.totalPnl).toBeCloseTo(-2);
    expect(r.realizedPnl).toBeCloseTo(-2);
    expect(r.positions).toHaveLength(0);
    expect(r.staleMarks).toEqual([]);
  });
});
