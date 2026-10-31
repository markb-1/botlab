/**
 * Script sandbox helpers shared by the bot worker and the backtest worker (spec §5.1).
 *
 * LIMITS — read before relying on this: worker_threads are NOT a security boundary. The script runs in
 * the same V8 isolate as the worker bootstrap, so this only stops casual or accidental access:
 *  - no `require` (compile step rejects imports; the factory receives `require`/`process` = undefined),
 *  - the worker's own `process` (getBuiltinModule, env, binding, exit...), `fetch`, `WebSocket`,
 *    `EventSource` and `BroadcastChannel` globals are deleted before script code runs, so
 *    `globalThis.process` / `Function('return this')().process` are gone too,
 *  - the worker is started with `env: {}` and V8 heap limits; network goes through the allowlisted ctx.fetch.
 * A determined script can still find ways around this (prototype tampering of objects it shares with the
 * bootstrap, V8/Node bugs, timing). Untrusted code needs a real isolate/process sandbox; out of scope (v3).
 */

import type { ResourceLimits } from 'worker_threads';

/** V8 heap limits for every script worker (bot and backtest). */
export const SCRIPT_WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 32,
};

/** Globals removed inside a script worker before the script is evaluated. */
export const REMOVED_WORKER_GLOBALS = ['process', 'fetch', 'WebSocket', 'EventSource', 'BroadcastChannel'] as const;

/**
 * Delete escape-hatch globals from the current worker. Call only inside a worker thread, after
 * capturing anything the bootstrap itself needs (e.g. `const proc = process`).
 */
export function hardenWorkerGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  for (const name of REMOVED_WORKER_GLOBALS) {
    try {
      delete g[name];
    } catch {
      /* non-configurable: shadowed in the factory below instead */
    }
    if (name in g) {
      try {
        Object.defineProperty(g, name, { value: undefined, writable: false, configurable: false });
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Evaluate compiled CommonJS script code. The script sees only `module`, `exports` and `ctx`;
 * `require` and `process` are shadowed with undefined (also when hardening was not applied, e.g. tests).
 */
export function evaluateScript(compiledCode: string, ctx: unknown): Record<string, unknown> {
  const moduleExports: Record<string, unknown> = {};
  const moduleObj = { exports: moduleExports };
  const factory = new Function('module', 'exports', 'ctx', 'require', 'process', compiledCode);
  factory(moduleObj, moduleExports, ctx, undefined, undefined);
  return moduleObj.exports as Record<string, unknown>;
}
