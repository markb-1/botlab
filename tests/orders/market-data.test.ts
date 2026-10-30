import { describe, it, expect } from 'vitest';
import { MandateSchema } from '../../electron/config';
import { mandateCategory, parseGammaMarket } from '../../electron/orders/MarketDataService';

describe('market metadata', () => {
  const gamma = {
    conditionId: '0xc1',
    question: 'Will CPI exceed 3%?',
    clobTokenIds: '["111","222"]',
    outcomes: '["Yes","No"]',
    endDate: '2026-07-01T00:00:00Z',
    volume24hr: 12345.6,
    category: 'Economics',
    tags: [{ slug: 'economy', label: 'Economy' }],
    events: [{ tags: [{ label: 'Sports' }] }],
    active: true,
    closed: false,
  };

  it('parses a Gamma market for the requested token only', () => {
    expect(parseGammaMarket(gamma, '222')).toMatchObject({
      marketId: '0xc1', outcome: 'No', tokenIds: ['111', '222'], volume24hrUsd: 12345.6,
      labels: ['Economics', 'economy', 'Sports'], closed: false,
    });
    expect(parseGammaMarket(gamma, '333')).toBeNull();
    expect(parseGammaMarket({ ...gamma, conditionId: undefined }, '111')).toBeNull();
    expect(parseGammaMarket({ ...gamma, active: false }, '111')?.closed).toBe(true);
    expect(parseGammaMarket({ ...gamma, endDate: 'soon' }, '111')?.endDate).toBeNull();
  });

  it('mandate category: denied label wins over allowed (fail closed)', () => {
    const mandate = MandateSchema.parse({});
    expect(mandateCategory(['Economics'], mandate)).toBe('economics');
    expect(mandateCategory(['Economics', 'Sports'], mandate)).toBe('sports');
    expect(mandateCategory(['Geopolitics', 'Economics'], mandate)).toBe('geopolitics'); // "later" list
    expect(mandateCategory(['Weather'], mandate)).toBe('weather'); // not in any list ⇒ rejected by the engine
    expect(mandateCategory([], mandate)).toBeNull();
  });
});
