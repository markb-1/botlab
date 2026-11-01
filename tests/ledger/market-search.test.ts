import { describe, it, expect, vi } from 'vitest';
import { MarketService, SEARCH_CACHE_MS } from '../../packages/core/src/services/MarketService';
import { GammaHttpError, type MarketCacheService } from '../../packages/core/src/ledger/MarketCacheService';
import { ServiceError } from '../../packages/core/src/services/errors';
import { LimitsSchema, MandateSchema } from '../../packages/core/src/config';

function setup() {
  const clock = { now: 1_000_000 };
  const searchGamma = vi.fn(async () => [{ marketId: 'm1' }]);
  const svc = new MarketService({ searchGamma } as unknown as MarketCacheService, () => clock.now);
  return { clock, searchGamma, svc };
}

describe('MarketService.searchLive (cache + Gamma 429 back-off)', () => {
  it('reuses results for the same query for 60 s', async () => {
    const { clock, searchGamma, svc } = setup();
    await svc.searchLive({ q: 'CPI ' });
    await svc.searchLive({ q: 'cpi' }); // same normalised query
    expect(searchGamma).toHaveBeenCalledTimes(1);
    await svc.searchLive({ q: 'cpi', category: 'economics' });
    expect(searchGamma).toHaveBeenCalledTimes(2);
    clock.now += SEARCH_CACHE_MS;
    await svc.searchLive({ q: 'cpi' });
    expect(searchGamma).toHaveBeenCalledTimes(3);
  });

  it('after a 429 it stops calling Gamma until Retry-After, still serving cached queries', async () => {
    const { clock, searchGamma, svc } = setup();
    await svc.searchLive({ q: 'cached' });
    searchGamma.mockRejectedValueOnce(new GammaHttpError('Gamma search HTTP 429', 429, 30_000));
    await expect(svc.searchLive({ q: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(svc.searchLive({ q: 'y' })).rejects.toThrow(/rate-limited.*\d+ s/);
    expect(searchGamma).toHaveBeenCalledTimes(2);
    expect(await svc.searchLive({ q: 'cached' })).toEqual([{ marketId: 'm1' }]);
    clock.now += 30_000;
    await svc.searchLive({ q: 'y' });
    expect(searchGamma).toHaveBeenCalledTimes(3);
  });

  it('other failures are not cached and do not back off', async () => {
    const { searchGamma, svc } = setup();
    searchGamma.mockRejectedValueOnce(new Error('network down'));
    await expect(svc.searchLive({ q: 'x' })).rejects.toBeInstanceOf(ServiceError);
    await svc.searchLive({ q: 'x' });
    expect(searchGamma).toHaveBeenCalledTimes(2);
  });
});

describe('MarketService.searchLive: category fan-out (Mac test F6 review)', () => {
  it('one fan-out for different limits: fetched once at the maximum size, sliced per request', async () => {
    const clock = { now: 1_000_000 };
    const many = Array.from({ length: 80 }, (_, i) => ({ marketId: `m${i}` }));
    const searchGamma = vi.fn(async () => many);
    const svc = new MarketService({ searchGamma } as unknown as MarketCacheService, () => clock.now);
    expect(await svc.searchLive({ category: 'economics', limit: 5 })).toHaveLength(5);
    expect(await svc.searchLive({ category: 'economics', limit: 50 })).toHaveLength(50);
    expect(await svc.searchLive({ category: 'economics' })).toHaveLength(50);
    expect(searchGamma).toHaveBeenCalledTimes(1);
    expect(searchGamma).toHaveBeenCalledWith(expect.objectContaining({ category: 'economics', limit: 100 }));
  });

  it('concurrent identical searches share one in-flight request', async () => {
    let release!: (v: unknown) => void;
    const searchGamma = vi.fn(() => new Promise((r) => (release = r)));
    const svc = new MarketService({ searchGamma } as unknown as MarketCacheService, () => 1_000_000);
    const a = svc.searchLive({ category: 'weather-climate', limit: 3 });
    const b = svc.searchLive({ category: 'weather-climate', limit: 10 });
    release([{ marketId: 'x' }]);
    expect(await a).toEqual([{ marketId: 'x' }]);
    expect(await b).toEqual([{ marketId: 'x' }]);
    expect(searchGamma).toHaveBeenCalledTimes(1);
  });

  it('a category fan-out weighs more against the per-principal search limit', () => {
    const svc = new MarketService({ categorySearchTagCount: (c: string) => (c === 'economics' ? 22 : 0) } as unknown as MarketCacheService, () => 0);
    expect(svc.searchCost({ q: 'cpi', category: 'economics' })).toBe(1);
    expect(svc.searchCost({ category: 'economics' })).toBe(6);
    expect(svc.searchCost({})).toBe(1);
  });
});

describe('MarketService.searchForAgent: 24h volume flags (R209)', () => {
  const NOW = Date.parse('2026-06-01T00:00:00Z');
  const hit = (marketId: string, volume24hUsd: number) => ({
    marketId,
    category: 'economics',
    endDate: new Date(NOW + 10 * 86_400_000).toISOString(),
    outcomePrices: ['0.5', '0.5'],
    volume24hUsd,
    ambiguityScore: null,
  });
  function search(mandate: Record<string, unknown>) {
    const searchGamma = vi.fn(async () => [hit('thick', 6000), hit('mid', 2000), hit('thin', 500)]);
    const svc = new MarketService({ searchGamma } as unknown as MarketCacheService, () => NOW, {
      getMandate: () => MandateSchema.parse({ categories: { allow: ['economics'] }, ...mandate }),
      getLimits: () => LimitsSchema.parse({}),
    });
    return svc.searchForAgent({ q: 'cpi' });
  }

  it('without min_forecast_volume_usd every market under the trading floor is flagged as before', async () => {
    const flags = Object.fromEntries((await search({})).map((h) => [h.marketId, h.flags]));
    expect(flags.thick).toEqual([]);
    expect(flags.mid).toEqual(['24h volume 2000 < 5000']);
    expect(flags.thin).toEqual(['24h volume 500 < 5000']);
  });

  it('between the floors: forecast only; below the forecast floor: no forecast either', async () => {
    const hits = await search({ markets: { min_forecast_volume_usd: 1000 } });
    const flags = Object.fromEntries(hits.map((h) => [h.marketId, h.flags]));
    expect(flags.thick).toEqual([]);
    expect(flags.mid).toEqual(['24h volume 2000 < 5000: forecast only (orders need min_liquidity_usd)']);
    expect(flags.thin).toEqual(['24h volume 500 < 1000 (min_forecast_volume_usd): no forecast either']);
  });
});
