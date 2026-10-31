import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock logger to suppress output
vi.mock('../../packages/core/src/utils/logger', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock ScriptRunner
class MockScriptRunner extends EventEmitter {
  start = vi.fn().mockResolvedValue(undefined);
  stop = vi.fn().mockResolvedValue(undefined);
  requestHeartbeat = vi.fn();
  isRunning = true;
}

let mockScriptRunnerInstance: MockScriptRunner;

vi.mock('../../packages/core/src/runtime/ScriptRunner', () => ({
  ScriptRunner: vi.fn().mockImplementation(() => {
    mockScriptRunnerInstance = new MockScriptRunner();
    return mockScriptRunnerInstance;
  }),
}));

// Mock PaperTradingState
const mockPaperState = {
  load: vi.fn(),
  getBalance: vi.fn().mockReturnValue(10000),
  getPositions: vi.fn().mockReturnValue([]),
};

vi.mock('../../packages/core/src/runtime/PaperTradingState', () => ({
  PaperTradingState: vi.fn().mockImplementation(() => mockPaperState),
}));

import { ScriptBotRunner } from '../../packages/core/src/runtime/ScriptBotRunner';
import { ScriptRunner } from '../../packages/core/src/runtime/ScriptRunner';
import { PaperTradingState } from '../../packages/core/src/runtime/PaperTradingState';

function makeBotRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bot-1',
    name: 'Test Bot',
    type: 'script',
    scriptId: 'script-1',
    walletId: 'wallet-1',
    config: {},
    status: 'stopped' as const,
    enabled: true,
    ...overrides,
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    compiledCode: 'module.exports = {}',
    scriptName: 'test-script',
    storageRepo: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    tradeRepo: { create: vi.fn() },
    rpcUrl: 'http://rpc',
    usdcContractAddress: '0xusdc',
    clobHttpUrl: 'http://clob',
    mode: 'live' as const,
    ...overrides,
  };
}

function makeWalletManager() {
  return {
    getWallet: vi.fn().mockResolvedValue({
      address: '0xwallet',
      proxyAddress: '0xproxy',
      privateKey: '0xkey',
    }),
    assignWalletToBot: vi.fn().mockResolvedValue(undefined),
    releaseWallet: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ScriptBotRunner', () => {
  let runner: ScriptBotRunner;
  let walletManager: ReturnType<typeof makeWalletManager>;
  let clobClient: Record<string, unknown>;
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    vi.clearAllMocks();
    walletManager = makeWalletManager();
    clobClient = {};
    deps = makeDeps();
    runner = new ScriptBotRunner(
      makeBotRecord() as any,
      walletManager as any,
      clobClient as any,
      deps as any
    );
  });

  describe('start() lifecycle', () => {
    it('should acquire wallet and create ScriptRunner in live mode', async () => {
      await runner.start();

      expect(walletManager.getWallet).toHaveBeenCalledWith('wallet-1');
      expect(walletManager.assignWalletToBot).toHaveBeenCalledWith('wallet-1', 'bot-1');
      expect(ScriptRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          compiledCode: 'module.exports = {}',
          botId: 'bot-1',
          botName: 'Test Bot',
          walletAddress: '0xwallet',
          proxyAddress: '0xproxy',
        })
      );
      expect(mockScriptRunnerInstance.start).toHaveBeenCalled();
      expect(runner.status).toBe('running');
    });

    it('should not create PaperTradingState in live mode', async () => {
      await runner.start();

      expect(PaperTradingState).not.toHaveBeenCalled();
      // ScriptRunner should be called without paperState
      expect(ScriptRunner).toHaveBeenCalledWith(
        expect.not.objectContaining({ paperState: expect.anything() })
      );
    });

    it('should create PaperTradingState in paper mode', async () => {
      deps = makeDeps({ mode: 'paper' });
      runner = new ScriptBotRunner(
        makeBotRecord({ config: { paperBalance: 5000 } }) as any,
        walletManager as any,
        clobClient as any,
        deps as any
      );

      await runner.start();

      expect(PaperTradingState).toHaveBeenCalledWith('bot-1', 5000, deps.storageRepo);
      expect(mockPaperState.load).toHaveBeenCalled();
    });

    it('should use default paper balance when not configured', async () => {
      deps = makeDeps({ mode: 'paper' });
      runner = new ScriptBotRunner(
        makeBotRecord() as any,
        walletManager as any,
        clobClient as any,
        deps as any
      );

      await runner.start();

      expect(PaperTradingState).toHaveBeenCalledWith('bot-1', 10000, deps.storageRepo);
    });

    it('should throw and set error status when wallet credentials unavailable', async () => {
      walletManager.getWallet.mockResolvedValue(null);

      // BaseBotRunner.start() sets walletCredentials from getWallet result.
      // doStart() checks this.walletCredentials, which will be null.
      await expect(runner.start()).rejects.toThrow('No wallet credentials available');
      expect(runner.status).toBe('error');
      expect(walletManager.releaseWallet).toHaveBeenCalledWith('wallet-1');
    });

    it('should throw when ScriptRunner.start() fails', async () => {
      // Need to set up for after ScriptRunner is constructed
      const originalMock = vi.mocked(ScriptRunner);
      originalMock.mockImplementationOnce(() => {
        mockScriptRunnerInstance = new MockScriptRunner();
        mockScriptRunnerInstance.start.mockRejectedValue(new Error('Worker failed'));
        return mockScriptRunnerInstance as any;
      });

      runner = new ScriptBotRunner(
        makeBotRecord() as any,
        walletManager as any,
        clobClient as any,
        deps as any
      );

      await expect(runner.start()).rejects.toThrow('Worker failed');
      expect(runner.status).toBe('error');
    });
  });

  describe('event forwarding', () => {
    it('should forward script error events', async () => {
      const eventSpy = vi.fn();
      runner.on('bot:event', eventSpy);

      await runner.start();
      mockScriptRunnerInstance.emit('error', { message: 'Script error' });

      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          botId: 'bot-1',
          data: { message: 'Script error' },
        })
      );
    });

    it('should forward custom bot events', async () => {
      const eventSpy = vi.fn();
      runner.on('bot:event', eventSpy);

      await runner.start();
      mockScriptRunnerInstance.emit('event', { type: 'trade', data: { market: 'BTC' } });

      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'trade',
          data: { market: 'BTC' },
        })
      );
    });

    it('should store heartbeat metrics from script', async () => {
      await runner.start();

      mockScriptRunnerInstance.emit('heartbeat', {
        metrics: { trades: 10, uptime: '1h', invalidObj: {} },
      });

      const health = runner.getHealthInfo();
      // Only number/string metrics are kept
      expect(health.metrics).toEqual({ trades: 10, uptime: '1h' });
    });

    it('should filter out non-string/number metrics', async () => {
      await runner.start();

      mockScriptRunnerInstance.emit('heartbeat', {
        metrics: { count: 5, nested: { a: 1 }, list: [1, 2] },
      });

      const health = runner.getHealthInfo();
      expect(health.metrics).toEqual({ count: 5 });
    });
  });

  describe('stop() lifecycle', () => {
    it('should stop ScriptRunner and release wallet', async () => {
      await runner.start();
      await runner.stop();

      expect(mockScriptRunnerInstance.stop).toHaveBeenCalled();
      expect(walletManager.releaseWallet).toHaveBeenCalledWith('wallet-1');
      expect(runner.status).toBe('stopped');
    });

    it('should handle stop when not started', async () => {
      await runner.stop(); // Should not throw
      expect(runner.status).toBe('stopped');
    });
  });

  describe('collectMetrics()', () => {
    it('should request heartbeat from running script and return last metrics', async () => {
      await runner.start();

      // Set some metrics via heartbeat event
      mockScriptRunnerInstance.emit('heartbeat', {
        metrics: { balance: 1000 },
      });

      const health = runner.getHealthInfo();
      expect(mockScriptRunnerInstance.requestHeartbeat).toHaveBeenCalled();
      expect(health.metrics).toEqual({ balance: 1000 });
    });

    it('should return empty metrics when no heartbeat received', async () => {
      await runner.start();
      const health = runner.getHealthInfo();
      expect(health.metrics).toEqual({});
    });
  });

  describe('fatal worker errors (tick watchdog)', () => {
    it('marks the bot error, releases the wallet and emits a fatal error event', async () => {
      await runner.start();
      const events: any[] = [];
      runner.on('bot:error', (e) => events.push(e));

      mockScriptRunnerInstance.emit('fatal', { message: 'onTick hung', reason: 'tick_watchdog' });
      await new Promise((r) => setImmediate(r));

      expect(runner.status).toBe('error');
      expect(walletManager.releaseWallet).toHaveBeenCalledWith('wallet-1');
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({ fatal: true, reason: 'tick_watchdog', message: 'onTick hung' });
    });
  });
});
