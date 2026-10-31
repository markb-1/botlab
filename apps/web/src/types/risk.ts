/** DTOs of the risk, config, ledger, market, audit and reconciler endpoints (server: packages/core/src/services) */

export interface BotAllocation {
  botId: string;
  name: string;
  stage: string;
  simulated: boolean;
  allocationUsd: number | null;
  usedUsd: number;
  availableUsd: number | null;
}

export interface Overview {
  at: string;
  config: { valid: boolean; error: string | null };
  liveTradingEnabled: boolean | null;
  approvalsNewTemplateLive: boolean | null;
  equity: { usd: number | null; cashUsd: number | null; positionsUsd: number; error: string | null; at: string | null };
  exposure: {
    totalUsd: number;
    totalLimitUsd: number | null;
    totalCapUsd: number | null;
    totalCapPct: number | null;
    longHorizonPct: number | null;
    longHorizonUsd: number;
    longHorizonUnknownUsd: number;
    longHorizonLimitUsd: number | null;
    openOrders: number;
    maxOpenOrders: number | null;
  };
  dailyPnl: {
    liveUsd: number | null;
    paperUsd: number | null;
    limitUsd: number | null;
    baselineUsd: number | null;
    lossUsd: number | null;
    dayStart: string | null;
    updatedAt: string | null;
  };
  halts: {
    global: { halted: boolean; reason: string | null; haltedAt: string | null };
    bots: Array<{ botId: string; name: string; reason: string | null; haltedAt: string | null }>;
  };
  reconciler: {
    reconciledAt: string | null;
    stale: boolean;
    locked: boolean;
    lastRunAt: string | null;
    lastRunOk: boolean | null;
    lastErrors: string[];
    consecutiveFailures: number;
    mismatches: number;
    clock: { ok: boolean; reason: string | null; detail: string | null; skewMs: number | null };
  };
  rights: { counts: Record<string, number>; trading: Array<{ category: string; horizonBucket: string; maxAllocationUsd: number }> };
  bots: BotAllocation[];
}

export interface RiskBotState {
  botId: string;
  name: string;
  stage: string;
  mode: string;
  status: string;
  halted: boolean;
  haltReason: string | null;
  haltedAt: string | null;
  dayRealizedPnl: number;
  dayUnrealizedPnl: number;
}

export interface RiskState {
  global: { scope: string; halted: boolean; reason: string | null; haltedAt: string | null } | null;
  bots: RiskBotState[];
}

export interface BotOrder {
  id: string;
  exchange: string;
  marketId: string;
  tokenId: string;
  side: string;
  orderType: string;
  price: number;
  size: number;
  notionalUsd: number;
  status: string;
  filledSize: number;
  avgFillPrice: number | null;
  feeUsd: number;
  simulated: boolean;
  forecastId: string | null;
  exchangeOrderId: string | null;
  expiresAt: string | null;
  reason: string | null;
  failedCheck: string | null;
  riskReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptVersionInfo {
  version: number;
  sourceHash: string;
  createdAt: string;
  createdBy: string;
}

export interface Forecast {
  id: string;
  marketId: string;
  tokenId: string;
  eventId: string;
  category: string;
  probability: number;
  marketPriceAtForecast: number;
  bestBid: number | null;
  bestAsk: number | null;
  liquidityUsd: number | null;
  rationale: string;
  sources: string[];
  ambiguityScore: number;
  status: 'active' | 'superseded' | 'withdrawn' | 'resolved' | 'void' | string;
  supersededBy: string | null;
  tradeable: boolean;
  daysToResolutionAtForecast: number;
  horizonBucket: 'short' | 'medium' | 'long';
  priceAt7d: number | null;
  convergence: number | null;
  createdBy: string;
  createdAt: string;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  resolvedAt: string | null;
  outcome: number | null;
  brierAgent: number | null;
  brierMarket: number | null;
  skill: number | null;
}

export interface BucketStats {
  category: string;
  horizonBucket: 'short' | 'medium' | 'long';
  state: 'shadow' | 'trading' | 'suspended' | 'deprioritised';
  forced: boolean;
  nScored: number;
  skillMean: number | null;
  skillLowerBound: number | null;
  nConvergence: number;
  convergenceMean: number | null;
  convergenceLowerBound: number | null;
  maxAllocationUsd: number;
  changedAt: string;
  changedReason: string | null;
  lastEvaluatedAt: string | null;
  mandate: string;
  threshold: { required: number; remaining: number; ratePerDay: number; expectedAt: string | null };
}

export interface MarketToken {
  tokenId: string;
  outcome: string;
}

export interface MarketView {
  marketId: string;
  eventId: string;
  eventTitle: string | null;
  slug: string | null;
  question: string;
  category: string;
  tags: string[];
  rulesText: string | null;
  rulesHash: string | null;
  rulesChangedAt: string | null;
  endDate: string | null;
  resolutionSource: string | null;
  negRisk: boolean;
  tokens: MarketToken[];
  feeCategory: string | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  active: boolean;
  closed: boolean;
  outcomePrices: string[] | null;
  umaResolutionStatus: string | null;
  disputed: boolean;
  assessedAmbiguity: number | null;
  ambiguitySource: string | null;
  ambiguityNote: string | null;
  ambiguityScore: number | null;
  ambiguityRaisedBecause: string | null;
  updatedAt: string;
}

export interface MarketSearchRow {
  marketId: string;
  question: string;
  category: string;
  endDate: string | null;
  closed: boolean;
  ambiguityScore: number | null;
  rulesChangedAt: string | null;
  disputed: boolean;
  updatedAt: string;
}

/** Live Gamma search result (GET /api/markets/search) */
export interface GammaSearchHit {
  marketId: string;
  question: string;
  eventTitle: string | null;
  slug: string | null;
  category: string;
  endDate: string | null;
  closed: boolean;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  feeRate: number | null;
  cached: boolean;
  ambiguityScore: number | null;
}

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  payload: unknown;
  result: string | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  nextBefore: number | null;
}

export interface ConfigVersion {
  versionId: string;
  file: string;
  at: string;
  actor: string;
  source: string;
  sha256: string;
}

export interface ConfigChange {
  file: string;
  path: string;
  old: unknown;
  new: unknown;
  effect: 'raises' | 'lowers' | 'neutral';
}

export interface ConfigPreview {
  valid: boolean;
  issues: string[];
  changes: ConfigChange[];
  raises: boolean;
}

export interface ConfigGetResult {
  config: Record<string, Record<string, unknown>> | null;
  error: string | null;
  hashes: Record<string, string>;
}

export interface ApiToken {
  id: string;
  name: string;
  scope: 'agent' | 'readonly';
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface WatchlistEntry {
  token_id: string;
  market_id: string | null;
  note: string | null;
  added_by?: string;
  added_at?: string;
}

export interface AdoptResult {
  adopted: Array<{ tokenId: string; marketId: string | null; quantity: number; price: number; postFirstOrderQuantity?: number }>;
  skipped: Array<{ tokenId: string; reason: string }>;
}

export interface ReconcileStatus {
  at: string;
  consecutiveFailures: number;
  clockSkewed: boolean;
  result: {
    ok: boolean;
    errors: string[];
    clockSkewMs: number | null;
    ordersChecked: number;
    mismatches: Array<{
      key: string;
      walletId: string;
      exchange: string;
      symbol: string;
      marketId: string | null;
      direction: string;
      exchangeQty: number;
      localQty: number;
      valueUsd: number;
      preExisting: boolean;
      consecutive: number;
    }>;
    halted: boolean;
  };
}
