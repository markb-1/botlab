import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { sqliteAvailable } from '../orders/db';
import { openRiskHarness, type RiskHarness } from './riskHarness';
import { GLOBAL_SCOPE } from '../../electron/database/repositories/RiskStateRepository';
import { ShutdownMarker, applyStartupHalt, recoverOpenOrders, UNCLEAN_SHUTDOWN_REASON } from '../../electron/risk/StartupRecovery';

const DAY = 86_400_000;
const T0 = Date.parse('2026-06-02T12:00:00Z');

describe('ShutdownMarker', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-marker-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('missing ⇒ unknown, running ⇒ unclean, clean ⇒ clean, garbage ⇒ unclean', () => {
    const m = new ShutdownMarker(dir);
    expect(m.readPrevious()).toBe('unknown');
    m.markRunning();
    expect(new ShutdownMarker(dir).readPrevious()).toBe('unclean');
    m.markClean();
    expect(new ShutdownMarker(dir).readPrevious()).toBe('clean');
    fs.writeFileSync(m.file, '{not json');
    expect(m.readPrevious()).toBe('unclean');
  });
});

describe.skipIf(!sqliteAvailable)('startup recovery', () => {
  let h: RiskHarness;
  let dir: string;

  beforeEach(() => {
    h = openRiskHarness(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-startup-'));
  });
  afterEach(() => {
    h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Simulate a previous run that never shut down cleanly. */
  const crashedBefore = () => new ShutdownMarker(dir).markRunning();

  it('unclean previous shutdown ⇒ starts globally halted (and audits it)', () => {
    crashedBefore();
    const r = applyStartupHalt({ marker: new ShutdownMarker(dir), startHaltedAfterCrash: true, halts: h.halts, audit: h.audit });
    expect(r).toEqual({ previous: 'unclean', halted: true });
    expect(h.riskStateRepo.get(GLOBAL_SCOPE)).toMatchObject({ halted: 1, halted_reason: UNCLEAN_SHUTDOWN_REASON });
    expect(h.auditRepo.list({ action: 'risk.halt', target: GLOBAL_SCOPE })).toHaveLength(1);
    // This run is now marked running (a crash now is unclean again)
    expect(new ShutdownMarker(dir).readPrevious()).toBe('unclean');
  });

  it('unreadable config (null) is treated as start_halted_after_crash: true', () => {
    crashedBefore();
    applyStartupHalt({ marker: new ShutdownMarker(dir), startHaltedAfterCrash: null, halts: h.halts, audit: h.audit });
    expect(h.riskStateRepo.isHalted(GLOBAL_SCOPE)).toBe(true);
  });

  it('start_halted_after_crash: false, a clean shutdown, or no marker ⇒ not halted', () => {
    crashedBefore();
    applyStartupHalt({ marker: new ShutdownMarker(dir), startHaltedAfterCrash: false, halts: h.halts, audit: h.audit });
    expect(h.riskStateRepo.isHalted(GLOBAL_SCOPE)).toBe(false);

    new ShutdownMarker(dir).markClean();
    applyStartupHalt({ marker: new ShutdownMarker(dir), startHaltedAfterCrash: true, halts: h.halts, audit: h.audit });
    expect(h.riskStateRepo.isHalted(GLOBAL_SCOPE)).toBe(false);

    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-fresh-'));
    try {
      expect(applyStartupHalt({ marker: new ShutdownMarker(fresh), startHaltedAfterCrash: true, halts: h.halts, audit: h.audit }).previous).toBe('unknown');
      expect(h.riskStateRepo.isHalted(GLOBAL_SCOPE)).toBe(false);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('an existing halt survives a restart', () => {
    h.riskStateRepo.setHalted(GLOBAL_SCOPE, true, 'manual');
    new ShutdownMarker(dir).markClean();
    applyStartupHalt({ marker: new ShutdownMarker(dir), startHaltedAfterCrash: true, halts: h.halts, audit: h.audit });
    expect(h.riskStateRepo.get(GLOBAL_SCOPE)).toMatchObject({ halted: 1, halted_reason: 'manual' });
  });

  it('syncs and cancels orphan orders, records fills seen on the exchange, resets stale bot status', async () => {
    h.addBot('b1', { stage: 'full' });
    h.botRepo.updateStatus('b1', 'running'); // left over from the crash
    const resting = h.addOpenOrder('b1', 'ex-1');
    const filled = h.addOpenOrder('b1', 'ex-2');
    h.poly.getOrder.mockImplementation(async (id: string) =>
      id === 'ex-2' ? { status: 'MATCHED', sizeMatched: 10, originalSize: 10, price: 0.4 } : { status: 'LIVE', sizeMatched: 0, originalSize: 10, price: 0.4 }
    );

    const results = await recoverOpenOrders({ botRepo: h.botRepo, canceller: h.canceller, audit: h.audit, isBotRunning: () => false });

    expect(h.orderRepo.findById(resting)!.status).toBe('cancelled');
    expect(h.orderRepo.findById(filled)!.status).toBe('filled');
    expect(h.poly.cancelOrders).toHaveBeenCalledWith(['ex-1']);
    expect(h.tradeRepo.getRiskPositions({ simulated: false })).toHaveLength(1);
    expect(h.botRepo.findById('b1')!.status).toBe('stopped');
    expect(results[0]).toMatchObject({ botId: 'b1', cancelled: 1, failed: 0 });
    expect(h.auditRepo.list({ action: 'startup.orphan_orders' })[0]).toMatchObject({ target: 'b1', result: 'ok' });
    expect(h.auditRepo.list({ action: 'startup.bot_status_reset' })).toHaveLength(1);
  });

  it('skips bots that are running', async () => {
    h.addBot('b1', { stage: 'full' });
    const id = h.addOpenOrder('b1', 'ex-1');
    await recoverOpenOrders({ botRepo: h.botRepo, canceller: h.canceller, audit: h.audit, isBotRunning: () => true });
    expect(h.orderRepo.findById(id)!.status).toBe('open');
  });
});

describe.skipIf(!sqliteAvailable)('ramp in the risk monitor', () => {
  let h: RiskHarness;

  beforeEach(() => {
    h = openRiskHarness(T0);
    h.marks['polymarket:t1'] = 0.5;
  });
  afterEach(() => h.close());

  function probationBot(id: string, fills: number): void {
    h.addBot(id, { stage: 'probation' });
    const since = new Date(T0 - DAY).toISOString();
    h.db.prepare('UPDATE bots SET stage_changed_at = ?, template_version = 1 WHERE id = ?').run(since, id);
    for (let i = 0; i < fills; i++) {
      h.addFill(id, 't1', i % 2 === 0 ? 'BUY' : 'SELL', 1, 0.5, T0 - DAY + (i + 1) * 60_000);
    }
  }

  it('probation → full when criteria are met; the template becomes proven after 2 such bots', async () => {
    probationBot('p1', 20);
    probationBot('p2', 20);
    probationBot('p3', 19);
    await h.monitor.runOnce(); // starts drawdown tracking
    expect(h.botRepo.findById('p1')!.stage).toBe('probation');

    h.clock.now = T0 + 7 * DAY;
    const r = await h.monitor.runOnce();
    expect(r.promotions.map((p) => `${p.botId}:${p.to}`).sort()).toEqual(['p1:full', 'p2:full']);
    expect(h.botRepo.findById('p1')).toMatchObject({ stage: 'full' });
    expect(h.botRepo.findById('p1')!.reached_full_at).not.toBeNull();
    expect(h.botRepo.findById('p3')!.stage).toBe('probation');
    expect(h.scriptRepo.findById('s1')!.trust).toBe('proven');
    expect(h.auditRepo.list({ action: 'script.trust', target: 's1' })).toHaveLength(1);
    expect(h.auditRepo.list({ action: 'bot.stage' }).map((a) => a.target).sort()).toEqual(['p1', 'p2']);
  });

  it('a halt during probation blocks promotion', async () => {
    probationBot('p1', 20);
    await h.monitor.runOnce();
    h.riskStateRepo.setHalted('p1', true, 'test');
    h.riskStateRepo.setHalted('p1', false);
    h.clock.now = T0 + 7 * DAY;
    await h.monitor.runOnce();
    expect(h.botRepo.findById('p1')!.stage).toBe('probation');
  });

  it('paper → probation after the paper days; blocked (audited once) when approvals are required', async () => {
    h.addBot('pp', { stage: 'paper' });
    h.db
      .prepare('UPDATE bots SET stage_changed_at = ?, last_started_at = ? WHERE id = ?')
      .run(new Date(T0 - 8 * DAY).toISOString(), new Date(T0 - 7.5 * DAY).toISOString(), 'pp');

    h.limits.approvals.new_template_live = true;
    await h.monitor.runOnce();
    await h.monitor.runOnce();
    expect(h.botRepo.findById('pp')!.stage).toBe('paper');
    expect(h.auditRepo.list({ action: 'bot.stage_blocked', target: 'pp' })).toHaveLength(1);

    h.limits.approvals.new_template_live = false;
    await h.monitor.runOnce();
    expect(h.botRepo.findById('pp')!.stage).toBe('probation');
  });

  it('no promotions while globally halted', async () => {
    h.addBot('pp', { stage: 'paper' });
    h.db
      .prepare('UPDATE bots SET stage_changed_at = ?, last_started_at = ? WHERE id = ?')
      .run(new Date(T0 - 8 * DAY).toISOString(), new Date(T0 - 7.5 * DAY).toISOString(), 'pp');
    h.riskStateRepo.setHalted(GLOBAL_SCOPE, true, 'test');
    await h.monitor.runOnce();
    expect(h.botRepo.findById('pp')!.stage).toBe('paper');
  });
});

describe.skipIf(!sqliteAvailable)('script versions', () => {
  let h: RiskHarness;
  beforeEach(() => {
    h = openRiskHarness(T0);
  });
  afterEach(() => h.close());

  it('every source change bumps the revision, stores a version row and resets trust (except builtin)', () => {
    const s = h.scriptRepo.create({ name: 'mine', source: 'a', compiled: 'A' });
    expect(s).toMatchObject({ revision: 1, trust: 'new', origin: 'human', kind: 'custom' });
    h.scriptRepo.setTrust(s.id, 'proven');

    h.scriptRepo.update(s.id, { description: 'no source change' });
    expect(h.scriptRepo.findById(s.id)).toMatchObject({ revision: 1, trust: 'proven' });

    const v2 = h.scriptRepo.update(s.id, { source: 'b', compiled: 'B' })!;
    expect(v2).toMatchObject({ revision: 2, trust: 'new' });
    expect(h.scriptRepo.findVersions(s.id).map((v) => [v.version, v.source, v.compiled, v.created_by])).toEqual([
      [2, 'b', 'B', 'human'],
      [1, 'a', 'A', 'human'],
    ]);

    const builtin = h.scriptRepo.create({ name: 'tpl', source: 'x', isTemplate: true, origin: 'builtin' });
    expect(builtin).toMatchObject({ trust: 'proven', kind: 'template', origin: 'builtin' });
    expect(h.scriptRepo.update(builtin.id, { source: 'y' }, 'system')).toMatchObject({ revision: 2, trust: 'proven' });
  });
});
