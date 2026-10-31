/**
 * Read endpoints added for the 3c UI pages: scopes (admin / readonly / agent), plus the basic shape of
 * what they return — risk overview, audit log paging, config JSON schema / preview (risk classification)
 * / version text, script versions, bot orders, forecast by id, market search, adoption preview.
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
import { scrubPublicText, publicLookupError, PublicError } from '../../packages/core/src/services/redact';

const RPC_URL = 'https://polygon-mainnet.g.alchemy.com/v2/SECRET_ALCHEMY_KEY_123';
const WALLET = '0x1111111111111111111111111111111111111111';

// The Polygon balance read fails the way ethers v5 does: URL (with the API key) and request body in the message
vi.mock('../../packages/core/src/exchange/polymarket/trading', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/core/src/exchange/polymarket/trading')>();
  return {
    ...actual,
    getBalance: vi.fn(async (address: string, rpcUrl: string) => {
      const err = new Error(
        `missing response (requestBody="{\"method\":\"eth_call\",\"params\":[{\"to\":\"0x2791\",\"data\":\"0x70a08231000000000000000000000000${address.slice(2)}\"}]}", requestMethod="POST", serverError={}, url="${rpcUrl}", code=SERVER_ERROR, version=web/5.8.0)`
      ) as Error & { code: string };
      err.code = 'SERVER_ERROR';
      throw err;
    }),
  };
});

const PASSWORD = 'correct horse battery';
const HOST = '127.0.0.1:3780';

describe.skipIf(!sqliteAvailable)('3c UI routes', () => {
  let tmp: string;
  let core: Core;
  let app: ReturnType<typeof createApp>['app'];
  let cookie: string;
  let agent: string;
  let readonly: string;

  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline (test)');
      })
    );
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-ui-'));
    core = createCore({ dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'config'), backups: false });
    await core.start();
    await core.unlock(crypto.randomBytes(32).toString('hex'));
    app = createApp({ core, webDir: null, limiter: new LoginLimiter(), loopbackOnly: true }).app;
    const r = await req('POST', '/api/auth/setup', { body: { password: PASSWORD } });
    cookie = r.cookie!;
    agent = core.auth.createToken('mcp', 'agent').token;
    readonly = core.auth.createToken('dash', 'readonly').token;
  }, 60_000);

  afterEach(async () => {
    await core.shutdown({ timeoutMs: 20_000 });
    core.close();
    vi.unstubAllGlobals();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  type Res = { status: number; json: any; cookie: string | null };
  async function req(method: string, p: string, opts: { body?: unknown; cookie?: string; bearer?: string } = {}): Promise<Res> {
    const headers: Record<string, string> = { host: HOST };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (method !== 'GET' && !opts.bearer) headers['x-botlab'] = '1';
    const res = await app.request(p, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    const set = res.headers.get('set-cookie');
    return { status: res.status, json: await res.json().catch(() => null), cookie: set ? set.split(';')[0] : null };
  }

  /** Status per principal: [admin, readonly, agent] */
  async function statuses(method: string, p: string, body?: unknown): Promise<number[]> {
    return [
      (await req(method, p, { cookie, body })).status,
      (await req(method, p, { bearer: readonly, body })).status,
      (await req(method, p, { bearer: agent, body })).status,
    ];
  }

  it('risk overview: everyone who can read (agent: get_overview)', async () => {
    expect(await statuses('GET', '/api/risk/overview')).toEqual([200, 200, 200]);
    const o = (await req('GET', '/api/risk/overview', { cookie })).json.data;
    expect(o).toMatchObject({
      liveTradingEnabled: false,
      exposure: { totalUsd: 0, maxOpenOrders: 50 },
      dailyPnl: { limitUsd: 100 },
      halts: { global: { halted: false } },
      reconciler: { locked: false },
    });
    expect(o.equity.usd).toBe(0); // no live bots: no wallets to read
  });

  it('equity errors never carry the RPC URL / API key or the request body (agent and readonly see them)', async () => {
    core.repos.settingsRepo.update({ rpcUrl: RPC_URL });
    const wallet = core.repos.walletRepo.create({ name: 'live', address: WALLET, privateKeyEncrypted: 'x' });
    const script = core.services.scripts.list().find((s) => s.isTemplate)!;
    core.repos.botRepo.create({ name: 'live bot', scriptId: script.id, walletId: wallet.id, mode: 'live', stage: 'full' });
    for (const auth of [{ cookie }, { bearer: agent }, { bearer: readonly }]) {
      const o = (await req('GET', '/api/risk/overview', auth)).json.data;
      expect(o.equity.usd).toBeNull();
      expect(o.equity.error).toBe('polygon balance lookup failed (SERVER_ERROR)');
      const text = JSON.stringify(o);
      expect(text).not.toContain('SECRET_ALCHEMY_KEY');
      expect(text).not.toContain('alchemy');
      expect(text).not.toContain(WALLET.slice(2));
    }
  });

  it('redaction helpers: URLs keep only the host, addresses are shortened, library codes kept', () => {
    expect(scrubPublicText(`failed url="${RPC_URL}" for ${WALLET}`)).toBe('failed url="https://polygon-mainnet.g.alchemy.com/…" for 0x1111…1111');
    expect(scrubPublicText('GET https://api.binance.com/api/v3/account?timestamp=1&signature=abc failed')).toBe('GET https://api.binance.com/… failed');
    expect(publicLookupError(Object.assign(new Error(RPC_URL), { code: 'NETWORK_ERROR' }), 'x')).toBe('x failed (NETWORK_ERROR)');
    expect(publicLookupError(new Error(RPC_URL), 'x')).toBe('x failed');
    expect(publicLookupError(new PublicError('RPC URL or USDC contract not configured'), 'x')).toBe('RPC URL or USDC contract not configured');
  });

  it('saving the config form unchanged gives zero changes', async () => {
    const got = (await req('GET', '/api/config', { cookie })).json.data;
    for (const file of ['limits', 'mandate', 'fees', 'server', 'categories']) {
      const value = got.config[file];
      const preview = (await req('POST', `/api/config/${file}/preview`, { cookie, body: { value } })).json.data;
      expect({ file, ...preview }).toEqual({ file, valid: true, issues: [], changes: [], raises: false });
      const saved = await req('PUT', `/api/config/${file}`, { cookie, body: { value, expectedSha256: got.hashes[file] } });
      expect({ file, data: saved.json.data }).toEqual({ file, data: { changes: [], raises: [] } });
    }
    // The masked Telegram token sent back unchanged keeps the stored value
    expect(core.configService.getConfig()?.server.notify.telegram.bot_token).toBe('');
  });

  it('restore is reviewed like an edit: restoring a looser version is classified raises; the hash is checked', async () => {
    const got = (await req('GET', '/api/config', { cookie })).json.data;
    const initial = (await req('GET', '/api/config/limits/history', { cookie })).json.data[0];
    const lowered = structuredClone(got.config.limits);
    lowered.global.daily_loss_limit_usd = 40;
    lowered.per_market.max_exposure_usd = 20;
    expect((await req('PUT', '/api/config/limits', { cookie, body: { value: lowered, expectedSha256: got.hashes.limits } })).status).toBe(200);

    expect(await statuses('POST', '/api/config/limits/restore/preview', { versionId: initial.versionId })).toEqual([200, 403, 403]);
    const preview = (await req('POST', '/api/config/limits/restore/preview', { cookie, body: { versionId: initial.versionId } })).json.data;
    expect(preview).toMatchObject({ valid: true, raises: true });
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'global.daily_loss_limit_usd', old: 40, new: 100, effect: 'raises' }),
        expect.objectContaining({ path: 'per_market.max_exposure_usd', old: 20, new: 50, effect: 'raises' }),
      ])
    );
    expect((await req('POST', '/api/config/limits/restore/preview', { cookie, body: { versionId: '20990101T000000000Z' } })).json.data.valid).toBe(false);

    const stale = await req('POST', '/api/config/limits/restore', { cookie, body: { versionId: initial.versionId, expectedSha256: got.hashes.limits } });
    expect(stale.json.success).toBe(false);
    expect(stale.json.error).toMatch(/changed on disk/);
    expect(core.configService.getConfig()?.limits.global.daily_loss_limit_usd).toBe(40);

    const hash = (await req('GET', '/api/config', { cookie })).json.data.hashes.limits;
    const ok = await req('POST', '/api/config/limits/restore', { cookie, body: { versionId: initial.versionId, expectedSha256: hash } });
    expect(ok.json.data.raises).toEqual(expect.arrayContaining(['limits.global.daily_loss_limit_usd']));
    expect(core.configService.getConfig()?.limits.global.daily_loss_limit_usd).toBe(100);
  });

  it('audit log: admin and readonly, not the agent; paged newest first', async () => {
    expect(await statuses('GET', '/api/audit')).toEqual([200, 200, 403]);
    expect(await statuses('GET', '/api/audit/actions')).toEqual([200, 200, 403]);
    core.services.audit.record('system', 'test.one', 'a');
    core.services.audit.record('system', 'test.two', 'b');
    core.services.audit.record('human', 'test.three', 'c');
    const p1 = (await req('GET', '/api/audit?actionPrefix=test.&limit=2', { cookie })).json.data;
    expect(p1.entries.map((e: any) => e.action)).toEqual(['test.three', 'test.two']);
    const p2 = (await req('GET', `/api/audit?actionPrefix=test.&limit=2&before=${p1.nextBefore}`, { cookie })).json.data;
    expect(p2).toMatchObject({ entries: [{ action: 'test.one' }], nextBefore: null });
    expect((await req('GET', '/api/audit?actor=human&actionPrefix=test.', { cookie })).json.data.entries).toHaveLength(1);
    expect((await req('GET', '/api/audit?since=not-a-date', { cookie })).status).toBe(400);
  });

  it('config schema (admin, readonly), preview (admin only, classifies raises), version text (admin only)', async () => {
    expect(await statuses('GET', '/api/config/schema')).toEqual([200, 200, 403]);
    const schema = (await req('GET', '/api/config/schema', { cookie })).json.data;
    expect(schema.limits.properties.global.properties.max_total_exposure_usd).toMatchObject({ type: 'number', default: 300 });

    const limits = (await req('GET', '/api/config', { cookie })).json.data.config.limits;
    const raised = structuredClone(limits);
    raised.global.daily_loss_limit_usd = 150;
    expect(await statuses('POST', '/api/config/limits/preview', { value: raised })).toEqual([200, 403, 403]);
    const preview = (await req('POST', '/api/config/limits/preview', { cookie, body: { value: raised } })).json.data;
    expect(preview).toMatchObject({ valid: true, raises: true, changes: [{ path: 'global.daily_loss_limit_usd', old: 100, new: 150, effect: 'raises' }] });
    const lowered = structuredClone(limits);
    lowered.global.daily_loss_limit_usd = 50;
    expect((await req('POST', '/api/config/limits/preview', { cookie, body: { value: lowered } })).json.data).toMatchObject({ valid: true, raises: false });
    const bad = structuredClone(limits);
    bad.global.max_total_exposure_usd = -1;
    const invalid = (await req('POST', '/api/config/limits/preview', { cookie, body: { value: bad } })).json.data;
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.join(' ')).toMatch(/max_total_exposure_usd/);
    // Nothing was written
    expect(core.configService.getConfig()?.limits.global.daily_loss_limit_usd).toBe(100);

    const history = (await req('GET', '/api/config/server/history', { cookie })).json.data;
    expect(history.length).toBeGreaterThan(0);
    const v = history[0].versionId;
    expect(await statuses('GET', `/api/config/server/history/${v}`)).toEqual([200, 403, 403]);
    expect((await req('GET', `/api/config/server/history/${v}`, { cookie })).json.data.text).toMatch(/telegram/);
    expect((await req('GET', '/api/config/server/history/20990101T000000000Z', { cookie })).status).toBe(404);
  });

  it('script versions, bot orders, forecast by id and market search are readable by all scopes', async () => {
    const script = core.services.scripts.list().find((s) => s.isTemplate)!;
    expect(await statuses('GET', `/api/scripts/${script.id}/versions`)).toEqual([200, 200, 200]);
    const versions = (await req('GET', `/api/scripts/${script.id}/versions`, { cookie })).json.data;
    expect(versions[0]).toMatchObject({ version: script.revision });
    expect(versions[0]).not.toHaveProperty('source');
    const one = (await req('GET', `/api/scripts/${script.id}/versions/${script.revision}`, { cookie })).json.data;
    expect(one.source).toBe(script.source);
    expect((await req('GET', `/api/scripts/${script.id}/versions/999`, { cookie })).status).toBe(404);

    const bot = (await req('POST', '/api/bots', { cookie, body: { name: 'p', scriptId: script.id } })).json.data;
    expect(bot).toMatchObject({ mode: 'paper', createdBy: 'human', scriptRevision: script.revision });
    expect(await statuses('GET', `/api/bots/${bot.id}/orders`)).toEqual([200, 200, 200]);
    expect((await req('GET', `/api/bots/${bot.id}/orders`, { cookie })).json.data).toEqual([]);
    expect((await req('GET', '/api/bots/nope/orders', { cookie })).status).toBe(404);

    expect(await statuses('GET', '/api/ledger/forecasts/nope')).toEqual([404, 404, 404]);
    expect(await statuses('GET', '/api/markets?q=election')).toEqual([200, 200, 200]);
  });

  it('adoption preview: human admin only; refused for an unknown bot without auditing', async () => {
    expect((await statuses('POST', '/api/reconcile/adopt/preview', { walletId: 'w', botId: 'b' })).slice(1)).toEqual([403, 403]);
    const r = await req('POST', '/api/reconcile/adopt/preview', { cookie, body: { walletId: 'w', botId: 'b' } });
    expect(r.json).toMatchObject({ success: false, code: 'conflict' });
    expect(core.repos.auditRepo.list({ action: 'reconcile.adopt' })).toHaveLength(0);
  });
});
