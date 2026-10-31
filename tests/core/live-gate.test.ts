/**
 * Live trading is opt-in (Decision R98): with the default limits.yaml (`live_trading.enabled: false`)
 * BotManager.startBot refuses a bot that would run live, before touching its wallet or the network.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { Wallet } from 'ethers';
import { sqliteAvailable } from '../orders/db';
import { createCore, type Core } from '../../packages/core/src';
import { asHuman } from '../../packages/core/src/services/actors';

describe.skipIf(!sqliteAvailable)('live trading gate', () => {
  let core: Core | null = null;
  let tmp: string | null = null;

  afterEach(async () => {
    await core?.shutdown({ timeoutMs: 20_000 });
    core?.close();
    core = null;
    vi.unstubAllGlobals();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('BotManager.startBot refuses a live bot while live_trading.enabled is false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline (test)');
      })
    );
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-live-'));
    core = createCore({ dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'config'), backups: false });
    await core.start();
    await core.unlock(crypto.randomBytes(32).toString('hex'));
    expect(core.configService.getConfig()?.limits.live_trading.enabled).toBe(false);

    const human = asHuman('test');
    const w = Wallet.createRandom();
    const wallet = await core.services.wallets.create({ name: 'real', address: w.address, privateKey: w.privateKey });
    const script = core.services.scripts.list().find((s) => s.isTemplate && s.trust === 'proven')!; // proven template ⇒ probation, not paper stage
    const bot = await core.services.bots.create({ name: 'live-bot', scriptId: script.id, walletId: wallet.id, mode: 'live' }, human);
    expect(bot.mode).toBe('live');

    await expect(core.botManager!.startBot(bot.id, 'human')).rejects.toThrow(/Live trading is disabled/);
    expect(core.botManager!.isRunning(bot.id)).toBe(false);
    expect(core.repos.auditRepo.list({ action: 'bot.start' }).at(-1)?.result).toMatch(/Live trading is disabled/);
  }, 60_000);
});
