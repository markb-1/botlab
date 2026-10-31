import { describe, it, expect } from 'vitest';
import { LimitsSchema, MandateSchema, type BotLabConfig } from '../../packages/core/src/config';
import {
  RiskEngine,
  horizonBucket,
  daysToSettlement,
  type OrderRequest,
  type RiskStateSnapshot,
  type MarketSnapshot,
  type BotRiskInfo,
} from '../../packages/core/src/risk';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function makeConfig(limits: Record<string, unknown> = {}, mandate: Record<string, unknown> = {}): BotLabConfig {
  return { limits: LimitsSchema.parse(limits), mandate: MandateSchema.parse(mandate) };
}

type OrderOverrides = Partial<Omit<OrderRequest, 'market'>> & { market?: Partial<MarketSnapshot> | null };
type Position = NonNullable<RiskStateSnapshot['position']>;
type StateOverrides = Partial<Omit<RiskStateSnapshot, 'bot' | 'exposure' | 'position'>> & {
  bot?: Partial<BotRiskInfo> | null;
  position?: (Omit<Position, 'openSellSize'> & { openSellSize?: number }) | null;
  exposure?: Partial<RiskStateSnapshot['exposure']>;
};

/** A resting post-only buy that passes every check with the default config. */
function makeOrder(o: OrderOverrides = {}): OrderRequest {
  const { market, ...rest } = o;
  return {
    botId: 'bot-1',
    exchange: 'polymarket',
    marketId: 'm1',
    tokenId: 't1',
    side: 'buy',
    orderType: 'limit',
    price: 0.5,
    size: 20,
    notionalUsd: 10,
    riskExit: false,
    forecast: null,
    ...rest,
    market:
      market === null
        ? null
        : {
            tokenId: rest.tokenId ?? 't1',
            category: 'economics',
            endDate: iso(NOW + 10 * DAY),
            ambiguityScore: 1,
            rulesChangedAt: null,
            liquidityUsd: 10_000,
            bestBid: 0.49,
            bestAsk: 0.52,
            bestBidSizeUsd: 500,
            bestAskSizeUsd: 500,
            takerFeeRate: 0.02,
            ...market,
          },
  };
}

function makeState(s: StateOverrides = {}): RiskStateSnapshot {
  const { bot, exposure, position, ...rest } = s;
  return {
    now: NOW,
    globalHalted: false,
    equityUsd: 1000,
    categoryBucket: null,
    botOrdersLastHour: 0,
    openOrdersCount: 0,
    ...rest,
    position: position ? { openSellSize: 0, ...position } : null,
    bot:
      bot === null
        ? null
        : { id: 'bot-1', stage: 'full', allocationUsd: null, marketIds: ['m1'], halted: false, ...bot },
    exposure: { botUsd: 0, marketUsd: 0, totalUsd: 0, longHorizonUsd: 0, ...exposure },
  };
}

/** A sell of a position held long enough */
const sell = (o: OrderOverrides = {}): OrderOverrides => ({ side: 'sell', price: 0.49, size: 20, notionalUsd: 9.8, ...o });
const held = (s: StateOverrides = {}): StateOverrides => ({ position: { size: 100, openedAt: NOW - 60 * MIN }, ...s });
const daysOut = (d: number) => ({ endDate: iso(NOW + d * DAY) });

interface Case {
  name: string;
  order?: OrderOverrides;
  state?: StateOverrides;
  config?: BotLabConfig;
  /** Expected failing check, or null if the order should pass */
  fails: string | null;
}

const cases: Case[] = [
  { name: 'baseline buy passes', fails: null },

  // Step 0 — snapshot validation
  { name: 'negative bot exposure', state: { exposure: { botUsd: -50 } }, fails: 'state_invalid' },
  { name: 'negative market exposure', state: { exposure: { marketUsd: -1 } }, fails: 'state_invalid' },
  { name: 'NaN total exposure', state: { exposure: { totalUsd: NaN } }, fails: 'state_invalid' },
  { name: 'negative long-horizon exposure', state: { exposure: { longHorizonUsd: -1 } }, fails: 'state_invalid' },
  { name: 'negative orders-last-hour count', state: { botOrdersLastHour: -5 }, fails: 'state_invalid' },
  { name: 'negative open orders count', state: { openOrdersCount: -1 }, fails: 'state_invalid' },
  { name: 'infinite equity', state: { equityUsd: Infinity }, fails: 'state_invalid' },
  { name: 'unknown equity does not block a sell', order: sell(), state: held({ equityUsd: NaN }), fails: null },
  { name: 'unknown equity does not block a risk-exit sell', order: sell({ riskExit: true }), state: held({ equityUsd: NaN }), fails: null },
  { name: 'unknown equity blocks a buy', state: { equityUsd: NaN }, fails: 'state_invalid' },
  { name: 'negative taker fee rate', order: { market: { takerFeeRate: -0.5 } }, fails: 'state_invalid' },
  { name: 'negative best bid', order: { market: { bestBid: -0.1 } }, fails: 'state_invalid' },
  { name: 'negative position size', order: sell(), state: { position: { size: -10, openedAt: NOW - 60 * MIN } }, fails: 'state_invalid' },
  { name: 'negative open sell size', order: sell(), state: held({ position: { size: 100, openSellSize: -50, openedAt: NOW - 60 * MIN } }), fails: 'state_invalid' },
  { name: 'negative category bucket exposure', state: { categoryBucket: { state: 'trading', exposureUsd: -10, maxAllocationUsd: 50 } }, fails: 'state_invalid' },
  { name: 'market snapshot for a different token', order: { market: { tokenId: 't2' } }, fails: 'state_invalid' },
  { name: 'invalid state is rejected even before halts', state: { globalHalted: true, botOrdersLastHour: -1 }, fails: 'state_invalid' },

  // Step 1 — halts and stage
  { name: 'global halt', state: { globalHalted: true }, fails: 'global_halt' },
  { name: 'global halt takes precedence over bot halt', state: { globalHalted: true, bot: { halted: true } }, fails: 'global_halt' },
  { name: 'global halt blocks risk-exit sells too', order: sell({ riskExit: true }), state: held({ globalHalted: true }), fails: 'global_halt' },
  { name: 'bot halt', state: { bot: { halted: true } }, fails: 'bot_halt' },
  { name: 'bot halt takes precedence over stage', state: { bot: { halted: true, stage: 'paper' } }, fails: 'bot_halt' },
  { name: 'unknown bot', state: { bot: null }, fails: 'bot_halt' },
  { name: 'paper stage never reaches live checks', state: { bot: { stage: 'paper' } }, fails: 'bot_stage' },
  { name: 'retired stage', state: { bot: { stage: 'retired' } }, fails: 'bot_stage' },
  { name: 'retired stage: plain sell refused', order: sell(), state: held({ bot: { stage: 'retired' } }), fails: 'bot_stage' },
  { name: 'retired stage: risk-exit sell allowed (R160)', order: sell({ riskExit: true }), state: held({ bot: { stage: 'retired' } }), fails: null },
  { name: 'paper stage: risk-exit sell allowed (R160)', order: sell({ riskExit: true }), state: held({ bot: { stage: 'paper' } }), fails: null },
  { name: 'retired stage: risk-exit sell still bound by the held position', order: sell({ riskExit: true, size: 1e6, notionalUsd: 5e5 }), state: held({ bot: { stage: 'retired' } }), fails: 'sell_position' },
  { name: 'forecast-strategy bot buy without forecast', state: { bot: { strategy: 'forecast' } }, fails: 'forecast_required' },
  { name: 'forecast-strategy bot may sell without forecast', order: sell(), state: held({ bot: { strategy: 'forecast' } }), fails: null },
  { name: 'probation stage allowed', state: { bot: { stage: 'probation' } }, fails: null },

  // Step 2 — market allowed
  { name: 'polymarket order without market metadata', order: { market: null }, fails: 'market_data' },
  { name: 'market outside bot scope', order: { marketId: 'm2' }, fails: 'market_scope' },
  { name: 'unscoped bot can trade any market', order: { marketId: 'm2' }, state: { bot: { marketIds: null } }, fails: null },
  { name: 'empty market scope allows nothing', state: { bot: { marketIds: [] } }, fails: 'market_scope' },
  { name: 'denied category', order: { market: { category: 'sports' } }, fails: 'category' },
  { name: '"later" category is not tradeable', order: { market: { category: 'geopolitics' } }, fails: 'category' },
  { name: 'unknown category', order: { market: { category: null } }, fails: 'category' },
  { name: 'sell in a denied category still allowed (exit)', order: sell({ market: { category: 'sports' } }), state: held(), fails: null },
  { name: 'end buffer: 59 min to end', order: { market: { endDate: iso(NOW + 59 * MIN) } }, fails: 'end_buffer' },
  { name: 'end buffer: exactly 60 min to end passes', order: { market: { endDate: iso(NOW + 60 * MIN) } }, fails: null },
  { name: 'end buffer applies to normal sells', order: sell({ market: { endDate: iso(NOW + 30 * MIN) } }), state: held(), fails: 'end_buffer' },
  { name: 'end buffer exempts risk-exit sells', order: sell({ riskExit: true, market: { endDate: iso(NOW + 30 * MIN) } }), state: held(), fails: null },
  { name: 'unknown end date blocks buys', order: { market: { endDate: null } }, fails: 'end_buffer' },
  { name: 'ambiguity above mandate max', order: { market: { ambiguityScore: 2 } }, fails: 'ambiguity' },
  { name: 'ambiguity at mandate max passes', order: { market: { ambiguityScore: 1 } }, fails: null },
  { name: 'unrated ambiguity', order: { market: { ambiguityScore: null } }, fails: 'ambiguity' },
  { name: 'sell allowed on an ambiguous market', order: sell({ market: { ambiguityScore: 3 } }), state: held(), fails: null },
  { name: 'rules changed 23h ago blocks buys', order: { market: { rulesChangedAt: iso(NOW - 23 * 60 * MIN) } }, fails: 'rules_changed' },
  { name: 'rules changed 25h ago passes', order: { market: { rulesChangedAt: iso(NOW - 25 * 60 * MIN) } }, fails: null },
  { name: 'rules changed does not block sells', order: sell({ market: { rulesChangedAt: iso(NOW - MIN) } }), state: held(), fails: null },
  { name: 'liquidity below minimum', order: { market: { liquidityUsd: 4999 } }, fails: 'liquidity' },
  { name: 'liquidity exactly at minimum passes', order: { market: { liquidityUsd: 5000 } }, fails: null },
  { name: 'binance disabled', order: { exchange: 'binance', marketId: 'BTCUSDT', tokenId: 'BTCUSDT', market: null, price: 60000, size: 0.0001, notionalUsd: 6 }, state: { bot: { marketIds: null } }, config: makeConfig({ binance: { enabled: false } }), fails: 'exchange_enabled' },

  // Step 3 — order shape
  { name: 'notional exactly at max_order_usd passes', order: { size: 50, notionalUsd: 25 }, fails: null },
  { name: 'notional above max_order_usd', order: { size: 50.02, notionalUsd: 25.01 }, fails: 'max_order' },
  { name: 'zero size', order: { size: 0 }, fails: 'order_input' },
  { name: 'NaN price', order: { price: NaN }, fails: 'order_input' },
  { name: 'understated notional on a limit order', order: { size: 40, notionalUsd: 10 }, fails: 'order_input' },
  { name: 'understated notional on a market order', order: { orderType: 'market', price: 0.52, size: 10_000, notionalUsd: 1 }, fails: 'order_input' },
  { name: 'market order with consistent notional passes', order: { orderType: 'market', price: 0.52, size: 20, notionalUsd: 10.4 }, fails: null },
  { name: 'price above 0.99', order: { price: 0.995, size: 10, notionalUsd: 9.95, market: { bestAsk: 0.999, bestBid: 0.99 } }, fails: 'price_range' },
  { name: 'price below 0.01', order: { price: 0.005, size: 100, notionalUsd: 0.5 }, fails: 'price_range' },
  { name: 'spread exactly at max passes', order: { price: 0.46, size: 20, notionalUsd: 9.2, market: { bestBid: 0.46, bestAsk: 0.52 } }, fails: null },
  { name: 'spread above max', order: { market: { bestBid: 0.45, bestAsk: 0.52 } }, fails: 'spread' },
  { name: 'missing best bid', order: { market: { bestBid: null } }, fails: 'spread' },
  { name: 'crossed book (bid > ask)', order: { price: 0.5, market: { bestBid: 0.53, bestAsk: 0.52 } }, fails: 'spread' },
  { name: 'marketable buy at best ask passes', order: { price: 0.52, size: 20, notionalUsd: 10.4 }, fails: null },
  { name: 'marketable buy slippage exactly at max passes', order: { price: 0.54, size: 20, notionalUsd: 10.8 }, fails: null },
  { name: 'marketable buy slippage above max', order: { price: 0.55, size: 20, notionalUsd: 11 }, fails: 'slippage' },
  { name: 'marketable sell slippage above max', order: sell({ price: 0.46, notionalUsd: 9.2 }), state: held(), fails: 'slippage' },
  { name: 'market order type is checked as marketable', order: { orderType: 'market', price: 0.6, notionalUsd: 12 }, fails: 'slippage' },
  { name: 'marketable disabled', order: { price: 0.52, notionalUsd: 10.4 }, config: makeConfig({ orders: { allow_marketable: false } }), fails: 'marketable_allowed' },
  { name: 'top of book below minimum when taking', order: { price: 0.52, notionalUsd: 10.4, market: { bestAskSizeUsd: 199 } }, fails: 'top_of_book' },
  { name: 'top of book exactly at minimum passes', order: { price: 0.52, notionalUsd: 10.4, market: { bestAskSizeUsd: 200 } }, fails: null },
  { name: 'top of book ignored for resting orders', order: { market: { bestAskSizeUsd: 1 } }, fails: null },

  // Step 4 — rate
  { name: 'orders last hour just below max passes', state: { botOrdersLastHour: 19 }, fails: null },
  { name: 'orders last hour at max', state: { botOrdersLastHour: 20 }, fails: 'bot_rate' },
  { name: 'open orders just below max passes', state: { openOrdersCount: 49 }, fails: null },
  { name: 'open orders at max', state: { openOrdersCount: 50 }, fails: 'open_orders' },

  // Step 5 — exposure
  { name: 'bot exposure exactly at allocation passes', state: { exposure: { botUsd: 90 } }, fails: null },
  { name: 'bot exposure above allocation', state: { exposure: { botUsd: 90.01 } }, fails: 'bot_exposure' },
  { name: 'probation allocation exactly at limit passes', state: { bot: { stage: 'probation' }, exposure: { botUsd: 10 } }, fails: null },
  { name: 'probation allocation exceeded', state: { bot: { stage: 'probation' }, exposure: { botUsd: 10.01 } }, fails: 'bot_exposure' },
  { name: 'new-template probation uses the smaller allocation', state: { bot: { stage: 'probation', newTemplate: true }, exposure: { botUsd: 0.01 } }, fails: 'bot_exposure' },
  { name: 'per-bot allocation override lowers the cap', state: { bot: { allocationUsd: 15 }, exposure: { botUsd: 5.01 } }, fails: 'bot_exposure' },
  { name: 'per-bot allocation override cannot raise the cap', state: { bot: { allocationUsd: 500 }, exposure: { botUsd: 95 } }, fails: 'bot_exposure' },
  { name: 'market exposure exactly at limit passes', state: { exposure: { marketUsd: 40 } }, fails: null },
  { name: 'market exposure above limit', state: { exposure: { marketUsd: 40.01 } }, fails: 'market_exposure' },
  { name: 'total exposure exactly at usd limit passes', state: { exposure: { totalUsd: 290 } }, fails: null },
  { name: 'total exposure above usd limit', state: { exposure: { totalUsd: 290.01 } }, fails: 'total_exposure' },
  { name: 'total exposure limited by pct of equity', state: { equityUsd: 100, exposure: { totalUsd: 50.01 } }, fails: 'total_exposure' },
  { name: 'total exposure exactly at pct of equity passes', state: { equityUsd: 100, exposure: { totalUsd: 50 } }, fails: null },
  { name: 'zero equity blocks buys', state: { equityUsd: 0 }, fails: 'total_exposure' },
  { name: 'settles in 91 days rejected', order: { market: daysOut(91) }, fails: 'horizon' },
  { name: 'long horizon (60d) within budget passes', order: { market: daysOut(60) }, state: { exposure: { longHorizonUsd: 65 } }, fails: null },
  { name: 'long horizon budget exceeded', order: { market: daysOut(60) }, state: { exposure: { longHorizonUsd: 65.01 } }, fails: 'long_horizon' },
  { name: 'long horizon budget scales with equity limit', order: { market: daysOut(60) }, state: { equityUsd: 100, exposure: { longHorizonUsd: 5.01 } }, fails: 'long_horizon' },
  { name: 'exactly 30 days is the default horizon (no long-horizon cap)', order: { market: daysOut(30) }, state: { exposure: { longHorizonUsd: 75 } }, fails: null },
  { name: 'outside a narrower mandate horizon', order: { market: daysOut(20) }, config: makeConfig({}, { markets: { resolves_within_days: [0, 14], long_horizon_days: [30, 60] } }), fails: 'horizon' },
  { name: 'beyond the mandate long horizon', order: { market: daysOut(70) }, config: makeConfig({}, { markets: { resolves_within_days: [0, 14], long_horizon_days: [30, 60] } }), fails: 'horizon' },
  { name: 'below the mandate minimum days', order: { market: daysOut(1) }, config: makeConfig({}, { markets: { resolves_within_days: [2, 30] } }), fails: 'horizon' },
  { name: 'ledger-driven order without category rights', order: { forecast: { forecastId: 'f1', probability: 0.7 } }, fails: 'category_exposure' },
  { name: 'ledger-driven order in a shadow bucket', order: { forecast: { forecastId: 'f1', probability: 0.7 } }, state: { categoryBucket: { state: 'shadow', exposureUsd: 0, maxAllocationUsd: 50 } }, fails: 'category_exposure' },
  { name: 'ledger-driven bucket exactly at limit passes', order: { forecast: { forecastId: 'f1', probability: 0.7 } }, state: { categoryBucket: { state: 'trading', exposureUsd: 40, maxAllocationUsd: 50 } }, fails: null },
  { name: 'ledger-driven bucket exceeded', order: { forecast: { forecastId: 'f1', probability: 0.7 } }, state: { categoryBucket: { state: 'trading', exposureUsd: 40.01, maxAllocationUsd: 50 } }, fails: 'category_exposure' },
  {
    name: 'sell that reduces exposure bypasses every exposure limit',
    order: sell(),
    state: held({ equityUsd: 0, exposure: { botUsd: 1000, marketUsd: 1000, totalUsd: 1000, longHorizonUsd: 1000 } }),
    fails: null,
  },
  { name: 'sell of more than held', order: sell(), state: held({ position: { size: 19.99, openedAt: NOW - 60 * MIN } }), fails: 'sell_position' },
  { name: 'sell with no position', order: sell(), fails: 'sell_position' },
  { name: 'resting sells reduce what can be sold', order: sell(), state: held({ position: { size: 100, openSellSize: 85, openedAt: NOW - 60 * MIN } }), fails: 'sell_position' },
  { name: 'sell exactly at position net of resting sells passes', order: sell(), state: held({ position: { size: 100, openSellSize: 80, openedAt: NOW - 60 * MIN } }), fails: null },
  { name: '31 days counts toward the long-horizon cap', order: { market: daysOut(31) }, state: { exposure: { longHorizonUsd: 65.01 } }, fails: 'long_horizon' },

  // Risk exits: exempt from max_order, rate limits and spread; still scoped, position-bound, price-ranged, slippage-checked
  { name: 'risk exit exempt from max_order_usd', order: sell({ riskExit: true, size: 61, notionalUsd: 29.89 }), state: held(), fails: null },
  { name: 'risk exit exempt from max_orders_per_hour', order: sell({ riskExit: true }), state: held({ botOrdersLastHour: 20 }), fails: null },
  { name: 'risk exit exempt from max_open_orders', order: sell({ riskExit: true }), state: held({ openOrdersCount: 50 }), fails: null },
  { name: 'risk exit exempt from max_spread', order: sell({ riskExit: true, price: 0.3, notionalUsd: 6, market: { bestBid: 0.3, bestAsk: 0.5 } }), state: held(), fails: null },
  { name: 'risk exit still needs market scope', order: sell({ riskExit: true, marketId: 'm2' }), state: held(), fails: 'market_scope' },
  { name: 'risk exit still needs a held position', order: sell({ riskExit: true }), state: held({ position: { size: 100, openSellSize: 90, openedAt: NOW } }), fails: 'sell_position' },
  { name: 'risk exit still needs price range', order: sell({ riskExit: true, price: 0.005, size: 20, notionalUsd: 0.1 }), state: held(), fails: 'price_range' },
  { name: 'risk exit still needs slippage when marketable', order: sell({ riskExit: true, price: 0.4, notionalUsd: 8 }), state: held(), fails: 'slippage' },
  { name: 'riskExit flag on a buy grants no exemption', order: { riskExit: true, size: 52, notionalUsd: 26 }, fails: 'max_order' },
  { name: 'non-risk-exit sell above max_order_usd', order: sell({ size: 61, notionalUsd: 29.89 }), state: held(), fails: 'max_order' },

  // Step 6 — hold time
  { name: 'sell before min hold time', order: sell(), state: { position: { size: 100, openedAt: NOW - 29 * MIN } }, fails: 'hold_time' },
  { name: 'sell exactly at min hold time passes', order: sell(), state: { position: { size: 100, openedAt: NOW - 30 * MIN } }, fails: null },
  { name: 'risk-exit sell bypasses hold time', order: sell({ riskExit: true }), state: { position: { size: 100, openedAt: NOW - MIN } }, fails: null },

  // Step 7 — edge
  ...(() => {
    const rights: StateOverrides = { categoryBucket: { state: 'trading', exposureUsd: 0, maxAllocationUsd: 50 } };
    return [
      { name: 'edge comfortably above floor', order: { forecast: { forecastId: 'f', probability: 0.6 } }, state: rights, fails: null },
      { name: 'edge exactly at the 0.03 floor passes', order: { forecast: { forecastId: 'f', probability: 0.53 } }, state: rights, fails: null },
      { name: 'edge below the 0.03 floor', order: { forecast: { forecastId: 'f', probability: 0.529 } }, state: rights, fails: 'edge' },
      { name: 'template min_edge below floor is raised to 0.03', order: { forecast: { forecastId: 'f', probability: 0.52, minEdge: 0.01 } }, state: rights, fails: 'edge' },
      { name: 'template min_edge above floor applies', order: { forecast: { forecastId: 'f', probability: 0.57, minEdge: 0.08 } }, state: rights, fails: 'edge' },
      { name: 'taker fee counts against marketable orders', order: { price: 0.52, notionalUsd: 10.4, forecast: { forecastId: 'f', probability: 0.56 } }, state: rights, fails: 'edge' },
      { name: "Polymarket fee formula (rate × p × (1 − p)) leaves the same order above the floor", order: { price: 0.52, notionalUsd: 10.4, market: { takerFeeFormula: 'price' }, forecast: { forecastId: 'f', probability: 0.56 } }, state: rights, fails: null },
      { name: 'buying above the forecast is negative edge', order: { forecast: { forecastId: 'f', probability: 0.4 } }, state: rights, fails: 'edge' },
      { name: 'ledger-driven sell needs price above forecast', order: sell({ price: 0.5, notionalUsd: 10, forecast: { forecastId: 'f', probability: 0.45 } }), state: held(), fails: null },
    ] as Case[];
  })(),
];

describe('RiskEngine — table-driven checks', () => {
  it.each(cases)('$name', ({ order, state, config, fails }) => {
    const engine = new RiskEngine(config ?? makeConfig());
    const decision = engine.check(makeOrder(order), makeState(state));
    if (fails === null) {
      expect(decision.reason).toBeUndefined();
      expect(decision.allowed).toBe(true);
    } else {
      expect(decision.allowed).toBe(false);
      expect(decision.failedCheck).toBe(fails);
    }
  });
});

describe('RiskEngine — decision shape', () => {
  const engine = new RiskEngine(makeConfig());

  it('records every check that ran when allowed', () => {
    const d = engine.check(makeOrder(), makeState());
    expect(d.allowed).toBe(true);
    expect(d.failedCheck).toBeUndefined();
    expect(d.evaluatedAt).toBe(iso(NOW));
    expect(d.checks.every((c) => c.passed)).toBe(true);
    const names = d.checks.map((c) => c.name);
    expect(names).toEqual([
      'state_invalid', 'global_halt', 'bot_halt', 'bot_stage', 'market_data', 'market_scope', 'category', 'end_buffer',
      'ambiguity', 'rules_changed', 'liquidity', 'order_input', 'max_order', 'price_range', 'spread',
      'bot_rate', 'open_orders', 'horizon', 'bot_exposure', 'market_exposure', 'total_exposure',
    ]);
    // Steps are non-decreasing (spec order)
    const steps = d.checks.map((c) => c.step);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it('stops at the first failure and reports it', () => {
    const d = engine.check(makeOrder(), makeState({ botOrdersLastHour: 20, exposure: { botUsd: 1000 } }));
    expect(d.failedCheck).toBe('bot_rate');
    expect(d.checks[d.checks.length - 1]).toMatchObject({ name: 'bot_rate', passed: false, step: 4 });
    expect(d.checks.some((c) => c.name === 'bot_exposure')).toBe(false);
    expect(d.reason).toContain('20');
  });

  it('is JSON-serialisable for orders.risk_decision', () => {
    const d = engine.check(makeOrder(), makeState({ globalHalted: true, globalHaltReason: 'kill switch' }));
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    expect(d.reason).toContain('kill switch');
  });

  it('evaluate() pulls state from a provider', async () => {
    const d = await engine.evaluate(makeOrder(), { getSnapshot: async () => makeState({ globalHalted: true }) });
    expect(d.failedCheck).toBe('global_halt');
  });
});

describe('RiskEngine — Binance', () => {
  const binanceOrder = (notionalUsd: number): OrderOverrides => ({
    exchange: 'binance', marketId: 'BTCUSDT', tokenId: 'BTCUSDT', market: null,
    price: 60_000, size: notionalUsd / 60_000, notionalUsd,
  });
  const engine = new RiskEngine(makeConfig({ binance: { max_order_usd: 20, allocation_usd: 50 } }));
  const unscoped: StateOverrides = { bot: { marketIds: null } };

  it('skips Polymarket market checks', () => {
    const d = engine.check(makeOrder(binanceOrder(10)), makeState(unscoped));
    expect(d.allowed).toBe(true);
    expect(d.checks.map((c) => c.name)).not.toContain('price_range');
  });

  it('uses binance.max_order_usd', () => {
    expect(engine.check(makeOrder(binanceOrder(20.01)), makeState(unscoped)).failedCheck).toBe('max_order');
  });

  it('caps bot allocation at binance.allocation_usd', () => {
    const d = engine.check(makeOrder(binanceOrder(10)), makeState({ ...unscoped, exposure: { botUsd: 40.01 } }));
    expect(d.failedCheck).toBe('bot_exposure');
  });
});

describe('RiskEngine — helpers', () => {
  it('effectiveAllocation by stage', () => {
    const engine = new RiskEngine(makeConfig());
    const bot: BotRiskInfo = { id: 'b', stage: 'full', allocationUsd: null, marketIds: null, halted: false };
    expect(engine.effectiveAllocation(bot, 'polymarket')).toBe(100);
    expect(engine.effectiveAllocation({ ...bot, stage: 'probation' }, 'polymarket')).toBe(20);
    expect(engine.effectiveAllocation({ ...bot, stage: 'probation', newTemplate: true }, 'polymarket')).toBe(10);
    expect(engine.effectiveAllocation({ ...bot, stage: 'paper' }, 'polymarket')).toBe(0);
    expect(engine.effectiveAllocation({ ...bot, stage: 'retired' }, 'polymarket')).toBe(0);
  });

  it('horizon buckets', () => {
    expect(horizonBucket(0.5)).toBe('short');
    expect(horizonBucket(7)).toBe('short');
    expect(horizonBucket(7.1)).toBe('medium');
    expect(horizonBucket(30)).toBe('medium');
    expect(horizonBucket(31)).toBe('long');
  });

  it('daysToSettlement handles unknown dates', () => {
    expect(daysToSettlement(null, NOW)).toBeNull();
    expect(daysToSettlement('not a date', NOW)).toBeNull();
    expect(daysToSettlement(iso(NOW + 2 * DAY), NOW)).toBe(2);
  });
});
