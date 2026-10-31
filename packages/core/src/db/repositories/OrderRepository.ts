import type Database from 'better-sqlite3';
import { generateId } from '../index';

export type OrderStatus =
  | 'rejected_risk'
  | 'submitted'
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'expired'
  | 'failed';

/** Statuses that may still fill on the exchange */
export const OPEN_ORDER_STATUSES: OrderStatus[] = ['submitted', 'open', 'partially_filled'];

export interface OrderRow {
  id: string;
  bot_id: string;
  exchange: string; // 'polymarket' | 'binance'
  market_id: string;
  token_id: string;
  side: string; // 'buy' | 'sell'
  order_type: string; // 'limit' | 'market'
  price: number;
  size: number;
  notional_usd: number;
  expires_at: string | null;
  status: OrderStatus;
  risk_decision: string | null; // JSON RiskDecision
  exchange_order_id: string | null;
  filled_size: number;
  avg_fill_price: number | null;
  fee_usd: number;
  reason: string | null;
  forecast_id: string | null;
  /** 1 = paper order (never sent to an exchange) */
  simulated: number;
  /** Wallet of the bot when the order was created (2b review) */
  wallet_id?: string | null;
  /** Bot that placed it on this bot's behalf (5a: position-manager exits); null = the bot itself */
  placed_by?: string | null;
  created_at: string; // ISO
  updated_at: string; // ISO
}

const OPEN_IN = `(${OPEN_ORDER_STATUSES.map((s) => `'${s}'`).join(',')})`;

/**
 * Every order attempt, including risk rejections (spec §2.2).
 * Timestamps are ISO strings so range queries compare correctly.
 *
 * Paper orders are stored too (`simulated = 1`) so paper bots get the same rate limits.
 * Every aggregate takes a `simulated` flag (default false = live only), so paper orders
 * never count toward live limits and vice versa.
 */
export class OrderRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  findById(id: string): OrderRow | undefined {
    return this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
  }

  findByExchangeOrderId(exchangeOrderId: string): OrderRow | undefined {
    return this.db
      .prepare('SELECT * FROM orders WHERE exchange_order_id = ?')
      .get(exchangeOrderId) as OrderRow | undefined;
  }

  findByBot(botId: string, limit = 100): OrderRow[] {
    return this.db
      .prepare('SELECT * FROM orders WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(botId, limit) as OrderRow[];
  }

  /** A bot's orders (paper or live) created since `sinceIso`, newest first. */
  findByBotSince(botId: string, simulated: boolean, sinceIso: string, limit = 500): OrderRow[] {
    return this.db
      .prepare('SELECT * FROM orders WHERE bot_id = ? AND simulated = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?')
      .all(botId, simulated ? 1 : 0, sinceIso, limit) as OrderRow[];
  }

  /** Forecast of the bot's most recent ledger-driven buy in a token that filled something (position manager). */
  lastBuyForecastId(botId: string, tokenId: string, simulated: boolean): string | null {
    const row = this.db
      .prepare(
        `SELECT forecast_id FROM orders WHERE bot_id = ? AND token_id = ? AND simulated = ? AND side = 'buy'
           AND forecast_id IS NOT NULL AND filled_size > 0 ORDER BY created_at DESC LIMIT 1`
      )
      .get(botId, tokenId, simulated ? 1 : 0) as { forecast_id: string } | undefined;
    return row?.forecast_id ?? null;
  }

  /** Open orders another bot placed on its owners' behalf (position-manager exits). */
  findOpenPlacedBy(placedBy: string, simulated: boolean): OrderRow[] {
    return this.db
      .prepare(`SELECT * FROM orders WHERE status IN ${OPEN_IN} AND placed_by = ? AND simulated = ? ORDER BY created_at`)
      .all(placedBy, simulated ? 1 : 0) as OrderRow[];
  }

  /** Orders that may still fill, optionally for one bot. */
  findOpen(botId?: string, simulated = false): OrderRow[] {
    const sim = simulated ? 1 : 0;
    if (botId) {
      return this.db
        .prepare(`SELECT * FROM orders WHERE status IN ${OPEN_IN} AND bot_id = ? AND simulated = ? ORDER BY created_at`)
        .all(botId, sim) as OrderRow[];
    }
    return this.db
      .prepare(`SELECT * FROM orders WHERE status IN ${OPEN_IN} AND simulated = ? ORDER BY created_at`)
      .all(sim) as OrderRow[];
  }

  /** Earliest live order on this wallet that may have reached the exchange (not rejected / failed); null if none (R67). */
  firstLiveOrderAtForWallet(walletId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT MIN(o.created_at) AS first FROM orders o LEFT JOIN bots b ON b.id = o.bot_id
         WHERE COALESCE(o.wallet_id, b.wallet_id) = ? AND o.simulated = 0 AND o.status NOT IN ('rejected_risk', 'failed')`
      )
      .get(walletId) as { first: string | null };
    return row.first;
  }

  /** Bots with orders that may still fill (live or paper). */
  findBotIdsWithOpenOrders(): string[] {
    return (this.db.prepare(`SELECT DISTINCT bot_id FROM orders WHERE status IN ${OPEN_IN}`).all() as Array<{ bot_id: string }>).map(
      (r) => r.bot_id
    );
  }

  create(data: {
    id?: string;
    botId: string;
    exchange: 'polymarket' | 'binance';
    marketId: string;
    tokenId: string;
    side: 'buy' | 'sell';
    orderType: 'limit' | 'market';
    price: number;
    size: number;
    notionalUsd: number;
    status: OrderStatus;
    expiresAt?: string | null;
    riskDecision?: unknown;
    exchangeOrderId?: string | null;
    reason?: string | null;
    forecastId?: string | null;
    simulated?: boolean;
    /** Default: the bot's current wallet */
    walletId?: string | null;
    /** Bot placing it on the owner's behalf (position-manager exits) */
    placedBy?: string | null;
  }): OrderRow {
    const id = data.id || generateId();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO orders (id, bot_id, exchange, market_id, token_id, side, order_type, price, size,
           notional_usd, expires_at, status, risk_decision, exchange_order_id, reason, forecast_id,
           simulated, created_at, updated_at, wallet_id, placed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT wallet_id FROM bots WHERE id = ?)), ?)`
      )
      .run(
        id,
        data.botId,
        data.exchange,
        data.marketId,
        data.tokenId,
        data.side,
        data.orderType,
        data.price,
        data.size,
        data.notionalUsd,
        data.expiresAt ?? null,
        data.status,
        data.riskDecision !== undefined ? JSON.stringify(data.riskDecision) : null,
        data.exchangeOrderId ?? null,
        data.reason ?? null,
        data.forecastId ?? null,
        data.simulated ? 1 : 0,
        now,
        now,
        data.walletId ?? null,
        data.botId,
        data.placedBy ?? null
      );

    return this.findById(id)!;
  }

  update(
    id: string,
    data: Partial<{
      status: OrderStatus;
      exchangeOrderId: string | null;
      filledSize: number;
      avgFillPrice: number | null;
      feeUsd: number;
      expiresAt: string | null;
    }>
  ): OrderRow | undefined {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (data.status !== undefined) { sets.push('status = ?'); values.push(data.status); }
    if (data.exchangeOrderId !== undefined) { sets.push('exchange_order_id = ?'); values.push(data.exchangeOrderId); }
    if (data.filledSize !== undefined) { sets.push('filled_size = ?'); values.push(data.filledSize); }
    if (data.avgFillPrice !== undefined) { sets.push('avg_fill_price = ?'); values.push(data.avgFillPrice); }
    if (data.feeUsd !== undefined) { sets.push('fee_usd = ?'); values.push(data.feeUsd); }
    if (data.expiresAt !== undefined) { sets.push('expires_at = ?'); values.push(data.expiresAt); }

    if (sets.length === 0) return this.findById(id);

    sets.push('updated_at = ?');
    values.push(new Date().toISOString(), id);

    this.db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  /**
   * Orders the bot itself submitted to the exchange / paper engine since `sinceIso` (per_bot_defaults.max_orders_per_hour):
   * risk rejections (`rejected_risk`) and orders another bot placed on its behalf (Position Manager exits,
   * `placed_by`) are not counted (Mac test F1: a bot spinning on rejections, or a manager exiting for it, locked
   * it out of the rate limit). Rejections have their own short cooldown (`countOwnRejectionsSince`).
   */
  countByBotSince(botId: string, sinceIso: string, simulated = false): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders WHERE bot_id = ? AND created_at >= ? AND simulated = ?
           AND status != 'rejected_risk' AND placed_by IS NULL`
      )
      .get(botId, sinceIso, simulated ? 1 : 0) as { n: number };
    return row.n;
  }

  /**
   * The bot's own risk rejections since `sinceIso` (not orders placed for it by another bot), oldest first, without
   * those whose `failedCheck` is in `excludeChecks` (the cooldown's own refusals, system-wide states): the rejection
   * cooldown's input.
   */
  ownRejectionTimesSince(botId: string, sinceIso: string, simulated: boolean, excludeChecks: readonly string[]): string[] {
    const placeholders = excludeChecks.map(() => '?').join(',') || "''";
    const rows = this.db
      .prepare(
        `SELECT created_at FROM orders WHERE bot_id = ? AND status = 'rejected_risk' AND created_at >= ? AND simulated = ?
           AND placed_by IS NULL AND COALESCE(json_extract(risk_decision, '$.failedCheck'), '') NOT IN (${placeholders})
         ORDER BY created_at`
      )
      .all(botId, sinceIso, simulated ? 1 : 0, ...excludeChecks) as Array<{ created_at: string }>;
    return rows.map((r) => r.created_at);
  }

  /** Whether the bot has a rejection with this failed check since `sinceIso` (one cooldown row per window). */
  hasRejectionSince(botId: string, sinceIso: string, simulated: boolean, failedCheck: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM orders WHERE bot_id = ? AND status = 'rejected_risk' AND created_at >= ? AND simulated = ?
           AND json_extract(risk_decision, '$.failedCheck') = ? LIMIT 1`
      )
      .get(botId, sinceIso, simulated ? 1 : 0, failedCheck);
  }

  /**
   * Latest Position Manager stop per token in one mode since `sinceIso` (sells placed by another bot with a
   * "position manager: stop" reason, any status: the decision to stop counts even when the exit was refused).
   */
  recentStops(simulated: boolean, sinceIso: string, tokenId?: string): Array<{ token_id: string; stopped_at: string }> {
    const sql = `SELECT token_id, MAX(created_at) AS stopped_at FROM orders
       WHERE simulated = ? AND created_at >= ? AND side = 'sell' AND placed_by IS NOT NULL
         AND reason LIKE 'position manager: stop%' ${tokenId ? 'AND token_id = ?' : ''}
       GROUP BY token_id`;
    const args: unknown[] = [simulated ? 1 : 0, sinceIso];
    if (tokenId) args.push(tokenId);
    return this.db.prepare(sql).all(...args) as Array<{ token_id: string; stopped_at: string }>;
  }

  /** Open orders across all bots (or one bot). */
  countOpen(simulated = false, botId?: string): number {
    const row = (botId
      ? this.db
          .prepare(`SELECT COUNT(*) AS n FROM orders WHERE status IN ${OPEN_IN} AND simulated = ? AND bot_id = ?`)
          .get(simulated ? 1 : 0, botId)
      : this.db
          .prepare(`SELECT COUNT(*) AS n FROM orders WHERE status IN ${OPEN_IN} AND simulated = ?`)
          .get(simulated ? 1 : 0)) as { n: number };
    return row.n;
  }

  /** Unfilled size of a bot's open sell orders in one token. */
  sumOpenSellSize(botId: string, tokenId: string, simulated = false): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(MAX(size - filled_size, 0)), 0) AS total
         FROM orders WHERE status IN ${OPEN_IN} AND side = 'sell' AND bot_id = ? AND token_id = ? AND simulated = ?`
      )
      .get(botId, tokenId, simulated ? 1 : 0) as { total: number };
    return row.total;
  }

  /** Unfilled notional of open buy orders, optionally filtered by bot, market and/or exchange. */
  sumOpenBuyNotional(
    filter: { botId?: string; marketId?: string; exchange?: 'polymarket' | 'binance'; simulated?: boolean } = {}
  ): number {
    const conditions = [`status IN ${OPEN_IN}`, "side = 'buy'", 'simulated = ?'];
    const values: unknown[] = [filter.simulated ? 1 : 0];
    if (filter.exchange) { conditions.push('exchange = ?'); values.push(filter.exchange); }
    if (filter.botId) { conditions.push('bot_id = ?'); values.push(filter.botId); }
    if (filter.marketId) { conditions.push('market_id = ?'); values.push(filter.marketId); }

    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(notional_usd * (1 - MIN(filled_size, size) / size)), 0) AS total
         FROM orders WHERE ${conditions.join(' AND ')}`
      )
      .get(...values) as { total: number };
    return row.total;
  }
}
