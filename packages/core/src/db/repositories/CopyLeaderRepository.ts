import type Database from 'better-sqlite3';
import { generateId } from '../index';

/** Leader of a copy-trading bot (spec §9.5 leader scoring, 5c) */
export type CopyLeaderStatus = 'active' | 'dropped' | 'removed';

export interface CopyLeaderRow {
  id: string;
  bot_id: string;
  /** Lower-case 0x address */
  address: string;
  status: CopyLeaderStatus;
  added_at: string;
  /** human / agent / system (system: found in a pre-5c bot's config) */
  added_by: string;
  /** Start of the auto-drop window (added, re-added or re-activated) */
  active_since: string;
  dropped_at: string | null;
  dropped_reason: string | null;
  updated_at: string;
}

export interface CopyTradeRow {
  order_id: string;
  bot_id: string;
  leader: string;
  leader_key: string | null;
  side: string;
  leader_price: number | null;
  leader_usd: number | null;
  created_at: string;
}

/** An order-linked fill of a bot with the leader its order copied (null = not a copied order) */
export interface CopyFillRow {
  order_id: string;
  symbol: string;
  condition_id: string | null;
  side: 'BUY' | 'SELL';
  quantity: number;
  quote_amount: number;
  fee_usd: number | null;
  executed_at: string;
  simulated: number;
  fill_source: string | null;
  leader: string | null;
}

export class CopyLeaderRepository {
  constructor(private db: Database.Database) {}

  list(botId: string): CopyLeaderRow[] {
    return this.db.prepare('SELECT * FROM copy_leaders WHERE bot_id = ? ORDER BY added_at, address').all(botId) as CopyLeaderRow[];
  }

  /** Bots with at least one leader row (digest) */
  botIds(): string[] {
    return (this.db.prepare('SELECT DISTINCT bot_id FROM copy_leaders ORDER BY bot_id').all() as Array<{ bot_id: string }>).map((r) => r.bot_id);
  }

  find(botId: string, address: string): CopyLeaderRow | undefined {
    return this.db.prepare('SELECT * FROM copy_leaders WHERE bot_id = ? AND address = ?').get(botId, address.toLowerCase()) as CopyLeaderRow | undefined;
  }

  insert(botId: string, address: string, addedBy: string, at: string): CopyLeaderRow {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO copy_leaders (id, bot_id, address, status, added_at, added_by, active_since, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .run(id, botId, address.toLowerCase(), at, addedBy, at, at);
    return this.find(botId, address)!;
  }

  /** removed → active again (re-added to the config): a new auto-drop window */
  reAdd(id: string, addedBy: string, at: string): void {
    this.db
      .prepare("UPDATE copy_leaders SET status = 'active', added_at = ?, added_by = ?, active_since = ?, updated_at = ? WHERE id = ? AND status = 'removed'")
      .run(at, addedBy, at, at, id);
  }

  setRemoved(id: string, at: string): void {
    this.db.prepare("UPDATE copy_leaders SET status = 'removed', updated_at = ? WHERE id = ? AND status = 'active'").run(at, id);
  }

  /** active → dropped; false if it was not active (already dropped / removed) */
  drop(id: string, reason: string, at: string): boolean {
    return (
      this.db
        .prepare("UPDATE copy_leaders SET status = 'dropped', dropped_at = ?, dropped_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'")
        .run(at, reason, at, id).changes > 0
    );
  }

  /** dropped → active (human only, checked by the service): a new auto-drop window */
  reactivate(id: string, at: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE copy_leaders SET status = 'active', active_since = ?, dropped_at = NULL, dropped_reason = NULL, updated_at = ? WHERE id = ? AND status = 'dropped'"
        )
        .run(at, at, id).changes > 0
    );
  }

  deleteForBot(botId: string): void {
    this.db.prepare('DELETE FROM copy_leaders WHERE bot_id = ?').run(botId);
    this.db.prepare('DELETE FROM copy_trades WHERE bot_id = ?').run(botId);
  }

  recordTrade(row: Omit<CopyTradeRow, 'created_at'>, at: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO copy_trades (order_id, bot_id, leader, leader_key, side, leader_price, leader_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.order_id, row.bot_id, row.leader.toLowerCase(), row.leader_key, row.side, row.leader_price, row.leader_usd, at);
  }

  /** Orders this bot placed per leader (copied orders, any outcome) */
  orderCounts(botId: string): Map<string, number> {
    const rows = this.db.prepare('SELECT leader, COUNT(*) AS n FROM copy_trades WHERE bot_id = ? GROUP BY leader').all(botId) as Array<{
      leader: string;
      n: number;
    }>;
    return new Map(rows.map((r) => [r.leader, r.n]));
  }

  /** The bot's Polymarket order-linked fills (OrderService and reconciler resolution closes), oldest first, with the copied leader */
  fills(botId: string): CopyFillRow[] {
    return this.db
      .prepare(
        `SELECT t.order_id, t.symbol, t.condition_id, t.side, t.quantity, t.quote_amount, t.fee_usd, t.executed_at,
                COALESCE(t.simulated, 0) AS simulated, t.fill_source, c.leader
         FROM bot_trades t LEFT JOIN copy_trades c ON c.order_id = t.order_id
         WHERE t.bot_id = ? AND t.order_id IS NOT NULL AND t.exchange = 'polymarket' AND t.symbol IS NOT NULL
           AND t.side IN ('BUY', 'SELL') AND t.quantity > 0
         ORDER BY t.executed_at, t.created_at`
      )
      .all(botId) as CopyFillRow[];
  }
}
