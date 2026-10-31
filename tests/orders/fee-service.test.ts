import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigError } from '../../packages/core/src/config';
import { DEFAULT_FEES_YAML, FeeService, FeesSchema, loadFees } from '../../packages/core/src/orders/FeeService';
import {
  feeForFill,
  parseMarketFeeSchedule,
  parseStoredFeeSchedule,
  ratesFromSchedule,
  takerFeePerShare,
  type FeeRates,
} from '../../packages/core/src/orders/feeModel';

describe('FeeService', () => {
  it('defaults match the spec table and config/fees.example.yaml', () => {
    const fees = FeesSchema.parse({});
    expect(fees.taker_rates).toEqual({
      crypto: 0.07, sports: 0.05, finance: 0.04, politics: 0.04, tech: 0.04, mentions: 0.04,
      economics: 0.05, culture: 0.05, weather: 0.05, other: 0.05, geopolitics: 0,
    });
    expect(fees.maker_rate).toBe(0);

    const example = fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'fees.example.yaml'), 'utf8');
    expect(example.replace(/\r\n/g, '\n')).toBe(DEFAULT_FEES_YAML);
  });

  it('rejects unknown categories, out-of-range rates and typos', () => {
    expect(FeesSchema.safeParse({ taker_rates: { crypto: 1.5 } }).success).toBe(false);
    expect(FeesSchema.safeParse({ taker_rates: { crypt: 0.07 } }).success).toBe(false);
    expect(FeesSchema.safeParse({ maker_rate: -0.01 }).success).toBe(false);
  });

  it('loads fees.yaml, writing defaults when missing; invalid file throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-fees-'));
    try {
      expect(loadFees(dir).taker_rates.crypto).toBe(0.07);
      expect(fs.existsSync(path.join(dir, 'fees.yaml'))).toBe(true);
      fs.writeFileSync(path.join(dir, 'fees.yaml'), 'taker_rates:\n  sports: 0.02\n');
      expect(loadFees(dir).taker_rates.sports).toBe(0.02);
      fs.writeFileSync(path.join(dir, 'fees.yaml'), 'maker_rate: lots\n');
      expect(() => loadFees(dir)).toThrow(ConfigError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps market labels to fee categories; unknown ⇒ highest taker rate', () => {
    const svc = new FeeService();
    expect(svc.feeCategoryFor(['Economics'])).toBe('economics');
    expect(svc.feeCategoryFor(['Politics', 'Geopolitics'])).toBe('geopolitics');
    expect(svc.feeCategoryFor(['Pop Culture'])).toBe('culture');
    expect(svc.feeCategoryFor(['NBA', 'Sports'])).toBe('sports');
    expect(svc.feeCategoryFor(['Something new'])).toBeNull();
    expect(svc.getRates('geopolitics')).toEqual({ takerRate: 0, makerRate: 0, formula: 'price', source: 'category' });
    expect(svc.getRates(null)).toMatchObject({ takerRate: 0.07, source: 'unknown' });
  });

  it("prefers the market's own schedule; falls back to the category table only when it has none", () => {
    const svc = new FeeService();
    const sched = parseMarketFeeSchedule({ feesEnabled: true, feeType: 'sports_fees_v3', feeSchedule: { rate: 0.05, exponent: 1, takerOnly: true, rebateRate: 0.25 } });
    expect(svc.ratesFor(sched, 'politics')).toMatchObject({ takerRate: 0.05, makerRate: 0, formula: 'price', source: 'market', feeType: 'sports_fees_v3' });
    expect(svc.ratesFor(null, 'politics')).toMatchObject({ takerRate: 0.04, formula: 'price', source: 'category' });
    expect(svc.ratesFor(null, 'sports').takerRate).toBe(0.05);
    expect(svc.ratesFor(null, null)).toMatchObject({ takerRate: 0.07, source: 'unknown' });
  });
});

describe('Polymarket fee model', () => {
  const r = (takerRate: number): FeeRates => ({ takerRate, makerRate: 0, formula: 'price', source: 'market' });

  it('matches the live data points: fee = shares × rate × p × (1 − p), in USDC', () => {
    // Live position (TEST-REPORT-MAC.md): 45.2353 shares at 0.5526 in a 7 % market ⇒ entryFeesUsdc 0.78283
    expect(feeForFill(r(0.07), 45.2353, 45.2353 * 0.5526, true)).toBeCloseTo(0.78283, 4); // 0.782857 before Polymarket's rounding
    // 15.625 shares at 0.32 ⇒ 0.238
    expect(feeForFill(r(0.07), 15.625, 15.625 * 0.32, true)).toBeCloseTo(0.238, 3);
    expect(takerFeePerShare(r(0.07), 0.5526)).toBeCloseTo(0.07 * 0.5526 * 0.4474, 12);
  });

  it('makers pay 0; zero_fees markets pay 0', () => {
    expect(feeForFill(r(0.07), 100, 50, false)).toBe(0);
    const zero = parseMarketFeeSchedule({ feesEnabled: false, feeType: 'zero_fees' })!;
    expect(zero).toMatchObject({ rate: 0, from: 'zero' });
    expect(feeForFill(ratesFromSchedule(zero), 100, 50, true)).toBe(0);
  });

  it('parses Gamma fee fields (JSON-string schedule, exponent 2 ⇒ conservative, legacy takerBaseFee bps, nothing ⇒ null)', () => {
    const s = parseMarketFeeSchedule({ feesEnabled: true, feeType: 'politics_fees', feeSchedule: JSON.stringify({ rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 }) })!;
    expect(s).toEqual({ feesEnabled: true, feeType: 'politics_fees', rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25, from: 'feeSchedule' });
    expect(parseStoredFeeSchedule(JSON.stringify(s))).toEqual(s);

    const exp2 = ratesFromSchedule(parseMarketFeeSchedule({ feesEnabled: true, feeSchedule: { rate: 0.25, exponent: 2, takerOnly: true } })!);
    expect(exp2.formula).toBe('notional');
    expect(feeForFill(exp2, 10, 5, true)).toBeCloseTo(0.25 * 5); // rate × notional

    const legacy = parseMarketFeeSchedule({ takerBaseFee: 200 })!;
    expect(legacy).toMatchObject({ rate: 0.02, from: 'legacy' });
    expect(ratesFromSchedule(legacy).formula).toBe('notional');

    // A fee-free flag next to a positive schedule rate takes the rate (conservative)
    expect(parseMarketFeeSchedule({ feesEnabled: false, feeSchedule: { rate: 0.05 } })!.rate).toBe(0.05);
    // takerOnly: false ⇒ makers charged too
    expect(ratesFromSchedule(parseMarketFeeSchedule({ feeSchedule: { rate: 0.05, takerOnly: false } })!).makerRate).toBe(0.05);
    expect(parseMarketFeeSchedule({ feesEnabled: true })).toBeNull();
    expect(parseMarketFeeSchedule({ takerBaseFee: 0 })).toBeNull();
    expect(parseMarketFeeSchedule({})).toBeNull();
    expect(parseStoredFeeSchedule('{"rate":2,"from":"feeSchedule"}')).toBeNull();
  });
});
