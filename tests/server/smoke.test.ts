/**
 * Server smoke test (spec §8, §15.2): boots the real HTTP server in-process on 127.0.0.1 (any free
 * port) against a temp data dir, sets up the admin password, lists bots, runs a paper bot (its worker
 * starts from the TypeScript sources through the tsx shim, as under `npm run dev`), receives events
 * over SSE, hits /healthz and the SPA fallback, and shuts down cleanly.
 *
 * Only requests to the test server reach the network; everything else (exchange APIs) fails fast.
 */

import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { sqliteAvailable } from '../orders/db';
import { startServer, type RunningServer } from '../../apps/server/src/server';
import { SHUTDOWN_MARKER_FILE } from '../../packages/core/src/risk/StartupRecovery';

const realFetch = globalThis.fetch;

describe.skipIf(!sqliteAvailable)('server smoke test', () => {
  let tmp: string;
  let server: RunningServer | null = null;
  let cookie = '';
  const savedLogDir = process.env.BOTLAB_LOG_DIR;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-server-'));
    const webDir = path.join(tmp, 'web');
    fs.mkdirSync(path.join(webDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>BotLab test</title>');
    fs.writeFileSync(path.join(webDir, 'assets', 'app.js'), 'console.log(1)');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (server && url.startsWith(server.url)) return realFetch(input, init);
        throw new Error('offline (test)');
      })
    );

    server = await startServer({
      env: { BOTLAB_MASTER_KEY: crypto.randomBytes(32).toString('hex') },
      dataDir: path.join(tmp, 'data'),
      configDir: path.join(tmp, 'config'),
      host: '127.0.0.1',
      port: 0,
      webDir,
      backups: false,
      log: () => undefined,
    });
  }, 60_000);

  afterAll(async () => {
    await server?.close({ timeoutMs: 20_000 }).catch(() => undefined);
    vi.unstubAllGlobals();
    if (savedLogDir === undefined) delete process.env.BOTLAB_LOG_DIR;
    else process.env.BOTLAB_LOG_DIR = savedLogDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const api = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await realFetch(`${server!.url}${p}`, {
      method,
      headers: { ...(method !== 'GET' ? { 'X-BotLab': '1' } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, json: text.startsWith('{') ? JSON.parse(text) : null, text, headers: res.headers };
  };

  it('boots unlocked on a fresh data dir; /healthz is healthy and minimal', async () => {
    expect(server!.lockReason).toBeNull();
    expect(server!.setupCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/); // printed to the log on first run
    expect(server!.masterKey.source).toBe('env');
    const h = await api('GET', '/healthz');
    expect(h.status).toBe(200);
    expect(h.json).toMatchObject({ ok: true, db: 'ok', unlocked: true, reconciler: 'starting', workers: { failed: 0 } });
  });

  it('first-run setup → session cookie → API calls', async () => {
    const s0 = await api('GET', '/api/auth/session');
    expect(s0.json.data).toMatchObject({ needsSetup: true, authenticated: false, unlocked: true });
    expect((await api('GET', '/api/bots')).status).toBe(401);

    const setup = await api('POST', '/api/auth/setup', { password: 'correct horse' });
    expect(setup.status).toBe(200);
    expect(setup.json.data).toMatchObject({ needsSetup: false, authenticated: true, scope: 'admin', recentAuth: true });
    expect(setup.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(setup.headers.get('set-cookie')).toMatch(/SameSite=Strict/i);

    const bots = await api('GET', '/api/bots');
    expect(bots.json).toEqual({ success: true, data: [] });
    const scripts = await api('GET', '/api/scripts');
    expect(scripts.json.data.some((s: { isTemplate: boolean }) => s.isTemplate)).toBe(true);
  });

  it('runs a paper bot (worker from .ts sources) and streams its events over SSE', async () => {
    const source = "export const meta = { name: 'noop' };\nexport async function onTick(ctx) { ctx.log.info('tick'); }\n";
    const script = await api('POST', '/api/scripts', { name: 'noop', source });
    expect(script.json).toMatchObject({ success: true });
    const bot = await api('POST', '/api/bots', { name: 'smoke', scriptId: script.json.data.id });
    expect(bot.json.data).toMatchObject({ mode: 'paper' }); // no mode ⇒ paper (live is never implied)

    // Open the event stream before starting the bot
    const ctrl = new AbortController();
    const res = await realFetch(`${server!.url}/api/events`, { headers: { cookie }, signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const waitFor = async (re: RegExp, ms = 20_000) => {
      const deadline = Date.now() + ms;
      while (!re.test(buffer)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${re} in SSE; got: ${buffer.slice(0, 500)}`);
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE stream ended');
        buffer += decoder.decode(value, { stream: true });
      }
    };
    await waitFor(/event: ready/);

    const start = await api('POST', `/api/bots/${bot.json.data.id}/start`);
    expect(start.json).toEqual({ success: true });
    await waitFor(/event: bot:event\ndata: .*"newStatus":"running"/);
    const h = await api('GET', '/healthz');
    expect(h.json.workers).toEqual({ running: 1, failed: 0 });

    await api('POST', `/api/bots/${bot.json.data.id}/stop`);
    await waitFor(/"newStatus":"stopped"/);
    ctrl.abort();
  }, 60_000);

  it('serves the web app with SPA fallback; unknown /api paths are JSON 404s', async () => {
    const index = await api('GET', '/bots/123');
    expect(index.status).toBe(200);
    expect(index.text).toContain('BotLab test');
    const asset = await api('GET', '/assets/app.js');
    expect(asset.headers.get('cache-control')).toMatch(/immutable/);
    expect((await api('GET', '/assets/missing.js')).status).toBe(404);
    expect((await api('GET', '/../../package.json')).text).not.toContain('"name": "botlab"');
    // Encoded traversal, incl. backslashes (a separator on Windows): never a file outside the web dir
    fs.writeFileSync(path.join(tmp, 'outside-secret.txt'), 'TOP SECRET');
    for (const p of ['/..%2foutside-secret.txt', '/..%5coutside-secret.txt', '/assets/..%2f..%2foutside-secret.txt', '/assets/..%5c..%5coutside-secret.txt', '/%2e%2e%5coutside-secret.txt', '/..%5c..%5c..%5cetc%5cpasswd']) {
      const r = await api('GET', p);
      expect({ p, leaked: r.text.includes('TOP SECRET') || r.text.includes('root:') }).toEqual({ p, leaked: false });
      expect([400, 404]).toContain(r.status);
    }
    const missing = await api('GET', '/api/nope');
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ success: false, code: 'not_found' });
  });

  it('shuts down cleanly (clean-shutdown marker) and stops listening', async () => {
    const { url, dataDir } = server!;
    const result = await server!.close({ timeoutMs: 20_000 });
    server = null;
    expect(result.clean).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, SHUTDOWN_MARKER_FILE), 'utf8')).toMatch(/clean/);
    expect(fs.existsSync(path.join(dataDir, 'server.lock'))).toBe(false);
    await expect(realFetch(`${url}/healthz`)).rejects.toThrow();
  }, 60_000);
});
