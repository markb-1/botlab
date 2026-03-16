import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock trading SDK before importing RpcHandler
vi.mock('../../electron/sdk/trading', () => ({
  executeBuy: vi.fn().mockResolvedValue({ success: true, executedAmount: 50, price: 0.5, tokenAmount: 100 }),
  executeSell: vi.fn().mockResolvedValue({ success: true, executedAmount: 30, price: 0.6, tokenAmount: 50 }),
  getOrderBook: vi.fn().mockResolvedValue({ asks: [{ price: '0.60', size: '100' }], bids: [{ price: '0.55', size: '100' }] }),
  getMarketPrice: vi.fn().mockResolvedValue({ bid: 0.55, ask: 0.60, mid: 0.575, spread: 0.05 }),
  getPositions: vi.fn().mockResolvedValue([]),
  getBalance: vi.fn().mockResolvedValue(500),
}));

// Mock logger
vi.mock('../../src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { RpcHandler, type RpcHandlerDeps } from '../../electron/runtime/RpcHandler';
import type { PaperTradingState } from '../../electron/runtime/PaperTradingState';
import type { RpcRequest } from '../../electron/sdk/types';
import {
  executeBuy,
  executeSell,
  getOrderBook,
  getMarketPrice,
  getPositions,
  getBalance,
} from '../../electron/sdk/trading';
import logger from '../../src/utils/logger';

function makeMockPaperState() {
  return {
    simulateBuy: vi.fn().mockReturnValue({ success: true, executedAmount: 50, price: 0.6, tokenAmount: 83.33 }),
    simulateSell: vi.fn().mockReturnValue({ success: true, executedAmount: 30, price: 0.55, tokenAmount: 50 }),
    getBalance: vi.fn().mockReturnValue(750),
    getPositions: vi.fn().mockReturnValue([{ tokenId: 't1', size: 100, currentValue: 60, avgPrice: 0.6 }]),
  } as unknown as PaperTradingState & {
    simulateBuy: ReturnType<typeof vi.fn>;
    simulateSell: ReturnType<typeof vi.fn>;
    getBalance: ReturnType<typeof vi.fn>;
    getPositions: ReturnType<typeof vi.fn>;
  };
}

describe('RpcHandler', () => {
  let deps: RpcHandlerDeps;
  let liveHandler: RpcHandler;
  let paperHandler: RpcHandler;
  let paperState: ReturnType<typeof makeMockPaperState>;
  let mockStorageRepo: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let mockTradeRepo: { create: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockStorageRepo = { get: vi.fn().mockReturnValue(null), set: vi.fn(), delete: vi.fn() };
    mockTradeRepo = { create: vi.fn().mockReturnValue({ id: 'trade-1' }) };

    deps = {
      clobClient: { getOrderBook: vi.fn(), getMarkets: vi.fn().mockResolvedValue([]) } as any,
      storageRepo: mockStorageRepo as any,
      tradeRepo: mockTradeRepo as any,
      botId: 'bot-1',
      botName: 'TestBot',
      scriptName: 'test-script',
      walletAddress: '0xwallet',
      proxyAddress: '0xproxy',
      rpcUrl: 'https://rpc.example.com',
      usdcContractAddress: '0xusdc',
      clobHttpUrl: 'https://clob.polymarket.com',
    };

    paperState = makeMockPaperState();
    liveHandler = new RpcHandler(deps);
    paperHandler = new RpcHandler(deps, paperState as unknown as PaperTradingState);
  });

  function makeReq(method: string, args: unknown[] = []): RpcRequest {
    return { id: 'req-1', method: method as any, args };
  }

  describe('handle() wrapper', () => {
    it('should wrap successful result with id', async () => {
      const resp = await liveHandler.handle(makeReq('polymarket:getBalance'));
      expect(resp.id).toBe('req-1');
      expect(resp.result).toBeDefined();
      expect(resp.error).toBeUndefined();
    });

    it('should wrap errors with id', async () => {
      const resp = await liveHandler.handle(makeReq('unknownMethod'));
      expect(resp.id).toBe('req-1');
      expect(resp.error).toContain('Unknown RPC method');
      expect(resp.result).toBeUndefined();
    });
  });

  describe('buy', () => {
    it('should delegate to executeBuy in live mode', async () => {
      await liveHandler.handle(makeReq('polymarket:buy', ['token1', 50, { maxPrice: 0.7 }]));
      expect(executeBuy).toHaveBeenCalledWith(deps.clobClient, 'token1', 50, { maxPrice: 0.7 });
    });

    it('should use paperState.simulateBuy in paper mode', async () => {
      await paperHandler.handle(makeReq('polymarket:buy', ['token1', 50, { maxPrice: 0.7 }]));
      expect(getOrderBook).toHaveBeenCalledWith(deps.clobClient, 'token1');
      expect(paperState.simulateBuy).toHaveBeenCalledWith(
        'token1', 50, expect.any(Object), { maxPrice: 0.7 }
      );
      expect(executeBuy).not.toHaveBeenCalled();
    });
  });

  describe('sell', () => {
    it('should delegate to executeSell in live mode', async () => {
      await liveHandler.handle(makeReq('polymarket:sell', ['token1', 100, { maxPrice: 0.5 }]));
      expect(executeSell).toHaveBeenCalledWith(deps.clobClient, 'token1', 100, { maxPrice: 0.5 });
    });

    it('should use paperState.simulateSell in paper mode', async () => {
      await paperHandler.handle(makeReq('polymarket:sell', ['token1', 100]));
      expect(getOrderBook).toHaveBeenCalledWith(deps.clobClient, 'token1');
      expect(paperState.simulateSell).toHaveBeenCalled();
      expect(executeSell).not.toHaveBeenCalled();
    });
  });

  describe('getOrderBook', () => {
    it('should pass through in both modes', async () => {
      await liveHandler.handle(makeReq('polymarket:getOrderBook', ['token1']));
      expect(getOrderBook).toHaveBeenCalledWith(deps.clobClient, 'token1');

      vi.clearAllMocks();
      await paperHandler.handle(makeReq('polymarket:getOrderBook', ['token1']));
      expect(getOrderBook).toHaveBeenCalledWith(deps.clobClient, 'token1');
    });
  });

  describe('getPositions', () => {
    it('should return paper positions in paper mode', async () => {
      const resp = await paperHandler.handle(makeReq('polymarket:getPositions'));
      expect(paperState.getPositions).toHaveBeenCalled();
      expect(getPositions).not.toHaveBeenCalled();
      expect(resp.result).toHaveLength(1);
    });

    it('should delegate to trading SDK in live mode', async () => {
      await liveHandler.handle(makeReq('polymarket:getPositions'));
      expect(getPositions).toHaveBeenCalledWith(deps.clobClient);
    });
  });

  describe('getBalance', () => {
    it('should return paper balance in paper mode', async () => {
      const resp = await paperHandler.handle(makeReq('polymarket:getBalance'));
      expect(paperState.getBalance).toHaveBeenCalled();
      expect(resp.result).toBe(750);
    });

    it('should use proxyAddress for live balance', async () => {
      await liveHandler.handle(makeReq('polymarket:getBalance'));
      expect(getBalance).toHaveBeenCalledWith('0xproxy', deps.rpcUrl, deps.usdcContractAddress);
    });

    it('should fall back to walletAddress when no proxyAddress', async () => {
      const noproxyDeps = { ...deps, proxyAddress: undefined };
      const handler = new RpcHandler(noproxyDeps);
      await handler.handle(makeReq('polymarket:getBalance'));
      expect(getBalance).toHaveBeenCalledWith('0xwallet', deps.rpcUrl, deps.usdcContractAddress);
    });
  });

  describe('getMarketPrice', () => {
    it('should delegate to trading SDK', async () => {
      await liveHandler.handle(makeReq('polymarket:getMarketPrice', ['token1']));
      expect(getMarketPrice).toHaveBeenCalledWith(deps.clobClient, 'token1');
    });
  });

  describe('getEvent', () => {
    it('should fetch event from clobHttpUrl', async () => {
      const mockResponse = { ok: true, json: vi.fn().mockResolvedValue({ id: 'evt-1', title: 'Test' }) };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as any);

      const resp = await liveHandler.handle(makeReq('polymarket:getEvent', ['my-event']));
      expect(globalThis.fetch).toHaveBeenCalledWith('https://clob.polymarket.com/events/my-event');
      expect(resp.result).toEqual({ id: 'evt-1', title: 'Test' });
    });

    it('should return error on non-ok response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false } as any);
      const resp = await liveHandler.handle(makeReq('polymarket:getEvent', ['bad-event']));
      expect(resp.error).toContain('Failed to fetch event');
    });
  });

  describe('storage', () => {
    it('should delegate get to storageRepo', async () => {
      mockStorageRepo.get.mockReturnValue({ foo: 'bar' });
      const resp = await liveHandler.handle(makeReq('storage:get', ['myKey']));
      expect(mockStorageRepo.get).toHaveBeenCalledWith('bot-1', 'myKey');
      expect(resp.result).toEqual({ foo: 'bar' });
    });

    it('should delegate set to storageRepo', async () => {
      await liveHandler.handle(makeReq('storage:set', ['myKey', { data: 1 }]));
      expect(mockStorageRepo.set).toHaveBeenCalledWith('bot-1', 'myKey', { data: 1 });
    });

    it('should delegate delete to storageRepo', async () => {
      await liveHandler.handle(makeReq('storage:delete', ['myKey']));
      expect(mockStorageRepo.delete).toHaveBeenCalledWith('bot-1', 'myKey');
    });
  });

  describe('log', () => {
    it('should format with [Script:BotName] prefix in live mode', async () => {
      await liveHandler.handle(makeReq('log', ['info', 'hello world']));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[Script:TestBot]'));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('hello world'));
    });

    it('should add [PAPER] tag in paper mode', async () => {
      await paperHandler.handle(makeReq('log', ['info', 'test msg']));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[PAPER]'));
    });

    it('should route error level to logger.error', async () => {
      await liveHandler.handle(makeReq('log', ['error', 'oh no']));
      expect(logger.error).toHaveBeenCalled();
    });

    it('should route warn level to logger.warning', async () => {
      await liveHandler.handle(makeReq('log', ['warn', 'watch out']));
      expect(logger.warning).toHaveBeenCalled();
    });

    it('should route debug level with [DEBUG] tag', async () => {
      await liveHandler.handle(makeReq('log', ['debug', 'details']));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[DEBUG]'));
    });
  });

  describe('recordTrade', () => {
    it('should create trade via tradeRepo in live mode', async () => {
      await liveHandler.handle(makeReq('recordTrade', [{ market: 'Test', side: 'BUY', bot_bet_size: 10 }]));
      expect(mockTradeRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          botId: 'bot-1',
          botName: 'TestBot',
          scriptName: 'test-script',
          market: 'Test',
          side: 'BUY',
        })
      );
    });

    it('should add simulated: 1 in paper mode', async () => {
      await paperHandler.handle(makeReq('recordTrade', [{ market: 'Test' }]));
      expect(mockTradeRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ simulated: 1 })
      );
    });
  });

  describe('emit', () => {
    it('should return type and data', async () => {
      const resp = await liveHandler.handle(makeReq('emit', ['myEvent', { key: 'val' }]));
      expect(resp.result).toEqual({ type: 'myEvent', data: { key: 'val' } });
    });
  });

  describe('unknown method', () => {
    it('should return error', async () => {
      const resp = await liveHandler.handle(makeReq('badMethod'));
      expect(resp.error).toContain('Unknown RPC method: badMethod');
    });
  });
});
