import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaperTradingState } from '../../electron/runtime/PaperTradingState';
import type { BinanceOrderBook } from '../../electron/sdk/types';

function makeStorageRepo() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn((botId: string, key: string) => store.get(`${botId}:${key}`) ?? null),
    set: vi.fn((botId: string, key: string, value: unknown) => { store.set(`${botId}:${key}`, value); }),
    delete: vi.fn(),
  };
}

function makeOrderBook(bids: Array<[string, string]>, asks: Array<[string, string]>): BinanceOrderBook {
  return {
    bids: bids.map(([price, quantity]) => ({ price, quantity })),
    asks: asks.map(([price, quantity]) => ({ price, quantity })),
  };
}

describe('PaperTradingState - Binance', () => {
  let state: PaperTradingState;
  let storageRepo: ReturnType<typeof makeStorageRepo>;

  beforeEach(() => {
    storageRepo = makeStorageRepo();
    state = new PaperTradingState('bot-1', 10000, storageRepo);
  });

  describe('initial state', () => {
    it('should have USDT balance equal to initial balance', () => {
      expect(state.getBinanceBalance('USDT')).toBe(10000);
    });

    it('should have no other positions', () => {
      const positions = state.getBinancePositions();
      expect(positions).toHaveLength(1);
      expect(positions[0].asset).toBe('USDT');
    });

    it('should return 0 for unknown asset', () => {
      expect(state.getBinanceBalance('BTC')).toBe(0);
    });
  });

  describe('simulateBinanceBuy()', () => {
    const book = makeOrderBook(
      [['64999', '2']],
      [['65000', '1']]  // 1 BTC available at 65000
    );

    it('should deduct USDT and credit base asset', () => {
      const result = state.simulateBinanceBuy('BTCUSDT', 650, book);
      expect(result.success).toBe(true);
      expect(result.side).toBe('BUY');
      expect(result.avgPrice).toBe(65000);
      expect(result.executedQty).toBeCloseTo(0.01); // 650 / 65000
      expect(result.cummulativeQuoteQty).toBe(650);

      expect(state.getBinanceBalance('USDT')).toBeCloseTo(9350);
      expect(state.getBinanceBalance('BTC')).toBeCloseTo(0.01);
    });

    it('should limit fill to available liquidity', () => {
      // Book has 1 BTC at 65000 = 65000 USDT liquidity
      // Use amount within USDT balance but above book liquidity
      // First bump balance so we have enough USDT
      const bigState = new PaperTradingState('bot-2', 100000, storageRepo);
      const result = bigState.simulateBinanceBuy('BTCUSDT', 80000, book);
      expect(result.success).toBe(true);
      expect(result.cummulativeQuoteQty).toBe(65000); // Only fills 65000 worth (1 BTC * 65000)
      expect(result.executedQty).toBe(1); // 1 BTC
    });

    it('should fail on insufficient USDT', () => {
      const result = state.simulateBinanceBuy('BTCUSDT', 20000, book);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient USDT');
    });

    it('should fail on zero amount', () => {
      const result = state.simulateBinanceBuy('BTCUSDT', 0, book);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid amount');
    });

    it('should fail with empty order book', () => {
      const emptyBook = makeOrderBook([['64999', '1']], []);
      const result = state.simulateBinanceBuy('BTCUSDT', 100, emptyBook);
      expect(result.success).toBe(false);
      expect(result.error).toContain('No asks');
    });

    it('should reject non-USDT quoted pairs', () => {
      expect(() => state.simulateBinanceBuy('BTCETH', 100, book)).toThrow('Only USDT-quoted');
    });

    it('should accumulate on multiple buys', () => {
      state.simulateBinanceBuy('BTCUSDT', 650, book);
      state.simulateBinanceBuy('BTCUSDT', 650, book);
      expect(state.getBinanceBalance('BTC')).toBeCloseTo(0.02);
      expect(state.getBinanceBalance('USDT')).toBeCloseTo(8700);
    });

    it('should save state after buy', () => {
      state.simulateBinanceBuy('BTCUSDT', 650, book);
      expect(storageRepo.set).toHaveBeenCalled();
    });
  });

  describe('simulateBinanceSell()', () => {
    const buyBook = makeOrderBook(
      [['64999', '2']],
      [['65000', '1']]
    );
    const sellBook = makeOrderBook(
      [['64500', '2']],  // 2 BTC wanted at 64500
      [['65000', '1']]
    );

    beforeEach(() => {
      // Buy 0.01 BTC first
      state.simulateBinanceBuy('BTCUSDT', 650, buyBook);
    });

    it('should deduct base asset and credit USDT', () => {
      const result = state.simulateBinanceSell('BTCUSDT', 0.005, sellBook);
      expect(result.success).toBe(true);
      expect(result.side).toBe('SELL');
      expect(result.avgPrice).toBe(64500);
      expect(result.executedQty).toBe(0.005);
      expect(result.cummulativeQuoteQty).toBeCloseTo(322.5);

      expect(state.getBinanceBalance('BTC')).toBeCloseTo(0.005);
    });

    it('should remove asset entry when fully sold', () => {
      state.simulateBinanceSell('BTCUSDT', 0.01, sellBook);
      expect(state.getBinanceBalance('BTC')).toBe(0);
      // Should not appear in positions
      const positions = state.getBinancePositions();
      expect(positions.find(p => p.asset === 'BTC')).toBeUndefined();
    });

    it('should fail on insufficient position', () => {
      const result = state.simulateBinanceSell('BTCUSDT', 1, sellBook);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient BTC');
    });

    it('should fail on zero quantity', () => {
      const result = state.simulateBinanceSell('BTCUSDT', 0, sellBook);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid quantity');
    });

    it('should fail with empty bids', () => {
      const noBids = makeOrderBook([], [['65000', '1']]);
      const result = state.simulateBinanceSell('BTCUSDT', 0.005, noBids);
      expect(result.success).toBe(false);
      expect(result.error).toContain('No bids');
    });

    it('should limit fill to bid liquidity', () => {
      // Sell more than bid has, but we only have 0.01 BTC
      const thinBook = makeOrderBook([['64500', '0.005']], [['65000', '1']]);
      const result = state.simulateBinanceSell('BTCUSDT', 0.01, thinBook);
      expect(result.success).toBe(true);
      expect(result.executedQty).toBe(0.005); // Limited to bid quantity
    });
  });

  describe('getBinancePositions()', () => {
    it('should return all non-zero positions', () => {
      const book = makeOrderBook([['2999', '10']], [['3000', '10']]);
      state.simulateBinanceBuy('ETHUSDT', 3000, book);

      const positions = state.getBinancePositions();
      expect(positions.length).toBeGreaterThanOrEqual(2); // USDT + ETH
      const eth = positions.find(p => p.asset === 'ETH');
      expect(eth).toBeDefined();
      expect(eth!.total).toBe(1); // 3000/3000
    });
  });

  describe('persistence', () => {
    it('should persist and restore Binance balances', () => {
      const book = makeOrderBook([['2999', '10']], [['3000', '10']]);
      state.simulateBinanceBuy('ETHUSDT', 3000, book);

      // Create a new instance and load
      const state2 = new PaperTradingState('bot-1', 10000, storageRepo);
      state2.load();

      expect(state2.getBinanceBalance('USDT')).toBeCloseTo(7000);
      expect(state2.getBinanceBalance('ETH')).toBeCloseTo(1);
    });
  });
});
