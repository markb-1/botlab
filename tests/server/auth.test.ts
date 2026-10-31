/**
 * HTTP auth (spec §8.2, §4.6; R84/R88/R89): sessions, expiry, the 15-minute re-auth window for
 * human-only actions, CSRF header, agent / readonly token scopes, and actors derived from the
 * authenticated principal (an `actor` in the request body is ignored). In-process requests against
 * `createApp` over a real core (temp data dir, network stubbed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { sqliteAvailable } from '../orders/db';
import { createCore, type Core } from '../../packages/core/src';
import { createApp } from '../../apps/server/src/app';
import { LoginLimiter } from '../../apps/server/src/routes/auth';
import { isHostAllowed } from '../../apps/server/src/http/hosts';
import { asAgent } from '../../packages/core/src/services/actors';

const PASSWORD = 'correct horse battery';
const HOST = '127.0.0.1:3780';

describe.skipIf(!sqliteAvailable)('HTTP auth', () => {
  let tmp: string;
  let core: Core;
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline (test)');
      })
    );
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-auth-'));
    core = createCore({ dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'config'), backups: false });
    await core.start();
    await core.unlock(crypto.randomBytes(32).toString('hex'));
    // loopbackOnly: in-process requests count as local, so setup needs no code (tested separately)
    app = createApp({ core, webDir: null, limiter: new LoginLimiter(), loopbackOnly: true }).app;
  }, 60_000);

  afterEach(async () => {
    vi.useRealTimers();
    await core.shutdown({ timeoutMs: 20_000 });
    core.close();
    vi.unstubAllGlobals();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  type Res = { status: number; json: any; cookie: string | null };
  async function req(method: string, p: string, opts: { body?: unknown; cookie?: string; bearer?: string; csrf?: boolean; headers?: Record<string, string> } = {}): Promise<Res> {
    const headers: Record<string, string> = { host: HOST, ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (method !== 'GET' && opts.csrf !== false) headers['x-botlab'] = '1';
    const res = await app.request(p, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    const set = res.headers.get('set-cookie');
    return { status: res.status, json: await res.json().catch(() => null), cookie: set ? set.split(';')[0] : null };
  }

  async function setup(): Promise<string> {
    const r = await req('POST', '/api/auth/setup', { body: { password: PASSWORD } });
    expect(r.status).toBe(200);
    return r.cookie!;
  }

  const audit = (action: string) => core.repos.auditRepo.list({ action });

  it('setup once, then login; wrong passwords are audited and rate-limited', async () => {
    expect((await req('POST', '/api/auth/setup', { body: { password: 'short' } })).status).toBe(400);
    await setup();
    expect((await req('POST', '/api/auth/setup', { body: { password: 'another password' } })).json.code).toBe('conflict');

    const bad = await req('POST', '/api/auth/login', { body: { password: 'wrong password' } });
    expect(bad.status).toBe(401);
    expect(audit('auth.login').some((r) => r.result === 'denied: wrong password')).toBe(true);
    const good = await req('POST', '/api/auth/login', { body: { password: PASSWORD } });
    expect(good.status).toBe(200);
    expect((await req('GET', '/api/bots', { cookie: good.cookie! })).status).toBe(200);

    for (let i = 0; i < 5; i++) await req('POST', '/api/auth/login', { body: { password: 'nope nope' } });
    const limited = await req('POST', '/api/auth/login', { body: { password: PASSWORD } });
    expect(limited.status).toBe(429);
  });

  it('requires a session; logout and idle expiry end it', async () => {
    expect((await req('GET', '/api/bots')).json).toMatchObject({ success: false, code: 'unauthenticated' });
    const cookie = await setup();
    expect((await req('GET', '/api/bots', { cookie })).status).toBe(200);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 8 * 24 * 3600_000); // idle > 7 days
    expect((await req('GET', '/api/bots', { cookie })).status).toBe(401);
    vi.useRealTimers();

    const fresh = (await req('POST', '/api/auth/login', { body: { password: PASSWORD } })).cookie!;
    expect((await req('POST', '/api/auth/logout', { cookie: fresh })).status).toBe(200);
    expect((await req('GET', '/api/bots', { cookie: fresh })).status).toBe(401);
  });

  it('mutations need the X-BotLab header and a same-origin Origin (CSRF)', async () => {
    expect((await req('POST', '/api/auth/setup', { body: { password: PASSWORD }, csrf: false })).json.code).toBe('csrf');
    const cookie = await setup();
    const noHeader = await req('POST', '/api/risk/kill-switch', { cookie, body: { reason: 'x' }, csrf: false });
    expect(noHeader).toMatchObject({ status: 403, json: { code: 'csrf' } });
    const crossOrigin = await req('POST', '/api/risk/kill-switch', { cookie, body: { reason: 'x' }, headers: { origin: 'http://evil.example' } });
    expect(crossOrigin.json.code).toBe('csrf');
    expect(core.halts.getState().global?.halted ?? false).toBe(false);
  });

  it('human-only actions need a password check within 15 minutes; re-auth refreshes it', async () => {
    const cookie = await setup();
    await core.killSwitch.activate('test halt', 'system');
    expect(core.halts.getState().global?.halted).toBe(true);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const stale = await req('POST', '/api/risk/clear-halt', { cookie, body: { scope: 'global', reason: 'checked' } });
    expect(stale).toMatchObject({ status: 403, json: { code: 'reauth_required' } });
    expect((await req('PUT', '/api/config/limits', { cookie, body: { value: {} } })).json.code).toBe('reauth_required');
    expect(core.halts.getState().global?.halted).toBe(true);

    expect((await req('POST', '/api/auth/reauth', { cookie, body: { password: 'wrong password' } })).status).toBe(401);
    const re = await req('POST', '/api/auth/reauth', { cookie, body: { password: PASSWORD } });
    expect(re.json.data).toMatchObject({ recentAuth: true });
    const cleared = await req('POST', '/api/risk/clear-halt', { cookie, body: { scope: 'global', reason: 'checked', actor: 'agent' } });
    expect(cleared.json).toEqual({ success: true });
    expect(core.halts.getState().global?.halted ?? false).toBe(false);
    // Recorded as the human (from the session), whatever the body said
    expect(audit('risk.halt_clear').at(-1)).toMatchObject({ actor: 'human', result: expect.not.stringMatching(/denied/) });
  });

  it('agent token: allowed routes act as the agent (body actor ignored); admin-only and human-only routes refused', async () => {
    const cookie = await setup();
    // Creating a token is a human-only admin action
    const created = await req('POST', '/api/auth/tokens', { cookie, body: { name: 'mcp', scope: 'agent' } });
    expect(created.status).toBe(200);
    const token = created.json.data.token as string;
    expect(token).toMatch(/^blt_/);
    expect((await req('GET', '/api/auth/tokens', { cookie })).json.data[0]).not.toHaveProperty('token_hash');

    // Bearer requests need no CSRF header
    expect((await req('GET', '/api/bots', { bearer: token })).status).toBe(200);
    expect((await req('GET', '/api/config', { bearer: token })).status).toBe(200);

    for (const [method, p, body] of [
      ['POST', '/api/risk/clear-halt', { scope: 'global', reason: 'x' }],
      ['PUT', '/api/config/limits', { value: {} }],
      ['POST', '/api/config/limits/restore', { versionId: 'v' }],
      ['POST', '/api/reconcile/adopt', { walletId: 'w', botId: 'b' }],
      ['POST', '/api/markets/m1/ambiguity', { score: 0 }],
      ['POST', '/api/ledger/rights', { category: 'c', bucket: 'short', state: 'trading', reason: 'x' }],
      ['GET', '/api/wallets', undefined],
      ['POST', '/api/wallets', { name: 'w', address: '0x', privateKey: 'k' }],
      ['GET', '/api/settings', undefined],
      ['PUT', '/api/settings/binance', { apiKey: 'a', apiSecret: 'b' }],
      ['DELETE', '/api/bots/some-id', undefined],
      ['POST', '/api/auth/tokens', { scope: 'agent' }],
    ] as const) {
      const r = await req(method, p, { bearer: token, body, csrf: false });
      expect({ p, status: r.status, code: r.json.code }).toEqual({ p, status: 403, code: 'forbidden' });
    }

    // Allowed for the agent: kill switch and bot creation, recorded as the agent even if the body claims human
    const kill = await req('POST', '/api/risk/kill-switch', { bearer: token, body: { reason: 'agent pressed it', actor: 'human' }, csrf: false });
    expect(kill.json.success).toBe(true);
    expect(audit('risk.kill_switch').at(-1)?.actor).toBe('agent');
    const script = core.services.scripts.list().find((s) => s.isTemplate && s.trust === 'proven')!; // not a standing-role template (R168)
    const bot = await req('POST', '/api/bots', { bearer: token, body: { name: 'agent-bot', scriptId: script.id, actor: 'human' }, csrf: false });
    expect(bot.json.data).toMatchObject({ mode: 'paper' });
    expect(audit('bot.create').at(-1)).toMatchObject({ actor: 'agent', target: bot.json.data.id });

    // Revoked ⇒ 401
    expect((await req('DELETE', `/api/auth/tokens/${created.json.data.id}`, { cookie })).json.data).toEqual({ revoked: true });
    expect((await req('GET', '/api/bots', { bearer: token })).status).toBe(401);
  });

  it('parallel wrong passwords cannot overtake the rate limit (login, reauth, password change)', async () => {
    const cookie = await setup();
    const login = await Promise.all(Array.from({ length: 40 }, () => req('POST', '/api/auth/login', { body: { password: 'wrong password!' } })));
    expect(login.filter((r) => r.status === 401)).toHaveLength(5);
    expect(login.filter((r) => r.status === 429)).toHaveLength(35);
    // Re-auth and password change are keyed on the session behind a loopback peer, and limited the same way
    const reauth = await Promise.all(Array.from({ length: 20 }, () => req('POST', '/api/auth/reauth', { cookie, body: { password: 'wrong password!' } })));
    expect(reauth.filter((r) => r.status === 401)).toHaveLength(5);
    expect(reauth.filter((r) => r.status === 429)).toHaveLength(15);
    const change = await req('POST', '/api/auth/password', { cookie, body: { currentPassword: PASSWORD, newPassword: 'another password' } });
    expect(change.status).toBe(429);
  });

  it('readonly token: no wallets, settings, config, tokens or script export', async () => {
    const cookie = await setup();
    const { token } = core.auth.createToken('dashboard', 'readonly');
    const script = core.services.scripts.list().find((s) => s.isTemplate && s.trust === 'proven')!; // not a standing-role template (R168)
    for (const p of [
      '/api/wallets',
      '/api/wallets/w1',
      '/api/wallets/w1/balance',
      '/api/settings',
      `/api/scripts/${script.id}/export`,
      '/api/config',
      '/api/config/limits/history',
      '/api/auth/tokens',
    ]) {
      const r = await req('GET', p, { bearer: token });
      expect({ p, status: r.status }).toEqual({ p, status: 403 });
    }
    // The admin still can
    expect((await req('GET', '/api/settings', { cookie })).status).toBe(200);
    expect((await req('GET', '/api/wallets', { cookie })).status).toBe(200);
  });

  it('wallets, credentials and settings changes need a recent password check', async () => {
    const cookie = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    for (const [method, p, body] of [
      ['POST', '/api/wallets', { name: 'w', address: '0x0', privateKey: 'k' }],
      ['PATCH', '/api/wallets/w1', { name: 'x' }],
      ['DELETE', '/api/wallets/w1', undefined],
      ['PUT', '/api/settings/binance', { apiKey: 'a', apiSecret: 'b' }],
      ['DELETE', '/api/settings/binance', undefined],
      ['PATCH', '/api/settings', { rpcUrl: 'https://example.invalid' }],
    ] as const) {
      const r = await req(method, p, { cookie, body });
      expect({ p, method, code: r.json.code }).toEqual({ p, method, code: 'reauth_required' });
    }
    expect(core.services.settings.get().rpcUrl).not.toBe('https://example.invalid');
  });

  it('agent: bots are paper with no wallet choice; updates are config only (enforced in BotService too)', async () => {
    await setup();
    const { token } = core.auth.createToken('mcp', 'agent');
    const script = core.services.scripts.list().find((s) => s.isTemplate && s.trust === 'proven')!; // not a standing-role template (R168)
    const asAgentReq = (method: string, p: string, body: unknown) => req(method, p, { bearer: token, body, csrf: false });
    expect((await asAgentReq('POST', '/api/bots', { name: 'a', scriptId: script.id, walletId: 'w1', mode: 'paper' })).json).toMatchObject({ code: 'forbidden' });
    expect((await asAgentReq('POST', '/api/bots', { name: 'a', scriptId: script.id, mode: 'live' })).json).toMatchObject({ code: 'forbidden' });
    const bot = (await asAgentReq('POST', '/api/bots', { name: 'a', scriptId: script.id })).json.data;
    expect(bot.mode).toBe('paper');
    for (const change of [{ name: 'renamed' }, { walletId: 'w2' }, { scriptId: script.id }, { enabled: false }, { name: 'x', config: {} }]) {
      const r = await asAgentReq('PATCH', `/api/bots/${bot.id}`, change);
      expect({ change, status: r.status, code: r.json.code }).toEqual({ change, status: 403, code: 'forbidden' });
    }
    const ok = await asAgentReq('PATCH', `/api/bots/${bot.id}`, { config: { pollingIntervalMs: 60000 } });
    expect(ok.json.data.config).toEqual({ pollingIntervalMs: 60000 });
    expect(audit('bot.update').some((r) => r.actor === 'agent' && r.result === 'denied: agent may change config only')).toBe(true);
    // The service enforces it without the HTTP layer
    expect(() => core.services.bots.update(bot.id, { name: 'direct' }, asAgent('token:test'))).toThrow(/config only/);
    await expect(core.services.bots.create({ name: 'b', scriptId: script.id, walletId: bot.walletId }, asAgent('token:test'))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('first-run setup needs the setup code unless it is a direct local request to a loopback-bound server', async () => {
    const remoteApp = createApp({ core, webDir: null, limiter: new LoginLimiter(), loopbackOnly: false }).app;
    const call = async (a: typeof app, body: unknown, headers: Record<string, string> = {}) => {
      const res = await a.request('/api/auth/setup', {
        method: 'POST',
        headers: { host: HOST, 'x-botlab': '1', 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as any };
    };
    const session = await (await remoteApp.request('/api/auth/session', { headers: { host: HOST } })).json();
    expect(session.data).toMatchObject({ needsSetup: true, setupCodeRequired: true });

    const code = core.auth.createSetupCode();
    expect((await call(remoteApp, { password: PASSWORD })).json.code).toBe('setup_code_required');
    expect((await call(remoteApp, { password: PASSWORD, setupCode: 'AAAA-AAAA' })).json.code).toBe('setup_code_required');
    // Loopback-bound but through a proxy (X-Forwarded-For) or with a non-local Host: the code is required too
    expect((await call(app, { password: PASSWORD }, { 'x-forwarded-for': '100.64.0.7' })).json.code).toBe('setup_code_required');
    expect((await call(app, { password: PASSWORD }, { host: 'box.tail1234.ts.net' })).json.code).toBe('setup_code_required');
    expect(audit('auth.setup').some((r) => r.result === 'denied: wrong setup code')).toBe(true);

    const ok = await call(remoteApp, { password: PASSWORD, setupCode: code.toLowerCase().replace('-', ' ') });
    expect(ok.status).toBe(200);
    expect(core.auth.verifySetupCode(code)).toBe(false); // one-time: cleared with the password
  });

  it('readonly token: GET only; a bad token is 401', async () => {
    await setup();
    const { token } = core.auth.createToken('dashboard', 'readonly');
    expect((await req('GET', '/api/bots', { bearer: token })).status).toBe(200);
    expect((await req('GET', '/api/risk/state', { bearer: token })).status).toBe(200);
    expect((await req('POST', '/api/risk/kill-switch', { bearer: token, body: { reason: 'x' } })).status).toBe(403);
    expect((await req('POST', '/api/bots', { bearer: token, body: { name: 'x', scriptId: 'y' } })).status).toBe(403);
    expect((await req('GET', '/api/bots', { bearer: 'blt_not-a-token' })).status).toBe(401);
  });

  it('refuses unknown Host names (DNS rebinding) but allows IPs, localhost, *.ts.net and configured names', async () => {
    expect((await req('GET', '/api/auth/session', { headers: { host: 'evil.example.com' } })).json.code).toBe('host_not_allowed');
    expect(isHostAllowed('127.0.0.1:3780', [])).toBe(true);
    expect(isHostAllowed('[::1]:3780', [])).toBe(true);
    expect(isHostAllowed('100.101.102.103', [])).toBe(true);
    expect(isHostAllowed('localhost:3000', [])).toBe(true);
    expect(isHostAllowed('homebox.tail1234.ts.net', [])).toBe(true);
    expect(isHostAllowed('botlab.lan', ['botlab.lan'])).toBe(true);
    expect(isHostAllowed('a.home.arpa', ['.home.arpa'])).toBe(true);
    expect(isHostAllowed('evilhome.arpa', ['.home.arpa'])).toBe(false);
    expect(isHostAllowed(undefined, [])).toBe(false);
  });
});
