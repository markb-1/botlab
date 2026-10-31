/**
 * Raw (uncompiled) CommonJS script that tries every known way out of the sandbox and reports, per attempt,
 * either `blocked: <ErrorName>: <message>` or `ESCAPED` (it obtained child_process, fs, worker_threads'
 * parentPort, or the real process object). Passed to workers as compiledCode, so literal `import()` stays.
 *
 * `report(results)` is a statement appended by the caller (ctx.emit for bots, throw for backtests).
 */

export function escapeProbe(report: string): string {
  return `
const IMP = "import('node:child_process')";
const IMP_WT = "import('node:worker_threads')";
function escaped(v) {
  if (!v || (typeof v !== 'object' && typeof v !== 'function')) return false;
  try {
    return !!(v.execSync || v.readFileSync || v.parentPort || v.getBuiltinModule || (v.env && v.pid) ||
      (v.default && (v.default.execSync || v.default.readFileSync || v.default.parentPort)));
  } catch (e) { return false; }
}
async function attempt(results, name, fn) {
  try {
    let v = fn();
    if (v && typeof v.then === 'function') v = await v;
    if (v && typeof v.next === 'function') { v = v.next(); if (v && typeof v.then === 'function') v = await v; v = v && v.value; }
    if (v && typeof v.then === 'function') v = await v;
    results[name] = escaped(v) ? 'ESCAPED' : 'nothing:' + typeof v;
  } catch (e) {
    results[name] = 'blocked: ' + (e && e.name) + ': ' + (e && e.message);
  }
}
async function probe(ctx) {
  const results = {};
  let ctxError = null;
  try { await ctx.fetch('https://evil.example.com/'); } catch (e) { ctxError = e; }
  const p = ctx.storage.get('x'); p.catch(() => {});
  await attempt(results, 'Function', () => Function('return ' + IMP)());
  await attempt(results, 'newFunction', () => new Function('return process')());
  await attempt(results, 'eval', () => eval(IMP));
  await attempt(results, 'indirectEval', () => (0, eval)(IMP_WT));
  await attempt(results, 'literalImport', () => import('node:child_process'));
  await attempt(results, 'ctxMethodConstructor', () => ctx.log.info.constructor('return ' + IMP)());
  await attempt(results, 'ctxNestedMethodConstructor', () => ctx.binance.getPrice.constructor('return ' + IMP_WT)());
  await attempt(results, 'ctxCallConstructor', () => ctx.log.info.call.constructor('return ' + IMP)());
  await attempt(results, 'ctxProtoConstructor', () => Object.getPrototypeOf(ctx.log.info).constructor('return ' + IMP)());
  await attempt(results, 'ctxConfigConstructor', () => ctx.config.constructor.constructor('return ' + IMP)());
  await attempt(results, 'ctxObjectConstructor', () => ctx.constructor.constructor('return ' + IMP)());
  await attempt(results, 'ctxPromiseConstructor', () => p.constructor.constructor('return ' + IMP)());
  await attempt(results, 'ctxPromiseThenConstructor', () => p.then.constructor('return ' + IMP)());
  await attempt(results, 'ctxErrorConstructor', () => ctxError.constructor.constructor('return ' + IMP)());
  await attempt(results, 'ctxAsyncFnConstructor', () => Object.getPrototypeOf(ctx.storage.get).constructor('return ' + IMP)());
  await attempt(results, 'timerConstructor', () => setTimeout.constructor('return ' + IMP)());
  await attempt(results, 'timerObjectConstructor', () => { const t = setTimeout(() => {}, 0); clearTimeout(t); return t.constructor.constructor('return ' + IMP)(); });
  await attempt(results, 'consoleConstructor', () => console.log.constructor('return ' + IMP)());
  await attempt(results, 'asyncFnConstructor', () => (async () => {}).constructor('return ' + IMP)());
  await attempt(results, 'generatorConstructor', () => (function* () {}).constructor('yield ' + IMP)());
  await attempt(results, 'asyncGeneratorConstructor', () => (async function* () {}).constructor('yield ' + IMP)());
  await attempt(results, 'reflectConstruct', () => Reflect.construct(Function, ['return ' + IMP])());
  await attempt(results, 'reflectConstructCtx', () => Reflect.construct(ctx.log.info.constructor, ['return ' + IMP])());
  await attempt(results, 'globalThisConstructor', () => globalThis.constructor.constructor('return ' + IMP)());
  await attempt(results, 'thisConstructor', function () { return this.constructor.constructor('return ' + IMP)(); });
  await attempt(results, 'requireProcess', () => (typeof require !== 'undefined' ? require('child_process') : null) || (typeof process !== 'undefined' ? process : null));
  await attempt(results, 'globalProcess', () => globalThis.process);
  await attempt(results, 'prepareStackTrace', () => {
    const E = ctxError.constructor;
    E.prepareStackTrace = (e, cs) => cs;
    const st = new E('x').stack;
    if (Array.isArray(st)) for (const cs of st) { const t = cs.getThis && cs.getThis(); if (t && t.process) return t.process; const f = cs.getFunction && cs.getFunction(); if (f) return { execSync: true }; }
    return null;
  });
  await attempt(results, 'wasm', () => WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
  return results;
}
module.exports.onStart = async function (ctx) {
  const results = await probe(ctx);
  ${report}
};
module.exports.onTick = async function (ctx) {};
`;
}

/** Attempt names that must be reported as blocked or empty, never ESCAPED. */
export const PROBE_ATTEMPTS = [
  'Function', 'newFunction', 'eval', 'indirectEval', 'literalImport', 'ctxMethodConstructor',
  'ctxNestedMethodConstructor', 'ctxCallConstructor', 'ctxProtoConstructor', 'ctxConfigConstructor',
  'ctxObjectConstructor', 'ctxPromiseConstructor', 'ctxPromiseThenConstructor', 'ctxErrorConstructor',
  'ctxAsyncFnConstructor', 'timerConstructor', 'timerObjectConstructor', 'consoleConstructor',
  'asyncFnConstructor', 'generatorConstructor', 'asyncGeneratorConstructor', 'reflectConstruct',
  'reflectConstructCtx', 'globalThisConstructor', 'thisConstructor', 'requireProcess', 'globalProcess',
  'prepareStackTrace', 'wasm',
];
