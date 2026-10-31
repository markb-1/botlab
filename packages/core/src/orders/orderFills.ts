/**
 * Fill recording shared by OrderService (its own syncs, cancels and placements) and the Reconciler
 * (spec §13). One code path decides how an exchange's view of an order turns into order-row updates
 * and `bot_trades` fills, so a fill is recorded exactly once whoever sees it first: the order row is
 * re-read inside the transaction and only the delta over the stored `filled_size` is recorded.
 */

import type Database from 'better-sqlite3';
import type { BotTradeRepository } from '../db/repositories/BotTradeRepository';
import type { OrderRepository, OrderRow, OrderStatus } from '../db/repositories/OrderRepository';
import { OPEN_ORDER_STATUSES } from '../db/repositories/OrderRepository';
import type { Exchange } from '../risk/types';
import type { OrderFillEvent } from '../notify/events';

const QTY_EPS = 1e-9;

/** Who the fill belongs to (bot_trades columns). */
export interface FillOwner {
  botId: string;
  botName: string;
  scriptName: string;
  simulated: boolean;
}

export interface FillInfo {
  /** Market question / outcome for bot_trades (optional) */
  question?: string | null;
  outcome?: string | null;
  category?: string | null;
}

/**
 * Insert one order-linked fill into bot_trades. Returns the notification event for live fills
 * (emit it only after the surrounding transaction commits).
 */
export function recordOrderFill(
  tradeRepo: BotTradeRepository,
  owner: FillOwner,
  row: OrderRow,
  fill: { size: number; notional: number },
  feeUsd: number,
  info: FillInfo | null
): OrderFillEvent | null {
  const price = fill.size > 0 ? fill.notional / fill.size : row.price;
  tradeRepo.create({
    botId: owner.botId,
    botName: owner.botName,
    scriptName: owner.scriptName,
    exchange: row.exchange as Exchange,
    side: row.side === 'buy' ? 'BUY' : 'SELL',
    symbol: row.token_id,
    conditionId: row.exchange === 'polymarket' ? row.market_id : undefined,
    market: info?.question || undefined,
    outcome: info?.outcome || undefined,
    price,
    quantity: fill.size,
    quoteAmount: fill.notional,
    simulated: owner.simulated ? 1 : 0,
    orderId: row.id,
    feeUsd,
    category: info?.category ?? null,
  });
  if (owner.simulated) return null;
  return {
    botId: owner.botId,
    botName: owner.botName,
    exchange: row.exchange,
    side: row.side === 'buy' ? 'BUY' : 'SELL',
    symbol: row.token_id,
    market: info?.question || undefined,
    outcome: info?.outcome || undefined,
    quantity: fill.size,
    price,
    notionalUsd: fill.notional,
    simulated: false,
  };
}

/** An exchange's view of one order (Polymarket getOrder, Binance order query, reconciled trades). */
export interface ExchangeOrderState {
  /** Exchange status: Polymarket live/matched/cancel*, unmatched; Binance statuses are mapped by the caller */
  status: string;
  /** Total size matched so far (shares / base quantity) */
  sizeMatched: number;
  originalSize?: number;
  price?: number;
  /**
   * Total quote (USD) exchanged for `sizeMatched`, when the exchange says (Binance cummulativeQuoteQty,
   * summed trades). Without it the delta is priced at the order's limit price (resting fills).
   */
  filledNotional?: number | null;
}

export interface ApplyStateOptions {
  now: number;
  owner: FillOwner;
  /** Taker/maker fee rate for the newly recorded part (default 0: resting fills are maker) */
  feeRate?: number;
  info?: FillInfo | null;
  /** Link the row to this exchange id (unknown-outcome order found on the exchange) */
  exchangeOrderId?: string | null;
}

export interface ApplyStateResult {
  /** Newly recorded fill size (0 if none) */
  delta: number;
  /** Row status after the update (unchanged when the exchange status was not understood) */
  status: OrderStatus | null;
  /** Live fill events to emit after commit */
  events: OrderFillEvent[];
}

/**
 * Apply the exchange's view of an order, atomically. The row is re-read inside the transaction so a
 * fill is recorded exactly once even if two callers (a bot's sync, a cancel, the reconciler) saw the
 * same exchange state. Unknown exchange statuses leave the row as is (a newly seen fill is still
 * recorded only for statuses this function understands).
 */
export function applyExchangeOrderState(
  deps: { db: Database.Database; orderRepo: OrderRepository; tradeRepo: BotTradeRepository },
  orderId: string,
  ex: ExchangeOrderState,
  opts: ApplyStateOptions
): ApplyStateResult {
  return deps.db.transaction((): ApplyStateResult => {
    const row = deps.orderRepo.findById(orderId);
    if (!row || !OPEN_ORDER_STATUSES.includes(row.status)) return { delta: 0, status: row?.status ?? null, events: [] };

    // A marketable buy is sized in USD: row.size (= amount / worst price) is a lower bound on the shares
    // it can get, so it is not capped there. Everything else cannot fill beyond its size.
    const cap = row.order_type === 'market' && row.side === 'buy' ? Math.max(row.size, ex.sizeMatched) : row.size;
    const matched = Math.min(Math.max(ex.sizeMatched, 0), cap);
    const delta = matched - row.filled_size;
    const s = ex.status.toLowerCase();
    let status: OrderStatus;
    if (matched >= row.size - QTY_EPS || s === 'matched' || s === 'filled') status = 'filled';
    else if (s === 'live' || s === 'new' || s === 'partially_filled') status = matched > QTY_EPS ? 'partially_filled' : 'open';
    else if (s === 'unmatched') status = 'cancelled';
    else if (s.startsWith('cancel') || s === 'expired' || s === 'rejected' || s === 'expired_in_match') {
      const expired = s.startsWith('expired') || (row.expires_at !== null && Date.parse(row.expires_at) <= opts.now);
      status = expired ? 'expired' : 'cancelled';
    } else return { delta: 0, status: row.status, events: [] }; // unknown status: leave as is

    const events: OrderFillEvent[] = [];
    if (opts.exchangeOrderId && !row.exchange_order_id && !claimedByOther(deps.orderRepo, row.id, opts.exchangeOrderId)) {
      deps.orderRepo.update(row.id, { exchangeOrderId: opts.exchangeOrderId });
    }
    if (delta > QTY_EPS) {
      const prevNotional = row.filled_size * (row.avg_fill_price ?? row.price);
      const totalNotional =
        typeof ex.filledNotional === 'number' && Number.isFinite(ex.filledNotional) && ex.filledNotional > 0 && ex.sizeMatched > 0
          ? (ex.filledNotional * matched) / ex.sizeMatched
          : null;
      // Resting fills happen at the order's price; a reported total notional is used when known
      const addNotional = totalNotional !== null ? Math.max(totalNotional - prevNotional, 0) : delta * row.price;
      const fee = (opts.feeRate ?? 0) * addNotional;
      const e = recordOrderFill(deps.tradeRepo, opts.owner, row, { size: delta, notional: addNotional }, fee, opts.info ?? null);
      if (e) events.push(e);
      deps.orderRepo.update(row.id, {
        filledSize: matched,
        avgFillPrice: (prevNotional + addNotional) / matched,
        feeUsd: row.fee_usd + fee,
      });
    }
    if (status !== row.status) deps.orderRepo.update(row.id, { status });
    return { delta: delta > QTY_EPS ? delta : 0, status, events };
  })();
}

/** Another order row already holds this exchange id (ids are unique per row; see the partial unique index). */
export function claimedByOther(orderRepo: Pick<OrderRepository, 'findByExchangeOrderId'>, rowId: string, exchangeOrderId: string): boolean {
  const other = orderRepo.findByExchangeOrderId(exchangeOrderId);
  return !!other && other.id !== rowId;
}

const STATUS_RANK: Partial<Record<OrderStatus, number>> = { submitted: 0, open: 1, partially_filled: 2 };

/** What the exchange answered when the order was posted (OrderService.applyOutcome). */
export interface PlacementResult {
  /** Status the answer implies (open or terminal) */
  status: OrderStatus;
  exchangeOrderId?: string | null;
  /** Total filled so far according to the answer */
  filled?: { size: number; notional: number } | null;
  feeRate?: number;
  expiresAt?: string | null;
}

/**
 * Apply the answer to a placement, atomically, through the same fresh-row/delta rule as
 * `applyExchangeOrderState`: the row is re-read inside the transaction; a row that is already terminal
 * (e.g. the Reconciler settled it while the request was in flight) is left untouched; only the fill
 * beyond what is already recorded is added; the status never moves backwards; an exchange id held by
 * another row is never copied.
 */
export function applyPlacementResult(
  deps: { db: Database.Database; orderRepo: OrderRepository; tradeRepo: BotTradeRepository },
  orderId: string,
  r: PlacementResult,
  opts: { owner: FillOwner; info?: FillInfo | null }
): { row: OrderRow | undefined; delta: number; events: OrderFillEvent[] } {
  return deps.db.transaction(() => {
    const row = deps.orderRepo.findById(orderId);
    if (!row || !OPEN_ORDER_STATUSES.includes(row.status)) return { row, delta: 0, events: [] as OrderFillEvent[] };

    const events: OrderFillEvent[] = [];
    const update: Parameters<OrderRepository['update']>[1] = {};
    if (r.exchangeOrderId && !row.exchange_order_id && !claimedByOther(deps.orderRepo, row.id, r.exchangeOrderId)) {
      update.exchangeOrderId = r.exchangeOrderId;
    }
    if (r.expiresAt !== undefined) update.expiresAt = r.expiresAt;

    let filledSize = row.filled_size;
    const total = r.filled?.size ?? 0;
    const delta = total - row.filled_size;
    if (r.filled && delta > QTY_EPS) {
      const prevNotional = row.filled_size * (row.avg_fill_price ?? row.price);
      const addNotional = Math.max(r.filled.notional - prevNotional, 0);
      const fee = (r.feeRate ?? 0) * addNotional;
      const e = recordOrderFill(deps.tradeRepo, opts.owner, row, { size: delta, notional: addNotional }, fee, opts.info ?? null);
      if (e) events.push(e);
      filledSize = total;
      update.filledSize = total;
      update.avgFillPrice = (prevNotional + addNotional) / total;
      update.feeUsd = row.fee_usd + fee;
    }

    let status = r.status;
    const terminal = !OPEN_ORDER_STATUSES.includes(status);
    if (filledSize > QTY_EPS && status === 'cancelled' && filledSize >= row.size - QTY_EPS) status = 'filled';
    if (!terminal && (STATUS_RANK[row.status] ?? 0) > (STATUS_RANK[status] ?? 0)) status = row.status; // never backwards
    if (!terminal && filledSize > QTY_EPS && status !== 'partially_filled') status = filledSize >= row.size - QTY_EPS ? 'filled' : 'partially_filled';
    if (status !== row.status) update.status = status;
    const updated = deps.orderRepo.update(row.id, update);
    return { row: updated, delta: delta > QTY_EPS ? delta : 0, events };
  })();
}
