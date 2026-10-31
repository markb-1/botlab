import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
// Side effect: CLOB credentials never reach clob-client's error logs (registered before any call)
import '../exchange/polymarket/redactCredentials';
import { SignatureType } from '@polymarket/order-utils';
import type {
  BotStatus,
  BotRecord,
  BotSummary,
  BotEvent,
  BotHealthInfo,
} from './types';
import type { BaseBotRunner } from './BaseBotRunner';
import type { WalletManager } from './WalletManager';
import type { BotRepository } from '../db/repositories/BotRepository';
import type { WalletRepository } from '../db/repositories/WalletRepository';
import type { SettingsRepository } from '../db/repositories/SettingsRepository';
import type { ScriptRepository } from '../db/repositories/ScriptRepository';
import type { BotStorageRepository } from '../db/repositories/BotStorageRepository';
import type { BotTradeRepository } from '../db/repositories/BotTradeRepository';
import { ScriptBotRunner, DEFAULT_PAPER_BALANCE, type OrderServiceFactory } from '../runtime/ScriptBotRunner';
import { PaperTradingState } from '../runtime/PaperTradingState';
import { builtinRoleOf, isStandingRole, type BuiltinRole } from '../db/repositories/ScriptRepository';
import type { PositionExitFlagRepository } from '../db/repositories/AgentRepository';
import { PortfolioService, type ExitOrderService } from '../orders/PortfolioService';
import type { BotPushEventName, MandateSummary } from '../sdk/types';
import type { CopyLeaderService } from '../services/CopyLeaderService';
import type { Database } from '../db/index';
import type { OrderRepository } from '../db/repositories/OrderRepository';
import type { RiskStateRepository } from '../db/repositories/RiskStateRepository';
import { loadConfig, resolveConfigDir } from '../config';
import { RiskEngine } from '../risk/RiskEngine';
import { FeeService, loadFees } from '../orders/FeeService';
import { MarketDataService, unassessedQualityProvider } from '../orders/MarketDataService';
import { defaultCategories } from '../config/categoriesSchema';
import type { MarketCacheService } from '../ledger/MarketCacheService';
import type { LedgerService } from '../ledger/LedgerService';
import { DbRiskStateProvider } from '../orders/DbRiskStateProvider';
import { OrderService, type ClobBook, type ClockSkewGuard } from '../orders/OrderService';
import { createBinanceAdapter, createPolymarketAdapter } from '../orders/ExchangeAdapter';
import type { BinanceAdapter, PolymarketAdapter } from '../orders/ExchangeAdapter';
import type { AuditActor, AuditService } from '../audit/AuditService';
import { GLOBAL_SCOPE } from '../db/repositories/RiskStateRepository';
import type { LimitsConfig, AppConfig } from '../config';
import type { OrderEventSink } from '../notify/events';
import type { ConfigService } from '../config/ConfigService';
import { getBalance } from '../exchange/polymarket/trading';
import type { MarketView } from '../ledger/MarketCacheService';
import type { ExitPolicy } from '../sdk/types';
import { POSITION_MANAGER_AMBIGUITY_EXIT, POSITION_MANAGER_EXIT_WINDOW_FALLBACK } from '../runtime/RpcHandler';

/** Emitted (with { botId, reason }) when a script calls ctx.requestRetire; the core retires the bot (5b) */
export const BOT_RETIRE_REQUEST_EVENT = 'bot:retire-request';

/** bots.market_ids JSON → list (null = unscoped; unreadable = no market) */
export function parseMarketIdList(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** ctx.polymarket.getMarket backend: a condition id (0x…) or a token id; a failed refresh falls back to the cache */
function marketLookup(cache: MarketCacheService): (idOrTokenId: string) => Promise<MarketView | null> {
  return async (id) => {
    const byId = /^0x[0-9a-fA-F]+$/.test(id);
    try {
      return byId ? await cache.getMarket(id) : await cache.getMarketByToken(id);
    } catch {
      return byId ? cache.getCached(id) : cache.getCachedByToken(id);
    }
  };
}
import { getBinanceBalance, getBinanceOrderBook } from '../exchange/binance/client';
import { decrypt } from '../security/crypto';
import { keyManager } from '../security/keyManager';
import logger from '../utils/logger';

/** Order store for OrderService (orders + halts). */
export interface BotManagerOrderDeps {
  db: Database.Database;
  orderRepo: OrderRepository;
  riskStateRepo: RiskStateRepository;
  audit?: AuditService;
  /** Live config (hot reload). Without it the config is read once in initialize(). */
  config?: ConfigService;
  /** Fill / rejection notifications (Telegram) */
  events?: OrderEventSink;
  /** Market cache: category, ambiguity, rules change. Without it every buy is rejected (ambiguity unknown). */
  marketCache?: MarketCacheService;
  /** Forecast ledger: forecasts and category rights for ledger-driven orders, ctx.ledger reads */
  ledger?: LedgerService;
  /** Clock skew guard (Reconciler): live orders are refused while the clock is off (spec §15) */
  clock?: ClockSkewGuard;
  /** position_exit_flags (R140): read and closed by the builtin position manager (ctx.portfolio) */
  exitFlags?: PositionExitFlagRepository;
  /** Copy-trading leaders (5c): ctx.copy and order attribution for the builtin Copy Trading template */
  copyLeaders?: Pick<CopyLeaderService, 'statusFor' | 'recordOrder' | 'holdings'>;
}

/**
 * BotManager orchestrates all bot instances.
 * Handles starting, stopping, and monitoring bots.
 */

/**
 * ctx.risk.getFlaggedTokens: open exit flags on any bot's position in ONE mode (filtered in SQL), latest per token,
 * without reasons or owners (they are another bot's business).
 */
export function flaggedTokensInMode(
  flags: Pick<PositionExitFlagRepository, 'listOpen'>,
  simulated: boolean
): Array<{ tokenId: string; marketId: string | null; flaggedAt: string }> {
  const byToken = new Map<string, { tokenId: string; marketId: string | null; flaggedAt: string }>();
  for (const f of flags.listOpen(simulated)) {
    const prev = byToken.get(f.token_id);
    if (!prev || f.created_at > prev.flaggedAt) byToken.set(f.token_id, { tokenId: f.token_id, marketId: f.market_id ?? prev?.marketId ?? null, flaggedAt: f.created_at });
  }
  return [...byToken.values()];
}

export class BotManager extends EventEmitter {
  private walletManager: WalletManager;
  private botRepo: BotRepository;
  private walletRepo: WalletRepository;
  private settingsRepo: SettingsRepository;
  private scriptRepo: ScriptRepository;
  private storageRepo: BotStorageRepository;
  private tradeRepo: BotTradeRepository;
  private instances: Map<string, BaseBotRunner> = new Map();
  private clobClients: Map<string, ClobClient> = new Map();
  private orderDeps: BotManagerOrderDeps | null;
  /** Created in initialize(), updated in place on config changes. null ⇒ every order fails. */
  private riskEngine: RiskEngine | null = null;
  private fees: FeeService | null = null;
  private configError: string | null = 'not loaded';
  private unsubscribeConfig: (() => void) | null = null;
  private marketData = new MarketDataService();
  /** Running bots' OrderServices (used to cancel their orders on a halt) */
  private orderServices: Map<string, { service: OrderService; simulated: boolean }> = new Map();
  /** Startup orphan-order recovery running: bots may not start until it finishes */
  private recoveryInProgress = false;
  /** Running bots on standing builtin templates: one per role and mode (spec §9.1, §9.2) */
  private roles: Map<string, { role: BuiltinRole; mode: 'live' | 'paper' }> = new Map();
  /** ctx.portfolio backend (builtin position manager only) */
  private portfolio: PortfolioService | null = null;

  constructor(
    walletManager: WalletManager,
    botRepo: BotRepository,
    walletRepo: WalletRepository,
    settingsRepo: SettingsRepository,
    scriptRepo: ScriptRepository,
    storageRepo: BotStorageRepository,
    tradeRepo: BotTradeRepository,
    orderDeps?: BotManagerOrderDeps
  ) {
    super();
    this.orderDeps = orderDeps ?? null;
    this.walletManager = walletManager;
    this.botRepo = botRepo;
    this.walletRepo = walletRepo;
    this.settingsRepo = settingsRepo;
    this.scriptRepo = scriptRepo;
    this.storageRepo = storageRepo;
    this.tradeRepo = tradeRepo;
  }

  /**
   * Initialize the bot manager
   */
  async initialize(): Promise<void> {
    // Risk config (limits/mandate) and fee table. A bad file disables all orders (fail closed)
    // rather than falling back to defaults the human did not choose. With a ConfigService the
    // engine and fee table are updated in place on every valid change (spec §3); an invalid edit
    // keeps the previous config.
    const config = this.orderDeps?.config;
    if (config) {
      const initial = config.getConfig();
      if (initial) this.applyConfig(initial);
      else this.configError = config.getLastError() ?? 'not loaded';
      if (!initial) logger.error(`Risk config failed to load; bots cannot be started: ${this.configError}`);
      this.unsubscribeConfig = config.onChange((e) => {
        this.applyConfig(e.after);
        logger.info('Risk config updated');
      });
    } else {
      try {
        const dir = resolveConfigDir();
        this.applyConfig({ ...loadConfig(dir), fees: loadFees(dir) });
        logger.info(`Risk config loaded from ${dir}`);
        this.orderDeps?.audit?.record('system', 'config.load', dir, { files: ['limits.yaml', 'mandate.yaml', 'fees.yaml'] }, 'ok');
      } catch (err) {
        this.riskEngine = null;
        this.fees = null;
        this.configError = err instanceof Error ? err.message : String(err);
        logger.error(`Risk config failed to load; bots cannot be started: ${this.configError}`);
        this.orderDeps?.audit?.record('system', 'config.load', resolveConfigDir(), { error: this.configError }, 'error');
      }
    }
    this.warnUnlinkedPositions();
    logger.info('BotManager initialized');
  }

  /** Install a validated config: the shared RiskEngine / FeeService objects are updated in place, so running bots' OrderServices see it at once. */
  private applyConfig(config: Pick<AppConfig, 'limits' | 'mandate' | 'fees'>): void {
    const risk = { limits: config.limits, mandate: config.mandate };
    if (this.riskEngine) this.riskEngine.setConfig(risk);
    else this.riskEngine = new RiskEngine(risk);
    if (this.fees) this.fees.setConfig(config.fees);
    else this.fees = new FeeService(config.fees);
    this.configError = null;
  }

  /**
   * Live positions recorded before OrderService (no order-linked fills) are invisible to the
   * risk engine: not counted as exposure and not sellable by bots. Say so at startup.
   */
  private warnUnlinkedPositions(): void {
    try {
      const rows = this.tradeRepo.findUnlinkedLivePositions();
      if (rows.length === 0) return;
      const byBot = new Map<string, string[]>();
      for (const r of rows) {
        const key = `${r.bot_name ?? r.bot_id} (${r.bot_id})`;
        byBot.set(key, [...(byBot.get(key) ?? []), `${r.exchange}:${r.symbol} ${r.net_quantity}`]);
      }
      logger.warning(
        `Live positions without order-linked fills are ignored by the risk engine (not counted as exposure, ` +
          `not sellable by bots; close them manually): ` +
          [...byBot].map(([bot, pos]) => `${bot}: ${pos.join(', ')}`).join('; ')
      );
    } catch (err) {
      logger.error(`Could not check for unlinked positions: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Builds a bot's OrderService: the risk-checked route for all its orders.
   * Throws (so the bot does not start) when the risk config or order store is unavailable.
   */
  private createOrderService: OrderServiceFactory = (args) => {
    const service = this.buildOrderService(args);
    this.orderServices.set(args.botId, { service, simulated: args.mode === 'paper' });
    return service;
  };

  private buildOrderService(args: Parameters<OrderServiceFactory>[0]): OrderService {
    if (!this.orderDeps) throw new Error('Order store not configured; orders are disabled');
    if (!this.riskEngine || !this.fees) throw new Error(`Risk config not loaded: ${this.configError}`);

    const { db, orderRepo, riskStateRepo } = this.orderDeps;
    const settings = this.getSettings();
    const binanceCreds =
      settings.binanceApiKey && settings.binanceApiSecret
        ? { apiKey: settings.binanceApiKey, apiSecret: settings.binanceApiSecret }
        : null;
    const paper = args.mode === 'paper';
    const ps = args.paperState;
    if (paper && !ps) throw new Error('Paper bot without paper trading state');

    const provider = new DbRiskStateProvider({
      botRepo: this.botRepo,
      getScriptTrust: (scriptId) => this.scriptRepo.findById(scriptId)?.trust ?? null,
      orderRepo,
      tradeRepo: this.tradeRepo,
      riskStateRepo,
      simulated: paper,
      // Equity cash: paper balance, or the bot's Polymarket wallet USDC + Binance USDT (if configured)
      getCashUsd: paper
        ? async (exchange) => (exchange === 'binance' ? ps!.getBinanceBalance('USDT') : ps!.getBalance())
        : async () => {
            let cash = await getBalance(args.proxyAddress || args.walletAddress, settings.rpcUrl, settings.usdcContractAddress);
            if (binanceCreds) cash += await getBinanceBalance(binanceCreds, 'USDT');
            return cash;
          },
      getEndDate: async (tokenId) => (await this.marketData.getMarketInfo(tokenId))?.endDate ?? null,
      categoryRights: this.orderDeps.ledger,
      getPaperPositionSize: paper
        ? (exchange, tokenId) => {
            if (exchange === 'binance') {
              const base = tokenId.toUpperCase().replace(/(USDT|USDC|FDUSD)$/, '');
              return ps!.getBinanceBalance(base) || null;
            }
            return ps!.getPositions().find((p) => p.tokenId === tokenId)?.size ?? null;
          }
        : undefined,
    });

    const service = new OrderService(
      {
        db,
        orderRepo,
        tradeRepo: this.tradeRepo,
        audit: this.orderDeps.audit,
        events: this.orderDeps.events,
        riskEngine: this.riskEngine,
        provider,
        fees: this.fees,
        marketData: this.marketData,
        quality: this.orderDeps.marketCache ?? unassessedQualityProvider(() => this.orderDeps?.config?.getConfig()?.categories ?? defaultCategories()),
        forecasts: this.orderDeps.ledger,
        getBook: (tokenId) => args.clobClient.getOrderBook(tokenId) as Promise<ClobBook>,
        getBinanceBook: (symbol) => getBinanceOrderBook(symbol),
        clock: this.orderDeps.clock,
      },
      {
        botId: args.botId,
        botName: args.botName,
        scriptName: args.scriptName,
        mode: args.mode,
        polymarket: paper ? null : createPolymarketAdapter(args.clobClient),
        binance: paper || !binanceCreds ? null : createBinanceAdapter(binanceCreds),
        paperState: ps ?? null,
      }
    );
    return service;
  }

  /**
   * The OrderService a position-manager exit is placed through: the owning bot's running service in this
   * mode, else a transient one for that bot built the same way (its wallet's client; in paper, its paper
   * state loaded from storage). Not registered as running. Throws if the bot or its wallet is unavailable.
   */
  async getExitOrderService(botId: string, simulated: boolean): Promise<ExitOrderService> {
    const running = this.getRunningOrderService(botId, simulated);
    if (running) return running;
    const row = this.botRepo.findById(botId);
    if (!row) throw new Error(`Bot not found: ${botId}`);
    const creds = await this.walletManager.getWallet(row.wallet_id);
    const clobClient = await this.getClobClient(creds, simulated);
    let paperState: PaperTradingState | undefined;
    if (simulated) {
      let balance = DEFAULT_PAPER_BALANCE;
      try {
        const cfg = JSON.parse(row.config || '{}') as { paperBalance?: unknown };
        if (typeof cfg.paperBalance === 'number' && cfg.paperBalance > 0) balance = cfg.paperBalance;
      } catch {
        /* default */
      }
      paperState = new PaperTradingState(botId, balance, this.storageRepo);
      paperState.load();
    }
    const script = this.scriptRepo.findById(row.script_id);
    return this.buildOrderService({
      botId,
      botName: row.name,
      scriptName: script?.name ?? 'script',
      mode: simulated ? 'paper' : 'live',
      clobClient,
      walletAddress: creds.address,
      proxyAddress: creds.proxyAddress,
      paperState,
    });
  }

  private getPortfolio(): PortfolioService {
    if (!this.orderDeps?.exitFlags) throw new Error('Exit flags store not configured');
    if (!this.portfolio) {
      this.portfolio = new PortfolioService({
        botRepo: this.botRepo,
        tradeRepo: this.tradeRepo,
        orderRepo: this.orderDeps.orderRepo,
        flagRepo: this.orderDeps.exitFlags,
        ledger: this.orderDeps.ledger,
        markets: this.orderDeps.marketCache,
        audit: this.orderDeps.audit,
        getExitService: (botId, simulated) => this.getExitOrderService(botId, simulated),
        // The running forecast executor's last unfunded demand (spec §9.2 "a better use of capital is queued")
        capitalDemand: (simulated) => {
          for (const [id, r] of this.roles) {
            if (r.role === 'forecast-executor' && r.mode === (simulated ? 'paper' : 'live') && this.instances.has(id)) {
              return this.storageRepo.get(id, 'executor:demand');
            }
          }
          return null;
        },
      });
    }
    return this.portfolio;
  }

  /**
   * The Position Manager's exit thresholds for bots in this mode (ctx.risk.getExitPolicy, 5b review): the largest
   * `exit_before_end_minutes` among non-retired Position Manager bots of the mode (any mode if none), else the
   * template's configSchema default; the ambiguity threshold is the one the template reads from here too.
   */
  getExitPolicy(simulated: boolean): ExitPolicy {
    const pmBots: Array<{ config: string; paper: boolean }> = [];
    let schemaDefault: number | null = null;
    for (const b of this.botRepo.findAll()) {
      if (b.stage === 'retired') continue;
      const script = this.scriptRepo.findById(b.script_id);
      if (builtinRoleOf(script) !== 'position-manager') continue;
      pmBots.push({ config: b.config, paper: b.mode === 'paper' || b.stage === 'paper' });
    }
    const windowOf = (raw: string): number | null => {
      try {
        const v = (JSON.parse(raw || '{}') as Record<string, unknown>).exit_before_end_minutes;
        const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
        return Number.isFinite(n) && n >= 0 ? n : null;
      } catch {
        return null;
      }
    };
    const sameMode = pmBots.filter((b) => b.paper === simulated);
    const windows = (sameMode.length ? sameMode : pmBots).map((b) => windowOf(b.config));
    // A PM bot without its own value uses the template default
    const pmScript = this.scriptRepo.findAll().find((s) => builtinRoleOf(s) === 'position-manager');
    if (pmScript) {
      try {
        const d = (JSON.parse(pmScript.config_schema || '{}') as { properties?: Record<string, { default?: unknown }> }).properties?.exit_before_end_minutes?.default;
        if (typeof d === 'number' && Number.isFinite(d)) schemaDefault = d;
      } catch {
        /* no default */
      }
    }
    const base = schemaDefault ?? POSITION_MANAGER_EXIT_WINDOW_FALLBACK;
    if (windows.length === 0) return { exitBeforeEndMinutes: base, ambiguityExitScore: POSITION_MANAGER_AMBIGUITY_EXIT, source: 'template-default' };
    return {
      exitBeforeEndMinutes: Math.max(...windows.map((w) => w ?? base)),
      ambiguityExitScore: POSITION_MANAGER_AMBIGUITY_EXIT,
      source: 'position-manager',
    };
  }

  /** ctx.events (spec §5.2): push an event to every running script bot. Never throws. */
  broadcastScriptEvent(name: BotPushEventName, data: Record<string, unknown>): void {
    for (const [id, instance] of this.instances) {
      if (!(instance instanceof ScriptBotRunner)) continue;
      try {
        instance.pushEvent(name, data);
      } catch (err) {
        logger.warning(`Could not push ${name} to bot ${id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** Standing role of a running bot (executor / position manager), if any. */
  getRunningRole(botId: string): BuiltinRole | null {
    return this.instances.has(botId) ? (this.roles.get(botId)?.role ?? null) : null;
  }

  /** Limits currently in force; null when the config failed to load. */
  /** The mandate's market filters as bots see them (ctx.risk.getMandateSummary); null when the config is invalid */
  getMandateSummary(): MandateSummary | null {
    const cfg = this.riskEngine?.getConfig();
    if (!cfg) return null;
    const { mandate, limits } = cfg;
    return {
      categoriesAllow: [...mandate.categories.allow],
      resolvesWithinDays: [mandate.markets.resolves_within_days[0], mandate.markets.resolves_within_days[1]],
      longHorizonDays: [mandate.markets.long_horizon_days[0], mandate.markets.long_horizon_days[1]],
      minLiquidityUsd: Math.max(mandate.markets.min_liquidity_usd, limits.per_market.min_liquidity_usd),
      maxAmbiguityScore: mandate.markets.max_ambiguity_score,
      strategiesAllow: [...mandate.strategies.allow],
    };
  }

  getLimits(): LimitsConfig | null {
    return this.riskEngine?.getConfig().limits ?? null;
  }

  /** Why the bot may not run (bot or global halt), or null. */
  private haltReason(botId: string): string | null {
    const riskState = this.orderDeps?.riskStateRepo;
    if (!riskState) return null;
    const global = riskState.get(GLOBAL_SCOPE);
    if (global?.halted === 1) {
      return `Global halt active (${global.halted_reason ?? 'no reason'}); a human must clear it first`;
    }
    const own = riskState.get(botId);
    if (own?.halted === 1) {
      return `Bot is halted (${own.halted_reason ?? 'no reason'}); a human must clear the halt first`;
    }
    return null;
  }

  setRecoveryInProgress(inProgress: boolean): void {
    this.recoveryInProgress = inProgress;
  }

  isRunning(botId: string): boolean {
    return this.instances.has(botId);
  }

  runningBotIds(): string[] {
    return [...this.instances.keys()];
  }

  /** The running bot's OrderService if it trades in this mode. */
  getRunningOrderService(botId: string, simulated: boolean): OrderService | null {
    const entry = this.instances.has(botId) ? this.orderServices.get(botId) : undefined;
    return entry && entry.simulated === simulated ? entry.service : null;
  }

  /** Authenticated Polymarket adapter for a bot's wallet (to cancel orders of a bot that is not running). */
  async getPolymarketAdapterForBot(botId: string): Promise<PolymarketAdapter | null> {
    const row = this.botRepo.findById(botId);
    if (!row) return null;
    const creds = await this.walletManager.getWallet(row.wallet_id);
    return createPolymarketAdapter(await this.getClobClient(creds, false));
  }

  /** Authenticated Polymarket adapter for a wallet (Reconciler: orders/trades lookups, any bot). */
  async getPolymarketAdapterForWallet(walletId: string): Promise<PolymarketAdapter | null> {
    const creds = await this.walletManager.getWallet(walletId);
    return createPolymarketAdapter(await this.getClobClient(creds, false));
  }

  /** Binance adapter with the configured credentials; null when none are set. */
  getBinanceAdapter(): BinanceAdapter | null {
    const s = this.getSettings();
    return s.binanceApiKey && s.binanceApiSecret ? createBinanceAdapter({ apiKey: s.binanceApiKey, apiSecret: s.binanceApiSecret }) : null;
  }

  /** CLOB client per wallet; paper clients are unauthenticated and cached separately. */
  private async getClobClient(
    creds: { address: string; privateKey: string; proxyAddress?: string },
    paper: boolean
  ): Promise<ClobClient> {
    const cacheKey = `${paper ? 'paper' : 'live'}:${creds.proxyAddress || creds.address}`;
    let clobClient = this.clobClients.get(cacheKey);
    if (clobClient) return clobClient;
    if (paper) {
      // Read-only endpoints (orderbook, prices) work without auth; trades are simulated.
      const settings = this.getSettings();
      clobClient = new ClobClient(settings.clobHttpUrl, 137, new ethers.Wallet(creds.privateKey));
    } else {
      clobClient = await this.createClobClientForWallet(creds.address, creds.privateKey, creds.proxyAddress);
    }
    this.clobClients.set(cacheKey, clobClient);
    return clobClient;
  }

  /**
   * Get current settings from database
   */
  getSettings(): {
    rpcUrl: string;
    clobHttpUrl: string;
    clobWsUrl: string;
    usdcContractAddress: string;
    binanceApiKey?: string;
    binanceApiSecret?: string;
  } {
    const settings = this.settingsRepo.get();
    const result: ReturnType<BotManager['getSettings']> = {
      rpcUrl: settings.rpc_url,
      clobHttpUrl: settings.clob_http_url,
      clobWsUrl: settings.clob_ws_url,
      usdcContractAddress: settings.usdc_contract_address,
    };

    // Decrypt Binance credentials if available
    if (settings.binance_api_key_encrypted && settings.binance_api_secret_encrypted && keyManager.isReady()) {
      try {
        const encKey = keyManager.getKey();
        result.binanceApiKey = decrypt(settings.binance_api_key_encrypted, encKey);
        result.binanceApiSecret = decrypt(settings.binance_api_secret_encrypted, encKey);
      } catch {
        logger.error('Failed to decrypt Binance credentials');
      }
    }

    return result;
  }

  /**
   * Create a CLOB client for a specific wallet
   */
  private async createClobClientForWallet(
    walletAddress: string,
    privateKey: string,
    proxyAddress?: string
  ): Promise<ClobClient> {
    // Get settings from database
    const settings = this.getSettings();
    const clobHttpUrl = settings.clobHttpUrl;
    const rpcUrl = settings.rpcUrl;

    const chainId = 137;
    const wallet = new ethers.Wallet(privateKey);

    // Use proxy address if provided (Polymarket funds are in the proxy wallet)
    // Ensure empty strings are treated as undefined
    const funderAddress = proxyAddress && proxyAddress.trim() ? proxyAddress : undefined;

    // Check if the funder address (proxy) is a Gnosis Safe
    const isProxySafe = funderAddress
      ? await this.isGnosisSafe(funderAddress, rpcUrl)
      : false;
    const signatureType = isProxySafe
      ? SignatureType.POLY_GNOSIS_SAFE
      : SignatureType.EOA;

    if (funderAddress) {
      logger.info(
        `Proxy wallet ${funderAddress}: ${isProxySafe ? 'Gnosis Safe' : 'EOA'}`
      );
    } else {
      logger.info(`No proxy address configured, using EOA ${walletAddress}`);
    }

    let clobClient = new ClobClient(
      clobHttpUrl,
      chainId,
      wallet,
      undefined,
      signatureType,
      funderAddress
    );

    // Suppress console output during API key creation
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    console.log = function () {};
    console.error = function () {};

    try {
      let creds = await clobClient.createApiKey();
      if (!creds.key) {
        creds = await clobClient.deriveApiKey();
      }

      clobClient = new ClobClient(
        clobHttpUrl,
        chainId,
        wallet,
        creds,
        signatureType,
        funderAddress
      );
    } finally {
      console.log = originalConsoleLog;
      console.error = originalConsoleError;
    }

    return clobClient;
  }

  /**
   * Check if an address is a Gnosis Safe
   */
  private async isGnosisSafe(address: string, rpcUrl: string): Promise<boolean> {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      const code = await provider.getCode(address);
      return code !== '0x';
    } catch (error) {
      logger.error(`Error checking wallet type: ${error}`);
      return false;
    }
  }

  /**
   * Convert a database bot row to a BotRecord
   */
  private toBotRecord(row: { id: string; name: string; script_id: string; wallet_id: string; config: string; status: string; enabled: number; mode?: string; last_started_at: string | null; last_stopped_at: string | null; last_heartbeat: string | null; error_logs: string; created_at: string; updated_at: string }): BotRecord {
    return {
      id: row.id,
      name: row.name,
      scriptId: row.script_id,
      walletId: row.wallet_id,
      config: JSON.parse(row.config || '{}'),
      status: row.status as BotStatus,
      enabled: row.enabled === 1,
      mode: (row.mode as 'live' | 'paper') || 'live',
      lastStartedAt: row.last_started_at,
      lastStoppedAt: row.last_stopped_at,
      lastHeartbeat: row.last_heartbeat,
      errorLogs: JSON.parse(row.error_logs || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Start a specific bot by ID. Refused while halted (bot or global), during startup recovery,
   * or for a retired bot. A bot at stage `paper` runs in paper mode whatever its `mode` (§4.5).
   */
  async startBot(botId: string, actor: AuditActor = 'system'): Promise<void> {
    try {
      await this.startBotUnaudited(botId);
      this.orderDeps?.audit?.record(actor, 'bot.start', botId, undefined, 'ok');
    } catch (err) {
      this.orderDeps?.audit?.record(actor, 'bot.start', botId, undefined, `error: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }

  private async startBotUnaudited(botId: string): Promise<void> {
    const botRow = this.botRepo.findById(botId);
    if (!botRow) {
      throw new Error(`Bot not found: ${botId}`);
    }

    const bot = this.toBotRecord(botRow);

    if (!bot.enabled) {
      throw new Error(`Bot ${botId} is disabled`);
    }
    if (botRow.stage === 'retired') {
      throw new Error(`Bot ${botId} is retired`);
    }
    if (this.recoveryInProgress) {
      throw new Error('Startup recovery (orphan order cleanup) is still running; try again shortly');
    }
    const halted = this.haltReason(botId);
    if (halted) throw new Error(halted);

    // Check if already running
    const existingInstance = this.instances.get(botId);
    if (existingInstance && existingInstance.status === 'running') {
      logger.warning(`Bot ${botId} is already running`);
      return;
    }

    // Paper stage ⇒ paper trading regardless of the bot's mode
    const mode: 'live' | 'paper' = botRow.stage === 'paper' || bot.mode === 'paper' ? 'paper' : 'live';
    if (mode === 'paper' && bot.mode !== 'paper') {
      logger.info(`Bot ${bot.name} is at stage paper: running in paper mode`);
    }
    // Live trading is opt-in (limits.yaml live_trading.enabled; OrderService also rejects live orders)
    if (mode === 'live' && this.riskEngine && this.riskEngine.getConfig().limits.live_trading?.enabled !== true) {
      throw new Error('Live trading is disabled: set live_trading.enabled: true in limits.yaml, or run the bot in paper mode');
    }

    // Get wallet credentials and the CLOB client for this wallet
    const walletCredentials = await this.walletManager.getWallet(bot.walletId);
    const clobClient = await this.getClobClient(walletCredentials, mode === 'paper');

    // Look up the script
    const script = this.scriptRepo.findById(bot.scriptId);

    if (!script?.compiled) {
      throw new Error(
        `No compiled script found for "${script?.name || bot.scriptId}". ` +
        `Write and compile the script source first.`
      );
    }

    // Standing builtin templates (executor, position manager) run once per mode; the role comes from the
    // script row (origin builtin), never from the script itself
    const role = builtinRoleOf(script);
    if (isStandingRole(role)) {
      for (const [otherId, r] of this.roles) {
        if (otherId !== botId && r.role === role && r.mode === mode && this.instances.has(otherId)) {
          throw new Error(`A ${role} bot is already running in ${mode} mode (${this.botRepo.findById(otherId)?.name ?? otherId}); it is a single-instance template`);
        }
      }
    }

    const settings = this.getSettings();
    const instance: BaseBotRunner = new ScriptBotRunner({ ...bot, mode }, this.walletManager, clobClient, {
      compiledCode: script.compiled,
      scriptName: script.name,
      storageRepo: this.storageRepo,
      tradeRepo: this.tradeRepo,
      rpcUrl: settings.rpcUrl,
      usdcContractAddress: settings.usdcContractAddress,
      clobHttpUrl: settings.clobHttpUrl,
      mode,
      binanceApiKey: settings.binanceApiKey,
      binanceApiSecret: settings.binanceApiSecret,
      createOrderService: this.createOrderService,
      fetchAllowlist: () => this.getLimits()?.server.script_fetch_allowlist,
      ledger: this.orderDeps?.ledger,
      role,
      ...(role === 'position-manager' ? { createPortfolio: ({ botId: id, simulated }) => this.getPortfolio().forBot(id, simulated) } : {}),
      ...(this.orderDeps?.marketCache ? { getMarket: marketLookup(this.orderDeps.marketCache) } : {}),
      marketScope: () => parseMarketIdList(this.botRepo.findById(botId)?.market_ids),
      ...(this.orderDeps?.exitFlags
        ? {
            exitFlags: (simulated: boolean) =>
              this.orderDeps!.exitFlags!.list({ status: 'open', limit: 1000 })
                .filter((f) => f.bot_id === botId && (f.simulated === 1) === simulated)
                .map((f) => ({ id: f.id, tokenId: f.token_id, marketId: f.market_id, reason: f.reason, createdBy: f.created_by, createdAt: f.created_at })),
          }
        : {}),
      ...(this.orderDeps?.exitFlags
        ? {
            flaggedTokens: (simulated: boolean) => flaggedTokensInMode(this.orderDeps!.exitFlags!, simulated),
          }
        : {}),
      exitPolicy: (simulated: boolean) => this.getExitPolicy(simulated),
      ...(this.orderDeps?.marketCache ? { eventMarketIds: (eventId: string) => this.orderDeps!.marketCache!.getEventMarketIds(eventId) } : {}),
      mandateSummary: () => this.getMandateSummary(),
      // Copy Trading template only (role from the script row): leader status and order attribution, bound to this bot
      ...(role === 'copy' && this.orderDeps?.copyLeaders
        ? {
            copy: {
              getLeaders: (addresses: unknown) => this.orderDeps!.copyLeaders!.statusFor(botId, addresses),
              getHoldings: (tokenId: string, simulated: boolean) => this.orderDeps!.copyLeaders!.holdings(botId, tokenId, simulated),
              recordOrder: (orderId: string, info: Parameters<CopyLeaderService['recordOrder']>[2]) => this.orderDeps!.copyLeaders!.recordOrder(botId, orderId, info),
            },
          }
        : {}),
      // Retire runs after the RPC reply (it stops this very worker), via the core's BotService (audited as the bot)
      requestRetire: (reason: string) => {
        setImmediate(() => this.emit(BOT_RETIRE_REQUEST_EVENT, { botId, reason }));
      },
    });

    // Forward events
    instance.on('bot:event', (event: BotEvent) => {
      // Runtime errors block paper → probation promotion (§4.5)
      if (event.type === 'error') {
        try {
          this.botRepo.recordRuntimeError(botId);
        } catch {
          /* best effort */
        }
        if (event.data?.fatal) this.onBotFatal(botId, instance, event.data);
      }
      this.emit('bot:event', event);
    });

    // Update heartbeat in database when heartbeat events occur
    instance.on('bot:heartbeat', () => {
      this.updateHeartbeat(botId);
    });

    // A halt may have been set while the wallet/client were being prepared
    const haltedBefore = this.haltReason(botId);
    if (haltedBefore) throw new Error(haltedBefore);

    // Store instance
    this.instances.set(botId, instance);
    if (role) this.roles.set(botId, { role, mode });
    else this.roles.delete(botId);

    // Start the bot
    try {
      await instance.start();
    } catch (err) {
      this.instances.delete(botId);
      this.orderServices.delete(botId);
      throw err;
    }

    // ...or while the worker was starting (a halt's stop pass may have run before the instance existed)
    const haltedAfter = this.haltReason(botId);
    if (haltedAfter) {
      try {
        await instance.stop();
      } catch (err) {
        logger.error(`Could not stop bot ${botId} after a halt during start: ${err instanceof Error ? err.message : err}`);
      } finally {
        this.instances.delete(botId);
        this.orderServices.delete(botId);
        this.botRepo.update(botId, { status: 'stopped', lastStoppedAt: new Date().toISOString() });
      }
      this.orderDeps?.audit?.record('system', 'bot.stop', botId, { reason: `halted during start: ${haltedAfter}` }, 'ok');
      throw new Error(haltedAfter);
    }
    this.botRepo.recordRunDay(botId);

    // Update database
    this.botRepo.update(botId, {
      status: 'running',
      lastStartedAt: new Date().toISOString(),
      errorLogs: [],
    });

    logger.info(`Bot ${bot.name} (${botId}) started (${mode})`);
  }

  /**
   * The bot's worker was terminated by the tick watchdog or died while running (spec §5.1):
   * forget the instance, persist status `error`, audit.
   */
  private onBotFatal(botId: string, instance: BaseBotRunner, data: Record<string, unknown>): void {
    if (this.instances.get(botId) !== instance) return;
    this.instances.delete(botId);
    this.orderServices.delete(botId);
    const message = String(data.message ?? 'worker died');
    try {
      this.botRepo.update(botId, { status: 'error', lastStoppedAt: new Date().toISOString() });
      this.botRepo.appendError(botId, message);
    } catch (err) {
      logger.error(`Could not record fatal error for bot ${botId}: ${err instanceof Error ? err.message : err}`);
    }
    this.orderDeps?.audit?.record('system', 'bot.error', botId, { reason: data.reason ?? 'unknown', message }, 'terminated');
    logger.error(`Bot ${botId} terminated: ${message}`);
  }

  /**
   * Stop a specific bot by ID
   */
  async stopBot(botId: string, actor: AuditActor = 'system'): Promise<void> {
    const instance = this.instances.get(botId);
    if (!instance) {
      // Check if bot exists and update its status
      const botRow = this.botRepo.findById(botId);
      if (botRow && botRow.status !== 'stopped') {
        this.botRepo.update(botId, {
          status: 'stopped',
          lastStoppedAt: new Date().toISOString(),
        });
        this.orderDeps?.audit?.record(actor, 'bot.stop', botId, { wasRunning: false }, 'ok');
      }
      return;
    }

    try {
      await instance.stop();
    } finally {
      // Update database
      this.botRepo.update(botId, {
        status: 'stopped',
        lastStoppedAt: new Date().toISOString(),
      });

      // Remove instance
      this.instances.delete(botId);
      this.orderServices.delete(botId);
    }
    this.orderDeps?.audit?.record(actor, 'bot.stop', botId, { wasRunning: true }, 'ok');

    logger.info(`Bot ${botId} stopped`);
  }

  /**
   * Restart a specific bot
   */
  async restartBot(botId: string, actor: AuditActor = 'system'): Promise<void> {
    await this.stopBot(botId, actor);
    await this.startBot(botId, actor);
  }

  /**
   * Start all bots of a specific type (by script ID)
   */
  async startBotsByScriptId(scriptId: string): Promise<{ started: string[]; failed: Array<{ id: string; error: string }> }> {
    const bots = this.botRepo.findAll({ scriptId, enabled: true });
    const started: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const bot of bots) {
      try {
        await this.startBot(bot.id);
        started.push(bot.id);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        failed.push({ id: bot.id, error: errorMsg });
        logger.error(`Failed to start bot ${bot.id}: ${errorMsg}`);
      }
    }

    return { started, failed };
  }

  /**
   * Stop all bots of a specific type (by script ID)
   */
  async stopBotsByScriptId(scriptId: string): Promise<{ stopped: string[]; failed: Array<{ id: string; error: string }> }> {
    const bots = this.botRepo.findAll({ scriptId });
    const stopped: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const bot of bots) {
      try {
        await this.stopBot(bot.id);
        stopped.push(bot.id);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        failed.push({ id: bot.id, error: errorMsg });
        logger.error(`Failed to stop bot ${bot.id}: ${errorMsg}`);
      }
    }

    return { stopped, failed };
  }

  /**
   * Get status of all bots
   */
  getAllStatus(): BotSummary[] {
    const bots = this.botRepo.findAll();

    return bots.map((botRow) => {
      const instance = this.instances.get(botRow.id);
      const wallet = this.walletRepo.findById(botRow.wallet_id);
      const script = this.scriptRepo.findById(botRow.script_id);

      return {
        id: botRow.id,
        type: script?.name || 'unknown',
        name: botRow.name,
        status: (instance?.status || botRow.status) as BotStatus,
        enabled: botRow.enabled === 1,
        walletId: botRow.wallet_id,
        walletAddress: wallet?.address,
        scriptId: botRow.script_id,
        scriptName: script?.name,
        lastHeartbeat: botRow.last_heartbeat ? new Date(botRow.last_heartbeat) : undefined,
      };
    });
  }

  /**
   * Get health info for a specific bot
   */
  getHealthInfo(botId: string): BotHealthInfo | undefined {
    const instance = this.instances.get(botId);
    return instance?.getHealthInfo();
  }

  /**
   * Get health info for all running bots
   */
  getAllHealthInfo(): BotHealthInfo[] {
    return Array.from(this.instances.values()).map((instance) =>
      instance.getHealthInfo()
    );
  }

  /**
   * Shutdown all bots gracefully
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down all bots...');
    this.unsubscribeConfig?.();
    this.unsubscribeConfig = null;

    const stopPromises = Array.from(this.instances.keys()).map((botId) =>
      this.stopBot(botId).catch((error) => {
        logger.error(`Error stopping bot ${botId} during shutdown: ${error}`);
      })
    );

    await Promise.all(stopPromises);

    this.instances.clear();
    this.clobClients.clear();

    logger.info('All bots shut down');
  }

  /**
   * Get count of running bots
   */
  getRunningCount(): number {
    return Array.from(this.instances.values()).filter(
      (instance) => instance.status === 'running'
    ).length;
  }

  /**
   * Update heartbeat for a bot in the database
   */
  updateHeartbeat(botId: string): void {
    this.botRepo.updateHeartbeat(botId);
  }

  /**
   * Log an error for a bot
   */
  logError(botId: string, message: string): void {
    this.botRepo.appendError(botId, message);
  }
}

export default BotManager;
