/**
 * Copy-trading leader scoring (spec §9.5, 5c): the pure scoring function (round trips per leader and token, sells
 * attributed to the copied leader first then pro rata, resolution closes, fees, hit rate, unrealised at the mark), the
 * auto-drop rule (last 20 closed copies since active: net P&L < 0 and hit rate < 50 %), and CopyLeaderService on the
 * real schema: attribution, sync with the config, auto-drop audited + Telegram, human-only re-activation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { autoDropDecision, scoreCopyFills, type ScoringFill } from '../../packages/core/src/copy/scoring';
import { sqliteAvailable, openTestDb, type TestDb } from '../orders/db';
import { CopyLeaderRepository } from '../../packages/core/src/db/repositories/CopyLeaderRepository';
import { CopyLeaderService } from '../../packages/core/src/services/CopyLeaderService';
import { AuditService } from '../../packages/core/src/audit/AuditService';
import { AuditRepository } from '../../packages/core/src/db/repositories/AuditRepository';
import { NotificationService } from '../../packages/core/src/notify/NotificationService';
import { asAgent, asHuman } from '../../packages/core/src/services/actors';

const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const at = (min: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + min * 60_000).toISOString();
const buy = (min: number, tokenId: string, shares: number, price: number, leader: string | null, fee = 0): ScoringFill => ({
  tokenId,
  side: 'BUY',
  shares,
  usd: shares * price,
  feeUsd: fee,
  at: at(min),
  simulated: true,
  leader,
});
const sell = (min: number, tokenId: string, shares: number, price: number, leader: string | null, fee = 0): ScoringFill => ({
  tokenId,
  side: 'SELL',
  shares,
  usd: shares * price,
  feeUsd: fee,
  at: at(min),
  simulated: true,
  leader,
});

describe('scoreCopyFills', () => {
  it('scores round trips per leader with fees; partial sells realise; open lots marked', () => {
    const r = scoreCopyFills(
      [
        buy(0, 't1', 10, 0.4, A, 0.1),
        sell(5, 't1', 5, 0.6, A),
        sell(6, 't1', 5, 0.3, A), // closes: proceeds 3 + 1.5 − cost 4.1 = +0.4
        buy(10, 't2', 10, 0.5, A),
        sell(11, 't2', 10, 0.45, null), // Position Manager exit (untagged): −0.5
        buy(20, 't3', 20, 0.25, A), // open
      ],
      (t) => (t === 't3' ? 0.3 : null)
    );
    expect(r.closed.map((c) => c.pnlUsd)).toEqual([0.4, -0.5]);
    const a = r.leaders.get(A)!;
    expect(a).toMatchObject({ closedTrades: 2, openTrades: 1, wins: 1, hitRate: 0.5, realisedPnlUsd: -0.1, unrealisedPnlUsd: 1, openCostUsd: 5 });
  });

  it('attributes a tagged sell to its leader first, untagged sells pro rata; resolution closes at the payout', () => {
    const r = scoreCopyFills([
      buy(0, 't', 10, 0.5, A),
      buy(1, 't', 30, 0.5, B),
      sell(2, 't', 10, 0.7, A), // A's copy closes +2
      sell(3, 't', 15, 0.4, null), // half of B's lot: −1.5
      sell(4, 't', 15, 1, null), // resolution: B's rest at 1: +7.5 ⇒ B round trip +6
    ]);
    expect(r.closed.map((c) => [c.leader, c.pnlUsd])).toEqual([
      [A, 2],
      [B, 6],
    ]);
    // An untagged sell across two leaders splits by holdings
    const p = scoreCopyFills([buy(0, 't', 10, 0.5, A), buy(1, 't', 30, 0.5, B), sell(2, 't', 20, 0.5, null)]);
    expect(p.open.map((o) => [o.leader, o.shares])).toEqual([
      [A, 5],
      [B, 15],
    ]);
    // Paper and live are separate books; untagged buys are never reported
    const m = scoreCopyFills([buy(0, 't', 10, 0.5, A), { ...sell(1, 't', 10, 0.9, A), simulated: false }, buy(2, 'u', 5, 0.5, null)]);
    expect(m.closed).toHaveLength(0);
    expect([...m.leaders.keys()]).toEqual([A]);
  });
});

describe('autoDropDecision', () => {
  const trades = (pnls: number[], leader = A, from = 0) =>
    pnls.map((p, i) => ({
      leader,
      tokenId: `t${i}`,
      simulated: true,
      openedAt: at(from + i * 10),
      closedAt: at(from + i * 10 + 5),
      costUsd: 1,
      proceedsUsd: 1 + p,
      pnlUsd: p,
      win: p > 0,
    }));

  it('drops only with 20 closed copies, net P&L < 0 and hit rate < 50 %', () => {
    // 19 closed losers: not enough
    expect(autoDropDecision(trades(Array(19).fill(-1)), A, null).drop).toBe(false);
    // 9 wins of 20, net −1 ⇒ drop
    const losing = [...Array(9).fill(1), ...Array(10).fill(-1), -1];
    expect(autoDropDecision(trades(losing), A, null)).toMatchObject({ drop: true, trades: 20, windowPnlUsd: -2, windowHitRate: 0.45 });
    // 10 wins of 20 (hit rate 50 %) but net negative ⇒ kept
    expect(autoDropDecision(trades([...Array(10).fill(0.5), ...Array(10).fill(-1)]), A, null).drop).toBe(false);
    // Hit rate 20 % but net positive ⇒ kept
    expect(autoDropDecision(trades([...Array(4).fill(10), ...Array(16).fill(-1)]), A, null).drop).toBe(false);
    // Only the last 20 count; trades opened before activeSince do not
    expect(autoDropDecision(trades([...Array(20).fill(-1), ...Array(20).fill(1)]), A, null).drop).toBe(false);
    expect(autoDropDecision(trades(Array(25).fill(-1)), A, at(100)).trades).toBe(15);
  });
});

describe.skipIf(!sqliteAvailable)('CopyLeaderService', () => {
  let t: TestDb;
  let service: CopyLeaderService;
  let audit: AuditService;
  let now = 0;

  beforeEach(() => {
    // Leaders are added before the fills below (2026-06-01)
    now = Date.parse('2026-05-31T00:00:00Z');
    t = openTestDb();
    t.addBot('cb');
    audit = new AuditService(new AuditRepository(t.db));
    service = new CopyLeaderService({ repo: new CopyLeaderRepository(t.db), botRepo: t.botRepo, audit, now: () => now, mark: () => 0.5 });
  });
  afterEach(() => t.close());

  /** An order-linked paper fill of bot cb, attributed to `leader` when given */
  let n = 0;
  function fill(side: 'BUY' | 'SELL', price: number, minute: number, leader: string | null, tokenId = `tok${minute}`) {
    const orderId = `o${++n}`;
    t.db
      .prepare(
        `INSERT INTO bot_trades (id, bot_id, side, exchange, symbol, price, quantity, quote_amount, simulated, order_id, fee_usd, executed_at, created_at)
         VALUES (?, 'cb', ?, 'polymarket', ?, ?, 10, ?, 1, ?, 0, ?, ?)`
      )
      .run(`f${n}`, side, tokenId, price, price * 10, orderId, at(minute), at(minute));
    if (leader) service.recordOrder('cb', orderId, { leader, side: side === 'BUY' ? 'buy' : 'sell', key: `k${n}` });
  }

  it('syncs leaders with the config; removed come back with a new window; dropped stay dropped', () => {
    service.sync('cb', { leaders: [A.toUpperCase().replace('0X', '0x'), B] }, 'agent');
    expect(service.leaders('cb').leaders.map((l) => [l.address, l.status, l.addedBy])).toEqual([
      [A, 'active', 'agent'],
      [B, 'active', 'agent'],
    ]);
    service.sync('cb', { leaders: [A] }, 'human');
    expect(service.leaders('cb').leaders.find((l) => l.address === B)!.status).toBe('removed');
    now += 60_000;
    service.sync('cb', { traders: [A, B] }, 'human'); // pre-5c key
    const b = service.leaders('cb').leaders.find((l) => l.address === B)!;
    expect(b).toMatchObject({ status: 'active', addedBy: 'human' });
    expect(b.activeSince).toBe(new Date(now).toISOString());
  });

  it('auto-drops a leader whose last 20 copies lose (audited, Telegram), the bot sees it dropped; only a human re-activates', async () => {
    const notifier = { send: vi.fn(), flush: vi.fn(async () => undefined), answerCallback: vi.fn() };
    const notify = new NotificationService({
      notifier: notifier as never,
      audit,
      killSwitch: { activate: vi.fn() } as never,
      botRepo: t.botRepo,
      riskStateRepo: t.riskStateRepo,
      getLimits: () => null,
      getServer: () => null,
      getExposureUsd: () => 0,
      stopBot: vi.fn(),
      isRunning: () => false,
    });
    service.sync('cb', { leaders: [A, B] }, 'agent');
    // Leader A: 20 closed copies, 8 wins (+1 each), 12 losses (−1 each) ⇒ net −4, hit 40 %
    for (let i = 0; i < 20; i++) {
      const tok = `a${i}`;
      fill('BUY', 0.5, i * 2, A, tok);
      fill('SELL', i < 8 ? 0.6 : 0.4, i * 2 + 1, A, tok);
    }
    // Leader B: 20 closed copies, all winners
    for (let i = 0; i < 20; i++) {
      fill('BUY', 0.5, 100 + i * 2, B, `b${i}`);
      fill('SELL', 0.55, 101 + i * 2, B, `b${i}`);
    }
    const before = service.leaders('cb').leaders.find((l) => l.address === A)!;
    expect(before).toMatchObject({
      ordersCopied: 40,
      closedTrades: 20,
      wins: 8,
      hitRate: 0.4,
      realisedPnlUsd: -4,
      window: { trades: 20, pnlUsd: -4, hitRate: 0.4 },
    });

    const statuses = service.statusFor('cb', [A, B]);
    expect(statuses).toEqual([
      { address: A, status: 'dropped', droppedReason: expect.stringMatching(/auto-drop: last 20 closed copied trades: net -\$4.00, hit rate 40%/) },
      { address: B, status: 'active', droppedReason: null },
    ]);
    const rows = new AuditRepository(t.db).list({ action: 'copy.leader_dropped' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'system', target: 'cb' });
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/Copy leader dropped on cb: 0xaaaa/) }));
    // Sticky: a second evaluation does not re-drop or re-notify; the agent cannot re-activate
    service.evaluate('cb');
    expect(new AuditRepository(t.db).list({ action: 'copy.leader_dropped' })).toHaveLength(1);
    expect(() => service.reactivate('cb', A, asAgent('token:x'))).toThrow();
    // Re-adding it in the config leaves it dropped
    service.sync('cb', { leaders: [B] }, 'agent');
    service.sync('cb', { leaders: [A, B] }, 'agent');
    expect(service.leaders('cb').leaders.find((l) => l.address === A)!.status).toBe('dropped');
    // A human re-activates it: a new window starts (old losses no longer count)
    now = Date.parse('2026-06-02T00:00:00Z');
    service.reactivate('cb', A, asHuman('session:x'));
    const after = service.leaders('cb').leaders.find((l) => l.address === A)!;
    expect(after).toMatchObject({ status: 'active', window: { trades: 0 } });
    expect(service.evaluate('cb')).toEqual([]);
    expect(service.digestText()).toMatch(/Copy leaders:\n- cb 0xaaaa…aaaa: active, 20 closed \/ 0 open, hit 40%, realised -\$4.00/);
    notify.stop?.();
  });
});

describe.skipIf(!sqliteAvailable)('Copy Trading v2 seed upgrade (5c)', () => {
  let t: TestDb;
  beforeEach(() => {
    t = openTestDb();
  });
  afterEach(() => t.close());

  it('updates the v1 builtin row in place: version, source, schema, trust new, role copy; its bots go back to paper', async () => {
    const { ScriptRepository, builtinRoleOf } = await import('../../packages/core/src/db/repositories/ScriptRepository');
    const { seedTemplates } = await import('../../packages/core/src/db/seed');
    const fs = await import('fs');
    const path = await import('path');
    const scripts = new ScriptRepository(t.db);
    const v1 = scripts.create({
      name: 'Copy Trading',
      version: '1.0.0',
      source: 'export const meta = { name: "Copy Trading", version: "1.0.0" };\nexport async function onTick() {}\n',
      compiled: 'module.exports = {}',
      configSchema: { properties: { traders: { type: 'array' } } },
      isTemplate: true,
      origin: 'builtin',
    });
    expect(v1.trust).toBe('proven');
    t.addBot('old', { stage: 'full' });
    t.db.prepare('UPDATE bots SET script_id = ? WHERE id = ?').run(v1.id, 'old');
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'copy-trading.ts'), 'utf8');
    const log = console.log;
    console.log = () => {};
    try {
      await seedTemplates(scripts, [{ filename: 'copy-trading.ts', source }]);
    } finally {
      console.log = log;
    }
    const rows = scripts.findAll().filter((s) => s.name === 'Copy Trading');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({ id: v1.id, version: '2.0.0', trust: 'new' });
    expect(builtinRoleOf(row)).toBe('copy');
    expect(JSON.parse(row.config_schema).properties.leaders).toBeTruthy();
    expect(t.botRepo.findById('old')!.stage).toBe('paper');
  });
});
