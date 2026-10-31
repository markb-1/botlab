import fs from 'fs';
import path from 'path';
import { Worker, type WorkerOptions } from 'worker_threads';

/**
 * Path of a worker entry module next to the calling module (spec §15.2).
 * Compiled output (`dist/packages/core/src/...`) has `<name>.js` beside the caller; running from
 * TypeScript sources under tsx (`npm run dev`), only `<name>.ts` exists. Uses `path`, so it works with
 * Windows separators.
 */
export function resolveWorkerEntry(dir: string, name: string): string {
  const js = path.join(dir, `${name}.js`);
  if (fs.existsSync(js)) return js;
  const ts = path.join(dir, `${name}.ts`);
  return fs.existsSync(ts) ? ts : js;
}

/**
 * Starts a worker on `entry`. A `.ts` entry (dev under tsx) cannot be a worker's main module: tsx's
 * loader does not apply to it even though the worker inherits `--import tsx` (verified with tsx 4.23 on
 * Node 22: "Cannot use import statement outside a module"). It is then loaded through a small eval'd
 * CommonJS shim that registers tsx's require hook first; the tsx path is resolved here, in the parent,
 * so it does not depend on the worker's cwd. Compiled `.js` entries start directly.
 */
export function startWorker(entry: string, options: WorkerOptions = {}): Worker {
  if (!entry.endsWith('.ts')) return new Worker(entry, options);
  const tsxApi = require.resolve('tsx/cjs/api');
  const shim = `require(${JSON.stringify(tsxApi)}).register();\nrequire(${JSON.stringify(entry)});\n`;
  return new Worker(shim, { ...options, eval: true });
}
