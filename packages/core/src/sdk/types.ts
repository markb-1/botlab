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

  // === Push events from the server (spec §5.2): forecast_changed, rules_changed, halt ===
  events: EventsContext;

  // === All bots' positions and risk exits: builtin Position Manager template only (others get an error) ===
  portfolio: PortfolioContext;

  // === Copy-trading leaders and their status: builtin Copy Trading template only (others get an error) ===
  copy: CopyContext;

  /**
   * Ask the server to retire THIS bot (stage `retired`: stopped, never trades again; only a human can un-retire).
   * For per-opportunity bots whose opportunity is over (markets resolved, gap closed for days). The server stops
   * the bot shortly after answering, so return from the current tick afterwards. Positions stay (the Position
   * Manager can still exit them). Audited as the bot.
   */
  requestRetire(reason: string): Promise<{ accepted: boolean }>;
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
  /**
   * Builtin Copy Trading template only (ignored for other bots): the leader trade this order copies, recorded by the
   * server for the per-leader P&L (leader scoring, spec §9.5).
   */
  copy?: CopyOrderTag;
}

/** The leader trade a copy order mirrors (LimitOrderOpts.copy). */
export interface CopyOrderTag {
  /** Leader wallet (0x address) */
  leader: string;
  /** De-duplication key of the leader's trade (transaction hash + log index) */
  key?: string;
  /** Leader's fill price and USD size */
  leaderPrice?: number;
  leaderUsd?: number;
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
  /** Ledger forecast the order was tagged with (null if none) */
  forecastId: string | null;
  /** Another bot placed it on this bot's behalf (the position manager's exits); null = this bot */
  placedBy: string | null;
}

/** An order of this bot, any status (ctx.polymarket.getOrderHistory). */
export interface OrderHistoryEntry {
  orderId: string;
  tokenId: string;
  marketId: string;
  side: 'buy' | 'sell';
  orderType: 'limit' | 'market';
  price: number;
  size: number;
  filledSize: number;
  status: string;
  /** Free text stored with the order; position-manager exits start with "position manager: <trigger>" */
  reason: string | null;
  forecastId: string | null;
  /** Bot that placed it on this bot's behalf (the position manager); null = this bot */
  placedBy: string | null;
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
  /** This bot's open orders (including exits the position manager placed for it, `placedBy` set: it cannot cancel those) */
  getOpenOrders(): Promise<OpenOrder[]>;
  /** This bot's orders of any status from the last `days` (default 7, max 30), newest first, at most 500 */
  getOrderHistory(days?: number): Promise<OrderHistoryEntry[]>;
  getFee(tokenId: string): Promise<FeeRates>;
  /**
   * A market from the server's market cache (refreshed from Gamma when stale), by condition id (0x…) or by one of
   * its token ids; null when unknown. Asked by token, `tokenId` / `outcome` / `complementTokenId` describe that
   * token and the other token of a binary market (e.g. the NO token of a YES token: Polymarket has no shorting,
   * "selling" an outcome you do not hold means buying its complement).
   */
  getMarket(idOrTokenId: string): Promise<MarketDetail | null>;
  /**
   * Condition ids of every market of an event (open or closed), from Gamma, cached; null when unknown. Use it to
   * check that a set of markets is the whole event (e.g. an exhaustive outcome set).
   */
  getEventMarketIds(eventId: string): Promise<string[] | null>;
}

/** A market as the server's market cache knows it (ctx.polymarket.getMarket). */
export interface MarketDetail {
  /** Condition id */
  marketId: string;
  eventId: string;
  question: string;
  category: string;
  /** ISO end date; null if unknown */
  endDate: string | null;
  active: boolean;
  /** Closed for trading (resolved or about to be) */
  closed: boolean;
  negRisk: boolean;
  /** All outcome tokens (a binary market has two: usually Yes / No) */
  tokens: Array<{ tokenId: string; outcome: string }>;
  /** The token asked about (null when asked by condition id) */
  tokenId: string | null;
  outcome: string | null;
  /** The other token of a binary market (null if not asked by token or not binary) */
  complementTokenId: string | null;
  /** Ambiguity 0-3 after the server raise (rules change, dispute); null = not assessed (buys are refused) */
  ambiguityScore: number | null;
  /** Hash of the resolution rules text; changes when the rules change */
  rulesHash: string | null;
  rulesChangedAt: string | null;
  /** A UMA dispute is recorded */
  disputed: boolean;
  umaResolutionStatus: string | null;
  /** This bot may trade the market: it is in the bot's market_ids (or the bot is not market-scoped) */
  inScope: boolean;
  /**
   * Gamma order-book liquidity (USD); informational. NOT what the minimum-liquidity filter uses: see volume24hUsd.
   * null if unknown.
   */
  liquidityUsd: number | null;
  /**
   * Gamma 24h volume (USD): the measure the risk engine and the ledger compare with `min_liquidity_usd`
   * (MandateSummary.minLiquidityUsd). null if unknown (buys are refused then).
   */
  volume24hUsd: number | null;
  /** When the cache row was last refreshed */
  updatedAt: string;
}

/** An open exit flag (agent / human flag_position_exit) on one of THIS bot's positions. */
export interface BotExitFlag {
  id: string;
  tokenId: string;
  marketId: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
}

export interface RiskBudget {
  remainingAllocation: number;
  remainingMarket: Record<string, number>;
  halted: boolean;
  /** limits.yaml per_bot_defaults.max_orders_per_hour (null when unknown, e.g. in a backtest) */
  ordersPerHour: number | null;
  /**
   * Orders this bot may still submit in the rolling hour: the limit minus its own submitted orders of the last hour
   * (risk rejections and Position Manager exits placed for it do not count). null when unknown.
   */
  ordersRemainingThisHour: number | null;
  /**
   * Longest resting-order lifetime the server allows (limits.yaml orders.resting_order_ttl_minutes): a longer
   * `ttlMinutes` is capped to it. null when unknown.
   */
  maxRestingTtlMinutes: number | null;
}

export interface RiskContext {
  getBudget(): Promise<RiskBudget>;
  /** Open exit flags on this bot's positions (same mode); the Position Manager acts on them, a bot may stop buying */
  getExitFlags(): Promise<BotExitFlag[]>;
  /**
   * When the Position Manager (in this bot's mode) exits positions on its risk triggers, read by the server from that
   * bot's config: buying into a market it would exit at once is pointless.
   */
  getExitPolicy(): Promise<ExitPolicy>;
  /**
   * The mandate's market filters (read-only), as the risk engine applies them to buys: allowed categories,
   * settlement horizons, minimum liquidity, maximum ambiguity, allowed strategies. null when the config is invalid
   * (every buy is refused then).
   */
  getMandateSummary(): Promise<MandateSummary | null>;
  /**
   * Tokens with an open exit flag on ANY bot's position in this bot's mode (read-only; no reasons): a bot should not
   * buy a token, or its complement, that the Position Manager is told to sell.
   */
  getFlaggedTokens(): Promise<FlaggedToken[]>;
  /**
   * Position Manager stops in this bot's mode over the last 30 days, latest per token, on any bot's position
   * (read-only). Optional token filter. A token stopped out should not be bought again until its forecast is renewed.
   */
  getRecentStops(tokenId?: string): Promise<RecentStop[]>;
}

/** A token with an open exit flag on some bot's position (ctx.risk.getFlaggedTokens). */
export interface FlaggedToken {
  tokenId: string;
  /** Market (condition id) of the flagged position; null if unknown */
  marketId: string | null;
  /** When the (latest) flag was raised */
  flaggedAt: string;
}

/** The latest Position Manager stop on a token (ctx.risk.getRecentStops). */
export interface RecentStop {
  tokenId: string;
  /** Time of the latest stop exit attempt on the token (ISO) */
  stoppedAt: string;
}

/** The mandate's market filters (ctx.risk.getMandateSummary). */
export interface MandateSummary {
  /** Categories bots may buy in (`categories.allow`) */
  categoriesAllow: string[];
  /** Default settlement horizon in days [min, max] */
  resolvesWithinDays: [number, number];
  /** Long horizon in days [min, max] (capped by a global share of exposure) */
  longHorizonDays: [number, number];
  /**
   * Minimum market 24h volume (USD; config key `min_liquidity_usd`): the larger of the mandate's and limits.yaml
   * per_market. Compare with MarketDetail.volume24hUsd, as the risk engine does.
   */
  minLiquidityUsd: number;
  /** Markets with ambiguity above this are not bought */
  maxAmbiguityScore: number;
  /** Strategy keys allowed for agent bots (`strategies.allow`) */
  strategiesAllow: string[];
}

/** One leader of a copy bot as the server knows it (ctx.copy.getLeaders). */
export interface CopyLeaderStatus {
  /** Lower-case 0x address */
  address: string;
  /** active: copy it; dropped: its copies lost (auto-drop) — never copy until a human re-activates it; removed / unknown: not a leader of this bot */
  status: 'active' | 'dropped' | 'removed' | 'unknown';
  droppedReason: string | null;
}

/**
 * ctx.copy — builtin Copy Trading template only (checked by the server from the script record). The status of the
 * leaders named in the bot's config; the server runs the leader auto-drop check here.
 */
export interface CopyContext {
  getLeaders(addresses: string[]): Promise<CopyLeaderStatus[]>;
  /**
   * This bot's shares of `tokenId` (its mode) attributed to each leader whose buys it copied, net of that leader's
   * open copied sells; a leader's sell may only unwind its own copies. `attributed` = all attributed shares (0 ⇒ no
   * attribution, e.g. positions bought before attribution existed).
   */
  getHoldings(tokenId: string): Promise<CopyHoldings>;
}

/** Copied shares of one token per leader (ctx.copy.getHoldings). */
export interface CopyHoldings {
  byLeader: Record<string, number>;
  attributed: number;
}

/** The Position Manager's risk-exit thresholds (ctx.risk.getExitPolicy). */
export interface ExitPolicy {
  /** Ambiguity ≥ 1 and less than this many minutes to the market end ⇒ exit (its `exit_before_end_minutes`) */
  exitBeforeEndMinutes: number;
  /** Ambiguity at or above this (after the server raise) ⇒ exit */
  ambiguityExitScore: number;
  /** 'position-manager': from a Position Manager bot's config; 'template-default': none exists, the template's default */
  source: 'position-manager' | 'template-default';
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
  /** The other token of the forecast's binary market (its fair value is 1 − probability); null if unknown / not binary */
  complementTokenId: string | null;
  /** Market end date (ISO) from the market cache; null if unknown */
  endDate: string | null;
  /** Current max allocation (USD) of the forecast's (category, horizon) bucket; null if the bucket is unknown */
  bucketAllocationUsd: number | null;
}

export interface LedgerContext {
  /** Active forecasts, optionally one category / tradeable only */
  getActiveForecasts(filter?: { category?: string; tradeableOnly?: boolean }): Promise<BotForecast[]>;
  /** The active forecast on a token, or null */
  getForecast(tokenId: string): Promise<BotForecast | null>;
}

// ============================================================================
// Push events (spec §5.2)
// ============================================================================

/**
 * Events pushed from the server to running bots. They are hints to re-check now: a bot must still read the
 * current state (ledger, positions, budget), and events are not replayed after a restart.
 * - forecast_changed: { forecastId, tokenId, marketId, status } (new, superseded or withdrawn forecast)
 * - rules_changed: { marketId, question, changedAt } (the market's resolution rules text changed)
 * - halt: { kind: 'global' | 'bot', scope, reason } (a halt was set; orders are refused until a human clears it)
 */
export type BotPushEventName = 'forecast_changed' | 'rules_changed' | 'halt';

export type BotPushEventHandler = (data: Record<string, unknown>) => void | Promise<void>;

export interface EventsContext {
  on(name: BotPushEventName, handler: BotPushEventHandler): void;
  off(name: BotPushEventName, handler: BotPushEventHandler): void;
}

// ============================================================================
// Portfolio (position manager only, spec §9.2)
// ============================================================================

/** An open order on a position (sells only: exits). */
export interface PortfolioExitOrder {
  orderId: string;
  orderType: 'limit' | 'market';
  price: number;
  size: number;
  filledSize: number;
  status: string;
  /** Placed by this position manager (else by the owning bot itself) */
  placedByMe: boolean;
  createdAt: string;
  expiresAt: string | null;
}

/** One bot's Polymarket position (same mode as the position manager: paper sees paper, live sees live). */
export interface PortfolioPosition {
  botId: string;
  botName: string | null;
  tokenId: string;
  /** Condition id */
  marketId: string | null;
  /** Shares held (order-linked fills) */
  size: number;
  /** Shares already committed to open sells of the owning bot */
  openSellSize: number;
  /** size − openSellSize: the most an exit may sell now */
  available: number;
  avgPrice: number;
  costBasis: number;
  /** When the position was opened (first buy after it was last flat); null if unknown */
  openedAt: string | null;
  /** Forecast of the last ledger-driven buy into the position; null if none */
  entryForecastId: string | null;
  /** That forecast's status now: active / superseded / withdrawn / resolved / void ... */
  entryForecastStatus: string | null;
  /** The active forecast pricing this token now (its own, or the other token's as 1 − p) */
  forecast: {
    id: string;
    /** Probability of THIS token resolving YES */
    probability: number;
    onComplement: boolean;
    tradeable: boolean;
    createdAt: string;
  } | null;
  /** Market state from the market cache; null if unknown */
  market: {
    question: string | null;
    outcome: string | null;
    category: string | null;
    endDate: string | null;
    /** After the server raise (rules change, dispute); null = not assessed */
    ambiguityScore: number | null;
    rulesChangedAt: string | null;
    disputed: boolean;
    closed: boolean;
  } | null;
  /** Open sells on this position */
  exitOrders: PortfolioExitOrder[];
  /** Open exit flag (flag_position_exit) on this position, if any */
  exitFlag: PortfolioExitFlag | null;
}

export interface PortfolioExitFlag {
  id: string;
  botId: string;
  tokenId: string;
  marketId: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
}

export interface CapitalDemand {
  bestUnmetEdgePerDay: number | null;
  at: string | null;
}

export interface ExitRequest {
  /** The bot that holds the position; the sell is placed as that bot (its order, its fills) */
  botId: string;
  tokenId: string;
  /** Shares to sell; must be <= the position's `available` */
  size: number;
  /** Limit price. Required for a resting exit; for a marketable exit it is the worst acceptable price (default best bid) */
  price?: number;
  /** false (default): post-only resting limit; true: marketable (fill-or-kill) */
  marketable?: boolean;
  /** Resting exits only, at least 3 */
  ttlMinutes?: number;
  /** Why (stored with the order and in the audit log) */
  reason: string;
}

/**
 * ctx.portfolio — available ONLY to bots running the builtin Position Manager template (checked by the server
 * from the script record; any other bot gets an error). Exits are risk-exit SELLS placed as the owning bot
 * through its OrderService and the RiskEngine; there is no way to buy here, and a sell can never exceed what
 * the bot holds net of its open sells.
 */
export interface PortfolioContext {
  getAllPositions(): Promise<PortfolioPosition[]>;
  /** Open exit flags (agent / human flag_position_exit) in this mode */
  getExitFlags(): Promise<PortfolioExitFlag[]>;
  /**
   * Unfunded demand reported by the running Forecast Executor in this mode: the best edge per day it had to leave
   * unfunded for lack of budget at its last cycle (`at`). null fields when there is none / no executor runs.
   */
  getCapitalDemand(): Promise<CapitalDemand>;
  /** Close an open flag as handled (done) with a note */
  ackExitFlag(flagId: string, note: string): Promise<boolean>;
  exit(req: ExitRequest): Promise<OrderResult>;
  /** Cancel an open exit order this position manager placed */
  cancelExit(orderId: string): Promise<void>;
}

export interface OrderBook {
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  /** Polymarket tick size, e.g. "0.01" (prices must be multiples of it); absent when unknown */
  tick_size?: string;
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
  | 'polymarket:getOrderHistory'
  | 'polymarket:getMarket'
  | 'polymarket:getEventMarketIds'
  | 'risk:getBudget'
  | 'risk:getExitFlags'
  | 'risk:getExitPolicy'
  | 'risk:getMandateSummary'
  | 'risk:getFlaggedTokens'
  | 'risk:getRecentStops'
  | 'copy:getLeaders'
  | 'copy:getHoldings'
  | 'bot:requestRetire'
  | 'ledger:getActiveForecasts'
  | 'ledger:getForecast'
  | 'portfolio:getAllPositions'
  | 'portfolio:getExitFlags'
  | 'portfolio:getCapitalDemand'
  | 'portfolio:ackExitFlag'
  | 'portfolio:exit'
  | 'portfolio:cancelExit'
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
  | { type: 'rpc-response'; response: RpcResponse }
  /** Push event for ctx.events (spec §5.2) */
  | { type: 'bot-event'; name: BotPushEventName; data: Record<string, unknown> };

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
