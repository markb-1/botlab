/**
 * ctx.fetch for bot scripts, executed in the main process (spec §5.1).
 *
 * Restricted to an allowlist of hosts (limits.yaml `server.script_fetch_allowlist`), https only,
 * GET/POST only, 10 s timeout, 2 MB response cap. Redirects are followed by hand (max 3) and each
 * hop must be allowlisted too. No cookies or credentials are added by the main process.
 * The worker receives a plain, structured-cloneable result and wraps it in a Response-like object.
 */

import { DEFAULT_SCRIPT_FETCH_ALLOWLIST } from '../config/schema';

export const SCRIPT_FETCH_TIMEOUT_MS = 10_000;
export const SCRIPT_FETCH_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

export interface ScriptFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** What crosses the worker boundary. */
export interface ScriptFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface ScriptFetchOptions {
  allowlist?: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Request headers a script may not set. */
const BLOCKED_HEADERS = new Set(['host', 'cookie', 'authorization', 'proxy-authorization', 'connection', 'content-length', 'transfer-encoding']);

function checkUrl(raw: string, allowlist: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`fetch: invalid URL: ${raw}`);
  }
  if (url.protocol !== 'https:') throw new Error(`fetch: only https is allowed (${url.protocol})`);
  if (url.username || url.password) throw new Error('fetch: credentials in URL are not allowed');
  if (url.port && url.port !== '443') throw new Error('fetch: non-standard ports are not allowed');
  const host = url.hostname.toLowerCase();
  if (!allowlist.some((h) => h.toLowerCase() === host)) {
    throw new Error(`fetch: host not allowed: ${host} (allowlist: limits.yaml server.script_fetch_allowlist)`);
  }
  return url;
}

function sanitizeInit(init: unknown): { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string } {
  const i = (init && typeof init === 'object' ? init : {}) as ScriptFetchInit;
  const method = String(i.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') throw new Error(`fetch: method not allowed: ${method}`);
  const headers: Record<string, string> = {};
  if (i.headers && typeof i.headers === 'object') {
    for (const [k, v] of Object.entries(i.headers)) {
      if (typeof v !== 'string' || BLOCKED_HEADERS.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
  }
  let body: string | undefined;
  if (i.body !== undefined && i.body !== null) {
    if (method === 'GET') throw new Error('fetch: GET requests cannot have a body');
    if (typeof i.body !== 'string') throw new Error('fetch: body must be a string');
    if (Buffer.byteLength(i.body) > MAX_REQUEST_BODY_BYTES) throw new Error('fetch: request body too large');
    body = i.body;
  }
  return { method, headers, body };
}

async function readCapped(resp: Response, maxBytes: number): Promise<string> {
  const declared = Number(resp.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`fetch: response too large (${declared} bytes, max ${maxBytes})`);
  }
  if (!resp.body) return '';
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`fetch: response too large (max ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function scriptFetch(rawUrl: unknown, init: unknown, opts: ScriptFetchOptions = {}): Promise<ScriptFetchResult> {
  const allowlist = opts.allowlist ?? DEFAULT_SCRIPT_FETCH_ALLOWLIST;
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? SCRIPT_FETCH_MAX_BYTES;
  const { method, headers, body } = sanitizeInit(init);
  let url = checkUrl(String(rawUrl), allowlist);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? SCRIPT_FETCH_TIMEOUT_MS);
  try {
    let currentMethod = method;
    let currentBody = body;
    for (let hop = 0; ; hop++) {
      let resp: Response;
      try {
        resp = await doFetch(url.toString(), {
          method: currentMethod,
          headers,
          body: currentBody,
          redirect: 'manual',
          credentials: 'omit',
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw new Error(`fetch: timed out after ${opts.timeoutMs ?? SCRIPT_FETCH_TIMEOUT_MS} ms`);
        throw new Error(`fetch: ${err instanceof Error ? err.message : String(err)}`);
      }

      const location = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && location) {
        await resp.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) throw new Error('fetch: too many redirects');
        url = checkUrl(new URL(location, url).toString(), allowlist);
        if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && currentMethod === 'POST')) {
          currentMethod = 'GET';
          currentBody = undefined;
        }
        continue;
      }

      let text: string;
      try {
        text = await readCapped(resp, maxBytes);
      } catch (err) {
        if (controller.signal.aborted) throw new Error(`fetch: timed out after ${opts.timeoutMs ?? SCRIPT_FETCH_TIMEOUT_MS} ms`);
        throw err;
      }
      const outHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        if (k.toLowerCase() !== 'set-cookie') outHeaders[k] = v;
      });
      return { ok: resp.ok, status: resp.status, statusText: resp.statusText, url: url.toString(), headers: outHeaders, body: text };
    }
  } finally {
    clearTimeout(timer);
  }
}
