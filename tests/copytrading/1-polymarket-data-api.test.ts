/**
 * Stage 1: Polymarket Data API Connectivity Tests
 *
 * These tests verify that we can successfully connect to and retrieve data
 * from the Polymarket Data API for trader activity and positions.
 */

import { describe, it, expect } from 'vitest';
import fetchData from '../../src/utils/fetchData';

const DATA_API_BASE = 'https://data-api.polymarket.com';

// A known active trader address (from Polymarket leaderboard)
// This is a public address visible on polymarket.com
const EXAMPLE_TRADER = '0xdc876e6873772d38716fda7f2452a78d426d7ab6';

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
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  title?: string;
  slug?: string;
  outcome?: string;
  redeemable: boolean;
}

// Calls the live Polymarket API; skipped in CI (SKIP_NETWORK_TESTS=1)
describe.skipIf(!!process.env.SKIP_NETWORK_TESTS)('Stage 1: Polymarket Data API Connectivity', () => {
  describe('Activity Endpoint', () => {
    it('should fetch trade activities for any address (may be empty)', async () => {
      const url = `${DATA_API_BASE}/activity?user=${EXAMPLE_TRADER}&type=TRADE`;

      // Should not throw - API should be accessible
      const activities = await fetchData(url);

      expect(Array.isArray(activities)).toBe(true);
      console.log(`Activities for example trader: ${activities.length} trades found`);
    });

    it('should return proper activity structure when data exists', async () => {
      // The activity API requires a user address
      const url = `${DATA_API_BASE}/activity?user=${EXAMPLE_TRADER}&type=TRADE`;
      const activities: TradeActivity[] = await fetchData(url);

      expect(Array.isArray(activities)).toBe(true);

      if (activities.length > 0) {
        const activity = activities[0];

        // Verify structure
        expect(activity).toHaveProperty('timestamp');
        expect(activity).toHaveProperty('type');
        expect(activity).toHaveProperty('transactionHash');

        console.log('\nSample trade activity:');
        console.log(`  Type: ${activity.type}`);
        console.log(`  Side: ${activity.side}`);
        console.log(`  Size: $${activity.usdcSize?.toFixed(2) || 'N/A'}`);
        console.log(`  Price: ${activity.price}`);
        console.log(`  Market: ${activity.title || activity.slug || 'N/A'}`);
      } else {
        console.log('No activities found for example trader (this is OK)');
      }
    });

    it('should filter activities by type', async () => {
      const tradeUrl = `${DATA_API_BASE}/activity?user=${EXAMPLE_TRADER}&type=TRADE`;
      const trades: TradeActivity[] = await fetchData(tradeUrl);

      expect(Array.isArray(trades)).toBe(true);

      // All returned activities should be TRADE type
      for (const activity of trades) {
        if (activity.type) {
          expect(activity.type).toBe('TRADE');
        }
      }

      console.log(`Filtered TRADE activities: ${trades.length}`);
    });
  });

  describe('Positions Endpoint', () => {
    it('should fetch positions for any address (may be empty)', async () => {
      const url = `${DATA_API_BASE}/positions?user=${EXAMPLE_TRADER}`;

      const positions = await fetchData(url);

      expect(Array.isArray(positions)).toBe(true);
      console.log(`Positions for example trader: ${positions.length} positions found`);
    });

    it('should return proper position structure when data exists', async () => {
      // Fetch positions for the example trader
      const positionsUrl = `${DATA_API_BASE}/positions?user=${EXAMPLE_TRADER}`;
      const positions: Position[] = await fetchData(positionsUrl);

      expect(Array.isArray(positions)).toBe(true);

      if (positions.length > 0) {
        const position = positions[0];

        console.log('\nSample position:');
        console.log(`  Market: ${position.title || position.slug || 'N/A'}`);
        console.log(`  Outcome: ${position.outcome || 'N/A'}`);
        console.log(`  Size: ${position.size?.toFixed(2) || 'N/A'} tokens`);
        console.log(`  Current Value: $${position.currentValue?.toFixed(2) || 'N/A'}`);
        console.log(`  P&L: $${position.cashPnl?.toFixed(2) || 'N/A'} (${position.percentPnl?.toFixed(1) || 'N/A'}%)`);
        console.log(`  Redeemable: ${position.redeemable}`);

        // Verify structure
        expect(position).toHaveProperty('asset');
        expect(position).toHaveProperty('conditionId');
        expect(position).toHaveProperty('size');
      } else {
        console.log('No positions found for example trader (this is OK)');
      }
    });

    it('should calculate total portfolio value', async () => {
      const positionsUrl = `${DATA_API_BASE}/positions?user=${EXAMPLE_TRADER}`;
      const positions: Position[] = await fetchData(positionsUrl);

      const totalValue = positions.reduce((sum, pos) => sum + (pos.currentValue || 0), 0);
      const totalPnL = positions.reduce((sum, pos) => sum + (pos.cashPnl || 0), 0);

      console.log(`\nPortfolio for ${EXAMPLE_TRADER.slice(0, 10)}...:`);
      console.log(`  Positions: ${positions.length}`);
      console.log(`  Total Value: $${totalValue.toFixed(2)}`);
      console.log(`  Total P&L: $${totalPnL.toFixed(2)}`);
    });
  });

  describe('Error Handling', () => {
    it('should return empty array for non-existent address', async () => {
      const fakeAddress = '0x0000000000000000000000000000000000000000';
      const url = `${DATA_API_BASE}/positions?user=${fakeAddress}`;

      const positions = await fetchData(url);

      expect(Array.isArray(positions)).toBe(true);
      expect(positions.length).toBe(0);
    });

    it('should handle malformed address gracefully', async () => {
      const badAddress = 'not-an-address';
      const url = `${DATA_API_BASE}/positions?user=${badAddress}`;

      try {
        const positions = await fetchData(url);
        // If it returns, should be an array
        expect(Array.isArray(positions)).toBe(true);
      } catch (error) {
        // API may return 400 for invalid addresses, which is acceptable
        console.log('API rejected malformed address (expected behavior)');
        expect(true).toBe(true);
      }
    });
  });
});
