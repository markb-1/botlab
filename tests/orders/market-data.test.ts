import { describe, it, expect } from 'vitest';
import { parseGammaMarket } from '../../packages/core/src/orders/MarketDataService';

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
});

describe('CLOB post response classification', () => {
  it('only definite client errors are rejections', async () => {
    const { interpretPostResponse } = await import('../../packages/core/src/exchange/polymarket/orders');
    expect(interpretPostResponse({ error: 'bad order', status: 400 }, 'buy').kind).toBe('rejected');
    expect(interpretPostResponse({ error: 'unauthorized', status: 401 }, 'buy').kind).toBe('rejected');
    for (const status of [408, 425, 429, 500, 502, 503]) {
      expect(interpretPostResponse({ error: 'x', status }, 'buy').kind).toBe('unknown');
    }
    expect(interpretPostResponse({ error: 'ECONNRESET' }, 'buy').kind).toBe('unknown');
    expect(interpretPostResponse(undefined, 'buy').kind).toBe('unknown');
    expect(interpretPostResponse({ success: false, errorMsg: 'not enough balance' }, 'buy').kind).toBe('rejected');
    expect(
      interpretPostResponse({ success: true, errorMsg: '', orderID: '0x1', status: 'matched', makingAmount: '10', takingAmount: '20' }, 'buy')
    ).toEqual({ kind: 'accepted', exchangeOrderId: '0x1', status: 'matched', filledSize: 20, filledNotional: 10 });
  });
});
