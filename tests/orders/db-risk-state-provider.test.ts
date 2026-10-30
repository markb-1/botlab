import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteAvailable, openTestDb, type TestDb } from './db';
import { DbRiskStateProvider } from '../../electron/orders/DbRiskStateProvider';
import type { OrderRequest } from '../../electron/risk/types';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe.skipIf(!sqliteAvailable)('DbRiskStateProvider', () => {
  let t: TestDb;
  let endDates: Record<string, string | null>;

  function provider(simulated = false, cash: () => Promise<number> = async () => 1000) {
    return new DbRiskStateProvider({
      botRepo: t.botRepo,
      orderRepo: t.orderRepo,
      tradeRepo: t.tradeRepo,
      riskStateRepo: t.riskStateRepo,
      simulated,
      getCashUsd: cash,
      getEndDate: async (tokenId) => endDates[tokenId] ?? null,
      now: () => NOW,
    });
  }

  function order(o: Partial<OrderRequest> = {}): OrderRequest {
    return {
      botId: 'bot-1', exchange: 'polymarket', marketId: 'm1', tokenId: 't1', side: 'buy', orderType: 'limit',
      price: 0.5, size: 10, notionalUsd: 5, forecast: null, market: null, ...o,
    };
  }

  /** A fill recorded by OrderService (has an order id). */
  function fill(botId: string, symbol: string, side: 'BUY' | 'SELL', qty: number, price: number, extra: Record<string, unknown> = {}) {
    return t.tradeRepo.create({
      botId, exchange: 'polymarket', side, symbol, conditionId: 'm1', price, quantity: qty, quoteAmount: qty * price,
      orderId: `o-${Math.random()}`, simulated: 0, ...extra,
    });
  }

  function openOrder(botId: string, o: Partial<Parameters<TestDb['orderRepo']['create']>[0]> & { filled?: number }) {
    const row = t.orderRepo.create({
      botId, exchange: 'polymarket', marketId: 'm1', tokenId: 't1', side: 'buy', orderType: 'limit',
      price: 0.5, size: 20, notionalUsd: 10, status: 'open', ...o,
    });
    if (o.filled) t.orderRepo.update(row.id, { filledSize: o.filled });
    return row;
  }

  beforeEach(() => {
    t = openTestDb();
    t.addBot('bot-1');
    t.addBot('bot-2');
    endDates = { t1: iso(NOW + 10 * DAY), t2: iso(NOW + 10 * DAY), t9: iso(NOW + 60 * DAY) };
  });
  afterEach(() => t.close());

  it('exposure = cost basis of open positions + unfilled open buy notional', async () => {
    // bot-1: bought 100 @ 0.40 and 100 @ 0.60 (avg 0.50), sold 50 ⇒ 150 held, cost basis 75
    fill('bot-1', 't1', 'BUY', 100, 0.4);
    fill('bot-1', 't1', 'BUY', 100, 0.6);
    fill('bot-1', 't1', 'SELL', 50, 0.7);
    // bot-1 Binance: 0.001 BTC for $30 (counts toward bot and total, not market)
    fill('bot-1', 'BTCUSDT', 'BUY', 0.001, 30_000, { exchange: 'binance', conditionId: undefined });
    // bot-2: open buy, $10 notional, 25% filled ⇒ $7.50 open; plus a 60-day market
    openOrder('bot-2', { notionalUsd: 10, size: 20, filled: 5 });
    openOrder('bot-2', { marketId: 'm9', tokenId: 't9', notionalUsd: 4, size: 8 });

    // Not exposure: rejected/filled/cancelled orders, open sells, paper and script-written trades
    openOrder('bot-1', { status: 'rejected_risk', notionalUsd: 100 });
    openOrder('bot-1', { status: 'cancelled', notionalUsd: 100 });
    openOrder('bot-1', { side: 'sell', notionalUsd: 100, size: 30 });
    openOrder('bot-1', { notionalUsd: 100, simulated: true });
    fill('bot-1', 't1', 'BUY', 1000, 0.5, { simulated: 1 });
    t.tradeRepo.create({ botId: 'bot-1', exchange: 'polymarket', side: 'BUY', symbol: 't1', conditionId: 'm1', price: 0.5, quantity: 1000, quoteAmount: 500 });

    const snap = await provider().getSnapshot(order());
    expect(snap.exposure.botUsd).toBeCloseTo(75); // Polymarket only for a Polymarket order
    expect(snap.exposure.marketUsd).toBeCloseTo(75 + 7.5);
    expect(snap.exposure.totalUsd).toBeCloseTo(75 + 30 + 7.5 + 4);
    expect(snap.exposure.longHorizonUsd).toBeCloseTo(4);
    expect(snap.equityUsd).toBeCloseTo(1000 + 75 + 30);
    expect(snap.openOrdersCount).toBe(3); // two bot-2 buys + bot-1 sell (live only)

    const binanceSnap = await provider().getSnapshot(order({ exchange: 'binance', marketId: 'BTCUSDT', tokenId: 'BTCUSDT' }));
    expect(binanceSnap.exposure.botUsd).toBeCloseTo(30);
    expect(binanceSnap.exposure.marketUsd).toBe(0);
  });

  it('unknown end dates count as long horizon (fail closed)', async () => {
    endDates = {};
    fill('bot-1', 't1', 'BUY', 20, 0.5);
    const snap = await provider().getSnapshot(order());
    expect(snap.exposure.longHorizonUsd).toBeCloseTo(10);
  });

  it('sell position: net size, open sells netted, opened at first buy since flat', async () => {
    const at = (ms: number, r: { id: string }) => t.db.prepare('UPDATE bot_trades SET executed_at = ? WHERE id = ?').run(iso(ms), r.id);
    at(NOW - 5 * DAY, fill('bot-1', 't1', 'BUY', 10, 0.5));
    at(NOW - 4 * DAY, fill('bot-1', 't1', 'SELL', 10, 0.6)); // flat
    at(NOW - 60 * 60_000, fill('bot-1', 't1', 'BUY', 30, 0.5));
    at(NOW - 30 * 60_000, fill('bot-1', 't1', 'BUY', 10, 0.5));
    openOrder('bot-1', { side: 'sell', size: 20, filled: 5 });
    openOrder('bot-2', { side: 'sell', size: 20 }); // other bot's sell does not net

    const snap = await provider().getSnapshot(order({ side: 'sell', size: 5 }));
    expect(snap.position).toEqual({ size: 40, openSellSize: 15, openedAt: NOW - 60 * 60_000 });
    expect(await provider().getSnapshot(order({ botId: 'bot-2', side: 'sell' }))).toMatchObject({ position: null });
  });

  it('cash failure ⇒ NaN equity', async () => {
    const snap = await provider(false, async () => {
      throw new Error('rpc down');
    }).getSnapshot(order());
    expect(Number.isNaN(snap.equityUsd)).toBe(true);
  });

  it('reads halts, scope and stage; paper treats stage paper as full and is scoped to the bot', async () => {
    t.addBot('p', { stage: 'paper', market_ids: '["m1"]', strategy: 'forecast', allocation_usd: 40 });
    t.addBot('bad', { market_ids: 'not json' });
    t.riskStateRepo.setHalted('global', true, 'kill switch');
    t.riskStateRepo.setHalted('p', true, 'loss');
    fill('bot-2', 't1', 'BUY', 100, 0.5); // live, other bot

    const live = await provider().getSnapshot(order({ botId: 'p' }));
    expect(live).toMatchObject({ globalHalted: true, globalHaltReason: 'kill switch' });
    expect(live.bot).toMatchObject({ stage: 'paper', halted: true, marketIds: ['m1'], strategy: 'forecast', allocationUsd: 40 });
    expect(live.exposure.totalUsd).toBeCloseTo(50);

    const paper = await provider(true).getSnapshot(order({ botId: 'p' }));
    expect(paper.bot?.stage).toBe('full');
    expect(paper.exposure.totalUsd).toBe(0); // live fills of other bots are not in a paper bot's scope

    expect((await provider().getSnapshot(order({ botId: 'bad' }))).bot?.marketIds).toEqual([]);
    expect((await provider().getSnapshot(order({ botId: 'nope' }))).bot).toBeNull();
  });

  it('counts this bot\'s attempts in the last hour, including rejections', async () => {
    const setCreated = (id: string, ms: number) => t.db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(iso(ms), id);
    setCreated(openOrder('bot-1', { status: 'rejected_risk' }).id, NOW - 10 * 60_000);
    setCreated(openOrder('bot-1', { status: 'filled' }).id, NOW - 30 * 60_000);
    setCreated(openOrder('bot-1', { status: 'filled' }).id, NOW - 2 * 3_600_000); // too old
    setCreated(openOrder('bot-2', { status: 'filled' }).id, NOW - 10 * 60_000); // other bot
    const snap = await provider().getSnapshot(order());
    expect(snap.botOrdersLastHour).toBe(2);
  });
});
