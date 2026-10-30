/**
 * DbRiskStateProvider — builds the RiskEngine's state snapshot from SQLite (spec §4.1).
 *
 * Exposure = cost basis of open positions + unfilled notional of open buy orders (§3.1).
 * - Positions come from `bot_trades` rows written by OrderService (`order_id IS NOT NULL`);
 *   cost basis = average buy price × net quantity.
 * - Open buy orders come from `orders` (submitted / open / partially_filled).
 * - Binance exposure (USDT-quoted, USDT taken as 1 USD) counts toward the bot and total
 *   exposure, so global limits cover everything live; market and long-horizon exposure are
 *   Polymarket-only.
 *
 * Live mode (`simulated: false`) aggregates all live bots. Paper mode (`simulated: true`)
 * looks only at the ordering bot's paper orders and fills, so each paper bot behaves like
 * a live bot with the same limits; its `paper` stage is treated as `full`.
 *
 * Equity = cash (from `getCashUsd`, cached) + cost basis of open positions in scope.
 * If cash cannot be read the equity is NaN, which the engine rejects as `state_invalid`.
 */

import type { BotRepository } from '../database/repositories/BotRepository';
import type { BotTradeRepository, RiskPositionRow } from '../database/repositories/BotTradeRepository';
import type { OrderRepository, OrderRow } from '../database/repositories/OrderRepository';
import { GLOBAL_SCOPE, type RiskStateRepository } from '../database/repositories/RiskStateRepository';
import { daysToSettlement, isLongHorizon } from '../risk/RiskEngine';
import type { BotRiskInfo, BotStage, Exchange, OrderRequest, RiskStateProvider, RiskStateSnapshot } from '../risk/types';

const HOUR_MS = 3_600_000;
const DEFAULT_CASH_CACHE_MS = 30_000;
const QTY_EPS = 1e-9;
/** External lookups run inside the placement lock, so they must not hang */
const LOOKUP_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface DbRiskStateProviderDeps {
  botRepo: Pick<BotRepository, 'findById'>;
  orderRepo: OrderRepository;
  tradeRepo: BotTradeRepository;
  riskStateRepo: RiskStateRepository;
  /** true = paper bot: only this bot's simulated orders/fills */
  simulated: boolean;
  /** Free cash in USD for equity; throw if unavailable */
  getCashUsd: (exchange: Exchange) => Promise<number>;
  /** Market end date for a Polymarket token (long-horizon exposure); null = unknown */
  getEndDate: (tokenId: string) => Promise<string | null>;
  /**
   * Paper only: the paper simulator's holding, used when the bot has no recorded fills
   * for the token (positions opened before OrderService existed). null = none.
   */
  getPaperPositionSize?: (exchange: Exchange, tokenId: string) => number | null;
  now?: () => number;
  cashCacheMs?: number;
}

/** Exposure breakdown used by the snapshot and by ctx.risk.getBudget(). */
export interface ExposureSummary {
  /** This bot, per exchange */
  botUsd: Record<Exchange, number>;
  /** Polymarket condition id → exposure across bots in scope */
  marketUsd: Map<string, number>;
  totalUsd: number;
  /** Positions in scope (for equity and long-horizon) */
  positions: RiskPositionRow[];
  openBuys: OrderRow[];
}

/** Unfilled notional of an open buy order. */
export function unfilledNotional(o: OrderRow): number {
  if (!(o.size > 0)) return o.notional_usd;
  return o.notional_usd * (1 - Math.min(Math.max(o.filled_size, 0), o.size) / o.size);
}

/** Parse SQLite ISO or `YYYY-MM-DD HH:MM:SS` (UTC) timestamps. */
export function parseDbTime(ts: string): number {
  const iso = ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

export class DbRiskStateProvider implements RiskStateProvider {
  private deps: DbRiskStateProviderDeps;
  private now: () => number;
  private cashCache = new Map<Exchange, { value: number; at: number }>();

  constructor(deps: DbRiskStateProviderDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Bot row as the engine sees it; null when the bot does not exist. */
  getBotInfo(botId: string): BotRiskInfo | null {
    const row = this.deps.botRepo.findById(botId);
    if (!row) return null;

    let marketIds: string[] | null = null;
    if (row.market_ids !== null && row.market_ids !== undefined) {
      try {
        const parsed = JSON.parse(row.market_ids) as unknown;
        // Anything but an array of strings scopes the bot to nothing (fail closed)
        marketIds = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        marketIds = [];
      }
    }

    let stage = (row.stage || 'full') as BotStage;
    // Paper orders never reach an exchange: the paper stage gets the full limits
    if (this.deps.simulated && stage === 'paper') stage = 'full';

    const halt = this.deps.riskStateRepo.get(botId);
    return {
      id: row.id,
      stage,
      allocationUsd: row.allocation_usd ?? null,
      marketIds,
      halted: halt?.halted === 1,
      haltReason: halt?.halted_reason ?? null,
      strategy: row.strategy ?? null,
    };
  }

  isGloballyHalted(): { halted: boolean; reason: string | null } {
    const g = this.deps.riskStateRepo.get(GLOBAL_SCOPE);
    return { halted: g?.halted === 1, reason: g?.halted_reason ?? null };
  }

  computeExposure(botId: string): ExposureSummary {
    const { simulated } = this.deps;
    const scopeBot = simulated ? botId : undefined;
    const positions = this.deps.tradeRepo.getRiskPositions({ simulated, botId: scopeBot });
    const openBuys = this.deps.orderRepo.findOpen(scopeBot, simulated).filter((o) => o.side === 'buy');

    const botUsd: Record<Exchange, number> = { polymarket: 0, binance: 0 };
    const marketUsd = new Map<string, number>();
    let totalUsd = 0;
    const addMarket = (marketId: string | null, usd: number) => {
      if (!marketId) return;
      marketUsd.set(marketId, (marketUsd.get(marketId) ?? 0) + usd);
    };

    for (const p of positions) {
      const ex = p.exchange === 'binance' ? 'binance' : 'polymarket';
      totalUsd += p.cost_basis;
      if (p.bot_id === botId) botUsd[ex] += p.cost_basis;
      if (ex === 'polymarket') addMarket(p.condition_id, p.cost_basis);
    }
    for (const o of openBuys) {
      const usd = unfilledNotional(o);
      const ex = o.exchange === 'binance' ? 'binance' : 'polymarket';
      totalUsd += usd;
      if (o.bot_id === botId) botUsd[ex] += usd;
      if (ex === 'polymarket') addMarket(o.market_id, usd);
    }

    return { botUsd, marketUsd, totalUsd, positions, openBuys };
  }

  /** Polymarket exposure in markets settling in > 30 days; unknown end date counts as long (fail closed). */
  async computeLongHorizon(exposure: ExposureSummary, now: number): Promise<number> {
    const tokens = new Set<string>();
    for (const p of exposure.positions) if (p.exchange === 'polymarket') tokens.add(p.symbol);
    for (const o of exposure.openBuys) if (o.exchange === 'polymarket') tokens.add(o.token_id);

    const isLong = new Map<string, boolean>();
    await Promise.all(
      [...tokens].map(async (tokenId) => {
        let end: string | null = null;
        try {
          end = await withTimeout(this.deps.getEndDate(tokenId), LOOKUP_TIMEOUT_MS, 'end date lookup');
        } catch {
          end = null;
        }
        const days = daysToSettlement(end, now);
        isLong.set(tokenId, days === null || isLongHorizon(days));
      })
    );

    let total = 0;
    for (const p of exposure.positions) {
      if (p.exchange === 'polymarket' && isLong.get(p.symbol)) total += p.cost_basis;
    }
    for (const o of exposure.openBuys) {
      if (o.exchange === 'polymarket' && isLong.get(o.token_id)) total += unfilledNotional(o);
    }
    return total;
  }

  /** Cash for equity, cached; NaN when unavailable. */
  async getCash(exchange: Exchange): Promise<number> {
    const ttl = this.deps.cashCacheMs ?? (this.deps.simulated ? 0 : DEFAULT_CASH_CACHE_MS);
    const key: Exchange = this.deps.simulated ? exchange : 'polymarket'; // live cash covers all accounts
    const hit = this.cashCache.get(key);
    if (hit && this.now() - hit.at < ttl) return hit.value;
    try {
      const value = await withTimeout(this.deps.getCashUsd(exchange), LOOKUP_TIMEOUT_MS, 'cash balance');
      if (!Number.isFinite(value) || value < 0) return NaN;
      if (ttl > 0) this.cashCache.set(key, { value, at: this.now() });
      return value;
    } catch {
      return NaN;
    }
  }

  /** This bot's holding in a token/symbol: net quantity, open sells and when it was opened. */
  getPosition(order: OrderRequest, positions: RiskPositionRow[]): RiskStateSnapshot['position'] {
    const { simulated } = this.deps;
    const row = positions.find(
      (p) => p.bot_id === order.botId && p.exchange === order.exchange && p.symbol === order.tokenId
    );
    let size = row?.net_quantity ?? 0;
    let openedAt: number | null = null;

    if (size > QTY_EPS) {
      // Opened = first buy after the position was last flat
      let running = 0;
      for (const f of this.deps.tradeRepo.findRiskFills(order.botId, order.tokenId, simulated)) {
        const qty = f.quantity ?? 0;
        if (f.side === 'BUY') {
          if (running <= QTY_EPS) openedAt = parseDbTime(f.executed_at);
          running += qty;
        } else {
          running = Math.max(0, running - qty);
        }
      }
    } else if (simulated && this.deps.getPaperPositionSize) {
      // Paper position opened before OrderService recorded fills: treat as old
      const paper = this.deps.getPaperPositionSize(order.exchange, order.tokenId);
      if (paper !== null && paper > QTY_EPS) {
        size = paper;
        openedAt = 0;
      }
    }

    if (size <= QTY_EPS) return null;
    return {
      size,
      openSellSize: this.deps.orderRepo.sumOpenSellSize(order.botId, order.tokenId, simulated),
      // Unknown open time ⇒ NaN ⇒ state_invalid (fail closed)
      openedAt: openedAt === null || Number.isNaN(openedAt) ? NaN : openedAt,
    };
  }

  async getSnapshot(order: OrderRequest): Promise<RiskStateSnapshot> {
    const { simulated, orderRepo } = this.deps;
    const now = this.now();
    const global = this.isGloballyHalted();
    const bot = this.getBotInfo(order.botId);
    const exposure = this.computeExposure(order.botId);

    // Only Polymarket buys are checked against the long-horizon cap
    const longHorizonUsd =
      order.exchange === 'polymarket' && order.side === 'buy' ? await this.computeLongHorizon(exposure, now) : 0;

    const cash = await this.getCash(order.exchange);
    const positionCost = exposure.positions.reduce((sum, p) => sum + p.cost_basis, 0);

    return {
      now,
      globalHalted: global.halted,
      globalHaltReason: global.reason,
      bot,
      equityUsd: cash + positionCost,
      exposure: {
        botUsd: exposure.botUsd[order.exchange],
        marketUsd: order.exchange === 'polymarket' ? (exposure.marketUsd.get(order.marketId) ?? 0) : 0,
        totalUsd: exposure.totalUsd,
        longHorizonUsd,
      },
      // TODO(chunk 2a): category rights from the forecast ledger. null ⇒ ledger-driven buys are rejected.
      categoryBucket: null,
      botOrdersLastHour: orderRepo.countByBotSince(order.botId, new Date(now - HOUR_MS).toISOString(), simulated),
      openOrdersCount: simulated ? orderRepo.countOpen(true, order.botId) : orderRepo.countOpen(false),
      position: order.side === 'sell' ? this.getPosition(order, exposure.positions) : null,
    };
  }
}
