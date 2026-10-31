/**
 * BotService — bot CRUD, lifecycle and the stats / positions / trades views (moved out of the
 * Electron `botHandlers`, spec §1.1). Transport-free: IPC today, HTTP + MCP in 3b.
 *
 * Starting, stopping and wallet operations need the unlocked BotManager / WalletManager; before
 * unlock those calls throw `ServiceError('locked')`.
 */

import { DEFAULT_MAX_EVENTS, DEFAULT_MAX_LOG_LINES, type BotActivityLog, type BotCustomEvent, type BotLogLine } from '../bots/BotActivityLog';
import type { BotRepository } from '../db/repositories/BotRepository';
import type { WalletRepository } from '../db/repositories/WalletRepository';
import { builtinRoleOf, isStandingRole, isStrategyRole, type ScriptRepository, type ScriptRow, type StrategyRole } from '../db/repositories/ScriptRepository';
import { validateConfigAgainstSchema } from '../utils/configSchema';
import type { OrderRepository, OrderRow } from '../db/repositories/OrderRepository';
import type { BotTradeRepository } from '../db/repositories/BotTradeRepository';
import type { BotStorageRepository } from '../db/repositories/BotStorageRepository';
import type { SettingsRepository } from '../db/repositories/SettingsRepository';
import type { BotManager } from '../bots/BotManager';
import type { WalletManager } from '../bots/WalletManager';
import type { IpcBot, IpcBotTrade } from './types';
import type { AuditService } from '../audit/AuditService';
import { auditActorOf, requireActor, type Actor } from './actors';
import { initialStage, lowerStage } from '../risk/ramp';
import type { BotStage } from '../risk/types';
import logger from '../utils/logger';
import { ServiceError, conflict, notFound } from './errors';
import type { BotCreateInput, BotUpdateInput } from './schemas';
import type { LimitsConfig, MandateConfig } from '../config/schema';

// Module-level cache for token → market info resolution (static data)
const tokenInfoCache = new Map<string, { market: string; outcome: string }>();

/**
 * Resolve a Polymarket tokenId to its market title and outcome label.
 * Results are cached in-memory to avoid repeated API calls.
 */
async function resolveTokenInfo(tokenId: string): Promise<{ market: string; outcome: string } | null> {
  const cached = tokenInfoCache.get(tokenId);
  if (cached) return cached;

  try {
    const resp = await fetch(
      `https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`
    );
    if (!resp.ok) return null;
    const markets = await resp.json();
    if (!Array.isArray(markets) || markets.length === 0) return null;

    const mkt = markets[0];
    let outcomeLabel = '';
    try {
      const tokenIds: string[] = typeof mkt.clobTokenIds === 'string'
        ? JSON.parse(mkt.clobTokenIds)
        : (mkt.clobTokenIds || []);
      const outcomes: string[] = typeof mkt.outcomes === 'string'
        ? JSON.parse(mkt.outcomes)
        : (mkt.outcomes || []);
      const tokenIndex = tokenIds.indexOf(tokenId);
      outcomeLabel = tokenIndex >= 0 && outcomes[tokenIndex] ? outcomes[tokenIndex] : outcomes[0] || '';
    } catch {
      outcomeLabel = '';
    }

    const info = { market: mkt.question || mkt.title || '', outcome: outcomeLabel };
    if (info.market) {
      tokenInfoCache.set(tokenId, info);
    }
    return info;
  } catch {
    return null;
  }
}

/**
 * Fetch the current price for a Polymarket tokenId from the Gamma API.
 * Prices are NOT cached since they change frequently.
 */
async function fetchCurrentPrice(tokenId: string): Promise<number | null> {
  try {
    const resp = await fetch(
      `https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`
    );
    if (!resp.ok) return null;
    const markets = await resp.json();
    if (!Array.isArray(markets) || markets.length === 0) return null;

    const mkt = markets[0];
    const tokenIds: string[] = typeof mkt.clobTokenIds === 'string'
      ? JSON.parse(mkt.clobTokenIds)
      : (mkt.clobTokenIds || []);
    const prices: string[] = typeof mkt.outcomePrices === 'string'
      ? JSON.parse(mkt.outcomePrices)
      : (mkt.outcomePrices || []);
    const tokenIndex = tokenIds.indexOf(tokenId);
    if (tokenIndex >= 0 && prices[tokenIndex]) {
      return parseFloat(prices[tokenIndex]);
    }
    return prices[0] ? parseFloat(prices[0]) : null;
  } catch {
    return null;
  }
}

/** Polymarket Data API position response */
interface PolymarketPosition {
  asset: string;
  conditionId: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  curPrice: number;
  cashPnl: number;
  percentPnl: number;
  redeemable?: boolean;
  title?: string;
  outcome?: string;
}

/**
 * Fetch live positions directly from the Polymarket Data API.
 * Public endpoint — no auth required, just the wallet address.
 * Only returns open positions (size > 0).
 */
async function fetchLivePositions(address: string): Promise<PolymarketPosition[]> {
  const allPositions: PolymarketPosition[] = [];
  const limit = 500;
  let offset = 0;

  try {
    while (offset < 5000) {
      const resp = await fetch(
        `https://data-api.polymarket.com/positions?user=${address}&sizeThreshold=0.01&limit=${limit}&offset=${offset}`
      );
      if (!resp.ok) break;
      const positions = await resp.json();
      if (!Array.isArray(positions) || positions.length === 0) break;

      allPositions.push(...positions);
      if (positions.length < limit) break;
      offset += limit;
    }
  } catch (err) {
    logger.error(`Failed to fetch live positions for ${address}: ${err}`);
  }

  return allPositions;
}

function parseMarketIds(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function botRowToIpc(
  row: any,
  walletRepo: WalletRepository,
  scriptRepo: ScriptRepository
): IpcBot {
  const wallet = walletRepo.findById(row.wallet_id);
  const script = scriptRepo.findById(row.script_id);

  return {
    id: row.id,
    name: row.name,
    scriptId: row.script_id,
    scriptName: script?.name || 'Unknown',
    walletId: row.wallet_id,
    walletAddress: wallet?.address,
    config: JSON.parse(row.config || '{}'),
    status: row.status,
    enabled: row.enabled === 1,
    mode: (row.mode as 'live' | 'paper') || 'live',
    stage: row.stage,
    createdBy: row.created_by ?? 'human',
    allocationUsd: row.allocation_usd ?? null,
    retireReason: row.retire_reason ?? null,
    pausedBy: row.paused_by ?? null,
    strategy: row.strategy ?? null,
    marketIds: parseMarketIds(row.market_ids),
    templateVersion: row.template_version ?? null,
    scriptRevision: script?.revision ?? null,
    scriptTrust: script?.trust ?? null,
    role: builtinRoleOf(script),
    stageChangedAt: row.stage_changed_at ?? null,
    lastStartedAt: row.last_started_at,
    lastStoppedAt: row.last_stopped_at,
    lastHeartbeat: row.last_heartbeat,
    errorLogs: JSON.parse(row.error_logs || '[]'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function tradeRowToIpc(row: any): IpcBotTrade {
  return {
    id: row.id,
    botId: row.bot_id,
    botName: row.bot_name,
    scriptName: row.script_name,
    traderAddress: row.trader_address,
    market: row.market,
    outcome: row.outcome,
    side: row.side,
    traderBetSize: row.trader_bet_size,
    botBetSize: row.bot_bet_size,
    executedAt: row.executed_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    exchange: row.exchange,
    symbol: row.symbol,
    price: row.price,
    quantity: row.quantity,
    quoteAmount: row.quote_amount,
    simulated: row.simulated,
  };
}

/**
 * A bot may not change wallets while it has open live orders or live positions (2b review): its orders and
 * fills stay attributed to the wallet they were made on, and the reconciler compares per wallet.
 */
export function walletChangeBlocker(
  botId: string,
  tradeRepo: Pick<BotTradeRepository, 'getRiskPositions'>,
  orderRepo?: Pick<OrderRepository, 'findOpen'>
): string | null {
  if (!orderRepo) return 'Cannot change the wallet: order store unavailable';
  const open = orderRepo.findOpen(botId, false).length;
  const positions = tradeRepo.getRiskPositions({ simulated: false, botId }).filter((p) => p.net_quantity > 1e-9).length;
  if (open === 0 && positions === 0) return null;
  return `Cannot change the wallet of a bot with ${open} open live order(s) and ${positions} live position(s); cancel the orders and close the positions first`;
}


/** A bot's position as shown in the UI (live: Data API; paper: trade history + Gamma price) */
export interface BotPositionView {
  symbol: string;
  exchange: string;
  market: string | null;
  outcome: string | null;
  netQuantity: number;
  totalCost: number;
  tradeCount: number;
  currentPrice: number | null;
  currentValue: number | null;
}

export interface BotStatsView {
  cashBalance: number;
  positionsValue: number;
  totalValue: number;
  initialBalance: number | null;
  pnlAllTime: number | null;
  pnl24h: number;
  mode: 'live' | 'paper';
}

export interface BotDashboardStat {
  botId: string;
  totalValue: number;
  positionCount: number;
  pnlAllTime: number | null;
  pnl24h: number;
}

export interface BotOrderView {
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
  /** Free text the bot gave, or the exchange / pre-check error */
  reason: string | null;
  /** Risk check that rejected the order and its message (orders.risk_decision) */
  failedCheck: string | null;
  riskReason: string | null;
  createdAt: string;
  updatedAt: string;
}

function orderRowToView(o: OrderRow): BotOrderView {
  let failedCheck: string | null = null;
  let riskReason: string | null = null;
  if (o.risk_decision) {
    try {
      const d = JSON.parse(o.risk_decision) as { allowed?: boolean; failedCheck?: string; reason?: string };
      if (d && d.allowed === false) {
        failedCheck = d.failedCheck ?? null;
        riskReason = d.reason ?? null;
      }
    } catch {
      riskReason = 'unreadable risk decision';
    }
  }
  return {
    id: o.id,
    exchange: o.exchange,
    marketId: o.market_id,
    tokenId: o.token_id,
    side: o.side,
    orderType: o.order_type,
    price: o.price,
    size: o.size,
    notionalUsd: o.notional_usd,
    status: o.status,
    filledSize: o.filled_size,
    avgFillPrice: o.avg_fill_price,
    feeUsd: o.fee_usd,
    simulated: o.simulated === 1,
    forecastId: o.forecast_id,
    exchangeOrderId: o.exchange_order_id,
    expiresAt: o.expires_at,
    reason: o.reason,
    failedCheck,
    riskReason,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

function clampLimit(limit: number | null | undefined, max: number): number {
  return typeof limit === 'number' && Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), max) : max;
}

export interface BotServiceDeps {
  botRepo: BotRepository;
  walletRepo: WalletRepository;
  scriptRepo: ScriptRepository;
  tradeRepo: BotTradeRepository;
  storageRepo: BotStorageRepository;
  settingsRepo: SettingsRepository;
  audit?: AuditService;
  orderRepo?: Pick<OrderRepository, 'findOpen' | 'findByBot'>;
  /** Recent log lines / custom events per bot (in memory) */
  activity?: Pick<BotActivityLog, 'getLogs' | 'getEvents' | 'forget'>;
  /** The BotManager once the core is unlocked, else null */
  botManager: () => Pick<BotManager, 'startBot' | 'stopBot' | 'restartBot'> | null;
  /** The WalletManager once the core is unlocked, else null */
  walletManager: () => Pick<WalletManager, 'createPaperWallet' | 'deletePaperWallet'> | null;
  /** Limits in force (agent bot caps); null = config unavailable ⇒ the agent may not create bots */
  getLimits?: () => LimitsConfig | null;
  /** Refuses agent writes during an event-triggered (maintenance-only) run (AgentService.guardMaintenanceRun) */
  guardAgentRun?: (by: unknown, action: string) => void;
  /** Cached market question / outcome of a token (positions and orders views) */
  describeToken?: (tokenId: string) => { marketId: string; question: string; outcome: string | null } | null;
  /** A token's market, refreshing the market cache from Gamma when needed (agent strategy-bot creates) */
  lookupTokenMarketInfo?: (tokenId: string) => Promise<StrategyMarketInfo | null>;
  /** A token's market from the cache only (agent strategy-bot config updates) */
  cachedTokenMarketInfo?: (tokenId: string) => StrategyMarketInfo | null;
  /** Every market of an event: `fetch` may call Gamma (creates), `cached` does not (updates) */
  eventMarketIds?: { fetch: (eventId: string) => Promise<string[] | null>; cached: (eventId: string) => string[] | null };
  /** A ledger forecast by id (resolution-rule `forecast_id`) */
  getForecast?: (id: string) => { tokenId: string; status: string } | null;
  /** Mandate in force (`strategies.allow` gates agent strategy bots); null = config unavailable */
  getMandate?: () => MandateConfig | null;
  now?: () => number;
}

/** What BotService needs to know about a strategy bot's market (from the market cache) */
export interface StrategyMarketInfo {
  marketId: string;
  eventId: string;
  negRisk: boolean;
  endDate: string | null;
  question: string;
  tokens: Array<{ tokenId: string; outcome: string }>;
}

/** Mandate `strategies.allow` key of each builtin strategy role */
const STRATEGY_KEYS: Record<StrategyRole, string> = { consistency: 'consistency', 'resolution-rule': 'resolution_rule' };

/** The token ids a strategy-role bot's config trades (consistency: `tokens`; resolution-rule: `token_id`). */
export function strategyConfigTokens(role: StrategyRole, config: Record<string, unknown> | undefined): string[] {
  const c = config ?? {};
  const raw = role === 'consistency' ? (Array.isArray(c.tokens) ? c.tokens : []) : [c.token_id];
  return [...new Set(raw.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()))];
}

/** A position from the order-linked fills the risk engine uses (spec §7.3 get_positions) */
export interface RiskPositionView {
  botId: string;
  botName: string | null;
  exchange: string;
  /** Polymarket token id / Binance symbol */
  symbol: string;
  marketId: string | null;
  question: string | null;
  outcome: string | null;
  netQuantity: number;
  costBasisUsd: number;
  simulated: boolean;
}

/** 24h P&L: realized trades in the last 24 hours (sells − buys) */
function pnl24hFor(tradeRepo: BotTradeRepository, botId: string): number {
  const recentTrades = tradeRepo.findByBotId(botId, { hoursAgo: 24 });
  let pnl24h = 0;
  for (const trade of recentTrades) {
    const amount = trade.quote_amount ?? 0;
    if (trade.side === 'SELL') {
      pnl24h += amount;
    } else if (trade.side === 'BUY') {
      pnl24h -= amount;
    }
  }
  return pnl24h;
}

export class BotService {
  constructor(private deps: BotServiceDeps) {}

  private manager() {
    const m = this.deps.botManager();
    if (!m) throw new ServiceError('locked', 'App is locked: unlock BotLab first');
    return m;
  }

  private wallets() {
    const w = this.deps.walletManager();
    if (!w) throw new ServiceError('locked', 'App is locked: unlock BotLab first');
    return w;
  }

  private toView(row: Parameters<typeof botRowToIpc>[0]): IpcBot {
    return botRowToIpc(row, this.deps.walletRepo, this.deps.scriptRepo);
  }

  /** Agent creates whose paper wallet is still being made (counted toward the caps) */
  private pendingAgentCreates = 0;

  /**
   * Agent bot rules (spec §7.3 create_bot, Decisions R109/R133): only from a template (`kind = template`),
   * at most `agent.max_bots_created_per_day` in the last 24 h and `agent.max_active_bots` not retired.
   * Unreadable limits ⇒ refused (fail closed). Denials are audited.
   */
  private checkAgentCreate(data: BotCreateInput): void {
    const { botRepo, scriptRepo, audit } = this.deps;
    const deny = (why: string, code: 'forbidden' | 'conflict' = 'forbidden'): never => {
      audit?.record('agent', 'bot.create', null, { name: data.name, scriptId: data.scriptId }, `denied: ${why}`);
      throw new ServiceError(code, `bots.create: ${why}`);
    };
    const script = scriptRepo.findById(data.scriptId);
    if (!script) throw notFound('Script not found');
    if (script.kind !== 'template') deny('the agent can only create bots from templates (list_templates)');
    // Standing builtin roles (executor, position manager) are set up by a human (R168)
    const role = builtinRoleOf(script);
    if (isStandingRole(role)) deny(`the ${role} template is a standing bot only a human can create`);
    const limits = this.deps.getLimits?.() ?? null;
    if (!limits) deny('limits unavailable (config invalid)', 'conflict');
    const { max_bots_created_per_day: perDay, max_active_bots: maxActive } = limits!.agent;
    const since = new Date((this.deps.now ?? Date.now)() - 86_400_000).toISOString();
    const createdToday = botRepo.countCreatedSince('agent', since) + this.pendingAgentCreates;
    if (createdToday >= perDay) deny(`agent bot limit reached: ${createdToday} created in the last 24 h (agent.max_bots_created_per_day = ${perDay})`, 'conflict');
    const active = botRepo.countActiveCreatedBy('agent') + this.pendingAgentCreates;
    if (active >= maxActive) deny(`agent bot limit reached: ${active} agent bots not retired (agent.max_active_bots = ${maxActive}); retire one first`, 'conflict');
  }

  /** The agent acts on its own bots only for start / config / retire (Decision R134); denial audited */
  private requireAgentOwned(row: { id: string; created_by: string }, action: string): void {
    if (row.created_by === 'agent') return;
    this.deps.audit?.record('agent', action, row.id, undefined, 'denied: bot not created by the agent');
    throw new ServiceError('forbidden', `${action}: the agent may only do this for bots it created (pause_bot works on any bot)`);
  }

  /** The agent may not start, restart or reconfigure a bot on a standing builtin-role template (R168); denial audited */
  private refuseAgentOnRole(row: { id: string; script_id: string }, action: string): void {
    const role = builtinRoleOf(this.deps.scriptRepo.findById(row.script_id));
    if (!isStandingRole(role)) return;
    this.deps.audit?.record('agent', action, row.id, { role }, `denied: ${role} bot`);
    throw new ServiceError('forbidden', `${action}: ${role} bots are standing bots managed by a human (the agent may only pause them)`);
  }

  /**
   * Agent bots on the builtin strategy templates (consistency, resolution-rule; 5b): the strategy must be allowed by
   * the mandate (`strategies.allow`), the config must match the template's configSchema, and the bot's market_ids
   * must cover the market of every token in the config (resolved through the market cache; unknown ⇒ refused).
   * `resolve` maps a token to its condition id (cached; create pre-fetches unknown tokens). Denials are audited.
   * Does nothing for any other script.
   */
  private checkAgentStrategyBot(
    script: ScriptRow | undefined,
    config: Record<string, unknown> | undefined,
    marketIds: string[] | null | undefined,
    action: string,
    target: string | null,
    resolve: (tokenId: string) => StrategyMarketInfo | null,
    eventMarkets: (eventId: string) => string[] | null
  ): void {
    const role = builtinRoleOf(script);
    if (!isStrategyRole(role) || !script) return;
    const deny = (why: string): never => {
      this.deps.audit?.record('agent', action, target, { role, marketIds: marketIds ?? null }, `denied: ${why}`);
      throw new ServiceError('forbidden', `${action === 'bot.create' ? 'bots.create' : 'bots.update'}: ${why}`);
    };
    const mandate = this.deps.getMandate?.() ?? null;
    if (this.deps.getMandate && !mandate) deny('mandate unavailable (config invalid)');
    if (mandate && !mandate.strategies.allow.includes(STRATEGY_KEYS[role])) deny(`strategy ${STRATEGY_KEYS[role]} is not in mandate.strategies.allow`);
    let schema: unknown = {};
    try {
      schema = JSON.parse(script.config_schema || '{}');
    } catch {
      schema = {};
    }
    const errors = validateConfigAgainstSchema(config, schema);
    if (errors.length > 0) deny(`config does not match the ${role} template: ${errors.slice(0, 5).join('; ')}`);
    const tokens = strategyConfigTokens(role, config);
    if (tokens.length === 0) deny(`config names no token (${role === 'consistency' ? 'tokens' : 'token_id'})`);
    if (!marketIds || marketIds.length === 0) deny(`${role} bots need marketIds covering every token in the config`);
    const infos: StrategyMarketInfo[] = [];
    for (const t of tokens) {
      const info = resolve(t);
      if (!info) deny(`token ${t} is unknown to the market cache (open it with get_market first)`);
      if (!marketIds!.includes(info!.marketId)) deny(`token ${t} belongs to market ${info!.marketId}, which is not in the bot's marketIds`);
      infos.push(info!);
    }
    const c = config ?? {};
    if (role === 'consistency') {
      // The same structural rules the template checks at start (5b review): YES tokens of binary markets, ladder
      // end dates known and ordered, exclusive sums inside one event, exhaustive sets covering the whole event
      infos.forEach((m, i) => {
        const own = m.tokens.find((x) => x.tokenId === tokens[i]);
        if (m.tokens.length !== 2 || !own || !/^yes$/i.test(own.outcome)) deny(`token ${tokens[i]} is not the YES token of a binary market`);
      });
      if (new Set(infos.map((m) => m.marketId)).size !== infos.length) deny('every token must be in a different market');
      if (c.constraint === 'date_ladder') {
        for (const m of infos) if (!m.endDate || !Number.isFinite(Date.parse(m.endDate))) deny(`date_ladder: "${m.question}" has no known end date`);
        for (let i = 1; i < infos.length; i++) {
          if (Date.parse(infos[i - 1].endDate as string) > Date.parse(infos[i].endDate as string)) deny('date_ladder tokens must be ordered by deadline (earliest first)');
        }
      }
      if (c.constraint === 'exclusive_sum') {
        if (new Set(infos.map((m) => m.eventId)).size !== 1) deny('exclusive_sum: every token must be a market of the same event');
        if (infos.some((m) => m.negRisk) && !infos.every((m) => m.negRisk)) deny('exclusive_sum: mixed negRisk and plain markets');
        if (c.exhaustive === true) {
          if (!infos.every((m) => m.negRisk)) deny('exhaustive: the legs must be the markets of one negRisk event');
          const all = eventMarkets(infos[0].eventId);
          if (!all) deny('exhaustive: the event\'s market list is unknown (get_market on a leg loads it)');
          const legSet = new Set(infos.map((m) => m.marketId));
          if (all!.length !== infos.length || all!.some((id) => !legSet.has(id))) {
            deny(`exhaustive: the event has ${all!.length} markets but the config has ${infos.length} legs (every outcome must be a leg)`);
          }
        }
      }
    }
    if (role === 'resolution-rule' && typeof c.forecast_id === 'string' && c.forecast_id.trim()) {
      const f = this.deps.getForecast?.(c.forecast_id.trim()) ?? null;
      if (!f) deny(`forecast ${c.forecast_id} not found`);
      if (f!.status !== 'active') deny(`forecast ${c.forecast_id} is ${f!.status}, not active`);
      const own = infos[0];
      if (!own.tokens.some((x) => x.tokenId === f!.tokenId)) deny(`forecast ${c.forecast_id} is on token ${f!.tokenId}, not ${tokens[0]} or its complement`);
    }
  }

  list(filter?: { scriptId?: string; status?: string }): IpcBot[] {
    const rows = this.deps.botRepo.findAll({
      scriptId: filter?.scriptId,
      status: filter?.status,
    });
    return rows.map((row) => this.toView(row));
  }

  get(id: string): IpcBot {
    const row = this.deps.botRepo.findById(id);
    if (!row) throw notFound('Bot not found');
    return this.toView(row);
  }

  async create(data: BotCreateInput, by: Actor): Promise<IpcBot> {
    const who = requireActor(by, ['human', 'agent'], 'bots.create');
    const actor = auditActorOf(who);
    const { botRepo, scriptRepo, audit } = this.deps;
    // The agent creates paper bots only, on their own throwaway paper wallet: it never picks a wallet or
    // goes live (spec §4.6, §7.3; Decision R109). A human creates the live bot.
    if (who.kind === 'agent' && (data.walletId !== undefined || (data.mode !== undefined && data.mode !== 'paper'))) {
      audit?.record(actor, 'bot.create', null, { name: data.name, mode: data.mode, walletId: data.walletId }, 'denied: agent bots are paper bots without a wallet choice');
      throw new ServiceError('forbidden', 'bots.create: the agent can only create paper bots (no walletId, mode paper)');
    }
    if (who.kind === 'agent') {
      this.deps.guardAgentRun?.(who, 'bot.create');
      this.checkAgentCreate(data);
      const script = scriptRepo.findById(data.scriptId);
      const role = builtinRoleOf(script);
      const markets = new Map<string, StrategyMarketInfo | null>();
      const events = new Map<string, string[] | null>();
      if (isStrategyRole(role)) {
        // Resolve the config's tokens (and an exhaustive set's event) first — may refresh from Gamma — then check
        for (const t of strategyConfigTokens(role, data.config).slice(0, 20)) {
          try {
            markets.set(t, this.deps.lookupTokenMarketInfo ? await this.deps.lookupTokenMarketInfo(t) : (this.deps.cachedTokenMarketInfo?.(t) ?? null));
          } catch {
            markets.set(t, null);
          }
        }
        const firstEvent = [...markets.values()].find((m) => m)?.eventId;
        if (firstEvent && data.config?.exhaustive === true && this.deps.eventMarketIds) {
          try {
            events.set(firstEvent, await this.deps.eventMarketIds.fetch(firstEvent));
          } catch {
            events.set(firstEvent, null);
          }
        }
      }
      this.checkAgentStrategyBot(script, data.config, data.marketIds, 'bot.create', null, (t) => markets.get(t) ?? null, (e) => events.get(e) ?? null);
    }
    let walletId = data.walletId;
    // Live is never implied (3b, spec §15.2): a bot created without a mode is a paper bot
    const mode = data.mode ?? 'paper';

    // Auto-generate a throwaway wallet for paper bots. Agent creates in flight count toward its caps.
    if (who.kind === 'agent') this.pendingAgentCreates++;
    try {
      if (mode === 'paper' && !walletId) {
        const paperWallet = await this.wallets().createPaperWallet(data.name);
        walletId = paperWallet.id;
      }
    } finally {
      if (who.kind === 'agent') this.pendingAgentCreates--;
    }

    if (!walletId) {
      throw new ServiceError('invalid_input', 'Wallet is required for live bots');
    }

    // Ramp (spec §4.5): new template ⇒ paper, proven template ⇒ probation
    const script = scriptRepo.findById(data.scriptId);
    const stage = initialStage(script?.trust);
    const row = botRepo.create({
      name: data.name,
      scriptId: data.scriptId,
      walletId,
      config: data.config,
      enabled: data.enabled,
      mode,
      stage,
      templateVersion: script?.revision ?? null,
      createdBy: who.kind,
      marketIds: data.marketIds ?? null,
    });
    audit?.record(actor, 'bot.create', row.id, {
      name: data.name,
      scriptId: data.scriptId,
      templateVersion: script?.revision ?? null,
      trust: script?.trust ?? null,
      mode,
      stage,
      ...(data.marketIds ? { marketIds: data.marketIds } : {}),
    });
    return this.toView(row);
  }

  update(id: string, data: BotUpdateInput, by: Actor): IpcBot {
    const who = requireActor(by, ['human', 'agent'], 'bots.update');
    const actor = auditActorOf(who);
    const { botRepo, scriptRepo, tradeRepo, orderRepo, audit } = this.deps;
    // The agent may change a bot's config only (spec §7.3 update_bot_config): not its name, script,
    // wallet or enabled flag
    if (who.kind === 'agent') {
      const other = Object.entries(data)
        .filter(([k, v]) => k !== 'config' && v !== undefined)
        .map(([k]) => k);
      if (other.length > 0) {
        audit?.record(actor, 'bot.update', id, { fields: other }, 'denied: agent may change config only');
        throw new ServiceError('forbidden', `bots.update: the agent may change config only (not ${other.join(', ')})`);
      }
    }
    const before = botRepo.findById(id);
    if (!before) throw notFound('Bot not found');
    if (who.kind === 'agent') {
      this.refuseAgentOnRole(before, 'bot.update');
      this.requireAgentOwned(before, 'bot.update');
      // A strategy bot's new config must still match its template and stay within its market_ids (cached markets)
      if (data.config !== undefined) {
        this.checkAgentStrategyBot(
          scriptRepo.findById(before.script_id),
          data.config,
          parseMarketIds(before.market_ids),
          'bot.update',
          id,
          (t) => this.deps.cachedTokenMarketInfo?.(t) ?? null,
          (e) => this.deps.eventMarketIds?.cached(e) ?? null
        );
      }
    }
    if (data.walletId !== undefined && data.walletId !== before.wallet_id) {
      const blocked = walletChangeBlocker(id, tradeRepo, orderRepo);
      if (blocked) {
        audit?.record(actor, 'bot.update', id, { walletId: { from: before.wallet_id, to: data.walletId } }, `denied: ${blocked}`);
        throw conflict(blocked);
      }
    }
    const row = botRepo.update(id, data);
    if (!row) throw notFound('Bot not found');
    audit?.record(actor, 'bot.update', id, {
      fields: Object.keys(data),
      ...(data.scriptId !== undefined && data.scriptId !== before.script_id ? { scriptId: { from: before.script_id, to: data.scriptId } } : {}),
      ...(data.walletId !== undefined && data.walletId !== before.wallet_id ? { walletId: { from: before.wallet_id, to: data.walletId } } : {}),
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
    });
    // Switching to another script can only lower the stage (the new code must earn trust)
    if (data.scriptId !== undefined && data.scriptId !== before.script_id) {
      const script = scriptRepo.findById(data.scriptId);
      const from = (row.stage || 'full') as BotStage;
      const to = lowerStage(from, initialStage(script?.trust));
      if (to !== from) {
        botRepo.setStage(id, to);
        audit?.record('system', 'bot.stage', id, { from, to, reason: `script changed to ${data.scriptId} (trust ${script?.trust ?? 'unknown'})` });
      }
      botRepo.setTemplateVersion(id, script?.revision ?? null);
    }
    const fresh = botRepo.findById(id) ?? row;
    return this.toView(fresh);
  }

  async delete(id: string, by: Actor): Promise<void> {
    const who = requireActor(by, ['human', 'agent'], 'bots.delete');
    const actor = auditActorOf(who);
    const { botRepo, walletRepo, audit } = this.deps;
    // Check if the bot has a paper wallet that should be cleaned up
    const botRow = botRepo.findById(id);
    if (who.kind === 'agent') {
      if (!botRow) throw notFound('Bot not found');
      this.requireAgentOwned(botRow, 'bot.delete');
    }
    const paperWalletId = botRow?.wallet_id;
    const wallet = paperWalletId ? walletRepo.findById(paperWalletId) : undefined;
    const isPaperWallet = wallet?.is_paper === 1;

    const deleted = botRepo.delete(id);
    if (!deleted) throw conflict('Bot not found or cannot be deleted (must be stopped)');
    audit?.record(actor, 'bot.delete', id, { name: botRow?.name, scriptId: botRow?.script_id, stage: botRow?.stage });
    this.deps.activity?.forget(id);

    // Clean up auto-generated paper wallet
    if (isPaperWallet && paperWalletId) {
      await this.wallets().deletePaperWallet(paperWalletId);
    }
  }

  async start(id: string, by: Actor): Promise<void> {
    const who = requireActor(by, ['human', 'agent', 'system'], 'bots.start');
    if (who.kind === 'agent') {
      const row = this.deps.botRepo.findById(id);
      if (!row) throw notFound('Bot not found');
      this.refuseAgentOnRole(row, 'bot.start');
      this.requireAgentOwned(row, 'bot.start');
    }
    await this.manager().startBot(id, auditActorOf(who));
    this.deps.botRepo.setPausedBy?.(id, null);
  }

  async stop(id: string, by: Actor): Promise<void> {
    await this.manager().stopBot(id, auditActorOf(requireActor(by, ['human', 'agent', 'system'], 'bots.stop')));
  }

  /** Stop a bot and record who paused it (spec §7.3 pause_bot). Anyone may pause any bot (it reduces risk). */
  async pause(id: string, by: Actor): Promise<IpcBot> {
    const who = requireActor(by, ['human', 'agent', 'system'], 'bots.pause');
    if (!this.deps.botRepo.findById(id)) throw notFound('Bot not found');
    await this.manager().stopBot(id, auditActorOf(who));
    this.deps.botRepo.setPausedBy(id, who.kind);
    return this.get(id);
  }

  /**
   * Retire a bot (spec §2.1, §7.3 retire_bot): stops it, sets the terminal stage `retired` with the reason
   * and disables it. Only a human can un-retire (§4.6; there is no un-retire path in the app). The agent
   * may retire only bots it created.
   */
  async retire(id: string, reason: unknown, by: Actor): Promise<IpcBot> {
    const who = requireActor(by, ['human', 'agent'], 'bots.retire');
    const actor = auditActorOf(who);
    const { botRepo, audit } = this.deps;
    const why = typeof reason === 'string' ? reason.trim().slice(0, 1000) : '';
    if (!why) throw new ServiceError('invalid_input', 'reason is required');
    const row = botRepo.findById(id);
    if (!row) throw notFound('Bot not found');
    if (who.kind === 'agent') this.requireAgentOwned(row, 'bot.retire');
    if (row.stage === 'retired') throw conflict('Bot is already retired');
    if (row.status !== 'stopped') await this.manager().stopBot(id, actor);
    botRepo.retire(id, why);
    botRepo.setPausedBy(id, null);
    audit?.record(actor, 'bot.stage', id, { from: row.stage, to: 'retired', reason: why });
    return this.get(id);
  }

  /**
   * A bot retiring itself (ctx.requestRetire, 5b): only ever this bot, only towards `retired` (less risk), so no
   * transport actor is involved — BotManager forwards the request of the running script, audited as `bot:<id>`.
   * Not exposed on HTTP / MCP. Returns false when the bot is gone or already retired.
   */
  async retireByBot(id: string, reason: string): Promise<boolean> {
    const { botRepo, audit } = this.deps;
    const row = botRepo.findById(id);
    if (!row || row.stage === 'retired') return false;
    const why = `self: ${String(reason).trim().slice(0, 500) || 'no reason given'}`;
    try {
      if (row.status !== 'stopped') await this.manager().stopBot(id, `bot:${id}`);
    } catch (err) {
      logger.warning(`[BotService] Stopping bot ${id} for its retire request failed: ${err instanceof Error ? err.message : err}`);
    }
    botRepo.retire(id, why);
    botRepo.setPausedBy(id, null);
    audit?.record(`bot:${id}`, 'bot.stage', id, { from: row.stage, to: 'retired', reason: why });
    return true;
  }

  /** Restart (starts a stopped bot too): the agent needs ownership exactly as for start (R134) */
  async restart(id: string, by: Actor): Promise<void> {
    const who = requireActor(by, ['human', 'agent', 'system'], 'bots.restart');
    if (who.kind === 'agent') {
      const row = this.deps.botRepo.findById(id);
      if (!row) throw notFound('Bot not found');
      this.refuseAgentOnRole(row, 'bot.restart');
      this.requireAgentOwned(row, 'bot.restart');
    }
    await this.manager().restartBot(id, auditActorOf(who));
  }

  /** Open positions from order-linked fills (paper and/or live), optionally one bot / market (spec §7.3 get_positions) */
  riskPositions(filter: { botId?: string; marketId?: string; simulated?: boolean } = {}): RiskPositionView[] {
    const { botRepo, tradeRepo } = this.deps;
    const modes = filter.simulated === undefined ? [false, true] : [filter.simulated];
    const names = new Map<string, string | null>();
    const nameOf = (id: string) => {
      if (!names.has(id)) names.set(id, botRepo.findById(id)?.name ?? null);
      return names.get(id) ?? null;
    };
    return modes.flatMap((simulated) =>
      tradeRepo
        .getRiskPositions({ simulated, ...(filter.botId ? { botId: filter.botId } : {}) })
        .map((p) => {
          const info = p.exchange === 'polymarket' ? (this.deps.describeToken?.(p.symbol) ?? null) : null;
          return {
            botId: p.bot_id,
            botName: nameOf(p.bot_id),
            exchange: p.exchange,
            symbol: p.symbol,
            marketId: p.condition_id ?? info?.marketId ?? null,
            question: info?.question ?? null,
            outcome: info?.outcome ?? null,
            netQuantity: p.net_quantity,
            costBasisUsd: p.cost_basis,
            simulated,
          };
        })
        .filter((p) => !filter.marketId || p.marketId === filter.marketId)
    );
  }

  /** Open orders (paper and/or live), optionally one bot / market (spec §7.3 get_open_orders) */
  openOrders(filter: { botId?: string; marketId?: string; simulated?: boolean } = {}): Array<BotOrderView & { botId: string }> {
    const { orderRepo } = this.deps;
    if (!orderRepo) return [];
    const modes = filter.simulated === undefined ? [false, true] : [filter.simulated];
    return modes.flatMap((simulated) =>
      orderRepo
        .findOpen(filter.botId, simulated)
        .filter((o) => !filter.marketId || o.market_id === filter.marketId)
        .map((o) => ({ botId: o.bot_id, ...orderRowToView(o) }))
    );
  }

  /** Trades (fills) newest first, optionally one bot / market (spec §7.3 get_trades) */
  recentTrades(filter: { botId?: string; marketId?: string; hours?: number; limit?: number } = {}): IpcBotTrade[] {
    const { tradeRepo } = this.deps;
    const hours = filter.hours && filter.hours > 0 ? filter.hours : 24 * 7;
    const rows = filter.botId ? tradeRepo.findByBotId(filter.botId, { hoursAgo: hours }) : tradeRepo.findRecent(hours);
    const limit = clampLimit(filter.limit, 500);
    return rows
      .filter((r) => !filter.marketId || (r as { condition_id?: string | null }).condition_id === filter.marketId)
      .slice(0, limit)
      .map(tradeRowToIpc);
  }

  /** Recent log lines of a bot, oldest first (the last 500 kept in memory since the server started) */
  logs(botId: string, limit?: number): BotLogLine[] {
    if (!this.deps.botRepo.findById(botId)) throw notFound('Bot not found');
    return this.deps.activity?.getLogs(botId, clampLimit(limit, DEFAULT_MAX_LOG_LINES)) ?? [];
  }

  /** Recent custom events (ctx.emit) of a bot, oldest first */
  events(botId: string, limit?: number): BotCustomEvent[] {
    if (!this.deps.botRepo.findById(botId)) throw notFound('Bot not found');
    return this.deps.activity?.getEvents(botId, clampLimit(limit, DEFAULT_MAX_EVENTS)) ?? [];
  }

  /** A bot's order attempts, newest first, including risk rejections with the failed check (spec §12 Bot detail) */
  orders(botId: string, limit?: number): BotOrderView[] {
    const { botRepo, orderRepo } = this.deps;
    if (!botRepo.findById(botId)) throw notFound('Bot not found');
    if (!orderRepo) return [];
    const n = Math.min(Math.max(Math.floor(limit ?? 200), 1), 1000);
    return orderRepo.findByBot(botId, n).map(orderRowToView);
  }

  /** A bot's trades; resolves missing market names from the Polymarket API and backfills the database */
  async trades(botId: string, hours?: number | null): Promise<IpcBotTrade[]> {
    const { tradeRepo } = this.deps;
    const rows = tradeRepo.findByBotId(botId, hours ? { hoursAgo: hours } : undefined);
    const trades = rows.map(tradeRowToIpc);

    // Resolve missing market names for polymarket trades
    const unresolvedSymbols = new Set<string>();
    for (const trade of trades) {
      if (!trade.market && trade.exchange === 'polymarket' && trade.symbol) {
        unresolvedSymbols.add(trade.symbol);
      }
    }

    // Resolve each unique symbol once, then apply to all trades
    const resolved = new Map<string, { market: string; outcome: string }>();
    for (const symbol of unresolvedSymbols) {
      try {
        const info = await resolveTokenInfo(symbol);
        if (info && info.market) {
          resolved.set(symbol, info);
          // Backfill database
          tradeRepo.updateMarketInfo(symbol, info.market, info.outcome);
        }
      } catch {
        /* ignore */
      }
    }

    // Apply resolved info to trades
    for (const trade of trades) {
      if (!trade.market && trade.symbol && resolved.has(trade.symbol)) {
        const info = resolved.get(trade.symbol)!;
        trade.market = info.market;
        trade.outcome = info.outcome;
      }
    }

    return trades;
  }

  /** Recent trades of all bots (default 24 h) */
  allTrades(hours?: number | null): IpcBotTrade[] {
    const rows = this.deps.tradeRepo.findRecent(hours || 24);
    return rows.map(tradeRowToIpc);
  }

  /**
   * A bot's positions. Live mode: fetched from the Polymarket Data API (source of truth).
   * Paper mode: computed from trade history + Gamma API prices.
   */
  async positions(botId: string): Promise<BotPositionView[]> {
    const { botRepo, walletRepo, tradeRepo } = this.deps;
    const botRow = botRepo.findById(botId);
    if (!botRow) throw notFound('Bot not found');

    const mode = (botRow.mode as 'live' | 'paper') || 'live';

    if (mode === 'live') {
      // Live mode: fetch real positions from Polymarket Data API
      const wallet = walletRepo.findById(botRow.wallet_id);
      if (!wallet) return [];

      const address = wallet.proxy_address || wallet.address;
      const livePositions = await fetchLivePositions(address);

      return livePositions.map((p) => ({
        symbol: p.asset,
        exchange: 'polymarket' as const,
        market: p.title || null,
        outcome: p.outcome || null,
        netQuantity: p.size,
        totalCost: p.initialValue,
        tradeCount: 0,
        currentPrice: p.curPrice,
        currentValue: p.currentValue,
      }));
    }

    // Paper mode: compute from trade history (existing logic)
    const rawPositions = tradeRepo.getPositions(botId);
    const positions: BotPositionView[] = [];
    for (const pos of rawPositions) {
      let currentPrice: number | null = null;

      if (pos.exchange === 'polymarket' && pos.symbol) {
        if (!pos.market) {
          try {
            const info = await resolveTokenInfo(pos.symbol);
            if (info && info.market) {
              pos.market = info.market;
              pos.outcome = info.outcome;
              tradeRepo.updateMarketInfo(pos.symbol, info.market, info.outcome);
            }
          } catch (err) {
            logger.error(`Failed to resolve token ${pos.symbol}: ${err}`);
          }
        }

        try {
          currentPrice = await fetchCurrentPrice(pos.symbol);
        } catch (err) {
          logger.error(`Failed to fetch price for ${pos.symbol}: ${err}`);
        }
      }

      const currentValue = currentPrice != null ? pos.netQuantity * currentPrice : null;
      positions.push({ ...pos, currentPrice, currentValue });
    }

    return positions;
  }

  /** Cash balance, positions value and P&L of one bot */
  async stats(botId: string): Promise<BotStatsView> {
    const { botRepo, walletRepo, tradeRepo, storageRepo, settingsRepo } = this.deps;
    const botRow = botRepo.findById(botId);
    if (!botRow) throw notFound('Bot not found');

    const config = JSON.parse(botRow.config || '{}');
    const mode = (botRow.mode as 'live' | 'paper') || 'live';
    let cashBalance = 0;
    let positionsValue = 0;
    let initialBalance: number | null = null;
    let pnlAllTime: number | null = null;

    if (mode === 'paper') {
      // Paper mode: read state from bot_storage
      const paperState = storageRepo.get(botId, '__paper_state') as {
        balance?: number;
        positions?: Array<{ tokenId: string; size: number; avgPrice: number }>;
        binanceBalances?: Record<string, number>;
      } | null;

      cashBalance = paperState?.balance ?? (config.paperBalance ? Number(config.paperBalance) : 0);
      initialBalance = config.paperBalance ? Number(config.paperBalance) : null;

      // Paper positions value from trade history + Gamma API prices
      const rawPositions = tradeRepo.getPositions(botId);
      for (const pos of rawPositions) {
        if (pos.exchange === 'polymarket' && pos.symbol) {
          try {
            const price = await fetchCurrentPrice(pos.symbol);
            if (price != null) {
              positionsValue += pos.netQuantity * price;
            }
          } catch {
            /* ignore */
          }
        }
      }

      const totalValue = cashBalance + positionsValue;
      pnlAllTime = initialBalance != null ? totalValue - initialBalance : null;
    } else {
      // Live mode: fetch real wallet USDC balance + Polymarket positions
      const wallet = walletRepo.findById(botRow.wallet_id);
      if (wallet) {
        const balanceAddress = wallet.proxy_address || wallet.address;

        // Cash balance from on-chain
        try {
          const settings = settingsRepo.get();
          const getMyBalanceMod = await import('../utils/getMyBalance');
          cashBalance = await getMyBalanceMod.default(balanceAddress, settings.rpc_url, settings.usdc_contract_address);
        } catch (err) {
          logger.error(`Failed to fetch live balance for bot ${botId}: ${err}`);
        }

        // Positions value from Polymarket Data API
        try {
          const livePositions = await fetchLivePositions(balanceAddress);
          positionsValue = livePositions.reduce((sum, p) => sum + (p.currentValue || 0), 0);
          // All-time P&L from Polymarket Data API
          const totalPnl = livePositions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
          pnlAllTime = totalPnl;
        } catch (err) {
          logger.error(`Failed to fetch live positions for stats: ${err}`);
        }
      }
    }

    const totalValue = cashBalance + positionsValue;
    const pnl24h = pnl24hFor(tradeRepo, botId);

    return {
      cashBalance,
      positionsValue,
      totalValue,
      initialBalance,
      pnlAllTime,
      pnl24h,
      mode,
    };
  }

  /** Dashboard stats for all bots: totalValue, positionCount and P&L per bot, fetched concurrently */
  async dashboardStats(): Promise<BotDashboardStat[]> {
    const { botRepo, walletRepo, tradeRepo, storageRepo, settingsRepo } = this.deps;
    const rows = botRepo.findAll({});
    const settings = settingsRepo.get();

    const results = await Promise.allSettled(
      rows.map(async (botRow) => {
        const mode = (botRow.mode as 'live' | 'paper') || 'live';
        let totalValue = 0;
        let positionCount = 0;
        let pnlAllTime: number | null = null;

        try {
          if (mode === 'paper') {
            const config = JSON.parse(botRow.config || '{}');
            const paperState = storageRepo.get(botRow.id, '__paper_state') as {
              balance?: number;
              positions?: Array<{ tokenId: string; size: number; avgPrice: number }>;
            } | null;

            const cashBalance = paperState?.balance ?? (config.paperBalance ? Number(config.paperBalance) : 0);
            const initialBalance = config.paperBalance ? Number(config.paperBalance) : null;
            let positionsValue = 0;

            const rawPositions = tradeRepo.getPositions(botRow.id);
            positionCount = rawPositions.length;

            // Fetch prices concurrently for paper positions
            const priceResults = await Promise.allSettled(
              rawPositions
                .filter((p) => p.exchange === 'polymarket' && p.symbol)
                .map(async (pos) => {
                  const price = await fetchCurrentPrice(pos.symbol);
                  return { netQuantity: pos.netQuantity, price };
                })
            );
            for (const pr of priceResults) {
              if (pr.status === 'fulfilled' && pr.value.price != null) {
                positionsValue += pr.value.netQuantity * pr.value.price;
              }
            }

            totalValue = cashBalance + positionsValue;
            pnlAllTime = initialBalance != null ? totalValue - initialBalance : null;
          } else {
            // Live mode
            const wallet = walletRepo.findById(botRow.wallet_id);
            if (wallet) {
              const balanceAddress = wallet.proxy_address || wallet.address;
              let cashBalance = 0;

              try {
                const getMyBalanceMod = await import('../utils/getMyBalance');
                cashBalance = await getMyBalanceMod.default(balanceAddress, settings.rpc_url, settings.usdc_contract_address);
              } catch {
                /* ignore */
              }

              let positionsValue = 0;
              try {
                const livePositions = await fetchLivePositions(balanceAddress);
                positionCount = livePositions.length;
                positionsValue = livePositions.reduce((sum, p) => sum + (p.currentValue || 0), 0);
                pnlAllTime = livePositions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
              } catch {
                /* ignore */
              }

              totalValue = cashBalance + positionsValue;
            }
          }
        } catch (err) {
          logger.error(`Dashboard stats error for bot ${botRow.id}: ${err}`);
        }

        // 24h P&L: realized trades in last 24 hours
        let pnl24h = 0;
        try {
          pnl24h = pnl24hFor(tradeRepo, botRow.id);
        } catch {
          /* ignore */
        }

        return {
          botId: botRow.id,
          totalValue,
          positionCount,
          pnlAllTime,
          pnl24h,
        };
      })
    );

    return results.filter((r): r is PromiseFulfilledResult<BotDashboardStat> => r.status === 'fulfilled').map((r) => r.value);
  }
}
