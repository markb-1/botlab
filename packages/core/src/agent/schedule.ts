/**
 * Agent schedule (spec §7.1): pure time arithmetic and gating rules for the server's AgentScheduler.
 * No timers, no I/O, so the rules are unit-tested with a fixed clock.
 *
 * - Scheduled runs at local times in the server.yaml `timezone` (default Europe/Dublin): the daily review
 *   (07:30) and cycles (11:30, 15:30, 19:30, 23:30). A local time is converted to UTC for each date, so DST
 *   changes move the UTC instant, not the local time. Nothing is scheduled between 00:00 and 07:00 (the
 *   schema refuses such times).
 * - A slot is due from its time until `graceMs` later (a server that was down at 11:30 and is back at 11:50
 *   still runs it); each slot is handled once.
 * - Event-triggered runs (rules_changed on a held market, bot halt, reconciliation mismatch) are maintenance
 *   runs: at most `max_per_day` per local day (≤ 4) and at most one per `debounce` (≥ 30 min); triggers that
 *   arrive meanwhile are coalesced into the next run. Between 00:00 and 07:00 only bot halts are accepted
 *   (Decision R151); other triggers are dropped (the 07:30 review sees them).
 */

import { AGENT_QUIET_END_MIN } from '../config/serverSchema';

export type ScheduledRunKind = 'review' | 'cycle';

export interface AgentScheduleConfig {
  review: string;
  cycles: readonly string[];
}

export interface ScheduledSlot {
  /** `<local date> <HH:MM> <kind>`: identifies the slot (handled once) */
  key: string;
  kind: ScheduledRunKind;
  /** Local time HH:MM */
  time: string;
  /** Local date YYYY-MM-DD */
  date: string;
  /** UTC instant (ms) */
  at: number;
}

const DAY_MS = 86_400_000;

function partsIn(ms: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** Local date (YYYY-MM-DD) and minutes since local midnight of `ms` in `timeZone` */
export function localDateTime(ms: number, timeZone: string): { date: string; minutes: number } {
  const p = partsIn(ms, timeZone);
  return { date: `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`, minutes: p.h * 60 + p.mi };
}

/** Offset of `timeZone` from UTC at instant `ms`, in ms (Dublin summer: +3 600 000) */
function offsetAt(ms: number, timeZone: string): number {
  const p = partsIn(ms, timeZone);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * UTC instant of local `date` + `minutes` in `timeZone` (two passes: the offset at the naive instant, then at
 * the corrected one, which settles on the right side of a DST change). Times inside a spring-forward gap or
 * a fall-back overlap (01:00–02:00 in Dublin) resolve to one of the candidate instants; the schedule never
 * uses them (no runs before 07:00).
 */
export function localToUtc(date: string, minutes: number, timeZone: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const naive = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  const guess = naive - offsetAt(naive, timeZone);
  return naive - offsetAt(guess, timeZone);
}

export function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** The day's slots in local time order (review, then cycles; duplicates dropped) */
export function slotsForDate(date: string, schedule: AgentScheduleConfig, timeZone: string): ScheduledSlot[] {
  const entries: Array<{ kind: ScheduledRunKind; time: string }> = [
    { kind: 'review', time: schedule.review },
    ...schedule.cycles.map((time) => ({ kind: 'cycle' as const, time })),
  ];
  const seen = new Set<string>();
  return entries
    .filter((e) => {
      if (seen.has(e.time) || minutesOf(e.time) < AGENT_QUIET_END_MIN) return false;
      seen.add(e.time);
      return true;
    })
    .map((e) => ({ key: `${date} ${e.time} ${e.kind}`, kind: e.kind, time: e.time, date, at: localToUtc(date, minutesOf(e.time), timeZone) }))
    .sort((a, b) => a.at - b.at);
}

/** The next `count` scheduled slots strictly after `nowMs` */
export function nextScheduledRuns(nowMs: number, schedule: AgentScheduleConfig, timeZone: string, count = 5): ScheduledSlot[] {
  const today = localDateTime(nowMs, timeZone).date;
  const out: ScheduledSlot[] = [];
  for (let i = 0; i < 8 && out.length < count; i++) {
    for (const slot of slotsForDate(addDays(today, i), schedule, timeZone)) {
      if (slot.at > nowMs && out.length < count) out.push(slot);
    }
  }
  return out;
}

/**
 * The slot to run now: the latest slot (today or yesterday) whose time has come and is less than `graceMs`
 * old, unless it was already handled. Null when nothing is due.
 */
export function dueScheduledRun(
  nowMs: number,
  schedule: AgentScheduleConfig,
  timeZone: string,
  isHandled: (slot: ScheduledSlot) => boolean,
  graceMs = 60 * 60_000
): ScheduledSlot | null {
  const today = localDateTime(nowMs, timeZone).date;
  const candidates = [...slotsForDate(addDays(today, -1), schedule, timeZone), ...slotsForDate(today, schedule, timeZone)]
    .filter((s) => s.at <= nowMs && nowMs - s.at < graceMs)
    .sort((a, b) => b.at - a.at);
  const latest = candidates[0];
  return latest && !isHandled(latest) ? latest : null;
}

/** Spec §7.1: 00:00–07:00 local time */
export function isQuietHours(nowMs: number, timeZone: string): boolean {
  return localDateTime(nowMs, timeZone).minutes < AGENT_QUIET_END_MIN;
}

/** UTC instant of the local midnight that started the current local day */
export function startOfLocalDay(nowMs: number, timeZone: string): number {
  return localToUtc(localDateTime(nowMs, timeZone).date, 0, timeZone);
}

// ── Event triggers ─────────────────────────────────────────────────

export type AgentTriggerKind = 'rules_changed' | 'bot_halt' | 'reconcile_mismatch';

export interface AgentTrigger {
  kind: AgentTriggerKind;
  /** ms */
  at: number;
  /** Market id or bot id, when there is one */
  ref?: string | null;
  /** Short description (system text; market questions are third-party text and wrapped by the runner) */
  detail: string;
}

/** Whether a trigger may queue an event run now (quiet hours: bot halts only, Decision R151) */
export function acceptTrigger(trigger: AgentTrigger, timeZone: string): { accepted: boolean; reason?: string } {
  if (isQuietHours(trigger.at, timeZone) && trigger.kind !== 'bot_halt') {
    return { accepted: false, reason: 'quiet hours (00:00–07:00): only bot halts start event runs; the 07:30 review sees the rest' };
  }
  return { accepted: true };
}

export type EventRunDecision = { action: 'fire' } | { action: 'wait'; until: number | null; why: string } | { action: 'drop'; why: string };

/**
 * What to do with pending triggers: fire an event run, wait (a run is active, or within the debounce), or
 * drop them (daily cap reached, events disabled).
 */
export function decideEventRun(input: {
  nowMs: number;
  enabled: boolean;
  maxPerDay: number;
  debounceMs: number;
  /** Event runs started since local midnight */
  eventRunsToday: number;
  /** Start of the last event run (ms), if any */
  lastEventRunAt: number | null;
  runActive: boolean;
}): EventRunDecision {
  if (!input.enabled) return { action: 'drop', why: 'event-triggered runs are disabled (agent.events.enabled)' };
  if (input.eventRunsToday >= input.maxPerDay)
    return { action: 'drop', why: `daily cap reached (${input.eventRunsToday} of agent.events.max_per_day = ${input.maxPerDay})` };
  if (input.runActive) return { action: 'wait', until: null, why: 'a run is in progress' };
  if (input.lastEventRunAt !== null && input.nowMs - input.lastEventRunAt < input.debounceMs) {
    return { action: 'wait', until: input.lastEventRunAt + input.debounceMs, why: 'debounce (one event run per agent.events.debounce_minutes)' };
  }
  return { action: 'fire' };
}
