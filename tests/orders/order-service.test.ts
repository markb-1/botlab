import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { sqliteAvailable, openTestDb, type TestDb } from './db';
import { LimitsSchema, MandateSchema } from '../../electron/config';
import { RiskEngine } from '../../electron/risk/RiskEngine';
import { FeeService } from '../../electron/orders/FeeService';
import { DbRiskStateProvider } from '../../electron/orders/DbRiskStateProvider';
import { OrderService, type BotOrderContext, type ClobBook } from '../../electron/orders/OrderService';
import { PlaceholderMarketQualityProvider, type MarketInfo } from '../../electron/orders/MarketDataService';
import type { PolymarketAdapter, BinanceAdapter } from '../../electron/orders/ExchangeAdapter';
import { PaperTradingState } from '../../electron/runtime/PaperTradingState';
import type { RiskDecision } from '../../electron/risk/types';

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

  const engine = new RiskEngine({ limits: LimitsSchema.parse({}), mandate: MandateSchema.parse({}) });

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
        marketData: { getMarketInfo: async (tokenId: string) => (MARKET.tokenIds.includes(tokenId) ? MARKET : null) },
        quality: PlaceholderMarketQualityProvider,
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
    expect(row.fee_usd).toBeCloseTo(0.05 * 20); // economics taker rate × notional

    const positions = t.tradeRepo.getRiskPositions({ simulated: false });
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ bot_id: 'bot-1', symbol: 't1', condition_id: 'm1', net_quantity: 40, cost_basis: 20 });
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

    const r = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20, ttlMinutes: 10_000 });
    expect(r).toMatchObject({ ok: true, status: 'open' });
    const ttl = engine.getConfig().limits.orders.resting_order_ttl_minutes; // ttl capped
    expect(poly.postLimitOrder).toHaveBeenCalledWith({ tokenId: 't1', side: 'buy', price: 0.45, size: 20, expiresAtMs: NOW + ttl * 60_000 });
    expect(r.expiresAt).toBe(new Date(NOW + ttl * 60_000).toISOString());
    expect(t.orderRepo.sumOpenBuyNotional({ marketId: 'm1' })).toBeCloseTo(9);
    expect(t.orderRepo.findById(r.orderId!)!.fee_usd).toBe(0); // maker
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
    // Resting paper orders are not simulated
    expect(await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.45, size: 20 })).toMatchObject({
      ok: false,
      status: 'invalid',
      error: 'paper mode: resting orders not simulated yet',
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

    it('unknown-outcome FOK: counted for 5 minutes, reported (not failed) by cancelAll, then dead', async () => {
      const svc = makeService('bot-1');
      poly.postMarketOrder.mockRejectedValueOnce(new Error('socket hang up'));
      const r = await svc.placeMarketable({ tokenId: 't1', side: 'buy', amount: 10 });
      expect(r.status).toBe('submitted');
      expect(r.feeUsd).toBe(0);
      expect(await svc.cancelAll()).toEqual({ cancelled: 0, failed: 0, unknownOutcome: 1 });
      expect(t.orderRepo.sumOpenBuyNotional({})).toBeCloseTo(10);

      clock = NOW + 4 * 60_000;
      await svc.syncOpenOrders();
      expect(t.orderRepo.sumOpenBuyNotional({})).toBeCloseTo(10);
      clock = NOW + 5 * 60_000;
      await svc.syncOpenOrders();
      expect(t.orderRepo.findById(r.orderId!)!.status).toBe('expired');
      expect(t.orderRepo.sumOpenBuyNotional({})).toBe(0);
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
});
