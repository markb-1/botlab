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
    } catch (err) {
      this.riskEngine = null;
      this.fees = null;
      this.configError = err instanceof Error ? err.message : String(err);
      logger.error(`Risk config failed to load; bots cannot be started: ${this.configError}`);
    }
    logger.info('BotManager initialized');
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

    return new OrderService(
      {
        db,
        orderRepo,
        tradeRepo: this.tradeRepo,
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
  };

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
   * Start a specific bot by ID
   */
  async startBot(botId: string): Promise<void> {
    const botRow = this.botRepo.findById(botId);
    if (!botRow) {
      throw new Error(`Bot not found: ${botId}`);
    }

    const bot = this.toBotRecord(botRow);

    if (!bot.enabled) {
      throw new Error(`Bot ${botId} is disabled`);
    }

    // Check if already running
    const existingInstance = this.instances.get(botId);
    if (existingInstance && existingInstance.status === 'running') {
      logger.warning(`Bot ${botId} is already running`);
      return;
    }

    // Get wallet credentials
    const walletCredentials = await this.walletManager.getWallet(bot.walletId);

    // Create or get CLOB client for this wallet
    const cacheKey = walletCredentials.proxyAddress || walletCredentials.address;
    let clobClient = this.clobClients.get(cacheKey);
    if (!clobClient) {
      if (bot.mode === 'paper') {
        // Paper mode: create unauthenticated CLOB client (no API key needed).
        // Read-only endpoints (orderbook, prices) work without auth.
        // Trades are simulated by PaperTradingState, not sent to the API.
        const settings = this.getSettings();
        const wallet = new ethers.Wallet(walletCredentials.privateKey);
        clobClient = new ClobClient(settings.clobHttpUrl, 137, wallet);
        logger.info(`Paper mode: created unauthenticated CLOB client for bot ${botId}`);
      } else {
        clobClient = await this.createClobClientForWallet(
          walletCredentials.address,
          walletCredentials.privateKey,
          walletCredentials.proxyAddress
        );
      }
      this.clobClients.set(cacheKey, clobClient);
    }

    // Look up the script
    const script = this.scriptRepo.findById(bot.scriptId);

    if (!script?.compiled) {
      throw new Error(
        `No compiled script found for "${script?.name || bot.scriptId}". ` +
        `Write and compile the script source first.`
      );
    }

    const settings = this.getSettings();
    const instance: BaseBotRunner = new ScriptBotRunner(bot, this.walletManager, clobClient, {
      compiledCode: script.compiled,
      scriptName: script.name,
      storageRepo: this.storageRepo,
      tradeRepo: this.tradeRepo,
      rpcUrl: settings.rpcUrl,
      usdcContractAddress: settings.usdcContractAddress,
      clobHttpUrl: settings.clobHttpUrl,
      mode: bot.mode || 'live',
      binanceApiKey: settings.binanceApiKey,
      binanceApiSecret: settings.binanceApiSecret,
      createOrderService: this.createOrderService,
    });

    // Forward events
    instance.on('bot:event', (event: BotEvent) => {
      this.emit('bot:event', event);
    });

    // Update heartbeat in database when heartbeat events occur
    instance.on('bot:heartbeat', () => {
      this.updateHeartbeat(botId);
    });

    // Store instance
    this.instances.set(botId, instance);

    // Start the bot
    await instance.start();

    // Update database
    this.botRepo.update(botId, {
      status: 'running',
      lastStartedAt: new Date().toISOString(),
      errorLogs: [],
    });

    logger.info(`Bot ${bot.name} (${botId}) started`);
  }

  /**
   * Stop a specific bot by ID
   */
  async stopBot(botId: string): Promise<void> {
    const instance = this.instances.get(botId);
    if (!instance) {
      // Check if bot exists and update its status
      const botRow = this.botRepo.findById(botId);
      if (botRow && botRow.status !== 'stopped') {
        this.botRepo.update(botId, {
          status: 'stopped',
          lastStoppedAt: new Date().toISOString(),
        });
      }
      return;
    }

    await instance.stop();

    // Update database
    this.botRepo.update(botId, {
      status: 'stopped',
      lastStoppedAt: new Date().toISOString(),
    });

    // Remove instance
    this.instances.delete(botId);

    logger.info(`Bot ${botId} stopped`);
  }

  /**
   * Restart a specific bot
   */
  async restartBot(botId: string): Promise<void> {
    await this.stopBot(botId);
    await this.startBot(botId);
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
