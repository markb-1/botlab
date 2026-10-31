import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock trading SDK before importing RpcHandler
vi.mock('../../electron/sdk/trading', () => ({
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

  describe('orders route through OrderService', () => {
    const filled = {
      ok: true, orderId: 'o1', status: 'filled', filledSize: 100, avgFillPrice: 0.5,
      filledNotionalUsd: 50, feeUsd: 0, expiresAt: null,
    };
    function withOrderService() {
      const orderService = {
        placeMarketable: vi.fn().mockResolvedValue(filled),
        placeLimit: vi.fn().mockResolvedValue(filled),
        placeBinance: vi.fn().mockResolvedValue({ ...filled, filledSize: 0.001, avgFillPrice: 50_000 }),
        cancel: vi.fn().mockResolvedValue(undefined),
        cancelAll: vi.fn().mockResolvedValue({ cancelled: 1, failed: 0 }),
      };
      return { orderService, handler: new RpcHandler({ ...deps, orderService: orderService as any }) };
    }

    it('buy places a marketable order and returns a TradeResult', async () => {
      const { orderService, handler } = withOrderService();
      const resp = await handler.handle(makeReq('polymarket:buy', ['token1', 50, { maxPrice: 0.7 }]));
      expect(orderService.placeMarketable).toHaveBeenCalledWith(
        expect.objectContaining({ tokenId: 'token1', side: 'buy', amount: 50, maxPrice: 0.7 })
      );
      expect(resp.result).toMatchObject({ success: true, executedAmount: 50, price: 0.5, tokenAmount: 100, orderId: 'o1' });
    });

    it('sell passes riskExit and minPrice', async () => {
      const { orderService, handler } = withOrderService();
      await handler.handle(makeReq('polymarket:sell', ['token1', 100, { minPrice: 0.4, riskExit: true }]));
      expect(orderService.placeMarketable).toHaveBeenCalledWith(
        expect.objectContaining({ tokenId: 'token1', side: 'sell', amount: 100, minPrice: 0.4, riskExit: true })
      );
    });

    it('risk rejection is returned as a typed result, not an RPC error', async () => {
      const { orderService, handler } = withOrderService();
      orderService.placeMarketable.mockResolvedValue({
        ok: false, orderId: 'o2', status: 'rejected_risk', filledSize: 0, avgFillPrice: null,
        filledNotionalUsd: 0, feeUsd: 0, expiresAt: null, failedCheck: 'max_order', error: 'Risk check failed: too big',
      });
      const resp = await handler.handle(makeReq('polymarket:buy', ['token1', 500]));
      expect(resp.error).toBeUndefined();
      expect(resp.result).toMatchObject({ success: false, status: 'rejected_risk', failedCheck: 'max_order' });
    });

    it('binance buy goes through OrderService', async () => {
      const { orderService, handler } = withOrderService();
      const resp = await handler.handle(makeReq('binance:buy', ['btcusdt', 50]));
      expect(orderService.placeBinance).toHaveBeenCalledWith({ symbol: 'btcusdt', side: 'buy', amount: 50 });
      expect(resp.result).toMatchObject({ success: true, symbol: 'BTCUSDT', side: 'BUY', clientOrderId: 'o1' });
    });

    it('order methods fail closed without an OrderService', async () => {
      for (const [method, args] of [
        ['polymarket:buy', ['t', 1]],
        ['polymarket:sell', ['t', 1]],
        ['polymarket:placeLimit', ['t', 'buy', 0.5, 10]],
        ['binance:buy', ['BTCUSDT', 10]],
      ] as const) {
        const resp = await liveHandler.handle(makeReq(method, [...args]));
        expect(resp.error).toContain('Order service unavailable');
      }
      expect(paperState.simulateBuy).not.toHaveBeenCalled();
    });

    it('recordTrade strips order linkage so scripts cannot fabricate positions', async () => {
      await liveHandler.handle(makeReq('recordTrade', [{ market: 'X', orderId: 'fake', order_id: 'fake', feeUsd: 1 }]));
      const arg = mockTradeRepo.create.mock.calls[0][0];
      expect(arg.orderId).toBeUndefined();
      expect(arg.order_id).toBeUndefined();
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

    it("should return the bot's order-linked live positions in live mode", async () => {
      const getRiskPositions = vi.fn().mockReturnValue([
        { bot_id: 'bot-1', exchange: 'polymarket', symbol: 'tok', condition_id: '0xc', net_quantity: 40, cost_basis: 20 },
      ]);
      (deps.tradeRepo as any).getRiskPositions = getRiskPositions;
      const resp = await liveHandler.handle(makeReq('polymarket:getPositions'));
      expect(getRiskPositions).toHaveBeenCalledWith({ simulated: false, botId: 'bot-1', exchange: 'polymarket' });
      expect(getPositions).not.toHaveBeenCalled();
      expect(resp.result).toEqual([{ tokenId: 'tok', conditionId: '0xc', size: 40, currentValue: 20, avgPrice: 0.5 }]);
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
