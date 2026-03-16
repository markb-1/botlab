import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaperTradingState } from '../../electron/runtime/PaperTradingState';
import type { BotStorageRepository } from '../../electron/database/repositories/BotStorageRepository';
import type { OrderBook } from '../../electron/sdk/types';

function makeOrderBook(opts: {
  asks?: Array<{ price: string; size: string }>;
  bids?: Array<{ price: string; size: string }>;
} = {}): OrderBook {
  return {
    asks: opts.asks || [],
    bids: opts.bids || [],
  };
}

describe('PaperTradingState', () => {
  let state: PaperTradingState;
  let storageRepo: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storageRepo = {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      delete: vi.fn(),
    };
    state = new PaperTradingState('bot-1', 1000, storageRepo as unknown as BotStorageRepository);
  });

  describe('constructor and initial state', () => {
    it('should initialize with the given balance', () => {
      expect(state.getBalance()).toBe(1000);
    });

    it('should start with empty positions', () => {
      expect(state.getPositions()).toEqual([]);
    });

    it('should expose initial balance', () => {
      expect(state.getInitialBalance()).toBe(1000);
    });
  });

  describe('load()', () => {
    it('should load saved state from storage', () => {
      storageRepo.get.mockReturnValue({
        balance: 500,
        positions: [{ tokenId: 't1', size: 10, avgPrice: 0.5 }],
      });

      state.load();

      expect(state.getBalance()).toBe(500);
      expect(state.getPositions()).toHaveLength(1);
      expect(state.getPositions()[0].tokenId).toBe('t1');
      expect(state.getPositions()[0].size).toBe(10);
    });

    it('should fall back to initial balance when no saved state', () => {
      storageRepo.get.mockReturnValue(null);
      state.load();
      expect(state.getBalance()).toBe(1000);
    });

    it('should fall back when saved state has invalid balance', () => {
      storageRepo.get.mockReturnValue({ balance: 'invalid', positions: [] });
      state.load();
      expect(state.getBalance()).toBe(1000);
    });

    it('should handle saved state with no positions array', () => {
      storageRepo.get.mockReturnValue({ balance: 800 });
      state.load();
      expect(state.getBalance()).toBe(800);
      expect(state.getPositions()).toEqual([]);
    });
  });

  describe('simulateBuy()', () => {
    const book = makeOrderBook({ asks: [{ price: '0.60', size: '100' }], bids: [{ price: '0.55', size: '100' }] });

    it('should reject amount <= 0', () => {
      const result = state.simulateBuy('t1', 0, book);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid amount');
    });

    it('should reject negative amount', () => {
      const result = state.simulateBuy('t1', -10, book);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid amount');
    });

    it('should reject when amount exceeds balance', () => {
      const result = state.simulateBuy('t1', 1500, book);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Insufficient paper balance');
    });

    it('should reject when orderbook has no asks', () => {
      const result = state.simulateBuy('t1', 50, makeOrderBook());
      expect(result.success).toBe(false);
      expect(result.error).toBe('No asks available in order book');
    });

    it('should execute a buy at best ask price', () => {
      const result = state.simulateBuy('t1', 60, book);

      expect(result.success).toBe(true);
      expect(result.price).toBe(0.60);
      expect(result.tokenAmount).toBe(100); // 60 / 0.60
      expect(result.executedAmount).toBe(60);
      expect(state.getBalance()).toBe(940);
    });

    it('should select the lowest ask as best ask', () => {
      const multiBook = makeOrderBook({
        asks: [{ price: '0.70', size: '50' }, { price: '0.55', size: '200' }],
      });
      const result = state.simulateBuy('t1', 55, multiBook);

      expect(result.success).toBe(true);
      expect(result.price).toBe(0.55);
    });

    it('should limit fill to available liquidity', () => {
      // 10 tokens at 0.50 = $5 of liquidity
      const thinBook = makeOrderBook({ asks: [{ price: '0.50', size: '10' }] });
      const result = state.simulateBuy('t1', 100, thinBook);

      expect(result.success).toBe(true);
      expect(result.executedAmount).toBe(5); // only $5 available
      expect(result.tokenAmount).toBe(10);
    });

    it('should update existing position with weighted average price', () => {
      // First buy: 100 tokens at 0.50
      const book1 = makeOrderBook({ asks: [{ price: '0.50', size: '200' }] });
      state.simulateBuy('t1', 50, book1); // 50/0.50 = 100 tokens

      // Second buy: 100 tokens at 0.80
      const book2 = makeOrderBook({ asks: [{ price: '0.80', size: '200' }] });
      state.simulateBuy('t1', 80, book2); // 80/0.80 = 100 tokens

      const positions = state.getPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0].size).toBe(200);
      // avgPrice = (0.50*100 + 80) / 200 = 130/200 = 0.65
      expect(positions[0].avgPrice).toBeCloseTo(0.65, 5);
    });

    it('should create a new position for a new tokenId', () => {
      const book1 = makeOrderBook({ asks: [{ price: '0.50', size: '200' }] });
      state.simulateBuy('t1', 50, book1);
      state.simulateBuy('t2', 50, book1);

      expect(state.getPositions()).toHaveLength(2);
    });

    it('should persist state via save()', () => {
      state.simulateBuy('t1', 60, book);

      expect(storageRepo.set).toHaveBeenCalledWith(
        'bot-1',
        '__paper_state',
        expect.objectContaining({
          balance: 940,
          positions: expect.arrayContaining([
            expect.objectContaining({ tokenId: 't1' }),
          ]),
        })
      );
    });

    it('should reject when maxPrice is exceeded', () => {
      const result = state.simulateBuy('t1', 50, book, { maxPrice: 0.50 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('exceeds max price');
    });

    it('should reject via maxPrice before slippage check', () => {
      // maxPrice check fires first when askPrice (0.60) > maxPrice (0.55)
      const result = state.simulateBuy('t1', 50, book, { maxPrice: 0.55, maxSlippage: 0.02 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('exceeds max price');
    });
  });

  describe('simulateSell()', () => {
    const sellBook = makeOrderBook({ bids: [{ price: '0.60', size: '100' }] });

    // Helper: buy some tokens first
    function setupPosition(tokenId: string, tokens: number, price: number) {
      const buyBook = makeOrderBook({ asks: [{ price: String(price), size: String(tokens + 100) }] });
      state.simulateBuy(tokenId, tokens * price, buyBook);
    }

    it('should reject amount <= 0', () => {
      const result = state.simulateSell('t1', 0, sellBook);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid amount');
    });

    it('should reject when no position exists', () => {
      const result = state.simulateSell('t1', 10, sellBook);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient paper position');
    });

    it('should reject when sell exceeds position', () => {
      setupPosition('t1', 10, 0.50);
      const result = state.simulateSell('t1', 20, sellBook);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient paper position');
    });

    it('should reject when orderbook has no bids', () => {
      setupPosition('t1', 10, 0.50);
      const result = state.simulateSell('t1', 5, makeOrderBook());
      expect(result.success).toBe(false);
      expect(result.error).toBe('No bids available in order book');
    });

    it('should execute a sell at best bid price', () => {
      setupPosition('t1', 100, 0.50);
      const balanceBefore = state.getBalance();

      const result = state.simulateSell('t1', 50, sellBook);

      expect(result.success).toBe(true);
      expect(result.price).toBe(0.60);
      expect(result.tokenAmount).toBe(50);
      expect(result.executedAmount).toBe(30); // 50 * 0.60
      expect(state.getBalance()).toBe(balanceBefore + 30);
    });

    it('should select the highest bid', () => {
      setupPosition('t1', 100, 0.50);
      const multiBidBook = makeOrderBook({
        bids: [{ price: '0.40', size: '50' }, { price: '0.65', size: '50' }],
      });
      const result = state.simulateSell('t1', 10, multiBidBook);
      expect(result.price).toBe(0.65);
    });

    it('should limit fill to available bid liquidity', () => {
      setupPosition('t1', 100, 0.50);
      const thinBidBook = makeOrderBook({ bids: [{ price: '0.50', size: '5' }] });
      const result = state.simulateSell('t1', 100, thinBidBook);

      expect(result.success).toBe(true);
      expect(result.tokenAmount).toBe(5);
    });

    it('should clean up position when remaining <= 0.0001', () => {
      setupPosition('t1', 10, 0.50);
      const fullSellBook = makeOrderBook({ bids: [{ price: '0.50', size: '10' }] });
      state.simulateSell('t1', 10, fullSellBook);

      expect(state.getPositions()).toEqual([]);
    });

    it('should keep position when remaining > 0.0001', () => {
      setupPosition('t1', 10, 0.50);
      const partialBook = makeOrderBook({ bids: [{ price: '0.50', size: '9' }] });
      state.simulateSell('t1', 9, partialBook);

      expect(state.getPositions()).toHaveLength(1);
      expect(state.getPositions()[0].size).toBeCloseTo(1, 1);
    });

    it('should persist state via save()', () => {
      setupPosition('t1', 100, 0.50);
      vi.clearAllMocks();

      state.simulateSell('t1', 50, sellBook);
      expect(storageRepo.set).toHaveBeenCalledWith('bot-1', '__paper_state', expect.any(Object));
    });
  });

  describe('getPositions()', () => {
    it('should map positions with currentValue = size * avgPrice', () => {
      const book = makeOrderBook({ asks: [{ price: '0.50', size: '200' }] });
      state.simulateBuy('t1', 50, book); // 100 tokens at 0.50

      const positions = state.getPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0]).toMatchObject({
        tokenId: 't1',
        size: 100,
        avgPrice: 0.50,
        currentValue: 50, // 100 * 0.50
      });
    });
  });
});
