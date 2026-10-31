/**
 * Polymarket (and optionally Binance) connectivity check: can this machine / IP use every endpoint BotLab
 * depends on? Used by `npm run cli -- check-polymarket` to vet a VPS before migrating (see README "Hosting on a
 * VPS"). Every request is a read-only GET: no order is placed or cancelled, no API key is created.
 *
 * Two failure kinds are kept apart:
 * - **geo-block** (the country / region is restricted): Polymarket's geoblock endpoint says `blocked`, an HTTP
 *   451, or a known "restricted region / location" error body;
 * - **datacenter / bot protection**: Cloudflare challenge pages (`cf-mitigated`, "Just a moment…"), a 403 with
 *   an HTML body or other 403, 429 and dropped connections.
 *
 * The module is transport-free and network-agnostic: `fetch` is injected (tests use a fake), the CLI passes the
 * global one. The authenticated CLOB probe is injected too (`auth`): this module never sees a private key, and
 * the L1/L2 headers it receives are only sent, never printed.
 */

import { MAX_CLOCK_SKEW_MS } from '../reconcile/Reconciler';

export type CheckClass =
  | 'ok'
  | 'geo_blocked'
  | 'bot_challenge'
  | 'forbidden'
  | 'rate_limited'
  | 'network_error'
  | 'unexpected'
  /** not run (no token id from Gamma, no wallet, no master key, …) */
  | 'skipped';

export type CheckGroup = 'ip' | 'geoblock' | 'clob' | 'gamma' | 'data' | 'clob_auth' | 'binance';

export interface CheckResult {
  id: string;
  group: CheckGroup;
  name: string;
  /** URL without the query string's addresses / tokens beyond what is public */
  url: string | null;
  status: number | null;
  latencyMs: number | null;
  classification: CheckClass;
  detail: string | null;
  /** Counts for the Polymarket verdict (ip / geoblock / binance are reported separately) */
  required: boolean;
}

export type VerdictKind = 'ok' | 'blocked_geo' | 'blocked_bot' | 'degraded';

export interface ConnectivityVerdict {
  kind: VerdictKind;
  /** One line, e.g. "OK: this IP can use Polymarket" */
  line: string;
  hints: string[];
  /** 0 ok, 1 blocked, 2 degraded */
  exitCode: 0 | 1 | 2;
}

export interface GeoblockInfo {
  /** `unavailable`: the endpoint failed or its shape was not the expected one (VERIFY) */
  status: 'allowed' | 'blocked' | 'unavailable';
  country: string | null;
  region: string | null;
  ip: string | null;
  detail: string | null;
}

export interface ConnectivityReport {
  startedAt: string;
  durationMs: number;
  /** From the IP lookup; null when unknown */
  ip: string | null;
  country: string | null;
  geoblock: GeoblockInfo;
  /** CLOB server time − local time (ms, round-trip midpoint); null when unknown */
  clobClockSkewMs: number | null;
  binanceClockSkewMs: number | null;
  /** Host:port of the HTTP(S) proxy the requests went through, or null */
  proxy: string | null;
  checks: CheckResult[];
  verdict: ConnectivityVerdict;
}

/**
 * Read-only authenticated CLOB probe, built by the caller from the configured wallet. `l1Headers` signs the
 * L1 (EIP-712) auth for `GET /auth/derive-api-key` (returns the wallet's existing API key, creates nothing);
 * `l2Headers` signs an L2 request with those credentials. Secrets never leave the returned headers.
 */
export interface ClobAuthProbe {
  /** Shown in the output (an address is public) */
  label: string;
  l1Headers(): Promise<Record<string, string>>;
  l2Headers(creds: ClobApiCreds, method: 'GET', requestPath: string): Promise<Record<string, string>>;
}

export interface ClobApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export interface ConnectivityOptions {
  fetch?: typeof fetch;
  /** Per request (default 10 s) */
  timeoutMs?: number;
  /** Parallel requests (default 3, capped at 3) */
  concurrency?: number;
  now?: () => number;
  clobUrl?: string;
  gammaUrl?: string;
  dataUrl?: string;
  binanceUrl?: string;
  ipLookupUrl?: string;
  geoblockUrl?: string;
  /** Any public address for the data API checks (an unknown address simply returns `[]`) */
  sampleAddress?: string;
  /** Run the Binance public checks */
  binance?: boolean;
  /** Authenticated CLOB probe, or the reason it is skipped (`--with-credentials` without a wallet, …) */
  auth?: ClobAuthProbe | { skip: string };
  /** Proxy the requests go through (shown in the report; the caller configures the transport) */
  proxy?: string | null;
}

export const DEFAULT_CLOB_URL = 'https://clob.polymarket.com';
export const DEFAULT_GAMMA_URL = 'https://gamma-api.polymarket.com';
export const DEFAULT_DATA_URL = 'https://data-api.polymarket.com';
export const DEFAULT_BINANCE_URL = 'https://api.binance.com';
/** Cloudflare's trace endpoint: `ip=` and `loc=` (country), no key */
export const DEFAULT_IP_LOOKUP_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
/**
 * VERIFY: Polymarket's public geoblock endpoint, documented as returning
 * `{ "blocked": boolean, "ip": string, "country": string, "region": string }`. Not checked against the live API
 * from the development sandbox (outbound blocked); any other shape is reported as `unavailable`.
 */
export const DEFAULT_GEOBLOCK_URL = 'https://polymarket.com/api/geoblock';
/** Placeholder public address for the data API checks: an address nobody uses returns an empty list */
export const DEFAULT_SAMPLE_ADDRESS = '0x0000000000000000000000000000000000000001';
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * "restricted region" style bodies (CLOB order refusal, Polymarket docs, Binance 451 / 403) and Cloudflare's
 * country ban page ("Error 1009 … has banned the country or region your IP address is in")
 */
const GEO_BODY =
  /restricted (in your |)(region|location|jurisdiction|country)|trading restricted|not available in your (region|country|jurisdiction)|geo-?block|unavailable from a restricted location|eligibility|banned the country or region|error 1009/i;
const CHALLENGE_BODY =
  /just a moment|attention required|cf-chl|challenge-platform|challenges\.cloudflare\.com|captcha|checking your browser|cf-browser-verification|enable javascript and cookies/i;
const HTML_BODY = /^\s*(<!doctype html|<html|<head|<body)/i;

// ── classification ───────────────────────────────────────────────────

export interface HttpObservation {
  status: number;
  headers: Headers | Record<string, string>;
  body: string;
  /** JSON expected on success (all API endpoints) */
  expectJson: boolean;
}

function header(h: Headers | Record<string, string>, name: string): string | null {
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name);
  const rec = h as Record<string, string>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? rec[key] : null;
}

function isCloudflare(h: Headers | Record<string, string>): boolean {
  return !!header(h, 'cf-ray') || /cloudflare/i.test(header(h, 'server') ?? '');
}

function looksHtml(body: string, h: Headers | Record<string, string>): boolean {
  return HTML_BODY.test(body) || /text\/html/i.test(header(h, 'content-type') ?? '');
}

function parseJson(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false };
  }
}

/** Classifies one HTTP response (the shape of a successful body is checked by the caller). */
export function classifyResponse(obs: HttpObservation): { classification: CheckClass; detail: string | null } {
  const { status, headers, body } = obs;
  const html = looksHtml(body, headers);
  const mitigated = header(headers, 'cf-mitigated');
  if (status === 451) return { classification: 'geo_blocked', detail: `HTTP 451 (unavailable for legal reasons)${snippet(body)}` };
  // Before the challenge markers: a Cloudflare country ban (1009) is an HTML page from Cloudflare too
  if (status >= 400 && GEO_BODY.test(body)) return { classification: 'geo_blocked', detail: `HTTP ${status}${snippet(body)}` };
  if (mitigated) return { classification: 'bot_challenge', detail: `Cloudflare cf-mitigated: ${mitigated} (HTTP ${status})` };
  if (html && CHALLENGE_BODY.test(body) && (isCloudflare(headers) || status === 403 || status === 503 || status === 429)) {
    return { classification: 'bot_challenge', detail: `Cloudflare challenge page (HTTP ${status})` };
  }
  if (status === 429)
    return { classification: 'rate_limited', detail: `HTTP 429${header(headers, 'retry-after') ? ` (retry-after ${header(headers, 'retry-after')})` : ''}` };
  if (status === 403) {
    return {
      classification: 'forbidden',
      detail: `HTTP 403${html ? ' with an HTML page' : ''}${isCloudflare(headers) ? ' from Cloudflare' : ''}${snippet(body)}`,
    };
  }
  if (status < 200 || status >= 300) return { classification: 'unexpected', detail: `HTTP ${status}${snippet(body)}` };
  if (obs.expectJson && !parseJson(body).ok) {
    return { classification: 'unexpected', detail: `HTTP ${status} but not JSON${html ? ' (an HTML page)' : ''}${snippet(body)}` };
  }
  return { classification: 'ok', detail: null };
}

/** Classifies a thrown fetch error (DNS, TLS, reset, timeout, proxy refusal). */
export function classifyError(err: unknown, timeoutMs: number): { classification: CheckClass; detail: string } {
  const e = err as { name?: string } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError')
    return { classification: 'network_error', detail: `timeout after ${Math.round(timeoutMs / 1000)} s` };
  // fetch wraps the real error in `cause` (sometimes twice: TypeError → DOMException → undici error)
  const chain: Array<{ code?: string; message?: string }> = [];
  for (let c: unknown = err; c && typeof c === 'object' && chain.length < 5; c = (c as { cause?: unknown }).cause)
    chain.push(c as { code?: string; message?: string });
  const code = [...chain].reverse().find((c) => typeof c.code === 'string')?.code;
  const msg =
    chain
      .map((c) => c.message)
      .filter(Boolean)
      .join(' / ') || String(err);
  const proxyRefused = /proxy response \((\d+)\)/i.exec(msg);
  if (proxyRefused) return { classification: 'network_error', detail: `the proxy refused the connection (HTTP ${proxyRefused[1]} to CONNECT)` };
  const known: Record<string, string> = {
    ENOTFOUND: 'DNS lookup failed',
    EAI_AGAIN: 'DNS lookup failed (temporary)',
    ECONNRESET: 'connection reset',
    ECONNREFUSED: 'connection refused',
    ETIMEDOUT: 'connection timed out',
    EHOSTUNREACH: 'host unreachable',
    ENETUNREACH: 'network unreachable',
    UND_ERR_SOCKET: 'connection closed by the remote side',
    UND_ERR_CONNECT_TIMEOUT: 'connect timeout',
    UND_ERR_HEADERS_TIMEOUT: 'response headers timeout',
  };
  if (code && known[code]) return { classification: 'network_error', detail: `${known[code]} (${code})` };
  if (code && /CERT|SSL|TLS/i.test(code)) return { classification: 'network_error', detail: `TLS error (${code})` };
  return { classification: 'network_error', detail: `${code ? `${code}: ` : ''}${oneLine(msg, 160)}` };
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function snippet(body: string): string {
  if (!body) return '';
  if (HTML_BODY.test(body)) {
    const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1];
    return title ? `: "${oneLine(title, 80)}"` : '';
  }
  return `: ${oneLine(body, 120)}`;
}

/** Removes every occurrence of the given secrets from a text (defence in depth for authenticated checks). */
export function redactSecrets(text: string | null, secrets: Array<string | undefined>): string | null {
  if (text == null) return text;
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[redacted]');
  return out;
}

// ── runner ───────────────────────────────────────────────────────────

interface Ctx {
  fetch: typeof fetch;
  timeoutMs: number;
  now: () => number;
}

interface Probe<T> {
  result: CheckResult;
  /** Parsed JSON (or text for `text` probes) when ok */
  value?: T;
  /** Local times around the request (clock skew) */
  t0?: number;
  t1?: number;
}

interface ProbeSpec {
  id: string;
  group: CheckGroup;
  name: string;
  url: string;
  required: boolean;
  headers?: Record<string, string>;
  /** `text` for the IP lookup; JSON otherwise */
  text?: boolean;
  /** Validates the parsed body; returns an error detail for a wrong shape */
  shape?: (value: unknown) => string | null;
  /** Never put any of the body into the detail (authenticated responses) */
  secretBody?: boolean;
  secrets?: string[];
  /** Shown instead of the URL (query strings with addresses, …) */
  displayUrl?: string;
}

async function probe<T>(ctx: Ctx, spec: ProbeSpec): Promise<Probe<T>> {
  const base: CheckResult = {
    id: spec.id,
    group: spec.group,
    name: spec.name,
    url: spec.displayUrl ?? spec.url,
    status: null,
    latencyMs: null,
    classification: 'network_error',
    detail: null,
    required: spec.required,
  };
  const t0 = ctx.now();
  try {
    const resp = await ctx.fetch(spec.url, {
      method: 'GET',
      headers: { Accept: spec.text ? 'text/plain, */*' : 'application/json', 'User-Agent': 'BotLab-connectivity-check', ...(spec.headers ?? {}) },
      // fetch forwards custom headers (POLY_*) across origins on a redirect: never follow one with credentials
      redirect: spec.headers ? 'manual' : 'follow',
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
    if (spec.headers && resp.status >= 300 && resp.status < 400) {
      await resp.body?.cancel().catch(() => undefined);
      let to = 'elsewhere';
      try {
        to = new URL(resp.headers.get('location') ?? '', spec.url).host || to;
      } catch {
        /* unparseable Location */
      }
      return {
        result: {
          ...base,
          status: resp.status,
          latencyMs: ctx.now() - t0,
          classification: 'unexpected',
          detail: `HTTP ${resp.status} redirect to ${to} not followed (credentials are never sent to a redirect)`,
        },
      };
    }
    const body = await resp.text();
    const t1 = ctx.now();
    const c = classifyResponse({ status: resp.status, headers: resp.headers, body, expectJson: !spec.text });
    const result: CheckResult = { ...base, status: resp.status, latencyMs: t1 - t0, classification: c.classification, detail: c.detail };
    let value: T | undefined;
    if (c.classification === 'ok') {
      if (spec.text) value = body as unknown as T;
      else {
        const parsed = parseJson(body);
        value = parsed.ok ? (parsed.value as T) : undefined;
      }
      const wrong = spec.shape ? spec.shape(value) : null;
      if (wrong) {
        result.classification = 'unexpected';
        result.detail = `unexpected response: ${wrong}`;
        value = undefined;
      }
    }
    // Authenticated responses: no body text in the output, only the status
    if (spec.secretBody && result.classification !== 'ok' && result.detail) result.detail = `HTTP ${resp.status}`;
    result.detail = redactSecrets(result.detail, spec.secrets ?? []);
    return { result, value, t0, t1 };
  } catch (err) {
    const c = classifyError(err, ctx.timeoutMs);
    return { result: { ...base, latencyMs: ctx.now() - t0, classification: c.classification, detail: redactSecrets(c.detail, spec.secrets ?? []) } };
  }
}

async function pool<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return out;
}

function skipped(id: string, group: CheckGroup, name: string, detail: string, required: boolean): CheckResult {
  return { id, group, name, url: null, status: null, latencyMs: null, classification: 'skipped', detail, required };
}

const isArray = (v: unknown) => (Array.isArray(v) ? null : 'expected a JSON array');
const isObject = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? null : 'expected a JSON object');

function parseTrace(text: string): { ip: string | null; country: string | null } {
  const get = (k: string) => new RegExp(`^${k}=(.+)$`, 'm').exec(text)?.[1]?.trim() ?? null;
  return { ip: get('ip'), country: get('loc') };
}

function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Skew = server − local midpoint, minus half the round trip (given to the local clock) and the resolution */
function skew(serverMs: number, t0: number, t1: number): number {
  return Math.round(serverMs - (t0 + t1) / 2);
}

const trim = (u: string) => u.replace(/\/+$/, '');

export async function runConnectivityCheck(opts: ConnectivityOptions = {}): Promise<ConnectivityReport> {
  const ctx: Ctx = {
    fetch: opts.fetch ?? globalThis.fetch,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    now: opts.now ?? Date.now,
  };
  const concurrency = Math.max(1, Math.min(3, opts.concurrency ?? 3));
  const clob = trim(opts.clobUrl ?? DEFAULT_CLOB_URL);
  const gamma = trim(opts.gammaUrl ?? DEFAULT_GAMMA_URL);
  const data = trim(opts.dataUrl ?? DEFAULT_DATA_URL);
  const binance = trim(opts.binanceUrl ?? DEFAULT_BINANCE_URL);
  const address = opts.sampleAddress ?? DEFAULT_SAMPLE_ADDRESS;
  const started = ctx.now();
  const checks: CheckResult[] = [];

  // Phase 1: who are we, are we geoblocked, CLOB time, Gamma (for a token id)
  const [ipP, geoP, timeP, gmP, geP] = await pool<Probe<unknown>>(
    [
      () =>
        probe(ctx, {
          id: 'ip',
          group: 'ip',
          name: 'Public IP / country (Cloudflare trace)',
          url: opts.ipLookupUrl ?? DEFAULT_IP_LOOKUP_URL,
          required: false,
          text: true,
        }),
      () =>
        probe(ctx, {
          id: 'geoblock',
          group: 'geoblock',
          name: 'Polymarket geoblock endpoint',
          url: opts.geoblockUrl ?? DEFAULT_GEOBLOCK_URL,
          required: false,
          shape: isObject,
        }),
      () =>
        probe(ctx, {
          id: 'clob_time',
          group: 'clob',
          name: 'CLOB GET /time',
          url: `${clob}/time`,
          required: true,
          shape: (v) => (Number.isFinite(Number(v)) ? null : 'expected a number of seconds'),
        }),
      () =>
        probe(ctx, {
          id: 'gamma_markets',
          group: 'gamma',
          name: 'Gamma GET /markets',
          url: `${gamma}/markets?limit=1&active=true&closed=false&order=volume24hr&ascending=false`,
          required: true,
          shape: isArray,
        }),
      () => probe(ctx, { id: 'gamma_events', group: 'gamma', name: 'Gamma GET /events', url: `${gamma}/events?limit=1`, required: true, shape: isArray }),
    ],
    concurrency
  );
  checks.push(ipP.result, geoP.result, timeP.result, gmP.result, geP.result);

  const trace = typeof ipP.value === 'string' ? parseTrace(ipP.value) : { ip: null, country: null };
  if (ipP.result.classification === 'ok' && !trace.ip) {
    ipP.result.classification = 'unexpected';
    ipP.result.detail = 'no ip= line in the trace';
  } else if (ipP.result.classification === 'ok') ipP.result.detail = `${trace.ip}${trace.country ? ` (${trace.country})` : ''}`;

  const geoblock = readGeoblock(geoP);
  const clobClockSkewMs =
    timeP.value !== undefined && timeP.t0 !== undefined && timeP.t1 !== undefined ? skew(Number(timeP.value) * 1000, timeP.t0, timeP.t1) : null;
  if (clobClockSkewMs !== null) timeP.result.detail = `clock skew ${formatSkew(clobClockSkewMs)} (1 s resolution)`;

  const market = Array.isArray(gmP.value) ? (gmP.value[0] as Record<string, unknown> | undefined) : undefined;
  const tokenId = market ? parseList(market.clobTokenIds)[0] : undefined;
  const conditionId = market && typeof market.conditionId === 'string' ? market.conditionId : undefined;
  if (market && typeof market.question === 'string') gmP.result.detail = `top market: ${oneLine(market.question, 60)}`;

  // Phase 2: order book and market on the CLOB, data API
  const phase2: Array<() => Promise<Probe<unknown>>> = [
    () =>
      probe(ctx, {
        id: 'data_positions',
        group: 'data',
        name: 'Data API GET /positions',
        url: `${data}/positions?user=${address}&limit=1`,
        required: true,
        shape: isArray,
      }),
    () =>
      probe(ctx, {
        id: 'data_activity',
        group: 'data',
        name: 'Data API GET /activity',
        url: `${data}/activity?user=${address}&limit=1&type=TRADE`,
        required: true,
        shape: isArray,
      }),
  ];
  if (tokenId) {
    phase2.unshift(() =>
      probe(ctx, {
        id: 'clob_book',
        group: 'clob',
        name: 'CLOB GET /book',
        url: `${clob}/book?token_id=${encodeURIComponent(tokenId)}`,
        displayUrl: `${clob}/book?token_id=${tokenId.slice(0, 10)}…`,
        required: true,
        shape: (v) =>
          v && typeof v === 'object' && Array.isArray((v as { bids?: unknown }).bids) && Array.isArray((v as { asks?: unknown }).asks)
            ? null
            : 'expected { bids: [], asks: [] }',
      })
    );
  }
  if (conditionId) {
    phase2.unshift(() =>
      probe(ctx, {
        id: 'clob_market',
        group: 'clob',
        name: 'CLOB GET /markets/{condition_id}',
        url: `${clob}/markets/${encodeURIComponent(conditionId)}`,
        displayUrl: `${clob}/markets/${conditionId.slice(0, 10)}…`,
        required: true,
        shape: isObject,
      })
    );
  }
  const phase2Results = await pool(phase2, concurrency);
  const byId = new Map(phase2Results.map((p) => [p.result.id, p.result]));
  const noMarket =
    gmP.result.classification === 'ok' ? 'Gamma returned no active market with a token id' : 'needs a token id from Gamma /markets, which failed';
  checks.push(
    byId.get('clob_market') ?? skipped('clob_market', 'clob', 'CLOB GET /markets/{condition_id}', noMarket, true),
    byId.get('clob_book') ?? skipped('clob_book', 'clob', 'CLOB GET /book', noMarket, true),
    byId.get('data_positions')!,
    byId.get('data_activity')!
  );

  // Phase 3: authenticated read-only CLOB calls (sequential)
  if (opts.auth) checks.push(...(await authChecks(ctx, clob, opts.auth)));

  // Phase 4: Binance public
  let binanceClockSkewMs: number | null = null;
  if (opts.binance) {
    const [ping, time] = await pool<Probe<unknown>>(
      [
        () =>
          probe(ctx, {
            id: 'binance_ping',
            group: 'binance',
            name: 'Binance GET /api/v3/ping',
            url: `${binance}/api/v3/ping`,
            required: false,
            shape: isObject,
          }),
        () =>
          probe(ctx, {
            id: 'binance_time',
            group: 'binance',
            name: 'Binance GET /api/v3/time',
            url: `${binance}/api/v3/time`,
            required: false,
            shape: (v) => (Number.isFinite(Number((v as { serverTime?: unknown } | undefined)?.serverTime)) ? null : 'expected { serverTime }'),
          }),
      ],
      concurrency
    );
    if (time.value !== undefined && time.t0 !== undefined && time.t1 !== undefined) {
      binanceClockSkewMs = skew(Number((time.value as { serverTime: number }).serverTime), time.t0, time.t1);
      time.result.detail = `clock skew ${formatSkew(binanceClockSkewMs)}`;
    }
    checks.push(ping.result, time.result);
  }

  const partial = { ip: trace.ip, country: trace.country, geoblock, clobClockSkewMs, binanceClockSkewMs, proxy: opts.proxy ?? null, checks };
  return { startedAt: new Date(started).toISOString(), durationMs: ctx.now() - started, ...partial, verdict: computeVerdict(partial) };
}

function readGeoblock(p: Probe<unknown>): GeoblockInfo {
  const none: GeoblockInfo = { status: 'unavailable', country: null, region: null, ip: null, detail: null };
  if (p.result.classification !== 'ok') {
    // A geo answer from the endpoint itself (451 / restricted body) still counts as blocked
    if (p.result.classification === 'geo_blocked') return { ...none, status: 'blocked', detail: p.result.detail };
    return { ...none, detail: `${p.result.classification}${p.result.detail ? `: ${p.result.detail}` : ''} (VERIFY the endpoint)` };
  }
  const v = p.value as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' && x ? x : null);
  if (typeof v.blocked !== 'boolean') {
    p.result.classification = 'unexpected';
    p.result.detail = `no boolean "blocked" field (keys: ${Object.keys(v).slice(0, 8).join(', ') || 'none'}) — VERIFY the endpoint`;
    return { ...none, detail: p.result.detail };
  }
  const info: GeoblockInfo = { status: v.blocked ? 'blocked' : 'allowed', country: str(v.country), region: str(v.region), ip: str(v.ip), detail: null };
  const where = [info.country, info.region].filter(Boolean).join('/');
  p.result.detail = `${v.blocked ? 'BLOCKED' : 'not blocked'}${where ? ` (${where})` : ''}`;
  if (v.blocked) p.result.classification = 'geo_blocked';
  return info;
}

async function authChecks(ctx: Ctx, clob: string, auth: ClobAuthProbe | { skip: string }): Promise<CheckResult[]> {
  const name = 'CLOB authenticated (read-only)';
  if ('skip' in auth) return [skipped('clob_auth', 'clob_auth', name, auth.skip, false)];
  if (!/^https:\/\//i.test(clob)) return [skipped('clob_auth', 'clob_auth', name, `refusing to send credentials to a non-https CLOB URL (${clob})`, false)];
  const out: CheckResult[] = [];
  let l1: Record<string, string>;
  try {
    l1 = await auth.l1Headers();
  } catch (err) {
    return [skipped('clob_auth', 'clob_auth', name, `cannot sign with the wallet: ${oneLine(err instanceof Error ? err.message : String(err), 120)}`, false)];
  }
  // GET /auth/derive-api-key returns the wallet's existing CLOB API key (L1 signature); it creates nothing
  const derive = await probe<Record<string, unknown>>(ctx, {
    id: 'clob_auth_derive',
    group: 'clob_auth',
    name: `CLOB GET /auth/derive-api-key (${auth.label})`,
    url: `${clob}/auth/derive-api-key`,
    required: true,
    headers: l1,
    secretBody: true,
    shape: isObject,
  });
  const v = derive.value;
  const creds: ClobApiCreds | null =
    v && typeof v.apiKey === 'string' && typeof v.secret === 'string' && typeof v.passphrase === 'string'
      ? { key: v.apiKey, secret: v.secret, passphrase: v.passphrase }
      : null;
  if (derive.result.classification === 'ok' && !creds) {
    derive.result.classification = 'unexpected';
    derive.result.detail = 'no API key in the response';
  }
  if (derive.result.status === 400 && derive.result.classification === 'unexpected') {
    // "Could not derive api key!": the wallet never created one. Reaching the endpoint is what matters here.
    derive.result.classification = 'skipped';
    derive.result.required = false;
    derive.result.detail = 'no CLOB API key exists for this wallet yet (BotLab creates one on first live use; this check never creates one)';
  }
  out.push(derive.result);
  if (!creds) return out;

  const secrets = [creds.key, creds.secret, creds.passphrase];
  const l2 = async (id: string, label: string, path: string, shape: (v: unknown) => string | null) => {
    let headers: Record<string, string>;
    try {
      headers = await auth.l2Headers(creds, 'GET', path);
    } catch (err) {
      return {
        result: skipped(id, 'clob_auth', label, `cannot sign: ${oneLine(err instanceof Error ? err.message : String(err), 120)}`, false),
      } as Probe<unknown>;
    }
    return probe<unknown>(ctx, { id, group: 'clob_auth', name: label, url: `${clob}${path}`, required: true, headers, secretBody: true, secrets, shape });
  };
  const keys = await l2('clob_auth_keys', 'CLOB GET /auth/api-keys (L2)', '/auth/api-keys', isObject);
  if (keys.result.classification === 'ok') keys.result.detail = 'authenticated';
  out.push(keys.result);
  const closed = await l2('clob_auth_closed_only', 'CLOB GET /auth/ban-status/closed-only (L2)', '/auth/ban-status/closed-only', (x) =>
    typeof (x as { closed_only?: unknown } | undefined)?.closed_only === 'boolean' ? null : 'expected { closed_only: boolean }'
  );
  if (closed.result.classification === 'ok') {
    const closedOnly = (closed.value as { closed_only: boolean }).closed_only;
    closed.result.detail = closedOnly ? 'account is in CLOSE-ONLY mode' : 'account not restricted';
    if (closedOnly) closed.result.classification = 'forbidden';
  }
  out.push(closed.result);
  return out;
}

// ── verdict ──────────────────────────────────────────────────────────

const GEO_HINTS = [
  'Polymarket restricts this country / region. Pick a provider region in an allowed country and test again.',
  'Do not use a VPN or proxy to get around a geo restriction: it breaks the Polymarket Terms of Service and can get the account closed (funds then only withdrawable).',
];
const BOT_HINTS = [
  "This IP range looks blocked as a datacenter / by bot protection. Try another provider or region (many clouds' ranges are filtered), or run BotLab from a home connection.",
  'Re-run the check later: some blocks are temporary; keep a new VPS only if repeated checks are OK.',
];

export function formatSkew(ms: number): string {
  return `${ms >= 0 ? '+' : ''}${(ms / 1000).toFixed(1)} s`;
}

export function computeVerdict(r: Omit<ConnectivityReport, 'verdict' | 'startedAt' | 'durationMs'>): ConnectivityVerdict {
  const required = r.checks.filter((c) => c.required && c.classification !== 'skipped');
  const failing = required.filter((c) => c.classification !== 'ok');
  const names = (cs: CheckResult[]) => cs.map((c) => c.id).join(', ');
  const hints: string[] = [];
  if (r.proxy) hints.push(`Requests went through the proxy ${r.proxy}: these results describe the proxy's IP, not this machine's.`);

  const geo = failing.filter((c) => c.classification === 'geo_blocked');
  if (r.geoblock.status === 'blocked' || geo.length > 0) {
    const where = [r.geoblock.country ?? r.country, r.geoblock.region].filter(Boolean).join('/');
    const why = [r.geoblock.status === 'blocked' ? 'geoblock endpoint says blocked' : null, geo.length ? `geo errors on ${names(geo)}` : null]
      .filter(Boolean)
      .join('; ');
    return { kind: 'blocked_geo', line: `BLOCKED (geo): ${why}${where ? ` [${where}]` : ''}`, hints: [...hints, ...GEO_HINTS], exitCode: 1 };
  }

  const bot = failing.filter((c) => c.classification === 'bot_challenge' || (c.classification === 'forbidden' && c.id !== 'clob_auth_closed_only'));
  const net = failing.filter((c) => c.classification === 'network_error');
  const ipOk = r.checks.find((c) => c.id === 'ip')?.classification === 'ok';
  if (bot.length > 0) {
    return {
      kind: 'blocked_bot',
      line: `BLOCKED (datacenter/bot protection): ${bot.map((c) => `${c.id} ${c.classification}`).join(', ')}`,
      hints: [...hints, ...BOT_HINTS],
      exitCode: 1,
    };
  }
  if (required.length > 0 && net.length === required.length) {
    if (ipOk) {
      return {
        kind: 'blocked_bot',
        line: `BLOCKED (datacenter/bot protection): every Polymarket request failed at the connection level while other sites work (${net[0].detail ?? 'network error'})`,
        hints: [...hints, ...BOT_HINTS],
        exitCode: 1,
      };
    }
    return {
      kind: 'degraded',
      line: `DEGRADED: no request succeeded, not even the IP lookup (${net[0].detail ?? 'network error'}) — check this machine's internet access, DNS, firewall or proxy`,
      hints,
      exitCode: 2,
    };
  }

  const problems: string[] = [];
  if (failing.length > 0) problems.push(failing.map((c) => `${c.id} ${c.classification}`).join(', '));
  const closedOnly = r.checks.find((c) => c.id === 'clob_auth_closed_only' && c.classification === 'forbidden');
  if (closedOnly) {
    hints.push(
      'Close-only mode: Polymarket lets this account only reduce positions (typically after access from a restricted region). Contact Polymarket support; do not trade around it.'
    );
  }
  if (r.clobClockSkewMs !== null && Math.abs(r.clobClockSkewMs) - 1000 > MAX_CLOCK_SKEW_MS) {
    problems.push(`clock skew ${formatSkew(r.clobClockSkewMs)} vs the CLOB (live orders are refused beyond ${MAX_CLOCK_SKEW_MS / 1000} s)`);
    hints.push('Enable time sync (NTP / chrony / systemd-timesyncd / Windows Time) on this machine.');
  }
  const bin = r.checks.filter((c) => c.group === 'binance' && c.classification !== 'ok' && c.classification !== 'skipped');
  if (bin.length > 0) {
    problems.push(`Binance: ${bin.map((c) => `${c.id} ${c.classification}`).join(', ')}`);
    if (bin.some((c) => c.classification === 'geo_blocked'))
      hints.push('Binance restricts this location (HTTP 451 / restricted location): Binance bots will not work from here.');
  }
  if (failing.some((c) => c.classification === 'rate_limited'))
    hints.push('HTTP 429 on a handful of requests suggests the IP range is rate limited; re-run in a few minutes.');
  if (r.geoblock.status === 'unavailable') hints.push('The Polymarket geoblock endpoint could not be read; the verdict rests on the API checks.');

  if (problems.length > 0) return { kind: 'degraded', line: `DEGRADED: ${problems.join('; ')}`, hints, exitCode: 2 };
  return { kind: 'ok', line: 'OK: this IP can use Polymarket', hints, exitCode: 0 };
}

// ── text output ──────────────────────────────────────────────────────

export function formatReport(r: ConnectivityReport): string {
  const lines: string[] = [];
  const where = [r.ip ?? 'unknown IP', r.country ? `country ${r.country}` : null].filter(Boolean).join(', ');
  lines.push(`Connectivity check — ${where}${r.proxy ? ` (via proxy ${r.proxy})` : ''}`);
  const geo = r.geoblock;
  lines.push(
    `Polymarket geoblock: ${geo.status === 'unavailable' ? `unavailable${geo.detail ? ` (${geo.detail})` : ''}` : `${geo.status}${geo.country ? ` (${[geo.country, geo.region].filter(Boolean).join('/')})` : ''}`}`
  );
  lines.push('');
  const rows = r.checks.map((c) => [
    c.name,
    c.status === null ? '-' : String(c.status),
    c.latencyMs === null ? '-' : `${c.latencyMs} ms`,
    c.classification,
    c.detail ?? '',
  ]);
  const head = ['Check', 'HTTP', 'Latency', 'Result', 'Detail'];
  const width = (i: number) => Math.max(head[i].length, ...rows.map((row) => row[i].length));
  const widths = [0, 1, 2, 3].map(width);
  const fmt = (row: string[]) =>
    row
      .map((cell, i) => (i < 4 ? cell.padEnd(widths[i]) : cell))
      .join('  ')
      .trimEnd();
  lines.push(fmt(head));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  ') + '  ------');
  for (const row of rows) lines.push(fmt(row));
  lines.push('');
  lines.push(r.verdict.line);
  for (const h of r.verdict.hints) lines.push(`  - ${h}`);
  return lines.join('\n');
}
