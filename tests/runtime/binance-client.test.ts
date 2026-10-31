import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  signQuery,
  getBinancePrice,
  getBinanceOrderBook,
  getBinanceBalances,
  getBinanceBalance,
  getBinancePositions,
  executeBinanceBuy,
  executeBinanceSell,
  testConnection,
} from '../../packages/core/src/exchange/binance/client';

function okResponse(data: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(data), text: () => Promise.resolve(JSON.stringify(data)) };
}

function errorResponse(status: number, body: string) {
  return { ok: false, status, json: () => Promise.resolve({}), text: () => Promise.resolve(body) };
}

const creds = { apiKey: 'test-key', apiSecret: 'test-secret' };

describe('Binance Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('signQuery()', () => {
    it('should produce a valid HMAC-SHA256 hex signature', () => {
      const sig = signQuery('symbol=BTCUSDT&timestamp=1234567890', 'my-secret');
      expect(sig).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should be deterministic for same inputs', () => {
      const sig1 = signQuery('foo=bar', 'secret');
      const sig2 = signQuery('foo=bar', 'secret');
      expect(sig1).toBe(sig2);
    });

    it('should produce different signatures for different secrets', () => {
      const sig1 = signQuery('foo=bar', 'secret1');
      const sig2 = signQuery('foo=bar', 'secret2');
      expect(sig1).not.toBe(sig2);
    });

    it('should produce different signatures for different query strings', () => {
      const sig1 = signQuery('a=1', 'secret');
      const sig2 = signQuery('a=2', 'secret');
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('getBinancePrice()', () => {
    it('should return parsed price', async () => {
      mockFetch.mockResolvedValue(okResponse({ symbol: 'BTCUSDT', price: '65432.10' }));

      const result = await getBinancePrice('BTCUSDT');
      expect(result).toEqual({ symbol: 'BTCUSDT', price: 65432.10 });
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/api/v3/ticker/price'));
    });

    it('should uppercase the symbol', async () => {
      mockFetch.mockResolvedValue(okResponse({ symbol: 'ETHUSDT', price: '3000.00' }));

      await getBinancePrice('ethusdt');
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('symbol=ETHUSDT'));
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValue(errorResponse(400, 'Bad Request'));
      await expect(getBinancePrice('INVALID')).rejects.toThrow('HTTP 400');
    });
  });

  describe('getBinanceOrderBook()', () => {
    it('should return mapped order book', async () => {
      mockFetch.mockResolvedValue(okResponse({
        bids: [['65000.00', '1.5'], ['64999.00', '2.0']],
        asks: [['65001.00', '1.0'], ['65002.00', '3.0']],
      }));

      const book = await getBinanceOrderBook('BTCUSDT');
      expect(book.bids).toHaveLength(2);
      expect(book.asks).toHaveLength(2);
      expect(book.bids[0]).toEqual({ price: '65000.00', quantity: '1.5' });
      expect(book.asks[0]).toEqual({ price: '65001.00', quantity: '1.0' });
    });

    it('should pass limit parameter', async () => {
      mockFetch.mockResolvedValue(okResponse({ bids: [], asks: [] }));

      await getBinanceOrderBook('BTCUSDT', 5);
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('limit=5'));
    });
  });

  describe('getBinanceBalances()', () => {
    it('should return only non-zero balances', async () => {
      mockFetch.mockResolvedValue(okResponse({
        balances: [
          { asset: 'BTC', free: '0.5', locked: '0.0' },
          { asset: 'ETH', free: '0.0', locked: '0.0' },
          { asset: 'USDT', free: '1000.0', locked: '50.0' },
        ],
      }));

      const balances = await getBinanceBalances(creds);
      expect(balances).toHaveLength(2);
      expect(balances.find(b => b.asset === 'BTC')).toEqual({ asset: 'BTC', free: 0.5, locked: 0 });
      expect(balances.find(b => b.asset === 'USDT')).toEqual({ asset: 'USDT', free: 1000, locked: 50 });
    });

    it('should include API key header', async () => {
      mockFetch.mockResolvedValue(okResponse({ balances: [] }));

      await getBinanceBalances(creds);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { 'X-MBX-APIKEY': 'test-key' },
        })
      );
    });
  });

  describe('getBinanceBalance()', () => {
    it('should return free balance for specific asset', async () => {
      mockFetch.mockResolvedValue(okResponse({
        balances: [
          { asset: 'USDT', free: '500.25', locked: '0' },
        ],
      }));

      const balance = await getBinanceBalance(creds, 'USDT');
      expect(balance).toBe(500.25);
    });

    it('should return 0 for missing asset', async () => {
      mockFetch.mockResolvedValue(okResponse({ balances: [] }));

      const balance = await getBinanceBalance(creds, 'XYZ');
      expect(balance).toBe(0);
    });

    it('should default to USDT', async () => {
      mockFetch.mockResolvedValue(okResponse({
        balances: [{ asset: 'USDT', free: '100', locked: '0' }],
      }));

      const balance = await getBinanceBalance(creds);
      expect(balance).toBe(100);
    });
  });

  describe('getBinancePositions()', () => {
    it('should return positions with total calculated', async () => {
      mockFetch.mockResolvedValue(okResponse({
        balances: [
          { asset: 'BTC', free: '1.0', locked: '0.5' },
          { asset: 'ETH', free: '10.0', locked: '0.0' },
        ],
      }));

      const positions = await getBinancePositions(creds);
      expect(positions).toHaveLength(2);
      expect(positions[0]).toEqual({ asset: 'BTC', free: 1.0, locked: 0.5, total: 1.5 });
    });
  });

  describe('executeBinanceBuy()', () => {
    it('should return success trade result', async () => {
      mockFetch.mockResolvedValue(okResponse({
        orderId: 12345,
        symbol: 'BTCUSDT',
        side: 'BUY',
        executedQty: '0.001',
        cummulativeQuoteQty: '65.00',
        status: 'FILLED',
      }));

      const result = await executeBinanceBuy(creds, 'BTCUSDT', 65);
      expect(result.success).toBe(true);
      expect(result.orderId).toBe(12345);
      expect(result.executedQty).toBe(0.001);
      expect(result.cummulativeQuoteQty).toBe(65);
      expect(result.avgPrice).toBe(65000);
      expect(result.side).toBe('BUY');
    });

    it('should return error on API failure', async () => {
      mockFetch.mockResolvedValue(errorResponse(400, '{"code":-1013,"msg":"Invalid quantity"}'));

      const result = await executeBinanceBuy(creds, 'BTCUSDT', 0.001);
      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 400');
      expect(result.executedQty).toBe(0);
    });

    it('should POST with MARKET order type', async () => {
      mockFetch.mockResolvedValue(okResponse({
        orderId: 1, symbol: 'ETHUSDT', side: 'BUY',
        executedQty: '1', cummulativeQuoteQty: '3000', status: 'FILLED',
      }));

      await executeBinanceBuy(creds, 'ETHUSDT', 3000);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('type=MARKET'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('executeBinanceSell()', () => {
    it('should return success trade result', async () => {
      mockFetch.mockResolvedValue(okResponse({
        orderId: 67890,
        symbol: 'ETHUSDT',
        side: 'SELL',
        executedQty: '2.0',
        cummulativeQuoteQty: '6000.00',
        status: 'FILLED',
      }));

      const result = await executeBinanceSell(creds, 'ETHUSDT', 2);
      expect(result.success).toBe(true);
      expect(result.orderId).toBe(67890);
      expect(result.executedQty).toBe(2);
      expect(result.avgPrice).toBe(3000);
      expect(result.side).toBe('SELL');
    });

    it('should return error on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await executeBinanceSell(creds, 'BTCUSDT', 1);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('testConnection()', () => {
    it('should return true on success', async () => {
      mockFetch.mockResolvedValue(okResponse({ balances: [] }));
      const result = await testConnection(creds);
      expect(result).toBe(true);
    });

    it('should throw on invalid credentials', async () => {
      mockFetch.mockResolvedValue(errorResponse(401, 'Invalid API-key'));
      await expect(testConnection(creds)).rejects.toThrow('HTTP 401');
    });
  });
});
