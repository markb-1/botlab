/**
 * ScriptRunner - manages a single worker thread for a bot script.
 * Spawns the worker, forwards RPC requests to RpcHandler,
 * and handles lifecycle messages (started, stopped, error, heartbeat).
 */

import { Worker } from 'worker_threads';
import path from 'path';
import { EventEmitter } from 'events';
import type {
  WorkerToMainMessage,
  MainToWorkerMessage,
  RpcRequest,
} from '../sdk/types';
import { RpcHandler } from './RpcHandler';
import type { RpcHandlerDeps } from './RpcHandler';
import type { PaperTradingState } from './PaperTradingState';
import { SCRIPT_WORKER_RESOURCE_LIMITS } from './sandbox';

/** A tick (onTick) running longer than this counts one watchdog strike per period (spec §5.1). */
export const TICK_TIMEOUT_MS = 30_000;
/** Consecutive strikes before the worker is terminated and the bot marked `error`. */
export const MAX_TICK_TIMEOUTS = 3;
/** Module load + onStart must finish within this, or the worker is terminated. */
export const START_TIMEOUT_MS = 60_000;

export interface ScriptRunnerOptions {
  compiledCode: string;
  botId: string;
  botName: string;
  config: Record<string, unknown>;
  walletAddress: string;
  proxyAddress?: string;
  rpcHandlerDeps: RpcHandlerDeps;
  paperState?: PaperTradingState;
  /** Path of the compiled worker bootstrap (default: worker-bootstrap.js next to this file) */
  bootstrapPath?: string;
  tickTimeoutMs?: number;
  maxTickTimeouts?: number;
  startTimeoutMs?: number;
}

/**
 * Events emitted by ScriptRunner:
 * - 'started': worker script's onStart completed
 * - 'stopped': worker script's onStop completed (or worker terminated)
 * - 'error': { message: string } - script error
 * - 'heartbeat': { metrics: Record<string, unknown> } - heartbeat response
 * - 'event': { type: string, data?: Record<string, unknown> } - custom bot event
 * - 'log': { level: string, args: unknown[] } - log from script
 * - 'tick-timeout': { strikes: number, elapsedMs: number } - an onTick exceeded the tick timeout
 * - 'fatal': { message: string, reason: 'tick_watchdog' | 'worker_exit' } - the worker died or was
 *   terminated while running (not via stop()); the bot must be marked `error`
 */
export class ScriptRunner extends EventEmitter {
  private worker: Worker | null = null;
  private rpcHandler: RpcHandler;
  private options: ScriptRunnerOptions;
  private running = false;
  private stopRequested = false;
  /** The worker reported 'started' (an exit after this, without stop(), is fatal) */
  private startedOk = false;
  // Tick watchdog
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickStartedAt = 0;
  private tickStruck = false;
  private tickStrikes = 0;
  private fatalReason: 'tick_watchdog' | null = null;

  constructor(options: ScriptRunnerOptions) {
    super();
    this.options = options;
    this.rpcHandler = new RpcHandler(options.rpcHandlerDeps, options.paperState);
  }

  /**
   * Spawn the worker thread and send 'start' message
   */
  async start(): Promise<void> {
    if (this.worker) {
      throw new Error('ScriptRunner already started');
    }

    return new Promise<void>((resolve, reject) => {
      // Worker bootstrap is compiled to dist-electron/electron/runtime/worker-bootstrap.js
      const bootstrapPath = this.options.bootstrapPath ?? path.join(__dirname, 'worker-bootstrap.js');

      this.worker = new Worker(bootstrapPath, {
        workerData: {
          compiledCode: this.options.compiledCode,
          botId: this.options.botId,
          botName: this.options.botName,
          config: this.options.config,
          walletAddress: this.options.walletAddress,
          proxyAddress: this.options.proxyAddress,
        },
        // Scripts cannot read the app's environment (secrets) and get bounded heaps (spec §5.1)
        env: {},
        resourceLimits: SCRIPT_WORKER_RESOURCE_LIMITS,
      });
      const worker = this.worker;

      let startResolved = false;
      const startTimer = setTimeout(() => {
        if (startResolved) return;
        startResolved = true;
        const message = `Script did not start within ${Math.round(this.startTimeoutMs / 1000)} s; worker terminated`;
        this.emit('error', { message });
        void worker.terminate();
        reject(new Error(message));
      }, this.startTimeoutMs);
      startTimer.unref?.();

      this.worker.on('message', async (msg: WorkerToMainMessage) => {
        switch (msg.type) {
          case 'started':
            if (startResolved) break; // start already timed out
            clearTimeout(startTimer);
            this.running = true;
            this.startedOk = true;
            startResolved = true;
            this.emit('started');
            resolve();
            break;

          case 'stopped':
            this.running = false;
            this.emit('stopped');
            break;

          case 'error':
            this.emit('error', { message: msg.error });
            if (!startResolved) {
              startResolved = true;
              clearTimeout(startTimer);
              reject(new Error(msg.error));
            }
            break;

          case 'tick-start':
            this.onTickStart();
            break;

          case 'tick-end':
            this.onTickEnd();
            break;

          case 'heartbeat-result':
            this.emit('heartbeat', { metrics: msg.metrics });
            break;

          case 'rpc-request':
            await this.handleRpcRequest(msg.request);
            break;
        }
      });

      worker.on('error', (err) => {
        this.running = false;
        this.emit('error', { message: err.message });
        if (!startResolved) {
          startResolved = true;
          clearTimeout(startTimer);
          reject(err);
        }
      });

      worker.on('exit', (code) => {
        this.running = false;
        if (this.worker === worker) this.worker = null;
        this.clearTickWatchdog();
        clearTimeout(startTimer);
        if (!startResolved) {
          startResolved = true;
          reject(new Error(`Worker exited with code ${code} before starting`));
        }
        if (code !== 0 && !this.fatalReason) {
          this.emit('error', { message: `Worker exited with code ${code}` });
        }
        // Died or was killed while running, not through stop(): the bot must be marked error
        if (this.startedOk && !this.stopRequested) {
          const reason = this.fatalReason ?? 'worker_exit';
          const message = reason === 'tick_watchdog'
            ? `onTick did not finish within ${Math.round(this.tickTimeoutMs / 1000)} s ${this.maxTickTimeouts} times in a row; worker terminated`
            : `Worker exited unexpectedly (code ${code})`;
          this.emit('fatal', { message, reason });
        }
        this.emit('stopped');
      });

      // Send start command to worker
      this.sendToWorker({ type: 'start' });
    });
  }

  /**
   * Send stop message to worker and wait for clean shutdown
   */
  async stop(timeoutMs = 10000): Promise<void> {
    if (!this.worker) return;
    this.stopRequested = true;
    this.clearTickWatchdog();

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Force terminate if worker doesn't stop in time
        if (this.worker) {
          this.worker.terminate();
          this.worker = null;
          this.running = false;
        }
        resolve();
      }, timeoutMs);

      this.once('stopped', () => {
        clearTimeout(timer);
        resolve();
      });

      this.sendToWorker({ type: 'stop' });
    });
  }

  /**
   * Request a heartbeat from the worker
   */
  requestHeartbeat(): void {
    if (this.worker && this.running) {
      this.sendToWorker({ type: 'heartbeat' });
    }
  }

  /**
   * Check if the worker is running
   */
  get isRunning(): boolean {
    return this.running;
  }

  private get tickTimeoutMs(): number {
    return this.options.tickTimeoutMs ?? TICK_TIMEOUT_MS;
  }

  private get maxTickTimeouts(): number {
    return this.options.maxTickTimeouts ?? MAX_TICK_TIMEOUTS;
  }

  private get startTimeoutMs(): number {
    return this.options.startTimeoutMs ?? START_TIMEOUT_MS;
  }

  /**
   * Tick watchdog (spec §5.1). Runs on the main thread so it also catches a worker blocked in a
   * synchronous loop. Every full tick-timeout period a tick stays unsettled is one strike; a tick that
   * settles without a strike resets the count. `maxTickTimeouts` consecutive strikes ⇒ terminate.
   */
  private onTickStart(): void {
    this.clearTickWatchdog();
    this.tickStartedAt = Date.now();
    this.tickStruck = false;
    this.tickTimer = setInterval(() => this.onTickStrike(), this.tickTimeoutMs);
    this.tickTimer.unref?.();
  }

  private onTickEnd(): void {
    this.clearTickWatchdog();
    if (!this.tickStruck) this.tickStrikes = 0;
  }

  private onTickStrike(): void {
    this.tickStruck = true;
    this.tickStrikes++;
    const elapsedMs = Date.now() - this.tickStartedAt;
    this.emit('tick-timeout', { strikes: this.tickStrikes, elapsedMs });
    if (this.tickStrikes >= this.maxTickTimeouts && this.worker && !this.stopRequested) {
      this.clearTickWatchdog();
      this.fatalReason = 'tick_watchdog';
      void this.worker.terminate();
    }
  }

  private clearTickWatchdog(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * Handle an RPC request from the worker
   */
  private async handleRpcRequest(request: RpcRequest): Promise<void> {
    const response = await this.rpcHandler.handle(request);

    // Check if the RPC was an 'emit' call - forward as a bot event
    if (request.method === 'emit' && response.result) {
      const eventData = response.result as { type: string; data?: Record<string, unknown> };
      this.emit('event', eventData);
    }

    // Check if the RPC was a 'log' call - forward as a bot log event
    if (request.method === 'log' && response.result) {
      const logData = response.result as { botId: string; level: string; message: string };
      this.emit('log', logData);
    }

    this.sendToWorker({ type: 'rpc-response', response });
  }

  /**
   * Send a message to the worker
   */
  private sendToWorker(msg: MainToWorkerMessage): void {
    if (this.worker) {
      this.worker.postMessage(msg);
    }
  }
}
