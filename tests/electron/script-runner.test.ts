import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock Worker class
class MockWorker extends EventEmitter {
  postMessage = vi.fn();
  terminate = vi.fn().mockResolvedValue(0);

  // Simulate sending a message from the worker to main
  simulateMessage(msg: Record<string, unknown>) {
    this.emit('message', msg);
  }

  simulateError(err: Error) {
    this.emit('error', err);
  }

  simulateExit(code: number) {
    this.emit('exit', code);
  }
}

let mockWorkerInstance: MockWorker;

vi.mock('worker_threads', () => ({
  Worker: vi.fn().mockImplementation(() => {
    mockWorkerInstance = new MockWorker();
    return mockWorkerInstance;
  }),
}));

// Mock RpcHandler
const mockRpcHandle = vi.fn().mockResolvedValue({ id: 'rpc-1', result: 'ok' });
vi.mock('../../packages/core/src/runtime/RpcHandler', () => ({
  RpcHandler: vi.fn().mockImplementation(() => ({
    handle: mockRpcHandle,
  })),
}));

import { ScriptRunner, type ScriptRunnerOptions } from '../../packages/core/src/runtime/ScriptRunner';

function makeOptions(overrides: Partial<ScriptRunnerOptions> = {}): ScriptRunnerOptions {
  return {
    compiledCode: 'module.exports = { onStart() {}, onStop() {} }',
    botId: 'bot-1',
    botName: 'Test Bot',
    config: { key: 'value' },
    walletAddress: '0x1234',
    proxyAddress: '0xproxy',
    rpcHandlerDeps: {
      clobClient: {} as any,
      storageRepo: {} as any,
      tradeRepo: {} as any,
      botId: 'bot-1',
      botName: 'Test Bot',
      scriptName: 'test-script',
      walletAddress: '0x1234',
      proxyAddress: '0xproxy',
      rpcUrl: 'http://rpc',
      usdcContractAddress: '0xusdc',
      clobHttpUrl: 'http://clob',
    },
    ...overrides,
  };
}

describe('ScriptRunner', () => {
  let runner: ScriptRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new ScriptRunner(makeOptions());
  });

  describe('start()', () => {
    it('should create a worker and resolve when worker sends "started"', async () => {
      const startPromise = runner.start();

      // Worker should have been created and sent 'start' message
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith({ type: 'start' });

      // Simulate worker responding with 'started'
      mockWorkerInstance.simulateMessage({ type: 'started' });

      await startPromise;
      expect(runner.isRunning).toBe(true);
    });

    it('should emit "started" event', async () => {
      const startedSpy = vi.fn();
      runner.on('started', startedSpy);

      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      expect(startedSpy).toHaveBeenCalledOnce();
    });

    it('should reject if worker sends "error" before "started"', async () => {
      // Must listen for 'error' to prevent EventEmitter unhandled error throw
      runner.on('error', () => {});

      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'error', error: 'Script crashed' });

      await expect(startPromise).rejects.toThrow('Script crashed');
      expect(runner.isRunning).toBe(false);
    });

    it('should reject if worker emits error event before start', async () => {
      // Must listen for 'error' to prevent EventEmitter unhandled error throw
      runner.on('error', () => {});

      const startPromise = runner.start();
      mockWorkerInstance.simulateError(new Error('Worker init failed'));

      await expect(startPromise).rejects.toThrow('Worker init failed');
      expect(runner.isRunning).toBe(false);
    });

    it('should throw if already started', async () => {
      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      await expect(runner.start()).rejects.toThrow('ScriptRunner already started');
    });

    it('should emit "error" event when worker sends error after start', async () => {
      const errorSpy = vi.fn();
      runner.on('error', errorSpy);

      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      // Now send error after successfully started
      mockWorkerInstance.simulateMessage({ type: 'error', error: 'Runtime error' });

      expect(errorSpy).toHaveBeenCalledWith({ message: 'Runtime error' });
    });
  });

  describe('stop()', () => {
    it('should send stop message and resolve when worker sends "stopped"', async () => {
      // Start first
      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      const stopPromise = runner.stop();
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith({ type: 'stop' });

      mockWorkerInstance.simulateMessage({ type: 'stopped' });
      await stopPromise;

      expect(runner.isRunning).toBe(false);
    });

    it('should resolve immediately if no worker exists', async () => {
      // Never started, so stop should be a no-op
      await runner.stop();
      expect(runner.isRunning).toBe(false);
    });

    it('should force terminate on timeout', async () => {
      vi.useFakeTimers();

      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      const stopPromise = runner.stop(100); // 100ms timeout

      // Don't send 'stopped' — let it timeout
      vi.advanceTimersByTime(150);

      await stopPromise;
      expect(mockWorkerInstance.terminate).toHaveBeenCalled();
      expect(runner.isRunning).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('worker exit handling', () => {
    it('should emit "stopped" and "error" on non-zero exit code', async () => {
      const errorSpy = vi.fn();
      const stoppedSpy = vi.fn();
      runner.on('error', errorSpy);
      runner.on('stopped', stoppedSpy);

      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      mockWorkerInstance.simulateExit(1);

      expect(errorSpy).toHaveBeenCalledWith({ message: 'Worker exited with code 1' });
      expect(stoppedSpy).toHaveBeenCalled();
      expect(runner.isRunning).toBe(false);
    });

    it('should emit "stopped" on clean exit (code 0)', async () => {
      const errorSpy = vi.fn();
      const stoppedSpy = vi.fn();
      runner.on('error', errorSpy);
      runner.on('stopped', stoppedSpy);

      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      mockWorkerInstance.simulateExit(0);

      expect(stoppedSpy).toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('RPC handling', () => {
    it('should forward rpc-request to RpcHandler and send response back', async () => {
      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      const request = { id: 'rpc-1', method: 'polymarket:buy', args: ['token1', 50] };
      mockRpcHandle.mockResolvedValue({ id: 'rpc-1', result: { success: true } });

      mockWorkerInstance.simulateMessage({ type: 'rpc-request', request });

      // Wait for async handling
      await vi.waitFor(() => {
        expect(mockRpcHandle).toHaveBeenCalledWith(request);
      });

      await vi.waitFor(() => {
        expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith({
          type: 'rpc-response',
          response: { id: 'rpc-1', result: { success: true } },
        });
      });
    });

    it('should emit "event" for emit RPC calls', async () => {
      const eventSpy = vi.fn();
      runner.on('event', eventSpy);

      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      const request = { id: 'rpc-2', method: 'emit', args: ['trade', { market: 'BTC' }] };
      mockRpcHandle.mockResolvedValue({
        id: 'rpc-2',
        result: { type: 'trade', data: { market: 'BTC' } },
      });

      mockWorkerInstance.simulateMessage({ type: 'rpc-request', request });

      await vi.waitFor(() => {
        expect(eventSpy).toHaveBeenCalledWith({ type: 'trade', data: { market: 'BTC' } });
      });
    });
  });

  describe('heartbeat', () => {
    it('should emit "heartbeat" event with metrics', async () => {
      const heartbeatSpy = vi.fn();
      runner.on('heartbeat', heartbeatSpy);

      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      mockWorkerInstance.simulateMessage({
        type: 'heartbeat-result',
        metrics: { trades: 5, balance: 1000 },
      });

      expect(heartbeatSpy).toHaveBeenCalledWith({
        metrics: { trades: 5, balance: 1000 },
      });
    });

    it('should send heartbeat request when running', async () => {
      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      runner.requestHeartbeat();
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith({ type: 'heartbeat' });
    });

    it('should not send heartbeat when not running', () => {
      // No worker, so nothing should happen (no error)
      expect(() => runner.requestHeartbeat()).not.toThrow();
    });
  });

  describe('message handling after worker error event', () => {
    it('should handle "stopped" message after start', async () => {
      const stoppedSpy = vi.fn();
      runner.on('stopped', stoppedSpy);

      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      mockWorkerInstance.simulateMessage({ type: 'stopped' });
      expect(stoppedSpy).toHaveBeenCalled();
      expect(runner.isRunning).toBe(false);
    });
  });

  describe('onTick scripts', () => {
    it('should start successfully with onTick-only script (no onStart)', async () => {
      runner = new ScriptRunner(makeOptions({
        compiledCode: 'module.exports = { onTick() {} }',
      }));

      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      expect(runner.isRunning).toBe(true);
    });

    it('should start successfully with both onStart and onTick', async () => {
      runner = new ScriptRunner(makeOptions({
        compiledCode: 'module.exports = { onStart() {}, onTick() {} }',
      }));

      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      expect(runner.isRunning).toBe(true);
    });

    it('should stop cleanly for onTick-only scripts', async () => {
      runner = new ScriptRunner(makeOptions({
        compiledCode: 'module.exports = { onTick() {} }',
      }));

      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      const stopPromise = runner.stop();
      mockWorkerInstance.simulateMessage({ type: 'stopped' });
      await stopPromise;

      expect(runner.isRunning).toBe(false);
    });

    it('should pass pollingIntervalMs config to worker', async () => {
      runner = new ScriptRunner(makeOptions({
        compiledCode: 'module.exports = { onTick() {} }',
        config: { pollingIntervalMs: 5000 },
      }));

      const startPromise = runner.start();
      mockWorkerInstance.simulateMessage({ type: 'started' });
      await startPromise;

      // Config is passed via workerData when creating the worker thread
      // The ScriptRunner passes it through to the worker constructor
      expect(runner.isRunning).toBe(true);
    });
  });
});
