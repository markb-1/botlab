/**
 * Pure helpers behind the 3c pages: line diff (script versions, config history), schema-driven config
 * form value handling, and the Monaco typings generated from the SDK types.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { diffLines, diffStats, withContext, splitLines } from '../../apps/web/src/lib/lineDiff';
import { fieldKind, getAt, setAt, parseInputValue, formatInputValue, humanizeKey, type JsonSchema } from '../../apps/web/src/lib/schemaForm';
import { sdkTypesToAmbient } from '../../apps/web/src/lib/sdkTypings';

/** Rebuild both sides from the diff: proves it is a valid edit script */
function apply(lines: ReturnType<typeof diffLines>) {
  return {
    before: lines.filter((l) => l.type !== 'add').map((l) => l.text),
    after: lines.filter((l) => l.type !== 'del').map((l) => l.text),
  };
}

describe('diffLines', () => {
  it('identical text has no changes', () => {
    const d = diffLines('a\nb\nc\n', 'a\nb\nc\n');
    expect(diffStats(d)).toEqual({ added: 0, removed: 0 });
    expect(d.every((l) => l.type === 'same')).toBe(true);
  });

  it('marks inserted, deleted and changed lines with line numbers on both sides', () => {
    const before = 'one\ntwo\nthree\nfour\n';
    const after = 'one\n2\nthree\nfour\nfive\n';
    const d = diffLines(before, after);
    expect(d).toEqual([
      { type: 'same', text: 'one', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'two', oldNo: 2 },
      { type: 'add', text: '2', newNo: 2 },
      { type: 'same', text: 'three', oldNo: 3, newNo: 3 },
      { type: 'same', text: 'four', oldNo: 4, newNo: 4 },
      { type: 'add', text: 'five', newNo: 5 },
    ]);
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
  });

  it('is a valid edit script for random edits (both sides rebuild exactly)', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 50; round++) {
      const a = Array.from({ length: Math.floor(rnd() * 30) }, () => String.fromCharCode(97 + Math.floor(rnd() * 5)));
      const b = a.filter(() => rnd() > 0.2).flatMap((x) => (rnd() > 0.8 ? [x, 'new'] : [x]));
      const d = diffLines(a.join('\n'), b.join('\n'));
      expect(apply(d)).toEqual({ before: a, after: b });
      // Unchanged lines keep their numbers on each side
      for (const l of d) if (l.type === 'same') expect([a[l.oldNo - 1], b[l.newNo - 1]]).toEqual([l.text, l.text]);
    }
  });

  it('handles CRLF, empty sides and the suffix offset', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(diffLines('', 'x\ny')).toEqual([
      { type: 'add', text: 'x', newNo: 1 },
      { type: 'add', text: 'y', newNo: 2 },
    ]);
    const d = diffLines('a\nz', 'a\nb\nc\nz');
    expect(d.at(-1)).toEqual({ type: 'same', text: 'z', oldNo: 2, newNo: 4 });
  });

  it('withContext collapses long unchanged runs', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l10', 'changed');
    const rows = withContext(diffLines(before, after), 2);
    expect(rows[0]).toEqual({ type: 'skip', count: 8 });
    expect(rows.filter((r) => r.type !== 'skip')).toHaveLength(6);
    expect(rows.at(-1)).toEqual({ type: 'skip', count: 7 });
  });
});

describe('schema form helpers', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      global: {
        type: 'object',
        properties: { max_total_exposure_usd: { type: 'number', minimum: 0 }, max_open_orders: { type: 'integer', minimum: 0, maximum: 9007199254740991 } },
      },
      allow: { type: 'array', items: { type: 'string', minLength: 1 } },
      range: { type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }], items: false },
      kind: { type: 'string', enum: ['limit', 'market'] },
      chat_id: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      rules: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
      on: { type: 'boolean' },
    },
  };
  const p = schema.properties!;

  it('picks an input kind per schema node', () => {
    expect(fieldKind(schema)).toBe('object');
    expect(fieldKind(p.global.properties!.max_total_exposure_usd)).toBe('number');
    expect(fieldKind(p.global.properties!.max_open_orders)).toBe('integer');
    expect(fieldKind(p.allow)).toBe('string-list');
    expect(fieldKind(p.range)).toBe('number-pair');
    expect(fieldKind(p.kind)).toBe('enum');
    expect(fieldKind(p.chat_id)).toBe('string-or-number');
    expect(fieldKind(p.rules)).toBe('json');
    expect(fieldKind(p.on)).toBe('boolean');
    expect(fieldKind(undefined)).toBe('json');
  });

  it('setAt copies instead of mutating and creates missing objects', () => {
    const value = { global: { a: 1, b: 2 }, other: { c: 3 } };
    const next = setAt(value, ['global', 'a'], 5);
    expect(next).toEqual({ global: { a: 5, b: 2 }, other: { c: 3 } });
    expect(value.global.a).toBe(1);
    expect(next.other).toBe(value.other);
    expect(setAt({}, ['x', 'y'], true)).toEqual({ x: { y: true } });
    expect(getAt(next, ['global', 'b'])).toBe(2);
    expect(getAt(next, ['nope', 'b'])).toBeUndefined();
  });

  it('parses typed text into schema values', () => {
    expect(parseInputValue('number', ' 12.5 ')).toEqual({ ok: true, value: 12.5 });
    expect(parseInputValue('number', '')).toMatchObject({ ok: false });
    expect(parseInputValue('number', 'abc')).toMatchObject({ ok: false });
    expect(parseInputValue('number', '-1', p.global.properties!.max_total_exposure_usd)).toEqual({ ok: false, error: 'must be ≥ 0' });
    expect(parseInputValue('integer', '2.5')).toMatchObject({ ok: false });
    expect(parseInputValue('integer', '7', p.global.properties!.max_open_orders)).toEqual({ ok: true, value: 7 });
    expect(parseInputValue('string-list', 'a\n b ,c\n\n')).toEqual({ ok: true, value: ['a', 'b', 'c'] });
    expect(parseInputValue('json', '[{"name":"x"}]')).toEqual({ ok: true, value: [{ name: 'x' }] });
    expect(parseInputValue('json', '[')).toMatchObject({ ok: false });
    expect(formatInputValue('string-list', ['a', 'b'])).toBe('a\nb');
    expect(formatInputValue('number', 0)).toBe('0');
    expect(formatInputValue('number', undefined)).toBe('');
    expect(humanizeKey('max_total_exposure_usd')).toBe('Max total exposure (USD)');
  });
});

describe('sdk typings for the script editor', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../packages/core/src/sdk/types.ts'), 'utf8');
  const out = sdkTypesToAmbient(src);

  it('declares the current ctx API and drops the internal RPC protocol', () => {
    expect(out).not.toMatch(/^export /m);
    expect(out).toContain('declare interface BotContext');
    expect(out).toContain('declare const ctx: BotContext;');
    for (const name of ['placeLimit', 'cancelAll', 'getOpenOrders', 'getFee', 'getBudget', 'getActiveForecasts', 'fetch(url']) expect(out).toContain(name);
    expect(out).not.toContain('RpcMethod');
    expect(out).not.toContain('WorkerToMainMessage');
  });
});

import { calibration } from '../../apps/web/src/lib/calibration';

describe('calibration buckets', () => {
  it('groups scored forecasts by predicted probability and ignores unscored / void ones', () => {
    const f = (probability: number, outcome: number | null, status = 'resolved') => ({
      probability,
      outcome,
      status,
      brierAgent: outcome === null ? null : (probability - outcome) ** 2,
      brierMarket: 0.25,
      skill: 0.1,
    });
    const c = calibration([f(0.15, 0), f(0.12, 1), f(0.95, 1), f(1, 1), f(0.5, null, 'active'), f(0.55, 1, 'void'), f(0.62, 0, 'superseded')]);
    expect(c.n).toBe(5);
    expect(c.buckets[1]).toMatchObject({ n: 2, observed: 0.5 });
    expect(c.buckets[1].meanForecast).toBeCloseTo(0.135);
    expect(c.buckets[6]).toMatchObject({ n: 1, observed: 0 });
    expect(c.buckets[9]).toMatchObject({ n: 2, observed: 1 }); // p = 1 lands in the last bucket
    expect(c.buckets[5]).toMatchObject({ n: 0, observed: null });
    expect(c.brierMarket).toBe(0.25);
    expect(c.meanSkill).toBeCloseTo(0.1);
  });
});

describe('relTime / bot activity history', () => {
  it('never says "in 0 s" for a timestamp slightly ahead of the browser clock', async () => {
    const { relTime } = await import('../../apps/web/src/lib/format');
    const now = Date.parse('2026-10-31T10:00:00Z');
    expect(relTime(new Date(now + 400).toISOString(), now)).toBe('just now');
    expect(relTime(new Date(now + 90_000).toISOString(), now)).toBe('just now');
    expect(relTime(new Date(now - 2_000).toISOString(), now)).toBe('just now');
    expect(relTime(new Date(now - 30_000).toISOString(), now)).toBe('30 s ago');
    expect(relTime(new Date(now + 3_600_000).toISOString(), now)).toBe('in 1 h');
  });

  it('merges server history with live lines received while it loaded, without duplicates', async () => {
    const { mergeHistory } = await import('../../apps/web/src/lib/botActivity');
    const l = (t: string, m: string) => ({ timestamp: t, level: 'info', message: m });
    const history = [l('1', 'a'), l('2', 'b')];
    expect(mergeHistory(history, [l('2', 'b'), l('3', 'c')], 500)).toEqual([l('1', 'a'), l('2', 'b'), l('3', 'c')]);
    expect(mergeHistory(history, [l('3', 'c')], 2)).toEqual([l('2', 'b'), l('3', 'c')]);
  });
});
