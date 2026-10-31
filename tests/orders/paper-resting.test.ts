/**
 * Paper resting-order simulation (R12 amended in 5a): a resting paper limit order fills only when a later
 * book read crosses it, at its own price (maker, fee 0), up to the size shown; expires at its TTL; a cross
 * first seen after the expiry never fills it (no look-ahead).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../packages/core/src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { sqliteAvailable, openTestDb, type TestDb } from './db';
import { LimitsSchema, MandateSchema } from '../../packages/core/src/config';
import { RiskEngine } from '../../packages/core/src/risk/RiskEngine';
import { FeeService } from '../../packages/core/src/orders/FeeService';
import { DbRiskStateProvider } from '../../packages/core/src/orders/DbRiskStateProvider';
import { OrderService, type ClobBook } from '../../packages/core/src/orders/OrderService';
import type { MarketInfo, MarketQualityProvider } from '../../packages/core/src/orders/MarketDataService';
import { PaperTradingState } from '../../packages/core/src/runtime/PaperTradingState';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const DAY = 86_400_000;
const MIN = 60_000;

const ASSESSED: MarketQualityProvider = { get: async () => ({ category: 'economics', ambiguityScore: 0, rulesChangedAt: null }) };
const MARKET: MarketInfo = {
  marketId: 'm1',
  question: 'Will CPI exceed 3%?',
  outcome: 'Yes',
  tokenIds: ['t1', 't2'],
  endDate: new Date(NOW + 10 * DAY).toISOString(),
  volume24hrUsd: 10_000,
  labels: ['Economics'],
  closed: false,
  feeSchedule: null,
};

const book = (bid: number, ask: number, size = 1000): ClobBook => ({
  bids: [{ price: String(bid), size: String(size) }],
  asks: [{ price: String(ask), size: String(size) }],
  tick_size: '0.01',
});

describe.skipIf(!sqliteAvailable)('paper resting orders', () => {
  let t: TestDb;
  let clock = NOW;
  let current: ClobBook;
  let ps: PaperTradingState;
  let svc: OrderService;
  const engine = new RiskEngine({ limits: LimitsSchema.parse({}), mandate: MandateSchema.parse({}) });

  beforeEach(() => {
    t = openTestDb();
    clock = NOW;
    current = book(0.49, 0.51);
    t.addBot('pb', { stage: 'paper' });
    ps = new PaperTradingState('pb', 1000, t.storageRepo);
    const provider = new DbRiskStateProvider({
      botRepo: t.botRepo,
      orderRepo: t.orderRepo,
      tradeRepo: t.tradeRepo,
      riskStateRepo: t.riskStateRepo,
      simulated: true,
      getCashUsd: async () => ps.getBalance(),
      getEndDate: async () => MARKET.endDate,
      now: () => clock,
    });
    svc = new OrderService(
      {
        db: t.db,
        orderRepo: t.orderRepo,
        tradeRepo: t.tradeRepo,
        riskEngine: engine,
        provider,
        fees: new FeeService(),
        marketData: { getMarketInfo: async (tokenId: string) => (MARKET.tokenIds.includes(tokenId) ? MARKET : null) },
        quality: ASSESSED,
        getBook: async () => current,
        getBinanceBook: async () => ({ bids: [], asks: [] }),
        now: () => clock,
      },
      { botId: 'pb', botName: 'pb', scriptName: 'script', mode: 'paper', paperState: ps }
    );
  });

  afterEach(() => t.close());

  it('rests, does not fill while the book stays away, then fills at its own price when the ask crosses', async () => {
    const r = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20, ttlMinutes: 10 });
    expect(r).toMatchObject({ ok: true, status: 'open', filledSize: 0 });

    clock += MIN;
    current = book(0.44, 0.46); // ask above our bid: no fill
    expect(await svc.getOpenOrders()).toHaveLength(1);
    expect(ps.getBalance()).toBe(1000);

    clock += MIN;
    current = book(0.4, 0.43); // ask through our bid: fill at 0.45 (our price, not 0.43)
    expect(await svc.getOpenOrders()).toHaveLength(0);
    const row = t.orderRepo.findById(r.orderId!)!;
    expect(row).toMatchObject({ status: 'filled', filled_size: 20, avg_fill_price: 0.45, fee_usd: 0 });
    expect(ps.getBalance()).toBeCloseTo(1000 - 9);
    const pos = t.tradeRepo.getRiskPositions({ simulated: true, botId: 'pb' });
    expect(pos[0]).toMatchObject({ symbol: 't1', net_quantity: 20 });
    expect(pos[0].cost_basis).toBeCloseTo(9);
  });

  it('fills partially up to the size shown at or through its price', async () => {
    const r = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20, ttlMinutes: 10 });
    clock += MIN;
    current = { bids: [{ price: '0.4', size: '100' }], asks: [{ price: '0.45', size: '5' }, { price: '0.47', size: '100' }], tick_size: '0.01' };
    await svc.getOpenOrders();
    expect(t.orderRepo.findById(r.orderId!)).toMatchObject({ status: 'partially_filled', filled_size: 5 });
    clock += MIN;
    await svc.getOpenOrders(); // same book again: 5 more
    expect(t.orderRepo.findById(r.orderId!)).toMatchObject({ filled_size: 10 });
  });

  it('two resting orders cannot fill against the same liquidity within one sync', async () => {
    const a = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20, ttlMinutes: 10 });
    const b = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20, ttlMinutes: 10 });
    clock += MIN;
    current = { bids: [{ price: '0.4', size: '100' }], asks: [{ price: '0.44', size: '25' }, { price: '0.6', size: '100' }], tick_size: '0.01' };
    await svc.getOpenOrders();
    const filled = t.orderRepo.findById(a.orderId!)!.filled_size + t.orderRepo.findById(b.orderId!)!.filled_size;
    expect(filled).toBeCloseTo(25); // 25 shown, not 40
    expect(current.asks[0].size).toBe('25'); // the fetched book itself is not modified
  });

  it('expires at its TTL; a cross first seen after the expiry never fills it (no look-ahead)', async () => {
    const r = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20, ttlMinutes: 5 });
    clock += 5 * MIN;
    current = book(0.4, 0.43);
    expect(await svc.getOpenOrders()).toHaveLength(0);
    expect(t.orderRepo.findById(r.orderId!)).toMatchObject({ status: 'expired', filled_size: 0 });
    expect(ps.getBalance()).toBe(1000);
    expect(t.tradeRepo.getRiskPositions({ simulated: true })).toHaveLength(0);
  });

  it('a resting sell fills when the bid crosses it and never sells more than held', async () => {
    current = book(0.49, 0.5);
    expect((await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 10 })).status).toBe('filled'); // 20 shares
    // More than held is rejected by the engine (sell_position)
    expect(await svc.placeLimit({ tokenId: 't1', side: 'sell', price: 0.55, size: 25, riskExit: true })).toMatchObject({ failedCheck: 'sell_position' });
    const r = await svc.placeLimit({ tokenId: 't1', side: 'sell', price: 0.55, size: 20, riskExit: true });
    expect(r.status).toBe('open');
    // A second sell would exceed what is held net of the open sell
    expect(await svc.placeLimit({ tokenId: 't1', side: 'sell', price: 0.56, size: 1, riskExit: true })).toMatchObject({ failedCheck: 'sell_position' });
    clock += MIN;
    current = book(0.56, 0.57);
    await svc.getOpenOrders();
    expect(t.orderRepo.findById(r.orderId!)).toMatchObject({ status: 'filled', avg_fill_price: 0.55 });
    expect(t.tradeRepo.getRiskPositions({ simulated: true })).toHaveLength(0);
  });

  it('post-only still refuses a crossing order; a non-post-only crossing order fills at once', async () => {
    current = book(0.49, 0.5);
    expect(await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.5, size: 10 })).toMatchObject({ failedCheck: 'post_only' });
    expect(await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.5, size: 10, postOnly: false })).toMatchObject({ status: 'filled', filledSize: 10 });
  });
});
