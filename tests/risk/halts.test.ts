import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { sqliteAvailable } from '../orders/db';
import { openRiskHarness, type RiskHarness } from './riskHarness';
import { GLOBAL_SCOPE } from '../../electron/database/repositories/RiskStateRepository';
import { RISK_HALT_EVENT, type RiskHaltEvent } from '../../electron/risk/HaltService';

const DAY = 86_400_000;
const DAY_START = Date.parse('2026-06-02T00:00:00Z');
const T0 = DAY_START + 60_000; // first monitor run of the day

describe.skipIf(!sqliteAvailable)('halts, daily loss limits and the kill switch', () => {
  let h: RiskHarness;

  beforeEach(() => {
    h = openRiskHarness(T0);
  });
  afterEach(() => h.close());

  /** Bot b1 holds 200 t1 bought yesterday at 0.50 ($100 cost). */
  function setupLosingBot(stage = 'full'): void {
    h.addBot('b1', { stage });
    h.addFill('b1', 't1', 'BUY', 200, 0.5, DAY_START - 3_600_000);
    h.marks['polymarket:t1'] = 0.5;
  }

  it('bot loss over the limit ⇒ halted, orders cancelled, worker stopped, new orders rejected; only a human clears it', async () => {
    setupLosingBot();
    const orderId = h.addOpenOrder('b1', 'ex-9');
    h.running.add('b1');
    const events: RiskHaltEvent[] = [];
    h.halts.on(RISK_HALT_EVENT, (e: RiskHaltEvent) => events.push(e));

    // First run of the day captures the 0.50 day-start mark: no loss
    const r1 = await h.monitor.runOnce();
    expect(r1.newDay).toBe(true);
    expect(r1.halted).toEqual([]);
    expect(h.riskStateRepo.isHalted('b1')).toBe(false);

    // Price drops to 0.20: 200 × −0.30 = −60 ≥ per-bot limit 50 (global limit 100 not reached)
    h.marks['polymarket:t1'] = 0.2;
    h.clock.now = T0 + 60_000;
    const r2 = await h.monitor.runOnce();
    expect(r2.halted).toEqual(['b1']);
    expect(r2.killSwitch).toBe(false);

    const state = h.riskStateRepo.get('b1')!;
    expect(state.halted).toBe(1);
    expect(state.halted_reason).toMatch(/daily loss limit: live loss 60\.00 USD/);
    expect(state.day_unrealized_pnl).toBeCloseTo(-60);
    expect(h.riskStateRepo.isHalted(GLOBAL_SCOPE)).toBe(false);

    // Open order cancelled on the exchange and in the DB; worker stopped
    expect(h.poly.cancelOrders).toHaveBeenCalledWith(['ex-9']);
    expect(h.orderRepo.findById(orderId)!.status).toBe('cancelled');
    expect(h.stopBot).toHaveBeenCalledWith('b1', 'system');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ scope: 'b1', kind: 'bot' });

    // Loss halt of a full bot demotes it to probation (§4.5)
    expect(h.botRepo.findById('b1')!.stage).toBe('probation');

    // New orders are rejected
    const placed = await h.orderService('b1').placeMarketable({ tokenId: 't1', side: 'buy', amount: 10 });
    expect(placed).toMatchObject({ ok: false, status: 'rejected_risk', failedCheck: 'bot_halt' });
    expect(h.poly.postMarketOrder).not.toHaveBeenCalled();
    expect(h.auditRepo.list({ action: 'order.rejected' })[0]).toMatchObject({ actor: 'bot:b1', result: 'rejected_risk' });

    // Next UTC day: P&L resets, halt stays
    h.marks['polymarket:t1'] = 0.2;
    h.clock.now = T0 + DAY;
    const r3 = await h.monitor.runOnce();
    expect(r3.newDay).toBe(true);
    expect(h.riskStateRepo.get('b1')!.day_unrealized_pnl).toBeCloseTo(0);
    expect(h.riskStateRepo.isHalted('b1')).toBe(true);

    // Clearing: human only, reason required
    expect(() => h.halts.clearHalt('b1', 'looks fine', 'system')).toThrow(/human/);
    expect(() => h.halts.clearHalt('b1', 'looks fine', 'bot:b1')).toThrow(/human/);
    expect(() => h.halts.clearHalt('b1', '  ', 'human')).toThrow(/reason/);
    expect(h.riskStateRepo.isHalted('b1')).toBe(true);
    h.halts.clearHalt('b1', 'reviewed the loss', 'human');
    expect(h.riskStateRepo.isHalted('b1')).toBe(false);
    expect(h.riskStateRepo.get('b1')!.last_halted_at).not.toBeNull();

    const actions = h.auditRepo.list({ target: 'b1' }).map((r) => `${r.actor} ${r.action} ${r.result ?? ''}`.trim());
    expect(actions).toContain('system risk.halt');
    expect(actions).toContain('system bot.stage');
    expect(actions).toContain('human risk.halt_clear');
    expect(actions).toContain('system risk.halt_clear denied: human only');
  });

  it('a halted bot is not halted again and the loss check never clears it', async () => {
    setupLosingBot('probation');
    await h.monitor.runOnce();
    h.marks['polymarket:t1'] = 0.1;
    h.clock.now += 60_000;
    await h.monitor.runOnce();
    await h.monitor.runOnce();
    expect(h.auditRepo.list({ action: 'risk.halt', target: 'b1' })).toHaveLength(1);
    // probation is not demoted further
    expect(h.botRepo.findById('b1')!.stage).toBe('probation');
    // Price recovers: still halted
    h.marks['polymarket:t1'] = 0.9;
    h.clock.now += 60_000;
    await h.monitor.runOnce();
    expect(h.riskStateRepo.isHalted('b1')).toBe(true);
  });

  it('unavailable price: last known mark is used and a warning is audited (not treated as no loss)', async () => {
    setupLosingBot();
    await h.monitor.runOnce();
    h.marks['polymarket:t1'] = 0.2;
    h.clock.now += 60_000;
    await h.monitor.runOnce(); // halts b1 at 0.20; 0.20 becomes the last known mark
    h.halts.clearHalt('b1', 'test', 'human');

    delete h.marks['polymarket:t1']; // book unavailable
    h.clock.now += 60_000;
    const r = await h.monitor.runOnce();
    expect(r.staleMarks).toEqual(['polymarket:t1']);
    expect(r.bots.find((b) => b.scope === 'b1')!.result.totalPnl).toBeCloseTo(-60);
    expect(h.auditRepo.list({ action: 'risk.marks_stale' })).toHaveLength(1);
    // Loss still above the limit ⇒ halted again
    expect(h.riskStateRepo.isHalted('b1')).toBe(true);
  });

  it('global loss over the limit ⇒ kill switch', async () => {
    // Two bots, each −60: per-bot halts and a global loss of 120 ≥ 100
    setupLosingBot();
    h.addBot('b2', { stage: 'full' });
    h.addFill('b2', 't2', 'BUY', 200, 0.5, DAY_START - 3_600_000);
    h.marks['polymarket:t2'] = 0.5;
    await h.monitor.runOnce();
    h.marks['polymarket:t1'] = 0.2;
    h.marks['polymarket:t2'] = 0.2;
    h.clock.now += 60_000;
    const r = await h.monitor.runOnce();
    expect(r.killSwitch).toBe(true);
    expect(h.riskStateRepo.get(GLOBAL_SCOPE)!.halted_reason).toMatch(/global daily loss limit: loss 120\.00 USD/);
    expect(h.riskStateRepo.get(GLOBAL_SCOPE)!.day_unrealized_pnl).toBeCloseTo(-120);
  });

  it('kill switch: global halt, cancels open orders of running AND non-running bots (live and paper), stops workers', async () => {
    h.addBot('run', { stage: 'full' });
    h.addBot('idle', { stage: 'full' });
    h.addBot('paper', { stage: 'paper' });
    const a = h.addOpenOrder('run', 'ex-run');
    const b = h.addOpenOrder('idle', 'ex-idle');
    const c = h.addOpenOrder('paper', null, { simulated: true });
    const unknown = h.addOpenOrder('idle', null); // outcome unknown: no exchange id
    h.running.add('run');

    const result = await h.killSwitch.activate('test kill', 'human');

    expect(h.riskStateRepo.get(GLOBAL_SCOPE)).toMatchObject({ halted: 1, halted_reason: 'test kill' });
    const cancelledIds = h.poly.cancelOrders.mock.calls.flatMap((c) => c[0] as string[]);
    expect(cancelledIds).toEqual(expect.arrayContaining(['ex-run', 'ex-idle']));
    expect(h.orderRepo.findById(a)!.status).toBe('cancelled');
    expect(h.orderRepo.findById(b)!.status).toBe('cancelled');
    expect(h.orderRepo.findById(c)!.status).toBe('cancelled');
    expect(h.orderRepo.findById(unknown)!.status).toBe('open');
    expect(result).toMatchObject({ stopped: ['run'], cancelled: 3, unknownOutcome: 2 }); // counted in both passes
    expect(h.stopBot).toHaveBeenCalledWith('run', 'system');

    // Nothing can be ordered afterwards
    h.addBot('fresh', { stage: 'full' });
    const placed = await h.orderService('fresh').placeMarketable({ tokenId: 't1', side: 'buy', amount: 10 });
    expect(placed).toMatchObject({ status: 'rejected_risk', failedCheck: 'global_halt' });

    const audit = h.auditRepo.list({ target: GLOBAL_SCOPE }).map((r) => `${r.actor} ${r.action}`);
    expect(audit).toEqual(expect.arrayContaining(['human risk.kill_switch', 'system risk.kill_switch.done']));
  });

  it('kill switch reports orders it cannot cancel (no exchange client) instead of failing', async () => {
    h.addBot('idle', { stage: 'full' });
    const id = h.addOpenOrder('idle', 'ex-idle');
    h.poly.cancelOrders.mockRejectedValue(new Error('network down'));
    const result = await h.killSwitch.activate('test', 'system');
    expect(h.riskStateRepo.isHalted(GLOBAL_SCOPE)).toBe(true);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.errors.join(' ')).toMatch(/network down/);
    expect(h.orderRepo.findById(id)!.status).toBe('open');
    expect(h.auditRepo.list({ action: 'risk.kill_switch.done' })[0].result).toBe('partial');
  });

  it('audit_log is append-only', () => {
    h.audit.record('human', 'test.action', 'x', { a: 1 });
    expect(() => h.db.prepare("UPDATE audit_log SET actor = 'agent'").run()).toThrow(/append-only/);
    expect(() => h.db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    expect(h.auditRepo.list({ action: 'test.action' })[0]).toMatchObject({ actor: 'human', target: 'x', payload: '{"a":1}' });
  });
});
