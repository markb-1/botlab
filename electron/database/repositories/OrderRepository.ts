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
  created_at: string; // ISO
  updated_at: string; // ISO
}

const OPEN_IN = `(${OPEN_ORDER_STATUSES.map((s) => `'${s}'`).join(',')})`;

/**
 * Every order attempt, including risk rejections (spec §2.2).
 * Timestamps are ISO strings so range queries compare correctly.
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

  /** Orders that may still fill, optionally for one bot. */
  findOpen(botId?: string): OrderRow[] {
    if (botId) {
      return this.db
        .prepare(`SELECT * FROM orders WHERE status IN ${OPEN_IN} AND bot_id = ? ORDER BY created_at`)
        .all(botId) as OrderRow[];
    }
    return this.db
      .prepare(`SELECT * FROM orders WHERE status IN ${OPEN_IN} ORDER BY created_at`)
      .all() as OrderRow[];
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
  }): OrderRow {
    const id = data.id || generateId();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO orders (id, bot_id, exchange, market_id, token_id, side, order_type, price, size,
           notional_usd, expires_at, status, risk_decision, exchange_order_id, reason, forecast_id,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        now,
        now
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

  /** Orders a bot attempted since `sinceIso` (all statuses — rejections count toward the rate limit). */
  countByBotSince(botId: string, sinceIso: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM orders WHERE bot_id = ? AND created_at >= ?')
      .get(botId, sinceIso) as { n: number };
    return row.n;
  }

  countOpen(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status IN ${OPEN_IN}`).get() as { n: number };
    return row.n;
  }

  /** Unfilled notional of open buy orders, optionally filtered by bot and/or market. */
  sumOpenBuyNotional(filter: { botId?: string; marketId?: string } = {}): number {
    const conditions = [`status IN ${OPEN_IN}`, "side = 'buy'"];
    const values: unknown[] = [];
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
