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

export interface ScriptRunnerOptions {
  compiledCode: string;
  botId: string;
  botName: string;
  config: Record<string, unknown>;
  walletAddress: string;
  proxyAddress?: string;
  rpcHandlerDeps: RpcHandlerDeps;
  paperState?: PaperTradingState;
}

/**
 * Events emitted by ScriptRunner:
 * - 'started': worker script's onStart completed
 * - 'stopped': worker script's onStop completed (or worker terminated)
 * - 'error': { message: string } - script error
 * - 'heartbeat': { metrics: Record<string, unknown> } - heartbeat response
 * - 'event': { type: string, data?: Record<string, unknown> } - custom bot event
 * - 'log': { level: string, args: unknown[] } - log from script
 */
export class ScriptRunner extends EventEmitter {
  private worker: Worker | null = null;
  private rpcHandler: RpcHandler;
  private options: ScriptRunnerOptions;
  private running = false;

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
      const bootstrapPath = path.join(__dirname, 'worker-bootstrap.js');

      this.worker = new Worker(bootstrapPath, {
        workerData: {
          compiledCode: this.options.compiledCode,
          botId: this.options.botId,
          botName: this.options.botName,
          config: this.options.config,
          walletAddress: this.options.walletAddress,
          proxyAddress: this.options.proxyAddress,
        },
      });

      let startResolved = false;

      this.worker.on('message', async (msg: WorkerToMainMessage) => {
        switch (msg.type) {
          case 'started':
            this.running = true;
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
              reject(new Error(msg.error));
            }
            break;

          case 'heartbeat-result':
            this.emit('heartbeat', { metrics: msg.metrics });
            break;

          case 'rpc-request':
            await this.handleRpcRequest(msg.request);
            break;
        }
      });

      this.worker.on('error', (err) => {
        this.running = false;
        this.emit('error', { message: err.message });
        if (!startResolved) {
          startResolved = true;
          reject(err);
        }
      });

      this.worker.on('exit', (code) => {
        this.running = false;
        this.worker = null;
        if (code !== 0) {
          this.emit('error', { message: `Worker exited with code ${code}` });
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
