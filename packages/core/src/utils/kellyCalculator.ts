/**
 * Kelly Criterion Calculator
 *
 * Calculates optimal position sizes based on win rate, sample size, and market price.
 * Pure math — no external dependencies. Available to scripts via ctx.kelly.
 */

export interface KellyConfig {
  /** Fraction of Kelly to use (0.25 = quarter Kelly, recommended) */
  kellyFraction: number;
  /** Minimum edge required to place a bet (e.g., 0.03 = 3%) */
  minEdge: number;
  /** Maximum position as fraction of bankroll (e.g., 0.10 = 10%) */
  maxPositionFraction: number;
  /** Minimum sample size to trust win rate */
  minSampleSize: number;
  /** Confidence decay rate for small samples */
  confidenceDecayRate: number;
}

export interface KellyResult {
  /** Should we take this position? */
  shouldTrade: boolean;
  /** Recommended position size (fraction of bankroll) */
  positionFraction: number;
  /** Actual dollar amount to trade */
  tradeAmount: number;
  /** Calculated edge */
  edge: number;
  /** Raw Kelly fraction (before adjustments) */
  rawKelly: number;
  /** Confidence score (0-1) based on sample size */
  confidence: number;
  /** Reason for decision */
  reason: string;
}

export const DEFAULT_KELLY_CONFIG: KellyConfig = {
  kellyFraction: 0.25,        // Quarter Kelly (conservative)
  minEdge: 0.03,              // 3% minimum edge
  maxPositionFraction: 0.05,  // 5% max per position
  minSampleSize: 20,          // Need at least 20 resolved trades
  confidenceDecayRate: 0.5,   // Decay rate for small samples
};

/**
 * Calculate Kelly-optimal position size.
 *
 * @param winRate     - Historical win rate (0-1)
 * @param sampleSize  - Number of resolved trades the win rate is based on
 * @param marketPrice - Current market price (0-1 for prediction markets)
 * @param bankroll    - Available capital
 * @param config      - Kelly parameters (optional, defaults to quarter Kelly)
 */
export function calculateKelly(
  winRate: number,
  sampleSize: number,
  marketPrice: number,
  bankroll: number,
  config: KellyConfig = DEFAULT_KELLY_CONFIG,
): KellyResult {
  // Check sample size
  if (sampleSize < config.minSampleSize) {
    return {
      shouldTrade: false,
      positionFraction: 0,
      tradeAmount: 0,
      edge: 0,
      rawKelly: 0,
      confidence: sampleSize / config.minSampleSize,
      reason: `Insufficient sample size: ${sampleSize} < ${config.minSampleSize}`,
    };
  }

  // Calculate confidence based on sample size (asymptotic to 1)
  const confidence = 1 - Math.exp(-config.confidenceDecayRate * sampleSize / 100);

  // Adjust win rate toward 50% based on confidence
  const adjustedWinRate = 0.5 + (winRate - 0.5) * confidence;

  // Calculate implied odds from market price
  // Buying at price p means odds of (1/p - 1)
  // E.g., buying at 0.60 = odds of 0.667 (payout of 1.667 for every 1 risked)
  const b = (1 / marketPrice) - 1;

  // Calculate edge: expected value per dollar
  const p = adjustedWinRate;
  const q = 1 - p;
  const edge = (p * (1 + b)) - 1;

  // Kelly formula: f* = (bp - q) / b
  const rawKelly = (b * p - q) / b;

  // Check if edge meets minimum threshold
  if (edge < config.minEdge) {
    return {
      shouldTrade: false,
      positionFraction: 0,
      tradeAmount: 0,
      edge,
      rawKelly,
      confidence,
      reason: `Edge too low: ${(edge * 100).toFixed(2)}% < ${(config.minEdge * 100).toFixed(0)}%`,
    };
  }

  // Check if Kelly is positive
  if (rawKelly <= 0) {
    return {
      shouldTrade: false,
      positionFraction: 0,
      tradeAmount: 0,
      edge,
      rawKelly,
      confidence,
      reason: `Negative Kelly: ${(rawKelly * 100).toFixed(2)}% - no edge at this price`,
    };
  }

  // Apply fractional Kelly and confidence adjustment
  let positionFraction = rawKelly * config.kellyFraction * confidence;

  // Cap at maximum position size
  positionFraction = Math.min(positionFraction, config.maxPositionFraction);

  // Calculate actual trade amount
  const tradeAmount = bankroll * positionFraction;

  return {
    shouldTrade: true,
    positionFraction,
    tradeAmount,
    edge,
    rawKelly,
    confidence,
    reason: `Kelly optimal: ${(positionFraction * 100).toFixed(2)}% of bankroll`,
  };
}

export default { calculateKelly, DEFAULT_KELLY_CONFIG };
