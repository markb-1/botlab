import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../packages/core/src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { sqliteAvailable, openTestDb, type TestDb } from './db';
import { LimitsSchema, MandateSchema } from '../../packages/core/src/config';
import { RiskEngine } from '../../packages/core/src/risk/RiskEngine';
import { FeeService } from '../../packages/core/src/orders/FeeService';
import { DbRiskStateProvider } from '../../packages/core/src/orders/DbRiskStateProvider';
import { OrderService, type BotOrderContext, type ClobBook } from '../../packages/core/src/orders/OrderService';
import type { MarketInfo, MarketQualityProvider } from '../../packages/core/src/orders/MarketDataService';

/** Market assessed as unambiguous economics (the market cache is tested separately) */
const ASSESSED: MarketQualityProvider = { get: async () => ({ category: 'economics', ambiguityScore: 0, rulesChangedAt: null }) };
import type { PolymarketAdapter, BinanceAdapter } from '../../packages/core/src/orders/ExchangeAdapter';
import { PaperTradingState } from '../../packages/core/src/runtime/PaperTradingState';
import type { RiskDecision } from '../../packages/core/src/risk/types';
import { computeDailyPnl, markKey } from '../../packages/core/src/risk/dailyPnl';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const DAY = 86_400_000;

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

const BOOK: ClobBook = {
  bids: [{ price: '0.49', size: '1000' }],
  asks: [{ price: '0.5', size: '1000' }],
  tick_size: '0.01',
};

function fakePolymarket(): PolymarketAdapter & Record<string, ReturnType<typeof vi.fn>> {
  return {
    postMarketOrder: vi.fn().mockImplementation(async (a: { side: string; amount: number; price: number }) => ({
      kind: 'accepted',
      exchangeOrderId: 'ex-1',
      status: 'matched',
      filledSize: a.side === 'buy' ? a.amount / a.price : a.amount,
      filledNotional: a.side === 'buy' ? a.amount : a.amount * a.price,
    })),
    postLimitOrder: vi.fn().mockResolvedValue({ kind: 'accepted', exchangeOrderId: 'ex-lim', status: 'live', filledSize: null, filledNotional: null }),
    cancelOrders: vi.fn().mockImplementation(async (ids: string[]) => ids),
    getOrder: vi.fn().mockResolvedValue(null),
  } as never;
}

describe.skipIf(!sqliteAvailable)('OrderService', () => {
  let t: TestDb;
  let poly: ReturnType<typeof fakePolymarket>;
  let binance: BinanceAdapter & Record<string, ReturnType<typeof vi.fn>>;
  let cash: () => Promise<number>;
  let clock = NOW;
  let market: MarketInfo = MARKET;

  // Live trading is opt-in (3b); these tests exercise live orders
  const engine = new RiskEngine({ limits: LimitsSchema.parse({ live_trading: { enabled: true } }), mandate: MandateSchema.parse({}) });

  function makeService(botId: string, mode: 'live' | 'paper' = 'live', paperState?: PaperTradingState): OrderService {
    const simulated = mode === 'paper';
    const provider = new DbRiskStateProvider({
      botRepo: t.botRepo,
      orderRepo: t.orderRepo,
      tradeRepo: t.tradeRepo,
      riskStateRepo: t.riskStateRepo,
      simulated,
      getCashUsd: simulated ? async () => paperState!.getBalance() : () => cash(),
      getEndDate: async () => MARKET.endDate,
      now: () => clock,
    });
    const bot: BotOrderContext = {
      botId,
      botName: botId,
      scriptName: 'script',
      mode,
      polymarket: simulated ? null : poly,
      binance: simulated ? null : binance,
      paperState: paperState ?? null,
    };
    return new OrderService(
      {
        db: t.db,
        orderRepo: t.orderRepo,
        tradeRepo: t.tradeRepo,
        riskEngine: engine,
        provider,
        fees: new FeeService(),
        marketData: { getMarketInfo: async (tokenId: string) => (market.tokenIds.includes(tokenId) ? market : null) },
        quality: ASSESSED,
        getBook: async () => BOOK,
        getBinanceBook: async () => ({ bids: [{ price: '49990', quantity: '1' }], asks: [{ price: '50000', quantity: '1' }] }),
        now: () => clock,
      },
      bot
    );
  }

  beforeEach(() => {
    t = openTestDb();
    poly = fakePolymarket();
    binance = {
      marketBuy: vi.fn().mockResolvedValue({ success: true, orderId: 7, symbol: 'BTCUSDT', side: 'BUY', executedQty: 0.0004, cummulativeQuoteQty: 20, avgPrice: 50_000 }),
      marketSell: vi.fn(),
    } as never;
    cash = async () => 1000;
    clock = NOW;
    market = MARKET;
    t.addBot('bot-1');
    t.addBot('bot-2');
  });

  afterEach(() => t.close());

  it('persists a risk rejection and never calls the exchange', async () => {
    const svc = makeService('bot-1');
    const r = await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 100 }); // > max_order_usd 25

    expect(r).toMatchObject({ ok: false, status: 'rejected_risk', failedCheck: 'max_order' });
    expect(poly.postMarketOrder).not.toHaveBeenCalled();
    const row = t.orderRepo.findById(r.orderId!)!;
    expect(row.status).toBe('rejected_risk');
    const decision = JSON.parse(row.risk_decision!) as RiskDecision;
    expect(decision.allowed).toBe(false);
    expect(decision.failedCheck).toBe('max_order');
  });

  it('places an allowed order once and records the fill, fee and position', async () => {
    const svc = makeService('bot-1');
    const r = await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 20 });

    expect(poly.postMarketOrder).toHaveBeenCalledTimes(1);
    expect(poly.postMarketOrder).toHaveBeenCalledWith({ tokenId: 't1', side: 'buy', amount: 20, price: 0.5 });
    expect(r).toMatchObject({ ok: true, status: 'filled', filledSize: 40, avgFillPrice: 0.5 });

    const row = t.orderRepo.findById(r.orderId!)!;
    expect(row).toMatchObject({ status: 'filled', exchange_order_id: 'ex-1', filled_size: 40, avg_fill_price: 0.5, market_id: 'm1', simulated: 0 });
    // No schedule on the market ⇒ economics table rate; fee = shares × rate × p × (1 − p)
    expect(row.fee_usd).toBeCloseTo(40 * 0.05 * 0.5 * 0.5);

    const positions = t.tradeRepo.getRiskPositions({ simulated: false });
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ bot_id: 'bot-1', symbol: 't1', condition_id: 'm1', net_quantity: 40, cost_basis: 20 });
  });

  it("uses the market's own fee schedule over the category table (zero_fees ⇒ 0, rate 0.07 ⇒ rate × p × (1 − p))", async () => {
    market = { ...MARKET, feeSchedule: { feesEnabled: false, feeType: 'zero_fees', rate: 0, exponent: null, takerOnly: true, rebateRate: null, from: 'zero' } };
    const svc = makeService('bot-1');
    const a = await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 20 });
    expect(t.orderRepo.findById(a.orderId!)!.fee_usd).toBe(0);
    expect(await svc.getFee('t1')).toMatchObject({ takerRate: 0, source: 'market', feeType: 'zero_fees' });

    market = { ...MARKET, feeSchedule: { feesEnabled: true, feeType: 'crypto_fees_v2', rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2, from: 'feeSchedule' } };
    const b = await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 20 });
    expect(t.orderRepo.findById(b.orderId!)!.fee_usd).toBeCloseTo(40 * 0.07 * 0.5 * 0.5, 9);
  });

  it('live trading off (the default limits.yaml) ⇒ live orders rejected as live_disabled; paper unaffected', async () => {
    const live = makeService('bot-1');
    engine.setConfig({ limits: LimitsSchema.parse({}), mandate: MandateSchema.parse({}) });
    try {
      const r = await live.placeMarketable({ tokenId: 't1', side: 'buy', amount: 20 });
      expect(r).toMatchObject({ ok: false, status: 'rejected_risk', failedCheck: 'live_disabled' });
      expect(poly.postMarketOrder).not.toHaveBeenCalled();
      const paper = makeService('bot-2', 'paper', new PaperTradingState('bot-2', 1000, t.storageRepo));
      const p = await paper.placeMarketable({ tokenId: 't1', side: 'buy', amount: 20 });
      expect(p.failedCheck).not.toBe('live_disabled');
    } finally {
      engine.setConfig({ limits: LimitsSchema.parse({ live_trading: { enabled: true } }), mandate: MandateSchema.parse({}) });
    }
  });

  it('counts earlier fills toward exposure (per-market cap across bots)', async () => {
    const a = makeService('bot-1');
    const b = makeService('bot-2');
    expect((await a.placeMarketable({ tokenId: 't1', side: 'buy', amount: 25 })).status).toBe('filled');
    expect((await b.placeMarketable({ tokenId: 't2', side: 'buy', amount: 25 })).status).toBe('filled');
    // per_market.max_exposure_usd = 50 across bots and both tokens
    const r = await b.placeMarketable({ tokenId: 't1', side: 'buy', amount: 1 });
    expect(r).toMatchObject({ status: 'rejected_risk', failedCheck: 'market_exposure' });
    expect(poly.postMarketOrder).toHaveBeenCalledTimes(2);
  });

  it('marks an exchange rejection failed and an unknown outcome still submitted', async () => {
    const svc = makeService('bot-1');
    poly.postMarketOrder.mockResolvedValueOnce({ kind: 'rejected', error: 'not enough balance' });
    const failed = await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 10 });
    expect(failed).toMatchObject({ ok: false, status: 'failed', error: 'not enough balance' });
    expect(t.orderRepo.findById(failed.orderId!)!.status).toBe('failed');

    poly.postMarketOrder.mockRejectedValueOnce(new Error('socket hang up'));
    const unknown = await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 10 });
    expect(unknown).toMatchObject({ ok: false, status: 'submitted' });
    // May be live: keeps counting as open buy notional
    expect(t.orderRepo.sumOpenBuyNotional({ botId: 'bot-1' })).toBeCloseTo(10);
    expect(t.tradeRepo.getRiskPositions({ simulated: false })).toHaveLength(0);
  });

  it('rejects buys when equity is unavailable (fail closed)', async () => {
    cash = async () => {
      throw new Error('rpc down');
    };
    const r = await makeService('bot-1').placeMarketable({ tokenId: 't1', side: 'buy', amount: 10 });
    expect(r).toMatchObject({ status: 'rejected_risk', failedCheck: 'state_invalid' });
    expect(poly.postMarketOrder).not.toHaveBeenCalled();
  });

  it('forecast-strategy bots cannot buy without a resolvable forecast', async () => {
    t.addBot('fc', { strategy: 'forecast' });
    const svc = makeService('fc');
    expect(await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 10 })).toMatchObject({
      status: 'rejected_risk',
      failedCheck: 'forecast_required',
    });
    // No ledger yet (chunk 2a): a forecast id never resolves
    expect(await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 10, forecastId: 'f1' })).toMatchObject({
      status: 'rejected_risk',
      failedCheck: 'forecast_unavailable',
    });
    expect(poly.postMarketOrder).not.toHaveBeenCalled();
  });

  it('places GTD limit orders: post-only by default, expiry = ttl, counted as open exposure', async () => {
    const svc = makeService('bot-1');
    const crossing = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.5, size: 20 });
    expect(crossing).toMatchObject({ status: 'rejected_risk', failedCheck: 'post_only' });
    expect(poly.postLimitOrder).not.toHaveBeenCalled();

    // Polymarket refuses GTD expirations under 3 minutes ahead: smaller TTLs are rejected up front (R126)
    for (const ttlMinutes of [0, 1, 2.9, -5, Number.NaN]) {
      const tooShort = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20, ttlMinutes });
      expect(tooShort).toMatchObject({ ok: false, status: 'invalid' });
      expect(tooShort.error).toMatch(/at least 3/);
    }
    expect(poly.postLimitOrder).not.toHaveBeenCalled();
    const min = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.44, size: 20, ttlMinutes: 3 });
    expect(min.expiresAt).toBe(new Date(NOW + 3 * 60_000).toISOString());
    poly.postLimitOrder.mockClear();

    const r = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20, ttlMinutes: 10_000 });
    expect(r).toMatchObject({ ok: true, status: 'open' });
    const ttl = engine.getConfig().limits.orders.resting_order_ttl_minutes; // ttl capped
    expect(poly.postLimitOrder).toHaveBeenCalledWith({ tokenId: 't1', side: 'buy', price: 0.45, size: 20, expiresAtMs: NOW + ttl * 60_000 });
    expect(r.expiresAt).toBe(new Date(NOW + ttl * 60_000).toISOString());
    expect(t.orderRepo.sumOpenBuyNotional({ marketId: 'm1' })).toBeCloseTo(9 + 0.44 * 20);
    expect(t.orderRepo.findById(r.orderId!)!.fee_usd).toBe(0); // maker
  });

  it('a limit order not marketable at check time that comes back matched pays the taker fee (and daily P&L sees it)', async () => {
    market = { ...MARKET, feeSchedule: { feesEnabled: true, feeType: 'politics_fees', rate: 0.04, exponent: 1, takerOnly: true, rebateRate: null, from: 'feeSchedule' } };
    // Book moved between the check (best ask 0.5) and the post: the CLOB matched it at once
    poly.postLimitOrder.mockResolvedValueOnce({ kind: 'accepted', exchangeOrderId: 'ex-m', status: 'matched', filledSize: 20, filledNotional: 9 });
    const svc = makeService('bot-1');
    const r = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20 });
    expect(r).toMatchObject({ ok: true, status: 'filled', filledSize: 20 });
    const expected = 20 * 0.04 * 0.45 * 0.55;
    expect(t.orderRepo.findById(r.orderId!)!.fee_usd).toBeCloseTo(expected, 9);

    const fills = t.tradeRepo.findPnlFills().filter((f) => f.bot_id === 'bot-1');
    expect(fills).toHaveLength(1);
    expect(fills[0].fee_usd).toBeCloseTo(expected, 9);
    const pnl = computeDailyPnl({
      fills: fills.map((f) => ({ exchange: f.exchange, symbol: f.symbol, side: f.side as 'BUY' | 'SELL', quantity: f.quantity ?? 0, quoteAmount: f.quote_amount ?? 0, feeUsd: f.fee_usd ?? 0, executedAt: NOW })),
      dayStartMs: NOW - 1000,
      dayStartMarks: {},
      currentMarks: { [markKey('polymarket', 't1')]: 0.45 },
      lastKnownMarks: {},
    });
    expect(pnl.totalPnl).toBeCloseTo(-expected, 9); // marked at cost: the fee is the whole day's loss
  });

  it('syncs resting fills from the exchange into positions', async () => {
    const svc = makeService('bot-1');
    const r = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20 });
    poly.getOrder.mockResolvedValue({ status: 'LIVE', sizeMatched: 5, originalSize: 20, price: 0.45 });
    const open = await svc.getOpenOrders();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ orderId: r.orderId, status: 'partially_filled', filledSize: 5 });
    expect(t.tradeRepo.getRiskPositions({ simulated: false })[0]).toMatchObject({ net_quantity: 5 });
    expect(t.orderRepo.sumOpenBuyNotional({})).toBeCloseTo(9 * 0.75);
  });

  it("a bot cannot see or cancel another bot's order", async () => {
    const other = await makeService('bot-2').placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20 });
    const svc = makeService('bot-1');

    await expect(svc.cancel(other.orderId!)).rejects.toThrow('Order not found');
    await svc.cancelAll();
    expect(poly.cancelOrders).not.toHaveBeenCalled();
    expect(await svc.getOpenOrders()).toHaveLength(0);
    expect(t.orderRepo.findById(other.orderId!)!.status).toBe('open');

    // The owner can
    await makeService('bot-2').cancel(other.orderId!);
    expect(poly.cancelOrders).toHaveBeenCalledWith(['ex-lim']);
    expect(t.orderRepo.findById(other.orderId!)!.status).toBe('cancelled');
  });

  it('paper orders are risk-checked, filled by PaperTradingState and never reach the exchange', async () => {
    t.addBot('paper-bot', { stage: 'paper' });
    const ps = new PaperTradingState('paper-bot', 1000, t.storageRepo);
    const svc = makeService('paper-bot', 'paper', ps);

    const r = await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 20 });
    expect(r).toMatchObject({ ok: true, status: 'filled', filledSize: 40 });
    expect(ps.getBalance()).toBeCloseTo(980);
    expect(t.orderRepo.findById(r.orderId!)!.simulated).toBe(1);

    // Same limits as live
    expect(await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 100 })).toMatchObject({
      status: 'rejected_risk',
      failedCheck: 'max_order',
    });
    // Resting paper orders rest (5a: filled by later syncs when the book crosses them)
    expect(await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20 })).toMatchObject({
      ok: true,
      status: 'open',
      filledSize: 0,
    });

    expect(poly.postMarketOrder).not.toHaveBeenCalled();
    expect(poly.postLimitOrder).not.toHaveBeenCalled();
    // Paper fills never count toward live exposure
    expect(t.tradeRepo.getRiskPositions({ simulated: false })).toHaveLength(0);
    expect(t.orderRepo.countByBotSince('paper-bot', new Date(0).toISOString(), false)).toBe(0);
  });

  it('records a resting fill once when syncs run concurrently', async () => {
    const svc = makeService('bot-1');
    const r = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20 });
    poly.getOrder.mockImplementation(async () => {
      await new Promise((res) => setTimeout(res, 1));
      return { status: 'LIVE', sizeMatched: 5, originalSize: 20, price: 0.45 };
    });
    const other = makeService('bot-1'); // e.g. a restarted runner for the same bot
    await Promise.all([
      svc.getOpenOrders(),
      svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.44, size: 10 }),
      other.getOpenOrders(),
      svc.cancel(r.orderId!).catch(() => undefined),
    ]);
    const fills = t.db.prepare('SELECT SUM(quantity) AS q FROM bot_trades WHERE order_id = ?').get(r.orderId) as { q: number };
    expect(fills.q).toBeCloseTo(5);
    expect(t.orderRepo.findById(r.orderId!)!.filled_size).toBeCloseTo(5);
  });

  it('re-reads cash after a fill instead of double-counting it as equity', async () => {
    let balance = 1000;
    let reads = 0;
    cash = async () => {
      reads++;
      return balance;
    };
    const svc = makeService('bot-1');
    poly.postMarketOrder.mockImplementation(async (a: { amount: number; price: number }) => {
      balance -= a.amount; // cash leaves the wallet when the order fills
      return { kind: 'accepted', exchangeOrderId: 'ex', status: 'matched', filledSize: a.amount / a.price, filledNotional: a.amount };
    });
    const snapshots: number[] = [];
    const getSnapshot = (svc as unknown as { deps: { provider: DbRiskStateProvider } }).deps.provider.getSnapshot.bind(
      (svc as unknown as { deps: { provider: DbRiskStateProvider } }).deps.provider
    );
    vi.spyOn((svc as unknown as { deps: { provider: DbRiskStateProvider } }).deps.provider, 'getSnapshot').mockImplementation(async (o) => {
      const snap = await getSnapshot(o);
      snapshots.push(snap.equityUsd);
      return snap;
    });
    for (const tokenId of ['t1', 't1', 't2']) await svc.placeMarketable({ tokenId, side: 'buy', amount: 10 });
    expect(reads).toBe(3);
    expect(snapshots).toEqual([1000, 1000, 1000]); // cash + cost basis stays 1000
  });

  it('sells (incl. risk exits) do not need a readable balance', async () => {
    const svc = makeService('bot-1');
    await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 20 });
    cash = async () => {
      throw new Error('rpc down');
    };
    const sell = await svc.placeMarketable({ tokenId: 't1', side: 'sell', amount: 10, riskExit: true });
    expect(sell).toMatchObject({ ok: true, status: 'filled' });
    // Buys still fail closed (fresh read after the fill invalidated the cache)
    expect(await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 5 })).toMatchObject({ failedCheck: 'state_invalid' });
  });

  describe('orders that never close do not accumulate', () => {
    it('GTD order past expiry + 60s: final fill check, then expired', async () => {
      const svc = makeService('bot-1');
      const r = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20, ttlMinutes: 10 });
      poly.getOrder.mockResolvedValue({ status: 'LIVE', sizeMatched: 2, originalSize: 20, price: 0.45 });
      clock = NOW + 10 * 60_000 + 30_000; // past expires_at, within the grace period
      await svc.syncOpenOrders();
      expect(t.orderRepo.findById(r.orderId!)!.status).toBe('partially_filled');
      clock = NOW + 11 * 60_000 + 1;
      expect(await svc.getOpenOrders()).toEqual([]);
      const row = t.orderRepo.findById(r.orderId!)!;
      expect(row).toMatchObject({ status: 'expired', filled_size: 2 });
      expect(t.orderRepo.sumOpenBuyNotional({})).toBe(0);
    });

    it('order not returned by the exchange after expiry ⇒ expired', async () => {
      const svc = makeService('bot-1');
      const r = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20, ttlMinutes: 10 });
      poly.getOrder.mockResolvedValue(null);
      clock = NOW + 5 * 60_000;
      await svc.syncOpenOrders();
      expect(t.orderRepo.findById(r.orderId!)!.status).toBe('open'); // not yet expired: stays open
      clock = NOW + 10 * 60_000 + 1;
      await svc.syncOpenOrders();
      expect(t.orderRepo.findById(r.orderId!)!.status).toBe('expired');
    });

    it('lookup errors keep the order open', async () => {
      const svc = makeService('bot-1');
      const r = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20, ttlMinutes: 10 });
      poly.getOrder.mockRejectedValue(new Error('down'));
      clock = NOW + 60 * 60_000;
      await svc.syncOpenOrders();
      expect(t.orderRepo.findById(r.orderId!)!.status).toBe('open');
    });

    it('FOK returned unmatched ⇒ cancelled with no fill', async () => {
      poly.postMarketOrder.mockResolvedValueOnce({ kind: 'accepted', exchangeOrderId: 'ex-u', status: 'unmatched', filledSize: null, filledNotional: null });
      const r = await makeService('bot-1').placeMarketable({ tokenId: 't1', side: 'buy', amount: 10 });
      expect(r).toMatchObject({ ok: false, status: 'cancelled', filledSize: 0, feeUsd: 0 });
      expect(t.tradeRepo.getRiskPositions({ simulated: false })).toHaveLength(0);
      expect(t.orderRepo.sumOpenBuyNotional({})).toBe(0);
    });

    it('unknown-outcome FOK: reported (not failed) by cancelAll, counted until the reconciler confirms it (R11, 2b)', async () => {
      const svc = makeService('bot-1');
      poly.postMarketOrder.mockRejectedValueOnce(new Error('socket hang up'));
      const r = await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 10 });
      expect(r.status).toBe('submitted');
      expect(r.feeUsd).toBe(0);
      expect(await svc.cancelAll()).toEqual({ cancelled: 0, failed: 0, unknownOutcome: 1 });
      expect(t.orderRepo.sumOpenBuyNotional({})).toBeCloseTo(10);

      // Past its 5-minute lifetime the bot's own sync no longer expires it: only the Reconciler,
      // after searching the exchange, may (tests/reconcile)
      clock = NOW + 60 * 60_000;
      await svc.syncOpenOrders();
      expect(t.orderRepo.findById(r.orderId!)!.status).toBe('submitted');
      expect(t.orderRepo.sumOpenBuyNotional({})).toBeCloseTo(10);
    });

    it('clock skew blocks live orders (clock_skew), not paper', async () => {
      const skew = { skewed: true, detail: 'local clock ahead of exchange time by 9.0 s' };
      const svc = makeService('bot-1');
      (svc as unknown as { deps: { clock: unknown } }).deps.clock = { status: () => skew };
      const r = await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 10 });
      expect(r).toMatchObject({ ok: false, status: 'rejected_risk', failedCheck: 'clock_skew' });
      expect(poly.postMarketOrder).not.toHaveBeenCalled();

      skew.skewed = false;
      const ok = await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 10 });
      expect(ok).toMatchObject({ ok: true, status: 'filled' });
    });
  });

  it('partial paper fills are partially_filled and the rest dies', async () => {
    t.addBot('paper-bot', { stage: 'paper' });
    const ps = new PaperTradingState('paper-bot', 1000, t.storageRepo);
    const svc = makeService('paper-bot', 'paper', ps);
    // The simulator only takes the top level; a book thin enough for that would fail top_of_book,
    // so stub a partial fill ($15 of $20) and check the price limit is passed through
    const spy = vi.spyOn(ps, 'simulateBuy').mockReturnValue({ success: true, executedAmount: 15, price: 0.5, tokenAmount: 30 });
    const r = await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 20 });
    expect(spy).toHaveBeenCalledWith('t1', 20, expect.anything(), { maxPrice: 0.5 });
    expect(r).toMatchObject({ status: 'partially_filled', filledSize: 30 });
    await svc.syncOpenOrders();
    expect(t.orderRepo.findById(r.orderId!)!.status).toBe('expired');
    expect(t.orderRepo.sumOpenBuyNotional({ simulated: true })).toBe(0);
  });

  it('routes Binance orders through the risk engine with the order id as client id', async () => {
    const svc = makeService('bot-1');
    const r = await svc.placeBinance({ symbol: 'btcusdt', side: 'buy', amount: 20 });
    expect(r).toMatchObject({ ok: true, status: 'filled' });
    expect(binance.marketBuy).toHaveBeenCalledWith('BTCUSDT', 20, r.orderId);

    expect(await svc.placeBinance({ symbol: 'ETHBTC', side: 'buy', amount: 20 })).toMatchObject({
      status: 'rejected_risk',
      failedCheck: 'unsupported_symbol',
    });
    expect(await svc.placeBinance({ symbol: 'BTCUSDT', side: 'buy', amount: 30 })).toMatchObject({
      status: 'rejected_risk',
      failedCheck: 'max_order',
    });
    expect(binance.marketBuy).toHaveBeenCalledTimes(1);
  });

  describe('order rate and rejection cooldown (Mac test F1)', () => {
    it('max_orders_per_hour counts only orders the bot itself submitted: no risk rejections, no exits placed for it', async () => {
      const svc = makeService('bot-1');
      expect(await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 100 })).toMatchObject({ failedCheck: 'max_order' });
      expect((await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20 })).ok).toBe(true);
      // A Position Manager exit placed on bot-1's behalf
      t.orderRepo.create({ botId: 'bot-1', exchange: 'polymarket', marketId: 'm1', tokenId: 't1', side: 'sell', orderType: 'limit', price: 0.6, size: 5, notionalUsd: 3, status: 'open', placedBy: 'pm', reason: 'position manager: flag: x' });
      expect(t.orderRepo.countByBotSince('bot-1', new Date(0).toISOString(), false)).toBe(1);
      const budget = await svc.getBudget();
      expect(budget.ordersPerHour).toBe(20);
      expect(budget.ordersRemainingThisHour).toBe(19);
    });

    it('a burst of own rejections pauses own submissions briefly; exits placed by another bot are exempt', async () => {
      clock = Date.now(); // row timestamps use the wall clock
      market = { ...MARKET, endDate: new Date(clock + 10 * DAY).toISOString() };
      const svc = makeService('bot-1');
      for (let i = 0; i < 6; i++) expect((await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 100 })).failedCheck).toBe('max_order');
      const paused = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20 });
      expect(paused).toMatchObject({ ok: false, status: 'rejected_risk', failedCheck: 'rejection_cooldown' });
      expect(poly.postLimitOrder).not.toHaveBeenCalled();
      // The cooldown's own refusals do not extend it
      expect(t.orderRepo.ownRejectionTimesSince('bot-1', new Date(0).toISOString(), false, 'rejection_cooldown')).toHaveLength(6);
      // A risk exit placed by the Position Manager still reaches the risk engine (refused there for other reasons)
      const exit = await svc.placeLimit({ tokenId: 't1', side: 'sell', price: 0.6, size: 5, riskExit: true, placedBy: 'pm' });
      expect(exit.failedCheck).not.toBe('rejection_cooldown');
      // Another bot is unaffected
      expect((await makeService('bot-2').placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20 })).ok).toBe(true);
      // Ten minutes later the window has drained
      clock += 11 * 60_000;
      expect((await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20 })).ok).toBe(true);
    });
  });

  it('getRecentStops: Position Manager stops on any bot in the same mode, latest per token (Mac test F4)', async () => {
    t.addBot('exec-a');
    t.addBot('exec-b');
    const row = (botId: string, tokenId: string, reason: string, simulated: boolean, side: 'buy' | 'sell' = 'sell', placedBy: string | null = 'pm') =>
      t.orderRepo.create({ botId, exchange: 'polymarket', marketId: 'm1', tokenId, side, orderType: 'limit', price: 0.4, size: 5, notionalUsd: 2, status: 'filled', placedBy, reason, simulated });
    row('exec-a', 't1', 'position manager: stop: bid 0.3 <= entry 0.5', true);
    row('exec-a', 't2', 'position manager: take_profit: converged', true);
    row('exec-a', 't3', 'position manager: stop (marketable): x', false); // live: not in paper
    row('exec-a', 't4', 'position manager: stop: but the bot sold it itself', true, 'sell', null);
    const ps = new PaperTradingState('exec-b', 1000, t.storageRepo);
    const svcB = makeService('exec-b', 'paper', ps);
    expect(svcB.getRecentStops()).toEqual([{ tokenId: 't1', stoppedAt: expect.any(String) }]);
    expect(svcB.getRecentStops('t2')).toEqual([]);
    expect(makeService('bot-1').getRecentStops().map((s) => s.tokenId)).toEqual(['t3']);
  });
});
