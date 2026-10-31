/**
 * Daily P&L (spec §4.2) — pure, no I/O.
 *
 *   daily P&L = Σ_symbols (qty_now × mark_now − qty_dayStart × mark_dayStart)
 *             + Σ today's sell proceeds − Σ today's buy cost − today's fees
 *
 * which equals realized P&L today + change in mark-to-market of open positions since 00:00 UTC.
 * `qty_dayStart` is rebuilt from the fills (net quantity of fills before the day start), so the
 * result is exact even when the day-start marks were captured some minutes after midnight.
 *
 * Marks: the current mid if available, else the last known mark, else the day-start mark,
 * else the average cost (zero unrealized). Every fallback is reported in `staleMarks` so the
 * caller can log/audit it — a missing price is never silently treated as "no loss".
 */

export interface PnlFill {
  exchange: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  /** USD paid (buy) or received (sell) */
  quoteAmount: number;
  feeUsd: number;
  /** Epoch ms */
  executedAt: number;
}

export type MarkSource = 'live' | 'last_known' | 'day_start' | 'cost';

export interface PositionPnl {
  key: string;
  qtyStart: number;
  qtyNow: number;
  markStart: number;
  markStartSource: MarkSource;
  markNow: number;
  markNowSource: MarkSource;
  /** Average cost × qtyNow */
  costBasisNow: number;
}

export interface DailyPnlResult {
  /** Realized today: sells vs average cost, minus today's fees */
  realizedPnl: number;
  /** total − realized */
  unrealizedChange: number;
  totalPnl: number;
  /** MTM value of the positions held at the day start (day_start marks) */
  dayStartValue: number;
  /** All-time realized (minus all fees) + current unrealized; used for drawdown tracking */
  cumulativePnl: number;
  positions: PositionPnl[];
  /** Keys whose mark (start or now) is not a fresh/recorded price */
  staleMarks: string[];
}

export interface DailyPnlInput {
  /** All order-linked fills of the scope (any time, any order) */
  fills: PnlFill[];
  dayStartMs: number;
  /** Marks captured at the first monitor run of the day */
  dayStartMarks: Record<string, number>;
  /** Fresh mids; missing/null/non-finite = unavailable */
  currentMarks: Record<string, number | null | undefined>;
  lastKnownMarks: Record<string, number>;
}

const QTY_EPS = 1e-9;

export const markKey = (exchange: string, symbol: string): string => `${exchange}:${symbol}`;

/** 00:00 UTC of the day containing `ms`. */
export function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const validPrice = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p >= 0;

export function computeDailyPnl(input: DailyPnlInput): DailyPnlResult {
  const { dayStartMs } = input;
  const fills = [...input.fills].sort((a, b) => a.executedAt - b.executedAt);

  interface Book {
    qty: number;
    cost: number; // total cost of qty at average price
    qtyStart: number;
    avgAtStart: number;
  }
  const books = new Map<string, Book>();
  let realizedAllTime = 0;
  let realizedToday = 0;
  let cashFlowToday = 0;
  let feesAll = 0;
  let feesToday = 0;

  for (const f of fills) {
    const key = markKey(f.exchange, f.symbol);
    let b = books.get(key);
    if (!b) {
      b = { qty: 0, cost: 0, qtyStart: 0, avgAtStart: 0 };
      books.set(key, b);
    }
    const today = f.executedAt >= dayStartMs;
    const qty = Number.isFinite(f.quantity) ? Math.max(f.quantity, 0) : 0;
    const quote = Number.isFinite(f.quoteAmount) ? f.quoteAmount : 0;
    const fee = Number.isFinite(f.feeUsd) ? f.feeUsd : 0;
    feesAll += fee;
    if (today) feesToday += fee;

    if (f.side === 'BUY') {
      b.qty += qty;
      b.cost += quote;
      if (today) cashFlowToday -= quote;
    } else {
      const sold = Math.min(qty, b.qty);
      const avg = b.qty > QTY_EPS ? b.cost / b.qty : 0;
      const pnl = quote - avg * sold; // selling more than held: excess proceeds count as P&L
      realizedAllTime += pnl;
      if (today) {
        realizedToday += pnl;
        cashFlowToday += quote;
      }
      b.cost -= avg * sold;
      b.qty -= sold;
      if (b.qty <= QTY_EPS) {
        b.qty = 0;
        b.cost = 0;
      }
    }
    if (!today) {
      // Fills are sorted, so after the last pre-day fill this is the day-start position
      b.qtyStart = b.qty;
      b.avgAtStart = b.qty > QTY_EPS ? b.cost / b.qty : 0;
    }
  }

  const stale = new Set<string>();
  const positions: PositionPnl[] = [];
  let mtmChange = 0;
  let dayStartValue = 0;
  let unrealizedNow = 0;

  for (const [key, b] of books) {
    if (b.qtyStart <= QTY_EPS && b.qty <= QTY_EPS) continue;
    const avgNow = b.qty > QTY_EPS ? b.cost / b.qty : 0;

    let markNow: number;
    let markNowSource: MarkSource;
    const live = input.currentMarks[key];
    if (validPrice(live)) {
      markNow = live;
      markNowSource = 'live';
    } else if (validPrice(input.lastKnownMarks[key])) {
      markNow = input.lastKnownMarks[key];
      markNowSource = 'last_known';
    } else if (validPrice(input.dayStartMarks[key])) {
      markNow = input.dayStartMarks[key];
      markNowSource = 'day_start';
    } else {
      markNow = avgNow;
      markNowSource = 'cost';
    }

    let markStart = 0;
    let markStartSource: MarkSource = 'day_start';
    if (b.qtyStart > QTY_EPS) {
      if (validPrice(input.dayStartMarks[key])) {
        markStart = input.dayStartMarks[key];
      } else if (validPrice(input.lastKnownMarks[key])) {
        markStart = input.lastKnownMarks[key];
        markStartSource = 'last_known';
      } else {
        markStart = b.avgAtStart;
        markStartSource = 'cost';
      }
    }

    if (b.qty > QTY_EPS && markNowSource !== 'live') stale.add(key);
    if (b.qtyStart > QTY_EPS && markStartSource !== 'day_start') stale.add(key);

    mtmChange += b.qty * markNow - b.qtyStart * markStart;
    dayStartValue += b.qtyStart * markStart;
    unrealizedNow += b.qty * markNow - b.cost;
    positions.push({
      key,
      qtyStart: b.qtyStart,
      qtyNow: b.qty,
      markStart,
      markStartSource,
      markNow,
      markNowSource,
      costBasisNow: b.cost,
    });
  }

  const totalPnl = mtmChange + cashFlowToday - feesToday;
  const realizedPnl = realizedToday - feesToday;
  return {
    realizedPnl,
    unrealizedChange: totalPnl - realizedPnl,
    totalPnl,
    dayStartValue,
    cumulativePnl: realizedAllTime + unrealizedNow - feesAll,
    positions,
    staleMarks: [...stale].sort(),
  };
}
