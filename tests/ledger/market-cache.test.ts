import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../packages/core/src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { sqliteAvailable } from '../orders/db';
import { openLedgerHarness, gammaMarket, DAY, type LedgerHarness } from './harness';
import { MARKET_RULES_CHANGED_EVENT, parseGammaMarketFull, type RulesChangedEvent } from '../../packages/core/src/ledger/MarketCacheService';
import type { MarketInfo } from '../../packages/core/src/orders/MarketDataService';
import { NotificationService } from '../../packages/core/src/notify/NotificationService';
import { asHuman } from '../../packages/core/src/services/actors';

const HUMAN = asHuman('test');

const info = (marketId: string, labels: string[] = ['Economy']): MarketInfo => ({
  marketId, question: 'q', outcome: 'Yes', tokenIds: [`${marketId}-yes`, `${marketId}-no`], endDate: null, volume24hrUsd: 1, labels, closed: false, feeSchedule: null,
});

describe('parseGammaMarketFull', () => {
  it('extracts rules, tokens, tags, UMA dispute; missing description ⇒ rules unknown', () => {
    const p = parseGammaMarketFull({
      ...gammaMarket('m1', { umaResolutionStatuses: '["proposed","disputed"]', umaResolutionStatus: 'proposed', negRisk: true }),
      events: [{ id: 123, title: 'CPI', tags: [{ slug: 'inflation', label: 'Inflation' }] }],
    })!;
    expect(p).toMatchObject({
      marketId: 'm1',
      eventId: '123',
      tokens: [{ tokenId: 'm1-yes', outcome: 'Yes' }, { tokenId: 'm1-no', outcome: 'No' }],
      negRisk: true,
      disputed: true,
      liquidityUsd: 20_000,
    });
    expect(p.tags).toEqual(expect.arrayContaining(['economy', 'inflation']));
    expect(p.rulesText).toContain('Resolution source: https://www.bls.gov');
    expect(parseGammaMarketFull({ ...gammaMarket('m1'), description: undefined })!.rulesText).toBeNull();
    expect(parseGammaMarketFull({ question: 'x' })).toBeNull();
  });
});

describe.skipIf(!sqliteAvailable)('MarketCacheService', () => {
  let h: LedgerHarness;
  beforeEach(() => {
    h = openLedgerHarness();
    h.addBot('bot-1');
  });
  afterEach(() => h.close());

  it('stores category and rules hash; a rules change sets rules_changed_at, audits with holders and emits', async () => {
    h.gamma.set('m1', gammaMarket('m1'));
    const first = (await h.cache.refresh('m1'))!;
    expect(first).toMatchObject({ category: 'economics', rulesChangedAt: null, eventId: 'ev-m1', feeCategory: 'economics' });
    expect(first.rulesHash).toMatch(/^[0-9a-f]{64}$/);

    // bot-1 holds a live position in m1
    h.tradeRepo.create({ botId: 'bot-1', exchange: 'polymarket', side: 'BUY', symbol: 'm1-yes', conditionId: 'm1', price: 0.5, quantity: 10, quoteAmount: 5, orderId: 'o1', simulated: 0 });
    const events: RulesChangedEvent[] = [];
    h.cache.on(MARKET_RULES_CHANGED_EVENT, (e: RulesChangedEvent) => events.push(e));

    // Whitespace-only edit: no change
    h.clock.now += 60_000;
    h.gamma.set('m1', gammaMarket('m1', { description: '  This market resolves YES if CPI (m1)\n exceeds 3%. ' }));
    await h.cache.refresh('m1');
    expect(h.cache.getCached('m1')!.rulesChangedAt).toBeNull();

    // Response without a description: rules unknown, kept
    h.gamma.set('m1', gammaMarket('m1', { description: undefined }));
    await h.cache.refresh('m1');
    expect(h.cache.getCached('m1')!.rulesHash).toBe(first.rulesHash);

    // Real wording change
    h.clock.now += 60_000;
    h.gamma.set('m1', gammaMarket('m1', { description: 'This market resolves YES if CPI (m1) is at least 3%.' }));
    const changed = (await h.cache.refresh('m1'))!;
    expect(changed.rulesChangedAt).toBe(new Date(h.clock.now).toISOString());
    expect(changed.rulesHash).not.toBe(first.rulesHash);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ marketId: 'm1', heldBy: ['bot-1'], oldHash: first.rulesHash });
    const audits = h.auditActions('market.rules_changed');
    expect(audits).toHaveLength(1);
    expect(audits[0].payload).toMatchObject({ heldBy: ['bot-1'] });
  });

  it("stores the market's own Gamma fee schedule (absent ⇒ null, category table applies)", async () => {
    h.gamma.set('m1', gammaMarket('m1', { feesEnabled: true, feeType: 'politics_fees', feeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 } }));
    h.gamma.set('m2', gammaMarket('m2', { feesEnabled: false, feeType: 'zero_fees' }));
    h.gamma.set('m3', gammaMarket('m3'));
    expect((await h.cache.refresh('m1'))!.feeSchedule).toEqual({ feesEnabled: true, feeType: 'politics_fees', rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25, from: 'feeSchedule' });
    expect((await h.cache.refresh('m2'))!.feeSchedule).toMatchObject({ rate: 0, from: 'zero' });
    expect((await h.cache.refresh('m3'))!.feeSchedule).toBeNull();
    expect(h.cache.getCachedByToken('m1-yes')!.feeSchedule!.rate).toBe(0.04);
  });

  it('live Gamma search: text ⇒ public-search events flattened, categorized and filtered; nothing cached', async () => {
    h.gamma.set('m1', gammaMarket('m1'));
    await h.cache.refresh('m1');
    h.fetchFn.mockImplementationOnce(async (url: string) => {
      const u = new URL(url);
      expect(u.pathname).toBe('/public-search');
      expect(u.searchParams.get('q')).toBe('cpi');
      expect(u.searchParams.get('events_status')).toBe('active');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          events: [
            { id: 'e1', title: 'US CPI', tags: [{ slug: 'economy', label: 'Economy' }], markets: [gammaMarket('m1'), gammaMarket('m2', { feeSchedule: { rate: 0.05, exponent: 1 } })] },
            { id: 'e2', title: 'NBA', tags: [{ slug: 'sports', label: 'Sports' }], markets: [gammaMarket('m3', { question: 'Lakers win?' }), gammaMarket('m4', { closed: true })] },
          ],
        }),
      } as unknown as Response;
    });
    const hits = await h.cache.searchGamma({ q: 'cpi', category: 'economics' });
    expect(hits.map((x) => [x.marketId, x.category, x.cached, x.feeRate])).toEqual([
      ['m1', 'economics', true, null],
      ['m2', 'economics', false, 0.05],
    ]);
    expect(h.cache.getCached('m2')).toBeNull();

    h.fetchFn.mockImplementationOnce(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response);
    await expect(h.cache.searchGamma({})).rejects.toThrow(/503/);
  });

  it('ambiguity: unassessed ⇒ null (buys rejected); assessed; auto-raised to 2 for 7 days after a rules change and on dispute', async () => {
    h.gamma.set('m1', gammaMarket('m1'));
    expect(await h.cache.get(info('m1'))).toEqual({ category: 'economics', ambiguityScore: null, rulesChangedAt: null });

    await h.cache.setAmbiguity('m1', 0, HUMAN, 'objective BLS source');
    expect((await h.cache.get(info('m1'))).ambiguityScore).toBe(0);
    expect(h.auditActions('market.ambiguity')[0]).toMatchObject({ actor: 'human', payload: { to: 0, effective: 0 } });

    h.gamma.set('m1', gammaMarket('m1', { description: 'Changed wording' }));
    h.clock.now += 11 * 60_000; // past the TTL: the order path refreshes
    const q = await h.cache.get(info('m1'));
    expect(q.ambiguityScore).toBe(2);
    expect(q.rulesChangedAt).toBe(new Date(h.clock.now).toISOString());

    h.clock.now += 7 * DAY + 1;
    expect(h.cache.getCached('m1')!.ambiguityScore).toBe(0); // raise expired, assessment kept

    h.gamma.set('m1', gammaMarket('m1', { description: 'Changed wording', umaResolutionStatus: 'disputed' }));
    await h.cache.refresh('m1');
    expect(h.cache.getCached('m1')).toMatchObject({ disputed: true, ambiguityScore: 2, ambiguityRaisedBecause: 'UMA dispute detected' });
    expect(h.auditActions('market.disputed')).toHaveLength(1);

    await expect(h.cache.setAmbiguity('m1', 4, HUMAN)).rejects.toThrow(/0-3/);
    await expect(h.cache.setAmbiguity('m1', 1.5, HUMAN)).rejects.toThrow(/0-3/);
  });

  it('order path never throws on Gamma failure: cached row is used; nothing cached ⇒ labels category, ambiguity unknown', async () => {
    h.gamma.set('m1', gammaMarket('m1'));
    await h.cache.setAmbiguity('m1', 1, HUMAN);
    h.gammaDown.value = true;
    h.clock.now += 60 * 60_000;
    expect(await h.cache.get(info('m1'))).toEqual({ category: 'economics', ambiguityScore: 1, rulesChangedAt: null });
    expect(await h.cache.get(info('m2', ['Sports']))).toEqual({ category: 'sports', ambiguityScore: null, rulesChangedAt: null });
  });

  it('order path: a row not refreshed for 2 h ⇒ ambiguity unknown (buys rejected)', async () => {
    h.gamma.set('m1', gammaMarket('m1'));
    await h.cache.setAmbiguity('m1', 0, HUMAN);
    h.gammaDown.value = true;
    h.clock.now += 2 * 3_600_000 - 1000;
    expect((await h.cache.get(info('m1'))).ambiguityScore).toBe(0);
    h.clock.now += 2000;
    expect(await h.cache.get(info('m1'))).toMatchObject({ category: 'economics', ambiguityScore: null });
    // Gamma no longer returns the market: same
    h.gammaDown.value = false;
    h.gamma.delete('m1');
    expect((await h.cache.get(info('m1'))).ambiguityScore).toBeNull();
    h.gamma.set('m1', gammaMarket('m1'));
    expect((await h.cache.get(info('m1'))).ambiguityScore).toBe(0);
  });

  it('periodic refresh batches watched markets; re-categorizes after a mapping change', async () => {
    for (const id of ['a', 'b', 'c']) h.gamma.set(id, gammaMarket(id));
    const cache2 = h.cache;
    (cache2 as unknown as { deps: { watchedMarketIds: () => string[] } }).deps.watchedMarketIds = () => ['a', 'b', 'c', 'a'];
    await cache2.runPeriodic();
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    expect(h.marketRepo.all().map((r) => r.market_id).sort()).toEqual(['a', 'b', 'c']);

    (cache2 as unknown as { deps: { getCategories: () => unknown } }).deps.getCategories = () => ({ rules: [] });
    expect(cache2.recategorizeAll()).toBe(3);
    expect(h.cache.getCached('a')!.category).toBe('other');
  });

  it('Telegram: rules change / dispute on a held market is sent immediately; unheld is not', () => {
    const send = vi.fn();
    const svc = new NotificationService({
      notifier: { send, flush: async () => undefined, answerCallback: async () => undefined } as never,
      audit: h.audit,
      killSwitch: { activate: vi.fn() } as never,
      botRepo: h.botRepo,
      riskStateRepo: h.riskStateRepo,
      getLimits: () => null,
      getServer: () => null,
      getExposureUsd: () => 0,
      stopBot: async () => undefined,
      isRunning: () => false,
    });
    h.audit.record('system', 'market.rules_changed', 'm1', { question: 'CPI?', heldBy: [] }, 'changed');
    expect(send).not.toHaveBeenCalled();
    h.audit.record('system', 'market.rules_changed', 'm1', { question: 'CPI?', heldBy: ['bot-1'] }, 'changed');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ text: expect.stringMatching(/RULES CHANGED.*bot-1/), priority: 'high' });
    h.audit.record('system', 'category_rights.change', 'economics/short', { category: 'economics', bucket: 'short', from: 'shadow', to: 'trading', maxAllocationUsd: 50, reason: 'qualified' }, 'ok');
    expect(send.mock.calls[1][0].text).toMatch(/economics\/short: shadow -> trading/);
    void svc.stop();
  });
});
