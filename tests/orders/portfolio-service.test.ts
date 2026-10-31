/**
 * PortfolioService (5a, R161): the position manager's cross-bot exits are SELLS placed as the owning bot through
 * its OrderService (risk-exit), attributed (orders.bot_id = owner, placed_by = manager), audited, scoped to the
 * manager's mode, never larger than held net of open sells; exit flags are acknowledged; only a bot running the
 * builtin position-manager template gets ctx.portfolio (RPC rejected otherwise) and that bot cannot buy.
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
import { PortfolioService } from '../../packages/core/src/orders/PortfolioService';
import type { MarketInfo, MarketQualityProvider } from '../../packages/core/src/orders/MarketDataService';
import { PaperTradingState } from '../../packages/core/src/runtime/PaperTradingState';
import { PositionExitFlagRepository } from '../../packages/core/src/db/repositories/AgentRepository';
import { AuditRepository } from '../../packages/core/src/db/repositories/AuditRepository';
import { AuditService } from '../../packages/core/src/audit/AuditService';
import { RpcHandler, type RpcHandlerDeps } from '../../packages/core/src/runtime/RpcHandler';
import { ScriptRepository, builtinRoleOf } from '../../packages/core/src/db/repositories/ScriptRepository';
import { seedTemplates, getBuiltinTemplates } from '../../packages/core/src/db/seed';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const DAY = 86_400_000;
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
const BOOK: ClobBook = { bids: [{ price: '0.49', size: '1000' }], asks: [{ price: '0.51', size: '1000' }], tick_size: '0.01' };

describe.skipIf(!sqliteAvailable)('PortfolioService', () => {
  let t: TestDb;
  let flags: PositionExitFlagRepository;
  let auditRepo: AuditRepository;
  let portfolio: PortfolioService;
  const states = new Map<string, PaperTradingState>();
  const services = new Map<string, OrderService>();
  const engine = new RiskEngine({ limits: LimitsSchema.parse({}), mandate: MandateSchema.parse({}) });

  function service(botId: string): OrderService {
    let svc = services.get(botId);
    if (svc) return svc;
    const ps = states.get(botId) ?? new PaperTradingState(botId, 1000, t.storageRepo);
    states.set(botId, ps);
    const provider = new DbRiskStateProvider({
      botRepo: t.botRepo,
      orderRepo: t.orderRepo,
      tradeRepo: t.tradeRepo,
      riskStateRepo: t.riskStateRepo,
      simulated: true,
      getCashUsd: async () => ps.getBalance(),
      getEndDate: async () => MARKET.endDate,
      now: () => NOW,
    });
    svc = new OrderService(
      {
        db: t.db,
        orderRepo: t.orderRepo,
        tradeRepo: t.tradeRepo,
        riskEngine: engine,
        provider,
        fees: new FeeService(),
        marketData: { getMarketInfo: async (id: string) => (MARKET.tokenIds.includes(id) ? MARKET : null) },
        quality: ASSESSED,
        getBook: async () => BOOK,
        getBinanceBook: async () => ({ bids: [], asks: [] }),
        audit: new AuditService(auditRepo),
        now: () => NOW,
      },
      { botId, botName: botId, scriptName: 'script', mode: 'paper', paperState: ps }
    );
    services.set(botId, svc);
    return svc;
  }

  beforeEach(async () => {
    t = openTestDb();
    states.clear();
    services.clear();
    flags = new PositionExitFlagRepository(t.db);
    auditRepo = new AuditRepository(t.db);
    t.addBot('owner', { stage: 'paper' });
    t.addBot('other', { stage: 'paper' });
    t.addBot('pm', { stage: 'paper' });
    portfolio = new PortfolioService({
      botRepo: t.botRepo,
      tradeRepo: t.tradeRepo,
      orderRepo: t.orderRepo,
      flagRepo: flags,
      audit: new AuditService(auditRepo),
      getExitService: async (botId, simulated) => {
        if (!simulated) throw new Error('live not used here');
        return service(botId);
      },
      now: () => NOW,
    });
    // owner buys 40 shares of t1 (paper)
    expect((await service('owner').placeMarketable({ tokenId: 't1', side: 'buy', amount: 20 })).filledSize).toBeCloseTo(39.2157, 3);
  });

  afterEach(() => t.close());

  const held = () => t.tradeRepo.getRiskPositions({ simulated: true, botId: 'owner' })[0]?.net_quantity ?? 0;

  it('lists positions across bots in its own mode only', async () => {
    const access = portfolio.forBot('pm', true);
    const list = await access.getAllPositions();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ botId: 'owner', tokenId: 't1', marketId: 'm1', openSellSize: 0, entryForecastId: null, exitOrders: [] });
    expect(list[0].available).toBeCloseTo(held());
    expect(await portfolio.forBot('pm', false).getAllPositions()).toHaveLength(0); // a live manager sees no paper positions
  });

  it('places the exit as the owning bot, attributed to the manager and audited', async () => {
    const access = portfolio.forBot('pm', true);
    const size = Math.floor(held() * 100) / 100;
    const r = await access.exit({ botId: 'owner', tokenId: 't1', size, price: 0.55, reason: 'take profit' });
    expect(r).toMatchObject({ ok: true, status: 'open' });
    const row = t.orderRepo.findById(r.orderId!)!;
    expect(row).toMatchObject({ bot_id: 'owner', side: 'sell', placed_by: 'pm', simulated: 1 });
    expect(row.reason).toBe('position manager: take profit');
    expect(JSON.parse(row.risk_decision!).checks.find((c: { name: string }) => c.name === 'hold_time').detail).toMatch(/Risk exit/);
    const audit = auditRepo.list({ action: 'position.exit' }) as Array<{ actor: string; target: string; result: string }>;
    expect(audit.some((a) => a.actor === 'bot:pm' && a.target === 'owner' && a.result === 'ok')).toBe(true);

    const pos = (await access.getAllPositions())[0];
    expect(pos.exitOrders).toEqual([expect.objectContaining({ orderId: r.orderId, placedByMe: true, price: 0.55 })]);
    expect(pos.available).toBeCloseTo(held() - size);
  });

  it('never sells more than held net of open sells (refused, audited) and cannot be turned into a buy', async () => {
    const access = portfolio.forBot('pm', true);
    await expect(access.exit({ botId: 'owner', tokenId: 't1', size: held() + 1, price: 0.55, reason: 'x' })).rejects.toThrow(/exceeds what the bot can sell/);
    await access.exit({ botId: 'owner', tokenId: 't1', size: 30, price: 0.55, reason: 'part' });
    await expect(access.exit({ botId: 'owner', tokenId: 't1', size: 10, price: 0.56, reason: 'more' })).rejects.toThrow(/exceeds/);
    // A bot without the position
    await expect(access.exit({ botId: 'other', tokenId: 't1', size: 1, price: 0.55, reason: 'x' })).rejects.toThrow(/holds no paper position/);
    // `side` is not an input: an exit is always a sell
    const r = await access.exit({ botId: 'owner', tokenId: 't1', size: 1, price: 0.55, reason: 'x', side: 'buy' } as never);
    expect(t.orderRepo.findById(r.orderId!)!.side).toBe('sell');
    const denied = auditRepo.list({ action: 'position.exit' }) as Array<{ result: string }>;
    expect(denied.filter((a) => a.result.startsWith('denied')).length).toBe(3);
    expect(t.tradeRepo.getRiskPositions({ simulated: true, botId: 'pm' })).toHaveLength(0);
  });

  it('a marketable exit sells at the bid as the owner; cancelExit only touches its own exits', async () => {
    const access = portfolio.forBot('pm', true);
    // owner's own resting sell: not cancellable by the manager
    const own = await service('owner').placeLimit({ tokenId: 't1', side: 'sell', price: 0.6, size: 5, riskExit: true });
    await expect(access.cancelExit(own.orderId!)).rejects.toThrow(/not found/);
    const r = await access.exit({ botId: 'owner', tokenId: 't1', size: 10, marketable: true, reason: 'flag' });
    expect(r).toMatchObject({ ok: true, status: 'filled' });
    expect(r.avgFillPrice).toBeCloseTo(0.49);
    const resting = await access.exit({ botId: 'owner', tokenId: 't1', size: 5, price: 0.58, reason: 'tp' });
    await access.cancelExit(resting.orderId!);
    expect(t.orderRepo.findById(resting.orderId!)!.status).toBe('cancelled');
    expect(t.orderRepo.findById(own.orderId!)!.status).toBe('open');
  });

  it('exit flags: listed per mode, acknowledged as done once', async () => {
    const f = flags.create({ botId: 'owner', tokenId: 't1', marketId: 'm1', simulated: true, reason: 'thesis broken', createdBy: 'agent', at: new Date(NOW).toISOString() });
    flags.create({ botId: 'owner', tokenId: 't9', marketId: 'm9', simulated: false, reason: 'live one', createdBy: 'agent', at: new Date(NOW).toISOString() });
    const access = portfolio.forBot('pm', true);
    expect((await access.getExitFlags()).map((x) => x.id)).toEqual([f.id]);
    expect((await access.getAllPositions())[0].exitFlag).toMatchObject({ id: f.id, reason: 'thesis broken' });
    expect(await access.ackExitFlag(f.id, 'exited')).toBe(true);
    expect(flags.findById(f.id)).toMatchObject({ status: 'done' });
    expect(flags.findById(f.id)!.handled_note).toMatch(/exited/);
    await expect(access.ackExitFlag(f.id, 'again')).rejects.toThrow(/not open/);
  });

  it('capital demand: the executor\'s report is validated (bot-written data)', async () => {
    const make = (raw: unknown) =>
      new PortfolioService({ botRepo: t.botRepo, tradeRepo: t.tradeRepo, orderRepo: t.orderRepo, flagRepo: flags, getExitService: async () => service('owner'), capitalDemand: () => raw }).forBot('pm', true);
    expect(await make(null).getCapitalDemand()).toEqual({ bestUnmetEdgePerDay: null, at: null });
    expect(await make({ bestUnmetEdgePerDay: 'lots', at: 'x' }).getCapitalDemand()).toEqual({ bestUnmetEdgePerDay: null, at: null });
    expect(await make({ bestUnmetEdgePerDay: 0.004, at: '2026-06-01T00:00:00.000Z' }).getCapitalDemand()).toEqual({ bestUnmetEdgePerDay: 0.004, at: '2026-06-01T00:00:00.000Z' });
  });

  describe('RPC scoping', () => {
    function handler(extra: Partial<RpcHandlerDeps>): RpcHandler {
      return new RpcHandler({
        clobClient: {} as never,
        storageRepo: t.storageRepo,
        tradeRepo: t.tradeRepo,
        botId: 'x',
        botName: 'x',
        scriptName: 's',
        walletAddress: '0x',
        rpcUrl: '',
        usdcContractAddress: '',
        clobHttpUrl: '',
        orderService: service('pm'),
        ...extra,
      });
    }
    const call = (h: RpcHandler, method: string, args: unknown[] = []) => h.handle({ id: '1', method: method as never, args });

    it('a bot that is not the builtin position manager cannot call ctx.portfolio', async () => {
      const h = handler({ role: 'forecast-executor' });
      for (const m of ['portfolio:getAllPositions', 'portfolio:getExitFlags', 'portfolio:exit', 'portfolio:cancelExit', 'portfolio:ackExitFlag']) {
        expect((await call(h, m, [{ botId: 'owner', tokenId: 't1', size: 1, price: 0.5, reason: 'x' }])).error).toMatch(/only available to bots running the builtin Position Manager/);
      }
      expect(t.orderRepo.findOpen('owner', true).filter((o) => o.side === 'sell')).toHaveLength(0);
    });

    it('the position manager gets ctx.portfolio and cannot buy', async () => {
      const h = handler({ role: 'position-manager', portfolio: portfolio.forBot('pm', true) });
      expect((await call(h, 'portfolio:getAllPositions')).result).toHaveLength(1);
      expect((await call(h, 'polymarket:buy', ['t1', 5])).error).toMatch(/cannot buy/);
      expect((await call(h, 'polymarket:placeLimit', ['t1', 'buy', 0.4, 10])).error).toMatch(/cannot buy/);
      expect((await call(h, 'binance:buy', ['BTCUSDT', 5])).error).toMatch(/cannot buy/);
      expect(t.orderRepo.findOpen('pm', true)).toHaveLength(0);
    });
  });

  it('seeds the standing templates as builtin, trust new, with their role; other scripts get no role', async () => {
    const scripts = new ScriptRepository(t.db);
    const log = console.log;
    console.log = () => {};
    try {
      await seedTemplates(scripts, getBuiltinTemplates());
    } finally {
      console.log = log;
    }
    const pm = scripts.findAll().find((s) => s.name === 'Position Manager')!;
    const ex = scripts.findAll().find((s) => s.name === 'Forecast Executor')!;
    expect(pm).toMatchObject({ origin: 'builtin', trust: 'new', is_template: 1 });
    expect(builtinRoleOf(pm)).toBe('position-manager');
    expect(builtinRoleOf(ex)).toBe('forecast-executor');
    expect(ex.trust).toBe('new');
    expect(scripts.findAll().find((s) => s.name === 'Binance Spot Trading' || s.name.startsWith('Binance'))!.trust).toBe('proven');
    // Copy Trading v2 (5c) is new code: trust new, strategy role copy
    const copyTpl = scripts.findAll().find((s) => s.name === 'Copy Trading')!;
    expect(copyTpl.trust).toBe('new');
    expect(builtinRoleOf(copyTpl)).toBe('copy');
    // A human copy of the source (same meta) has no role: the role is never read from a script
    const copy = scripts.create({ name: 'Position Manager (copy)', source: pm.source, origin: 'human' });
    scripts.setBuiltinRole(copy.id, 'position-manager');
    expect(builtinRoleOf(scripts.findById(copy.id))).toBeNull();
  });
});
