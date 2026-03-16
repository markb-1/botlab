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
          exchange, symbol, price, quantity, quote_amount, simulated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        data.simulated ?? 0
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
