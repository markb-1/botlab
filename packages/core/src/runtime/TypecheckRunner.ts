/**
 * Runs script typechecks in a worker thread (PROGRESS R144): one at a time, a short queue, a hard timeout
 * that terminates the worker, and V8 heap limits. The worker is kept between checks (the parsed lib files
 * stay cached) and replaced after a timeout or crash. Unref'd: it never keeps the process alive.
 */

import type { Worker } from 'worker_threads';
import { resolveWorkerEntry, startWorker } from './workerPath';
import type { TypecheckResult } from './typecheckScript';

export const TYPECHECK_TIMEOUT_MS = 10_000;
export const TYPECHECK_MAX_QUEUE = 2;
export const TYPECHECK_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 };

/** The check could not finish (timeout, memory limit, busy); the message is meant for the caller */
export class TypecheckLimitError extends Error {
  constructor(
    message: string,
    readonly reason: 'timeout' | 'memory' | 'busy' | 'crashed'
  ) {
    super(message);
    this.name = 'TypecheckLimitError';
  }
}

interface Job {
  source: string;
  resolve: (r: TypecheckResult) => void;
  reject: (e: Error) => void;
}

export class TypecheckRunner {
  private worker: Worker | null = null;
  private queue: Job[] = [];
  private busy = false;
  private nextId = 1;
  private closed = false;

  constructor(private opts: { timeoutMs?: number; maxQueue?: number } = {}) {}

  run(source: string): Promise<TypecheckResult> {
    if (this.closed) return Promise.reject(new TypecheckLimitError('typecheck unavailable: shutting down', 'busy'));
    if (this.queue.length >= (this.opts.maxQueue ?? TYPECHECK_MAX_QUEUE)) {
      return Promise.reject(new TypecheckLimitError('typecheck busy: too many checks waiting; try again shortly', 'busy'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ source, resolve, reject });
      this.pump();
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = startWorker(resolveWorkerEntry(__dirname, 'typecheck-worker'), { resourceLimits: TYPECHECK_RESOURCE_LIMITS, env: {} });
    w.unref();
    this.worker = w;
    return w;
  }

  private kill(): void {
    const w = this.worker;
    this.worker = null;
    if (w) {
      w.removeAllListeners();
      w.on('error', () => undefined);
      void w.terminate().catch(() => undefined);
    }
  }

  private pump(): void {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    const id = this.nextId++;
    let w: Worker;
    try {
      w = this.ensureWorker();
    } catch (err) {
      this.busy = false;
      job.reject(new TypecheckLimitError(`typecheck worker failed to start: ${err instanceof Error ? err.message : String(err)}`, 'crashed'));
      this.pump();
      return;
    }
    const timeoutMs = this.opts.timeoutMs ?? TYPECHECK_TIMEOUT_MS;
    const done = (fn: () => void) => {
      clearTimeout(timer);
      w.off('message', onMessage);
      w.off('error', onError);
      w.off('exit', onExit);
      this.busy = false;
      fn();
      this.pump();
    };
    const onMessage = (m: { id: number; result?: TypecheckResult; error?: string }) => {
      if (m.id !== id) return;
      done(() => (m.result ? job.resolve(m.result) : job.reject(new TypecheckLimitError(`typecheck failed: ${m.error ?? 'unknown error'}`, 'crashed'))));
    };
    const onError = (err: Error & { code?: string }) => {
      this.kill();
      const memory = err.code === 'ERR_WORKER_OUT_OF_MEMORY';
      done(() =>
        job.reject(
          memory
            ? new TypecheckLimitError(
                `typecheck exceeded the memory limit (${TYPECHECK_RESOURCE_LIMITS.maxOldGenerationSizeMb} MB): simplify the types`,
                'memory'
              )
            : new TypecheckLimitError(`typecheck crashed: ${err.message}`, 'crashed')
        )
      );
    };
    const onExit = () => {
      this.worker = null;
      done(() => job.reject(new TypecheckLimitError('typecheck worker exited', 'crashed')));
    };
    const timer = setTimeout(() => {
      this.kill();
      done(() => job.reject(new TypecheckLimitError(`typecheck timed out after ${Math.round(timeoutMs / 1000)} s: simplify the types`, 'timeout')));
    }, timeoutMs);
    w.on('message', onMessage);
    w.on('error', onError);
    w.on('exit', onExit);
    w.postMessage({ id, source: job.source });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const j of this.queue.splice(0)) j.reject(new TypecheckLimitError('typecheck unavailable: shutting down', 'busy'));
    this.kill();
  }
}
