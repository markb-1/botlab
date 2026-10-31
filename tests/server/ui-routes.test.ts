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
