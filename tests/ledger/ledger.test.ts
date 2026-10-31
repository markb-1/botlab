import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../packages/core/src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { sqliteAvailable } from '../orders/db';
import { openLedgerHarness, gammaMarket, DAY, T0, type LedgerHarness } from './harness';
import { DbRiskStateProvider } from '../../packages/core/src/orders/DbRiskStateProvider';
import { RiskEngine } from '../../packages/core/src/risk/RiskEngine';
import { LimitsSchema, MandateSchema } from '../../packages/core/src/config';
import type { OrderRequest } from '../../packages/core/src/risk/types';
import { asHuman } from '../../packages/core/src/services/actors';

const HUMAN = asHuman('test');

const HOUR = 3_600_000;

const valid = (tokenId = 'm1-yes', o: Record<string, unknown> = {}) => ({
  tokenId,
  probability: 0.6,
  rationale: 'BLS nowcast and Cleveland Fed point above consensus.',
  sources: ['https://www.bls.gov/cpi/', 'https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting'],
  ambiguityScore: 0,
  ...o,
});

describe.skipIf(!sqliteAvailable)('LedgerService', () => {
  let h: LedgerHarness;

  function market(id: string, o: Parameters<typeof gammaMarket>[1] = {}) {
    h.gamma.set(id, gammaMarket(id, o));
    h.books.set(`${id}-yes`, { bestBid: 0.4, bestAsk: 0.44 });
    h.books.set(`${id}-no`, { bestBid: 0.56, bestAsk: 0.6 });
  }

  beforeEach(() => {
    h = openLedgerHarness();
    h.addBot('bot-1');
    market('m1');
  });
  afterEach(() => h.close());

  describe('submitForecast', () => {
    it('captures the market snapshot server-side and computes bucket, category, tradeable', async () => {
      const f = await h.ledger.submitForecast(valid(), 'human');
      expect(f).toMatchObject({
        marketId: 'm1',
        tokenId: 'm1-yes',
        eventId: 'ev-m1',
        category: 'economics',
        probability: 0.6,
        bestBid: 0.4,
        bestAsk: 0.44,
        liquidityUsd: 20_000,
        horizonBucket: 'short',
        status: 'active',
        tradeable: false, // new bucket starts in shadow
        createdBy: 'human',
      });
      expect(f.marketPriceAtForecast).toBeCloseTo(0.42);
      expect(f.daysToResolutionAtForecast).toBeCloseTo(5);
      expect(h.rightsRepo.get('economics', 'short')!.state).toBe('shadow');
      // The forecast's score is the market's assessment
      expect(h.cache.getCached('m1')).toMatchObject({ assessedAmbiguity: 0, ambiguitySource: 'forecast' });
      expect(h.auditActions('ledger.forecast')).toHaveLength(1);
    });

    it('the caller cannot supply or backdate market data', async () => {
      for (const extra of [{ marketPriceAtForecast: 0.1 }, { bestBid: 0.1 }, { createdAt: '2020-01-01T00:00:00Z' }, { liquidityUsd: 1e9 }, { tradeable: true }]) {
        await expect(h.ledger.submitForecast(valid('m1-yes', extra), 'human')).rejects.toThrow(/Invalid forecast/);
      }
      expect(h.forecastRepo.list()).toHaveLength(0);
    });

    it.each([
      ['probability below 0.01', { probability: 0.005 }],
      ['probability above 0.99', { probability: 0.995 }],
      ['probability not a number', { probability: '0.5' }],
      ['empty rationale', { rationale: '   ' }],
      ['rationale too long', { rationale: 'x'.repeat(4001) }],
      ['sources not URLs', { sources: ['not a url'] }],
      ['sources not https/http', { sources: ['javascript:alert(1)'] }],
      ['sources missing', { sources: undefined }],
      ['ambiguity out of range', { ambiguityScore: 4 }],
      ['ambiguity not an integer', { ambiguityScore: 1.5 }],
    ])('rejects %s', async (_n, o) => {
      await expect(h.ledger.submitForecast(valid('m1-yes', o), 'human')).rejects.toThrow(/Invalid forecast/);
    });

    it('rejects closed, unknown, ending-soon, too-long and unpriced markets', async () => {
      market('closed', { closed: true });
      market('soon', { endDate: new Date(T0 + 5 * HOUR).toISOString() });
      market('far', { endDate: new Date(T0 + 120 * DAY).toISOString() });
      market('noend', { endDate: 'tbd' });
      market('onesided');
      h.books.set('onesided-yes', { bestBid: null, bestAsk: 0.5 });
      market('nobook');
      h.books.delete('nobook-yes');
      await expect(h.ledger.submitForecast(valid('closed-yes'), 'human')).rejects.toThrow(/not open/);
      await expect(h.ledger.submitForecast(valid('nope-yes'), 'human')).rejects.toThrow(/Unknown token/);
      await expect(h.ledger.submitForecast(valid('soon-yes'), 'human')).rejects.toThrow(/less than 6 hours/);
      await expect(h.ledger.submitForecast(valid('far-yes'), 'human')).rejects.toThrow(/> 90/);
      await expect(h.ledger.submitForecast(valid('noend-yes'), 'human')).rejects.toThrow(/end date unknown/);
      await expect(h.ledger.submitForecast(valid('onesided-yes'), 'human')).rejects.toThrow(/two-sided/);
      await expect(h.ledger.submitForecast(valid('nobook-yes'), 'human')).rejects.toThrow(/Order book unavailable/);
      h.gammaDown.value = true;
      h.clock.now += HOUR; // cache stale
      await expect(h.ledger.submitForecast(valid('m1-yes'), 'human')).rejects.toThrow(/Market lookup failed/);
    });

    it('a new forecast supersedes the active one after 6 h at the earliest; withdraw is always allowed and needs a reason', async () => {
      const a = await h.ledger.submitForecast(valid(), 'human');
      h.clock.now += 6 * HOUR - 1;
      await expect(h.ledger.submitForecast(valid('m1-yes', { probability: 0.7 }), 'human')).rejects.toThrow(/less than 6 hours old/);
      h.clock.now += 1;
      const b = await h.ledger.submitForecast(valid('m1-yes', { probability: 0.7 }), 'human');
      expect(h.ledger.getForecast(a.id)).toMatchObject({ status: 'superseded', supersededBy: b.id });
      expect(h.ledger.getActiveForToken('m1-yes')!.id).toBe(b.id);
      expect(() => h.ledger.withdrawForecast(b.id, ' ', 'human')).toThrow(/reason/);
      expect(h.ledger.withdrawForecast(b.id, 'new information', 'human').status).toBe('withdrawn');
      expect(h.ledger.getActiveForToken('m1-yes')).toBeNull();
      expect(() => h.ledger.withdrawForecast(b.id, 'again', 'human')).toThrow(/not active/);
      // Nothing active any more: a new forecast is allowed at once
      expect((await h.ledger.submitForecast(valid('m1-yes', { probability: 0.65 }), 'human')).status).toBe('active');
    });

    it('rejects markets whose mid is not a usable baseline: wide spread, low liquidity, any UMA status', async () => {
      market('wide');
      h.books.set('wide-yes', { bestBid: 0.4, bestAsk: 0.47 }); // 0.07 > limits max_spread 0.06
      await expect(h.ledger.submitForecast(valid('wide-yes'), 'human')).rejects.toThrow(/Spread 0.070 > 0.06/);
      market('wide2');
      h.books.set('wide2-yes', { bestBid: 0.3, bestAsk: 0.45 });
      const noLimits = (h.ledger as unknown as { deps: { getLimits?: unknown } }).deps;
      noLimits.getLimits = undefined; // no limits: the fixed 0.10 cap still applies
      await expect(h.ledger.submitForecast(valid('wide2-yes'), 'human')).rejects.toThrow(/> 0.1/);
      market('thin', { volume24hr: 4999 });
      await expect(h.ledger.submitForecast(valid('thin-yes'), 'human')).rejects.toThrow(/liquidity 4999/);
      for (const status of ['proposed', 'disputed', 'resolved']) {
        market(`uma-${status}`, { umaResolutionStatus: status });
        await expect(h.ledger.submitForecast(valid(`uma-${status}-yes`), 'human')).rejects.toThrow(/UMA resolution status/);
      }
      h.mandate.value = null;
      await expect(h.ledger.submitForecast(valid('m1-yes'), 'human')).rejects.toThrow(/Mandate unavailable/);
    });

    it('a human assessment wins over forecasts; forecasts can only raise a forecast-sourced score', async () => {
      market('m2');
      await h.ledger.submitForecast(valid('m1-yes', { ambiguityScore: 1 }), 'human');
      expect(h.cache.getCached('m1')).toMatchObject({ assessedAmbiguity: 1, ambiguitySource: 'forecast' });
      await h.ledger.submitForecast(valid('m1-no', { ambiguityScore: 0 }), 'human'); // lower: ignored
      expect(h.cache.getCached('m1')!.assessedAmbiguity).toBe(1);
      h.clock.now += 6 * HOUR;
      await h.ledger.submitForecast(valid('m1-yes', { ambiguityScore: 2 }), 'human'); // higher: raises
      expect(h.cache.getCached('m1')!.assessedAmbiguity).toBe(2);

      await h.cache.setAmbiguity('m2', 0, HUMAN, 'read the rules');
      await h.ledger.submitForecast(valid('m2-yes', { ambiguityScore: 3 }), 'human');
      expect(h.cache.getCached('m2')).toMatchObject({ assessedAmbiguity: 0, ambiguitySource: 'human' });
      await h.cache.setAmbiguity('m2', 1, HUMAN); // a human can change it
      expect(h.cache.getCached('m2')!.assessedAmbiguity).toBe(1);
      await expect(h.cache.setAmbiguity('m2', 0, 'agent')).rejects.toThrow(/human/);
    });

    it('server raise: a recent rules change records the forecast at ambiguity ≥ 2', async () => {
      await h.cache.refresh('m1');
      h.gamma.set('m1', gammaMarket('m1', { description: 'Different rules now' }));
      await h.cache.refresh('m1');
      const f = await h.ledger.submitForecast(valid(), 'human');
      expect(f.ambiguityScore).toBe(2);
      expect(h.cache.getCached('m1')).toMatchObject({ assessedAmbiguity: 0, ambiguityScore: 2 });
    });
  });

  describe('scorer', () => {
    it('scores resolved markets (superseded and withdrawn too) after confirmation, voids 50-50, captures convergence', async () => {
      for (const id of ['m2', 'm3', 'm4']) market(id);
      const a = await h.ledger.submitForecast(valid('m1-yes', { probability: 0.6 }), 'human'); // m = 0.42
      const c = await h.ledger.submitForecast(valid('m2-no', { probability: 0.3 }), 'human'); // m = 0.58
      h.ledger.withdrawForecast(c.id, 'changed my mind', 'human');
      const d = await h.ledger.submitForecast(valid('m3-yes'), 'human');
      const e = await h.ledger.submitForecast(valid('m4-yes', { probability: 0.6 }), 'human');
      h.clock.now = T0 + 6 * HOUR;
      const b = await h.ledger.submitForecast(valid('m1-yes', { probability: 0.8 }), 'human'); // supersedes a

      // Day 2: m1 resolves YES with a settled UMA status (scored at once); m2 resolves YES and m3 50-50
      // without one (need a second sighting 24 h later)
      h.clock.now = T0 + 2 * DAY;
      h.gamma.set('m1', gammaMarket('m1', { closed: true, outcomePrices: '["1","0"]', umaResolutionStatus: 'resolved' }));
      h.gamma.set('m2', gammaMarket('m2', { closed: true, outcomePrices: '["1","0"]' }));
      h.gamma.set('m3', gammaMarket('m3', { closed: true, outcomePrices: '["0.5","0.5"]' }));
      expect(await h.ledger.runOnce()).toMatchObject({ scored: 2, voided: 0, pendingConfirmation: 2 });
      h.clock.now = T0 + 3 * DAY - HOUR;
      expect(await h.ledger.runOnce()).toMatchObject({ scored: 0, voided: 0, pendingConfirmation: 2 });
      h.clock.now = T0 + 3 * DAY + HOUR;
      expect(await h.ledger.runOnce()).toMatchObject({ scored: 1, voided: 1, pendingConfirmation: 0 });

      const fa = h.ledger.getForecast(a.id)!;
      expect(fa).toMatchObject({ status: 'superseded', outcome: 1 });
      expect(fa.brierAgent).toBeCloseTo(0.16);
      expect(fa.brierMarket).toBeCloseTo(0.58 ** 2);
      expect(fa.skill).toBeCloseTo(0.58 ** 2 - 0.16);
      expect(fa.priceAt7d).toBe(1); // resolved before 7 days ⇒ resolution price
      expect(fa.convergence).toBeCloseTo(0.58);
      expect(h.ledger.getForecast(b.id)).toMatchObject({ status: 'resolved', outcome: 1 });
      const fc = h.ledger.getForecast(c.id)!;
      expect(fc).toMatchObject({ status: 'withdrawn', outcome: 0, resolvedAt: new Date(T0 + 2 * DAY).toISOString() }); // first sighting
      expect(fc.skill).toBeCloseTo(0.58 ** 2 - 0.09);
      expect(h.ledger.getForecast(d.id)).toMatchObject({ status: 'void', outcome: null });

      // A final price that changes between sightings restarts the wait
      market('m5');
      await h.ledger.submitForecast(valid('m5-yes'), 'human');
      h.gamma.set('m5', gammaMarket('m5', { closed: true, outcomePrices: '["1","0"]' }));
      await h.ledger.runOnce();
      h.clock.now += 25 * HOUR;
      h.gamma.set('m5', gammaMarket('m5', { closed: true, outcomePrices: '["0","1"]' }));
      expect(await h.ledger.runOnce()).toMatchObject({ scored: 0, pendingConfirmation: 1 });

      // Day 7: convergence for the still-open m4 (agent above market, market rose)
      h.mids.set('m4-yes', 0.5);
      h.clock.now = T0 + 7 * DAY + HOUR;
      await h.ledger.runOnce();
      const fe = h.ledger.getForecast(e.id)!;
      expect(fe.priceAt7d).toBe(0.5);
      expect(fe.convergence).toBeCloseTo(0.08);
      expect(fe.outcome).toBeNull();
      // m5's second result has now been seen for > 24 h
      expect(h.ledger.list({ marketId: 'm5' })[0]).toMatchObject({ outcome: 0 });

      // Stats: one vote per event, void excluded
      const stats = h.ledger.stats().find((s) => s.category === 'economics' && s.horizonBucket === 'short')!;
      expect(stats.nScored).toBe(3); // events m1, m2, m5
      expect(stats.nConvergence).toBe(4); // m1, m2, m5 (at resolution) and m4
      expect(stats.state).toBe('shadow');
      expect(stats.threshold.remaining).toBe(27);
    });

    it('superseding cannot dilute a bad call: versions weighted by active time, near-mid versions excluded', async () => {
      // One bad call (p 0.9, m 0.5, outcome 0 ⇒ skill −0.56) active for a day, then 9 quick re-forecasts at the mid
      const row = (i: number, p: number, created: number, until: number) => ({
        id: `v${i}`, market_id: 'mk', token_id: 'tok', event_id: 'ev', category: 'economics', probability: p,
        market_price_at_forecast: 0.5, best_bid: 0.49, best_ask: 0.51, liquidity_usd: 1e4, rationale: 'r', sources: '[]',
        ambiguity_score: 0, status: (i === 9 ? 'resolved' : 'superseded') as 'resolved', superseded_by: null, tradeable: 0,
        days_to_resolution_at_forecast: 5, horizon_bucket: 'short' as const, price_at_7d: null, price_at_7d_at: null,
        convergence: null, created_by: 'human', withdrawn_at: null, withdrawn_reason: null,
        created_at: new Date(created).toISOString(), resolved_at: new Date(T0 + 3 * DAY).toISOString(), outcome: 0,
        brier_agent: p ** 2, brier_market: 0.25, skill: 0.25 - p ** 2, active_until: new Date(until).toISOString(),
      });
      const bad = row(0, 0.9, T0, T0 + 2 * DAY);
      const atMid = Array.from({ length: 9 }, (_, i) => row(i + 1, 0.5, T0 + 2 * DAY + i * 6 * HOUR, T0 + 2 * DAY + (i + 1) * 6 * HOUR));
      const { bucketVotes } = await import('../../packages/core/src/ledger/LedgerService');
      expect(bucketVotes([bad, ...atMid]).skill[0].value).toBeCloseTo(-0.56);
      // Slightly off the mid (|p − m| = 0.03) still counts, but only for its active time
      const nearMid = atMid.map((r) => ({ ...r, probability: 0.53, skill: 0.25 - 0.53 ** 2 }));
      const v = bucketVotes([bad, ...nearMid]).skill[0].value;
      const expected = (-0.56 * 2 * DAY + (0.25 - 0.53 ** 2) * 54 * HOUR) / (2 * DAY + 54 * HOUR);
      expect(v).toBeCloseTo(expected);
      expect(v).toBeLessThan(-0.2); // a plain mean of the 10 rows would be ≈ −0.08
      // Two tokens of one event: mean over tokens, not over rows
      const other = { ...row(20, 0.2, T0, T0 + 3 * DAY), token_id: 'tok2', outcome: 1, skill: 0.25 - 0.64 };
      expect(bucketVotes([bad, ...atMid, other]).skill).toHaveLength(1);
      expect(bucketVotes([bad, ...atMid, other]).skill[0].value).toBeCloseTo((-0.56 + (0.25 - 0.64)) / 2);
    });

    it('end to end: quick re-forecasts are refused, so a bad call keeps its weight', async () => {
      await h.ledger.submitForecast(valid('m1-yes', { probability: 0.9 }), 'human');
      for (let i = 0; i < 9; i++) {
        h.clock.now += 30 * 60_000;
        await expect(h.ledger.submitForecast(valid('m1-yes', { probability: 0.42 }), 'human')).rejects.toThrow(/6 hours/);
      }
      expect(h.forecastRepo.list()).toHaveLength(1);
    });

    it('rights move shadow → trading on the 30th good event, audited', async () => {
      // 30 scored events with positive skill, written straight to the repository
      for (let i = 0; i < 30; i++) {
        const id = `f${i}`;
        h.forecastRepo.insertSuperseding({
          id, marketId: `mk${i}`, tokenId: `tok${i}`, eventId: `ev${i}`, category: 'economics', probability: 0.7,
          marketPriceAtForecast: 0.5, bestBid: 0.49, bestAsk: 0.51, liquidityUsd: 1e4, rationale: 'r', sources: [],
          ambiguityScore: 0, tradeable: false, daysToResolution: 3, horizonBucket: 'short', createdBy: 'human',
          createdAt: new Date(T0 - 40 * DAY + i * DAY).toISOString(),
        });
        h.forecastRepo.setScore(id, { outcome: i % 5 === 0 ? 0 : 1, brierAgent: 0, brierMarket: 0, skill: i % 5 === 0 ? -0.24 : 0.16, resolvedAt: new Date(T0 - 35 * DAY + i * DAY).toISOString() });
      }
      const changes = h.ledger.evaluateRights();
      expect(changes).toEqual([expect.objectContaining({ category: 'economics', bucket: 'short', from: 'shadow', to: 'trading' })]);
      expect(h.rightsRepo.get('economics', 'short')).toMatchObject({ state: 'trading', max_allocation_usd: 50, qualified_n: 30, n_scored: 30 });
      expect(h.auditActions('category_rights.change')[0]).toMatchObject({ actor: 'system', target: 'economics/short', payload: { from: 'shadow', to: 'trading' } });

      // A later category with the same record could never trade
      h.mandate.value = MandateSchema.parse({ categories: { allow: ['weather-climate'], later: ['economics', 'geopolitics'] } });
      expect(h.ledger.evaluateRights()).toEqual([expect.objectContaining({ from: 'trading', to: 'shadow' })]);
      expect(() => h.ledger.forceRightsState('economics', 'short', 'trading', 'try', HUMAN)).toThrow(/later/);
    });

    it('human force is audited and human only', () => {
      expect(() => h.ledger.forceRightsState('economics', 'short', 'trading', 'test', 'agent')).toThrow(/human/);
      const s = h.ledger.forceRightsState('economics', 'short', 'trading', 'manual test', HUMAN)!;
      expect(s).toMatchObject({ state: 'trading', forced: true, maxAllocationUsd: 50 });
      expect(h.auditActions('category_rights.change').at(-1)).toMatchObject({ actor: 'human', payload: { forced: true, to: 'trading' } });
      expect(h.ledger.forceRightsState('economics', 'short', 'auto', 'back to rules', HUMAN)!.forced).toBe(false);
    });

    it('un-forcing (auto) re-evaluates at once: a forced trading bucket without a record goes back to shadow; a qualified one keeps trading', () => {
      h.ledger.forceRightsState('politics-non-us', 'medium', 'trading', 'test run', HUMAN);
      h.ledger.forceRightsState('economics', 'short', 'trading', 'test run', HUMAN);
      expect(h.rightsRepo.get('economics', 'short')).toMatchObject({ state: 'trading', forced: 1, max_allocation_usd: 50 });
      const back = h.ledger.forceRightsState('economics', 'short', 'auto', 'test done', HUMAN)!;
      expect(back).toMatchObject({ state: 'shadow', forced: false, maxAllocationUsd: 0 });
      expect(h.auditActions('category_rights.change').at(-1)).toMatchObject({ actor: 'human', payload: { from: 'trading', to: 'shadow', forced: false } });
      // Other buckets are untouched by the targeted evaluation
      expect(h.rightsRepo.get('politics-non-us', 'medium')).toMatchObject({ state: 'trading', forced: 1 });

      // With a qualifying record the rules promote it again straight away
      for (let i = 0; i < 30; i++) {
        h.forecastRepo.insertSuperseding({
          id: `q${i}`, marketId: `mk${i}`, tokenId: `tok${i}`, eventId: `ev${i}`, category: 'economics', probability: 0.7,
          marketPriceAtForecast: 0.5, bestBid: 0.49, bestAsk: 0.51, liquidityUsd: 1e4, rationale: 'r', sources: [],
          ambiguityScore: 0, tradeable: false, daysToResolution: 3, horizonBucket: 'short', createdBy: 'human',
          createdAt: new Date(T0 - 40 * DAY + i * DAY).toISOString(),
        });
        h.forecastRepo.setScore(`q${i}`, { outcome: i % 5 === 0 ? 0 : 1, brierAgent: 0, brierMarket: 0, skill: i % 5 === 0 ? -0.24 : 0.16, resolvedAt: new Date(T0 - 35 * DAY + i * DAY).toISOString() });
      }
      h.ledger.forceRightsState('economics', 'short', 'trading', 'again', HUMAN);
      expect(h.ledger.forceRightsState('economics', 'short', 'auto', 'rules', HUMAN)).toMatchObject({ state: 'trading', forced: false, maxAllocationUsd: 50 });
      // Un-forcing a forced shadow bucket hands it to the rules too (qualified ⇒ trading now)
      h.ledger.forceRightsState('economics', 'short', 'shadow', 'pause', HUMAN);
      expect(h.ledger.forceRightsState('economics', 'short', 'auto', 'resume', HUMAN)).toMatchObject({ state: 'trading', forced: false });
    });
  });

  describe('risk engine path for ledger-driven buys', () => {
    // Per-market cap above the bucket allocation so the bucket limit is what binds
    const engine = new RiskEngine({ limits: LimitsSchema.parse({ per_market: { max_exposure_usd: 100 } }), mandate: MandateSchema.parse({}) });

    function provider() {
      return new DbRiskStateProvider({
        botRepo: h.botRepo,
        orderRepo: h.orderRepo,
        tradeRepo: h.tradeRepo,
        riskStateRepo: h.riskStateRepo,
        simulated: false,
        getCashUsd: async () => 1000,
        getEndDate: async () => new Date(T0 + 5 * DAY).toISOString(),
        categoryRights: h.ledger,
        now: () => h.clock.now,
      });
    }

    function order(forecastId: string, probability: number, notionalUsd = 10): OrderRequest {
      return {
        botId: 'bot-1', exchange: 'polymarket', marketId: 'm1', tokenId: 'm1-yes', side: 'buy', orderType: 'limit',
        price: 0.5, size: notionalUsd / 0.5, notionalUsd, forecast: { forecastId, probability },
        market: {
          tokenId: 'm1-yes', category: 'economics', endDate: new Date(T0 + 5 * DAY).toISOString(), ambiguityScore: 0, rulesChangedAt: null,
          liquidityUsd: 10_000, bestBid: 0.49, bestAsk: 0.52, bestBidSizeUsd: 500, bestAskSizeUsd: 500, takerFeeRate: 0.05,
        },
      };
    }

    it('rejected in shadow, allowed in trading within the bucket allocation', async () => {
      const shadowF = await h.ledger.submitForecast(valid('m1-yes', { probability: 0.6 }), 'human');
      expect(await h.ledger.get(shadowF.id, 'm1-yes')).toBeNull(); // not tradeable ⇒ OrderService: forecast_unavailable
      const rejected = engine.check(order(shadowF.id, 0.6), await provider().getSnapshot(order(shadowF.id, 0.6)));
      expect(rejected).toMatchObject({ allowed: false, failedCheck: 'category_exposure' });
      expect(rejected.reason).toMatch(/shadow/);

      h.ledger.forceRightsState('economics', 'short', 'trading', 'test', HUMAN);
      // Live tradeable (ctx.ledger and orders): the shadow-era forecast is tradeable now; the stored flag is history
      expect(h.ledger.botForecast('m1-yes')).toMatchObject({ id: shadowF.id, tradeable: false, tradeableNow: true, bucketState: 'trading' });
      expect(await h.ledger.get(shadowF.id, 'm1-yes')).toEqual({ forecastId: shadowF.id, probability: 0.6 });
      h.clock.now += 6 * HOUR;
      const f = await h.ledger.submitForecast(valid('m1-yes', { probability: 0.6 }), 'human');
      expect(f.tradeable).toBe(true);
      expect(await h.ledger.get(f.id, 'm1-yes')).toEqual({ forecastId: f.id, probability: 0.6 });
      expect((await h.ledger.get(f.id, 'm1-no'))!.probability).toBeCloseTo(0.4); // complementary token
      expect(await h.ledger.get(f.id, 'other-token')).toBeNull();

      const ok = engine.check(order(f.id, 0.6), await provider().getSnapshot(order(f.id, 0.6)));
      expect(ok.allowed).toBe(true);

      // $45 already in the bucket from an earlier ledger-driven fill ⇒ a $10 buy exceeds the $50 allocation
      const prior = h.orderRepo.create({
        botId: 'bot-1', exchange: 'polymarket', marketId: 'm1', tokenId: 'm1-yes', side: 'buy', orderType: 'limit',
        price: 0.45, size: 100, notionalUsd: 45, status: 'filled', forecastId: f.id,
      });
      h.orderRepo.update(prior.id, { filledSize: 100 });
      h.tradeRepo.create({ botId: 'bot-1', exchange: 'polymarket', side: 'BUY', symbol: 'm1-yes', conditionId: 'm1', price: 0.45, quantity: 100, quoteAmount: 45, orderId: prior.id, simulated: 0 });
      const snap = await provider().getSnapshot(order(f.id, 0.6));
      expect(snap.categoryBucket).toEqual({ state: 'trading', exposureUsd: 45, maxAllocationUsd: 50 });
      expect(engine.check(order(f.id, 0.6), snap)).toMatchObject({ allowed: false, failedCheck: 'category_exposure' });
      expect(engine.check(order(f.id, 0.6, 5), await provider().getSnapshot(order(f.id, 0.6, 5))).allowed).toBe(true);

      // A non-ledger buy does not look at category rights
      const plain = { ...order(f.id, 0.6), forecast: null };
      expect((await provider().getSnapshot(plain)).categoryBucket).toBeNull();
    });
  });
});
