import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { LimitsSchema, MandateSchema, type BotLabConfig } from '../../packages/core/src/config';
import {
  RiskEngine,
  horizonBucket,
  isLongHorizon,
  type BotStage,
  type OrderRequest,
  type RiskStateSnapshot,
} from '../../packages/core/src/risk';

/**
 * Property: whatever sequence of orders bots send, applying only the orders the
 * engine allows never pushes any exposure above its configured limit (spec §14).
 *
 * Simulation: every allowed buy fills immediately at its price (exposure += notional),
 * every allowed sell reduces the position at cost basis. Equity is fixed per run.
 */

const START = Date.parse('2026-06-01T00:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;
const EPS = 1e-6;

const BOTS: Array<{ id: string; stage: BotStage; newTemplate?: boolean }> = [
  { id: 'b-full', stage: 'full' },
  { id: 'b-prob', stage: 'probation' },
  { id: 'b-new', stage: 'probation', newTemplate: true },
];
const MARKETS = [
  { id: 'm-short', days: 3, category: 'weather-climate' },
  { id: 'm-medium', days: 20, category: 'economics' },
  { id: 'm-long', days: 45, category: 'economics' },
  { id: 'm-longer', days: 80, category: 'politics-non-us' },
  { id: 'm-too-long', days: 120, category: 'economics' },
];
const BUCKET_MAX = 40;

const orderArb = fc.record({
  bot: fc.integer({ min: 0, max: BOTS.length - 1 }),
  market: fc.integer({ min: 0, max: MARKETS.length - 1 }),
  side: fc.constantFrom('buy' as const, 'sell' as const),
  notional: fc.double({ min: 0.5, max: 30, noNaN: true }),
  price: fc.constantFrom(0.3, 0.5, 0.7),
  ledger: fc.boolean(),
  riskExit: fc.boolean(),
  advanceMinutes: fc.integer({ min: 0, max: 20 }),
});

const configArb = fc.record({
  maxTotal: fc.integer({ min: 50, max: 400 }),
  pct: fc.double({ min: 0.1, max: 1, noNaN: true }),
  longPct: fc.double({ min: 0, max: 0.5, noNaN: true }),
  maxMarket: fc.integer({ min: 10, max: 80 }),
  equity: fc.integer({ min: 0, max: 1000 }),
});

describe('RiskEngine — property: limits are never exceeded', () => {
  it('random order sequences keep every exposure within its limit', () => {
    let allowedBuys = 0;
    let allowedSells = 0;
    fc.assert(
      fc.property(configArb, fc.array(orderArb, { minLength: 1, maxLength: 150 }), (cfg, orders) => {
        const config: BotLabConfig = {
          limits: LimitsSchema.parse({
            global: {
              max_total_exposure_usd: cfg.maxTotal,
              max_total_exposure_pct: cfg.pct,
              max_long_horizon_pct: cfg.longPct,
              max_open_orders: 1000,
            },
            per_bot_defaults: { max_orders_per_hour: 1000 },
            per_market: { max_exposure_usd: cfg.maxMarket, max_spread: 1, min_liquidity_usd: 0 },
          }),
          mandate: MandateSchema.parse({ markets: { min_liquidity_usd: 0 } }),
        };
        const engine = new RiskEngine(config);
        const { limits } = config;

        // position cost (USD) and shares per bot+market
        const cost = new Map<string, number>();
        const shares = new Map<string, number>();
        const openedAt = new Map<string, number>();
        const key = (b: string, m: string) => `${b}|${m}`;
        let now = START;

        const sum = (pred: (botId: string, marketId: string) => boolean) => {
          let total = 0;
          for (const [k, v] of cost) {
            const [b, m] = k.split('|');
            if (pred(b, m)) total += v;
          }
          return total;
        };
        const marketById = (id: string) => MARKETS.find((m) => m.id === id)!;
        const bucketOf = (m: (typeof MARKETS)[number]) => `${m.category}|${horizonBucket(m.days)}`;

        for (const o of orders) {
          now += o.advanceMinutes * MIN;
          const bot = BOTS[o.bot];
          const mkt = MARKETS[o.market];
          const k = key(bot.id, mkt.id);
          const size = o.notional / o.price;

          const order: OrderRequest = {
            botId: bot.id,
            exchange: 'polymarket',
            marketId: mkt.id,
            tokenId: mkt.id,
            side: o.side,
            orderType: 'limit',
            price: o.price,
            size,
            notionalUsd: o.notional,
            riskExit: o.riskExit,
            forecast: o.ledger ? { forecastId: 'f', probability: o.side === 'buy' ? 0.95 : 0.05 } : null,
            market: {
              tokenId: mkt.id,
              category: mkt.category,
              endDate: new Date(START + mkt.days * DAY).toISOString(),
              ambiguityScore: 0,
              rulesChangedAt: null,
              liquidityUsd: 1e6,
              bestBid: o.price - 0.01,
              bestAsk: o.price + 0.01,
              bestBidSizeUsd: 1e6,
              bestAskSizeUsd: 1e6,
              takerFeeRate: 0,
            },
          };

          const daysLeft = (m: (typeof MARKETS)[number]) => (START + m.days * DAY - now) / DAY;
          const state: RiskStateSnapshot = {
            now,
            globalHalted: false,
            bot: { id: bot.id, stage: bot.stage, newTemplate: bot.newTemplate, allocationUsd: null, marketIds: null, halted: false },
            equityUsd: cfg.equity,
            exposure: {
              botUsd: sum((b) => b === bot.id),
              marketUsd: sum((_b, m) => m === mkt.id),
              totalUsd: sum(() => true),
              longHorizonUsd: sum((_b, m) => isLongHorizon(daysLeft(marketById(m)))),
            },
            categoryBucket: {
              state: 'trading',
              exposureUsd: sum((_b, m) => bucketOf(marketById(m)) === bucketOf(mkt)),
              maxAllocationUsd: BUCKET_MAX,
            },
            botOrdersLastHour: 0,
            openOrdersCount: 0,
            position: shares.has(k) ? { size: shares.get(k)!, openSellSize: 0, openedAt: openedAt.get(k)! } : null,
          };

          const decision = engine.check(order, state);
          if (!decision.allowed) continue;

          if (o.side === 'buy') {
            allowedBuys++;
            cost.set(k, (cost.get(k) ?? 0) + o.notional);
            shares.set(k, (shares.get(k) ?? 0) + size);
            if (!openedAt.has(k)) openedAt.set(k, now);
          } else {
            allowedSells++;
            const held = shares.get(k)!;
            const remaining = Math.max(held - size, 0);
            cost.set(k, (cost.get(k) ?? 0) * (remaining / held));
            shares.set(k, remaining);
          }

          // Invariants
          const totalLimit = Math.min(limits.global.max_total_exposure_usd, limits.global.max_total_exposure_pct * cfg.equity);
          expect(sum(() => true)).toBeLessThanOrEqual(totalLimit + EPS);
          expect(sum((_b, m) => isLongHorizon(daysLeft(marketById(m))))).toBeLessThanOrEqual(
            limits.global.max_long_horizon_pct * totalLimit + EPS
          );
          for (const b of BOTS) {
            const alloc = engine.effectiveAllocation({ ...b, allocationUsd: null, marketIds: null, halted: false }, 'polymarket');
            expect(sum((id) => id === b.id)).toBeLessThanOrEqual(alloc + EPS);
          }
          for (const m of MARKETS) {
            expect(sum((_b, id) => id === m.id)).toBeLessThanOrEqual(limits.per_market.max_exposure_usd + EPS);
          }
          // Nothing beyond 90 days is ever bought
          expect(cost.get(key(bot.id, 'm-too-long')) ?? 0).toBe(0);
          for (const n of shares.values()) expect(n).toBeGreaterThanOrEqual(-EPS);
        }
      }),
      { numRuns: 300 }
    );
    // Guard against a vacuous pass where the engine rejects everything
    expect(allowedBuys).toBeGreaterThan(50);
    expect(allowedSells).toBeGreaterThan(0);
  });
});
