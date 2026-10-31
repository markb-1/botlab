import { describe, it, expect } from 'vitest';
import {
  allocationFor,
  bootstrapLowerBound,
  convergenceScore,
  decideRights,
  eventVotes,
  expectedThresholdDate,
  mandateListing,
  parseResolution,
  scoreForecast,
  voteStats,
  type EventVote,
  type RightsInput,
} from '../../packages/core/src/ledger/scoring';
import { autoRaiseReason, effectiveAmbiguity, normalizeRulesText, rulesHash } from '../../packages/core/src/ledger/ambiguity';
import { MandateSchema } from '../../packages/core/src/config';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-31T00:00:00Z');

describe('resolution parsing', () => {
  const r = (closed: boolean, prices: string[] | null, uma: string | null = null) => parseResolution({ closed, outcomePrices: prices, umaResolutionStatus: uma });
  it.each([
    ['open market', r(false, ['1', '0']), { kind: 'unresolved' }],
    ['closed YES', r(true, ['1', '0']), { kind: 'resolved', payouts: [1, 0] }],
    ['closed NO', r(true, ['0', '1'], 'resolved'), { kind: 'resolved', payouts: [0, 1] }],
    ['50-50 ⇒ void', r(true, ['0.5', '0.5']), { kind: 'void' }],
    ['settling (not exactly 0/1)', r(true, ['0.9995', '0.0005']), { kind: 'unresolved' }],
    ['disputed', r(true, ['1', '0'], 'disputed'), { kind: 'unresolved' }],
    ['proposed', r(true, ['1', '0'], 'proposed'), { kind: 'unresolved' }],
    ['two winners', r(true, ['1', '1']), { kind: 'unresolved' }],
    ['no prices', r(true, null), { kind: 'unresolved' }],
    ['garbage', r(true, ['x', '0']), { kind: 'unresolved' }],
  ])('%s', (_n, got, want) => expect(got).toEqual(want));
});

describe('scores', () => {
  it('Brier and skill', () => {
    const s = scoreForecast(0.7, 0.5, 1);
    expect(s.brierAgent).toBeCloseTo(0.09);
    expect(s.brierMarket).toBeCloseTo(0.25);
    expect(s.skill).toBeCloseTo(0.16); // agent better ⇒ positive
    expect(scoreForecast(0.7, 0.5, 0).skill).toBeCloseTo(0.25 - 0.49); // agent worse ⇒ negative
  });

  it('convergence sign: positive when the market moved toward the agent', () => {
    expect(convergenceScore(0.7, 0.5, 0.6)).toBeCloseTo(0.1); // agent above, market rose
    expect(convergenceScore(0.7, 0.5, 0.4)).toBeCloseTo(-0.1); // agent above, market fell
    expect(convergenceScore(0.3, 0.5, 0.4)).toBeCloseTo(0.1); // agent below, market fell
    expect(convergenceScore(0.3, 0.5, 0.6)).toBeCloseTo(-0.1);
    expect(convergenceScore(0.5, 0.5, 0.9)).toBe(0); // agreed with the market: no signal
    expect(convergenceScore(0.7, 0.5, 1)).toBeCloseTo(0.5); // resolved before 7 days: resolution price
  });
});

describe('one vote per event + bootstrap', () => {
  it('each event contributes the mean of its forecasts, ordered by time', () => {
    const votes = eventVotes([
      { eventId: 'e1', value: 0.1, at: 3 },
      { eventId: 'e1', value: 0.3, at: 5 },
      { eventId: 'e1', value: 0.2, at: 4 },
      { eventId: 'e2', value: -0.4, at: 1 },
    ]);
    expect(votes).toEqual([
      { eventId: 'e2', value: -0.4, at: 1, firstAt: 1 },
      { eventId: 'e1', value: expect.closeTo(0.2, 10), at: 5, firstAt: 3 },
    ]);
    // Many correlated forecasts on one event do not outvote other events
    const s = voteStats(eventVotes([...Array.from({ length: 50 }, (_, i) => ({ eventId: 'big', value: 1, at: i })), { eventId: 'small', value: -1, at: 0 }]), 1);
    expect(s.n).toBe(2);
    expect(s.mean).toBeCloseTo(0);
  });

  it('bootstrap lower bound is deterministic for a seed and below the mean', () => {
    const values = Array.from({ length: 40 }, (_, i) => Math.sin(i) * 0.1 + 0.02);
    const a = bootstrapLowerBound(values, 42);
    expect(bootstrapLowerBound(values, 42)).toBe(a);
    expect(bootstrapLowerBound(values, 43)).not.toBe(a);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    expect(a!).toBeLessThan(mean);
    expect(bootstrapLowerBound([], 1)).toBeNull();
    expect(bootstrapLowerBound([0.05, 0.05, 0.05], 7)).toBeCloseTo(0.05); // no variance
  });
});

// ─── Rights transitions ──────────────────────────────────────────────

/** n events with the given skill values (cycled), scored one per day ending at `endAt`. */
function votes(n: number, values: number[], endAt = NOW): EventVote[] {
  return Array.from({ length: n }, (_, i) => {
    const at = endAt - (n - 1 - i) * DAY;
    return { eventId: `e${i}`, value: values[i % values.length], at, firstAt: at };
  });
}
const GOOD = [0.05, 0.06, 0.04, 0.07]; // clearly positive skill
const BAD = [-0.05, -0.06, -0.04, -0.07];

function input(o: Partial<RightsInput> & { state?: RightsInput['current']['state']; current?: Partial<RightsInput['current']> } = {}): RightsInput {
  const { state, current, ...rest } = o;
  return {
    bucket: 'short',
    current: { state: state ?? 'shadow', maxAllocationUsd: 0, qualifiedN: null, forced: false, changedAt: 0, ...current },
    skillVotes: [],
    convergenceVotes: [],
    mandate: 'allow',
    shortBucketTrading: false,
    budgetUsd: 300,
    seed: 1,
    ...rest,
  };
}

describe('category rights transitions', () => {
  const table: Array<[string, RightsInput, { state: string; maxAllocationUsd?: number; changed?: boolean }]> = [
    ['shadow stays below 30 events', input({ skillVotes: votes(29, GOOD) }), { state: 'shadow', changed: false }],
    ['shadow → trading at 30 with lb > 0', input({ skillVotes: votes(30, GOOD) }), { state: 'trading', maxAllocationUsd: 50 }],
    ['shadow stays when lb ≤ 0', input({ skillVotes: votes(40, [0.2, -0.25]) }), { state: 'shadow' }],
    ['later category never trades', input({ skillVotes: votes(60, GOOD), mandate: 'later' }), { state: 'shadow' }],
    ['deny category never trades', input({ skillVotes: votes(60, GOOD), mandate: 'deny' }), { state: 'shadow' }],
    ['unlisted category never trades', input({ skillVotes: votes(60, GOOD), mandate: 'none' }), { state: 'shadow' }],
    ['medium needs 30 normally', input({ bucket: 'medium', skillVotes: votes(25, GOOD) }), { state: 'shadow' }],
    ['medium qualifies at 20 when short trades', input({ bucket: 'medium', skillVotes: votes(20, GOOD), shortBucketTrading: true }), { state: 'trading', maxAllocationUsd: 50 }],
    ['long gets no relaxation', input({ bucket: 'long', skillVotes: votes(20, GOOD), shortBucketTrading: true }), { state: 'shadow' }],
    ['initial allocation capped by budget', input({ skillVotes: votes(30, GOOD), budgetUsd: 40 }), { state: 'trading', maxAllocationUsd: 40 }],
    ['allocation +50 per 20 further events', input({ state: 'trading', current: { maxAllocationUsd: 50, qualifiedN: 30 }, skillVotes: votes(70, GOOD) }), { state: 'trading', maxAllocationUsd: 150 }],
    ['allocation capped by budget', input({ state: 'trading', current: { maxAllocationUsd: 50, qualifiedN: 30 }, skillVotes: votes(200, GOOD), budgetUsd: 120 }), { state: 'trading', maxAllocationUsd: 120 }],
    ['trading → suspended when last 20 mean < 0', input({ state: 'trading', current: { maxAllocationUsd: 100, qualifiedN: 30 }, skillVotes: [...votes(40, GOOD, NOW - 30 * DAY), ...votes(20, BAD).map((v) => ({ ...v, eventId: `b${v.eventId}` }))] }), { state: 'suspended', maxAllocationUsd: 0 }],
    ['trading stays when last 20 positive', input({ state: 'trading', current: { maxAllocationUsd: 50, qualifiedN: 30 }, skillVotes: votes(30, GOOD) }), { state: 'trading', changed: false }],
    ['trading leaves when category moves out of allow', input({ state: 'trading', current: { maxAllocationUsd: 50 }, skillVotes: votes(30, GOOD), mandate: 'later' }), { state: 'shadow', maxAllocationUsd: 0 }],
    ['deprioritised by convergence (n ≥ 20, lb < 0, mean < 0)', input({ convergenceVotes: votes(20, BAD) }), { state: 'deprioritised' }],
    ['not deprioritised under 20 convergence events', input({ convergenceVotes: votes(19, BAD) }), { state: 'shadow', changed: false }],
    ['convergence never grants trading', input({ convergenceVotes: votes(100, GOOD), skillVotes: votes(10, GOOD) }), { state: 'shadow', changed: false }],
    ['deprioritised is sticky', input({ state: 'deprioritised', skillVotes: votes(60, GOOD) }), { state: 'deprioritised', changed: false }],
    ['forced shadow is not auto-promoted', input({ current: { forced: true }, skillVotes: votes(60, GOOD) }), { state: 'shadow', changed: false }],
    ['forced trading is still suspended on bad skill', input({ state: 'trading', current: { forced: true, maxAllocationUsd: 50 }, skillVotes: votes(25, BAD) }), { state: 'suspended' }],
  ];

  it.each(table)('%s', (_n, inp, want) => {
    const d = decideRights(inp);
    expect(d.state).toBe(want.state);
    if (want.maxAllocationUsd !== undefined) expect(d.maxAllocationUsd).toBe(want.maxAllocationUsd);
    if (want.changed !== undefined) expect(d.changed).toBe(want.changed);
  });

  it('suspended → trading only on events scored after the suspension', () => {
    const suspendedAt = NOW - 40 * DAY;
    const before = votes(60, GOOD, suspendedAt - DAY); // plenty of good history before suspension
    const stay = decideRights(input({ state: 'suspended', current: { changedAt: suspendedAt }, skillVotes: [...before, ...votes(29, GOOD).map((v) => ({ ...v, eventId: `n${v.eventId}` }))] }));
    expect(stay.state).toBe('suspended');
    const back = decideRights(input({ state: 'suspended', current: { changedAt: suspendedAt }, skillVotes: [...before, ...votes(30, GOOD).map((v) => ({ ...v, eventId: `n${v.eventId}` }))] }));
    expect(back.state).toBe('trading');
    expect(back.maxAllocationUsd).toBe(50);
    expect(back.qualifiedN).toBe(90);
    // Only old good events: stays suspended
    expect(decideRights(input({ state: 'suspended', current: { changedAt: suspendedAt }, skillVotes: before })).state).toBe('suspended');
  });

  it('entering trading also needs mean skill of the last 20 events ≥ 0', () => {
    // Strong early record, recent 20 events slightly negative: lower bound > 0 but recent mean < 0
    const v = votes(30, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, ...Array(20).fill(-0.01)]);
    const d = decideRights(input({ skillVotes: v }));
    expect(d.skill.lowerBound!).toBeGreaterThan(0);
    expect(d.state).toBe('shadow');
    // Same for re-entry after suspension
    const suspendedAt = NOW - 40 * DAY;
    expect(decideRights(input({ state: 'suspended', current: { changedAt: suspendedAt }, skillVotes: v })).state).toBe('suspended');
  });

  it('re-qualification ignores events with any forecast resolved before the suspension', () => {
    const suspendedAt = NOW - 40 * DAY;
    // 30 good events whose latest resolution is after the suspension but whose first is before it
    const straddling = votes(30, GOOD).map((v) => ({ ...v, firstAt: suspendedAt - DAY }));
    expect(decideRights(input({ state: 'suspended', current: { changedAt: suspendedAt }, skillVotes: straddling })).state).toBe('suspended');
    expect(decideRights(input({ state: 'suspended', current: { changedAt: suspendedAt }, skillVotes: votes(30, GOOD) })).state).toBe('trading');
  });

  it('allocationFor and mandateListing', () => {
    expect(allocationFor(30, 30, 300)).toBe(50);
    expect(allocationFor(49, 30, 300)).toBe(50);
    expect(allocationFor(50, 30, 300)).toBe(100);
    expect(allocationFor(500, 30, 300)).toBe(300);
    const m = MandateSchema.parse({});
    expect(mandateListing('economics', m)).toBe('allow');
    expect(mandateListing('geopolitics', m)).toBe('later');
    expect(mandateListing('sports', m)).toBe('deny');
    expect(mandateListing('other', m)).toBe('none');
  });

  it('expected date to threshold from the recent rate', () => {
    // 15 events in the last 30 days ⇒ 0.5/day; 15 more needed ⇒ 30 days
    const v = votes(15, GOOD);
    const e = expectedThresholdDate(v, 30, NOW);
    expect(e.remaining).toBe(15);
    expect(e.ratePerDay).toBeCloseTo(0.5);
    expect(e.expectedAt).toBe(new Date(NOW + 30 * DAY).toISOString());
    expect(expectedThresholdDate([], 30, NOW).expectedAt).toBeNull();
    expect(expectedThresholdDate(votes(30, GOOD), 30, NOW).expectedAt).toBe(new Date(NOW).toISOString());
  });
});

describe('rules hash and ambiguity raise', () => {
  it('hash ignores whitespace-only changes, not wording', () => {
    expect(normalizeRulesText('  Resolves YES if\r\n  CPI > 3%.  ')).toBe('Resolves YES if CPI > 3%.');
    expect(rulesHash('Resolves YES if CPI > 3%.')).toBe(rulesHash('Resolves  YES if\nCPI > 3%. '));
    expect(rulesHash('Resolves YES if CPI > 3%.')).not.toBe(rulesHash('Resolves YES if CPI >= 3%.'));
  });

  it('server raises to ≥ 2 within 7 days of a rules change or on a dispute; unassessed stays unknown', () => {
    const recent = new Date(NOW - 6 * DAY).toISOString();
    const old = new Date(NOW - 8 * DAY).toISOString();
    expect(effectiveAmbiguity({ assessed: 0, rulesChangedAt: recent, disputed: false }, NOW)).toBe(2);
    expect(effectiveAmbiguity({ assessed: 3, rulesChangedAt: recent, disputed: false }, NOW)).toBe(3);
    expect(effectiveAmbiguity({ assessed: 0, rulesChangedAt: old, disputed: false }, NOW)).toBe(0);
    expect(effectiveAmbiguity({ assessed: 1, rulesChangedAt: null, disputed: true }, NOW)).toBe(2);
    expect(effectiveAmbiguity({ assessed: null, rulesChangedAt: recent, disputed: true }, NOW)).toBeNull();
    expect(autoRaiseReason({ rulesChangedAt: null, disputed: false }, NOW)).toBeNull();
  });
});
