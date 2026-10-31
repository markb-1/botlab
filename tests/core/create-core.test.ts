import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { sqliteAvailable } from '../orders/db';
import { createCore, type Core } from '../../packages/core/src';
import { SHUTDOWN_MARKER_FILE } from '../../packages/core/src/risk/StartupRecovery';

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
    await expect(c.services.bots.start('nope', 'human')).rejects.toMatchObject({ code: 'locked' });
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
    const bot = await c.services.bots.create({ name: 'paper-1', scriptId: script.id, mode: 'paper' }, 'human');
    expect(bot.mode).toBe('paper');
    expect(c.services.bots.list().map((b) => b.id)).toEqual([bot.id]);

    const result = await c.shutdown({ timeoutMs: 20_000 });
    expect(result.clean).toBe(true);
  }, 60_000);
});
