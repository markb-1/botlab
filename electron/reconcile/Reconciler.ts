/**
 * Reconciler (spec §13, §15) — every 60 s in the main process, whether or not bots run.
 *
 * Each run:
 * 1. Clock skew: local time vs exchange server time. More than 5 s ⇒ OrderService rejects new live
 *    orders (`clock_skew`) until a later run sees it fixed; audited + notified once per episode.
 * 2. Orders: every live order that may still fill is checked against the exchange and its fills /
 *    status recorded through the shared transactional path (`applyExchangeOrderState`, exactly once).
 *    Unknown-outcome orders (no exchange id) are searched for: Polymarket — the wallet's open orders and
 *    trades in the token around the submit time (same side, price, size); Binance — by client order id
 *    (= orders.id). Exactly one match ⇒ linked and its fills recorded; several ⇒ left open (ambiguous,
 *    audited); none (both lookups answered) and past expiry ⇒ expired. A failed lookup leaves the order
 *    open (fail closed). Then open orders of bots that are halted or not running are cancelled.
 * 3. Resolved markets (market_cache, confirmed as in R54): order-linked positions in them are closed
 *    with a `resolution` fill at the payout (realized P&L = payout − cost), so they stop counting as
 *    exposure and daily P&L uses the payout. Redemption on-chain is not done here.
 * 4. Positions: Polymarket Data API positions per wallet vs the local order-linked positions of the
 *    bots on that wallet (summed per token); Binance balances vs local Binance positions (only "local
 *    larger than exchange"). Differences beyond dust (0.01 tokens and $0.50) are mismatches: audited and
 *    notified when new; mismatches seen on 2 consecutive runs whose unexplained value exceeds
 *    `limits.reconcile.max_unexplained_usd` ⇒ kill switch (global halt). Exchange positions that already
 *    existed before the wallet's first order (R8) only warn until a human adopts them.
 * 5. `risk_state.reconciled_at` is set when every lookup of the run succeeded.
 *
 * Reconciler failures never halt by themselves: 5 consecutive failed runs ⇒ notification (once).
 */

import type Database from 'better-sqlite3';
import { generateId } from '../database/index';
import type { BotRepository } from '../database/repositories/BotRepository';
import type { BotTradeRepository, RiskPositionRow } from '../database/repositories/BotTradeRepository';
import type { OrderRepository, OrderRow } from '../database/repositories/OrderRepository';
import { OPEN_ORDER_STATUSES } from '../database/repositories/OrderRepository';
import { GLOBAL_SCOPE, type RiskStateRepository } from '../database/repositories/RiskStateRepository';
import type { ScriptRepository } from '../database/repositories/ScriptRepository';
import type { WalletRepository } from '../database/repositories/WalletRepository';
import type { AuditActor, AuditService } from '../audit/AuditService';
import type { KillSwitch } from '../risk/KillSwitch';
import type { OrderCanceller } from '../orders/OrderCanceller';
import type { BinanceAdapter, ClobTrade, PolymarketAdapter } from '../orders/ExchangeAdapter';
import type { ClockSkewGuard } from '../orders/OrderService';
import { applyExchangeOrderState, type ExchangeOrderState, type FillOwner } from '../orders/orderFills';
import type { OrderEventSink, OrderFillEvent } from '../notify/events';
import type { LimitsConfig } from '../config';
import type { MarketView } from '../ledger/MarketCacheService';
import { checkResolution } from '../ledger/scoring';
import type { DataApiPosition, DataApiTrade } from './dataApi';
import logger from '../../src/utils/logger';

export const RECONCILE_INTERVAL_MS = 60_000;
/** Spec §15: refuse live orders when exchange time differs by more than this */
export const MAX_CLOCK_SKEW_MS = 5_000;
/** Without a successful clock check for this long, live orders are refused (`clock_unverified`) */
export const CLOCK_UNVERIFIED_MS = 3 * 60_000;
/** Round trips longer than this give no slack (the midpoint is too uncertain to be generous) */
const MAX_SLACK_RTT_MS = 2_000;
/** Unknown-outcome orders younger than this may still be in flight (OrderService is waiting for the answer) */
export const IN_FLIGHT_GRACE_MS = 2 * 60_000;
/** Consecutive failed runs before a notification (no halt on reconciler outage alone) */
export const RECONCILER_FAILURE_ALERT = 5;
/** Consecutive runs a mismatch must persist before it can halt */
export const MISMATCH_RUNS_TO_HALT = 2;
export const DUST_QTY = 0.01;
export const DUST_USD = 0.5;
/** Polymarket local_excess tolerance (fee possibly taken in shares; unverified) — fraction of the local position */
export const LOCAL_EXCESS_FEE_TOLERANCE = 0.01;
export const DEFAULT_MAX_UNEXPLAINED_USD = 10;
/** Unknown-outcome search window around the order's submit time */
const SEARCH_BEFORE_MS = 60_000;
const SEARCH_AFTER_MS = 10 * 60_000;
/** Same as OrderService: GTD security buffer, market-order lifetime */
const EXPIRY_GRACE_MS = 60_000;
const MARKET_ORDER_LIFETIME_MS = 5 * 60_000;
const LOOKUP_TIMEOUT_MS = 30_000;
const QTY_EPS = 1e-9;
const PRICE_EPS = 1e-9;
const BINANCE_QUOTES = ['USDT', 'USDC', 'FDUSD'];

export interface ReconcileNotifier {
  reconciliationMismatch(summary: string): void;
  /** Clock skew, reconciler outage and recovery (high priority) */
  reconcilerAlert?(text: string): void;
}

export interface ReconcilerDeps {
  db: Database.Database;
  orderRepo: OrderRepository;
  tradeRepo: BotTradeRepository;
  botRepo: Pick<BotRepository, 'findById' | 'findAll'>;
  scriptRepo?: Pick<ScriptRepository, 'findById'>;
  walletRepo: Pick<WalletRepository, 'findById'>;
  riskStateRepo: RiskStateRepository;
  audit: AuditService;
  killSwitch: Pick<KillSwitch, 'activate'>;
  canceller: Pick<OrderCanceller, 'cancelBot'>;
  notify?: ReconcileNotifier;
  /** Recovered live fills (Telegram batches); emitted after commit */
  events?: OrderEventSink;
  marketCache?: Pick<{ getCached(id: string): MarketView | null; getCachedByToken(id: string): MarketView | null; setResolutionSeen(id: string, sig: string | null, at: string | null): void }, 'getCached' | 'getCachedByToken' | 'setResolutionSeen'>;
  /** Fee rates for a token (recovered marketable fills pay taker) */
  getFeeRates: (tokenId: string) => { takerRate: number; makerRate: number };
  /** The bot runs in live mode (its open live orders are its own); otherwise they are cancelled */
  isBotRunning: (botId: string) => boolean;
  /** Authenticated CLOB adapter for a wallet; null/throw ⇒ that wallet's orders cannot be checked this run */
  getPolymarketAdapter: (walletId: string) => Promise<PolymarketAdapter | null>;
  /** null when no Binance credentials are configured */
  getBinanceAdapter: () => BinanceAdapter | null;
  fetchPositions: (user: string) => Promise<DataApiPosition[]>;
  fetchTrades: (user: string, conditionId: string) => Promise<DataApiTrade[]>;
  /**
   * Exchange server time in ms (CLOB /time, else Binance /api/v3/time); `resolutionMs` 1000 for sources that
   * report whole seconds (adds 1 s tolerance)
   */
  getExchangeTime: () => Promise<number | { timeMs: number; resolutionMs: number }>;
  /** Binance spot price (USDT) for valuing a missing balance; optional */
  getBinancePrice?: (symbol: string) => Promise<number>;
  getLimits: () => LimitsConfig | null;
  now?: () => number;
}

export type MismatchDirection = 'exchange_excess' | 'local_excess';

export interface Mismatch {
  key: string;
  walletId: string;
  exchange: 'polymarket' | 'binance';
  /** Token id (Polymarket) or base asset (Binance) */
  symbol: string;
  marketId: string | null;
  direction: MismatchDirection;
  exchangeQty: number;
  localQty: number;
  valueUsd: number;
  /** Value that may halt (excess beyond positions held before the wallet's first order) */
  haltValueUsd: number;
  /** Entirely explained by positions older than the wallet's first order (R8): warn only */
  preExisting: boolean;
  consecutive: number;
}

export interface ReconcileRunResult {
  ok: boolean;
  errors: string[];
  clockSkewMs: number | null;
  ordersChecked: number;
  /** Unknown-outcome orders linked to an exchange order */
  recovered: string[];
  expired: string[];
  ambiguous: string[];
  cancelledBots: string[];
  resolvedPositions: number;
  mismatches: Mismatch[];
  halted: boolean;
}

export interface AdoptResult {
  adopted: Array<{ tokenId: string; marketId: string | null; quantity: number; price: number; postFirstOrderQuantity?: number }>;
  skipped: Array<{ tokenId: string; reason: string }>;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const usd = (n: number): string => `$${n.toFixed(2)}`;

interface OrderAggregate {
  orderId: string;
  side: 'buy' | 'sell';
  size: number;
  notional: number;
  firstMatchMs: number;
  /** price of a maker fill (the order's own price) */
  makerPrice: number | null;
  taker: boolean;
}

/** Group a wallet's CLOB trades in one token by the order they filled (taker or our maker orders). */
export function aggregateTrades(trades: ClobTrade[], tokenId: string, walletAddrs: string[]): Map<string, OrderAggregate> {
  const addrs = new Set(walletAddrs.map((a) => a.toLowerCase()));
  const out = new Map<string, OrderAggregate>();
  const add = (id: string, side: 'buy' | 'sell', size: number, price: number, at: number, taker: boolean) => {
    if (!id || !(size > 0) || !Number.isFinite(price)) return;
    const a = out.get(id) ?? { orderId: id, side, size: 0, notional: 0, firstMatchMs: at, makerPrice: taker ? null : price, taker };
    a.size += size;
    a.notional += size * price;
    a.firstMatchMs = Math.min(a.firstMatchMs, at);
    out.set(id, a);
  };
  for (const t of trades) {
    if (/fail/i.test(t.status)) continue;
    if (t.assetId && t.assetId !== tokenId) continue;
    if (t.traderSide.toUpperCase() === 'TAKER') {
      add(t.takerOrderId, t.side, t.size, t.price, t.matchTimeMs, true);
    } else {
      for (const m of t.makerOrders) {
        if (m.assetId && m.assetId !== tokenId) continue;
        if (addrs.size > 0 && !addrs.has(m.makerAddress.toLowerCase())) continue;
        add(m.orderId, m.side, m.matchedAmount, m.price, t.matchTimeMs, false);
      }
    }
  }
  return out;
}

/** Does an aggregated exchange order look like our order row? */
export function aggregateMatchesRow(a: OrderAggregate, row: OrderRow): boolean {
  if (a.side !== row.side) return false;
  const created = Date.parse(row.created_at);
  if (Number.isFinite(created) && Number.isFinite(a.firstMatchMs)) {
    if (a.firstMatchMs < created - SEARCH_BEFORE_MS) return false;
    if (row.order_type === 'market' && a.firstMatchMs > created + SEARCH_AFTER_MS) return false;
  }
  const avg = a.size > 0 ? a.notional / a.size : NaN;
  if (row.order_type === 'market') {
    if (!a.taker) return false;
    if (row.side === 'buy') {
      // USD-sized: the spend matches (±2%) at or below the worst price
      return avg <= row.price + PRICE_EPS && Math.abs(a.notional - row.notional_usd) <= Math.max(0.02 * row.notional_usd, 0.01);
    }
    return avg >= row.price - PRICE_EPS && Math.abs(a.size - row.size) <= Math.max(1e-6 * row.size, 0.01);
  }
  // Limit order: never more than its size; maker fills at its price, taker fills at its price or better
  if (a.size > row.size + 0.01) return false;
  if (a.taker) return row.side === 'buy' ? avg <= row.price + PRICE_EPS : avg >= row.price - PRICE_EPS;
  return a.makerPrice !== null && Math.abs(a.makerPrice - row.price) < 1e-6;
}

type SearchOutcome =
  | { kind: 'found'; exchangeOrderId: string; state: ExchangeOrderState }
  | { kind: 'absent' }
  | { kind: 'ambiguous'; candidates: string[] };

export class Reconciler implements ClockSkewGuard {
  private deps: ReconcilerDeps;
  private now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<ReconcileRunResult | null> | null = null;
  private consecutiveFailures = 0;
  private outageAlerted = false;
  private skew: { skewed: boolean; detail: string | null; ms: number | null } = { skewed: false, detail: null, ms: null };
  /** Last successful clock check (else construction time): no check for 3 min ⇒ clock_unverified */
  private lastClockOkAt: number;
  private unverifiedReported = false;
  /** mismatch key → consecutive runs seen */
  private mismatchRuns = new Map<string, number>();
  private lastReportedKeys = new Set<string>();
  private ambiguousReported = new Set<string>();
  private last: { at: string; result: ReconcileRunResult } | null = null;

  constructor(deps: ReconcilerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.lastClockOkAt = this.now();
  }

  // ── ClockSkewGuard ──────────────────────────────────────────────

  status(): { skewed: boolean; detail: string | null; reason?: 'clock_skew' | 'clock_unverified' } {
    if (this.skew.skewed) return { skewed: true, detail: this.skew.detail, reason: 'clock_skew' };
    const since = this.now() - this.lastClockOkAt;
    if (since > CLOCK_UNVERIFIED_MS) {
      return { skewed: true, detail: `no successful exchange clock check for ${Math.round(since / 1000)} s`, reason: 'clock_unverified' };
    }
    return { skewed: false, detail: null };
  }

  /** Last finished run (for IPC / health). */
  lastRun(): { at: string; result: ReconcileRunResult; consecutiveFailures: number; clockSkewed: boolean } | null {
    return this.last ? { ...this.last, consecutiveFailures: this.consecutiveFailures, clockSkewed: this.skew.skewed } : null;
  }

  // ── Scheduling ──────────────────────────────────────────────────

  start(intervalMs = RECONCILE_INTERVAL_MS): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  private tick(): void {
    if (this.running) return; // previous run still going: skip this cycle
    void this.runSafe();
  }

  /** One run that never throws; a run already in progress is joined. */
  runSafe(): Promise<ReconcileRunResult | null> {
    if (this.running) return this.running;
    this.running = this.runOnce()
      .then((r) => {
        this.last = { at: new Date(this.now()).toISOString(), result: r };
        this.afterRun(r.ok, r.errors.join('; '));
        return r;
      })
      .catch((err) => {
        this.afterRun(false, errMsg(err));
        return null;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private afterRun(ok: boolean, error: string): void {
    if (ok) {
      if (this.outageAlerted) {
        this.deps.audit.record('system', 'reconcile.recovered', null, { after: this.consecutiveFailures });
        this.alert(`Reconciler recovered after ${this.consecutiveFailures} failed runs`);
      }
      this.consecutiveFailures = 0;
      this.outageAlerted = false;
      return;
    }
    this.consecutiveFailures++;
    logger.error(`[Reconciler] Run incomplete (${this.consecutiveFailures} in a row): ${error}`);
    if (this.consecutiveFailures === 1 || this.consecutiveFailures === RECONCILER_FAILURE_ALERT) {
      this.deps.audit.record('system', 'reconcile.error', null, { error: error.slice(0, 2000), consecutive: this.consecutiveFailures }, 'error');
    }
    if (this.consecutiveFailures >= RECONCILER_FAILURE_ALERT && !this.outageAlerted) {
      this.outageAlerted = true;
      this.alert(`Reconciler failed ${this.consecutiveFailures} runs in a row (positions/orders not verified; trading continues): ${error.slice(0, 300)}`);
    }
  }

  private alert(text: string): void {
    try {
      if (this.deps.notify?.reconcilerAlert) this.deps.notify.reconcilerAlert(text);
      else this.deps.notify?.reconciliationMismatch(text);
    } catch (err) {
      logger.error(`[Reconciler] notification failed: ${errMsg(err)}`);
    }
  }

  // ── Run ─────────────────────────────────────────────────────────

  async runOnce(): Promise<ReconcileRunResult> {
    const result: ReconcileRunResult = {
      ok: false,
      errors: [],
      clockSkewMs: null,
      ordersChecked: 0,
      recovered: [],
      expired: [],
      ambiguous: [],
      cancelledBots: [],
      resolvedPositions: 0,
      mismatches: [],
      halted: false,
    };
    await this.checkClock(result);
    const failedWallets = new Set<string>();
    await this.syncOrders(result, failedWallets);
    try {
      result.resolvedPositions = this.resolveMarkets();
    } catch (err) {
      result.errors.push(`resolution: ${errMsg(err)}`);
    }
    await this.cancelOrphans(result);
    await this.checkPositions(result, failedWallets);
    result.ok = result.errors.length === 0;
    if (result.ok) this.deps.riskStateRepo.setReconciledAt(new Date(this.now()).toISOString());
    return result;
  }

  // ── 1. Clock ────────────────────────────────────────────────────

  private async checkClock(result: ReconcileRunResult): Promise<void> {
    let skewMs: number;
    let resolutionMs = 1;
    try {
      const t0 = this.now();
      const answer = await withTimeout(this.deps.getExchangeTime(), LOOKUP_TIMEOUT_MS, 'exchange time');
      const t1 = this.now();
      const server = typeof answer === 'number' ? answer : answer.timeMs;
      resolutionMs = typeof answer === 'number' ? 1 : answer.resolutionMs;
      if (!Number.isFinite(server)) throw new Error('no server time');
      // Round-trip midpoint; the uncertainty (half the round trip) is given to the local clock, unless the
      // round trip is so long that the midpoint means little
      skewMs = server - (t0 + t1) / 2;
      const rtt = t1 - t0;
      if (rtt <= MAX_SLACK_RTT_MS) skewMs = Math.sign(skewMs) * Math.max(0, Math.abs(skewMs) - rtt / 2);
    } catch (err) {
      // Unknown: keep the previous state (a skew stays blocking until it is seen fixed); after 3 min without
      // a successful check live orders are refused (status(): clock_unverified)
      result.errors.push(`clock: ${errMsg(err)}`);
      if (this.now() - this.lastClockOkAt > CLOCK_UNVERIFIED_MS && !this.unverifiedReported) {
        this.unverifiedReported = true;
        this.deps.audit.record('system', 'reconcile.clock_unverified', null, { error: errMsg(err) }, 'live orders blocked');
        this.alert(`Exchange clock could not be checked for over ${CLOCK_UNVERIFIED_MS / 60_000} min (${errMsg(err)}); new live orders are refused until it can.`);
      }
      return;
    }
    this.lastClockOkAt = this.now();
    if (this.unverifiedReported) {
      this.unverifiedReported = false;
      this.deps.audit.record('system', 'reconcile.clock_verified', null, { skewMs: Math.round(skewMs) });
    }
    result.clockSkewMs = skewMs;
    // Whole-second sources (CLOB /time) get 1 s more tolerance
    const skewed = Math.abs(skewMs) > MAX_CLOCK_SKEW_MS + (resolutionMs >= 1000 ? 1000 : 0);
    const detail = `local clock ${skewMs > 0 ? 'behind' : 'ahead of'} exchange time by ${(Math.abs(skewMs) / 1000).toFixed(1)} s (max ${MAX_CLOCK_SKEW_MS / 1000} s); fix NTP`;
    if (skewed && !this.skew.skewed) {
      this.deps.audit.record('system', 'reconcile.clock_skew', null, { skewMs: Math.round(skewMs) }, 'live orders blocked');
      logger.error(`[Reconciler] Clock skew: ${detail}; live orders blocked`);
      this.alert(`Clock skew: ${detail}. New live orders are refused until it is fixed.`);
    } else if (!skewed && this.skew.skewed) {
      this.deps.audit.record('system', 'reconcile.clock_ok', null, { skewMs: Math.round(skewMs) }, 'live orders allowed');
      logger.info('[Reconciler] Clock skew fixed; live orders allowed again');
      this.alert(`Clock skew fixed (${(skewMs / 1000).toFixed(1)} s); live orders allowed again.`);
    }
    this.skew = { skewed, detail: skewed ? detail : null, ms: skewMs };
  }

  // ── 2. Orders ───────────────────────────────────────────────────

  private owner(botId: string): FillOwner {
    const bot = this.deps.botRepo.findById(botId);
    const script = bot && this.deps.scriptRepo ? this.deps.scriptRepo.findById(bot.script_id) : undefined;
    return { botId, botName: bot?.name ?? botId, scriptName: script?.name ?? '', simulated: false };
  }

  private walletAddrs(walletId: string): string[] {
    const w = this.deps.walletRepo.findById(walletId);
    return w ? [w.proxy_address, w.address].filter((a): a is string => !!a && a.trim().length > 0) : [];
  }

  /** Wallet an order belongs to: stored on the row at creation, else its bot's current wallet. */
  private walletOf(row: OrderRow): string | null {
    return row.wallet_id ?? this.deps.botRepo.findById(row.bot_id)?.wallet_id ?? null;
  }

  /** Unknown-outcome order that OrderService may still be waiting on (do not race the placement). */
  private inFlight(row: OrderRow): boolean {
    return row.status === 'submitted' && !row.exchange_order_id && this.now() - Date.parse(row.created_at) < IN_FLIGHT_GRACE_MS;
  }

  private async syncOrders(result: ReconcileRunResult, failedWallets: Set<string>, onlyWallet?: string): Promise<void> {
    const rows = this.deps.orderRepo
      .findOpen(undefined, false)
      .filter((r) => !onlyWallet || (r.exchange === 'polymarket' && this.walletOf(r) === onlyWallet));
    const adapters = new Map<string, Promise<PolymarketAdapter | null>>();
    const adapterFor = (walletId: string) => {
      let p = adapters.get(walletId);
      if (!p) {
        p = withTimeout(this.deps.getPolymarketAdapter(walletId), LOOKUP_TIMEOUT_MS, 'exchange client');
        adapters.set(walletId, p);
      }
      return p;
    };

    for (const row of rows) {
      if (this.inFlight(row)) continue;
      result.ordersChecked++;
      const walletId = this.walletOf(row);
      try {
        if (row.exchange === 'binance') {
          await this.syncBinanceOrder(row, result);
          continue;
        }
        if (!walletId) throw new Error(`bot ${row.bot_id} not found (wallet unknown)`);
        const adapter = await adapterFor(walletId);
        if (!adapter) throw new Error('no exchange client for the wallet');
        if (row.exchange_order_id) await this.syncPolymarketOrder(row, adapter, result);
        else await this.searchPolymarketOrder(row, adapter, walletId, result);
      } catch (err) {
        if (walletId && row.exchange === 'polymarket') failedWallets.add(walletId);
        if (row.exchange === 'binance') failedWallets.add('binance');
        result.errors.push(`order ${row.id}: ${errMsg(err)}`);
      }
    }
  }

  /** Record a fill/status from the exchange via the shared path; emit fills after commit. */
  private apply(row: OrderRow, state: ExchangeOrderState, opts: { exchangeOrderId?: string | null; feeRate?: number }): void {
    const view = this.deps.marketCache?.getCachedByToken(row.token_id) ?? null;
    const r = applyExchangeOrderState(this.deps, row.id, state, {
      now: this.now(),
      owner: this.owner(row.bot_id),
      feeRate: opts.feeRate,
      exchangeOrderId: opts.exchangeOrderId,
      info: view ? { question: view.question, outcome: view.tokens.find((t) => t.tokenId === row.token_id)?.outcome ?? null, category: view.category } : null,
    });
    if (r.delta > 0) {
      this.deps.audit.record('system', 'reconcile.fill', row.id, { botId: row.bot_id, tokenId: row.token_id, side: row.side, size: r.delta, status: r.status });
      logger.info(`[Reconciler] Recorded fill of ${r.delta} on order ${row.id} (bot ${row.bot_id})`);
    }
    this.emit(r.events);
  }

  private emit(events: OrderFillEvent[]): void {
    for (const e of events) {
      try {
        this.deps.events?.orderFilled(e);
      } catch (err) {
        logger.error(`[Reconciler] fill notification failed: ${errMsg(err)}`);
      }
    }
  }

  private expire(row: OrderRow, why: string, result: ReconcileRunResult): void {
    const changed = this.deps.db.transaction((): boolean => {
      const fresh = this.deps.orderRepo.findById(row.id);
      if (!fresh || !OPEN_ORDER_STATUSES.includes(fresh.status)) return false;
      this.deps.orderRepo.update(row.id, { status: 'expired' });
      return true;
    })();
    if (!changed) return;
    result.expired.push(row.id);
    this.deps.audit.record('system', 'reconcile.order_expired', row.id, { botId: row.bot_id, exchange: row.exchange, why });
    logger.info(`[Reconciler] Order ${row.id} expired (${why})`);
  }

  /** When an order that can no longer be found may be declared dead. */
  private deadline(row: OrderRow): number {
    const exp = row.expires_at ? Date.parse(row.expires_at) : NaN;
    if (Number.isFinite(exp)) return exp + EXPIRY_GRACE_MS;
    return Date.parse(row.created_at) + MARKET_ORDER_LIFETIME_MS + EXPIRY_GRACE_MS;
  }

  private async syncPolymarketOrder(row: OrderRow, adapter: PolymarketAdapter, result: ReconcileRunResult): Promise<void> {
    const ex = await withTimeout(adapter.getOrder(row.exchange_order_id!), LOOKUP_TIMEOUT_MS, 'getOrder');
    if (ex) this.apply(row, ex, { feeRate: row.order_type === 'market' ? this.deps.getFeeRates(row.token_id).takerRate : 0 });
    const exp = row.expires_at ? Date.parse(row.expires_at) : null;
    const now = this.now();
    if (exp !== null && (now >= exp + EXPIRY_GRACE_MS || (!ex && now >= exp))) {
      this.expire(row, ex ? 'past GTD expiry' : 'not returned by exchange after expiry', result);
    }
  }

  /** Unknown-outcome Polymarket order: find it among the wallet's open orders and trades. */
  private async searchPolymarketOrder(row: OrderRow, adapter: PolymarketAdapter, walletId: string, result: ReconcileRunResult): Promise<void> {
    const outcome = await this.findPolymarketOrder(row, adapter, walletId);
    if (outcome.kind === 'found') {
      const state = outcome.state;
      this.apply(row, state, {
        exchangeOrderId: outcome.exchangeOrderId,
        feeRate: row.order_type === 'market' ? this.deps.getFeeRates(row.token_id).takerRate : 0,
      });
      // Linked even if nothing filled (a live resting order): later runs sync it by id
      const after = this.deps.orderRepo.findById(row.id);
      if (after && !after.exchange_order_id) this.deps.orderRepo.update(row.id, { exchangeOrderId: outcome.exchangeOrderId });
      result.recovered.push(row.id);
      this.deps.audit.record('system', 'reconcile.order_recovered', row.id, {
        botId: row.bot_id,
        exchangeOrderId: outcome.exchangeOrderId,
        status: after?.status,
        filledSize: after?.filled_size,
      });
      logger.warning(`[Reconciler] Unknown-outcome order ${row.id} found on the exchange as ${outcome.exchangeOrderId} (${after?.status})`);
      return;
    }
    if (outcome.kind === 'ambiguous') {
      result.ambiguous.push(row.id);
      if (!this.ambiguousReported.has(row.id)) {
        this.ambiguousReported.add(row.id);
        this.deps.audit.record('system', 'reconcile.order_ambiguous', row.id, { botId: row.bot_id, candidates: outcome.candidates }, 'left open');
        this.safeMismatch(`order ${row.id} (bot ${row.bot_id}): outcome unknown and ${outcome.candidates.length} exchange orders match it; left open (counts as exposure) — check by hand`);
      }
      return;
    }
    if (this.now() >= this.deadline(row)) this.expire(row, 'outcome unknown; no matching order or trade on the exchange', result);
  }

  private async findPolymarketOrder(row: OrderRow, adapter: PolymarketAdapter, walletId: string): Promise<SearchOutcome> {
    if (!adapter.getOpenOrders || !adapter.getTrades) throw new Error('exchange client cannot search orders/trades');
    const created = Date.parse(row.created_at);
    const linked = (id: string) => {
      const other = this.deps.orderRepo.findByExchangeOrderId(id);
      return !!other && other.id !== row.id;
    };
    const [open, trades] = await Promise.all([
      withTimeout(adapter.getOpenOrders(row.token_id), LOOKUP_TIMEOUT_MS, 'open orders'),
      withTimeout(adapter.getTrades(row.token_id, Math.floor((created - SEARCH_BEFORE_MS) / 1000)), LOOKUP_TIMEOUT_MS, 'trades'),
    ]);

    const candidates = new Map<string, ExchangeOrderState>();
    if (row.order_type === 'limit') {
      for (const o of open) {
        if (o.side !== row.side || Math.abs(o.price - row.price) > 1e-6 || Math.abs(o.originalSize - row.size) > 1e-6) continue;
        if (Number.isFinite(o.createdAtMs) && (o.createdAtMs < created - SEARCH_BEFORE_MS || o.createdAtMs > created + SEARCH_AFTER_MS)) continue;
        if (linked(o.id)) continue;
        candidates.set(o.id, { status: 'live', sizeMatched: o.sizeMatched, originalSize: o.originalSize, price: o.price });
      }
    }
    for (const a of aggregateTrades(trades, row.token_id, this.walletAddrs(walletId)).values()) {
      if (candidates.has(a.orderId) || linked(a.orderId) || !aggregateMatchesRow(a, row)) continue;
      const full = row.order_type === 'market' || a.size >= row.size - QTY_EPS;
      // Not resting any more (not among open orders) and not full: the rest was cancelled/expired
      candidates.set(a.orderId, { status: full ? 'matched' : 'canceled', sizeMatched: a.size, filledNotional: a.notional });
    }

    if (candidates.size > 1) return { kind: 'ambiguous', candidates: [...candidates.keys()] };
    if (candidates.size === 0) return { kind: 'absent' };
    const [id, fromSearch] = [...candidates.entries()][0];
    // Prefer the exchange's own view of the order; fall back to what the search saw
    let state: ExchangeOrderState = fromSearch;
    try {
      const ex = await withTimeout(adapter.getOrder(id), LOOKUP_TIMEOUT_MS, 'getOrder');
      if (ex) state = { ...ex, filledNotional: fromSearch.filledNotional ?? null };
    } catch {
      /* keep the search's view */
    }
    return { kind: 'found', exchangeOrderId: id, state };
  }

  private async syncBinanceOrder(row: OrderRow, result: ReconcileRunResult): Promise<void> {
    const adapter = this.deps.getBinanceAdapter();
    if (!adapter?.getOrder) throw new Error('Binance credentials not available: cannot check the order');
    const q = await withTimeout(adapter.getOrder(row.market_id, row.id), LOOKUP_TIMEOUT_MS, 'Binance order');
    if (!q.found) {
      // Binance says it never got the order: dead once its lifetime is over
      if (this.now() >= this.deadline(row)) this.expire(row, 'Binance: order does not exist', result);
      return;
    }
    const before = row.exchange_order_id;
    this.apply(
      row,
      { status: q.status, sizeMatched: q.executedQty, originalSize: q.origQty, filledNotional: q.cummulativeQuoteQty },
      { exchangeOrderId: String(q.orderId), feeRate: 0 }
    );
    if (!before) {
      result.recovered.push(row.id);
      this.deps.audit.record('system', 'reconcile.order_recovered', row.id, { botId: row.bot_id, exchange: 'binance', exchangeOrderId: String(q.orderId), status: q.status, executedQty: q.executedQty });
    }
  }

  /** Cancel open live orders of bots that are halted or not running (as at startup, R19). */
  private async cancelOrphans(result: ReconcileRunResult): Promise<void> {
    const open = this.deps.orderRepo.findOpen(undefined, false);
    const globalHalted = this.deps.riskStateRepo.isHalted(GLOBAL_SCOPE);
    const bots = new Set(open.filter((o) => o.exchange === 'polymarket' && o.exchange_order_id).map((o) => o.bot_id));
    for (const botId of bots) {
      const halted = globalHalted || this.deps.riskStateRepo.isHalted(botId);
      if (!halted && this.deps.isBotRunning(botId)) continue;
      try {
        const r = await this.deps.canceller.cancelBot(botId);
        result.cancelledBots.push(botId);
        const ok = r.failed === 0 && r.errors.length === 0;
        this.deps.audit.record('system', 'reconcile.orphan_orders', botId, { reason: halted ? 'halted' : 'not running', ...r }, ok ? 'ok' : 'partial');
        if (!ok) result.errors.push(`cancel orders of bot ${botId}: ${r.errors.join('; ') || `${r.failed} not confirmed`}`);
      } catch (err) {
        result.errors.push(`cancel orders of bot ${botId}: ${errMsg(err)}`);
      }
    }
  }

  // ── 3. Resolved markets ─────────────────────────────────────────

  /** Close order-linked positions (live and paper) in confirmed-resolved markets at the payout. */
  private resolveMarkets(): number {
    const cache = this.deps.marketCache;
    if (!cache) return 0;
    const positions = [false, true].flatMap((simulated) =>
      this.deps.tradeRepo.getRiskPositions({ simulated, exchange: 'polymarket' }).map((p) => ({ ...p, simulated }))
    );
    const byMarket = new Map<string, Array<RiskPositionRow & { simulated: boolean }>>();
    for (const p of positions) {
      if (!p.condition_id || p.net_quantity <= QTY_EPS) continue;
      byMarket.set(p.condition_id, [...(byMarket.get(p.condition_id) ?? []), p]);
    }
    let n = 0;
    for (const [marketId, held] of byMarket) {
      const view = cache.getCached(marketId);
      if (!view) continue;
      const check = checkResolution(view, this.now());
      if (check.status === 'unresolved') {
        if (check.clearSeen) cache.setResolutionSeen(marketId, null, null);
        continue;
      }
      if (check.status === 'pending') {
        if (check.setSeen) cache.setResolutionSeen(marketId, check.setSeen.signature, check.setSeen.at);
        continue;
      }
      const payouts = check.resolution.kind === 'void' ? view.tokens.map(() => 0.5) : check.resolution.payouts;
      for (const p of held) {
        const idx = view.tokens.findIndex((t) => t.tokenId === p.symbol);
        if (idx < 0 || idx >= payouts.length) {
          logger.warning(`[Reconciler] Resolved market ${marketId}: token ${p.symbol} not among its outcomes; position left open`);
          continue;
        }
        if (this.closeResolvedPosition(p, marketId, payouts[idx], view)) n++;
      }
    }
    return n;
  }

  private closeResolvedPosition(p: RiskPositionRow & { simulated: boolean }, marketId: string, payout: number, view: MarketView): boolean {
    const done = this.deps.db.transaction((): { qty: number; cost: number } | null => {
      // Re-read inside the transaction: a position is closed once
      const fresh = this.deps.tradeRepo
        .getRiskPositions({ simulated: p.simulated, botId: p.bot_id, exchange: 'polymarket' })
        .find((r) => r.symbol === p.symbol);
      if (!fresh || fresh.net_quantity <= QTY_EPS) return null;
      const owner = this.owner(p.bot_id);
      this.deps.tradeRepo.create({
        botId: p.bot_id,
        botName: owner.botName,
        scriptName: owner.scriptName,
        exchange: 'polymarket',
        side: 'SELL',
        symbol: p.symbol,
        conditionId: marketId,
        market: view.question,
        outcome: view.tokens.find((t) => t.tokenId === p.symbol)?.outcome,
        price: payout,
        quantity: fresh.net_quantity,
        quoteAmount: fresh.net_quantity * payout,
        simulated: p.simulated ? 1 : 0,
        orderId: `resolve:${marketId}`,
        feeUsd: 0,
        category: view.category,
        fillSource: 'resolution',
      });
      return { qty: fresh.net_quantity, cost: fresh.cost_basis };
    })();
    if (!done) return false;
    const realized = done.qty * payout - done.cost;
    this.deps.audit.record('system', 'reconcile.position_resolved', p.bot_id, {
      marketId,
      tokenId: p.symbol,
      simulated: p.simulated,
      quantity: done.qty,
      payout,
      costBasis: done.cost,
      realizedPnl: realized,
    });
    logger.info(`[Reconciler] ${p.simulated ? 'Paper' : 'Live'} position of bot ${p.bot_id} in resolved market ${marketId} closed at ${payout} (realized ${usd(realized)}); redeem on-chain by hand`);
    return true;
  }

  // ── 4. Positions ────────────────────────────────────────────────

  /** Live order-linked Polymarket positions of the bots on a wallet, per token. */
  private localPositions(walletId: string): Map<string, { qty: number; cost: number; marketId: string | null }> {
    const out = new Map<string, { qty: number; cost: number; marketId: string | null }>();
    for (const p of this.deps.tradeRepo.getLiveWalletPositions()) {
      if (p.wallet_id !== walletId) continue;
      out.set(p.symbol, { qty: p.net_quantity, cost: p.cost_basis, marketId: p.condition_id });
    }
    return out;
  }

  /** Wallets used by a bot or holding order-linked live positions (paper wallets excluded). */
  private liveWallets(): string[] {
    const ids = new Set([...this.deps.botRepo.findAll().map((b) => b.wallet_id), ...this.deps.tradeRepo.getLiveWalletPositions().map((p) => p.wallet_id)]);
    return [...ids].filter((id) => {
      const w = this.deps.walletRepo.findById(id);
      return !!w && w.is_paper !== 1;
    });
  }

  /** Market closed / resolved: the position is settled by the resolution path, not compared. */
  private settled(tokenId: string, marketId: string | null, ex: DataApiPosition | undefined): boolean {
    if (ex?.redeemable) return true;
    const view = this.deps.marketCache?.getCachedByToken(tokenId) ?? (marketId ? this.deps.marketCache?.getCached(marketId) : null) ?? null;
    return !!view?.closed;
  }

  /** Quantity of a token the wallet held before `beforeMs` (net of sells); 0 if unknown (fail closed). */
  private async heldBefore(user: string, marketId: string | null, tokenId: string, beforeMs: number): Promise<number> {
    try {
      return await this.heldBeforeStrict(user, marketId, tokenId, beforeMs);
    } catch (err) {
      logger.warning(`[Reconciler] Could not read trade history of ${tokenId}: ${errMsg(err)}; treated as not pre-existing`);
      return 0;
    }
  }

  /** Same, but a failed lookup throws (adoption refuses rather than guess). */
  private async heldBeforeStrict(user: string, marketId: string | null, tokenId: string, beforeMs: number): Promise<number> {
    if (!marketId) return 0;
    const trades = await withTimeout(this.deps.fetchTrades(user, marketId), LOOKUP_TIMEOUT_MS, 'Data API trades');
    let qty = 0;
    for (const t of trades) {
      if (t.tokenId !== tokenId || t.timestampMs >= beforeMs) continue;
      qty += t.side === 'BUY' ? t.size : -t.size;
    }
    return Math.max(0, qty);
  }

  /** Exchange positions not explained by local fills, per token (shared with adoption). */
  private async polymarketDiffs(walletId: string): Promise<Array<Omit<Mismatch, 'key' | 'consecutive' | 'preExisting' | 'haltValueUsd'> & { price: number | null; user: string }>> {
    const w = this.deps.walletRepo.findById(walletId);
    if (!w) throw new Error(`wallet ${walletId} not found`);
    const user = w.proxy_address?.trim() || w.address;
    const exchange = await withTimeout(this.deps.fetchPositions(user), LOOKUP_TIMEOUT_MS, 'Data API positions');
    const exMap = new Map<string, DataApiPosition>();
    for (const p of exchange) {
      const prev = exMap.get(p.tokenId);
      exMap.set(p.tokenId, prev ? { ...prev, size: prev.size + p.size } : p);
    }
    const local = this.localPositions(walletId);
    const out: Array<Omit<Mismatch, 'key' | 'consecutive' | 'preExisting' | 'haltValueUsd'> & { price: number | null; user: string }> = [];
    for (const tokenId of new Set([...exMap.keys(), ...local.keys()])) {
      const ex = exMap.get(tokenId);
      const loc = local.get(tokenId);
      const marketId = ex?.conditionId ?? loc?.marketId ?? null;
      if (this.settled(tokenId, marketId, ex)) continue;
      const exchangeQty = ex?.size ?? 0;
      const localQty = loc?.qty ?? 0;
      const diff = exchangeQty - localQty;
      // Until verified whether the CLOB takes the taker fee in shares, local may exceed the exchange by up to 1 %
      const tolerance = diff < 0 ? Math.max(DUST_QTY, LOCAL_EXCESS_FEE_TOLERANCE * localQty) : DUST_QTY;
      if (Math.abs(diff) <= tolerance) continue;
      const markPrice = ex?.curPrice ?? (loc && loc.qty > 0 ? loc.cost / loc.qty : null);
      // Unknown price ⇒ valued at $1 per share (the most a share can be worth)
      const valueUsd = Math.abs(diff) * (markPrice ?? 1);
      if (valueUsd <= DUST_USD) continue;
      out.push({
        walletId,
        exchange: 'polymarket',
        symbol: tokenId,
        marketId,
        direction: diff > 0 ? 'exchange_excess' : 'local_excess',
        exchangeQty,
        localQty,
        valueUsd,
        price: ex?.curPrice ?? ex?.avgPrice ?? null,
        user,
      });
    }
    return out;
  }

  private async checkPositions(result: ReconcileRunResult, failedWallets: Set<string>): Promise<void> {
    const found: Array<Omit<Mismatch, 'consecutive'>> = [];
    const skipped = new Set<string>();

    for (const walletId of this.liveWallets()) {
      if (failedWallets.has(walletId)) {
        skipped.add(walletId); // orders not synced: positions would be compared against stale fills
        continue;
      }
      try {
        const diffs = await this.polymarketDiffs(walletId);
        const firstOrder = this.deps.orderRepo.firstLiveOrderAtForWallet(walletId);
        const firstOrderMs = firstOrder ? Date.parse(firstOrder) : null;
        for (const d of diffs) {
          let haltQty = Math.abs(d.exchangeQty - d.localQty);
          if (d.direction === 'exchange_excess') {
            // R8: positions bought before the wallet's first order only warn until adopted
            const pre = firstOrderMs === null ? Infinity : await this.heldBefore(d.user, d.marketId, d.symbol, firstOrderMs);
            haltQty = Math.max(0, haltQty - pre);
          }
          const perShare = d.valueUsd / Math.abs(d.exchangeQty - d.localQty);
          const haltValueUsd = haltQty > DUST_QTY ? haltQty * perShare : 0;
          found.push({
            key: `${walletId}:polymarket:${d.symbol}:${d.direction}`,
            walletId,
            exchange: 'polymarket',
            symbol: d.symbol,
            marketId: d.marketId,
            direction: d.direction,
            exchangeQty: d.exchangeQty,
            localQty: d.localQty,
            valueUsd: d.valueUsd,
            haltValueUsd,
            preExisting: haltValueUsd === 0,
          });
        }
      } catch (err) {
        skipped.add(walletId);
        result.errors.push(`positions of wallet ${walletId}: ${errMsg(err)}`);
      }
    }

    if (failedWallets.has('binance')) skipped.add('binance');
    else {
      try {
        found.push(...(await this.binanceDiffs()));
      } catch (err) {
        skipped.add('binance');
        result.errors.push(`Binance balances: ${errMsg(err)}`);
      }
    }

    // Debounce: count consecutive runs per key; keys of wallets not checked this run keep their count
    const next = new Map<string, number>();
    for (const [k, n] of this.mismatchRuns) {
      if (skipped.has(k.split(':')[0])) next.set(k, n); // key = wallet id (or 'binance') : exchange : symbol : direction
    }
    const mismatches: Mismatch[] = found.map((m) => {
      const consecutive = (this.mismatchRuns.get(m.key) ?? 0) + 1;
      next.set(m.key, consecutive);
      return { ...m, consecutive };
    });
    this.mismatchRuns = next;
    result.mismatches = mismatches;

    // Mismatches of wallets not checked this run are neither new nor gone
    this.report(mismatches, [...next.keys()].filter((k) => !mismatches.some((m) => m.key === k)));

    const limit = this.deps.getLimits()?.reconcile.max_unexplained_usd ?? DEFAULT_MAX_UNEXPLAINED_USD;
    const persistent = mismatches.filter((m) => m.consecutive >= MISMATCH_RUNS_TO_HALT && m.haltValueUsd > 0);
    const unexplained = persistent.reduce((s, m) => s + m.haltValueUsd, 0);
    if (unexplained > limit && !this.deps.riskStateRepo.isHalted(GLOBAL_SCOPE)) {
      const detail = persistent
        .slice(0, 5)
        .map((m) => `${m.exchange} ${m.symbol.slice(0, 12)}… exchange ${m.exchangeQty.toFixed(2)} vs local ${m.localQty.toFixed(2)}`)
        .join('; ');
      const reason = `reconciliation: unexplained exposure ${usd(unexplained)} > ${usd(limit)} (${detail})`;
      result.halted = true;
      await this.deps.killSwitch.activate(reason, 'system').catch((err) => logger.error(`[Reconciler] Kill switch failed: ${errMsg(err)}`));
    }
  }

  /** Binance: only "local larger than the account" is checked (the account may hold the human's own coins). */
  private async binanceDiffs(): Promise<Array<Omit<Mismatch, 'consecutive'>>> {
    const local = new Map<string, { qty: number; cost: number }>();
    for (const p of this.deps.tradeRepo.getRiskPositions({ simulated: false, exchange: 'binance' })) {
      const quote = BINANCE_QUOTES.find((q) => p.symbol.toUpperCase().endsWith(q) && p.symbol.length > q.length);
      if (!quote) continue;
      const base = p.symbol.toUpperCase().slice(0, -quote.length);
      const e = local.get(base) ?? { qty: 0, cost: 0 };
      e.qty += p.net_quantity;
      e.cost += p.cost_basis;
      local.set(base, e);
    }
    if (local.size === 0) return [];
    const adapter = this.deps.getBinanceAdapter();
    if (!adapter?.getBalances) throw new Error('Binance credentials not available: bot holdings cannot be verified');
    const balances = await withTimeout(adapter.getBalances(), LOOKUP_TIMEOUT_MS, 'Binance balances');
    const out: Array<Omit<Mismatch, 'consecutive'>> = [];
    for (const [asset, loc] of local) {
      const b = balances.find((x) => x.asset.toUpperCase() === asset);
      const exchangeQty = b ? b.free + b.locked : 0;
      const missing = loc.qty - exchangeQty;
      if (missing <= QTY_EPS) continue;
      let price = loc.qty > 0 ? loc.cost / loc.qty : NaN;
      if (this.deps.getBinancePrice) {
        try {
          price = await withTimeout(this.deps.getBinancePrice(`${asset}USDT`), LOOKUP_TIMEOUT_MS, 'Binance price');
        } catch {
          /* average cost */
        }
      }
      const valueUsd = missing * (Number.isFinite(price) ? price : 0);
      if (valueUsd <= DUST_USD) continue;
      out.push({
        key: `binance:binance:${asset}:local_excess`,
        walletId: 'binance',
        exchange: 'binance',
        symbol: asset,
        marketId: null,
        direction: 'local_excess',
        exchangeQty,
        localQty: loc.qty,
        valueUsd,
        haltValueUsd: valueUsd,
        preExisting: false,
      });
    }
    return out;
  }

  /** Audit + notify when mismatches appear (not on every run); audit when they are all gone. */
  private report(mismatches: Mismatch[], retained: string[]): void {
    const keys = new Set([...mismatches.map((m) => m.key), ...retained.filter((k) => this.lastReportedKeys.has(k))]);
    const fresh = mismatches.filter((m) => !this.lastReportedKeys.has(m.key));
    if (fresh.length > 0) {
      const warnOnly = fresh.every((m) => m.preExisting);
      this.deps.audit.record(
        'system',
        'reconcile.mismatch',
        null,
        { mismatches: fresh.map(({ key: _k, ...m }) => m) },
        warnOnly ? 'warning: pre-existing positions (adopt them with reconcile:adoptPositions)' : 'mismatch'
      );
      const lines = fresh.slice(0, 6).map(
        (m) =>
          `${m.exchange} ${m.symbol.length > 14 ? `${m.symbol.slice(0, 14)}…` : m.symbol}: exchange ${m.exchangeQty.toFixed(2)} vs local ${m.localQty.toFixed(2)} (${usd(m.valueUsd)}${m.preExisting ? ', pre-existing: adopt or sell by hand' : ''})`
      );
      if (fresh.length > 6) lines.push(`…and ${fresh.length - 6} more`);
      logger.warning(`[Reconciler] Position mismatch: ${lines.join('; ')}`);
      this.safeMismatch(lines.join('\n'));
    } else if (keys.size === 0 && this.lastReportedKeys.size > 0) {
      this.deps.audit.record('system', 'reconcile.mismatch_cleared', null, { previous: [...this.lastReportedKeys] });
    }
    this.lastReportedKeys = keys;
  }

  private safeMismatch(summary: string): void {
    try {
      this.deps.notify?.reconciliationMismatch(summary);
    } catch (err) {
      logger.error(`[Reconciler] notification failed: ${errMsg(err)}`);
    }
  }

  // ── Adoption (human, one-time) ──────────────────────────────────

  /**
   * Record a wallet's exchange positions that have no local fills (pre-v3, R8) as `adopted` fills of a bot
   * on that wallet, so they count as exposure, become sellable by the bot and stop triggering mismatches.
   * Priced at the Data API's current price (else its average price): the day's P&L starts from now.
   *
   * Safety (2b review): the wallet's orders are synced first; refused while the wallet has an open live order
   * whose outcome is unknown (no exchange id, incl. ambiguous ones), for retired or halted bots, or when the
   * trade history cannot be read. Per token only the quantity held before the wallet's first order is
   * adopted; anything beyond needs `includePostFirstOrder: true` (audited).
   */
  async adoptPositions(walletId: string, botId: string, actor: AuditActor, opts: { includePostFirstOrder?: boolean } = {}): Promise<AdoptResult> {
    const includePost = opts.includePostFirstOrder === true;
    const deny = (why: string): never => {
      this.deps.audit.record(actor, 'reconcile.adopt', botId, { walletId, includePostFirstOrder: includePost }, `denied: ${why}`);
      throw new Error(why);
    };
    if (actor !== 'human') deny('Only a human can adopt positions');
    const bot = this.deps.botRepo.findById(botId);
    if (!bot) deny(`Bot ${botId} not found`);
    if (bot!.wallet_id !== walletId) deny(`Bot ${botId} does not use wallet ${walletId}`);
    if (bot!.stage === 'retired') deny(`Bot ${botId} is retired`);
    if (this.deps.riskStateRepo.isHalted(botId)) deny(`Bot ${botId} is halted`);
    const wallet = this.deps.walletRepo.findById(walletId);
    if (!wallet || wallet.is_paper === 1) deny('Wallet not found or a paper wallet');

    // Not while a run compares positions
    while (this.running) await this.running;
    let release!: () => void;
    this.running = new Promise<ReconcileRunResult | null>((r) => (release = () => r(null)));
    try {
      // 1. Bring the wallet's orders up to date (fills recorded locally are not "unexplained")
      const sync = { errors: [], ordersChecked: 0, recovered: [], expired: [], ambiguous: [] } as unknown as ReconcileRunResult;
      await this.syncOrders(sync, new Set<string>(), walletId);
      if (sync.errors.length > 0) deny(`order sync failed: ${sync.errors.join('; ').slice(0, 300)}`);
      const unknown = this.deps.orderRepo
        .findOpen(undefined, false)
        .filter((o) => o.exchange === 'polymarket' && !o.exchange_order_id && this.walletOf(o) === walletId);
      if (unknown.length > 0) deny(`wallet has ${unknown.length} open order(s) with unknown outcome (${unknown.map((o) => o.id).join(', ')}); wait for the reconciler`);

      // 2. Exchange excess, capped at what was held before the wallet's first order
      const diffs = (await this.polymarketDiffs(walletId)).filter((d) => d.direction === 'exchange_excess');
      const first = this.deps.orderRepo.firstLiveOrderAtForWallet(walletId);
      const firstMs = first ? Date.parse(first) : null;
      const plan: Array<{ d: (typeof diffs)[number]; qty: number; post: number }> = [];
      const result: AdoptResult = { adopted: [], skipped: [] };
      for (const d of diffs) {
        const excess = d.exchangeQty - d.localQty;
        let pre: number;
        try {
          pre = firstMs === null ? Infinity : await this.heldBeforeStrict(d.user, d.marketId, d.symbol, firstMs);
        } catch (err) {
          deny(`trade history of ${d.symbol} unavailable: ${errMsg(err)}`);
          return result; // unreachable
        }
        // Pre-existing quantity not adopted yet (repeated adoptions cannot exceed it)
        const capped = Math.max(0, Math.min(excess, pre - this.deps.tradeRepo.adoptedQuantity(walletId, d.symbol)));
        const post = Math.max(0, excess - capped);
        const qty = includePost ? excess : capped;
        if (d.price === null || !(d.price >= 0)) {
          result.skipped.push({ tokenId: d.symbol, reason: 'no price from the Data API' });
          continue;
        }
        if (qty <= DUST_QTY) {
          result.skipped.push({ tokenId: d.symbol, reason: `bought after the wallet's first order (${post.toFixed(2)}); pass includePostFirstOrder to adopt` });
          continue;
        }
        if (!includePost && post > DUST_QTY) result.skipped.push({ tokenId: d.symbol, reason: `${post.toFixed(2)} bought after the wallet's first order not adopted` });
        plan.push({ d, qty, post: includePost ? post : 0 });
      }

      const owner = this.owner(botId);
      this.deps.db.transaction(() => {
        for (const { d, qty, post } of plan) {
          const view = this.deps.marketCache?.getCachedByToken(d.symbol) ?? null;
          this.deps.tradeRepo.create({
            botId,
            botName: owner.botName,
            scriptName: owner.scriptName,
            exchange: 'polymarket',
            side: 'BUY',
            symbol: d.symbol,
            conditionId: d.marketId ?? undefined,
            market: view?.question,
            outcome: view?.tokens.find((t) => t.tokenId === d.symbol)?.outcome,
            price: d.price!,
            quantity: qty,
            quoteAmount: qty * d.price!,
            simulated: 0,
            orderId: `adopt:${generateId()}`,
            feeUsd: 0,
            category: view?.category ?? null,
            fillSource: 'adopted',
            walletId,
          });
          result.adopted.push({ tokenId: d.symbol, marketId: d.marketId, quantity: qty, price: d.price!, ...(post > 0 ? { postFirstOrderQuantity: post } : {}) });
        }
      })();
      for (const a of result.adopted) {
        this.mismatchRuns.delete(`${walletId}:polymarket:${a.tokenId}:exchange_excess`);
        this.lastReportedKeys.delete(`${walletId}:polymarket:${a.tokenId}:exchange_excess`);
      }
      this.deps.audit.record(actor, 'reconcile.adopt', botId, { walletId, includePostFirstOrder: includePost, ...result }, result.skipped.length ? 'partial' : 'ok');
      logger.info(`[Reconciler] Adopted ${result.adopted.length} position(s) of wallet ${walletId} into bot ${botId}`);
      return result;
    } finally {
      this.running = null;
      release();
    }
  }
}
