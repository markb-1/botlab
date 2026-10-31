/**
 * Real SQLite (in memory) + real halt/kill-switch/monitor wiring with a fake Polymarket adapter.
 */

import { vi } from 'vitest';
import { openTestDb, type TestDb } from '../orders/db';
import { LimitsSchema, MandateSchema, type LimitsConfig } from '../../electron/config';
import { AuditRepository } from '../../electron/database/repositories/AuditRepository';
import { ScriptRepository } from '../../electron/database/repositories/ScriptRepository';
import { AuditService } from '../../electron/audit/AuditService';
import { OrderCanceller } from '../../electron/orders/OrderCanceller';
import { HaltService } from '../../electron/risk/HaltService';
import { KillSwitch } from '../../electron/risk/KillSwitch';
import { RiskMonitor } from '../../electron/risk/RiskMonitor';
import { RiskEngine } from '../../electron/risk/RiskEngine';
import { FeeService } from '../../electron/orders/FeeService';
import { DbRiskStateProvider } from '../../electron/orders/DbRiskStateProvider';
import { OrderService, type ClobBook } from '../../electron/orders/OrderService';
import { PlaceholderMarketQualityProvider, type MarketInfo } from '../../electron/orders/MarketDataService';
import type { PolymarketAdapter } from '../../electron/orders/ExchangeAdapter';

export type FakePolymarket = PolymarketAdapter & Record<'cancelOrders' | 'getOrder' | 'postMarketOrder' | 'postLimitOrder', ReturnType<typeof vi.fn>>;

export function fakePolymarket(): FakePolymarket {
  return {
    postMarketOrder: vi.fn().mockResolvedValue({ kind: 'accepted', exchangeOrderId: 'ex-m', status: 'matched', filledSize: null, filledNotional: null }),
    postLimitOrder: vi.fn().mockResolvedValue({ kind: 'accepted', exchangeOrderId: 'ex-l', status: 'live', filledSize: null, filledNotional: null }),
    cancelOrders: vi.fn().mockImplementation(async (ids: string[]) => ids),
    getOrder: vi.fn().mockResolvedValue(null),
  } as never;
}

export interface RiskHarness extends TestDb {
  scriptRepo: ScriptRepository;
  auditRepo: AuditRepository;
  audit: AuditService;
  poly: FakePolymarket;
  canceller: OrderCanceller;
  halts: HaltService;
  killSwitch: KillSwitch;
  monitor: RiskMonitor;
  running: Set<string>;
  stopBot: ReturnType<typeof vi.fn>;
  limits: LimitsConfig;
  marks: Record<string, number | null>;
  clock: { now: number };
  addFill(botId: string, symbol: string, side: 'BUY' | 'SELL', qty: number, price: number, atMs: number, simulated?: boolean): void;
  addOpenOrder(botId: string, exchangeOrderId: string | null, opts?: { simulated?: boolean; tokenId?: string }): string;
  orderService(botId: string): OrderService;
}

export const MARKET: MarketInfo = {
  marketId: 'm1',
  question: 'Will CPI exceed 3%?',
  outcome: 'Yes',
  tokenIds: ['t1', 't2'],
  endDate: '2026-06-20T00:00:00Z', // within the 30-day horizon of the harness clock
  volume24hrUsd: 10_000,
  labels: ['Economics'],
  closed: false,
};

const BOOK: ClobBook = { bids: [{ price: '0.49', size: '1000' }], asks: [{ price: '0.5', size: '1000' }], tick_size: '0.01' };

export function openRiskHarness(startMs: number): RiskHarness {
  const t = openTestDb();
  const scriptRepo = new ScriptRepository(t.db);
  const auditRepo = new AuditRepository(t.db);
  const audit = new AuditService(auditRepo);
  const poly = fakePolymarket();
  const running = new Set<string>();
  const stopBot = vi.fn().mockImplementation(async (id: string) => {
    running.delete(id);
  });
  const limits = LimitsSchema.parse({});
  const marks: Record<string, number | null> = {};
  const clock = { now: startMs };

  const canceller = new OrderCanceller({
    db: t.db,
    orderRepo: t.orderRepo,
    tradeRepo: t.tradeRepo,
    getPolymarketAdapter: async () => poly,
  });
  const halts = new HaltService({
    riskStateRepo: t.riskStateRepo,
    botRepo: t.botRepo,
    audit,
    canceller,
    bots: { stopBot, runningBotIds: () => [...running] },
  });
  const killSwitch = new KillSwitch(halts);
  const monitor = new RiskMonitor({
    botRepo: t.botRepo,
    scriptRepo,
    tradeRepo: t.tradeRepo,
    riskStateRepo: t.riskStateRepo,
    audit,
    halts,
    killSwitch,
    getLimits: () => limits,
    getMark: async (exchange, symbol) => {
      const m = marks[`${exchange}:${symbol}`];
      if (m === undefined) throw new Error('no book');
      return m;
    },
    now: () => clock.now,
  });

  let orderSeq = 0;
  const engine = new RiskEngine({ limits, mandate: MandateSchema.parse({}) });

  return {
    ...t,
    scriptRepo,
    auditRepo,
    audit,
    poly,
    canceller,
    halts,
    killSwitch,
    monitor,
    running,
    stopBot,
    limits,
    marks,
    clock,
    addFill(botId, symbol, side, qty, price, atMs, simulated = false) {
      t.db
        .prepare(
          `INSERT INTO bot_trades (id, bot_id, side, exchange, symbol, condition_id, price, quantity, quote_amount, simulated, order_id, fee_usd, executed_at, created_at)
           VALUES (?, ?, ?, 'polymarket', ?, 'm1', ?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .run(`f-${++orderSeq}`, botId, side, symbol, price, qty, qty * price, simulated ? 1 : 0, `o-${orderSeq}`, new Date(atMs).toISOString(), new Date(atMs).toISOString());
    },
    addOpenOrder(botId, exchangeOrderId, opts = {}) {
      const row = t.orderRepo.create({
        botId,
        exchange: 'polymarket',
        marketId: 'm1',
        tokenId: opts.tokenId ?? 't1',
        side: 'buy',
        orderType: 'limit',
        price: 0.4,
        size: 10,
        notionalUsd: 4,
        status: 'open',
        // Cancel-only services use the real clock
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        exchangeOrderId,
        simulated: opts.simulated ?? false,
      });
      return row.id;
    },
    orderService(botId) {
      const provider = new DbRiskStateProvider({
        botRepo: t.botRepo,
        orderRepo: t.orderRepo,
        tradeRepo: t.tradeRepo,
        riskStateRepo: t.riskStateRepo,
        simulated: false,
        getCashUsd: async () => 1000,
        getEndDate: async () => MARKET.endDate,
        now: () => clock.now,
      });
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
          getBinanceBook: async () => ({ bids: [], asks: [] }),
          audit,
          now: () => clock.now,
        },
        { botId, botName: botId, scriptName: 'script', mode: 'live', polymarket: poly, binance: null, paperState: null }
      );
    },
  };
}
