/**
 * PortfolioService — the position manager's cross-bot view and its risk exits (spec §9.2, 5a; R161).
 *
 * Only a bot running the builtin Position Manager template gets an access object (`forBot`), bound to that
 * bot and its mode; BotManager decides that from the script row (`builtinRoleOf`), never from the script.
 *
 * Exits are placed AS THE OWNING BOT: the owner's own OrderService (the running one, else a transient one
 * built the same way) places a SELL flagged `riskExit`, so the order row, its fills, the position, the risk
 * check (`sell_position`: held net of open sells, scope, price range, slippage, halts) and the reconciler all
 * see the owner's order. `orders.placed_by` records the position manager. There is no buy path here.
 * Every exit request (placed, rejected or refused) and cancel is audited as the position manager
 * (`bot:<id>`), target the owning bot.
 */

import type { AuditService } from '../audit/AuditService';
import type { BotRepository } from '../db/repositories/BotRepository';
import type { BotTradeRepository } from '../db/repositories/BotTradeRepository';
import type { OrderRepository, OrderRow } from '../db/repositories/OrderRepository';
import { OPEN_ORDER_STATUSES } from '../db/repositories/OrderRepository';
import type { PositionExitFlagRepository, PositionExitFlagRow } from '../db/repositories/AgentRepository';
import type { MarketView } from '../ledger/MarketCacheService';
import type { BotForecastRow } from '../ledger/LedgerService';
import type { CapitalDemand, ExitRequest, PortfolioExitFlag, PortfolioPosition } from '../sdk/types';
import type { OrderResult, OrderService } from './OrderService';
import { parseDbTime } from './DbRiskStateProvider';
import { GTD_MIN_TTL_MINUTES } from '../exchange/polymarket/gtd';
import logger from '../utils/logger';

const QTY_EPS = 1e-9;
const MAX_REASON = 500;

/** ctx.portfolio as the RpcHandler sees it (arguments arrive unvalidated from the worker). */
export interface PortfolioAccess {
  getAllPositions(): Promise<PortfolioPosition[]>;
  getExitFlags(): Promise<PortfolioExitFlag[]>;
  getCapitalDemand(): Promise<CapitalDemand>;
  ackExitFlag(flagId: unknown, note: unknown): Promise<boolean>;
  exit(req: unknown): Promise<OrderResult>;
  cancelExit(orderId: unknown): Promise<void>;
}

export type ExitOrderService = Pick<OrderService, 'placeLimit' | 'placeMarketable' | 'cancel' | 'syncOpenOrders'>;

export interface PortfolioServiceDeps {
  botRepo: Pick<BotRepository, 'findById'>;
  tradeRepo: Pick<BotTradeRepository, 'getRiskPositions' | 'findRiskFills'>;
  orderRepo: Pick<OrderRepository, 'findOpen' | 'findById' | 'findOpenPlacedBy' | 'sumOpenSellSize' | 'lastBuyForecastId'>;
  flagRepo: Pick<PositionExitFlagRepository, 'list' | 'findById' | 'close'>;
  /** Forecast ledger: the forecast pricing a held token, and a forecast's status */
  ledger?: {
    heldTokenForecast(tokenId: string): { forecast: BotForecastRow; probability: number; onComplement: boolean } | null;
    getForecast(id: string): { status: string } | null;
  };
  /** Market cache (rules change, ambiguity after the raise, end date) */
  markets?: { getMarketByToken(tokenId: string): Promise<MarketView | null>; getCachedByToken(tokenId: string): MarketView | null };
  /** The owning bot's OrderService in this mode (its running one, else a transient one); throws if unavailable */
  getExitService(botId: string, simulated: boolean): Promise<ExitOrderService>;
  /** What the running forecast executor in this mode stored as its unfunded demand (bot storage); null if none */
  capitalDemand?: (simulated: boolean) => unknown;
  audit?: AuditService;
  now?: () => number;
}

class PortfolioError extends Error {}

export class PortfolioService {
  private deps: PortfolioServiceDeps;
  private now: () => number;

  /** Per owning bot: a transient OrderService and its PaperTradingState load-modify-save never overlap */
  private ownerTail = new Map<string, Promise<void>>();

  constructor(deps: PortfolioServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Run fn with the owning bot's exit service, serialised per owner and mode. */
  private async withOwner<T>(botId: string, simulated: boolean, fn: (svc: ExitOrderService) => Promise<T>): Promise<T> {
    const key = `${simulated ? 'paper' : 'live'}:${botId}`;
    const prev = this.ownerTail.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.ownerTail.set(key, tail);
    try {
      await prev;
      return await fn(await this.deps.getExitService(botId, simulated));
    } finally {
      release();
      if (this.ownerTail.get(key) === tail) this.ownerTail.delete(key);
    }
  }

  /** Access object for one position-manager bot (BotManager calls this only for that template). */
  forBot(callerBotId: string, simulated: boolean): PortfolioAccess {
    return {
      getAllPositions: () => this.getAllPositions(callerBotId, simulated),
      getExitFlags: async () => this.openFlags(simulated).map(toFlag),
      getCapitalDemand: async () => this.capitalDemand(simulated),
      ackExitFlag: async (flagId, note) => this.ackExitFlag(callerBotId, simulated, flagId, note),
      exit: (req) => this.exit(callerBotId, simulated, req),
      cancelExit: (orderId) => this.cancelExit(callerBotId, simulated, orderId),
    };
  }

  /** The executor's last reported unfunded demand, validated (it is bot-written data). */
  capitalDemand(simulated: boolean): CapitalDemand {
    let raw: unknown = null;
    try {
      raw = this.deps.capitalDemand?.(simulated) ?? null;
    } catch {
      raw = null;
    }
    const d = (raw && typeof raw === 'object' ? raw : {}) as { bestUnmetEdgePerDay?: unknown; at?: unknown };
    const v = typeof d.bestUnmetEdgePerDay === 'number' && Number.isFinite(d.bestUnmetEdgePerDay) && d.bestUnmetEdgePerDay > 0 ? d.bestUnmetEdgePerDay : null;
    const at = typeof d.at === 'string' && Number.isFinite(Date.parse(d.at)) ? d.at : null;
    return { bestUnmetEdgePerDay: v === null || at === null ? null : v, at };
  }

  private openFlags(simulated: boolean): PositionExitFlagRow[] {
    return this.deps.flagRepo.list({ status: 'open', limit: 1000 }).filter((f) => (f.simulated === 1) === simulated);
  }

  private async market(tokenId: string): Promise<MarketView | null> {
    const m = this.deps.markets;
    if (!m) return null;
    try {
      return await m.getMarketByToken(tokenId);
    } catch {
      return m.getCachedByToken(tokenId);
    }
  }

  /** Every bot's Polymarket position in this mode, with forecast, market state, open sells and exit flag. */
  async getAllPositions(callerBotId: string, simulated: boolean): Promise<PortfolioPosition[]> {
    // Pick up fills of exits placed earlier (paper resting fills happen on a sync; live via the exchange)
    const owners = new Set(this.deps.orderRepo.findOpenPlacedBy(callerBotId, simulated).map((o) => o.bot_id));
    for (const botId of owners) {
      try {
        await this.withOwner(botId, simulated, (svc) => svc.syncOpenOrders());
      } catch (err) {
        logger.warning(`[Portfolio] sync of ${botId}'s orders failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    const flags = this.openFlags(simulated);
    const rows = this.deps.tradeRepo.getRiskPositions({ simulated, exchange: 'polymarket' });
    const out: PortfolioPosition[] = [];
    for (const p of rows) {
      const open = this.deps.orderRepo.findOpen(p.bot_id, simulated).filter((o) => o.token_id === p.symbol && o.side === 'sell');
      const openSellSize = open.reduce((n, o) => n + Math.max(o.size - o.filled_size, 0), 0);
      const entryForecastId = this.deps.orderRepo.lastBuyForecastId(p.bot_id, p.symbol, simulated);
      const held = this.deps.ledger?.heldTokenForecast(p.symbol) ?? null;
      const m = await this.market(p.symbol);
      const flag = flags.find((f) => f.bot_id === p.bot_id && f.token_id === p.symbol);
      out.push({
        botId: p.bot_id,
        botName: this.deps.botRepo.findById(p.bot_id)?.name ?? null,
        tokenId: p.symbol,
        marketId: p.condition_id,
        size: p.net_quantity,
        openSellSize,
        available: Math.max(p.net_quantity - openSellSize, 0),
        avgPrice: p.net_quantity > 0 ? p.cost_basis / p.net_quantity : 0,
        costBasis: p.cost_basis,
        openedAt: this.openedAt(p.bot_id, p.symbol, simulated),
        entryForecastId,
        entryForecastStatus: entryForecastId ? (this.deps.ledger?.getForecast(entryForecastId)?.status ?? null) : null,
        forecast: held
          ? { id: held.forecast.id, probability: held.probability, onComplement: held.onComplement, tradeable: held.forecast.tradeableNow, createdAt: held.forecast.createdAt }
          : null,
        market: m
          ? {
              question: m.question,
              outcome: m.tokens.find((t) => t.tokenId === p.symbol)?.outcome ?? null,
              category: m.category,
              endDate: m.endDate,
              ambiguityScore: m.ambiguityScore,
              rulesChangedAt: m.rulesChangedAt,
              disputed: m.disputed,
              closed: m.closed,
            }
          : null,
        exitOrders: open.map((o) => ({
          orderId: o.id,
          orderType: o.order_type as 'limit' | 'market',
          price: o.price,
          size: o.size,
          filledSize: o.filled_size,
          status: o.status,
          placedByMe: o.placed_by === callerBotId,
          createdAt: o.created_at,
          expiresAt: o.expires_at,
        })),
        exitFlag: flag ? toFlag(flag) : null,
      });
    }
    return out;
  }

  /** First buy after the position was last flat (same rule as the risk provider's hold time). */
  private openedAt(botId: string, tokenId: string, simulated: boolean): string | null {
    let running = 0;
    let at: number | null = null;
    for (const f of this.deps.tradeRepo.findRiskFills(botId, tokenId, simulated)) {
      const qty = f.quantity ?? 0;
      if (f.side === 'BUY') {
        if (running <= QTY_EPS) at = parseDbTime(f.executed_at);
        running += qty;
      } else {
        running = Math.max(0, running - qty);
      }
    }
    return at !== null && Number.isFinite(at) ? new Date(at).toISOString() : null;
  }

  private audit(callerBotId: string, action: string, target: string | null, payload: Record<string, unknown>, result: string): void {
    this.deps.audit?.record(`bot:${callerBotId}`, action, target, payload, result);
  }

  /** Risk-exit SELL placed as the owning bot. Refusals (bad input, no position, too large) throw and are audited. */
  async exit(callerBotId: string, simulated: boolean, raw: unknown): Promise<OrderResult> {
    const req = (raw && typeof raw === 'object' ? raw : {}) as Partial<ExitRequest> & Record<string, unknown>;
    const botId = typeof req.botId === 'string' ? req.botId : '';
    const tokenId = typeof req.tokenId === 'string' ? req.tokenId : '';
    const base = { tokenId, size: req.size ?? null, price: req.price ?? null, marketable: req.marketable === true, simulated };
    try {
      if (!botId || !tokenId) throw new PortfolioError('botId and tokenId are required');
      if (typeof req.size !== 'number' || !Number.isFinite(req.size) || req.size <= 0) throw new PortfolioError('size must be a positive number');
      if (req.price !== undefined && (typeof req.price !== 'number' || !Number.isFinite(req.price) || req.price <= 0 || req.price >= 1)) {
        throw new PortfolioError('price must be between 0 and 1');
      }
      if (req.marketable !== true && req.price === undefined) throw new PortfolioError('a resting exit needs a price');
      if (req.ttlMinutes !== undefined && (typeof req.ttlMinutes !== 'number' || !(req.ttlMinutes >= GTD_MIN_TTL_MINUTES))) {
        throw new PortfolioError(`ttlMinutes must be at least ${GTD_MIN_TTL_MINUTES}`);
      }
      const why = typeof req.reason === 'string' ? req.reason.trim() : '';
      if (!why) throw new PortfolioError('reason is required');
      if (!this.deps.botRepo.findById(botId)) throw new PortfolioError(`Unknown bot ${botId}`);

      const position = this.deps.tradeRepo
        .getRiskPositions({ simulated, botId, exchange: 'polymarket' })
        .find((p) => p.symbol === tokenId);
      if (!position) throw new PortfolioError(`Bot ${botId} holds no ${simulated ? 'paper' : 'live'} position in token ${tokenId}`);
      const openSells = this.deps.orderRepo.sumOpenSellSize(botId, tokenId, simulated);
      const available = position.net_quantity - openSells;
      if (req.size > available + QTY_EPS) {
        throw new PortfolioError(`exit of ${req.size} exceeds what the bot can sell: ${Math.max(available, 0)} (held ${position.net_quantity}, open sells ${openSells})`);
      }

      const reason = `position manager: ${why}`.slice(0, MAX_REASON);
      const size = req.size;
      const result = await this.withOwner(botId, simulated, (service) =>
        req.marketable === true
          ? service.placeMarketable({ tokenId, side: 'sell', amount: size, minPrice: req.price, riskExit: true, reason, placedBy: callerBotId })
          : service.placeLimit({
              tokenId,
              side: 'sell',
              price: req.price as number,
              size,
              postOnly: true,
              ttlMinutes: req.ttlMinutes,
              riskExit: true,
              reason,
              placedBy: callerBotId,
            })
      );
      this.audit(
        callerBotId,
        'position.exit',
        botId,
        { ...base, marketId: position.condition_id, held: position.net_quantity, orderId: result.orderId, status: result.status, ...(result.failedCheck ? { failedCheck: result.failedCheck } : {}), reason: why.slice(0, MAX_REASON) },
        result.ok ? 'ok' : String(result.status)
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit(callerBotId, 'position.exit', botId || null, { ...base, error: message }, `denied: ${message.slice(0, 200)}`);
      throw err;
    }
  }

  /** Cancel an open exit this position manager placed (as the owning bot). */
  async cancelExit(callerBotId: string, simulated: boolean, orderId: unknown): Promise<void> {
    const row: OrderRow | undefined = typeof orderId === 'string' && orderId ? this.deps.orderRepo.findById(orderId) : undefined;
    if (!row || row.placed_by !== callerBotId || (row.simulated === 1) !== simulated || !OPEN_ORDER_STATUSES.includes(row.status)) {
      throw new Error(`Exit order not found or not open: ${String(orderId)}`);
    }
    try {
      await this.withOwner(row.bot_id, simulated, (svc) => svc.cancel(row.id, { placedBy: callerBotId }));
      this.audit(callerBotId, 'position.exit_cancel', row.bot_id, { orderId: row.id, tokenId: row.token_id, simulated }, 'ok');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit(callerBotId, 'position.exit_cancel', row.bot_id, { orderId: row.id, tokenId: row.token_id, simulated, error: message }, 'error');
      throw err;
    }
  }

  /** Close an open exit flag in this mode as handled. */
  ackExitFlag(callerBotId: string, simulated: boolean, flagId: unknown, note: unknown): boolean {
    const flag = typeof flagId === 'string' && flagId ? this.deps.flagRepo.findById(flagId) : undefined;
    if (!flag || flag.status !== 'open' || (flag.simulated === 1) !== simulated) {
      throw new Error(`Exit flag not found or not open: ${String(flagId)}`);
    }
    const text = typeof note === 'string' && note.trim() ? note.trim().slice(0, 1000) : 'handled';
    const closed = this.deps.flagRepo.close(flag.id, 'done', `${text} (position manager ${callerBotId})`, new Date(this.now()).toISOString());
    if (closed) this.audit(callerBotId, 'position.exit_flag_done', flag.bot_id, { flagId: flag.id, tokenId: flag.token_id, note: text }, 'ok');
    return closed;
  }
}

function toFlag(f: PositionExitFlagRow): PortfolioExitFlag {
  return { id: f.id, botId: f.bot_id, tokenId: f.token_id, marketId: f.market_id, reason: f.reason, createdBy: f.created_by, createdAt: f.created_at };
}
