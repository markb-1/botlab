/**
 * Script sandbox helpers shared by the bot worker and the backtest worker (spec §5.1).
 *
 * Two layers:
 *  1. The script is evaluated in its own `vm` context created with `codeGeneration: { strings: false,
 *     wasm: false }` and no `importModuleDynamically`: inside it `eval`, `Function`, the async/generator
 *     function constructors (incl. via `Reflect.construct` or `globalThis.constructor.constructor`) throw
 *     EvalError and `import()` is rejected. The context global has a null-prototype backing object holding
 *     only a few harmless worker globals (timers, console, URL, TextEncoder/Decoder...). No require/process.
 *  2. Objects the script receives (ctx and its methods, RPC results, errors, timers) belong to the worker
 *     realm, whose Function constructor would compile code without restriction. `hardenWorkerRealm()` removes
 *     every route to it: `constructor` on Function.prototype and on the async / generator / async-generator
 *     function prototypes becomes a non-configurable undefined, as do the worker's global `Function`, `eval`,
 *     `process`, `fetch`, `WebSocket`, `EventSource`, `BroadcastChannel` and `Error.prepareStackTrace`.
 *  Plus: worker started with `env: {}` and V8 heap limits; network only through the allowlisted ctx.fetch.
 *
 * LIMITS — read before relying on this: this is NOT a hard security boundary. The script still shares the
 * V8 isolate and process with the worker bootstrap; the known escapes above are closed, but unknown
 * cross-realm paths, V8/Node bugs or side channels may remain. Untrusted code needs a process/OS sandbox.
 */

import vm from 'vm';
import type { ResourceLimits } from 'worker_threads';

/** V8 heap limits for every script worker (bot and backtest). */
export const SCRIPT_WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 32,
};

/** Globals removed from the worker realm before the script is evaluated. */
export const REMOVED_WORKER_GLOBALS = [
  'process',
  'fetch',
  'WebSocket',
  'EventSource',
  'BroadcastChannel',
  'Function',
  'eval',
] as const;

/** Worker globals a script may use (exposed inside its vm context). */
const CONTEXT_GLOBALS = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
  'structuredClone',
  'console',
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'atob',
  'btoa',
] as const;

function lockUndefined(obj: object, prop: string): void {
  try {
    Object.defineProperty(obj, prop, { value: undefined, writable: false, enumerable: false, configurable: false });
  } catch {
    // Non-configurable already: try plain deletion / assignment as a fallback
    try {
      delete (obj as Record<string, unknown>)[prop];
    } catch {
      /* best effort */
    }
  }
}

/**
 * Close the worker realm's code-generation routes. Call only inside a worker thread, after the bootstrap
 * has captured what it needs (e.g. `const proc = process`) and before any script code runs. Irreversible.
 */
export function hardenWorkerRealm(): void {
  // Prototypes of the four function kinds (obtained without calling any constructor)
  const protos = [
    Function.prototype,
    Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {}),
  ] as object[];
  for (const p of protos) lockUndefined(p, 'constructor');

  // Error.prepareStackTrace would hand out CallSite objects
  lockUndefined(Error, 'prepareStackTrace');

  const g = globalThis as Record<string, unknown>;
  for (const name of REMOVED_WORKER_GLOBALS) lockUndefined(g, name);
}

/** A fresh restricted context for one script. */
export function createScriptContext(): vm.Context {
  const backing = Object.create(null) as Record<string, unknown>;
  const g = globalThis as Record<string, unknown>;
  for (const name of CONTEXT_GLOBALS) {
    if (g[name] !== undefined) backing[name] = g[name];
  }
  return vm.createContext(backing, {
    name: 'bot-script',
    codeGeneration: { strings: false, wasm: false },
  });
}

/**
 * Evaluate compiled CommonJS script code in a restricted vm context. The script sees only `module`,
 * `exports` and `ctx` (plus the context globals above); `require` and `process` do not exist there.
 */
export function evaluateScript(compiledCode: string, ctx: unknown): Record<string, unknown> {
  const context = createScriptContext();
  // module/exports are created inside the context, so their prototypes are the restricted realm's
  const moduleObj = vm.runInContext('({ exports: {} })', context) as { exports: Record<string, unknown> };
  const factory = vm.runInContext(
    `(function (module, exports, ctx, require, process) {\n${compiledCode}\n})`,
    context,
    { filename: 'bot-script.js' }
  ) as (m: unknown, e: unknown, c: unknown, r: undefined, p: undefined) => void;
  factory(moduleObj, moduleObj.exports, ctx, undefined, undefined);
  return moduleObj.exports;
}
