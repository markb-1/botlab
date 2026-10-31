import type Database from 'better-sqlite3';
import { generateId } from '../index';

export interface BotTradeRow {
  id: string;
  bot_id: string;
  bot_name: string | null;
  script_name: string | null;
  trader_address: string | null;
  trader_name: string | null;
  market: string | null;
  market_slug: string | null;
  condition_id: string | null;
  outcome: string | null;
  side: string | null;
  trader_bet_size: number | null;
  bot_bet_size: number | null;
  trader_win_rate: number | null;
  trader_sample_size: number | null;
  kelly_fraction: number | null;
  kelly_edge: number | null;
  kelly_percentage: number | null;
  sizing_reason: string | null;
  current_position_value: number | null;
  max_position_size: number | null;
  executed_at: string;
  trader_trade_timestamp: number | null;
  metadata: string | null;
  created_at: string;
  // Auto-recorded trade columns
  exchange: string | null;
  symbol: string | null;
  price: number | null;
  quantity: number | null;
  quote_amount: number | null;
  simulated: number | null;
  /** Set only for fills recorded by OrderService; such trades are the risk engine's source of positions */
  order_id: string | null;
  fee_usd: number | null;
  category: string | null;
}

/** Open position of one bot in one symbol, computed from OrderService fills. */
export interface RiskPositionRow {
  bot_id: string;
  exchange: string;
  symbol: string;
  /** Polymarket condition id (null for Binance) */
  condition_id: string | null;
  net_quantity: number;
  /** Average buy price × net quantity */
  cost_basis: number;
}

export interface PnlFillRow {
  bot_id: string;
  exchange: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number | null;
  quote_amount: number | null;
  fee_usd: number | null;
  executed_at: string;
  simulated: number;
}

export class BotTradeRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(data: {
    botId: string;
    botName?: string;
    scriptName?: string;
    traderAddress?: string;
    traderName?: string;
    market?: string;
    marketSlug?: string;
    conditionId?: string;
    outcome?: string;
    side?: 'BUY' | 'SELL';
    traderBetSize?: number;
    botBetSize?: number;
    traderWinRate?: number;
    traderSampleSize?: number;
    kellyFraction?: number;
    kellyEdge?: number;
    kellyPercentage?: number;
    sizingReason?: string;
    currentPositionValue?: number;
    maxPositionSize?: number;
    traderTradeTimestamp?: number;
    metadata?: Record<string, unknown>;
    // Auto-recorded trade fields
    exchange?: 'polymarket' | 'binance';
    symbol?: string;
    price?: number;
    quantity?: number;
    quoteAmount?: number;
    simulated?: number;
    orderId?: string;
    feeUsd?: number;
    category?: string | null;
  }): BotTradeRow {
    const id = generateId();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO bot_trades (
          id, bot_id, bot_name, script_name, trader_address, trader_name,
          market, market_slug, condition_id, outcome, side,
          trader_bet_size, bot_bet_size,
          trader_win_rate, trader_sample_size, kelly_fraction, kelly_edge, kelly_percentage,
          sizing_reason, current_position_value, max_position_size,
          executed_at, trader_trade_timestamp, metadata, created_at,
          exchange, symbol, price, quantity, quote_amount, simulated, order_id, fee_usd, category
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.botId,
        data.botName || null,
        data.scriptName || null,
        data.traderAddress || null,
        data.traderName || null,
        data.market || null,
        data.marketSlug || null,
        data.conditionId || null,
        data.outcome || null,
        data.side || null,
        data.traderBetSize ?? null,
        data.botBetSize ?? null,
        data.traderWinRate ?? null,
        data.traderSampleSize ?? null,
        data.kellyFraction ?? null,
        data.kellyEdge ?? null,
        data.kellyPercentage ?? null,
        data.sizingReason || null,
        data.currentPositionValue ?? null,
        data.maxPositionSize ?? null,
        now,
        data.traderTradeTimestamp ?? null,
        data.metadata ? JSON.stringify(data.metadata) : null,
        now,
        data.exchange || null,
        data.symbol || null,
        data.price ?? null,
        data.quantity ?? null,
        data.quoteAmount ?? null,
        data.simulated ?? 0,
        data.orderId ?? null,
        data.feeUsd ?? null,
        data.category ?? null
      );

    return this.db.prepare('SELECT * FROM bot_trades WHERE id = ?').get(id) as BotTradeRow;
  }

  findByBotId(botId: string, opts?: { hoursAgo?: number; simulated?: 0 | 1 }): BotTradeRow[] {
    const hoursAgo = opts?.hoursAgo;
    const simulated = opts?.simulated;

    let sql = 'SELECT * FROM bot_trades WHERE bot_id = ?';
    const params: unknown[] = [botId];

    if (hoursAgo) {
      sql += " AND executed_at >= datetime('now', ?)";
      params.push(`-${hoursAgo} hours`);
    }

    if (simulated !== undefined) {
      sql += ' AND simulated = ?';
      params.push(simulated);
    }

    sql += ' ORDER BY executed_at DESC';

    if (!hoursAgo) {
      sql += ' LIMIT 100';
    }

    return this.db.prepare(sql).all(...params) as BotTradeRow[];
  }

  /**
   * Compute aggregate open positions from trade history.
   * Groups trades by symbol/exchange and calculates net quantity.
   * Only returns positions with a positive net quantity.
   */
  getPositions(botId: string): Array<{
    symbol: string;
    exchange: string;
    market: string | null;
    outcome: string | null;
    netQuantity: number;
    totalCost: number;
    tradeCount: number;
  }> {
    return this.db.prepare(`
      SELECT
        symbol,
        exchange,
        MAX(market) as market,
        MAX(outcome) as outcome,
        SUM(CASE WHEN side = 'BUY' THEN quantity ELSE -quantity END) as netQuantity,
        SUM(CASE WHEN side = 'BUY' THEN quote_amount ELSE 0 END) as totalCost,
        COUNT(*) as tradeCount
      FROM bot_trades
      WHERE bot_id = ?
      GROUP BY symbol, exchange
      HAVING netQuantity > 0.0001
      ORDER BY MAX(executed_at) DESC
    `).all(botId) as any[];
  }

  /**
   * Open positions for the risk engine, from fills recorded by OrderService only
   * (`order_id IS NOT NULL`). Trades written by scripts via ctx.recordTrade, and
   * pre-v3 auto-recorded trades, are ignored so a bot cannot fabricate positions.
   *
   * Cost basis = average buy price × net quantity.
   */
  getRiskPositions(filter: { simulated: boolean; botId?: string; exchange?: 'polymarket' | 'binance' }): RiskPositionRow[] {
    const conditions = ['order_id IS NOT NULL', 'simulated = ?'];
    const values: unknown[] = [filter.simulated ? 1 : 0];
    if (filter.botId) { conditions.push('bot_id = ?'); values.push(filter.botId); }
    if (filter.exchange) { conditions.push('exchange = ?'); values.push(filter.exchange); }

    return this.db.prepare(`
      SELECT bot_id, exchange, symbol, condition_id, net_quantity,
        CASE WHEN buy_qty > 0 THEN net_quantity * buy_cost / buy_qty ELSE 0 END AS cost_basis
      FROM (
        SELECT bot_id, exchange, symbol, MAX(condition_id) AS condition_id,
          SUM(CASE WHEN side = 'BUY' THEN quantity ELSE -quantity END) AS net_quantity,
          SUM(CASE WHEN side = 'BUY' THEN quantity ELSE 0 END) AS buy_qty,
          SUM(CASE WHEN side = 'BUY' THEN quote_amount ELSE 0 END) AS buy_cost
        FROM bot_trades
        WHERE ${conditions.join(' AND ')}
        GROUP BY bot_id, exchange, symbol
      )
      WHERE net_quantity > 1e-9
    `).all(...values) as RiskPositionRow[];
  }

  /** All OrderService fills (live and paper) for daily P&L and the ramp; oldest first. */
  findPnlFills(): PnlFillRow[] {
    return this.db.prepare(`
      SELECT bot_id, exchange, symbol, side, quantity, quote_amount, fee_usd, executed_at, COALESCE(simulated, 0) AS simulated
      FROM bot_trades
      WHERE order_id IS NOT NULL AND exchange IS NOT NULL AND symbol IS NOT NULL AND side IN ('BUY', 'SELL')
      ORDER BY executed_at, created_at
    `).all() as PnlFillRow[];
  }

  /**
   * Live positions built only from trades without an order_id (recorded before OrderService
   * existed, or by scripts). The risk engine ignores these; listed at startup as a warning.
   */
  findUnlinkedLivePositions(): Array<{ bot_id: string; bot_name: string | null; exchange: string; symbol: string; net_quantity: number }> {
    return this.db.prepare(`
      SELECT bot_id, MAX(bot_name) AS bot_name, exchange, symbol,
        SUM(CASE WHEN side = 'BUY' THEN quantity ELSE -quantity END) AS net_quantity
      FROM bot_trades
      WHERE order_id IS NULL AND COALESCE(simulated, 0) = 0 AND exchange IS NOT NULL AND symbol IS NOT NULL
        AND quantity IS NOT NULL
      GROUP BY bot_id, exchange, symbol
      HAVING net_quantity > 1e-9
    `).all() as Array<{ bot_id: string; bot_name: string | null; exchange: string; symbol: string; net_quantity: number }>;
  }

  /** OrderService fills of one bot in one symbol, oldest first (for position open time). */
  findRiskFills(botId: string, symbol: string, simulated: boolean): Array<{ side: string; quantity: number; executed_at: string }> {
    return this.db.prepare(`
      SELECT side, quantity, executed_at FROM bot_trades
      WHERE bot_id = ? AND symbol = ? AND simulated = ? AND order_id IS NOT NULL
      ORDER BY executed_at, created_at
    `).all(botId, symbol, simulated ? 1 : 0) as Array<{ side: string; quantity: number; executed_at: string }>;
  }

  /**
   * Backfill market name and outcome for trades matching a symbol.
   * Only updates trades where market is currently NULL.
   */
  updateMarketInfo(symbol: string, market: string, outcome: string): void {
    this.db.prepare(`
      UPDATE bot_trades
      SET market = ?, outcome = ?
      WHERE symbol = ? AND market IS NULL
    `).run(market, outcome, symbol);
  }

  findRecent(hoursAgo: number = 24): BotTradeRow[] {
    return this.db
      .prepare(
        `SELECT * FROM bot_trades
         WHERE executed_at >= datetime('now', ?)
         ORDER BY executed_at DESC`
      )
      .all(`-${hoursAgo} hours`) as BotTradeRow[];
  }
}
