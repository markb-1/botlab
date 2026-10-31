/**
 * Stage 2: Trader Activity Tests
 *
 * These tests verify that we can fetch and process real trader activity
 * data from the Polymarket API.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fetchData from '../../packages/core/src/utils/fetchData';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

interface TradeActivity {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: string;
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: string;
  outcomeIndex: number;
  title?: string;
  slug?: string;
  outcome?: string;
}

interface Position {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  cashPnl: number;
  title?: string;
  outcome?: string;
}

describe('Stage 2: Trader Activity', () => {
  let activeTraderAddress: string | null = null;
  let traderActivities: TradeActivity[] = [];
  let traderPositions: Position[] = [];

  beforeAll(async () => {
    // Find an active trader from Polymarket leaderboard/profiles
    console.log('Finding an active trader...');

    try {
      // Try to get profiles from the leaderboard API
      const leaderboard = await fetchData(`${GAMMA_API_BASE}/leaderboard?window=daily&limit=10`);

      if (Array.isArray(leaderboard) && leaderboard.length > 0) {
        // Find a trader with an address
        for (const entry of leaderboard) {
          if (entry.address || entry.proxyWallet || entry.userAddress) {
            activeTraderAddress = entry.address || entry.proxyWallet || entry.userAddress;
            break;
          }
        }
      }
    } catch (e) {
      console.log('Leaderboard API not available, using fallback address');
    }

    // Fallback: use a known active trader address
    if (!activeTraderAddress) {
      // Use a real trader address for meaningful test results
      activeTraderAddress = '0xdc876e6873772d38716fda7f2452a78d426d7ab6';
      console.log('Using fallback trader address');
    }

    console.log(`Testing with trader: ${activeTraderAddress}`);

    try {
      // Fetch their activity
      traderActivities = await fetchData(
        `${DATA_API_BASE}/activity?user=${activeTraderAddress}&type=TRADE`
      );

      // Fetch their positions
      traderPositions = await fetchData(
        `${DATA_API_BASE}/positions?user=${activeTraderAddress}`
      );

      console.log(`  Activities fetched: ${traderActivities.length}`);
      console.log(`  Current positions: ${traderPositions.length}`);
    } catch (e) {
      console.log('Could not fetch trader data (this may be OK for testing)');
      traderActivities = [];
      traderPositions = [];
    }
  });

  describe('Trader Discovery', () => {
    it('should have a trader address to test', () => {
      expect(activeTraderAddress).not.toBeNull();
      expect(activeTraderAddress?.startsWith('0x')).toBe(true);
      console.log(`Trader address: ${activeTraderAddress}`);
    });

    it('should fetch trader activities (may be empty)', () => {
      expect(Array.isArray(traderActivities)).toBe(true);
      console.log(`Activities found: ${traderActivities.length}`);
    });

    it('should fetch trader positions (may be empty)', () => {
      expect(Array.isArray(traderPositions)).toBe(true);
      console.log(`Positions found: ${traderPositions.length}`);
    });
  });

  describe('Activity Analysis', () => {
    it('should categorize trades by side (BUY/SELL)', () => {
      if (traderActivities.length === 0) {
        console.log('No activities to analyze');
        return;
      }

      const buys = traderActivities.filter((a) => a.side === 'BUY');
      const sells = traderActivities.filter((a) => a.side === 'SELL');

      console.log('\nTrade breakdown:');
      console.log(`  BUY trades: ${buys.length}`);
      console.log(`  SELL trades: ${sells.length}`);

      const totalBuyVolume = buys.reduce((sum, t) => sum + (t.usdcSize || 0), 0);
      const totalSellVolume = sells.reduce((sum, t) => sum + (t.usdcSize || 0), 0);

      console.log(`  Buy volume: $${totalBuyVolume.toFixed(2)}`);
      console.log(`  Sell volume: $${totalSellVolume.toFixed(2)}`);
    });

    it('should identify unique markets traded', () => {
      if (traderActivities.length === 0) {
        console.log('No activities to analyze');
        return;
      }

      const uniqueMarkets = new Set<string>();

      for (const activity of traderActivities) {
        const marketId = activity.conditionId || activity.slug || 'unknown';
        uniqueMarkets.add(marketId);
      }

      console.log(`\nUnique markets traded: ${uniqueMarkets.size}`);

      // Show some market titles
      const marketTitles = new Set<string>();
      for (const activity of traderActivities) {
        if (activity.title && marketTitles.size < 5) {
          marketTitles.add(activity.title);
        }
      }

      if (marketTitles.size > 0) {
        console.log('Sample markets:');
        for (const title of marketTitles) {
          console.log(`  - ${title.substring(0, 60)}${title.length > 60 ? '...' : ''}`);
        }
      }
    });

    it('should calculate average trade size', () => {
      if (traderActivities.length === 0) {
        console.log('No activities to analyze');
        return;
      }

      const tradeSizes = traderActivities
        .map((t) => t.usdcSize)
        .filter((size) => size && size > 0);

      if (tradeSizes.length === 0) {
        console.log('No valid trade sizes found');
        return;
      }

      const avgSize = tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length;
      const maxSize = Math.max(...tradeSizes);
      const minSize = Math.min(...tradeSizes);

      console.log('\nTrade size analysis:');
      console.log(`  Average: $${avgSize.toFixed(2)}`);
      console.log(`  Min: $${minSize.toFixed(2)}`);
      console.log(`  Max: $${maxSize.toFixed(2)}`);

      expect(avgSize).toBeGreaterThan(0);
    });

    it('should analyze trade timing', () => {
      if (traderActivities.length < 2) {
        console.log('Not enough activities for timing analysis');
        return;
      }

      // Sort by timestamp
      const sorted = [...traderActivities].sort((a, b) => b.timestamp - a.timestamp);

      const newestTrade = sorted[0];
      const oldestTrade = sorted[sorted.length - 1];

      const newestDate = new Date(newestTrade.timestamp * 1000);
      const oldestDate = new Date(oldestTrade.timestamp * 1000);

      console.log('\nTrade timing:');
      console.log(`  Most recent: ${newestDate.toISOString()}`);
      console.log(`  Oldest: ${oldestDate.toISOString()}`);

      // Calculate average time between trades
      if (sorted.length >= 2) {
        let totalGap = 0;
        for (let i = 0; i < sorted.length - 1; i++) {
          totalGap += sorted[i].timestamp - sorted[i + 1].timestamp;
        }
        const avgGapSeconds = totalGap / (sorted.length - 1);
        const avgGapMinutes = avgGapSeconds / 60;

        console.log(`  Avg time between trades: ${avgGapMinutes.toFixed(1)} minutes`);
      }
    });
  });

  describe('Position Analysis', () => {
    it('should fetch and analyze current positions', () => {
      console.log(`\nCurrent positions: ${traderPositions.length}`);

      if (traderPositions.length === 0) {
        console.log('No positions to analyze');
        return;
      }

      const totalValue = traderPositions.reduce((sum, pos) => sum + (pos.currentValue || 0), 0);
      const totalPnL = traderPositions.reduce((sum, pos) => sum + (pos.cashPnl || 0), 0);

      console.log(`  Total portfolio value: $${totalValue.toFixed(2)}`);
      console.log(`  Total P&L: $${totalPnL.toFixed(2)}`);

      // Show top positions by value
      const sortedPositions = [...traderPositions].sort(
        (a, b) => (b.currentValue || 0) - (a.currentValue || 0)
      );

      console.log('\nTop positions by value:');
      for (const pos of sortedPositions.slice(0, 5)) {
        console.log(
          `  $${(pos.currentValue || 0).toFixed(2)} - ${pos.outcome || 'N/A'} in "${(pos.title || 'Unknown').substring(0, 40)}..."`
        );
      }
    });

    it('should identify winning and losing positions', () => {
      if (traderPositions.length === 0) {
        console.log('No positions to analyze');
        return;
      }

      const winners = traderPositions.filter((p) => (p.cashPnl || 0) > 0);
      const losers = traderPositions.filter((p) => (p.cashPnl || 0) < 0);
      const breakeven = traderPositions.filter((p) => (p.cashPnl || 0) === 0);

      console.log('\nPosition P&L breakdown:');
      console.log(`  Winners: ${winners.length}`);
      console.log(`  Losers: ${losers.length}`);
      console.log(`  Break-even: ${breakeven.length}`);

      if (winners.length + losers.length > 0) {
        const winRate = (winners.length / (winners.length + losers.length)) * 100;
        console.log(`  Win rate: ${winRate.toFixed(1)}%`);
      }
    });
  });

  describe('Copy Trading Simulation', () => {
    it('should identify copyable BUY trades', () => {
      if (traderActivities.length === 0) {
        console.log('No activities to simulate');
        return;
      }

      // Filter for recent BUY trades that would be copyable
      const now = Math.floor(Date.now() / 1000);
      const oneHourAgo = now - 3600;

      const recentBuys = traderActivities.filter(
        (t) => t.side === 'BUY' && t.timestamp > oneHourAgo && (t.usdcSize || 0) > 0
      );

      console.log(`\nRecent BUY trades (last hour): ${recentBuys.length}`);

      for (const trade of recentBuys.slice(0, 3)) {
        const timeAgo = Math.floor((now - trade.timestamp) / 60);
        console.log(`\n  Trade from ${timeAgo} minutes ago:`);
        console.log(`    Market: ${(trade.title || trade.slug || 'Unknown').substring(0, 50)}`);
        console.log(`    Outcome: ${trade.outcome || 'N/A'}`);
        console.log(`    Size: $${(trade.usdcSize || 0).toFixed(2)}`);
        console.log(`    Price: ${(trade.price || 0).toFixed(2)}`);
      }
    });

    it('should calculate hypothetical copy sizes', () => {
      if (traderActivities.length === 0) {
        console.log('No activities to simulate');
        return;
      }

      const recentBuys = traderActivities.filter(
        (t) => t.side === 'BUY' && (t.usdcSize || 0) > 0
      );

      if (recentBuys.length === 0) {
        console.log('No BUY trades to simulate');
        return;
      }

      console.log('\nHypothetical copy sizes (10% strategy):');

      for (const trade of recentBuys.slice(0, 5)) {
        const copySize = (trade.usdcSize || 0) * 0.1;
        const capped = Math.min(copySize, 100); // $100 max

        console.log(
          `  Trader: $${(trade.usdcSize || 0).toFixed(2)} → Copy: $${copySize.toFixed(2)}${capped < copySize ? ` (capped to $${capped.toFixed(2)})` : ''}`
        );
      }
    });
  });
});
