/**
 * BotContext SDK Type Definitions
 *
 * This is the public API surface available to user scripts running in worker threads.
 * Scripts receive a BotContext object with trading, data, scheduling, and storage capabilities.
 * Private keys and CLOB clients remain in the main process -- workers communicate via RPC.
 */

// ============================================================================
// Core BotContext Interface
// ============================================================================

export interface BotContext {
  /**
   * User-defined config values (from UI form, driven by script's configSchema). Typed `any` per key: the
   * values are whatever the bot's JSON config holds, so check / convert them (`Number(ctx.config.x)`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly config: Readonly<Record<string, any>>;

  /** Bot metadata */
  readonly botId: string;
  readonly botName: string;

  /** Current timestamp (ms). Use instead of Date.now() for backtest compatibility. */
  readonly now: number;

  // === Trading ===
  buy(tokenId: string, amountUsd: number, opts?: OrderOpts): Promise<TradeResult>;
  sell(tokenId: string, amountTokens: number, opts?: OrderOpts): Promise<TradeResult>;
  getOrderBook(tokenId: string): Promise<OrderBook>;
  getPositions(): Promise<Position[]>;
  getBalance(): Promise<number>;

  // === Market Data ===
  getMarkets(query?: MarketQuery): Promise<Market[]>;
  getMarketPrice(tokenId: string): Promise<MarketPrice>;
  getEvent(eventSlug: string): Promise<PolymarketEvent>;

  // === HTTP (proxied to the main process; allowlisted hosts, https, GET/POST, 10 s, 2 MB) ===
  fetch(url: string, init?: ScriptFetchInit): Promise<ScriptResponse>;

  // === Scheduling (tracked for cleanup on stop) ===
  setInterval(fn: () => void | Promise<void>, ms: number): string;
  setTimeout(fn: () => void | Promise<void>, ms: number): string;
  clearInterval(handle: string): void;
  clearTimeout(handle: string): void;

  // === Logging (forwarded to main process) ===
  log: BotLogger;

  // === Events (forwarded to main process) ===
  emit(type: string, data?: Record<string, unknown>): void;

  // === Per-bot key-value storage (persisted to SQLite) ===
  storage: BotStorage;

  // === Wallet info (read-only, no private key exposed) ===
  readonly wallet: WalletInfo;

  // === Binance spot trading ===
  binance: BinanceContext;

  // === Kelly Criterion position sizing ===
  kelly: KellyContext;

  // === Polymarket orders v2 (spec §5.2): limit orders, cancels, fees ===
  polymarket: PolymarketContext;

  // === Risk budget (read-only) ===
  risk: RiskContext;

  // === Forecast ledger (read-only, spec §5.2) ===
  ledger: LedgerContext;
}

/** ctx.fetch options (spec §5.1): GET or POST, string body, plain header object. */
export interface ScriptFetchInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

/** Minimal Response-like object returned by ctx.fetch. */
export interface ScriptResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

// ============================================================================
// Trading Types
// ============================================================================

export interface OrderOpts {
  /** Buy: highest price willing to pay. If not set, best ask (+ maxSlippage). */
  maxPrice?: number;
  /** Sell: lowest price willing to accept. If not set, best bid (− maxSlippage). */
  minPrice?: number;
  /** Tolerance from the best price when maxPrice/minPrice is not set (e.g. 0.02 = 2 cents) */
  maxSlippage?: number;
  /** @deprecated Ignored: orders are a single fill-or-kill attempt */
  retries?: number;
  /** Free text stored with the order (e.g. why the bot traded) */
  reason?: string;
  /** Ledger forecast this order trades on */
  forecastId?: string;
  /** Sell is a risk exit (exempt from hold time and rate limits) */
  riskExit?: boolean;
}

export interface TradeResult {
  success: boolean;
  /** Total USD executed */
  executedAmount: number;
  /** Average execution price */
  price: number;
  /** Tokens received (for buy) or sold (for sell) */
  tokenAmount: number;
  /** Error message if failed */
  error?: string;
  /** Sizing reasoning (for copy strategies) */
  reasoning?: string;
  /** orders.id of the attempt (null if the input was invalid) */
  orderId?: string | null;
  /** Order status, e.g. 'filled', 'rejected_risk', 'failed' */
  status?: string;
  /** Risk check that rejected the order */
  failedCheck?: string;
}

// ============================================================================
// Orders v2 (spec §5.2)
// ============================================================================

export interface LimitOrderOpts {
  /** Reject instead of crossing the book (default true). Checked against the book before posting. */
  postOnly?: boolean;
  /** Minutes until the order expires (GTD), at least 3 (Polymarket minimum). Capped at limits.orders.resting_order_ttl_minutes. */
  ttlMinutes?: number;
  reason?: string;
  forecastId?: string;
  riskExit?: boolean;
}

/** Result of placing an order. Rejections are returned (ok: false), not thrown. */
export interface OrderResult {
  ok: boolean;
  orderId: string | null;
  /** 'submitted' | 'open' | 'partially_filled' | 'filled' | 'rejected_risk' | 'failed' | 'cancelled' | 'invalid' ... */
  status: string;
  filledSize: number;
  avgFillPrice: number | null;
  filledNotionalUsd: number;
  feeUsd: number;
  expiresAt: string | null;
  failedCheck?: string;
  error?: string;
}

export interface OpenOrder {
  orderId: string;
  exchange: 'polymarket' | 'binance';
  marketId: string;
  tokenId: string;
  side: 'buy' | 'sell';
  orderType: 'limit' | 'market';
  price: number;
  size: number;
  filledSize: number;
  status: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface FeeRates {
  /** Polymarket fee rate for takers. Taker fee (USDC, on top) = shares × takerRate × p × (1 − p) when formula is 'price' */
  takerRate: number;
  /** 0 on Polymarket (makers never pay) unless a market's schedule says otherwise */
  makerRate: number;
  /** 'price': fee per share = rate × p × (1 − p); 'notional': rate × p (conservative, unusual fee schedules) */
  formula: 'price' | 'notional';
  /** 'market': the market's own fee schedule; 'category': fee table by category; 'unknown': highest table rate */
  source: 'market' | 'category' | 'unknown';
  /** Polymarket feeType when known, e.g. 'zero_fees' */
  feeType?: string | null;
}

export interface PolymarketContext {
  placeLimit(tokenId: string, side: 'buy' | 'sell', price: number, size: number, opts?: LimitOrderOpts): Promise<OrderResult>;
  /** Cancel one of this bot's orders; throws if not found or not cancellable */
  cancel(orderId: string): Promise<void>;
  /**
   * Cancel all of this bot's open orders. Throws if the exchange did not confirm some cancels.
   * Orders whose placement outcome is unknown cannot be cancelled; they are counted in
   * `unknownOutcome` and expire on their own.
   */
  cancelAll(): Promise<{ cancelled: number; failed: number; unknownOutcome: number }>;
  /** This bot's open orders */
  getOpenOrders(): Promise<OpenOrder[]>;
  getFee(tokenId: string): Promise<FeeRates>;
}

export interface RiskBudget {
  remainingAllocation: number;
  remainingMarket: Record<string, number>;
  halted: boolean;
}

export interface RiskContext {
  getBudget(): Promise<RiskBudget>;
}

/** A ledger forecast (probability of `tokenId` resolving YES), read-only for bots. */
export interface BotForecast {
  id: string;
  /** Condition id */
  marketId: string;
  tokenId: string;
  eventId: string;
  category: string;
  probability: number;
  /** Mid captured by the server when the forecast was written */
  marketPriceAtForecast: number;
  bestBid: number | null;
  bestAsk: number | null;
  /** 0-3, after the server raise */
  ambiguityScore: number;
  /** Tradeable now: active, its (category, horizon) bucket is trading and the category is allowed */
  tradeable: boolean;
  /** The bucket was trading when the forecast was written */
  tradeableAtForecast: boolean;
  /** Current rights state of the forecast's (category, horizon) bucket; null if unknown */
  bucketState: string | null;
  horizonBucket: 'short' | 'medium' | 'long';
  daysToResolutionAtForecast: number;
  status: string;
  rationale: string;
  sources: string[];
  createdAt: string;
}

export interface LedgerContext {
  /** Active forecasts, optionally one category / tradeable only */
  getActiveForecasts(filter?: { category?: string; tradeableOnly?: boolean }): Promise<BotForecast[]>;
  /** The active forecast on a token, or null */
  getForecast(tokenId: string): Promise<BotForecast | null>;
}

export interface OrderBook {
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
}

export interface OrderBookEntry {
  price: string;
  size: string;
}

export interface Position {
  /** Token ID (asset) */
  tokenId: string;
  /** Market slug or title */
  market?: string;
  /** Condition ID */
  conditionId?: string;
  /** Outcome label (e.g., "Yes", "No") */
  outcome?: string;
  /** Number of tokens held */
  size: number;
  /** Current value in USD */
  currentValue: number;
  /** Average purchase price */
  avgPrice: number;
}

// ============================================================================
// Market Data Types
// ============================================================================

export interface MarketQuery {
  /** Search term for market title */
  search?: string;
  /** Filter by tag/category */
  tag?: string;
  /** Only active markets */
  active?: boolean;
  /** Only closed markets */
  closed?: boolean;
  /** Max results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

export interface Market {
  conditionId: string;
  questionId: string;
  slug: string;
  title: string;
  description: string;
  outcomes: string[];
  outcomePrices: string[];
  tokens: MarketToken[];
  active: boolean;
  closed: boolean;
  volume: string;
  liquidity: string;
  endDate?: string;
  createdAt: string;
}

export interface MarketToken {
  tokenId: string;
  outcome: string;
  price: number;
  winner?: boolean;
}

export interface MarketPrice {
  bid: number;
  ask: number;
  mid: number;
  spread: number;
}

export interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  markets: Market[];
  startDate?: string;
  endDate?: string;
  createdAt: string;
}

// ============================================================================
// Logging
// ============================================================================

export interface BotLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

// ============================================================================
// Storage
// ============================================================================

export interface BotStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

// ============================================================================
// Binance Types
// ============================================================================

export interface BinanceTradeResult {
  success: boolean;
  orderId?: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  executedQty: number;
  cummulativeQuoteQty: number;
  avgPrice: number;
  error?: string;
  /** BotLab orders.id (sent to Binance as the client order id) */
  clientOrderId?: string | null;
  status?: string;
  /** Risk check that rejected the order */
  failedCheck?: string;
}

export interface BinanceOrderBook {
  bids: Array<{ price: string; quantity: string }>;
  asks: Array<{ price: string; quantity: string }>;
}

export interface BinancePosition {
  asset: string;
  free: number;
  locked: number;
  total: number;
  estimatedValueUsdt?: number;
}

export interface BinancePrice {
  symbol: string;
  price: number;
}

/**
 * Binance trading context available to scripts via ctx.binance.*
 */
export interface BinanceContext {
  buy(symbol: string, quoteAmountUsdt: number): Promise<BinanceTradeResult>;
  sell(symbol: string, quantity: number): Promise<BinanceTradeResult>;
  getBalance(asset?: string): Promise<number>;
  getOrderBook(symbol: string, limit?: number): Promise<BinanceOrderBook>;
  getPrice(symbol: string): Promise<BinancePrice>;
  getPositions(): Promise<BinancePosition[]>;
}

// ============================================================================
// Kelly Criterion Types
// ============================================================================

export interface KellyConfig {
  /** Fraction of Kelly to use (0.25 = quarter Kelly) */
  kellyFraction: number;
  /** Minimum edge required (e.g., 0.03 = 3%) */
  minEdge: number;
  /** Maximum position as fraction of bankroll (e.g., 0.05 = 5%) */
  maxPositionFraction: number;
  /** Minimum sample size to trust win rate */
  minSampleSize: number;
  /** Confidence decay rate for small samples */
  confidenceDecayRate: number;
}

export interface KellyResult {
  /** Should we take this position? */
  shouldTrade: boolean;
  /** Recommended position size (fraction of bankroll) */
  positionFraction: number;
  /** Actual dollar amount to trade */
  tradeAmount: number;
  /** Calculated edge */
  edge: number;
  /** Raw Kelly fraction (before adjustments) */
  rawKelly: number;
  /** Confidence score (0-1) based on sample size */
  confidence: number;
  /** Reason for decision */
  reason: string;
}

/**
 * Kelly Criterion calculator available to scripts via ctx.kelly.
 * Pure math — runs locally in the worker, no RPC needed.
 */
export interface KellyContext {
  /**
   * Calculate Kelly-optimal position size.
   * @param winRate     - Historical win rate (0-1)
   * @param sampleSize  - Number of resolved trades
   * @param marketPrice - Current market price (0-1 for prediction markets)
   * @param bankroll    - Available capital
   * @param config      - Optional Kelly parameters (defaults to quarter Kelly)
   */
  calculate(
    winRate: number,
    sampleSize: number,
    marketPrice: number,
    bankroll: number,
    config?: KellyConfig,
  ): KellyResult;

  /** Default config (quarter Kelly, 3% min edge, 5% max position) */
  DEFAULT_CONFIG: KellyConfig;
}

// ============================================================================
// Wallet Info (read-only)
// ============================================================================

export interface WalletInfo {
  address: string;
  proxyAddress?: string;
}

// ============================================================================
// Script Metadata & Exports
// ============================================================================

/**
 * The meta object exported by user scripts.
 * Contains script metadata and a JSON Schema config definition.
 */
export interface ScriptMeta {
  name: string;
  description?: string;
  version?: string;
  author?: string;
  configSchema?: Record<string, unknown>;
}

/**
 * A compiled user script module.
 * Scripts export these functions for lifecycle management.
 *
 * Two patterns are supported:
 *   - Simple: export onTick(ctx) — called automatically on a polling interval
 *   - Advanced: export onStart(ctx) — set up your own intervals and logic
 *
 * At least one of onStart or onTick must be defined.
 */
export interface ScriptModule {
  meta?: ScriptMeta;
  onStart?: (ctx: BotContext) => Promise<void> | void;
  onStop?: (ctx: BotContext) => Promise<void> | void;
  onHeartbeat?: (ctx: BotContext) => Record<string, unknown> | Promise<Record<string, unknown>>;
  onTick?: (ctx: BotContext) => Promise<void> | void;
}

// ============================================================================
// RPC Protocol (internal -- between worker and main process)
// ============================================================================

export type RpcMethod =
  | 'polymarket:buy'
  | 'polymarket:sell'
  | 'polymarket:getOrderBook'
  | 'polymarket:getPositions'
  | 'polymarket:getBalance'
  | 'polymarket:getMarkets'
  | 'polymarket:getMarketPrice'
  | 'polymarket:getEvent'
  | 'polymarket:placeLimit'
  | 'polymarket:cancel'
  | 'polymarket:cancelAll'
  | 'polymarket:getOpenOrders'
  | 'polymarket:getFee'
  | 'risk:getBudget'
  | 'ledger:getActiveForecasts'
  | 'ledger:getForecast'
  | 'storage:get'
  | 'storage:set'
  | 'storage:delete'
  | 'log'
  | 'emit'
  | 'recordTrade'
  | 'binance:buy'
  | 'binance:sell'
  | 'binance:getBalance'
  | 'binance:getOrderBook'
  | 'binance:getPrice'
  | 'binance:getPositions'
  | 'fetch';

export interface RpcRequest {
  id: string;
  method: RpcMethod;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[];
}

export interface RpcResponse {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: any;
  error?: string;
}

/** Messages from main process to worker */
export type MainToWorkerMessage =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'heartbeat' }
  /** Liveness check, answered by the bootstrap without running script code */
  | { type: 'ping' }
  | { type: 'rpc-response'; response: RpcResponse };

/** Messages from worker to main process */
export type WorkerToMainMessage =
  | { type: 'started' }
  | { type: 'stopped' }
  | { type: 'error'; error: string }
  | { type: 'heartbeat-result'; metrics: Record<string, unknown> }
  | { type: 'rpc-request'; request: RpcRequest }
  /** onTick began / settled (main-side tick watchdog) */
  | { type: 'tick-start'; id: number }
  | { type: 'tick-end'; id: number }
  | { type: 'pong' };
