/**
 * Keep exchange credentials out of logs.
 *
 * @polymarket/clob-client's HTTP error handler prints `JSON.stringify(err.response.config)` with
 * console.error. That config holds the L2 auth headers (POLY_API_KEY, POLY_PASSPHRASE, POLY_SIGNATURE, …)
 * and, for orders, a body whose `owner` is the API key. A response-error interceptor on the axios
 * default instance (the one clob-client calls; package.json `overrides` makes it the root axios)
 * replaces credential headers with "[redacted]" and drops the request body before the error reaches
 * that handler. The error keeps its response (status, data), so clob-client still returns
 * `{ error, status }`.
 *
 * `installCredentialRedaction()` is idempotent and runs at import of this module's users
 * (orders.ts, BotManager, createCore), i.e. before any ClobClient exists.
 */

import { createRequire } from 'module';

const REDACTED = '[redacted]';
/** POLY_* (L1/L2/builder auth), Authorization-style and API-key headers */
const SENSITIVE_HEADER = /^(poly[_-].*|authorization|proxy-authorization|cookie|x-mbx-apikey|x-api-key|api-key|x-.*-signature)$/i;
const INSTALLED = Symbol.for('botlab.credentialRedaction');

type AnyRecord = Record<string, unknown>;

interface AxiosLike {
  interceptors: { response: { use(onOk: undefined, onErr: (err: unknown) => unknown): number } };
  [INSTALLED]?: boolean;
}

function plainHeaders(h: unknown): AnyRecord | null {
  if (!h || typeof h !== 'object') return null;
  const toJSON = (h as { toJSON?: () => unknown }).toJSON;
  const obj = typeof toJSON === 'function' ? toJSON.call(h) : h;
  return obj && typeof obj === 'object' ? { ...(obj as AnyRecord) } : null;
}

/** Redact one axios request config in place (headers, body, basic auth). */
export function redactAxiosConfig(config: unknown): void {
  if (!config || typeof config !== 'object') return;
  const c = config as AnyRecord;
  const headers = plainHeaders(c.headers);
  if (headers) {
    for (const k of Object.keys(headers)) if (SENSITIVE_HEADER.test(k)) headers[k] = REDACTED;
    c.headers = headers;
  }
  if ('data' in c && c.data !== undefined) c.data = REDACTED;
  if ('auth' in c && c.auth !== undefined) c.auth = REDACTED;
}

/** Redact the request side of an axios error in place; the response (status, body) is kept. */
export function redactAxiosError(err: unknown): unknown {
  if (err && typeof err === 'object') {
    const e = err as AnyRecord & { response?: AnyRecord };
    redactAxiosConfig(e.config);
    if (e.response && typeof e.response === 'object') {
      redactAxiosConfig(e.response.config);
      // The underlying ClientRequest holds the raw headers too
      if ('request' in e.response) e.response.request = undefined;
    }
    if ('request' in e) e.request = undefined;
  }
  return err;
}

function install(axios: unknown): void {
  const a = axios as AxiosLike | null;
  if (!a || (typeof a !== 'object' && typeof a !== 'function')) return;
  if (!a.interceptors?.response || a[INSTALLED]) return;
  a.interceptors.response.use(undefined, (err: unknown) => Promise.reject(redactAxiosError(err)));
  a[INSTALLED] = true;
}

function load(req: NodeRequire, id: string): unknown {
  try {
    const m = req(id) as { default?: unknown };
    return m && typeof m === 'object' && 'default' in m && m.default ? m.default : m;
  } catch {
    return null;
  }
}

/**
 * Register the redaction on the axios default instance(s) that clob-client and BotLab use. Resolved
 * from clob-client's own location, so it is the instance clob-client calls even if axios is ever
 * installed twice.
 */
export function installCredentialRedaction(): void {
  const here = createRequire(__filename);
  install(load(here, 'axios'));
  try {
    const clob = createRequire(here.resolve('@polymarket/clob-client'));
    install(load(clob, 'axios'));
  } catch {
    /* clob-client not installed: nothing to protect */
  }
}

installCredentialRedaction();
