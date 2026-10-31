import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
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
import type { BotRepository } from '../../electron/database/repositories/BotRepository';
import type { WalletRepository } from '../../electron/database/repositories/WalletRepository';
import type { SettingsRepository } from '../../electron/database/repositories/SettingsRepository';
import type { ScriptRepository } from '../../electron/database/repositories/ScriptRepository';
import type { BotStorageRepository } from '../../electron/database/repositories/BotStorageRepository';
import type { BotTradeRepository } from '../../electron/database/repositories/BotTradeRepository';
import { ScriptBotRunner, type OrderServiceFactory } from '../../electron/runtime/ScriptBotRunner';
import type { Database } from '../../electron/database/index';
import type { OrderRepository } from '../../electron/database/repositories/OrderRepository';
import type { RiskStateRepository } from '../../electron/database/repositories/RiskStateRepository';
import { loadConfig, resolveConfigDir } from '../../electron/config';
import { RiskEngine } from '../../electron/risk/RiskEngine';
import { FeeService, loadFees } from '../../electron/orders/FeeService';
import { MarketDataService, PlaceholderMarketQualityProvider } from '../../electron/orders/MarketDataService';
import { DbRiskStateProvider } from '../../electron/orders/DbRiskStateProvider';
import { OrderService, type ClobBook } from '../../electron/orders/OrderService';
import { createBinanceAdapter, createPolymarketAdapter } from '../../electron/orders/ExchangeAdapter';
import type { PolymarketAdapter } from '../../electron/orders/ExchangeAdapter';
import type { AuditActor, AuditService } from '../../electron/audit/AuditService';
import { GLOBAL_SCOPE } from '../../electron/database/repositories/RiskStateRepository';
import type { LimitsConfig } from '../../electron/config';
import { getBalance } from '../../electron/sdk/trading';
import { getBinanceBalance, getBinanceOrderBook } from '../../electron/sdk/binance';
import CryptoJS from 'crypto-js';
import { keyManager } from '../../electron/security/keyManager';
import logger from '../utils/logger';

/** Order store for OrderService (orders + halts). */
export interface BotManagerOrderDeps {
  db: Database.Database;
  orderRepo: OrderRepository;
  riskStateRepo: RiskStateRepository;
  audit?: AuditService;
}

/**
 * BotManager orchestrates all bot instances.
 * Handles starting, stopping, and monitoring bots.
 */
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
  /** Loaded once in initialize() (hot reload: chunk 1e). null ⇒ every order fails. */
  private riskEngine: RiskEngine | null = null;
  private fees: FeeService | null = null;
  private configError: string | null = 'not loaded';
  private marketData = new MarketDataService();
  /** Running bots' OrderServices (used to cancel their orders on a halt) */
  private orderServices: Map<string, { service: OrderService; simulated: boolean }> = new Map();
  /** Startup orphan-order recovery running: bots may not start until it finishes */
  private recoveryInProgress = false;

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
    // rather than falling back to defaults the human did not choose.
    try {
      const dir = resolveConfigDir();
      this.riskEngine = new RiskEngine(loadConfig(dir));
      this.fees = new FeeService(loadFees(dir));
      this.configError = null;
      logger.info(`Risk config loaded from ${dir}`);
      this.orderDeps?.audit?.record('system', 'config.load', dir, { files: ['limits.yaml', 'mandate.yaml', 'fees.yaml'] }, 'ok');
    } catch (err) {
      this.riskEngine = null;
      this.fees = null;
      this.configError = err instanceof Error ? err.message : String(err);
      logger.error(`Risk config failed to load; bots cannot be started: ${this.configError}`);
      this.orderDeps?.audit?.record('system', 'config.load', resolveConfigDir(), { error: this.configError }, 'error');
    }
    this.warnUnlinkedPositions();
    logger.info('BotManager initialized');
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
        riskEngine: this.riskEngine,
        provider,
        fees: this.fees,
        marketData: this.marketData,
        quality: PlaceholderMarketQualityProvider,
        getBook: (tokenId) => args.clobClient.getOrderBook(tokenId) as Promise<ClobBook>,
        getBinanceBook: (symbol) => getBinanceOrderBook(symbol),
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
    this.orderServices.set(args.botId, { service, simulated: paper });
    return service;
  };

  /** Limits currently in force; null when the config failed to load. */
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
        result.binanceApiKey = CryptoJS.AES.decrypt(settings.binance_api_key_encrypted, encKey).toString(CryptoJS.enc.Utf8);
        result.binanceApiSecret = CryptoJS.AES.decrypt(settings.binance_api_secret_encrypted, encKey).toString(CryptoJS.enc.Utf8);
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
