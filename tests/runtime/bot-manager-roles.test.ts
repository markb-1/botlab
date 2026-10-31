/**
 * BotManager and the standing builtin roles (5a review): one running bot per role and mode (R167); the exit
 * OrderService for a stopped bot is transient (not registered as running), works on that bot's paper orders,
 * and the owner's own cancels leave the manager's exits alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../packages/core/src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const { FakeRunner } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: Emitter } = require('events') as typeof import('events');
  class FakeRunner extends Emitter {
    status = 'stopped';
    start = vi.fn(async () => {
      this.status = 'running';
    });
    stop = vi.fn(async () => {
      this.status = 'stopped';
    });
    pushEvent = vi.fn();
  }
  return { FakeRunner };
});
vi.mock('../../packages/core/src/runtime/ScriptBotRunner', () => ({ ScriptBotRunner: FakeRunner, DEFAULT_PAPER_BALANCE: 10_000 }));

import { sqliteAvailable, openTestDb, type TestDb } from '../orders/db';
import { BotManager } from '../../packages/core/src/bots/BotManager';
import { ScriptRepository } from '../../packages/core/src/db/repositories/ScriptRepository';
import { SettingsRepository } from '../../packages/core/src/db/repositories/SettingsRepository';
import { WalletRepository } from '../../packages/core/src/db/repositories/WalletRepository';
import { LimitsSchema, MandateSchema } from '../../packages/core/src/config';

const PRIVATE_KEY = '0x' + '11'.repeat(32);

describe.skipIf(!sqliteAvailable)('BotManager standing roles', () => {
  let t: TestDb;
  let manager: BotManager;
  let pmScript: string;

  beforeEach(async () => {
    t = openTestDb();
    const scripts = new ScriptRepository(t.db);
    const pm = scripts.create({ name: 'Position Manager', source: 'x', compiled: 'module.exports = {}', isTemplate: true, origin: 'builtin', trust: 'new' });
    scripts.setBuiltinRole(pm.id, 'position-manager');
    pmScript = pm.id;
    for (const id of ['pm1', 'pm2', 'owner']) {
      t.addBot(id, { stage: 'paper' });
      t.db.prepare("UPDATE bots SET mode = 'paper' WHERE id = ?").run(id);
    }
    t.db.prepare('UPDATE bots SET script_id = ? WHERE id IN (?, ?)').run(pmScript, 'pm1', 'pm2');
    t.db.prepare("UPDATE scripts SET compiled = 'module.exports = {}' WHERE id = 's1'").run();
    const config = {
      getConfig: () => ({ limits: LimitsSchema.parse({}), mandate: MandateSchema.parse({}), fees: undefined }),
      getLastError: () => null,
      onChange: () => () => {},
    };
    manager = new BotManager(
      { getWallet: vi.fn().mockResolvedValue({ address: '0xabc', privateKey: PRIVATE_KEY }) } as never,
      t.botRepo,
      new WalletRepository(t.db),
      new SettingsRepository(t.db),
      scripts,
      t.storageRepo,
      t.tradeRepo,
      { db: t.db, orderRepo: t.orderRepo, riskStateRepo: t.riskStateRepo, config: config as never }
    );
    await manager.initialize();
  });

  afterEach(() => t.close());

  it('runs one bot per role and mode', async () => {
    await manager.startBot('pm1', 'human');
    expect(manager.getRunningRole('pm1')).toBe('position-manager');
    await expect(manager.startBot('pm2', 'human')).rejects.toThrow(/position-manager bot is already running in paper mode/);
    expect(manager.isRunning('pm2')).toBe(false);
    // A bot on a script without a role is unaffected; after the first stops, the second may run
    await manager.startBot('owner', 'human');
    await manager.stopBot('pm1', 'human');
    await manager.startBot('pm2', 'human');
    expect(manager.isRunning('pm2')).toBe(true);
  });

  it('builds a transient exit OrderService for a stopped bot; the owner cannot cancel the manager\'s exit', async () => {
    const exitRow = t.orderRepo.create({
      botId: 'owner', exchange: 'polymarket', marketId: 'm1', tokenId: 't1', side: 'sell', orderType: 'limit',
      price: 0.6, size: 5, notionalUsd: 3, status: 'open', simulated: true, placedBy: 'pm1', expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const own = t.orderRepo.create({
      botId: 'owner', exchange: 'polymarket', marketId: 'm1', tokenId: 't1', side: 'buy', orderType: 'limit',
      price: 0.4, size: 5, notionalUsd: 2, status: 'open', simulated: true, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const svc = await manager.getExitOrderService('owner', true);
    expect(manager.getRunningOrderService('owner', true)).toBeNull(); // not registered as running
    expect(manager.isRunning('owner')).toBe(false);

    // The owner's own cancel paths leave the manager's exit alone
    await expect(svc.cancel(exitRow.id)).rejects.toThrow(/placed by the position manager/);
    const all = await (svc as unknown as { cancelAll(): Promise<{ cancelled: number }> }).cancelAll();
    expect(all.cancelled).toBe(1);
    expect(t.orderRepo.findById(own.id)!.status).toBe('cancelled');
    expect(t.orderRepo.findById(exitRow.id)!.status).toBe('open');
    // The manager that placed it can
    await svc.cancel(exitRow.id, { placedBy: 'pm1' });
    expect(t.orderRepo.findById(exitRow.id)!.status).toBe('cancelled');

    await expect(manager.getExitOrderService('nope', true)).rejects.toThrow(/Bot not found/);
  });
});
