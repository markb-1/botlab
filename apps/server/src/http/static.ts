/**
 * Static serving of the built web app with SPA fallback: files under the web dir by path; any other
 * GET that is not `/api/*` and has no file extension gets `index.html`. Hashed assets are cached for a
 * year, index.html never.
 */

import fs from 'fs';
import path from 'path';
import type { Context } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function fileResponse(c: Context, file: string, cache: string): Response {
  const body = fs.readFileSync(file);
  return c.body(body, 200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': cache,
  });
}

export function serveWeb(webDir: string) {
  const root = path.resolve(webDir);
  const index = path.join(root, 'index.html');
  return (c: Context): Response => {
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text('Bad request', 400);
    }
    if (rel.includes('\0')) return c.text('Bad request', 400);
    const file = path.resolve(root, `.${path.posix.normalize(rel)}`);
    // Never outside the web dir (path.relative handles Windows drive letters and separators)
    const inside = path.relative(root, file);
    if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) {
      try {
        if (fs.statSync(file).isFile()) {
          const immutable = inside.split(path.sep)[0] === 'assets';
          return fileResponse(c, file, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
        }
      } catch {
        /* not a file */
      }
    }
    if (path.extname(rel)) return c.text('Not found', 404);
    return fileResponse(c, index, 'no-cache');
  };
}
