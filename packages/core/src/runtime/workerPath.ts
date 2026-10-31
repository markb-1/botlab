import fs from 'fs';
import path from 'path';

/**
 * Path of a worker entry module next to the calling module (spec §15.2).
 * Compiled output (`dist-electron/packages/core/src/...`, later the server build) has `<name>.js`
 * beside the caller; running from TypeScript sources under a loader such as tsx, only `<name>.ts`
 * exists and the worker inherits the loader through the parent's execArgv. Uses `path`, so it
 * works with Windows separators.
 */
export function resolveWorkerEntry(dir: string, name: string): string {
  const js = path.join(dir, `${name}.js`);
  if (fs.existsSync(js)) return js;
  const ts = path.join(dir, `${name}.ts`);
  return fs.existsSync(ts) ? ts : js;
}
