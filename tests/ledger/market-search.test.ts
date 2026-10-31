import { describe, it, expect, vi } from 'vitest';
import { MarketService, SEARCH_CACHE_MS } from '../../packages/core/src/services/MarketService';
import { GammaHttpError, type MarketCacheService } from '../../packages/core/src/ledger/MarketCacheService';
import { ServiceError } from '../../packages/core/src/services/errors';

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
