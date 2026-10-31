/**
 * Reconciler (spec §13, §15): missed fills, unknown-outcome orders, position mismatches (debounced halt,
 * pre-existing positions, adoption), resolved markets, clock skew, outage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { sqliteAvailable } from '../orders/db';
import { openRiskHarness, type RiskHarness } from '../risk/riskHarness';
import { WalletRepository } from '../../electron/database/repositories/WalletRepository';
import { GLOBAL_SCOPE } from '../../electron/database/repositories/RiskStateRepository';
import { Reconciler, RECONCILER_FAILURE_ALERT, type ReconcilerDeps } from '../../electron/reconcile/Reconciler';
import type { DataApiPosition, DataApiTrade } from '../../electron/reconcile/dataApi';
import type { MarketView } from '../../electron/ledger/MarketCacheService';
import type { ClobTrade } from '../../electron/orders/ExchangeAdapter';

const TAKER = 0.02;

function position(tokenId: string, size: number, curPrice = 0.5, extra: Partial<DataApiPosition> = {}): DataApiPosition {
  return { tokenId, conditionId: `c-${tokenId}`, size, avgPrice: curPrice, curPrice, redeemable: false, title: null, outcome: null, ...extra };
}

function market(id: string, tokens: string[], fields: Partial<MarketView> = {}): MarketView {
  return {
    marketId: id,
    question: `Q ${id}`,
    tokens: tokens.map((t, i) => ({ tokenId: t, outcome: i === 0 ? 'Yes' : 'No' })),
    closed: false,
    outcomePrices: null,
    umaResolutionStatus: null,
    resolutionSeen: null,
    resolutionSeenAt: null,
    category: 'economics',
    feeCategory: null,
    ...fields,
  } as MarketView;
}

describe.skipIf(!sqliteAvailable)('Reconciler', () => {
  let h: RiskHarness;
  let positions: DataApiPosition[];
  let walletTrades: DataApiTrade[];
  let clobTrades: ClobTrade[];
  let markets: Map<string, MarketView>;
  let notify: { reconciliationMismatch: ReturnType<typeof vi.fn>; reconcilerAlert: ReturnType<typeof vi.fn> };
  let exchangeTime: () => Promise<number>;
  let deps: ReconcilerDeps;

  function makeReconciler(over: Partial<ReconcilerDeps> = {}): Reconciler {
    deps = {
      db: h.db,
      orderRepo: h.orderRepo,
      tradeRepo: h.tradeRepo,
      botRepo: h.botRepo,
      scriptRepo: h.scriptRepo,
      walletRepo: new WalletRepository(h.db),
      riskStateRepo: h.riskStateRepo,
      audit: h.audit,
      killSwitch: h.killSwitch,
      canceller: h.canceller,
      notify,
      marketCache: {
        getCached: (id) => markets.get(id) ?? null,
        getCachedByToken: (t) => [...markets.values()].find((m) => m.tokens.some((x) => x.tokenId === t)) ?? null,
        setResolutionSeen: (id, sig, at) => {
          const m = markets.get(id);
          if (m) markets.set(id, { ...m, resolutionSeen: sig, resolutionSeenAt: at });
        },
      },
      getFeeRates: () => ({ takerRate: TAKER, makerRate: 0 }),
      isBotRunning: (id) => h.running.has(id),
      getPolymarketAdapter: async () => h.poly,
      getBinanceAdapter: () => null,
      fetchPositions: async () => positions,
      fetchTrades: async () => walletTrades,
      getExchangeTime: () => exchangeTime(),
      getLimits: () => h.limits,
      now: () => h.clock.now,
      ...over,
    };
    return new Reconciler(deps);
  }

  beforeEach(() => {
    h = openRiskHarness(Date.now());
    h.addBot('b1');
    h.running.add('b1');
    positions = [];
    walletTrades = [];
    clobTrades = [];
    markets = new Map();
    notify = { reconciliationMismatch: vi.fn(), reconcilerAlert: vi.fn() };
    exchangeTime = async () => h.clock.now;
    Object.assign(h.poly, {
      getOpenOrders: vi.fn(async () => []),
      getTrades: vi.fn(async () => clobTrades),
    });
  });

  afterEach(() => h.close());

  const fillsOf = (orderId: string) => h.db.prepare('SELECT * FROM bot_trades WHERE order_id = ?').all(orderId) as Array<{ quantity: number; quote_amount: number; fee_usd: number }>;

  it('records a missed resting fill exactly once (two runs and a bot sync)', async () => {
    const id = h.addOpenOrder('b1', 'ex-1');
    h.poly.getOrder.mockResolvedValue({ status: 'live', sizeMatched: 4, originalSize: 10, price: 0.4 });
    const r = makeReconciler();
    const first = await r.runOnce();
    await r.runOnce();
    await h.orderService('b1').syncOpenOrders();

    expect(first.errors).toEqual([]);
    expect(fillsOf(id)).toHaveLength(1);
    expect(fillsOf(id)[0].quantity).toBeCloseTo(4);
    expect(h.orderRepo.findById(id)).toMatchObject({ status: 'partially_filled', filled_size: 4 });
    expect(h.riskStateRepo.getGlobal()?.reconciled_at).toBeTruthy();
  });

  function unknownMarketBuy(): string {
    // FOK buy of $10 at worst price 0.5 whose post timed out: no exchange id, 5-minute lifetime
    return h.orderRepo.create({
      botId: 'b1',
      exchange: 'polymarket',
      marketId: 'm1',
      tokenId: 't1',
      side: 'buy',
      orderType: 'market',
      price: 0.5,
      size: 20,
      notionalUsd: 10,
      status: 'submitted',
      expiresAt: new Date(h.clock.now + 5 * 60_000).toISOString(),
    }).id;
  }

  it('recovers an unknown-outcome order that actually filled instead of expiring it', async () => {
    const id = unknownMarketBuy();
    const created = Date.parse(h.orderRepo.findById(id)!.created_at);
    clobTrades = [
      {
        id: 'tr-1',
        assetId: 't1',
        status: 'CONFIRMED',
        matchTimeMs: created + 1500,
        traderSide: 'TAKER',
        takerOrderId: 'ex-taker',
        side: 'buy',
        size: 20.4,
        price: 0.49,
        makerOrders: [],
      },
    ];
    h.poly.getOrder.mockResolvedValue(null); // exchange does not return matched FOK orders: use the trades
    h.clock.now += 30 * 60_000; // long past the old 5-minute expiry
    const r = makeReconciler();
    const res = await r.runOnce();
    await r.runOnce();

    expect(res.recovered).toEqual([id]);
    const row = h.orderRepo.findById(id)!;
    expect(row).toMatchObject({ status: 'filled', exchange_order_id: 'ex-taker' });
    expect(row.filled_size).toBeCloseTo(20.4);
    const fills = fillsOf(id);
    expect(fills).toHaveLength(1);
    expect(fills[0].quantity).toBeCloseTo(20.4);
    expect(fills[0].quote_amount).toBeCloseTo(9.996);
    expect(fills[0].fee_usd).toBeCloseTo(TAKER * 9.996);
    expect(h.tradeRepo.getRiskPositions({ simulated: false })[0].net_quantity).toBeCloseTo(20.4);
  });

  it('expires an unknown-outcome order only after the exchange confirms no match, and never on a failed lookup', async () => {
    const id = unknownMarketBuy();
    const r = makeReconciler();
    await r.runOnce();
    expect(h.orderRepo.findById(id)!.status).toBe('submitted'); // within its lifetime

    h.clock.now += 10 * 60_000;
    h.poly.getTrades.mockRejectedValueOnce(new Error('CLOB down'));
    const failed = await r.runOnce();
    expect(failed.ok).toBe(false);
    expect(h.orderRepo.findById(id)!.status).toBe('submitted'); // fail closed

    const ok = await r.runOnce();
    expect(ok.expired).toEqual([id]);
    expect(h.orderRepo.findById(id)!.status).toBe('expired');
  });

  it('leaves an unknown-outcome order open when several exchange orders match it', async () => {
    const id = unknownMarketBuy();
    const created = Date.parse(h.orderRepo.findById(id)!.created_at);
    const trade = (n: number): ClobTrade => ({
      id: `tr-${n}`,
      assetId: 't1',
      status: 'MATCHED',
      matchTimeMs: created + n * 1000,
      traderSide: 'TAKER',
      takerOrderId: `ex-${n}`,
      side: 'buy',
      size: 20,
      price: 0.5,
      makerOrders: [],
    });
    clobTrades = [trade(1), trade(2)];
    h.clock.now += 30 * 60_000;
    const res = await makeReconciler().runOnce();
    expect(res.ambiguous).toEqual([id]);
    expect(h.orderRepo.findById(id)!.status).toBe('submitted');
    expect(notify.reconciliationMismatch).toHaveBeenCalledTimes(1);
  });

  it('cancels open orders of bots that are not running or halted', async () => {
    const id = h.addOpenOrder('b1', 'ex-9');
    h.running.delete('b1');
    const res = await makeReconciler().runOnce();
    expect(res.cancelledBots).toEqual(['b1']);
    expect(h.poly.cancelOrders).toHaveBeenCalledWith(['ex-9']);
    expect(h.orderRepo.findById(id)!.status).toBe('cancelled');
  });

  function priorOrder(): void {
    // The wallet traded through OrderService before (first order row = now - 1 day)
    const o = h.orderRepo.create({
      botId: 'b1',
      exchange: 'polymarket',
      marketId: 'm0',
      tokenId: 't0',
      side: 'buy',
      orderType: 'limit',
      price: 0.5,
      size: 1,
      notionalUsd: 0.5,
      status: 'cancelled',
    });
    h.db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(new Date(h.clock.now - 86_400_000).toISOString(), o.id);
  }

  it('mismatch: warns on the first run, halts globally when it persists above the threshold', async () => {
    priorOrder();
    positions = [position('tx', 100, 0.5)]; // $50 the bots never bought
    walletTrades = [{ tokenId: 'tx', side: 'BUY', size: 100, price: 0.5, timestampMs: h.clock.now - 60_000 }];
    const r = makeReconciler();

    const first = await r.runOnce();
    expect(first.mismatches).toHaveLength(1);
    expect(first.mismatches[0]).toMatchObject({ direction: 'exchange_excess', preExisting: false, consecutive: 1 });
    expect(first.halted).toBe(false);
    expect(h.riskStateRepo.isHalted(GLOBAL_SCOPE)).toBe(false);
    expect(notify.reconciliationMismatch).toHaveBeenCalledTimes(1);

    h.clock.now += 60_000;
    const second = await r.runOnce();
    expect(second.halted).toBe(true);
    expect(h.riskStateRepo.isHalted(GLOBAL_SCOPE)).toBe(true);
    expect(h.riskStateRepo.getGlobal()?.halted_reason).toMatch(/^reconciliation: unexplained exposure \$50\.00 > \$10\.00/);
    expect(notify.reconciliationMismatch).toHaveBeenCalledTimes(1); // same mismatch: not re-sent
  });

  it('does not halt below the threshold, nor on dust, nor when a mismatch clears between runs', async () => {
    priorOrder();
    positions = [position('small', 10, 0.5), position('dust', 0.005, 0.5)]; // $5, dust
    const r = makeReconciler();
    await r.runOnce();
    await r.runOnce();
    expect(h.riskStateRepo.isHalted(GLOBAL_SCOPE)).toBe(false);

    // Data API lag after a fill: seen once, gone the next run
    positions = [position('lag', 100, 0.5)];
    await r.runOnce();
    positions = [];
    await r.runOnce();
    positions = [position('lag', 100, 0.5)];
    await r.runOnce(); // counts from 1 again
    expect(h.riskStateRepo.isHalted(GLOBAL_SCOPE)).toBe(false);
  });

  it('local position larger than the exchange is a mismatch too', async () => {
    h.addFill('b1', 't1', 'BUY', 100, 0.4, h.clock.now - 60_000);
    positions = [position('t1', 50, 0.4)];
    const r = makeReconciler();
    const first = await r.runOnce();
    expect(first.mismatches[0]).toMatchObject({ direction: 'local_excess', localQty: 100, exchangeQty: 50 });
    await r.runOnce();
    expect(h.riskStateRepo.isHalted(GLOBAL_SCOPE)).toBe(true); // $20 > $10
  });

  it('pre-existing positions (before the wallet’s first order) only warn; adoption clears them', async () => {
    positions = [position('old', 200, 0.5)]; // $100, no order ever placed on this wallet
    const r = makeReconciler();
    for (let i = 0; i < 3; i++) {
      const res = await r.runOnce();
      expect(res.mismatches[0]).toMatchObject({ preExisting: true });
    }
    expect(h.riskStateRepo.isHalted(GLOBAL_SCOPE)).toBe(false);
    const audit = h.auditRepo.list({ action: 'reconcile.mismatch' }) as Array<{ result: string }>;
    expect(audit.some((a) => /^warning: pre-existing/.test(a.result))).toBe(true);

    await expect(r.adoptPositions('w1', 'b1', 'agent')).rejects.toThrow(/human/);
    const adopted = await r.adoptPositions('w1', 'b1', 'human');
    expect(adopted.adopted).toEqual([{ tokenId: 'old', marketId: 'c-old', quantity: 200, price: 0.5 }]);
    const pos = h.tradeRepo.getRiskPositions({ simulated: false });
    expect(pos).toEqual([expect.objectContaining({ bot_id: 'b1', symbol: 'old', net_quantity: 200, cost_basis: 100 })]);
    expect((await r.runOnce()).mismatches).toEqual([]);
    // Adopted fills are not fills the bot made (ramp)
    expect(h.tradeRepo.findPnlFills()[0].fill_source).toBe('adopted');
  });

  it('a position bought before the first order but grown afterwards halts on the new part only', async () => {
    priorOrder();
    positions = [position('mix', 150, 0.5)];
    walletTrades = [
      { tokenId: 'mix', side: 'BUY', size: 130, price: 0.5, timestampMs: h.clock.now - 2 * 86_400_000 }, // before the first order
      { tokenId: 'mix', side: 'BUY', size: 20, price: 0.5, timestampMs: h.clock.now - 60_000 },
    ];
    const r = makeReconciler();
    await r.runOnce();
    const res = await r.runOnce();
    expect(res.mismatches[0].haltValueUsd).toBeCloseTo(10);
    expect(h.riskStateRepo.isHalted(GLOBAL_SCOPE)).toBe(false); // $10 is not > $10
  });

  it('a resolved market closes the position at the payout and stops counting it as exposure', async () => {
    h.addFill('b1', 't1', 'BUY', 100, 0.4, h.clock.now - 3_600_000);
    h.addFill('b1', 't2', 'BUY', 50, 0.3, h.clock.now - 3_600_000, true); // paper, losing side
    markets.set('m1', market('m1', ['t1', 't2'], { closed: true, outcomePrices: ['1', '0'], umaResolutionStatus: 'resolved' }));
    positions = [position('t1', 100, 1, { redeemable: true, conditionId: 'm1' })]; // waiting for redemption
    const r = makeReconciler();
    const res = await r.runOnce();

    expect(res.resolvedPositions).toBe(2);
    expect(res.mismatches).toEqual([]);
    expect(h.tradeRepo.getRiskPositions({ simulated: false })).toEqual([]);
    expect(h.tradeRepo.getRiskPositions({ simulated: true })).toEqual([]);
    const sells = h.db.prepare("SELECT * FROM bot_trades WHERE fill_source = 'resolution' ORDER BY simulated").all() as Array<{ price: number; quote_amount: number; simulated: number }>;
    expect(sells.map((s) => [s.price, s.quote_amount, s.simulated])).toEqual([
      [1, 100, 0],
      [0, 0, 1],
    ]);
    const audit = h.auditRepo.list({ action: 'reconcile.position_resolved' }) as Array<{ payload: string }>;
    expect(audit.map((a) => JSON.parse(a.payload).realizedPnl).sort()).toEqual([-15, 60]);
    await r.runOnce();
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM bot_trades WHERE fill_source = 'resolution'").get()).toEqual({ n: 2 });
  });

  it('a final price without a settled UMA status waits 24 h before closing positions', async () => {
    h.addFill('b1', 't1', 'BUY', 100, 0.4, h.clock.now - 3_600_000);
    markets.set('m1', market('m1', ['t1', 't2'], { closed: true, outcomePrices: ['1', '0'] }));
    positions = [position('t1', 100, 1, { redeemable: true, conditionId: 'm1' })];
    const r = makeReconciler();
    expect((await r.runOnce()).resolvedPositions).toBe(0);
    h.clock.now += 25 * 3_600_000;
    exchangeTime = async () => h.clock.now;
    expect((await r.runOnce()).resolvedPositions).toBe(1);
  });

  it('clock skew > 5 s blocks live orders until fixed; audited and notified once', async () => {
    exchangeTime = async () => h.clock.now - 9_000; // local clock 9 s ahead
    const r = makeReconciler();
    await r.runOnce();
    await r.runOnce();
    expect(r.status().skewed).toBe(true);
    expect(notify.reconcilerAlert).toHaveBeenCalledTimes(1);

    const svc = h.orderService('b1');
    (svc as unknown as { deps: { clock: unknown } }).deps.clock = r;
    const blocked = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.3, size: 10 });
    expect(blocked).toMatchObject({ ok: false, status: 'rejected_risk', failedCheck: 'clock_skew' });

    exchangeTime = async () => h.clock.now + 1_000;
    await r.runOnce();
    expect(r.status().skewed).toBe(false);
    const after = await svc.placeLimit({ tokenId: 't1', side: 'buy', price: 0.3, size: 10 });
    expect(after.failedCheck).not.toBe('clock_skew');
    expect(notify.reconcilerAlert).toHaveBeenCalledTimes(2); // skew + fixed
  });

  it('a reconciler outage notifies after 5 failed runs and never halts', async () => {
    const r = makeReconciler({ fetchPositions: async () => Promise.reject(new Error('Data API down')) });
    for (let i = 0; i < RECONCILER_FAILURE_ALERT + 2; i++) await r.runSafe();
    expect(notify.reconcilerAlert).toHaveBeenCalledTimes(1);
    expect(notify.reconcilerAlert.mock.calls[0][0]).toMatch(/failed 5 runs in a row/);
    expect(h.riskStateRepo.isHalted(GLOBAL_SCOPE)).toBe(false);
    expect(h.riskStateRepo.getGlobal()?.reconciled_at ?? null).toBeNull();
  });
});
