/**
 * Types for the risk engine (spec §4). No Electron or DB imports — this moves to
 * packages/core/risk later.
 */

export type Exchange = 'polymarket' | 'binance';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';
export type BotStage = 'paper' | 'probation' | 'full' | 'retired';
export type CategoryRightsState = 'shadow' | 'trading' | 'suspended' | 'deprioritised';
export type HorizonBucket = 'short' | 'medium' | 'long';

/** Market metadata captured when the order is checked (Polymarket only). */
export interface MarketSnapshot {
  /** Token the book fields (best bid/ask, sizes) describe; must equal the order's tokenId */
  tokenId: string;
  category: string | null;
  /** ISO timestamp of the market end date */
  endDate: string | null;
  /** 0–3 (spec §7.4); null = not rated */
  ambiguityScore: number | null;
  /** ISO timestamp of the last rules_hash change, if any */
  rulesChangedAt: string | null;
  /** 24h volume in USD */
  liquidityUsd: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  /** USD size resting at the best bid / best ask */
  bestBidSizeUsd: number | null;
  bestAskSizeUsd: number | null;
  /** Taker fee as a fraction of notional; makers pay 0 */
  takerFeeRate: number;
}

/** Present only for ledger-driven orders. */
export interface ForecastEdgeInfo {
  forecastId: string;
  /** Forecast probability of the token being ordered (not necessarily YES) */
  probability: number;
  /** Template `min_edge`; floored at 0.03 by the engine */
  minEdge?: number;
}

export interface OrderRequest {
  botId: string;
  exchange: Exchange;
  /** Polymarket condition id, or Binance symbol */
  marketId: string;
  /** Polymarket token id, or Binance symbol */
  tokenId: string;
  side: OrderSide;
  orderType: OrderType;
  /** Limit price (for market orders: the worst acceptable price) */
  price: number;
  size: number;
  notionalUsd: number;
  /** Sell flagged as a risk exit by the position manager or a human; see RiskEngine for exemptions */
  riskExit?: boolean;
  forecast?: ForecastEdgeInfo | null;
  /** Required for Polymarket orders; null for Binance */
  market: MarketSnapshot | null;
}

export interface BotRiskInfo {
  id: string;
  stage: BotStage;
  /** Per-bot allocation override; can only lower the configured allocation */
  allocationUsd: number | null;
  /** Markets the bot is scoped to; null = unscoped (legacy human-created bots) */
  marketIds: string[] | null;
  halted: boolean;
  haltReason?: string | null;
  /** Bot runs a template with trust=new (smaller probation allocation) */
  newTemplate?: boolean;
  /** Strategy template key (bots.strategy); `forecast` bots may only buy with a forecast */
  strategy?: string | null;
}

/**
 * State the engine needs to check one order. Supplied by a RiskStateProvider
 * so the engine itself never does I/O.
 *
 * Exposure = open position cost + open buy order notional (spec §3.1).
 */
export interface RiskStateSnapshot {
  /** Epoch ms; all time-based checks use this, never Date.now() */
  now: number;
  globalHalted: boolean;
  globalHaltReason?: string | null;
  /** null when the bot does not exist */
  bot: BotRiskInfo | null;
  /** Wallet equity in USD (for max_total_exposure_pct). Only checked for buys; may be NaN for sells. */
  equityUsd: number;
  exposure: {
    /** This bot, all markets */
    botUsd: number;
    /** This market, all bots */
    marketUsd: number;
    /** Everything */
    totalUsd: number;
    /** Markets settling beyond the mandate's default horizon (see isLongHorizon) */
    longHorizonUsd: number;
  };
  /** Category rights for (market category, horizon bucket); needed for ledger-driven orders */
  categoryBucket: {
    state: CategoryRightsState;
    exposureUsd: number;
    maxAllocationUsd: number;
  } | null;
  /** Orders this bot submitted in the last hour (including rejected) */
  botOrdersLastHour: number;
  /** Open orders across all bots */
  openOrdersCount: number;
  /** This bot's holding in the order's token; needed for sells */
  position: {
    size: number;
    /** Size already committed to this bot's resting sell orders in the token */
    openSellSize: number;
    openedAt: number;
  } | null;
}

export interface RiskStateProvider {
  getSnapshot(order: OrderRequest): RiskStateSnapshot | Promise<RiskStateSnapshot>;
}

export type RiskCheckName =
  | 'state_invalid'
  | 'global_halt'
  | 'bot_halt'
  | 'bot_stage'
  | 'forecast_required'
  | 'exchange_enabled'
  | 'market_data'
  | 'market_scope'
  | 'category'
  | 'end_buffer'
  | 'ambiguity'
  | 'rules_changed'
  | 'liquidity'
  | 'order_input'
  | 'max_order'
  | 'price_range'
  | 'spread'
  | 'marketable_allowed'
  | 'slippage'
  | 'top_of_book'
  | 'bot_rate'
  | 'open_orders'
  | 'sell_position'
  | 'horizon'
  | 'bot_exposure'
  | 'market_exposure'
  | 'total_exposure'
  | 'long_horizon'
  | 'category_exposure'
  | 'hold_time'
  | 'edge'
  // Rejections raised by OrderService before the engine runs (step 0)
  | 'forecast_unavailable'
  | 'post_only'
  | 'unsupported_symbol'
  | 'market_data_unavailable'
  // Local clock differs from exchange time by more than 5 s (spec §15; set by the Reconciler)
  | 'clock_skew';

export interface RiskCheckResult {
  /** Spec §4.1 step number (1–7); 0 = snapshot validation */
  step: number;
  name: RiskCheckName;
  passed: boolean;
  detail: string;
  values?: Record<string, number | string | boolean | null>;
}

/** Stored as JSON in `orders.risk_decision`. */
export interface RiskDecision {
  allowed: boolean;
  failedCheck?: RiskCheckName;
  reason?: string;
  /** Checks that ran, in order; stops at the first failure */
  checks: RiskCheckResult[];
  evaluatedAt: string;
}
