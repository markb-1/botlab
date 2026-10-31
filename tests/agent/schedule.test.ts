/**
 * Agent schedule rules (spec §7.1, chunk 4b): local times in Europe/Dublin across DST, the 00:00–07:00 quiet
 * hours, due-slot handling with a grace window, and the event-run cap / debounce / quiet-hour rules.
 */

import { describe, it, expect } from 'vitest';
import {
  acceptTrigger,
  decideEventRun,
  dueScheduledRun,
  isQuietHours,
  localToUtc,
  nextScheduledRuns,
  startOfLocalDay,
} from '../../packages/core/src/agent/schedule';
import { ServerSchema } from '../../packages/core/src/config/serverSchema';

const TZ = 'Europe/Dublin';
const SCHEDULE = { review: '07:30', cycles: ['11:30', '15:30', '19:30', '23:30'] };
const iso = (ms: number) => new Date(ms).toISOString();

describe('agent schedule (Europe/Dublin)', () => {
  it('converts local times to UTC on both sides of the October DST change', () => {
    // 2026-10-25: IST (UTC+1) ends at 02:00 local
    expect(iso(localToUtc('2026-10-24', 7 * 60 + 30, TZ))).toBe('2026-10-24T06:30:00.000Z');
    expect(iso(localToUtc('2026-10-25', 7 * 60 + 30, TZ))).toBe('2026-10-25T07:30:00.000Z');
    // 2026-03-29: IST starts at 01:00 GMT
    expect(iso(localToUtc('2026-03-28', 23 * 60 + 30, TZ))).toBe('2026-03-28T23:30:00.000Z');
    expect(iso(localToUtc('2026-03-29', 7 * 60 + 30, TZ))).toBe('2026-03-29T06:30:00.000Z');
  });

  it('lists the next runs across the autumn DST change (local times stay fixed)', () => {
    const now = Date.parse('2026-10-24T12:00:00Z'); // Saturday 13:00 IST
    const next = nextScheduledRuns(now, SCHEDULE, TZ, 6);
    expect(next.map((s) => [s.kind, s.date, s.time, iso(s.at)])).toEqual([
      ['cycle', '2026-10-24', '15:30', '2026-10-24T14:30:00.000Z'],
      ['cycle', '2026-10-24', '19:30', '2026-10-24T18:30:00.000Z'],
      ['cycle', '2026-10-24', '23:30', '2026-10-24T22:30:00.000Z'],
      ['review', '2026-10-25', '07:30', '2026-10-25T07:30:00.000Z'],
      ['cycle', '2026-10-25', '11:30', '2026-10-25T11:30:00.000Z'],
      ['cycle', '2026-10-25', '15:30', '2026-10-25T15:30:00.000Z'],
    ]);
  });

  it('lists the next runs across the spring DST change', () => {
    const now = Date.parse('2026-03-28T20:00:00Z'); // Saturday 20:00 GMT
    const next = nextScheduledRuns(now, SCHEDULE, TZ, 3);
    expect(next.map((s) => [s.kind, s.time, iso(s.at)])).toEqual([
      ['cycle', '23:30', '2026-03-28T23:30:00.000Z'],
      ['review', '07:30', '2026-03-29T06:30:00.000Z'],
      ['cycle', '11:30', '2026-03-29T10:30:00.000Z'],
    ]);
  });

  it('a slot is due from its time for the grace window, once', () => {
    const slotAt = Date.parse('2026-10-31T11:30:00Z'); // 11:30 GMT
    const handled = new Set<string>();
    const isHandled = (s: { key: string }) => handled.has(s.key);
    expect(dueScheduledRun(slotAt - 60_000, SCHEDULE, TZ, isHandled)).toBeNull();
    const due = dueScheduledRun(slotAt + 20 * 60_000, SCHEDULE, TZ, isHandled)!;
    expect(due).toMatchObject({ kind: 'cycle', time: '11:30', key: '2026-10-31 11:30 cycle' });
    handled.add(due.key);
    expect(dueScheduledRun(slotAt + 21 * 60_000, SCHEDULE, TZ, isHandled)).toBeNull();
    // Missed by more than the grace window (server was down): not run late
    expect(dueScheduledRun(slotAt + 61 * 60_000, SCHEDULE, TZ, () => false)).toBeNull();
    // The 23:30 slot is still due just after midnight (yesterday's slot, within the grace window)
    const lateCycle = dueScheduledRun(Date.parse('2026-11-01T00:10:00Z'), SCHEDULE, TZ, () => false);
    expect(lateCycle).toMatchObject({ date: '2026-10-31', time: '23:30' });
  });

  it('quiet hours are 00:00–07:00 local; the schema refuses scheduled runs in them', () => {
    expect(isQuietHours(Date.parse('2026-07-01T05:30:00Z'), TZ)).toBe(true); // 06:30 IST
    expect(isQuietHours(Date.parse('2026-07-01T06:00:00Z'), TZ)).toBe(false); // 07:00 IST
    expect(isQuietHours(Date.parse('2026-12-01T06:59:00Z'), TZ)).toBe(true); // 06:59 GMT
    expect(iso(startOfLocalDay(Date.parse('2026-07-01T12:00:00Z'), TZ))).toBe('2026-06-30T23:00:00.000Z');
    expect(ServerSchema.safeParse({ agent: { schedule: { cycles: ['03:00'] } } }).success).toBe(false);
    expect(ServerSchema.safeParse({ agent: { schedule: { review: '06:59' } } }).success).toBe(false);
    expect(ServerSchema.safeParse({ agent: { model: 'claude-haiku-5-5' } }).success).toBe(false);
    const defaults = ServerSchema.parse({}).agent;
    expect(defaults).toMatchObject({ enabled: false, model: 'claude-sonnet-5-5', schedule: SCHEDULE, events: { max_per_day: 4, debounce_minutes: 30 } });
    // The spec caps event runs at 4/day and debounces at least 30 min
    expect(ServerSchema.safeParse({ agent: { events: { max_per_day: 5 } } }).success).toBe(false);
    expect(ServerSchema.safeParse({ agent: { events: { debounce_minutes: 10 } } }).success).toBe(false);
  });
});

describe('event-triggered runs', () => {
  const base = {
    nowMs: Date.parse('2026-10-31T12:00:00Z'),
    enabled: true,
    maxPerDay: 4,
    debounceMs: 30 * 60_000,
    eventRunsToday: 0,
    lastEventRunAt: null,
    runActive: false,
  };

  it('fires, waits for an active run, debounces 30 min and stops at the daily cap', () => {
    expect(decideEventRun(base)).toEqual({ action: 'fire' });
    expect(decideEventRun({ ...base, runActive: true })).toMatchObject({ action: 'wait' });
    const last = base.nowMs - 10 * 60_000;
    expect(decideEventRun({ ...base, lastEventRunAt: last })).toEqual({ action: 'wait', until: last + 30 * 60_000, why: expect.stringContaining('debounce') });
    expect(decideEventRun({ ...base, lastEventRunAt: base.nowMs - 31 * 60_000 })).toEqual({ action: 'fire' });
    expect(decideEventRun({ ...base, eventRunsToday: 4 })).toMatchObject({ action: 'drop', why: expect.stringContaining('daily cap') });
    expect(decideEventRun({ ...base, enabled: false })).toMatchObject({ action: 'drop' });
  });

  it('between 00:00 and 07:00 only bot halts are accepted', () => {
    const night = Date.parse('2026-10-31T03:00:00Z');
    expect(acceptTrigger({ kind: 'bot_halt', at: night, detail: 'x' }, TZ).accepted).toBe(true);
    expect(acceptTrigger({ kind: 'rules_changed', at: night, detail: 'x' }, TZ).accepted).toBe(false);
    expect(acceptTrigger({ kind: 'reconcile_mismatch', at: night, detail: 'x' }, TZ).accepted).toBe(false);
    expect(acceptTrigger({ kind: 'rules_changed', at: Date.parse('2026-10-31T09:00:00Z'), detail: 'x' }, TZ).accepted).toBe(true);
  });
});
