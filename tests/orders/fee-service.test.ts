import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigError } from '../../electron/config';
import { DEFAULT_FEES_YAML, FeeService, FeesSchema, loadFees } from '../../electron/orders/FeeService';

describe('FeeService', () => {
  it('defaults match the spec table and config/fees.example.yaml', () => {
    const fees = FeesSchema.parse({});
    expect(fees.taker_rates).toEqual({
      crypto: 0.07, sports: 0.03, finance: 0.04, politics: 0.04, tech: 0.04, mentions: 0.04,
      economics: 0.05, culture: 0.05, weather: 0.05, other: 0.05, geopolitics: 0,
    });
    expect(fees.maker_rate).toBe(0);

    const example = fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'fees.example.yaml'), 'utf8');
    expect(example.replace(/\r\n/g, '\n')).toBe(DEFAULT_FEES_YAML);
  });

  it('rejects unknown categories, out-of-range rates and typos', () => {
    expect(FeesSchema.safeParse({ taker_rates: { crypto: 1.5 } }).success).toBe(false);
    expect(FeesSchema.safeParse({ taker_rates: { crypt: 0.07 } }).success).toBe(false);
    expect(FeesSchema.safeParse({ maker_rate: -0.01 }).success).toBe(false);
  });

  it('loads fees.yaml, writing defaults when missing; invalid file throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-fees-'));
    try {
      expect(loadFees(dir).taker_rates.crypto).toBe(0.07);
      expect(fs.existsSync(path.join(dir, 'fees.yaml'))).toBe(true);
      fs.writeFileSync(path.join(dir, 'fees.yaml'), 'taker_rates:\n  sports: 0.02\n');
      expect(loadFees(dir).taker_rates.sports).toBe(0.02);
      fs.writeFileSync(path.join(dir, 'fees.yaml'), 'maker_rate: lots\n');
      expect(() => loadFees(dir)).toThrow(ConfigError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps market labels to fee categories; unknown ⇒ highest taker rate', () => {
    const svc = new FeeService();
    expect(svc.feeCategoryFor(['Economics'])).toBe('economics');
    expect(svc.feeCategoryFor(['Politics', 'Geopolitics'])).toBe('geopolitics');
    expect(svc.feeCategoryFor(['Pop Culture'])).toBe('culture');
    expect(svc.feeCategoryFor(['NBA', 'Sports'])).toBe('sports');
    expect(svc.feeCategoryFor(['Something new'])).toBeNull();
    expect(svc.getRates('geopolitics')).toEqual({ takerRate: 0, makerRate: 0 });
    expect(svc.getRates(null).takerRate).toBe(0.07);
  });
});
