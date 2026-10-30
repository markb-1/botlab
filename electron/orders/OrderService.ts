/**
 * OrderService — the single choke point for every order from a bot (spec §4).
 *
 *   RpcHandler → OrderService → RiskEngine.check() → exchange adapter (live) / PaperTradingState (paper)
 *
 * Every attempt that gets as far as a risk check is stored in `orders`: rejected ones as
 * `rejected_risk` with the RiskDecision, accepted ones as `submitted` before the exchange is
 * called, then updated with the exchange id, status, fills and fee. Rejections are returned
 * to the bot as a typed `OrderResult` ({ ok: false, failedCheck, error }), never thrown.
 *
 * One instance per running bot (it holds that bot's exchange clients); the snapshot →
 * check → insert sequence is serialised across all instances by a process-wide lock so two
 * bots cannot both pass an exposure check that only one of them fits in.
 */

import type Database from 'better-sqlite3';
import { generateId } from '../database/index';
import type { BotTradeRepository } from '../database/repositories/BotTradeRepository';
import type { OrderRepository, OrderRow, OrderStatus } from '../database/repositories/OrderRepository';
import type { RiskEngine } from '../risk/RiskEngine';
import type {
  Exchange,
  ForecastEdgeInfo,
  MarketSnapshot,
  OrderRequest,
  OrderSide,
  RiskCheckName,
  RiskDecision,
} from '../risk/types';
import type { OrderBook, TradeResult, BinanceOrderBook } from '../sdk/types';
import type { BinanceTradeResult } from '../sdk/binance';
import type { PaperTradingState } from '../runtime/PaperTradingState';
import type { BinanceAdapter, PolymarketAdapter, PostOrderOutcome } from './ExchangeAdapter';
import type { DbRiskStateProvider } from './DbRiskStateProvider';
import type { FeeCategory, FeeService } from './FeeService';
import { mandateCategory, type MarketDataService, type MarketInfo, type MarketQualityProvider } from './MarketDataService';
import logger from '../../src/utils/logger';

const MS_PER_MINUTE = 60_000;
const QTY_EPS = 1e-9;
/** Used when the book does not report a tick size; 0.01 multiples are valid on finer ticks too */
const DEFAULT_TICK = 0.01;
/** USD-quoted Binance pairs; anything else has no USD notional and is rejected */
const BINANCE_USD_QUOTES = ['USDT', 'USDC', 'FDUSD'];

// ─── Public types ──────────────────────────────────────────────────────

export type OrderResultStatus = OrderStatus | 'invalid';

/** Result of placing an order. Never thrown: rejections and failures are `ok: false`. */
export interface OrderResult {
  ok: boolean;
  /** orders.id (also the client/idempotency id); null when the input was invalid and nothing was stored */
  orderId: string | null;
  status: OrderResultStatus;
  /** Shares (Polymarket) or base quantity (Binance) filled so far */
  filledSize: number;
  avgFillPrice: number | null;
  /** USD spent (buy) or received (sell) for the filled part */
  filledNotionalUsd: number;
  /** Expected fee in USD (taker rate × notional for marketable orders) */
  feeUsd: number;
  expiresAt: string | null;
  /** Risk check that rejected the order (status `rejected_risk`) */
  failedCheck?: RiskCheckName;
  error?: string;
}

export interface OrderIntentOpts {
  reason?: string;
  /** Ledger forecast this order trades on (spec §6) */
  forecastId?: string;
  /** Sell flagged as a risk exit (see RiskEngine exemptions) */
  riskExit?: boolean;
}

export interface MarketableOrderInput extends OrderIntentOpts {
  tokenId: string;
  side: OrderSide;
  /** BUY: USD to spend. SELL: shares to sell. */
  amount: number;
  /** BUY: worst (highest) acceptable price */
  maxPrice?: number;
  /** SELL: worst (lowest) acceptable price */
  minPrice?: number;
  /** Price tolerance from the best price when no max/min price is given (default 0) */
  maxSlippage?: number;
}

export interface LimitOrderInput extends OrderIntentOpts {
  tokenId: string;
  side: OrderSide;
  price: number;
  size: number;
  /** Default true (spec §3.1 orders.default_type: resting post-only) */
  postOnly?: boolean;
  /** Capped at orders.resting_order_ttl_minutes */
  ttlMinutes?: number;
}

export interface BinanceOrderInput extends OrderIntentOpts {
  symbol: string;
  side: OrderSide;
  /** BUY: quote (USDT) to spend. SELL: base quantity. */
  amount: number;
}

export interface OpenOrderInfo {
  orderId: string;
  exchange: Exchange;
  marketId: string;
  tokenId: string;
  side: OrderSide;
  orderType: 'limit' | 'market';
  price: number;
  size: number;
  filledSize: number;
  status: OrderStatus;
  expiresAt: string | null;
  createdAt: string;
}

export interface RiskBudget {
  /** Allocation left for new Polymarket buys (also bounded by the global total) */
  remainingAllocation: number;
  /** Per market (bot scope, or markets the bot has exposure in): room left under per_market.max_exposure_usd */
  remainingMarket: Record<string, number>;
  halted: boolean;
}

/** Ledger lookup. TODO(chunk 2a): real ledger; until then no forecast resolves. */
export interface ForecastSource {
  get(forecastId: string, tokenId: string): Promise<ForecastEdgeInfo | null>;
}

export const NoForecastSource: ForecastSource = {
  async get() {
    return null;
  },
};

export interface OrderServiceDeps {
  db: Database.Database;
  orderRepo: OrderRepository;
  tradeRepo: BotTradeRepository;
  riskEngine: RiskEngine;
  provider: DbRiskStateProvider;
  fees: FeeService;
  marketData: Pick<MarketDataService, 'getMarketInfo'>;
  quality: MarketQualityProvider;
  forecasts?: ForecastSource;
  /** Polymarket order book for a token (public endpoint) */
  getBook: (tokenId: string) => Promise<ClobBook>;
  getBinanceBook: (symbol: string) => Promise<BinanceOrderBook>;
  now?: () => number;
}

export interface BotOrderContext {
  botId: string;
  botName: string;
  scriptName: string;
  mode: 'live' | 'paper';
  /** Live only */
  polymarket?: PolymarketAdapter | null;
  /** Live only; null when Binance credentials are not configured */
  binance?: BinanceAdapter | null;
  /** Paper only */
  paperState?: PaperTradingState | null;
}

// ─── Process-wide placement lock ───────────────────────────────────────

let lockTail: Promise<void> = Promise.resolve();

/** Run `fn` exclusively with respect to all other placements in this process. */
async function withPlacementLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lockTail;
  let release!: () => void;
  lockTail = new Promise<void>((r) => (release = r));
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const dbNum = (n: number): number => (Number.isFinite(n) ? n : 0);

/** CLOB book as returned by ClobClient.getOrderBook (tick_size is a string like "0.01"). */
export type ClobBook = OrderBook & { tick_size?: string };

function tickOf(book: ClobBook | null): number {
  const t = book?.tick_size !== undefined ? parseFloat(book.tick_size) : NaN;
  return Number.isFinite(t) && t > 0 && t < 1 ? t : DEFAULT_TICK;
}

/** Round a price onto the tick grid (down for buys, up for sells, so it is never worse than intended). */
function toTick(p: number, tick: number, dir: 'up' | 'down'): number {
  const steps = p / tick;
  const n = dir === 'up' ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9);
  return Math.round(n * tick * 1e6) / 1e6;
}

const onTick = (p: number, tick: number): boolean => Math.abs(p / tick - Math.round(p / tick)) < 1e-6;

/** Best bid/ask and USD size at each from a CLOB book. */
export function bookTop(book: OrderBook | null): Pick<MarketSnapshot, 'bestBid' | 'bestAsk' | 'bestBidSizeUsd' | 'bestAskSizeUsd'> {
  const best = (levels: OrderBook['bids'] | undefined, pick: 'max' | 'min') => {
    let price: number | null = null;
    let size = 0;
    for (const l of levels ?? []) {
      const p = parseFloat(l.price);
      const s = parseFloat(l.size);
      if (!Number.isFinite(p) || !Number.isFinite(s) || s <= 0) continue;
      if (price === null || (pick === 'max' ? p > price : p < price)) {
        price = p;
        size = s;
      } else if (p === price) {
        size += s;
      }
    }
    return { price, sizeUsd: price === null ? null : price * size };
  };
  const bid = best(book?.bids, 'max');
  const ask = best(book?.asks, 'min');
  return { bestBid: bid.price, bestAsk: ask.price, bestBidSizeUsd: bid.sizeUsd, bestAskSizeUsd: ask.sizeUsd };
}

function preDecision(name: RiskCheckName, detail: string, now: number): RiskDecision {
  return {
    allowed: false,
    failedCheck: name,
    reason: detail,
    checks: [{ step: 0, name, passed: false, detail }],
    evaluatedAt: new Date(now).toISOString(),
  };
}

function invalid(error: string): OrderResult {
  return {
    ok: false,
    orderId: null,
    status: 'invalid',
    filledSize: 0,
    avgFillPrice: null,
    filledNotionalUsd: 0,
    feeUsd: 0,
    expiresAt: null,
    error,
  };
}

function resultFromRow(row: OrderRow, extra: Partial<OrderResult> = {}): OrderResult {
  const ok = !['rejected_risk', 'failed', 'cancelled', 'expired'].includes(row.status);
  return {
    ok,
    orderId: row.id,
    status: row.status,
    filledSize: row.filled_size,
    avgFillPrice: row.avg_fill_price,
    filledNotionalUsd: row.avg_fill_price !== null ? row.filled_size * row.avg_fill_price : 0,
    feeUsd: row.fee_usd,
    expiresAt: row.expires_at,
    ...extra,
  };
}

/** Convert an OrderResult to the legacy ctx.buy/sell TradeResult shape. */
export function toTradeResult(r: OrderResult): TradeResult {
  return {
    success: r.filledSize > QTY_EPS,
    executedAmount: r.filledNotionalUsd,
    price: r.avgFillPrice ?? 0,
    tokenAmount: r.filledSize,
    ...(r.error ? { error: r.error } : {}),
    orderId: r.orderId,
    status: r.status,
    ...(r.failedCheck ? { failedCheck: r.failedCheck } : {}),
  };
}

interface PolymarketContext {
  info: MarketInfo | null;
  market: MarketSnapshot | null;
  book: ClobBook | null;
  feeCategory: FeeCategory | null;
  category: string | null;
}

interface Fill {
  size: number;
  notional: number;
}

// ─── Service ───────────────────────────────────────────────────────────

export class OrderService {
  private deps: OrderServiceDeps;
  private bot: BotOrderContext;
  private now: () => number;

  constructor(deps: OrderServiceDeps, bot: BotOrderContext) {
    this.deps = deps;
    this.bot = bot;
    this.now = deps.now ?? Date.now;
  }

  private get paper(): boolean {
    return this.bot.mode === 'paper';
  }

  /** Execution route for Polymarket is missing (checked before anything is stored). */
  private polymarketUnavailable(): string | null {
    if (this.paper) return this.bot.paperState ? null : 'Paper trading state missing for paper bot';
    return this.bot.polymarket ? null : 'Polymarket client not available';
  }

  // ── Polymarket ──────────────────────────────────────────────────────

  private async polymarketContext(tokenId: string): Promise<PolymarketContext> {
    const [info, book] = await Promise.all([
      this.deps.marketData.getMarketInfo(tokenId),
      this.deps.getBook(tokenId).catch(() => null),
    ]);
    if (!info || !book || info.closed) {
      return { info, market: null, book, feeCategory: null, category: null };
    }
    const feeCategory = this.deps.fees.feeCategoryFor(info.labels);
    const category = mandateCategory(info.labels, this.deps.riskEngine.getConfig().mandate);
    const quality = await this.deps.quality.get(info.marketId);
    const market: MarketSnapshot = {
      tokenId,
      category,
      endDate: info.endDate,
      ambiguityScore: quality.ambiguityScore,
      rulesChangedAt: quality.rulesChangedAt,
      liquidityUsd: info.volume24hrUsd,
      ...bookTop(book),
      takerFeeRate: this.deps.fees.getRates(feeCategory).takerRate,
    };
    return { info, market, book, feeCategory, category };
  }

  private isMarketable(order: { side: OrderSide; price: number; orderType: string }, market: MarketSnapshot | null): boolean {
    if (order.orderType === 'market') return true;
    if (!market) return false;
    return order.side === 'buy'
      ? market.bestAsk !== null && order.price >= market.bestAsk
      : market.bestBid !== null && order.price <= market.bestBid;
  }

  /** Marketable (fill-or-kill) Polymarket order; backs ctx.buy / ctx.sell. */
  async placeMarketable(input: MarketableOrderInput): Promise<OrderResult> {
    if (typeof input.tokenId !== 'string' || !input.tokenId) return invalid('tokenId required');
    if (input.side !== 'buy' && input.side !== 'sell') return invalid('side must be buy or sell');
    if (!finite(input.amount) || input.amount <= 0) return invalid('amount must be a positive number');
    for (const k of ['maxPrice', 'minPrice', 'maxSlippage'] as const) {
      const v = input[k];
      if (v !== undefined && v !== null && (!finite(v) || v < 0)) return invalid(`${k} must be a number >= 0`);
    }
    const unavailable = this.polymarketUnavailable();
    if (unavailable) return invalid(unavailable);

    await this.syncOpenOrders();
    const ctx = await this.polymarketContext(input.tokenId);
    const top = ctx.market;
    const slip = input.maxSlippage ?? 0;
    const tick = tickOf(ctx.book);

    // Worst acceptable price: explicit limit, else best price ± tolerance; always on the tick grid
    // so the exchange client cannot round it past the price the risk engine checked.
    let price: number;
    if (input.side === 'buy') {
      const best = top?.bestAsk ?? null;
      const raw = input.maxPrice ?? (best !== null ? Math.min(best + slip, 0.99) : NaN);
      price = toTick(raw, tick, 'down');
      if (input.maxPrice === undefined && best !== null) price = Math.max(price, best);
    } else {
      const best = top?.bestBid ?? null;
      const raw = input.minPrice ?? (best !== null ? Math.max(best - slip, 0.01) : NaN);
      price = toTick(raw, tick, 'up');
      if (input.minPrice === undefined && best !== null) price = Math.min(price, best);
    }
    const size = input.side === 'buy' ? input.amount / price : input.amount;
    const notionalUsd = input.side === 'buy' ? input.amount : input.amount * price;

    return this.submitPolymarket(input, ctx, { orderType: 'market', price, size, notionalUsd, expiresAt: null }, async (row) => {
      if (this.paper) {
        const ps = this.requirePaper();
        const book = ctx.book ?? { bids: [], asks: [] };
        const res =
          input.side === 'buy'
            ? ps.simulateBuy(input.tokenId, input.amount, book, { maxPrice: price })
            : ps.simulateSell(input.tokenId, input.amount, book);
        return this.paperOutcome(res);
      }
      return this.requirePolymarket().postMarketOrder({ tokenId: row.token_id, side: input.side, amount: input.amount, price });
    });
  }

  /** Resting GTD limit order (ctx.polymarket.placeLimit). */
  async placeLimit(input: LimitOrderInput): Promise<OrderResult> {
    if (typeof input.tokenId !== 'string' || !input.tokenId) return invalid('tokenId required');
    if (input.side !== 'buy' && input.side !== 'sell') return invalid('side must be buy or sell');
    if (!finite(input.price) || input.price <= 0 || input.price >= 1) return invalid('price must be between 0 and 1');
    if (!finite(input.size) || input.size <= 0) return invalid('size must be a positive number');
    if (input.ttlMinutes !== undefined && (!finite(input.ttlMinutes) || input.ttlMinutes <= 0)) {
      return invalid('ttlMinutes must be a positive number');
    }
    const unavailable = this.polymarketUnavailable();
    if (unavailable) return invalid(unavailable);

    const maxTtl = this.deps.riskEngine.getConfig().limits.orders.resting_order_ttl_minutes;
    const ttl = Math.min(input.ttlMinutes ?? maxTtl, maxTtl);
    const postOnly = input.postOnly !== false;

    await this.syncOpenOrders();
    const ctx = await this.polymarketContext(input.tokenId);
    if (ctx.book && !onTick(input.price, tickOf(ctx.book))) {
      return invalid(`price ${input.price} is not a multiple of the tick size ${tickOf(ctx.book)}`);
    }
    const marketable = this.isMarketable({ side: input.side, price: input.price, orderType: 'limit' }, ctx.market);

    if (this.paper && !marketable && ctx.market) {
      return invalid('paper mode: resting orders not simulated yet');
    }

    const expiresAtMs = this.now() + ttl * MS_PER_MINUTE;
    const preCheck =
      postOnly && marketable
        ? preDecision(
            'post_only',
            `Post-only ${input.side} at ${input.price} would cross the book (best ${input.side === 'buy' ? 'ask' : 'bid'} ${
              input.side === 'buy' ? ctx.market?.bestAsk : ctx.market?.bestBid
            })`,
            this.now()
          )
        : null;

    return this.submitPolymarket(
      input,
      ctx,
      {
        orderType: 'limit',
        price: input.price,
        size: input.size,
        notionalUsd: input.price * input.size,
        expiresAt: new Date(expiresAtMs).toISOString(),
        preCheck,
      },
      async (row) => {
        if (this.paper) {
          // Marketable paper limit order: fills in full at the limit price
          const ps = this.requirePaper();
          const level = [{ price: String(input.price), size: String(input.size) }];
          const res =
            input.side === 'buy'
              ? ps.simulateBuy(input.tokenId, input.price * input.size, { bids: [], asks: level })
              : ps.simulateSell(input.tokenId, input.size, { bids: level, asks: [] });
          return this.paperOutcome(res);
        }
        return this.requirePolymarket().postLimitOrder({
          tokenId: row.token_id,
          side: input.side,
          price: input.price,
          size: input.size,
          expiresAtMs,
        });
      }
    );
  }

  private paperOutcome(res: TradeResult): PostOrderOutcome {
    if (!res.success) return { kind: 'rejected', error: res.error || 'paper fill failed' };
    return {
      kind: 'accepted',
      exchangeOrderId: null,
      status: 'matched',
      filledSize: res.tokenAmount,
      filledNotional: res.executedAmount,
    };
  }

  private requirePaper(): PaperTradingState {
    if (!this.bot.paperState) throw new Error('Paper trading state missing for paper bot');
    return this.bot.paperState;
  }

  private requirePolymarket(): PolymarketAdapter {
    if (!this.bot.polymarket) throw new Error('Polymarket client not available');
    return this.bot.polymarket;
  }

  /**
   * Shared Polymarket path: forecast lookup → risk check (locked) → persist → execute → record.
   */
  private async submitPolymarket(
    input: OrderIntentOpts & { tokenId: string; side: OrderSide },
    ctx: PolymarketContext,
    shape: {
      orderType: 'limit' | 'market';
      price: number;
      size: number;
      notionalUsd: number;
      expiresAt: string | null;
      preCheck?: RiskDecision | null;
    },
    execute: (row: OrderRow) => Promise<PostOrderOutcome>
  ): Promise<OrderResult> {
    const forecast = input.forecastId ? await this.lookupForecast(input.forecastId, input.tokenId) : null;
    const order: OrderRequest = {
      botId: this.bot.botId,
      exchange: 'polymarket',
      marketId: ctx.info?.marketId ?? 'unknown',
      tokenId: input.tokenId,
      side: input.side,
      orderType: shape.orderType,
      price: shape.price,
      size: shape.size,
      notionalUsd: shape.notionalUsd,
      riskExit: input.side === 'sell' && input.riskExit === true,
      forecast,
      market: ctx.market,
    };

    let preCheck = shape.preCheck ?? null;
    if (!preCheck && input.forecastId && !forecast) {
      preCheck = preDecision('forecast_unavailable', `Forecast ${input.forecastId} not found for token ${input.tokenId}`, this.now());
    }
    if (!preCheck && !ctx.market) {
      const why = !ctx.info ? 'market metadata unavailable' : ctx.info.closed ? 'market closed' : 'order book unavailable';
      preCheck = preDecision('market_data_unavailable', `Cannot check order: ${why}`, this.now());
    }

    const rates = this.deps.fees.getRates(ctx.feeCategory);
    const feeRate = this.isMarketable(order, ctx.market) ? rates.takerRate : rates.makerRate;

    const row = await this.checkAndPersist(order, preCheck, shape.expiresAt, input);
    if (row.status === 'rejected_risk') {
      const decision = JSON.parse(row.risk_decision || '{}') as RiskDecision;
      return resultFromRow(row, { ok: false, failedCheck: decision.failedCheck, error: `Risk check failed: ${decision.reason ?? 'rejected'}` });
    }

    let outcome: PostOrderOutcome;
    try {
      outcome = await execute(row);
    } catch (err) {
      outcome = { kind: 'unknown', error: err instanceof Error ? err.message : String(err) };
    }
    const updated = this.applyOutcome(row, outcome, feeRate, ctx);
    if (this.paper && ctx.info && updated.filled_size > 0) {
      this.bot.paperState?.updatePositionMeta(input.tokenId, ctx.info.question, ctx.info.outcome);
    }
    return resultFromRow(updated, outcome.kind === 'accepted' ? {} : { ok: false, error: outcome.error });
  }

  private async lookupForecast(forecastId: string, tokenId: string): Promise<ForecastEdgeInfo | null> {
    try {
      return await (this.deps.forecasts ?? NoForecastSource).get(forecastId, tokenId);
    } catch {
      return null;
    }
  }

  /** Under the placement lock: snapshot, check, and insert the order row. */
  private checkAndPersist(
    order: OrderRequest,
    preCheck: RiskDecision | null,
    expiresAt: string | null,
    intent: OrderIntentOpts
  ): Promise<OrderRow> {
    return withPlacementLock(async () => {
      let decision = preCheck;
      if (!decision) {
        try {
          decision = this.deps.riskEngine.check(order, await this.deps.provider.getSnapshot(order));
        } catch (err) {
          decision = preDecision('state_invalid', `Risk state unavailable: ${err instanceof Error ? err.message : String(err)}`, this.now());
        }
      }
      const row = this.deps.orderRepo.create({
        id: generateId(),
        botId: order.botId,
        exchange: order.exchange,
        marketId: order.marketId,
        tokenId: order.tokenId,
        side: order.side,
        orderType: order.orderType,
        price: dbNum(order.price),
        size: dbNum(order.size),
        notionalUsd: dbNum(order.notionalUsd),
        status: decision.allowed ? 'submitted' : 'rejected_risk',
        expiresAt,
        riskDecision: decision,
        reason: typeof intent.reason === 'string' ? intent.reason.slice(0, 500) : null,
        forecastId: intent.forecastId ?? null,
        simulated: this.paper,
      });
      if (!decision.allowed) {
        logger.warning(
          `[OrderService] ${this.bot.botName}: ${order.side} ${order.tokenId} rejected (${decision.failedCheck}): ${decision.reason}`
        );
      }
      return row;
    });
  }

  /**
   * Update the order row from the exchange outcome and record any fill, atomically.
   * `feeRate`: taker rate if the order crossed the book at check time, else maker rate.
   */
  private applyOutcome(row: OrderRow, outcome: PostOrderOutcome, feeRate: number, ctx: PolymarketContext): OrderRow {
    const side = row.side as OrderSide;

    if (outcome.kind === 'rejected') {
      logger.warning(`[OrderService] ${this.bot.botName}: order ${row.id} failed: ${outcome.error}`);
      return this.deps.orderRepo.update(row.id, { status: 'failed' }) ?? row;
    }
    if (outcome.kind === 'unknown') {
      // May be live on the exchange: keep counting it as open until reconciled (chunk 2b)
      logger.error(`[OrderService] ${this.bot.botName}: order ${row.id} outcome unknown, left as submitted: ${outcome.error}`);
      return this.deps.orderRepo.findById(row.id) ?? row;
    }

    let fill: Fill | null = null;
    let status: OrderStatus;
    const matched = outcome.status.toLowerCase() === 'matched';
    if (row.order_type === 'market') {
      if (matched) {
        // Fill-or-kill matched ⇒ the whole order filled at `price` or better
        const size = outcome.filledSize ?? row.size;
        const notional = outcome.filledNotional ?? (side === 'buy' ? row.notional_usd : row.size * row.price);
        fill = { size, notional };
        status = 'filled';
      } else {
        status = 'submitted'; // delayed / unknown: wait for sync
      }
    } else {
      const filled = matched ? (outcome.filledSize ?? row.size) : (outcome.filledSize ?? 0);
      if (filled > QTY_EPS) {
        fill = { size: filled, notional: outcome.filledNotional ?? filled * row.price };
      }
      status =
        filled >= row.size - QTY_EPS ? 'filled' : filled > QTY_EPS ? 'partially_filled' : outcome.status.toLowerCase() === 'live' ? 'open' : 'submitted';
    }

    // Expected fee on what filled; an unfilled marketable order records the fee on its full notional
    const fee = feeRate * (fill ? fill.notional : row.notional_usd);
    const tx = this.deps.db.transaction(() => {
      const updated = this.deps.orderRepo.update(row.id, {
        status,
        exchangeOrderId: outcome.exchangeOrderId,
        filledSize: fill?.size ?? 0,
        avgFillPrice: fill && fill.size > 0 ? fill.notional / fill.size : null,
        feeUsd: fee,
      });
      if (fill) this.recordFill(row, fill, fee, ctx.info, ctx.category);
      return updated;
    });
    return tx() ?? row;
  }

  private recordFill(row: OrderRow, fill: Fill, feeUsd: number, info: MarketInfo | null, category: string | null): void {
    this.deps.tradeRepo.create({
      botId: this.bot.botId,
      botName: this.bot.botName,
      scriptName: this.bot.scriptName,
      exchange: row.exchange as Exchange,
      side: row.side === 'buy' ? 'BUY' : 'SELL',
      symbol: row.token_id,
      conditionId: row.exchange === 'polymarket' ? row.market_id : undefined,
      market: info?.question || undefined,
      outcome: info?.outcome || undefined,
      price: fill.size > 0 ? fill.notional / fill.size : row.price,
      quantity: fill.size,
      quoteAmount: fill.notional,
      simulated: this.paper ? 1 : 0,
      orderId: row.id,
      feeUsd,
      category,
    });
  }

  // ── Binance ─────────────────────────────────────────────────────────

  /** Binance market order (ctx.binance.buy / sell). */
  async placeBinance(input: BinanceOrderInput): Promise<OrderResult> {
    if (typeof input.symbol !== 'string' || !input.symbol) return invalid('symbol required');
    if (input.side !== 'buy' && input.side !== 'sell') return invalid('side must be buy or sell');
    if (!finite(input.amount) || input.amount <= 0) return invalid('amount must be a positive number');
    const symbol = input.symbol.toUpperCase();

    let book: BinanceOrderBook | null = null;
    try {
      book = await this.deps.getBinanceBook(symbol);
    } catch {
      book = null;
    }
    const best = (levels: BinanceOrderBook['asks'] | undefined, pick: 'max' | 'min'): number => {
      const prices = (levels ?? []).map((l) => parseFloat(l.price)).filter((p) => Number.isFinite(p) && p > 0);
      if (prices.length === 0) return NaN;
      return pick === 'max' ? Math.max(...prices) : Math.min(...prices);
    };
    const price = input.side === 'buy' ? best(book?.asks, 'min') : best(book?.bids, 'max');
    const size = input.side === 'buy' ? input.amount / price : input.amount;
    const notionalUsd = input.side === 'buy' ? input.amount : input.amount * price;

    const order: OrderRequest = {
      botId: this.bot.botId,
      exchange: 'binance',
      marketId: symbol,
      tokenId: symbol,
      side: input.side,
      orderType: 'market',
      price,
      size,
      notionalUsd,
      riskExit: input.side === 'sell' && input.riskExit === true,
      forecast: null,
      market: null,
    };

    let preCheck: RiskDecision | null = null;
    if (!BINANCE_USD_QUOTES.some((q) => symbol.endsWith(q) && symbol.length > q.length)) {
      preCheck = preDecision('unsupported_symbol', `${symbol} is not quoted in ${BINANCE_USD_QUOTES.join('/')}: no USD notional`, this.now());
    } else if (!finite(price)) {
      preCheck = preDecision('market_data_unavailable', `No ${input.side === 'buy' ? 'ask' : 'bid'} in ${symbol} order book`, this.now());
    }

    await this.syncOpenOrders();
    const row = await this.checkAndPersist(order, preCheck, null, input);
    if (row.status === 'rejected_risk') {
      const decision = JSON.parse(row.risk_decision || '{}') as RiskDecision;
      return resultFromRow(row, { ok: false, failedCheck: decision.failedCheck, error: `Risk check failed: ${decision.reason ?? 'rejected'}` });
    }

    let res: BinanceTradeResult;
    try {
      if (this.paper) {
        const ps = this.requirePaper();
        res =
          input.side === 'buy'
            ? ps.simulateBinanceBuy(symbol, input.amount, book ?? { bids: [], asks: [] })
            : ps.simulateBinanceSell(symbol, input.amount, book ?? { bids: [], asks: [] });
      } else {
        if (!this.bot.binance) throw new Error('Binance API credentials not configured. Set them in Settings.');
        res =
          input.side === 'buy'
            ? await this.bot.binance.marketBuy(symbol, input.amount, row.id)
            : await this.bot.binance.marketSell(symbol, input.amount, row.id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Thrown before any request (e.g. no credentials) ⇒ nothing was sent
      const failed = this.deps.orderRepo.update(row.id, { status: 'failed' }) ?? row;
      return resultFromRow(failed, { error: msg });
    }

    let outcome: PostOrderOutcome;
    if (res.success) {
      outcome = {
        kind: 'accepted',
        exchangeOrderId: res.orderId !== undefined ? String(res.orderId) : null,
        status: 'matched',
        filledSize: res.executedQty,
        filledNotional: res.cummulativeQuoteQty,
      };
    } else {
      outcome = { kind: res.outcomeUnknown ? 'unknown' : 'rejected', error: res.error || 'Binance order failed' };
    }
    if (outcome.kind === 'accepted' && !(res.executedQty > QTY_EPS)) {
      const r = this.deps.orderRepo.update(row.id, { status: 'cancelled', exchangeOrderId: outcome.exchangeOrderId }) ?? row;
      return resultFromRow(r, { ok: false, error: 'Order did not fill' });
    }
    // Binance fees are charged in the traded asset/BNB; not modelled here (fee_usd = 0)
    const updated = this.applyOutcome(row, outcome, 0, { info: null, market: null, book: null, feeCategory: null, category: null });
    return resultFromRow(updated, outcome.kind === 'accepted' ? {} : { ok: false, error: outcome.error });
  }

  // ── Open orders, cancel, budget, fees ───────────────────────────────

  /**
   * Refresh this bot's live resting orders from the exchange (fills, cancels, expiry).
   * Best effort: errors leave rows unchanged (they keep counting as open — fail closed).
   * TODO(chunk 2b): the reconciler takes this over for all bots.
   */
  async syncOpenOrders(): Promise<void> {
    if (this.paper || !this.bot.polymarket) return;
    const open = this.deps.orderRepo
      .findOpen(this.bot.botId, false)
      .filter((o) => o.exchange === 'polymarket' && o.exchange_order_id);
    for (const row of open) {
      try {
        const ex = await this.bot.polymarket.getOrder(row.exchange_order_id!);
        if (ex) this.applyExchangeState(row, ex);
      } catch (err) {
        logger.warning(`[OrderService] sync of order ${row.id} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private applyExchangeState(row: OrderRow, ex: { status: string; sizeMatched: number; originalSize: number; price: number }): void {
    const matched = Math.min(ex.sizeMatched, row.size);
    const delta = matched - row.filled_size;
    const s = ex.status.toLowerCase();
    let status: OrderStatus;
    if (matched >= row.size - QTY_EPS || s === 'matched') status = 'filled';
    else if (s === 'live') status = matched > QTY_EPS ? 'partially_filled' : 'open';
    else if (s.startsWith('cancel')) {
      const expired = row.expires_at !== null && Date.parse(row.expires_at) <= this.now();
      status = expired ? 'expired' : 'cancelled';
    } else return; // unknown status: leave as is

    if (status === row.status && delta <= QTY_EPS) return;
    this.deps.db.transaction(() => {
      if (delta > QTY_EPS) {
        // Resting fills happen at the order's price
        const prevNotional = row.filled_size * (row.avg_fill_price ?? row.price);
        const addNotional = delta * row.price;
        this.recordFill(row, { size: delta, notional: addNotional }, 0, null, null);
        this.deps.orderRepo.update(row.id, {
          filledSize: matched,
          avgFillPrice: (prevNotional + addNotional) / matched,
        });
      }
      this.deps.orderRepo.update(row.id, { status });
    })();
  }

  private ownOpenOrder(orderId: string): OrderRow {
    const row = typeof orderId === 'string' ? this.deps.orderRepo.findById(orderId) : undefined;
    // Same message whether it does not exist or belongs to another bot
    if (!row || row.bot_id !== this.bot.botId || row.simulated !== (this.paper ? 1 : 0)) {
      throw new Error(`Order not found: ${orderId}`);
    }
    if (!['submitted', 'open', 'partially_filled'].includes(row.status)) {
      throw new Error(`Order ${orderId} is not open (status ${row.status})`);
    }
    return row;
  }

  /** Cancel one of this bot's orders. Throws if not found, not this bot's, or not cancellable. */
  async cancel(orderId: string): Promise<void> {
    const row = this.ownOpenOrder(orderId);
    if (this.paper) {
      this.deps.orderRepo.update(row.id, { status: 'cancelled' });
      return;
    }
    if (row.exchange !== 'polymarket' || !row.exchange_order_id) {
      throw new Error(`Order ${orderId} has no exchange order id (outcome unknown); it cannot be cancelled from here`);
    }
    await this.cancelRows([row]);
    const after = this.deps.orderRepo.findById(row.id);
    if (after && ['submitted', 'open', 'partially_filled'].includes(after.status)) {
      throw new Error(`Exchange did not confirm cancellation of order ${orderId}`);
    }
  }

  /** Cancel all of this bot's open orders (never other bots'). */
  async cancelAll(): Promise<{ cancelled: number; failed: number }> {
    const open = this.deps.orderRepo.findOpen(this.bot.botId, this.paper);
    if (this.paper) {
      for (const row of open) this.deps.orderRepo.update(row.id, { status: 'cancelled' });
      return { cancelled: open.length, failed: 0 };
    }
    const cancellable = open.filter((o) => o.exchange === 'polymarket' && o.exchange_order_id);
    const cancelled = await this.cancelRows(cancellable);
    return { cancelled, failed: open.length - cancelled };
  }

  private async cancelRows(rows: OrderRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const adapter = this.requirePolymarket();
    const confirmed = new Set(await adapter.cancelOrders(rows.map((r) => r.exchange_order_id!)));
    let n = 0;
    for (const row of rows) {
      // Pick up any fills that happened before the cancel
      try {
        const ex = await adapter.getOrder(row.exchange_order_id!);
        if (ex) this.applyExchangeState(row, ex);
      } catch {
        /* keep going */
      }
      const current = this.deps.orderRepo.findById(row.id);
      if (confirmed.has(row.exchange_order_id!) && current && ['submitted', 'open', 'partially_filled'].includes(current.status)) {
        this.deps.orderRepo.update(row.id, { status: 'cancelled' });
      }
      const final = this.deps.orderRepo.findById(row.id);
      if (final && !['submitted', 'open', 'partially_filled'].includes(final.status)) n++;
    }
    return n;
  }

  /** This bot's open orders (after a sync with the exchange). */
  async getOpenOrders(): Promise<OpenOrderInfo[]> {
    await this.syncOpenOrders();
    return this.deps.orderRepo.findOpen(this.bot.botId, this.paper).map((o) => ({
      orderId: o.id,
      exchange: o.exchange as Exchange,
      marketId: o.market_id,
      tokenId: o.token_id,
      side: o.side as OrderSide,
      orderType: o.order_type as 'limit' | 'market',
      price: o.price,
      size: o.size,
      filledSize: o.filled_size,
      status: o.status,
      expiresAt: o.expires_at,
      createdAt: o.created_at,
    }));
  }

  /** Taker/maker fee rates for a token (unknown market ⇒ highest taker rate). */
  async getFee(tokenId: string): Promise<{ takerRate: number; makerRate: number }> {
    const info = typeof tokenId === 'string' && tokenId ? await this.deps.marketData.getMarketInfo(tokenId) : null;
    return this.deps.fees.getRates(info ? this.deps.fees.feeCategoryFor(info.labels) : null);
  }

  /** ctx.risk.getBudget(): what this bot can still add before limits bite. */
  async getBudget(): Promise<RiskBudget> {
    const { provider, riskEngine } = this.deps;
    const bot = provider.getBotInfo(this.bot.botId);
    const global = provider.isGloballyHalted();
    if (!bot) return { remainingAllocation: 0, remainingMarket: {}, halted: true };

    const exposure = provider.computeExposure(this.bot.botId);
    const limits = riskEngine.getConfig().limits;
    const liveStage = bot.stage === 'probation' || bot.stage === 'full';
    const allocation = liveStage ? riskEngine.effectiveAllocation(bot, 'polymarket') : 0;
    const cash = await provider.getCash('polymarket');
    const equity = cash + exposure.positions.reduce((sum, p) => sum + p.cost_basis, 0);
    // Unknown equity ⇒ no room (the engine would reject buys as state_invalid)
    const totalRoom = Number.isFinite(equity) ? riskEngine.totalExposureLimit(equity) - exposure.totalUsd : 0;
    const remainingAllocation = Math.max(0, Math.min(allocation - exposure.botUsd.polymarket, totalRoom));

    const markets = new Set<string>(bot.marketIds ?? []);
    if (bot.marketIds === null) {
      for (const p of exposure.positions) if (p.bot_id === this.bot.botId && p.condition_id) markets.add(p.condition_id);
      for (const o of exposure.openBuys) if (o.bot_id === this.bot.botId && o.exchange === 'polymarket') markets.add(o.market_id);
    }
    const remainingMarket: Record<string, number> = {};
    for (const m of markets) {
      remainingMarket[m] = Math.max(0, Math.min(limits.per_market.max_exposure_usd - (exposure.marketUsd.get(m) ?? 0), remainingAllocation));
    }
    return { remainingAllocation, remainingMarket, halted: global.halted || bot.halted };
  }
}
