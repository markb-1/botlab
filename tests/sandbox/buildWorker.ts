/**
 * Bundles a worker entry (TypeScript) to a temp .js file so tests can spawn real worker threads.
 */

import * as esbuild from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';

const cache = new Map<string, Promise<string>>();

export function buildWorker(entry: string): Promise<string> {
  let p = cache.get(entry);
  if (!p) {
    p = (async () => {
      const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-worker-'));
      const outfile = path.join(outdir, path.basename(entry).replace(/\.ts$/, '.js'));
      await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        outfile,
        logLevel: 'silent',
      });
      return outfile;
    })();
    cache.set(entry, p);
  }
  return p;
}

export const ROOT = path.resolve(__dirname, '..', '..');
