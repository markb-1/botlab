/**
 * Polymarket fee model (pure; used by FeeService, OrderService, RiskEngine, Reconciler, backtests).
 *
 * Polymarket docs (docs.polymarket.com/trading/fees, checked in docs/TEST-REPORT-MAC.md against a live
 * position's `entryFeesUsdc`):
 *
 *   taker fee (USDC) = C × feeRate × p × (1 − p)      C = shares, p = price
 *
 * charged in USDC on top of the trade (shares are not reduced); makers never pay. Live check:
 * 45.2353 shares at 0.5526 with rate 0.07 ⇒ 0.78283; 15.625 at 0.32 ⇒ 0.238.
 *
 * Markets carry their own schedule in Gamma (`feesEnabled`, `feeType`, `feeSchedule {rate, exponent,
 * takerOnly, rebateRate}`, legacy `takerBaseFee`). `exponent: 2` (seen on some old crypto markets with
 * rate 0.25) is not covered by the current docs, so those use the conservative `rate × notional`
 * (PROGRESS Decision R125).
 */

/**
 * - `price`: fee per share = rate × p × (1 − p) (the documented formula, exponent 1)
 * - `notional`: fee per share = rate × p (conservative upper bound; unknown exponents / legacy fields)
 */
export type FeeFormula = 'price' | 'notional';

export interface FeeRates {
  /** Taker rate (`feeRate` in the docs formula) */
  takerRate: number;
  /** Maker rate (0 unless a market's schedule says fees are not taker-only) */
  makerRate: number;
  formula: FeeFormula;
  /** Where the rates came from: the market's own Gamma schedule, the category table, or unknown market (highest rate) */
  source: 'market' | 'category' | 'unknown';
  /** Gamma `feeType` when known (e.g. `zero_fees`, `sports_fees_v3`) */
  feeType?: string | null;
}

/** A market's fee schedule as published by Gamma (stored in market_cache.fee_schedule as JSON). */
export interface MarketFeeSchedule {
  feesEnabled: boolean | null;
  feeType: string | null;
  /** Taker rate; 0 for fee-free markets */
  rate: number;
  /** null when Gamma gave none (treated as 1) */
  exponent: number | null;
  takerOnly: boolean;
  /** Maker rebate (informational; rebates are never counted, which keeps fees conservative) */
  rebateRate: number | null;
  /** `feeSchedule`: from Gamma's feeSchedule; `legacy`: from takerBaseFee (bps); `zero`: fee-free market */
  from: 'feeSchedule' | 'legacy' | 'zero';
}

const clamp01 = (p: number) => (p < 0 ? 0 : p > 1 ? 1 : p);

/** Taker fee per share at `price`. */
export function takerFeePerShare(rates: Pick<FeeRates, 'takerRate' | 'formula'>, price: number): number {
  if (!Number.isFinite(price) || rates.takerRate <= 0) return 0;
  const p = clamp01(price);
  return rates.formula === 'price' ? rates.takerRate * p * (1 - p) : rates.takerRate * p;
}

/** Fee per share for a taker or maker fill. */
export function feePerShare(rates: FeeRates, price: number, taker: boolean): number {
  if (taker) return takerFeePerShare(rates, price);
  return takerFeePerShare({ takerRate: rates.makerRate, formula: rates.formula }, price);
}

/**
 * Fee in USD for a fill of `shares` worth `notional` USD. The average price (notional / shares) is used;
 * since p(1 − p) is concave, this never understates the sum over several price levels.
 */
export function feeForFill(rates: FeeRates, shares: number, notional: number, taker: boolean): number {
  if (!(shares > 0) || !(notional > 0)) return 0;
  return shares * feePerShare(rates, notional / shares, taker);
}

/** How a fill is charged: the market's rates and whether the fill took liquidity. */
export interface AppliedFee {
  rates: FeeRates;
  taker: boolean;
}

export function appliedFeeUsd(fee: AppliedFee | null | undefined, shares: number, notional: number): number {
  return fee ? feeForFill(fee.rates, shares, notional, fee.taker) : 0;
}

/** Rates from a market's own schedule. */
export function ratesFromSchedule(s: MarketFeeSchedule): FeeRates {
  const exponentOne = s.exponent === null || s.exponent === 1;
  const formula: FeeFormula = s.from === 'feeSchedule' && exponentOne ? 'price' : s.from === 'zero' ? 'price' : 'notional';
  return {
    takerRate: s.rate,
    makerRate: s.takerOnly ? 0 : s.rate,
    formula,
    source: 'market',
    feeType: s.feeType,
  };
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Parse a Gamma market's fee fields; null when it carries nothing usable (⇒ category table).
 *
 * - `feeSchedule.rate` (0–1) wins; its `exponent` / `takerOnly` / `rebateRate` are kept.
 * - No schedule: `feesEnabled: false` or `feeType: "zero_fees"` ⇒ fee-free; a positive legacy
 *   `takerBaseFee` (basis points) ⇒ that rate with the conservative notional formula.
 * - Contradictions (a fee-free flag next to a positive rate) take the positive rate.
 */
export function parseMarketFeeSchedule(raw: unknown): MarketFeeSchedule | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const feesEnabled = typeof m.feesEnabled === 'boolean' ? m.feesEnabled : null;
  const feeType = typeof m.feeType === 'string' && m.feeType ? m.feeType : null;
  const sched = obj(m.feeSchedule);
  const rate = sched ? num(sched.rate) : null;
  if (sched && rate !== null && rate >= 0 && rate <= 1) {
    const exponent = num(sched.exponent);
    return {
      feesEnabled,
      feeType,
      rate,
      exponent: exponent !== null && exponent > 0 ? exponent : null,
      takerOnly: sched.takerOnly !== false,
      rebateRate: num(sched.rebateRate),
      from: 'feeSchedule',
    };
  }
  const legacyBps = num(m.takerBaseFee);
  if (legacyBps !== null && legacyBps > 0 && legacyBps <= 10_000) {
    return { feesEnabled, feeType, rate: legacyBps / 10_000, exponent: null, takerOnly: true, rebateRate: null, from: 'legacy' };
  }
  if (feesEnabled === false || feeType === 'zero_fees') {
    return { feesEnabled, feeType, rate: 0, exponent: null, takerOnly: true, rebateRate: null, from: 'zero' };
  }
  return null;
}

/** Parse the JSON stored in market_cache.fee_schedule (null on anything unexpected). */
export function parseStoredFeeSchedule(text: string | null | undefined): MarketFeeSchedule | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<MarketFeeSchedule> | null;
    if (!v || typeof v !== 'object' || typeof v.rate !== 'number' || !Number.isFinite(v.rate) || v.rate < 0 || v.rate > 1) return null;
    if (v.from !== 'feeSchedule' && v.from !== 'legacy' && v.from !== 'zero') return null;
    return {
      feesEnabled: typeof v.feesEnabled === 'boolean' ? v.feesEnabled : null,
      feeType: typeof v.feeType === 'string' ? v.feeType : null,
      rate: v.rate,
      exponent: typeof v.exponent === 'number' && Number.isFinite(v.exponent) ? v.exponent : null,
      takerOnly: v.takerOnly !== false,
      rebateRate: typeof v.rebateRate === 'number' ? v.rebateRate : null,
      from: v.from,
    };
  } catch {
    return null;
  }
}
