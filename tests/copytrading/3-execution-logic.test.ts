/**
 * Stage 3: Execution Logic Tests (Mocked Data)
 *
 * These tests verify the copy trading logic using mocked data.
 * No actual trades are executed.
 */

import { describe, it, expect } from 'vitest';

// ============================================================================
// TYPES (matching the real implementation)
// ============================================================================

type StrategyType = 'PERCENTAGE' | 'FIXED' | 'ADAPTIVE';

interface CopyStrategyConfig {
  strategy: StrategyType;
  copySize: number; // Percentage (e.g., 10 = 10%) or fixed USD amount
  maxOrderSizeUSD: number;
  minOrderSizeUSD: number;
  maxPositionSizeUSD?: number;
  maxDailyVolumeUSD?: number;
  tieredMultipliers?: Array<{ min: number; max: number; multiplier: number }>;
  smallTradeThreshold?: number;
  smallTradePercentage?: number;
}

interface OrderCalcResult {
  finalAmount: number;
  reasoning: string;
  belowMinimum: boolean;
}

interface MockTrade {
  transactionHash: string;
  timestamp: number;
  conditionId: string;
  asset: string;
  side: 'BUY' | 'SELL';
  usdcSize: number;
  price: number;
  title: string;
  outcome: string;
}

interface MockPosition {
  conditionId: string;
  asset: string;
  size: number;
  currentValue: number;
  avgPrice: number;
}

// ============================================================================
// COPY STRATEGY CALCULATION (extracted from postOrder.ts)
// ============================================================================

function calculateOrderSize(
  config: CopyStrategyConfig,
  traderOrderSize: number,
  myBalance: number,
  currentPositionValue: number
): OrderCalcResult {
  let baseAmount: number;
  let reasoning: string;

  // Calculate base amount based on strategy
  switch (config.strategy) {
    case 'PERCENTAGE':
      baseAmount = traderOrderSize * (config.copySize / 100);
      reasoning = `${config.copySize}% of $${traderOrderSize.toFixed(2)} = $${baseAmount.toFixed(2)}`;
      break;
    case 'FIXED':
      baseAmount = config.copySize;
      reasoning = `Fixed amount: $${baseAmount.toFixed(2)}`;
      break;
    case 'ADAPTIVE':
    default:
      baseAmount = traderOrderSize * (config.copySize / 100);
      reasoning = `Adaptive ${config.copySize}% of $${traderOrderSize.toFixed(2)} = $${baseAmount.toFixed(2)}`;
      break;
  }

  // Apply small trade boost if applicable
  if (
    config.smallTradeThreshold &&
    config.smallTradePercentage &&
    traderOrderSize < config.smallTradeThreshold
  ) {
    const boostedAmount = traderOrderSize * (config.smallTradePercentage / 100);
    if (boostedAmount > baseAmount) {
      baseAmount = boostedAmount;
      reasoning += ` (boosted to ${config.smallTradePercentage}% for small trade)`;
    }
  }

  // Apply tiered multiplier if applicable
  if (config.tieredMultipliers && config.tieredMultipliers.length > 0) {
    const tier = config.tieredMultipliers.find(
      (t) => traderOrderSize >= t.min && traderOrderSize < t.max
    );
    if (tier) {
      baseAmount *= tier.multiplier;
      reasoning += ` × ${tier.multiplier}x tier`;
    }
  }

  // Apply constraints
  let finalAmount = baseAmount;

  // Check max order size
  if (finalAmount > config.maxOrderSizeUSD) {
    finalAmount = config.maxOrderSizeUSD;
    reasoning += ` → capped at max $${config.maxOrderSizeUSD}`;
  }

  // Check max position size
  if (config.maxPositionSizeUSD) {
    const newPositionValue = currentPositionValue + finalAmount;
    if (newPositionValue > config.maxPositionSizeUSD) {
      const allowedAmount = config.maxPositionSizeUSD - currentPositionValue;
      if (allowedAmount <= 0) {
        return {
          finalAmount: 0,
          reasoning: `Position limit reached ($${currentPositionValue.toFixed(2)}/$${config.maxPositionSizeUSD})`,
          belowMinimum: false,
        };
      }
      finalAmount = allowedAmount;
      reasoning += ` → reduced to $${finalAmount.toFixed(2)} (position limit)`;
    }
  }

  // Check balance
  if (finalAmount > myBalance) {
    finalAmount = myBalance;
    reasoning += ` → reduced to balance $${myBalance.toFixed(2)}`;
  }

  // Check minimum
  if (finalAmount < config.minOrderSizeUSD) {
    return {
      finalAmount: 0,
      reasoning: `$${finalAmount.toFixed(2)} below min order size $${config.minOrderSizeUSD}`,
      belowMinimum: true,
    };
  }

  return { finalAmount, reasoning, belowMinimum: false };
}

// ============================================================================
// MOCK DATA
// ============================================================================

const MOCK_TRADES: MockTrade[] = [
  {
    transactionHash: 'tx-1',
    timestamp: Math.floor(Date.now() / 1000) - 60, // 1 minute ago
    conditionId: 'cond-1',
    asset: 'asset-1a',
    side: 'BUY',
    usdcSize: 100,
    price: 0.65,
    title: 'Will Bitcoin reach $100k by end of 2025?',
    outcome: 'Yes',
  },
  {
    transactionHash: 'tx-2',
    timestamp: Math.floor(Date.now() / 1000) - 120, // 2 minutes ago
    conditionId: 'cond-2',
    asset: 'asset-2a',
    side: 'BUY',
    usdcSize: 500,
    price: 0.35,
    title: 'Lakers vs Celtics - Who will win?',
    outcome: 'Lakers',
  },
  {
    transactionHash: 'tx-3',
    timestamp: Math.floor(Date.now() / 1000) - 180, // 3 minutes ago
    conditionId: 'cond-3',
    asset: 'asset-3a',
    side: 'BUY',
    usdcSize: 25, // Small trade
    price: 0.80,
    title: 'Will it rain in NYC tomorrow?',
    outcome: 'Yes',
  },
  {
    transactionHash: 'tx-4',
    timestamp: Math.floor(Date.now() / 1000) - 240, // 4 minutes ago
    conditionId: 'cond-1',
    asset: 'asset-1a',
    side: 'SELL',
    usdcSize: 50,
    price: 0.70,
    title: 'Will Bitcoin reach $100k by end of 2025?',
    outcome: 'Yes',
  },
  {
    transactionHash: 'tx-5',
    timestamp: Math.floor(Date.now() / 1000) - 86400, // 24 hours ago (too old)
    conditionId: 'cond-4',
    asset: 'asset-4a',
    side: 'BUY',
    usdcSize: 200,
    price: 0.50,
    title: 'Old trade that should be ignored',
    outcome: 'Yes',
  },
];

const MOCK_MY_POSITIONS: MockPosition[] = [
  {
    conditionId: 'cond-1',
    asset: 'asset-1a',
    size: 100,
    currentValue: 70,
    avgPrice: 0.60,
  },
];

// ============================================================================
// TESTS
// ============================================================================

describe('Stage 3: Copy Trading Execution Logic', () => {
  describe('Strategy: PERCENTAGE', () => {
    const config: CopyStrategyConfig = {
      strategy: 'PERCENTAGE',
      copySize: 10, // 10%
      maxOrderSizeUSD: 100,
      minOrderSizeUSD: 5,
    };

    it('should calculate 10% of trader order', () => {
      const result = calculateOrderSize(config, 100, 1000, 0);

      expect(result.finalAmount).toBe(10);
      expect(result.belowMinimum).toBe(false);
      console.log(`$100 trade → ${result.reasoning}`);
    });

    it('should handle large trader orders', () => {
      const result = calculateOrderSize(config, 500, 1000, 0);

      expect(result.finalAmount).toBe(50);
      console.log(`$500 trade → ${result.reasoning}`);
    });

    it('should cap at max order size', () => {
      const result = calculateOrderSize(config, 2000, 1000, 0);

      expect(result.finalAmount).toBe(100); // Capped at $100
      expect(result.reasoning).toContain('capped');
      console.log(`$2000 trade → ${result.reasoning}`);
    });

    it('should reject orders below minimum', () => {
      const result = calculateOrderSize(config, 30, 1000, 0);

      expect(result.finalAmount).toBe(0);
      expect(result.belowMinimum).toBe(true);
      console.log(`$30 trade → ${result.reasoning}`);
    });
  });

  describe('Strategy: FIXED', () => {
    const config: CopyStrategyConfig = {
      strategy: 'FIXED',
      copySize: 25, // Fixed $25
      maxOrderSizeUSD: 100,
      minOrderSizeUSD: 5,
    };

    it('should use fixed amount regardless of trader size', () => {
      const result1 = calculateOrderSize(config, 50, 1000, 0);
      const result2 = calculateOrderSize(config, 500, 1000, 0);
      const result3 = calculateOrderSize(config, 5000, 1000, 0);

      expect(result1.finalAmount).toBe(25);
      expect(result2.finalAmount).toBe(25);
      expect(result3.finalAmount).toBe(25);

      console.log(`$50 trade → ${result1.reasoning}`);
      console.log(`$500 trade → ${result2.reasoning}`);
      console.log(`$5000 trade → ${result3.reasoning}`);
    });
  });

  describe('Strategy: ADAPTIVE with Tiered Multipliers', () => {
    const config: CopyStrategyConfig = {
      strategy: 'ADAPTIVE',
      copySize: 10,
      maxOrderSizeUSD: 100,
      minOrderSizeUSD: 5,
      tieredMultipliers: [
        { min: 0, max: 50, multiplier: 2.0 }, // Small trades: 2x
        { min: 50, max: 200, multiplier: 1.0 }, // Medium trades: 1x
        { min: 200, max: 1000, multiplier: 0.5 }, // Large trades: 0.5x
      ],
    };

    it('should apply 2x multiplier for small trades', () => {
      const result = calculateOrderSize(config, 30, 1000, 0);

      // 10% of $30 = $3, × 2.0 = $6
      expect(result.finalAmount).toBe(6);
      expect(result.reasoning).toContain('2x tier');
      console.log(`$30 trade → ${result.reasoning}`);
    });

    it('should apply 1x multiplier for medium trades', () => {
      const result = calculateOrderSize(config, 100, 1000, 0);

      // 10% of $100 = $10, × 1.0 = $10
      expect(result.finalAmount).toBe(10);
      expect(result.reasoning).toContain('1x tier');
      console.log(`$100 trade → ${result.reasoning}`);
    });

    it('should apply 0.5x multiplier for large trades', () => {
      const result = calculateOrderSize(config, 500, 1000, 0);

      // 10% of $500 = $50, × 0.5 = $25
      expect(result.finalAmount).toBe(25);
      expect(result.reasoning).toContain('0.5x tier');
      console.log(`$500 trade → ${result.reasoning}`);
    });
  });

  describe('Small Trade Boost', () => {
    const config: CopyStrategyConfig = {
      strategy: 'PERCENTAGE',
      copySize: 10,
      maxOrderSizeUSD: 100,
      minOrderSizeUSD: 5,
      smallTradeThreshold: 50,
      smallTradePercentage: 50, // 50% for small trades
    };

    it('should boost small trades', () => {
      const result = calculateOrderSize(config, 20, 1000, 0);

      // Normal: 10% of $20 = $2
      // Boosted: 50% of $20 = $10
      expect(result.finalAmount).toBe(10);
      expect(result.reasoning).toContain('boosted');
      console.log(`$20 small trade → ${result.reasoning}`);
    });

    it('should not boost trades above threshold', () => {
      const result = calculateOrderSize(config, 100, 1000, 0);

      // 10% of $100 = $10 (no boost)
      expect(result.finalAmount).toBe(10);
      expect(result.reasoning).not.toContain('boosted');
      console.log(`$100 trade → ${result.reasoning}`);
    });
  });

  describe('Position Limits', () => {
    const config: CopyStrategyConfig = {
      strategy: 'PERCENTAGE',
      copySize: 10,
      maxOrderSizeUSD: 100,
      minOrderSizeUSD: 5,
      maxPositionSizeUSD: 200,
    };

    it('should allow orders within position limit', () => {
      const result = calculateOrderSize(config, 500, 1000, 50);

      // 10% of $500 = $50, position would be $100 (under $200 limit)
      expect(result.finalAmount).toBe(50);
      console.log(`Current position $50 → ${result.reasoning}`);
    });

    it('should reduce order to fit within position limit', () => {
      const result = calculateOrderSize(config, 500, 1000, 180);

      // 10% of $500 = $50, but position limit only allows $20 more
      expect(result.finalAmount).toBe(20);
      expect(result.reasoning).toContain('position limit');
      console.log(`Current position $180 → ${result.reasoning}`);
    });

    it('should reject orders when position limit reached', () => {
      const result = calculateOrderSize(config, 500, 1000, 200);

      expect(result.finalAmount).toBe(0);
      expect(result.reasoning).toContain('Position limit reached');
      console.log(`Current position $200 → ${result.reasoning}`);
    });
  });

  describe('Balance Constraints', () => {
    const config: CopyStrategyConfig = {
      strategy: 'PERCENTAGE',
      copySize: 10,
      maxOrderSizeUSD: 100,
      minOrderSizeUSD: 5,
    };

    it('should reduce order to available balance', () => {
      const result = calculateOrderSize(config, 500, 30, 0);

      // 10% of $500 = $50, but only $30 available
      expect(result.finalAmount).toBe(30);
      expect(result.reasoning).toContain('balance');
      console.log(`Balance $30 → ${result.reasoning}`);
    });

    it('should reject when balance below minimum', () => {
      const result = calculateOrderSize(config, 500, 3, 0);

      // 10% of $500 = $50, but only $3 available (below $5 minimum)
      expect(result.finalAmount).toBe(0);
      expect(result.belowMinimum).toBe(true);
      console.log(`Balance $3 → ${result.reasoning}`);
    });
  });

  describe('Trade Filtering', () => {
    it('should filter trades by age', () => {
      const maxAgeHours = 1;
      const cutoffTimestamp = Math.floor(Date.now() / 1000) - maxAgeHours * 3600;

      const validTrades = MOCK_TRADES.filter((t) => t.timestamp > cutoffTimestamp);
      const oldTrades = MOCK_TRADES.filter((t) => t.timestamp <= cutoffTimestamp);

      console.log(`\nTrade age filtering (max ${maxAgeHours} hour):`);
      console.log(`  Valid trades: ${validTrades.length}`);
      console.log(`  Filtered out (too old): ${oldTrades.length}`);

      expect(validTrades.length).toBe(4);
      expect(oldTrades.length).toBe(1);
    });

    it('should identify BUY vs SELL trades', () => {
      const buyTrades = MOCK_TRADES.filter((t) => t.side === 'BUY');
      const sellTrades = MOCK_TRADES.filter((t) => t.side === 'SELL');

      console.log('\nTrade type breakdown:');
      console.log(`  BUY trades: ${buyTrades.length}`);
      console.log(`  SELL trades: ${sellTrades.length}`);

      expect(buyTrades.length).toBe(4);
      expect(sellTrades.length).toBe(1);
    });

    it('should detect duplicate trades by transaction hash', () => {
      const processedHashes = new Set<string>();
      const duplicates: MockTrade[] = [];
      const unique: MockTrade[] = [];

      for (const trade of MOCK_TRADES) {
        if (processedHashes.has(trade.transactionHash)) {
          duplicates.push(trade);
        } else {
          processedHashes.add(trade.transactionHash);
          unique.push(trade);
        }
      }

      console.log('\nDuplicate detection:');
      console.log(`  Unique trades: ${unique.length}`);
      console.log(`  Duplicates: ${duplicates.length}`);

      expect(duplicates.length).toBe(0); // Our mock data has no duplicates
    });
  });

  describe('Full Copy Simulation', () => {
    it('should simulate copying all valid trades', () => {
      const config: CopyStrategyConfig = {
        strategy: 'PERCENTAGE',
        copySize: 10,
        maxOrderSizeUSD: 100,
        minOrderSizeUSD: 5,
        maxPositionSizeUSD: 500,
      };

      const myBalance = 1000;
      const maxAgeHours = 1;
      const cutoffTimestamp = Math.floor(Date.now() / 1000) - maxAgeHours * 3600;

      // Track position values by conditionId
      const positionValues: Record<string, number> = {};
      for (const pos of MOCK_MY_POSITIONS) {
        positionValues[pos.conditionId] = pos.currentValue;
      }

      console.log('\n========================================');
      console.log('COPY TRADING SIMULATION');
      console.log('========================================\n');
      console.log('Config:', JSON.stringify(config, null, 2));
      console.log(`\nMy balance: $${myBalance}`);
      console.log(`Max trade age: ${maxAgeHours} hour(s)`);
      console.log('\n----------------------------------------\n');

      let totalCopied = 0;
      let tradesSkipped = 0;
      let tradesCopied = 0;

      for (const trade of MOCK_TRADES) {
        console.log(`\nEvaluating: ${trade.side} $${trade.usdcSize} on "${trade.title}"`);

        // Filter by age
        if (trade.timestamp <= cutoffTimestamp) {
          console.log('  ❌ Skipped: Trade too old');
          tradesSkipped++;
          continue;
        }

        // Only copy BUY trades for this simulation
        if (trade.side !== 'BUY') {
          console.log('  ⏭️  Skipped: SELL trade (different logic)');
          continue;
        }

        const currentPositionValue = positionValues[trade.conditionId] || 0;
        const result = calculateOrderSize(config, trade.usdcSize, myBalance, currentPositionValue);

        if (result.finalAmount === 0) {
          console.log(`  ❌ Skipped: ${result.reasoning}`);
          tradesSkipped++;
          continue;
        }

        console.log(`  ✓ Would copy: $${result.finalAmount.toFixed(2)}`);
        console.log(`    ${result.reasoning}`);

        totalCopied += result.finalAmount;
        tradesCopied++;

        // Update position tracking
        positionValues[trade.conditionId] =
          (positionValues[trade.conditionId] || 0) + result.finalAmount;
      }

      console.log('\n========================================');
      console.log('SIMULATION RESULTS');
      console.log('========================================\n');
      console.log(`Trades copied: ${tradesCopied}`);
      console.log(`Trades skipped: ${tradesSkipped}`);
      console.log(`Total would copy: $${totalCopied.toFixed(2)}`);

      expect(tradesCopied).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero trader order size', () => {
      const config: CopyStrategyConfig = {
        strategy: 'PERCENTAGE',
        copySize: 10,
        maxOrderSizeUSD: 100,
        minOrderSizeUSD: 5,
      };

      const result = calculateOrderSize(config, 0, 1000, 0);

      expect(result.finalAmount).toBe(0);
      expect(result.belowMinimum).toBe(true);
    });

    it('should handle zero balance', () => {
      const config: CopyStrategyConfig = {
        strategy: 'PERCENTAGE',
        copySize: 10,
        maxOrderSizeUSD: 100,
        minOrderSizeUSD: 5,
      };

      const result = calculateOrderSize(config, 100, 0, 0);

      expect(result.finalAmount).toBe(0);
      expect(result.belowMinimum).toBe(true);
    });

    it('should handle very small copySize', () => {
      const config: CopyStrategyConfig = {
        strategy: 'PERCENTAGE',
        copySize: 1, // 1%
        maxOrderSizeUSD: 100,
        minOrderSizeUSD: 5,
      };

      const result = calculateOrderSize(config, 100, 1000, 0);

      // 1% of $100 = $1, below minimum
      expect(result.finalAmount).toBe(0);
      expect(result.belowMinimum).toBe(true);
    });

    it('should handle 100% copySize', () => {
      const config: CopyStrategyConfig = {
        strategy: 'PERCENTAGE',
        copySize: 100, // 100%
        maxOrderSizeUSD: 1000,
        minOrderSizeUSD: 5,
      };

      const result = calculateOrderSize(config, 100, 1000, 0);

      expect(result.finalAmount).toBe(100);
    });
  });
});
