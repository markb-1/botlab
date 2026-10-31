import { describe, it, expect } from 'vitest';
import { LimitsSchema } from '../../electron/config';
import {
  decideRampTransition,
  demoteOnLossHalt,
  initialStage,
  lowerStage,
  templateTrustAfter,
  type RampInput,
} from '../../electron/risk/ramp';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-20T12:00:00Z');
const limits = LimitsSchema.parse({});

const base: RampInput = {
  stage: 'paper',
  stageSince: NOW - 8 * DAY,
  now: NOW,
  templateTrust: 'new',
  ranSinceStageChange: true,
  lastErrorAt: null,
  halted: false,
  lastHaltedAt: null,
  liveFillsSinceStageChange: 0,
  drawdownPct: null,
};

const probation: Partial<RampInput> = { stage: 'probation', liveFillsSinceStageChange: 20, drawdownPct: 0.1 };

const rows: Array<{ name: string; input: Partial<RampInput>; approvals?: boolean; expect: string }> = [
  // paper → probation
  { name: 'paper after 8 days, ran, no errors ⇒ probation', input: {}, expect: 'promote:probation' },
  { name: 'paper exactly 7 days ⇒ probation', input: { stageSince: NOW - 7 * DAY }, expect: 'promote:probation' },
  { name: 'paper 6.9 days ⇒ wait', input: { stageSince: NOW - 6.9 * DAY }, expect: 'none' },
  { name: 'paper bot never ran ⇒ wait', input: { ranSinceStageChange: false }, expect: 'none' },
  { name: 'runtime error during paper ⇒ wait', input: { lastErrorAt: NOW - DAY }, expect: 'none' },
  { name: 'error before the paper stage does not count', input: { lastErrorAt: NOW - 9 * DAY }, expect: 'promote:probation' },
  { name: 'currently halted ⇒ wait', input: { halted: true }, expect: 'none' },
  { name: 'halted during paper ⇒ wait', input: { lastHaltedAt: NOW - DAY }, expect: 'none' },
  { name: 'approval required for a new template', input: {}, approvals: true, expect: 'blocked' },
  { name: 'approval flag ignored for a proven template', input: { templateTrust: 'proven' }, approvals: true, expect: 'promote:probation' },
  // probation → full
  { name: 'probation meeting every criterion ⇒ full', input: probation, expect: 'promote:full' },
  { name: 'probation 19 fills ⇒ wait', input: { ...probation, liveFillsSinceStageChange: 19 }, expect: 'none' },
  { name: 'probation 6 days ⇒ wait', input: { ...probation, stageSince: NOW - 6 * DAY }, expect: 'none' },
  { name: 'probation drawdown at the limit ⇒ full', input: { ...probation, drawdownPct: 0.25 }, expect: 'promote:full' },
  { name: 'probation drawdown over the limit ⇒ wait', input: { ...probation, drawdownPct: 0.2501 }, expect: 'none' },
  { name: 'probation drawdown unknown ⇒ wait', input: { ...probation, drawdownPct: null }, expect: 'none' },
  { name: 'probation infinite drawdown ⇒ wait', input: { ...probation, drawdownPct: Infinity }, expect: 'none' },
  { name: 'halt during probation ⇒ wait', input: { ...probation, lastHaltedAt: NOW - DAY }, expect: 'none' },
  { name: 'halt before probation does not count', input: { ...probation, lastHaltedAt: NOW - 9 * DAY }, expect: 'promote:full' },
  { name: 'probation runtime errors do not block', input: { ...probation, lastErrorAt: NOW - DAY }, expect: 'promote:full' },
  // terminal / no automatic transition
  { name: 'full stays full', input: { ...probation, stage: 'full' }, expect: 'none' },
  { name: 'retired stays retired', input: { ...probation, stage: 'retired' }, expect: 'none' },
  { name: 'unknown stage start ⇒ wait', input: { stageSince: NaN }, expect: 'none' },
];

describe('decideRampTransition', () => {
  it.each(rows)('$name', ({ input, approvals, expect: want }) => {
    const d = decideRampTransition({ ...base, ...input }, limits.ramp, { new_template_live: approvals ?? false });
    expect(d.action === 'promote' ? `promote:${d.to}` : d.action).toBe(want);
  });
});

describe('ramp helpers', () => {
  it('initial stage: new template ⇒ paper, proven ⇒ probation, unknown ⇒ paper', () => {
    expect(initialStage('new')).toBe('paper');
    expect(initialStage('proven')).toBe('probation');
    expect(initialStage(undefined)).toBe('paper');
  });

  it('loss halt demotes full to probation only', () => {
    expect(demoteOnLossHalt('full')).toBe('probation');
    expect(demoteOnLossHalt('probation')).toBeNull();
    expect(demoteOnLossHalt('paper')).toBeNull();
    expect(demoteOnLossHalt('retired')).toBeNull();
  });

  it('lowerStage never raises a stage', () => {
    expect(lowerStage('full', 'paper')).toBe('paper');
    expect(lowerStage('paper', 'probation')).toBe('paper');
    expect(lowerStage('probation', 'probation')).toBe('probation');
    expect(lowerStage('retired', 'probation')).toBe('retired');
  });

  it('template becomes proven with 2 bots that reached full', () => {
    expect(templateTrustAfter('new', 0)).toBe('new');
    expect(templateTrustAfter('new', 1)).toBe('new');
    expect(templateTrustAfter('new', 2)).toBe('proven');
    expect(templateTrustAfter('proven', 0)).toBe('proven');
  });
});
