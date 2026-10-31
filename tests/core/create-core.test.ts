import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { sqliteAvailable } from '../orders/db';
import { createCore, type Core } from '../../packages/core/src';
import { SHUTDOWN_MARKER_FILE } from '../../packages/core/src/risk/StartupRecovery';
import { BotManager } from '../../packages/core/src/bots/BotManager';
import { ScriptRepository } from '../../packages/core/src/db/repositories/ScriptRepository';
import { keyManager } from '../../packages/core/src/security/keyManager';
import { initializeDatabase, closeDatabase, getDatabase } from '../../packages/core/src/db/index';
import { asAgent, asSystem } from '../../packages/core/src/services/actors';
import { asHuman } from '../../packages/core/src/services/actors';

const HUMAN = asHuman('test');

/**
 * Composition root smoke test (seed of the 3b server smoke test): a fresh data dir and config dir,
 * paper mode, no credentials. Network is stubbed to fail fast so the jobs started by `start()` and
 * `unlock()` (scorer, reconciler clock check) do not wait on real endpoints.
 */
describe.skipIf(!sqliteAvailable)('createCore', () => {
  let core: Core | null = null;
  let tmp: string | null = null;

  afterEach(() => {
    core?.close();
    core = null;
    vi.unstubAllGlobals();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  function boot(): Core {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline (test)');
      })
    );
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-core-'));
    core = createCore({ dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'config') });
    return core;
  }

  it('boots against an empty data dir, starts, and shuts down cleanly', async () => {
    const c = boot();
    await c.start();

    // Defaults written on first start; built-in templates seeded
    expect(fs.existsSync(path.join(tmp!, 'config', 'limits.yaml'))).toBe(true);
    expect(c.configService.getConfig()).not.toBeNull();
    expect(c.services.scripts.list().some((s) => s.isTemplate)).toBe(true);
    expect(c.services.bots.list()).toEqual([]);
    expect(c.services.risk.getState().bots).toEqual([]);
    expect(c.isUnlocked()).toBe(false);

    // Key-dependent calls are refused while locked
    await expect(c.services.bots.start('nope', HUMAN)).rejects.toMatchObject({ code: 'locked' });
    expect(() => c.services.reconcile.status()).toThrow(/Unlock/);

    const result = await c.shutdown({ timeoutMs: 20_000 });
    expect(result.clean).toBe(true);
    const marker = JSON.parse(fs.readFileSync(path.join(tmp!, 'data', SHUTDOWN_MARKER_FILE), 'utf8'));
    expect(JSON.stringify(marker)).toMatch(/clean/);
  }, 60_000);

  it('unlocks with a key, creates a paper bot, and shuts down cleanly', async () => {
    const c = boot();
    await c.start();
    expect(await c.unlock(crypto.randomBytes(32).toString('hex'))).toBe(true);
    expect(c.isUnlocked()).toBe(true);
    expect(await c.unlock('ignored')).toBe(false);

    const script = c.services.scripts.list().find((s) => s.isTemplate)!;
    const bot = await c.services.bots.create({ name: 'paper-1', scriptId: script.id, mode: 'paper' }, HUMAN);
    expect(bot.mode).toBe('paper');
    expect(c.services.bots.list().map((b) => b.id)).toEqual([bot.id]);

    const result = await c.shutdown({ timeoutMs: 20_000 });
    expect(result.clean).toBe(true);
  }, 60_000);
});

describe.skipIf(!sqliteAvailable)('createCore — lifecycle failures (3a review)', () => {
  let core: Core | null = null;
  let tmp: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    core?.close();
    core = null;
    vi.unstubAllGlobals();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  function boot(): Core {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline (test)');
      })
    );
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-core-'));
    core = createCore({ dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'config') });
    return core;
  }
  const key = () => crypto.randomBytes(32).toString('hex');

  it('unlock() refuses before start() has succeeded', async () => {
    const c = boot();
    await expect(c.unlock(key())).rejects.toThrow(/not started/);
    expect(c.isUnlocked()).toBe(false);
  });

  it('a failed start() is rolled back and can be retried; the startup halt is applied once', async () => {
    const c = boot();
    // Fails after the startup halt / shutdown marker step (template seeding)
    const spy = vi.spyOn(ScriptRepository.prototype, 'findByNameAndVersion').mockImplementationOnce(() => {
      throw new Error('seed boom');
    });
    await expect(c.start()).rejects.toThrow(/seed boom/);
    await expect(c.unlock(key())).rejects.toThrow(/not started/);
    spy.mockRestore();

    await c.start();
    // The retry did not read its own "running" marker as a crash
    expect(c.services.risk.getState().global?.halted ?? false).toBe(false);
    expect(c.services.scripts.list().some((s) => s.isTemplate)).toBe(true);
    expect(await c.unlock(key())).toBe(true);
    expect((await c.shutdown({ timeoutMs: 20_000 })).clean).toBe(true);
  }, 60_000);

  it('a failed unlock() leaves the core locked and can be retried', async () => {
    const c = boot();
    await c.start();
    const spy = vi.spyOn(BotManager.prototype, 'initialize').mockRejectedValueOnce(new Error('init boom'));
    // One master key per database (its key check is written by the first unlock)
    const masterKey = key();
    await expect(c.unlock(masterKey)).rejects.toThrow(/init boom/);
    expect(c.isUnlocked()).toBe(false);
    expect(c.botManager).toBeNull();
    expect(c.walletManager).toBeNull();
    expect(c.reconciler).toBeNull();
    expect(keyManager.isReady()).toBe(false);
    await expect(c.services.bots.start('x', HUMAN)).rejects.toMatchObject({ code: 'locked' });

    spy.mockRestore();
    await expect(c.unlock(key())).rejects.toMatchObject({ code: 'locked' });
    expect(c.isUnlocked()).toBe(false);
    expect(await c.unlock(masterKey)).toBe(true);
    expect(c.isUnlocked()).toBe(true);
    const script = c.services.scripts.list().find((s) => s.isTemplate)!;
    await c.services.bots.create({ name: 'after-retry', scriptId: script.id, mode: 'paper' }, HUMAN);
    expect((await c.shutdown({ timeoutMs: 20_000 })).clean).toBe(true);
  }, 60_000);

  it('a second database in the same process is refused; close() only closes its own handle', () => {
    const c = boot();
    const other = path.join(tmp!, 'other.db');
    // createCore / initializeDatabase with another path while this core's DB is open
    expect(() => initializeDatabase(other)).toThrow(/Another database is already open/);
    expect(() => createCore({ dataDir: path.join(tmp!, 'data2'), configDir: path.join(tmp!, 'config') })).toThrow(/Another database/);
    // Same path returns the same handle
    expect(initializeDatabase(path.join(tmp!, 'data', 'botlab.db'))).toBe(c.db);

    // Someone else closes the process DB and opens another; this core's close() must not close it
    closeDatabase();
    const second = initializeDatabase(other);
    c.close();
    expect(second.open).toBe(true);
    expect(getDatabase()).toBe(second);
    closeDatabase();
    core = null;
  });
});

describe.skipIf(!sqliteAvailable)('createCore — actors (3a review)', () => {
  let core: Core | null = null;
  let tmp: string | null = null;

  afterEach(() => {
    core?.close();
    core = null;
    vi.unstubAllGlobals();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  async function started(): Promise<Core> {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline (test)');
      })
    );
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-core-'));
    core = createCore({ dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'config') });
    await core.start();
    return core;
  }

  const lastAudit = (c: Core, action: string) => c.repos.auditRepo.list({ action }).at(0);

  it('only minted HumanActors pass human-only checks; strings and forged objects are refused and audited', async () => {
    const c = await started();
    c.halts.setGlobalHaltFlag('test halt', 'system');

    for (const fake of ['human', { kind: 'human', principal: 'forged' }, asAgent('agent-token'), asSystem()]) {
      expect(() => c.services.risk.clearHalt('global', 'trying', fake as never)).toThrow(/human/);
      await expect(c.services.config.write('limits', {}, fake as never)).rejects.toThrow(/human/);
      await expect(c.services.config.restore('limits', 'v', fake as never)).rejects.toThrow(/human/);
      await expect(c.services.markets.setAmbiguity('m1', 1, fake as never)).rejects.toThrow(/human/);
      expect(() => c.services.ledger.forceRightsState('economics', 'short', 'trading', 'x', fake as never)).toThrow(/human/);
    }
    expect(lastAudit(c, 'risk.halt_clear')).toMatchObject({ actor: 'system', result: 'denied: human only' });
    expect(c.repos.auditRepo.list({ action: 'risk.halt_clear' }).map((r) => r.result)).toContain('denied: human only (unauthenticated actor)');
    expect(c.services.risk.getState().global?.halted).toBe(true);

    c.services.risk.clearHalt('global', 'reviewed', asHuman('test-admin'));
    expect(c.services.risk.getState().global?.halted).toBe(false);
    expect(lastAudit(c, 'risk.halt_clear')).toMatchObject({ actor: 'human' });
  }, 60_000);

  it('service-level actor checks: config read, watchlist, kill switch', async () => {
    const c = await started();
    const agent = asAgent('agent-token');

    // Config: agent may read (secrets masked), not an unauthenticated caller
    expect(c.services.config.get(agent).config).not.toBeNull();
    expect(() => c.services.config.get('agent' as never)).toThrow(/unauthenticated/);
    expect(() => c.services.config.get(asSystem())).toThrow(/not allowed/);
    expect(c.services.config.history('limits', agent).length).toBeGreaterThan(0);

    // Watchlist: human or agent, recorded
    c.services.reconcile.watchlistAdd('123', null, null, agent);
    expect(lastAudit(c, 'recorder.watch_add')).toMatchObject({ actor: 'agent', target: '123' });
    expect(() => c.services.reconcile.watchlistAdd('456', null, null, asSystem())).toThrow(/not allowed/);
    expect(() => c.services.reconcile.watchlistRemove('123', 'human' as never)).toThrow(/unauthenticated/);
    expect(c.services.reconcile.watchlistRemove('123', HUMAN)).toEqual({ removed: true });

    // Kill switch: any authenticated actor, recorded; strings refused
    await expect(c.services.risk.killSwitch('x', 'agent' as never)).rejects.toThrow(/unauthenticated/);
    await c.services.risk.killSwitch('agent pressed it', agent);
    expect(lastAudit(c, 'risk.kill_switch')).toMatchObject({ actor: 'agent' });
    expect(c.services.risk.getState().global?.halted).toBe(true);
  }, 60_000);

  it('the agent can neither create nor start nor reconfigure bots on the standing builtin-role templates (R168)', async () => {
    const c = await started();
    const agent = asAgent('agent-token');
    const pm = c.services.scripts.list().find((s) => s.name === 'Position Manager')!;
    const ex = c.services.scripts.list().find((s) => s.name === 'Forecast Executor')!;
    for (const script of [pm, ex]) {
      await expect(c.services.bots.create({ name: 'x', scriptId: script.id }, agent)).rejects.toThrow(/standing bot only a human can create/);
    }
    // A position-manager bot, even one recorded as the agent's, can only be paused by the agent
    const wallet = c.repos.walletRepo.create({ name: 'w', address: '0xabc', privateKeyEncrypted: 'x' });
    const bot = c.repos.botRepo.create({ name: 'pm', scriptId: pm.id, walletId: wallet.id, mode: 'paper', createdBy: 'agent' });
    await expect(c.services.bots.start(bot.id, agent)).rejects.toThrow(/position-manager bots are standing bots/);
    await expect(c.services.bots.restart(bot.id, agent)).rejects.toThrow(/position-manager bots are standing bots/);
    expect(() => c.services.bots.update(bot.id, { config: { take_profit_margin: 0.5 } }, agent)).toThrow(/position-manager bots are standing bots/);
    expect(lastAudit(c, 'bot.update')).toMatchObject({ actor: 'agent', result: 'denied: position-manager bot' });
    // A human may
    expect(c.services.bots.update(bot.id, { config: { take_profit_margin: 0.03 } }, HUMAN).config).toMatchObject({ take_profit_margin: 0.03 });
  }, 60_000);
});
