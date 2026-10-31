/**
 * Composition root (spec §1.1, §1.2). `createCore` builds the database, repositories, config, risk
 * controls, notifications, market cache, ledger, recorder and services; transports (the HTTP server
 * in apps/server, MCP in Phase 4) only call `core.services.*` and forward `core.events`.
 *
 * Lifecycle:
 * - `createCore(options)` — opens the DB (migrations) and constructs everything; no timers, no network.
 * - `start()` — what needs no wallet keys ("Phase A"): config load + watcher, Telegram, market cache,
 *   ledger scorer, order-book recorder, nightly backup, start-halted-after-crash check, template seeding. Halts and
 *   the kill switch work from here on (R22).
 * - `unlock(masterKey)` — what needs the keys ("Phase B"): master-key check, secret migration,
 *   WalletManager, BotManager, startup order recovery, RiskMonitor, Reconciler. The server calls it at
 *   boot with the key from `BOTLAB_MASTER_KEY(_FILE)` (spec §8.3).
 * - `shutdown({ timeoutMs })` — graceful stop; writes the clean-shutdown marker unless it timed out.
 * - `close()` — closes the database (after `shutdown`).
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { initializeDatabase, closeDatabase, type Database } from './db/index';
import {
  BotRepository,
  WalletRepository,
  ScriptRepository,
  SettingsRepository,
  BotTradeRepository,
  BotStorageRepository,
  BacktestRepository,
  OrderRepository,
  RiskStateRepository,
  AuditRepository,
  MarketCacheRepository,
  ForecastRepository,
  CategoryRightsRepository,
  OrderbookSnapshotRepository,
} from './db/repositories/index';
import { keyManager } from './security/keyManager';
import { migrateSecretsToV2 } from './security/migrateSecrets';
import { verifyMasterKey } from './security/masterKey';
import { AdminAuthStore } from './security/adminAuth';
import { BackupJob } from './ops/BackupJob';
import { WalletManager } from './bots/WalletManager';
import { BotManager } from './bots/BotManager';
import { seedTemplates, getBuiltinTemplates } from './db/seed';
import { AuditService } from './audit/AuditService';
import { OrderCanceller } from './orders/OrderCanceller';
import { fetchPolymarketMid, fetchPolymarketTop, bookMid } from './orders/MarketDataService';
import { FeeService, FEE_CATEGORIES, type FeeCategory } from './orders/FeeService';
import { MarketCacheService, MARKET_RULES_CHANGED_EVENT } from './ledger/MarketCacheService';
import { LedgerService } from './ledger/LedgerService';
import { defaultCategories } from './config/categoriesSchema';
import { HaltService, RISK_HALT_EVENT, RISK_HALT_CLEARED_EVENT, type BotControl } from './risk/HaltService';
import { KillSwitch } from './risk/KillSwitch';
import { RiskMonitor } from './risk/RiskMonitor';
import { ShutdownMarker, applyStartupHalt, recoverOpenOrders } from './risk/StartupRecovery';
import { ConfigService } from './config/ConfigService';
import { TelegramNotifier, telegramSettingsFrom } from './notify/TelegramNotifier';
import { NotificationService } from './notify/NotificationService';
import { unfilledNotional } from './orders/DbRiskStateProvider';
import { getBinanceOrderBook, getBinancePrice, getBinanceServerTime } from './exchange/binance/client';
import type { ClockSkewGuard } from './orders/OrderService';
import { Reconciler } from './reconcile/Reconciler';
import { fetchDataApiPositions, fetchDataApiTrades } from './reconcile/dataApi';
import { Recorder } from './recorder/Recorder';
import { BotService } from './services/BotService';
import { WalletService } from './services/WalletService';
import { ScriptService } from './services/ScriptService';
import { SettingsService } from './services/SettingsService';
import { BacktestService } from './services/BacktestService';
import { RiskService } from './services/RiskService';
import { ConfigFileService } from './services/ConfigFileService';
import { ReconcileService } from './services/ReconcileService';
import { MarketService } from './services/MarketService';
import { OverviewService } from './services/OverviewService';
import { AuditLogService } from './services/AuditLogService';
import { getBalance } from './exchange/polymarket/trading';
import { getBinanceBalance } from './exchange/binance/client';

export interface CoreOptions {
  /** Directory for the database, shutdown marker, notify state and config history (created if missing) */
  dataDir: string;
  /** Config directory (limits/mandate/fees/server/categories.yaml). Default: `resolveConfigDir()` */
  configDir?: string;
  /** Built-in bot templates. Default: `<repo>/templates` */
  templatesDir?: string;
  /** Database file. Default: `<dataDir>/botlab.db` (tests may pass ':memory:') */
  dbPath?: string;
  /** Nightly SQLite backups to `<dataDir>/backups` (default true; never for ':memory:') */
  backups?: boolean;
}

/**
 * Events transports forward to clients (IPC channel / SSE event name ⇒ payload):
 * `risk:halt`, `risk:halt-cleared`, `config:changed`, `market:rulesChanged`, `bot:event`, `bot:log`.
 */
export const CORE_EVENTS = [RISK_HALT_EVENT, RISK_HALT_CLEARED_EVENT, 'config:changed', MARKET_RULES_CHANGED_EVENT, 'bot:event', 'bot:log'] as const;
export type CoreEventName = (typeof CORE_EVENTS)[number];

export interface CoreRepositories {
  botRepo: BotRepository;
  walletRepo: WalletRepository;
  scriptRepo: ScriptRepository;
  settingsRepo: SettingsRepository;
  tradeRepo: BotTradeRepository;
  storageRepo: BotStorageRepository;
  backtestRepo: BacktestRepository;
  orderRepo: OrderRepository;
  riskStateRepo: RiskStateRepository;
  auditRepo: AuditRepository;
  forecastRepo: ForecastRepository;
  snapshotRepo: OrderbookSnapshotRepository;
}

export interface CoreServices {
  bots: BotService;
  wallets: WalletService;
  scripts: ScriptService;
  settings: SettingsService;
  backtests: BacktestService;
  risk: RiskService;
  config: ConfigFileService;
  /** Forecast ledger and category rights (methods take plain inputs and an actor) */
  ledger: LedgerService;
  markets: MarketService;
  reconcile: ReconcileService;
  audit: AuditService;
  /** Dashboard risk picture (spec §12, §7.3 get_overview) */
  overview: OverviewService;
  /** Audit log queries (Audit page, halt history) */
  auditLog: AuditLogService;
}

export interface Core {
  readonly dataDir: string;
  readonly db: Database.Database;
  readonly repos: CoreRepositories;
  readonly services: CoreServices;
  /** Emits the events listed in CORE_EVENTS */
  readonly events: EventEmitter;
  readonly configService: ConfigService;
  readonly halts: HaltService;
  readonly killSwitch: KillSwitch;
  readonly notifications: NotificationService;
  /** Admin password, sessions and API tokens (spec §8.2) */
  readonly auth: AdminAuthStore;
  /** Nightly database backup; null when disabled */
  readonly backups: BackupJob | null;
  /** Null until `unlock()` */
  readonly botManager: BotManager | null;
  readonly walletManager: WalletManager | null;
  readonly reconciler: Reconciler | null;
  isUnlocked(): boolean;
  start(): Promise<void>;
  /**
   * Returns false if already unlocked (nothing done). Throws `ServiceError('locked')` if the key is not
   * this database's master key (or the secrets still use the old password-derived key).
   */
  unlock(masterKey: string): Promise<boolean>;
  /** Graceful stop. `clean` is false when it timed out (no clean marker written). */
  shutdown(opts?: { timeoutMs?: number }): Promise<{ clean: boolean }>;
  close(): void;
}

const QTY_EPSILON = 1e-9;

export function createCore(options: CoreOptions): Core {
  const dataDir = path.resolve(options.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const db = initializeDatabase(options.dbPath ?? path.join(dataDir, 'botlab.db'));
  console.log('[Core] Database initialized');

  const events = new EventEmitter();
  events.setMaxListeners(50);

  // ── Repositories ──────────────────────────────────────────────────
  const repos: CoreRepositories = {
    botRepo: new BotRepository(db),
    walletRepo: new WalletRepository(db),
    scriptRepo: new ScriptRepository(db),
    settingsRepo: new SettingsRepository(db),
    tradeRepo: new BotTradeRepository(db),
    storageRepo: new BotStorageRepository(db),
    backtestRepo: new BacktestRepository(db),
    orderRepo: new OrderRepository(db),
    riskStateRepo: new RiskStateRepository(db),
    auditRepo: new AuditRepository(db),
    forecastRepo: new ForecastRepository(db),
    snapshotRepo: new OrderbookSnapshotRepository(db),
  };
  const { botRepo, walletRepo, scriptRepo, settingsRepo, tradeRepo, storageRepo, backtestRepo, orderRepo, riskStateRepo, forecastRepo, snapshotRepo } = repos;
  const audit = new AuditService(repos.auditRepo);
  const auth = new AdminAuthStore(db);
  const dbFile = options.dbPath ?? path.join(dataDir, 'botlab.db');
  const backups =
    options.backups !== false && dbFile !== ':memory:'
      ? new BackupJob({
          db,
          dir: path.join(dataDir, 'backups'),
          onResult: (r) => {
            if (!r.ok) audit.record('system', 'backup.run', null, { error: r.error }, 'error');
          },
        })
      : null;

  // Created by unlock()
  let botManager: BotManager | null = null;
  let walletManager: WalletManager | null = null;
  let riskMonitor: RiskMonitor | null = null;
  let reconciler: Reconciler | null = null;
  let shutdownMarker: ShutdownMarker | null = null;
  let started = false;

  /** OrderService asks this before every live order; the reconciler sets it (spec §15) */
  const clockGuard: ClockSkewGuard = { status: () => reconciler?.status() ?? { skewed: false, detail: null } };

  // ── Halts / kill switch ───────────────────────────────────────────
  // Before unlock there is no BotManager: no bot runs, and live orders cannot be cancelled
  // (wallet keys locked) — such failures are reported, the halt still applies.
  const botControl: BotControl = {
    stopBot: async (id, actor) => {
      if (botManager) await botManager.stopBot(id, actor);
    },
    runningBotIds: () => botManager?.runningBotIds() ?? [],
  };
  const canceller = new OrderCanceller({
    db,
    orderRepo,
    tradeRepo,
    getRunningService: (id, simulated) => botManager?.getRunningOrderService(id, simulated) ?? null,
    getPolymarketAdapter: async (id) => {
      if (!botManager) throw new Error('app locked: wallet keys unavailable');
      return botManager.getPolymarketAdapterForBot(id);
    },
  });
  const halts = new HaltService({ riskStateRepo, botRepo, audit, canceller, bots: botControl });
  const killSwitch = new KillSwitch(halts);
  for (const evt of [RISK_HALT_EVENT, RISK_HALT_CLEARED_EVENT]) {
    halts.on(evt, (payload) => events.emit(evt, payload));
  }

  // ── Config (hot reload) ───────────────────────────────────────────
  const configService = new ConfigService({ audit, historyDir: path.join(dataDir, 'config-history'), ...(options.configDir ? { configDir: options.configDir } : {}) });

  /** Fee rates for a token from the live fee table and the market cache's fee category. */
  function feeRatesFor(tokenId: string): { takerRate: number; makerRate: number } {
    const fees = new FeeService(configService.getConfig()?.fees);
    const cat = marketCache.getCachedByToken(tokenId)?.feeCategory ?? null;
    return fees.getRates(cat && (FEE_CATEGORIES as readonly string[]).includes(cat) ? (cat as FeeCategory) : null);
  }

  /** CLOB /time (seconds) → ms; falls back to Binance server time (ms). */
  async function exchangeTimeMs(): Promise<{ timeMs: number; resolutionMs: number }> {
    try {
      const resp = await fetch(`${settingsRepo.get().clob_http_url.replace(/\/+$/, '')}/time`, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) throw new Error(`CLOB /time HTTP ${resp.status}`);
      const n = Number((await resp.text()).trim());
      if (!Number.isFinite(n) || n <= 0) throw new Error('CLOB /time: not a number');
      return n < 1e12 ? { timeMs: n * 1000, resolutionMs: 1000 } : { timeMs: n, resolutionMs: 1 };
    } catch {
      return { timeMs: await getBinanceServerTime(), resolutionMs: 1 };
    }
  }

  // ── Telegram notifications (no-op unless enabled in server.yaml) ──
  // eslint-disable-next-line prefer-const
  let notifications: NotificationService;
  const telegram = new TelegramNotifier({
    getSettings: () => {
      const server = configService.getConfig()?.server;
      return server ? telegramSettingsFrom(server) : { enabled: false, token: '', chatId: '' };
    },
    onUpdate: (u) => notifications.handleUpdate(u),
  });
  notifications = new NotificationService({
    notifier: telegram,
    audit,
    halts,
    killSwitch,
    botRepo,
    riskStateRepo,
    getLimits: () => configService.getConfig()?.limits ?? null,
    getServer: () => configService.getConfig()?.server ?? null,
    getExposureUsd: () => {
      const positions = tradeRepo.getRiskPositions({ simulated: false }).reduce((n, p) => n + p.cost_basis, 0);
      const openBuys = orderRepo
        .findOpen(undefined, false)
        .filter((o) => o.side === 'buy')
        .reduce((n, o) => n + unfilledNotional(o), 0);
      return positions + openBuys;
    },
    stopBot: async (id, actor) => {
      if (!botManager) throw new Error('App is locked: unlock BotLab first');
      await botManager.stopBot(id, actor);
    },
    isRunning: (id) => botManager?.isRunning(id) ?? false,
    stateFile: path.join(dataDir, 'notify-state.json'),
  });

  // ── Market cache and forecast ledger (no wallet keys needed) ──────
  const feeLabels = new FeeService();
  const marketCache = new MarketCacheService({
    repo: new MarketCacheRepository(db),
    getCategories: () => configService.getConfig()?.categories ?? defaultCategories(),
    feeCategoryFor: (labels) => feeLabels.feeCategoryFor(labels),
    audit,
    heldBy: (marketId) => [
      ...new Set(
        tradeRepo
          .getRiskPositions({ simulated: false, exchange: 'polymarket' })
          .filter((p) => p.condition_id === marketId && p.net_quantity > QTY_EPSILON)
          .map((p) => p.bot_id)
      ),
    ],
    watchedMarketIds: () => [
      ...[false, true].flatMap((simulated) =>
        tradeRepo
          .getRiskPositions({ simulated, exchange: 'polymarket' })
          .filter((p) => p.net_quantity > QTY_EPSILON && p.condition_id)
          .map((p) => p.condition_id as string)
      ),
      ...[false, true].flatMap((simulated) =>
        orderRepo
          .findOpen(undefined, simulated)
          .filter((o) => o.exchange === 'polymarket')
          .map((o) => o.market_id)
      ),
      ...forecastRepo.activeMarketIds(),
    ],
  });
  marketCache.on(MARKET_RULES_CHANGED_EVENT, (payload) => events.emit(MARKET_RULES_CHANGED_EVENT, payload));
  const ledger = new LedgerService({
    forecastRepo,
    rightsRepo: new CategoryRightsRepository(db),
    marketCache,
    audit,
    getTopOfBook: (tokenId) => fetchPolymarketTop(settingsRepo.get().clob_http_url, tokenId),
    getMid: (tokenId) => fetchPolymarketMid(settingsRepo.get().clob_http_url, tokenId),
    getMandate: () => configService.getConfig()?.mandate ?? null,
    getLimits: () => configService.getConfig()?.limits ?? null,
  });

  // ── Order-book recorder (spec §10): never affects trading ─────────
  const recorder = new Recorder({
    repo: snapshotRepo,
    getSettings: () => configService.getConfig()?.server.recorder ?? null,
    heldTokens: () =>
      [false, true].flatMap((simulated) =>
        tradeRepo
          .getRiskPositions({ simulated, exchange: 'polymarket' })
          .filter((p) => p.net_quantity > QTY_EPSILON)
          .map((p) => p.symbol)
      ),
    forecastTokens: () => forecastRepo.activeTokenIds(),
    botMarketIds: () =>
      botRepo
        .findAll()
        .filter((b) => b.stage !== 'retired' && b.enabled === 1 && b.market_ids)
        .flatMap((b) => {
          try {
            const ids = JSON.parse(b.market_ids as string) as unknown;
            return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
          } catch {
            return [];
          }
        }),
    marketTokens: async (marketId) => (await marketCache.getMarket(marketId))?.tokens.map((t) => t.tokenId) ?? null,
    fetchBook: async (tokenId) => {
      const resp = await fetch(`${settingsRepo.get().clob_http_url.replace(/\/+$/, '')}/book?token_id=${encodeURIComponent(tokenId)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) throw new Error(`CLOB book HTTP ${resp.status}`);
      return (await resp.json()) as { bids?: Array<{ price: string; size: string }>; asks?: Array<{ price: string; size: string }>; last_trade_price?: string };
    },
  });

  // ── Services ──────────────────────────────────────────────────────
  const services: CoreServices = {
    bots: new BotService({
      botRepo,
      walletRepo,
      scriptRepo,
      tradeRepo,
      storageRepo,
      settingsRepo,
      audit,
      orderRepo,
      botManager: () => botManager,
      walletManager: () => walletManager,
    }),
    wallets: new WalletService({ walletRepo, settingsRepo, walletManager: () => walletManager }),
    scripts: new ScriptService({ scriptRepo, audit }),
    settings: new SettingsService({ settingsRepo }),
    backtests: new BacktestService({
      db,
      scriptRepo,
      backtestRepo,
      snapshots: {
        snapshotRepo,
        getFeeRates: feeRatesFor,
        getMaxTtlMinutes: () => configService.getConfig()?.limits.orders.resting_order_ttl_minutes,
      },
    }),
    risk: new RiskService({ halts, killSwitch, botRepo }),
    config: new ConfigFileService(configService),
    ledger,
    markets: new MarketService(marketCache),
    reconcile: new ReconcileService({ getReconciler: () => reconciler, snapshotRepo, audit }),
    audit,
    overview: new OverviewService({
      botRepo,
      scriptRepo,
      tradeRepo,
      orderRepo,
      riskStateRepo,
      getConfig: () => configService.getConfig(),
      getConfigError: () => configService.getLastError(),
      getCachedMarketByToken: (tokenId) => marketCache.getCachedByToken(tokenId),
      ledgerStats: () => ledger.stats(),
      getReconciler: () => reconciler,
      // Cash of the (non-paper) wallets live bots use, plus Binance USDT when credentials are set
      getLiveCashUsd: async () => {
        if (!botManager) throw new Error('locked: the master key is not loaded');
        const settings = botManager.getSettings();
        const walletIds = new Set(
          botRepo
            .findAll()
            .filter((b) => b.mode === 'live' && b.stage !== 'retired' && b.wallet_id)
            .map((b) => b.wallet_id)
        );
        let cash = 0;
        for (const id of walletIds) {
          const w = walletRepo.findById(id);
          if (!w || w.is_paper === 1) continue;
          if (!settings.rpcUrl || !settings.usdcContractAddress) throw new Error('RPC URL or USDC contract not configured');
          cash += await getBalance(w.proxy_address || w.address, settings.rpcUrl, settings.usdcContractAddress);
        }
        if (settings.binanceApiKey && settings.binanceApiSecret) {
          cash += await getBinanceBalance({ apiKey: settings.binanceApiKey, apiSecret: settings.binanceApiSecret }, 'USDT');
        }
        return cash;
      },
    }),
    auditLog: new AuditLogService(repos.auditRepo),
  };

  // ── Lifecycle ─────────────────────────────────────────────────────

  let startPromise: Promise<void> | null = null;
  /** The startup halt / shutdown marker is applied once per core, even if start() is retried */
  let startupHaltApplied = false;

  /** start() once; a failed start is rolled back and may be retried. Concurrent calls share one run. */
  function start(): Promise<void> {
    if (started) return Promise.resolve();
    if (!startPromise) {
      startPromise = startOnce().then(
        () => {
          started = true;
        },
        async (err) => {
          startPromise = null;
          await rollbackStart();
          throw err;
        }
      );
    }
    return startPromise;
  }

  /** Listeners registered by startOnce (removed by rollbackStart) */
  let startUnsubs: Array<() => void> = [];

  async function startOnce(): Promise<void> {
    console.log('[Core] Starting (pre-unlock services)...');

    // Config: limits, mandate, fees, server, categories. Loaded and validated here, then hot-reloaded
    // on file edits. An unreadable config is audited; everything that needs it fails closed.
    try {
      configService.load();
      audit.record('system', 'config.load', configService.configDir, { files: ['limits.yaml', 'mandate.yaml', 'fees.yaml', 'server.yaml', 'categories.yaml'], stage: 'startup' }, 'ok');
    } catch (err) {
      console.error('[Core] Could not read config at startup:', err);
      audit.record('system', 'config.load', configService.configDir, { stage: 'startup', error: err instanceof Error ? err.message : String(err) }, 'error');
    }
    configService.start();
    startUnsubs.push(
      configService.onChange((e) => {
        events.emit('config:changed', { changes: e.changes, raises: e.raises.map((c) => `${c.file}.${c.path}`), source: e.source });
      })
    );

    // Telegram before the startup halt below, so that a halt after a crash is announced
    notifications.attachConfig(configService);
    notifications.start();
    telegram.start();

    // Market cache (category, rules hash, ambiguity) and ledger (scorer hourly, refresh every 30 min)
    startUnsubs.push(
      configService.onChange((e) => {
        if (e.changes.some((c) => c.file === 'categories')) {
          const n = marketCache.recategorizeAll();
          console.log(`[Core] categories.yaml changed: ${n} cached market(s) re-categorized`);
        }
      })
    );
    marketCache.start();
    ledger.start();
    recorder.start();
    backups?.start();

    // Unclean previous shutdown ⇒ global halt (spec §4.3). Unreadable config ⇒ treated as true.
    // Once only: a retried start() must not read its own "running" marker as a crash.
    if (!startupHaltApplied) {
      const startHaltedAfterCrash: boolean | null = configService.getConfig()?.limits.server.start_halted_after_crash ?? null;
      shutdownMarker = new ShutdownMarker(dataDir);
      applyStartupHalt({ marker: shutdownMarker, startHaltedAfterCrash, halts, audit });
      startupHaltApplied = true;
    }

    // Seed script templates (compiles with esbuild)
    const templates = getBuiltinTemplates(options.templatesDir);
    const seeded = await seedTemplates(scriptRepo, templates);
    if (seeded > 0) {
      console.log(`[Core] Seeded ${seeded} script template(s)`);
    } else {
      console.log('[Core] Script templates already present');
    }
    console.log('[Core] Started');
  }

  /** Undo a failed start: stop what it started and drop its listeners, so start() can run again. */
  async function rollbackStart(): Promise<void> {
    console.error('[Core] Start failed; rolling back');
    for (const u of startUnsubs) u();
    startUnsubs = [];
    const quiet = (what: string) => (error: unknown) => console.error(`[Core] Error stopping ${what} after failed start:`, error);
    await recorder.stop().catch(quiet('recorder'));
    await backups?.stop().catch(quiet('backups'));
    await ledger.stop().catch(quiet('ledger'));
    await marketCache.stop().catch(quiet('market cache'));
    await notifications.stop().catch(quiet('notifications')); // also detaches its config listeners
    await telegram.stop().catch(quiet('Telegram'));
    await configService.stop().catch(quiet('config watcher'));
  }

  let unlocking = false;

  async function unlock(encryptionKey: string): Promise<boolean> {
    if (!started) throw new Error('Core not started: call start() first (and wait for it to succeed)');
    // Guard against double initialization (also while an unlock is in progress)
    if (botManager || unlocking) {
      console.log('[Core] Protected services already initialized');
      return false;
    }
    unlocking = true;
    try {
      await unlockOnce(encryptionKey);
      return true;
    } catch (err) {
      console.error('[Core] Unlock failed; rolling back:', err);
      await rollbackUnlock();
      throw err;
    } finally {
      unlocking = false;
    }
  }

  async function unlockOnce(encryptionKey: string): Promise<void> {
    console.log('[Core] Unlocking: initializing protected services...');
    // Wrong key, or secrets still under the old password-derived key ⇒ ServiceError('locked')
    verifyMasterKey(db, encryptionKey);
    keyManager.setKey(encryptionKey);

    // One-time re-encryption of legacy CryptoJS secrets to AES-256-GCM (idempotent, audited)
    try {
      migrateSecretsToV2(db, encryptionKey, audit);
    } catch (err) {
      console.error('[Core] Secret migration failed (legacy secrets stay readable):', err);
      audit.record('system', 'secrets.migrate_v2', null, { error: err instanceof Error ? err.message : String(err) }, 'error');
    }

    // Wallet manager with the derived encryption key
    const wm = new WalletManager(walletRepo, encryptionKey);
    console.log('[Core] WalletManager initialized');

    walletManager = wm;
    const manager = new BotManager(wm, botRepo, walletRepo, settingsRepo, scriptRepo, storageRepo, tradeRepo, {
      db,
      orderRepo,
      riskStateRepo,
      audit,
      config: configService,
      events: notifications,
      marketCache,
      ledger,
      clock: clockGuard,
    });
    botManager = manager;
    // No bot may start until startup recovery below has finished (set before initialize so there is no gap)
    manager.setRecoveryInProgress(true);
    await manager.initialize();
    console.log('[Core] BotManager initialized');

    // Startup recovery: sync and cancel orphaned open orders (no bot runs yet; starts are refused
    // until this finishes). Runs in the background so unlocking is not blocked.
    recoverOpenOrders({ botRepo, canceller, audit, isBotRunning: (id) => manager.isRunning(id) })
      .catch((err) => {
        console.error('[Core] Startup order recovery failed:', err);
        audit.record('system', 'startup.orphan_orders', null, { error: String(err) }, 'error');
      })
      .finally(() => manager.setRecoveryInProgress(false));

    // Daily P&L, loss limits and ramp promotions every 60 s
    riskMonitor = new RiskMonitor({
      botRepo,
      scriptRepo,
      tradeRepo,
      riskStateRepo,
      audit,
      halts,
      killSwitch,
      getLimits: () => manager.getLimits(),
      getMark: async (exchange, symbol) => {
        if (exchange === 'binance') {
          const book = await getBinanceOrderBook(symbol, 5);
          return bookMid(book.bids, book.asks);
        }
        return fetchPolymarketMid(settingsRepo.get().clob_http_url, symbol);
      },
    });
    riskMonitor.start();

    // Reconciler every 60 s (spec §13, §15): orders, fills, positions, resolutions, clock skew
    reconciler = new Reconciler({
      db,
      orderRepo,
      tradeRepo,
      botRepo,
      scriptRepo,
      walletRepo,
      riskStateRepo,
      audit,
      killSwitch,
      canceller,
      notify: notifications,
      events: notifications,
      marketCache,
      getFeeRates: feeRatesFor,
      // Running with a live OrderService (a bot now running paper does not own its old live orders)
      isBotRunning: (id) => manager.getRunningOrderService(id, false) !== null,
      getPolymarketAdapter: (walletId) => manager.getPolymarketAdapterForWallet(walletId),
      getBinanceAdapter: () => manager.getBinanceAdapter(),
      fetchPositions: (user) => fetchDataApiPositions(user),
      fetchTrades: (user, conditionId) => fetchDataApiTrades(user, conditionId),
      getExchangeTime: exchangeTimeMs,
      getBinancePrice: async (symbol) => (await getBinancePrice(symbol)).price,
      getLimits: () => configService.getConfig()?.limits ?? null,
    });
    reconciler.start();

    // Bot events; log events also on the dedicated bot:log channel (UI Logs tab)
    manager.on('bot:event', (event) => {
      events.emit('bot:event', event);
      if (event.type === 'log' && event.data) {
        events.emit('bot:log', {
          botId: event.botId,
          timestamp: event.timestamp,
          level: event.data.level,
          message: event.data.message,
        });
      }
    });

    console.log('[Core] Unlocked — all services ready');
  }

  /** Undo a failed unlock: stop what was created, forget the managers and the key, so unlock can be retried. */
  async function rollbackUnlock(): Promise<void> {
    const quiet = (what: string) => (error: unknown) => console.error(`[Core] Error stopping ${what} after failed unlock:`, error);
    await riskMonitor?.stop().catch(quiet('risk monitor'));
    await reconciler?.stop().catch(quiet('reconciler'));
    if (botManager) {
      botManager.removeAllListeners('bot:event');
      await botManager.shutdown().catch(quiet('bot manager'));
    }
    riskMonitor = null;
    reconciler = null;
    botManager = null;
    walletManager = null;
    keyManager.clear();
  }


  let shutdownPromise: Promise<{ clean: boolean }> | null = null;

  function shutdown(opts: { timeoutMs?: number } = {}): Promise<{ clean: boolean }> {
    if (shutdownPromise) return shutdownPromise;
    let timedOut = false;

    /**
     * Stop the risk monitor, reconciler and all bots, then the background jobs, then write the
     * clean-shutdown marker (spec §4.3). After a timeout the remaining steps and the marker are
     * skipped, so the next start is treated as unclean.
     */
    const graceful = async (): Promise<void> => {
      console.log('[Core] Shutting down...');
      if (riskMonitor) {
        await riskMonitor.stop().catch((error) => console.error('[Core] Error stopping risk monitor:', error));
      }
      await reconciler?.stop().catch((error) => console.error('[Core] Error stopping reconciler:', error));
      if (botManager) {
        await botManager.shutdown();
      }
      await recorder.stop().catch((error) => console.error('[Core] Error stopping recorder:', error));
      await backups?.stop().catch((error) => console.error('[Core] Error stopping backups:', error));
      await ledger.stop().catch((error) => console.error('[Core] Error stopping ledger scorer:', error));
      await marketCache.stop().catch((error) => console.error('[Core] Error stopping market cache:', error));
      if (timedOut) return;
      await notifications.stop().catch((error) => console.error('[Core] Error stopping notifications:', error));
      await telegram.stop().catch((error) => console.error('[Core] Error stopping Telegram:', error));
      await configService.stop().catch((error) => console.error('[Core] Error stopping config watcher:', error));
      if (timedOut) return;
      try {
        shutdownMarker?.markClean();
        audit.record('system', 'app.shutdown', null, undefined, 'clean');
      } catch (error) {
        console.error('[Core] Could not write clean-shutdown marker:', error);
      }
    };

    let timer: NodeJS.Timeout | null = null;
    const timeout =
      opts.timeoutMs !== undefined
        ? new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              console.error('[Core] Shutdown timed out; exiting without clean marker');
              timedOut = true;
              resolve();
            }, opts.timeoutMs);
          })
        : null;
    shutdownPromise = (timeout ? Promise.race([graceful(), timeout]) : graceful())
      .catch((error) => console.error('[Core] Error during shutdown:', error))
      .then(() => {
        if (timer) clearTimeout(timer);
        return { clean: !timedOut };
      });
    return shutdownPromise;
  }

  return {
    dataDir,
    db,
    repos,
    services,
    events,
    configService,
    halts,
    killSwitch,
    notifications,
    auth,
    backups,
    get botManager() {
      return botManager;
    },
    get walletManager() {
      return walletManager;
    },
    get reconciler() {
      return reconciler;
    },
    isUnlocked: () => botManager !== null,
    start,
    unlock,
    shutdown,
    close: () => {
      closeDatabase(db);
      console.log('[Core] Database closed');
    },
  };
}
