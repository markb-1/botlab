import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

// Fake worker runner: start() runs a hook so a test can set a halt while the bot is starting
const { FakeRunner, runners, runnerHooks } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: Emitter } = require('events') as typeof import('events');
  const runnerHooks: { onStart: () => void | Promise<void> } = { onStart: () => {} };
  const runners: Array<InstanceType<typeof FakeRunner>> = [];
  class FakeRunner extends Emitter {
    status = 'stopped';
    start = vi.fn(async () => {
      await runnerHooks.onStart();
      this.status = 'running';
    });
    stop = vi.fn(async () => {
      this.status = 'stopped';
    });
    constructor() {
      super();
      runners.push(this);
    }
  }
  return { FakeRunner, runners, runnerHooks };
});
vi.mock('../../electron/runtime/ScriptBotRunner', () => ({ ScriptBotRunner: FakeRunner }));

import { BotManager } from '../../src/core/BotManager';

const PRIVATE_KEY = '0x' + '11'.repeat(32);

describe('BotManager.startBot halt races', () => {
  let halts: Map<string, { halted: number; halted_reason: string }>;
  let botRepo: Record<string, ReturnType<typeof vi.fn>>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let walletManager: { getWallet: ReturnType<typeof vi.fn> };
  let manager: BotManager;

  beforeEach(() => {
    runners.length = 0;
    runnerHooks.onStart = () => {};
    halts = new Map();
    botRepo = {
      findById: vi.fn().mockReturnValue({
        id: 'b1', name: 'B1', script_id: 's1', wallet_id: 'w1', config: '{}', status: 'stopped', enabled: 1,
        mode: 'paper', stage: 'paper', last_started_at: null, last_stopped_at: null, last_heartbeat: null,
        error_logs: '[]', created_at: '', updated_at: '',
      }),
      update: vi.fn(),
      recordRunDay: vi.fn(),
      recordRuntimeError: vi.fn(),
      appendError: vi.fn(),
    };
    audit = { record: vi.fn() };
    walletManager = { getWallet: vi.fn().mockResolvedValue({ address: '0xabc', privateKey: PRIVATE_KEY }) };
    const settingsRepo = {
      get: () => ({ rpc_url: 'http://rpc', clob_http_url: 'http://clob', clob_ws_url: '', usdc_contract_address: '0x0' }),
    };
    const scriptRepo = { findById: () => ({ name: 'script', compiled: 'module.exports = {}', trust: 'new' }) };
    const riskStateRepo = { get: (scope: string) => halts.get(scope) };
    manager = new BotManager(
      walletManager as never,
      botRepo as never,
      {} as never,
      settingsRepo as never,
      scriptRepo as never,
      {} as never,
      {} as never,
      { db: {} as never, orderRepo: {} as never, riskStateRepo: riskStateRepo as never, audit: audit as never }
    );
  });

  it('starts when nothing is halted', async () => {
    await manager.startBot('b1', 'human');
    expect(manager.isRunning('b1')).toBe(true);
    expect(botRepo.recordRunDay).toHaveBeenCalledWith('b1');
  });

  it('a halt set while the wallet/client are prepared prevents the worker from starting', async () => {
    walletManager.getWallet.mockImplementation(async () => {
      halts.set('global', { halted: 1, halted_reason: 'kill switch' });
      return { address: '0xabc', privateKey: PRIVATE_KEY };
    });
    await expect(manager.startBot('b1', 'human')).rejects.toThrow(/Global halt active \(kill switch\)/);
    expect(runners[0]?.start ?? vi.fn()).not.toHaveBeenCalled();
    expect(manager.isRunning('b1')).toBe(false);
  });

  it('a halt set while the worker is starting stops it right after start and audits', async () => {
    runnerHooks.onStart = () => {
      halts.set('b1', { halted: 1, halted_reason: 'daily loss limit' });
    };
    await expect(manager.startBot('b1', 'human')).rejects.toThrow(/Bot is halted \(daily loss limit\)/);
    expect(runners[0].start).toHaveBeenCalled();
    expect(runners[0].stop).toHaveBeenCalled();
    expect(manager.isRunning('b1')).toBe(false);
    expect(manager.runningBotIds()).toEqual([]);
    expect(botRepo.update).toHaveBeenCalledWith('b1', expect.objectContaining({ status: 'stopped' }));
    expect(audit.record).toHaveBeenCalledWith('system', 'bot.stop', 'b1', expect.objectContaining({ reason: expect.stringMatching(/halted during start/) }), 'ok');
    expect(audit.record).toHaveBeenCalledWith('human', 'bot.start', 'b1', undefined, expect.stringMatching(/^error: Bot is halted/));
  });

  it('a fatal worker error (watchdog / unresponsive) marks the bot error and audits it', async () => {
    await manager.startBot('b1', 'human');
    const runner = runners[0];
    runner.emit('bot:event', { type: 'error', botId: 'b1', data: { fatal: true, reason: 'worker_unresponsive', message: 'blocked' } });
    expect(manager.isRunning('b1')).toBe(false);
    expect(botRepo.update).toHaveBeenCalledWith('b1', expect.objectContaining({ status: 'error' }));
    expect(botRepo.appendError).toHaveBeenCalledWith('b1', 'blocked');
    expect(audit.record).toHaveBeenCalledWith('system', 'bot.error', 'b1', { reason: 'worker_unresponsive', message: 'blocked' }, 'terminated');
  });
});
