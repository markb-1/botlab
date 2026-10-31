import { describe, it, expect } from 'vitest';
import {
  classifyError,
  classifyResponse,
  formatReport,
  runConnectivityCheck,
  type ClobAuthProbe,
  type ConnectivityOptions,
} from '../../packages/core/src/ops/connectivityCheck';

/** Never the live API: every URL is answered by a route table. */
type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });
const html = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });

const TOKEN = '71321045679252212594626385532706912750332728571942532289631379312455583992563';
const CONDITION = '0xabc0000000000000000000000000000000000000000000000000000000000001';
const NOW = 1_800_000_000_000;

function healthy(): Record<string, Route> {
  return {
    'cdn-cgi/trace': () => new Response('fl=1\nh=www.cloudflare.com\nip=203.0.113.7\nts=1\nloc=IE\n', { status: 200 }),
    'polymarket.com/api/geoblock': () => json({ blocked: false, ip: '203.0.113.7', country: 'IE', region: 'L' }),
    'clob.polymarket.com/time': () => json(Math.floor(NOW / 1000)),
    'gamma-api.polymarket.com/markets': () => json([{ question: 'Will it rain?', conditionId: CONDITION, clobTokenIds: JSON.stringify([TOKEN, '2']) }]),
    'gamma-api.polymarket.com/events': () => json([{ id: '1' }]),
    'clob.polymarket.com/markets/': () => json({ condition_id: CONDITION }),
    'clob.polymarket.com/book': () => json({ bids: [], asks: [] }),
    'data-api.polymarket.com/positions': () => json([]),
    'data-api.polymarket.com/activity': () => json([]),
    'api.binance.com/api/v3/ping': () => json({}),
    'api.binance.com/api/v3/time': () => json({ serverTime: NOW }),
    'clob.polymarket.com/auth/derive-api-key': () => json({ apiKey: 'key-1234567890', secret: 'secret-abcdefgh', passphrase: 'pass-xyz123' }),
    'clob.polymarket.com/auth/api-keys': () => json({ apiKeys: ['key-1234567890'] }),
    'clob.polymarket.com/auth/ban-status/closed-only': () => json({ closed_only: false }),
  };
}

function fakeFetch(routes: Record<string, Route>, calls: Array<{ url: string; init?: RequestInit }> = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    // Longest matching key first (".../markets/" before ".../markets")
    const key = Object.keys(routes)
      .filter((k) => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`unrouted ${url}`);
    return routes[key](url, init);
  }) as typeof fetch;
}

const netError = (code: string) => () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
};

function run(routes: Record<string, Route>, extra: ConnectivityOptions = {}, calls?: Array<{ url: string; init?: RequestInit }>) {
  return runConnectivityCheck({ fetch: fakeFetch(routes, calls), now: () => NOW, ...extra });
}

const byId = (r: Awaited<ReturnType<typeof run>>, id: string) => r.checks.find((c) => c.id === id)!;

const authProbe: ClobAuthProbe = {
  label: 'wallet "Main" 0x1',
  l1Headers: async () => ({ POLY_ADDRESS: '0x1', POLY_SIGNATURE: 'l1sig', POLY_TIMESTAMP: '1', POLY_NONCE: '0' }),
  l2Headers: async (creds, method, path) => ({
    POLY_ADDRESS: '0x1',
    POLY_API_KEY: creds.key,
    POLY_PASSPHRASE: creds.passphrase,
    POLY_SIGNATURE: `l2:${method}:${path}`,
  }),
};

describe('connectivity check — verdicts', () => {
  it('everything reachable ⇒ OK, exit 0; read-only GETs; the Gamma token id is used for the book', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const r = await run(healthy(), { binance: true }, calls);
    expect(r.verdict.kind).toBe('ok');
    expect(r.verdict.exitCode).toBe(0);
    expect(r.verdict.line).toBe('OK: this IP can use Polymarket');
    expect(r.ip).toBe('203.0.113.7');
    expect(r.country).toBe('IE');
    expect(r.geoblock).toMatchObject({ status: 'allowed', country: 'IE', region: 'L' });
    expect(r.clobClockSkewMs).toBe(0);
    expect(r.checks.every((c) => c.classification === 'ok')).toBe(true);
    expect(calls.every((c) => (c.init?.method ?? 'GET') === 'GET')).toBe(true);
    expect(calls.find((c) => c.url.includes('/book'))!.url).toContain(`token_id=${TOKEN}`);
    expect(calls.find((c) => c.url.includes('clob.polymarket.com/markets/'))!.url).toContain(CONDITION);
    expect(calls.some((c) => c.url.includes('/auth/'))).toBe(false);
    expect(formatReport(r)).toContain('OK: this IP can use Polymarket');
  });

  it('geoblock endpoint says blocked ⇒ BLOCKED (geo), exit 1, ToS hint', async () => {
    const r = await run({ ...healthy(), 'polymarket.com/api/geoblock': () => json({ blocked: true, ip: '1.2.3.4', country: 'US', region: 'NY' }) });
    expect(r.verdict.kind).toBe('blocked_geo');
    expect(r.verdict.exitCode).toBe(1);
    expect(r.verdict.line).toMatch(/^BLOCKED \(geo\): geoblock endpoint says blocked \[US\/NY\]/);
    expect(r.verdict.hints.join(' ')).toMatch(/VPN or proxy.*Terms of Service/);
    expect(byId(r, 'geoblock').classification).toBe('geo_blocked');
  });

  it('HTTP 451 or a "restricted region" body on an API ⇒ geo_blocked', async () => {
    const r1 = await run({ ...healthy(), 'clob.polymarket.com/time': () => json({ error: 'unavailable' }, 451) });
    expect(byId(r1, 'clob_time').classification).toBe('geo_blocked');
    expect(r1.verdict.kind).toBe('blocked_geo');
    const r2 = await run({
      ...healthy(),
      'clob.polymarket.com/book': () => json({ error: 'Trading restricted in your region, please refer to available regions' }, 403),
    });
    expect(byId(r2, 'clob_book').classification).toBe('geo_blocked');
    expect(r2.verdict.exitCode).toBe(1);
  });

  it('Cloudflare cf-mitigated header ⇒ bot_challenge ⇒ BLOCKED (datacenter/bot protection)', async () => {
    const r = await run({
      ...healthy(),
      'gamma-api.polymarket.com/events': () => html('<html>…</html>', 403, { 'cf-mitigated': 'challenge', 'cf-ray': 'abc-DUB' }),
    });
    expect(byId(r, 'gamma_events').classification).toBe('bot_challenge');
    expect(r.verdict.kind).toBe('blocked_bot');
    expect(r.verdict.exitCode).toBe(1);
    expect(r.verdict.line).toMatch(/^BLOCKED \(datacenter\/bot protection\): gamma_events bot_challenge/);
    expect(r.verdict.hints.join(' ')).toMatch(/another provider/);
  });

  it('"Just a moment…" HTML from Cloudflare ⇒ bot_challenge (also on a 200 where JSON was expected)', async () => {
    const page = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>challenge-platform</body></html>';
    const r = await run({
      ...healthy(),
      'data-api.polymarket.com/positions': () => html(page, 403, { 'cf-ray': 'x', server: 'cloudflare' }),
      'data-api.polymarket.com/activity': () => html(page, 200, { 'cf-ray': 'x', server: 'cloudflare' }),
    });
    expect(byId(r, 'data_positions').classification).toBe('bot_challenge');
    expect(byId(r, 'data_positions').detail).toMatch(/Cloudflare challenge page/);
    expect(byId(r, 'data_activity').classification).toBe('bot_challenge');
    expect(r.verdict.kind).toBe('blocked_bot');
  });

  it('a plain 403 ⇒ forbidden ⇒ BLOCKED (datacenter/bot protection)', async () => {
    const r = await run({ ...healthy(), 'clob.polymarket.com/time': () => html('<html><title>403 Forbidden</title></html>', 403) });
    expect(byId(r, 'clob_time').classification).toBe('forbidden');
    expect(byId(r, 'clob_time').detail).toMatch(/HTML page.*403 Forbidden/);
    expect(r.verdict.kind).toBe('blocked_bot');
  });

  it('429 ⇒ rate_limited ⇒ DEGRADED, exit 2', async () => {
    const r = await run({ ...healthy(), 'gamma-api.polymarket.com/events': () => json({ error: 'too many' }, 429, { 'retry-after': '30' }) });
    expect(byId(r, 'gamma_events')).toMatchObject({ classification: 'rate_limited', detail: 'HTTP 429 (retry-after 30)' });
    expect(r.verdict.kind).toBe('degraded');
    expect(r.verdict.exitCode).toBe(2);
    expect(r.verdict.line).toMatch(/^DEGRADED: gamma_events rate_limited/);
  });

  it('every Polymarket request dropped while other sites work ⇒ BLOCKED (datacenter/bot protection)', async () => {
    const routes = healthy();
    for (const k of Object.keys(routes)) if (k.includes('polymarket.com')) routes[k] = netError('ECONNRESET');
    const r = await run(routes);
    expect(byId(r, 'clob_time')).toMatchObject({ classification: 'network_error', detail: 'connection reset (ECONNRESET)' });
    expect(byId(r, 'clob_book').classification).toBe('skipped');
    expect(r.geoblock.status).toBe('unavailable');
    expect(r.verdict.kind).toBe('blocked_bot');
    expect(r.verdict.line).toMatch(/every Polymarket request failed at the connection level/);
  });

  it('no request succeeds at all (not even the IP lookup) ⇒ DEGRADED (no network)', async () => {
    const routes = healthy();
    for (const k of Object.keys(routes)) routes[k] = netError('ENOTFOUND');
    const r = await run(routes);
    expect(r.ip).toBeNull();
    expect(r.verdict.kind).toBe('degraded');
    expect(r.verdict.line).toMatch(/not even the IP lookup.*DNS lookup failed/);
  });

  it('one connection reset among working requests ⇒ DEGRADED', async () => {
    const r = await run({ ...healthy(), 'data-api.polymarket.com/activity': netError('ECONNRESET') });
    expect(r.verdict.kind).toBe('degraded');
    expect(r.verdict.line).toBe('DEGRADED: data_activity network_error');
  });

  it('non-JSON where JSON is expected ⇒ unexpected ⇒ DEGRADED; a wrong shape too', async () => {
    const r = await run({
      ...healthy(),
      'gamma-api.polymarket.com/events': () => new Response('hello', { status: 200 }),
      'clob.polymarket.com/book': () => json({ nope: true }),
    });
    expect(byId(r, 'gamma_events')).toMatchObject({ classification: 'unexpected' });
    expect(byId(r, 'gamma_events').detail).toMatch(/not JSON/);
    expect(byId(r, 'clob_book').detail).toMatch(/expected \{ bids/);
    expect(r.verdict.kind).toBe('degraded');
  });

  it('geoblock endpoint missing or of another shape ⇒ unavailable (VERIFY), verdict from the API checks', async () => {
    const r1 = await run({ ...healthy(), 'polymarket.com/api/geoblock': () => html('<html><title>Not found</title></html>', 404) });
    expect(r1.geoblock.status).toBe('unavailable');
    expect(r1.geoblock.detail).toMatch(/VERIFY/);
    expect(r1.verdict.kind).toBe('ok');
    expect(r1.verdict.hints.join(' ')).toMatch(/geoblock endpoint could not be read/);
    const r2 = await run({ ...healthy(), 'polymarket.com/api/geoblock': () => json({ isBlocked: 'no' }) });
    expect(r2.geoblock.status).toBe('unavailable');
    expect(byId(r2, 'geoblock').detail).toMatch(/no boolean "blocked" field.*VERIFY/);
    expect(r2.verdict.kind).toBe('ok');
  });

  it('IP lookup failure is "unknown", not fatal', async () => {
    const r = await run({ ...healthy(), 'cdn-cgi/trace': netError('ETIMEDOUT') });
    expect(r.ip).toBeNull();
    expect(r.verdict.kind).toBe('ok');
    expect(formatReport(r)).toContain('unknown IP');
  });

  it('clock skew beyond the live-order limit ⇒ DEGRADED with a time-sync hint', async () => {
    const r = await run({ ...healthy(), 'clob.polymarket.com/time': () => json(Math.floor(NOW / 1000) + 30) });
    expect(r.clobClockSkewMs).toBe(30_000);
    expect(byId(r, 'clob_time').detail).toBe('clock skew +30.0 s (1 s resolution)');
    expect(r.verdict.kind).toBe('degraded');
    expect(r.verdict.line).toMatch(/clock skew \+30\.0 s/);
    expect(r.verdict.hints.join(' ')).toMatch(/time sync/);
  });

  it('Binance 451 ⇒ geo_blocked on Binance only: Polymarket not blocked, verdict DEGRADED', async () => {
    const r = await run(
      {
        ...healthy(),
        'api.binance.com/api/v3/ping': () => json({ code: 0, msg: "Service unavailable from a restricted location according to 'b. Eligibility'" }, 451),
        'api.binance.com/api/v3/time': () => json({ code: 0, msg: 'Service unavailable from a restricted location' }, 451),
      },
      { binance: true }
    );
    expect(byId(r, 'binance_ping').classification).toBe('geo_blocked');
    expect(r.verdict.kind).toBe('degraded');
    expect(r.verdict.line).toMatch(/Binance: binance_ping geo_blocked/);
    expect(r.verdict.hints.join(' ')).toMatch(/Binance restricts this location/);
  });

  it('times out each request after timeoutMs ⇒ network_error', async () => {
    const hang: Route = (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    const r = await runConnectivityCheck({ fetch: fakeFetch({ ...healthy(), 'gamma-api.polymarket.com/events': hang }), timeoutMs: 50 });
    expect(byId(r, 'gamma_events')).toMatchObject({ classification: 'network_error', detail: 'timeout after 0 s' });
    expect(r.verdict.kind).toBe('degraded');
  });

  it('reports the proxy and warns that results reflect its IP', async () => {
    const r = await run(healthy(), { proxy: 'proxy.example:3128' });
    expect(r.verdict.hints[0]).toMatch(/proxy proxy\.example:3128.*proxy's IP/);
    expect(formatReport(r)).toContain('via proxy proxy.example:3128');
  });
});

describe('connectivity check — authenticated (read-only)', () => {
  it('derives the existing key, calls two L2 GETs, never prints a secret', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const r = await run(healthy(), { auth: authProbe }, calls);
    expect(byId(r, 'clob_auth_derive').classification).toBe('ok');
    expect(byId(r, 'clob_auth_keys')).toMatchObject({ classification: 'ok', detail: 'authenticated' });
    expect(byId(r, 'clob_auth_closed_only')).toMatchObject({ classification: 'ok', detail: 'account not restricted' });
    expect(r.verdict.kind).toBe('ok');
    const authCalls = calls.filter((c) => c.url.includes('/auth/'));
    expect(authCalls.map((c) => c.url.replace('https://clob.polymarket.com', ''))).toEqual([
      '/auth/derive-api-key',
      '/auth/api-keys',
      '/auth/ban-status/closed-only',
    ]);
    expect(authCalls.every((c) => c.init?.method === 'GET')).toBe(true);
    expect((authCalls[1].init?.headers as Record<string, string>).POLY_SIGNATURE).toBe('l2:GET:/auth/api-keys');
    const out = JSON.stringify(r) + formatReport(r);
    for (const s of ['key-1234567890', 'secret-abcdefgh', 'pass-xyz123', 'l1sig']) expect(out).not.toContain(s);
  });

  it('error bodies of authenticated calls are not echoed', async () => {
    const r = await run(
      { ...healthy(), 'clob.polymarket.com/auth/api-keys': () => json({ error: 'Unauthorized/Invalid api key key-1234567890' }, 401) },
      { auth: authProbe }
    );
    expect(byId(r, 'clob_auth_keys')).toMatchObject({ classification: 'unexpected', detail: 'HTTP 401' });
    expect(JSON.stringify(r)).not.toContain('key-1234567890');
    expect(r.verdict.kind).toBe('degraded');
  });

  it('closed-only account ⇒ DEGRADED with a support hint (not a datacenter block)', async () => {
    const r = await run({ ...healthy(), 'clob.polymarket.com/auth/ban-status/closed-only': () => json({ closed_only: true }) }, { auth: authProbe });
    expect(byId(r, 'clob_auth_closed_only').detail).toBe('account is in CLOSE-ONLY mode');
    expect(r.verdict.kind).toBe('degraded');
    expect(r.verdict.hints.join(' ')).toMatch(/Close-only mode/);
  });

  it('no API key to derive (400) ⇒ skipped, never created; verdict stays OK', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const r = await run(
      { ...healthy(), 'clob.polymarket.com/auth/derive-api-key': () => json({ error: 'Could not derive api key!' }, 400) },
      { auth: authProbe },
      calls
    );
    expect(byId(r, 'clob_auth_derive')).toMatchObject({ classification: 'skipped' });
    expect(byId(r, 'clob_auth_derive').detail).toMatch(/never creates one/);
    expect(calls.filter((c) => c.url.includes('/auth/'))).toHaveLength(1);
    expect(r.verdict.kind).toBe('ok');
  });

  it('no wallet / no key ⇒ a skipped row with the reason', async () => {
    const r = await run(healthy(), { auth: { skip: 'no wallet is configured in BotLab (add one in Wallets first)' } });
    expect(byId(r, 'clob_auth')).toMatchObject({ classification: 'skipped', detail: 'no wallet is configured in BotLab (add one in Wallets first)' });
    expect(r.verdict.kind).toBe('ok');
  });
});

describe('connectivity check — credentials never follow a redirect', () => {
  it('a 3xx on an authenticated probe is not followed (manual redirect) and is "unexpected"', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const r = await run(
      {
        ...healthy(),
        'clob.polymarket.com/auth/derive-api-key': () => new Response(null, { status: 302, headers: { location: 'https://evil.example/collect' } }),
      },
      { auth: authProbe },
      calls
    );
    expect(byId(r, 'clob_auth_derive')).toMatchObject({ classification: 'unexpected', status: 302 });
    expect(byId(r, 'clob_auth_derive').detail).toBe('HTTP 302 redirect to evil.example not followed (credentials are never sent to a redirect)');
    expect(calls.some((c) => c.url.includes('evil.example'))).toBe(false);
    const authCalls = calls.filter((c) => c.url.includes('/auth/'));
    expect(authCalls).toHaveLength(1);
    expect(authCalls[0].init?.redirect).toBe('manual');
    // Public probes keep following redirects
    expect(calls.find((c) => c.url.endsWith('/time'))!.init?.redirect).toBe('follow');
    expect(r.verdict.kind).toBe('degraded');
  });

  it('refuses to send credentials to an http: CLOB URL', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const r = await runConnectivityCheck({ fetch: fakeFetch(healthy(), calls), now: () => NOW, clobUrl: 'http://clob.polymarket.com', auth: authProbe });
    expect(byId(r, 'clob_auth')).toMatchObject({ classification: 'skipped' });
    expect(byId(r, 'clob_auth').detail).toMatch(/non-https/);
    expect(calls.some((c) => c.url.includes('/auth/'))).toBe(false);
  });
});

describe('connectivity check — classifiers', () => {
  it('Cloudflare country ban (error 1009) ⇒ geo_blocked with the ToS warning', async () => {
    const page =
      '<!DOCTYPE html><html><head><title>Access denied | clob.polymarket.com used Cloudflare to restrict access</title></head>' +
      '<body><span>Error 1009</span><p>The owner of this website (clob.polymarket.com) has banned the country or region your IP address is in (US) from accessing this website.</p></body></html>';
    const r = await run({ ...healthy(), 'clob.polymarket.com/time': () => html(page, 403, { 'cf-ray': 'abc-IAD', server: 'cloudflare' }) });
    expect(byId(r, 'clob_time').classification).toBe('geo_blocked');
    expect(r.verdict.kind).toBe('blocked_geo');
    expect(r.verdict.hints.join(' ')).toMatch(/Terms of Service/);
    expect(classifyResponse({ status: 403, headers: {}, body: 'error 1009', expectJson: true }).classification).toBe('geo_blocked');
  });

  it('classifyResponse', () => {
    expect(classifyResponse({ status: 200, headers: {}, body: '{}', expectJson: true }).classification).toBe('ok');
    expect(classifyResponse({ status: 451, headers: {}, body: '', expectJson: true }).classification).toBe('geo_blocked');
    expect(
      classifyResponse({ status: 503, headers: { 'CF-RAY': 'x' }, body: '<html><title>Attention Required! | Cloudflare</title></html>', expectJson: true })
        .classification
    ).toBe('bot_challenge');
    expect(classifyResponse({ status: 403, headers: {}, body: '{"error":"nope"}', expectJson: true }).classification).toBe('forbidden');
    expect(classifyResponse({ status: 500, headers: {}, body: 'boom', expectJson: true })).toEqual({ classification: 'unexpected', detail: 'HTTP 500: boom' });
  });

  it('classifyError walks fetch cause chains (proxy refusal, TLS, timeout)', () => {
    const undiciErr = Object.assign(new Error('Proxy response (403) !== 200 when HTTP Tunneling'), { code: 'UND_ERR_ABORTED' });
    const dom = Object.assign(new Error('Request was cancelled.'), { cause: undiciErr });
    const top = Object.assign(new TypeError('fetch failed'), { cause: dom });
    expect(classifyError(top, 10_000)).toEqual({ classification: 'network_error', detail: 'the proxy refused the connection (HTTP 403 to CONNECT)' });
    const tls = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('bad cert'), { code: 'CERT_HAS_EXPIRED' }) });
    expect(classifyError(tls, 10_000).detail).toBe('TLS error (CERT_HAS_EXPIRED)');
    expect(classifyError(new DOMException('timed out', 'TimeoutError'), 10_000).detail).toBe('timeout after 10 s');
  });
});
