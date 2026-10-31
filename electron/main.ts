import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import path from 'path';
import { initializeDatabase, closeDatabase, getDataDir } from '../packages/core/src/db/index';
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
} from '../packages/core/src/db/repositories/index';
import type { Database } from '../packages/core/src/db/index';
import { keyManager } from '../packages/core/src/security/keyManager';
import { migrateSecretsToV2 } from '../packages/core/src/security/migrateSecrets';
import { WalletManager } from '../packages/core/src/bots/WalletManager';
import { BotManager } from '../packages/core/src/bots/BotManager';
import { registerAuthHandlers } from './ipc/handlers/authHandlers';
import { registerBotHandlers } from './ipc/handlers/botHandlers';
import { registerWalletHandlers } from './ipc/handlers/walletHandlers';
import { registerSettingsHandlers } from './ipc/handlers/settingsHandlers';
import { registerScriptHandlers } from './ipc/handlers/scriptHandlers';
import { registerAiHandlers } from './ipc/handlers/aiHandlers';
import { registerBacktestHandlers } from './ipc/handlers/backtestHandlers';
import { registerRiskHandlers } from './ipc/handlers/riskHandlers';
import { seedTemplates, getBuiltinTemplates } from '../packages/core/src/db/seed';
import { AuditService } from '../packages/core/src/audit/AuditService';
import { OrderCanceller } from '../packages/core/src/orders/OrderCanceller';
import { fetchPolymarketMid, fetchPolymarketTop, bookMid } from '../packages/core/src/orders/MarketDataService';
import { FeeService } from '../packages/core/src/orders/FeeService';
import { MarketCacheService, MARKET_RULES_CHANGED_EVENT } from '../packages/core/src/ledger/MarketCacheService';
import { LedgerService } from '../packages/core/src/ledger/LedgerService';
import { registerLedgerHandlers } from './ipc/handlers/ledgerHandlers';
import { defaultCategories } from '../packages/core/src/config/categoriesSchema';
import { HaltService, RISK_HALT_EVENT, RISK_HALT_CLEARED_EVENT, type BotControl } from '../packages/core/src/risk/HaltService';
import { KillSwitch } from '../packages/core/src/risk/KillSwitch';
import { RiskMonitor } from '../packages/core/src/risk/RiskMonitor';
import { ShutdownMarker, applyStartupHalt, recoverOpenOrders } from '../packages/core/src/risk/StartupRecovery';
import { resolveConfigDir } from '../packages/core/src/config';
import { ConfigService } from '../packages/core/src/config/ConfigService';
import { registerConfigHandlers } from './ipc/handlers/configHandlers';
import { TelegramNotifier, telegramSettingsFrom } from '../packages/core/src/notify/TelegramNotifier';
import { NotificationService } from '../packages/core/src/notify/NotificationService';
import { unfilledNotional } from '../packages/core/src/orders/DbRiskStateProvider';
import { getBinanceOrderBook, getBinancePrice, getBinanceServerTime } from '../packages/core/src/exchange/binance/client';
import { FEE_CATEGORIES, type FeeCategory } from '../packages/core/src/orders/FeeService';
import type { ClockSkewGuard } from '../packages/core/src/orders/OrderService';
import { Reconciler } from '../packages/core/src/reconcile/Reconciler';
import { fetchDataApiPositions, fetchDataApiTrades } from '../packages/core/src/reconcile/dataApi';
import { Recorder } from '../packages/core/src/recorder/Recorder';
import { registerReconcileHandlers } from './ipc/handlers/reconcileHandlers';

// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

let mainWindow: BrowserWindow | null = null;
let botManager: BotManager | null = null;

// Repositories (created in Phase A, used in Phase B)
let botRepo: BotRepository;
let walletRepo: WalletRepository;
let scriptRepo: ScriptRepository;
let settingsRepo: SettingsRepository;
let tradeRepo: BotTradeRepository;
let storageRepo: BotStorageRepository;
let backtestRepo: BacktestRepository;
let orderRepo: OrderRepository;
let riskStateRepo: RiskStateRepository;
let database: Database.Database;

// Risk controls (created in Phase A so halts and the kill switch exist before unlock)
let audit: AuditService;
let halts: HaltService;
let killSwitch: KillSwitch;
let canceller: OrderCanceller;
let riskMonitor: RiskMonitor | null = null;
let shutdownMarker: ShutdownMarker | null = null;

// Config (hot reload) and notifications (Telegram); both work without credentials
let configService: ConfigService;
let telegram: TelegramNotifier;
let notifications: NotificationService;

// Market cache and forecast ledger (no wallet keys needed: created before unlock)
let marketCache: MarketCacheService | null = null;
let ledger: LedgerService | null = null;

// Order-book recorder (before unlock) and reconciler (after unlock: needs wallet keys)
let recorder: Recorder | null = null;
let reconciler: Reconciler | null = null;
let snapshotRepo: OrderbookSnapshotRepository;
/** OrderService asks this before every live order; the reconciler sets it (spec §15) */
const clockGuard: ClockSkewGuard = { status: () => reconciler?.status() ?? { skewed: false, detail: null } };

/** Fee rates for a token from the live fee table and the market cache's fee category. */
function feeRatesFor(tokenId: string): { takerRate: number; makerRate: number } {
  const fees = new FeeService(configService.getConfig()?.fees);
  const cat = marketCache?.getCachedByToken(tokenId)?.feeCategory ?? null;
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

const isDev = !app.isPackaged;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'BotLab',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.icns'),
    backgroundColor: '#0f0f0f',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // Needed for better-sqlite3 native module
    },
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    // In development with explicit dev server URL, load from Vite
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    await mainWindow.loadURL(devServerUrl);
  } else {
    // Load the built React app (production or dev without Vite server)
    // __dirname is dist-electron/electron/ so go up 2 levels to project root
    const indexPath = path.join(__dirname, '..', '..', 'web', 'client', 'dist', 'index.html');
    console.log(`[Main] Loading UI from: ${indexPath}`);
    await mainWindow.loadFile(indexPath);
  }

  // Windows: forced shutdown / restart / log off (see also powerMonitor 'shutdown' in whenReady)
  mainWindow.on('session-end', () => {
    startGracefulShutdown();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Phase A: Pre-auth initialization.
 * Sets up database, repositories, seeds templates, registers auth handlers.
 * This runs BEFORE the window is created so auth IPC is available immediately.
 */
async function initializePhaseA(): Promise<void> {
  console.log('[Main] Phase A: Pre-auth initialization...');

  // 1. Initialize database
  const db = initializeDatabase();
  console.log('[Main] Database initialized');

  // 2. Create repositories
  botRepo = new BotRepository(db);
  walletRepo = new WalletRepository(db);
  scriptRepo = new ScriptRepository(db);
  settingsRepo = new SettingsRepository(db);
  tradeRepo = new BotTradeRepository(db);
  storageRepo = new BotStorageRepository(db);
  backtestRepo = new BacktestRepository(db);
  orderRepo = new OrderRepository(db);
  riskStateRepo = new RiskStateRepository(db);
  database = db;
  audit = new AuditService(new AuditRepository(db));

  // Halts / kill switch. Before unlock there is no BotManager: no bot runs, and live orders
  // cannot be cancelled (wallet keys locked) — such failures are reported, the halt still applies.
  const botControl: BotControl = {
    stopBot: async (id, actor) => {
      if (botManager) await botManager.stopBot(id, actor);
    },
    runningBotIds: () => botManager?.runningBotIds() ?? [],
  };
  canceller = new OrderCanceller({
    db,
    orderRepo,
    tradeRepo,
    getRunningService: (id, simulated) => botManager?.getRunningOrderService(id, simulated) ?? null,
    getPolymarketAdapter: async (id) => {
      if (!botManager) throw new Error('app locked: wallet keys unavailable');
      return botManager.getPolymarketAdapterForBot(id);
    },
  });
  halts = new HaltService({ riskStateRepo, botRepo, audit, canceller, bots: botControl });
  killSwitch = new KillSwitch(halts);
  for (const evt of [RISK_HALT_EVENT, RISK_HALT_CLEARED_EVENT]) {
    halts.on(evt, (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(evt, payload);
    });
  }

  // Config: limits, mandate, fees, server. Loaded and validated here, then hot-reloaded on file edits.
  // An unreadable config is audited; everything that needs it fails closed.
  configService = new ConfigService({ audit, historyDir: path.join(getDataDir(), 'config-history') });
  try {
    configService.load();
    audit.record('system', 'config.load', configService.configDir, { files: ['limits.yaml', 'mandate.yaml', 'fees.yaml', 'server.yaml', 'categories.yaml'], stage: 'startup' }, 'ok');
  } catch (err) {
    console.error('[Main] Could not read config at startup:', err);
    audit.record('system', 'config.load', configService.configDir, { stage: 'startup', error: err instanceof Error ? err.message : String(err) }, 'error');
  }
  configService.start();
  configService.onChange((e) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('config:changed', { changes: e.changes, raises: e.raises.map((c) => `${c.file}.${c.path}`), source: e.source });
    }
  });

  // Telegram notifications (no-op unless enabled in server.yaml). Created before the startup halt
  // below so that a halt after a crash is announced.
  telegram = new TelegramNotifier({
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
      const openBuys = orderRepo.findOpen(undefined, false).filter((o) => o.side === 'buy').reduce((n, o) => n + unfilledNotional(o), 0);
      return positions + openBuys;
    },
    stopBot: async (id, actor) => {
      if (!botManager) throw new Error('App is locked: unlock BotLab first');
      await botManager.stopBot(id, actor);
    },
    isRunning: (id) => botManager?.isRunning(id) ?? false,
    stateFile: path.join(getDataDir(), 'notify-state.json'),
  });
  notifications.attachConfig(configService);
  notifications.start();
  telegram.start();

  // Market cache (category, rules hash, ambiguity) and forecast ledger (scorer hourly, refresh every 30 min)
  const forecastRepo = new ForecastRepository(db);
  const feeLabels = new FeeService();
  const qty = 1e-9;
  marketCache = new MarketCacheService({
    repo: new MarketCacheRepository(db),
    getCategories: () => configService.getConfig()?.categories ?? defaultCategories(),
    feeCategoryFor: (labels) => feeLabels.feeCategoryFor(labels),
    audit,
    heldBy: (marketId) => [
      ...new Set(
        tradeRepo
          .getRiskPositions({ simulated: false, exchange: 'polymarket' })
          .filter((p) => p.condition_id === marketId && p.net_quantity > qty)
          .map((p) => p.bot_id)
      ),
    ],
    watchedMarketIds: () => [
      ...[false, true].flatMap((simulated) =>
        tradeRepo
          .getRiskPositions({ simulated, exchange: 'polymarket' })
          .filter((p) => p.net_quantity > qty && p.condition_id)
          .map((p) => p.condition_id as string)
      ),
      ...[false, true].flatMap((simulated) => orderRepo.findOpen(undefined, simulated).filter((o) => o.exchange === 'polymarket').map((o) => o.market_id)),
      ...forecastRepo.activeMarketIds(),
    ],
  });
  marketCache.on(MARKET_RULES_CHANGED_EVENT, (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(MARKET_RULES_CHANGED_EVENT, payload);
  });
  const cache = marketCache;
  configService.onChange((e) => {
    if (e.changes.some((c) => c.file === 'categories')) {
      const n = cache.recategorizeAll();
      console.log(`[Main] categories.yaml changed: ${n} cached market(s) re-categorized`);
    }
  });
  ledger = new LedgerService({
    forecastRepo,
    rightsRepo: new CategoryRightsRepository(db),
    marketCache,
    audit,
    getTopOfBook: (tokenId) => fetchPolymarketTop(settingsRepo.get().clob_http_url, tokenId),
    getMid: (tokenId) => fetchPolymarketMid(settingsRepo.get().clob_http_url, tokenId),
    getMandate: () => configService.getConfig()?.mandate ?? null,
    getLimits: () => configService.getConfig()?.limits ?? null,
  });
  registerLedgerHandlers(ledger, marketCache, (sender) => !!mainWindow && !mainWindow.isDestroyed() && sender.id === mainWindow.webContents.id);
  marketCache.start();
  ledger.start();

  // Order-book recorder (spec §10): bot scopes, active forecasts, held tokens, watchlist; never affects trading
  snapshotRepo = new OrderbookSnapshotRepository(db);
  recorder = new Recorder({
    repo: snapshotRepo,
    getSettings: () => configService.getConfig()?.server.recorder ?? null,
    heldTokens: () =>
      [false, true].flatMap((simulated) =>
        tradeRepo
          .getRiskPositions({ simulated, exchange: 'polymarket' })
          .filter((p) => p.net_quantity > qty)
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
    marketTokens: async (marketId) => (await cache.getMarket(marketId))?.tokens.map((t) => t.tokenId) ?? null,
    fetchBook: async (tokenId) => {
      const resp = await fetch(`${settingsRepo.get().clob_http_url.replace(/\/+$/, '')}/book?token_id=${encodeURIComponent(tokenId)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) throw new Error(`CLOB book HTTP ${resp.status}`);
      return (await resp.json()) as { bids?: Array<{ price: string; size: string }>; asks?: Array<{ price: string; size: string }>; last_trade_price?: string };
    },
  });
  recorder.start();
  registerReconcileHandlers({
    getReconciler: () => reconciler,
    snapshotRepo,
    audit,
    isTrustedSender: (sender) => !!mainWindow && !mainWindow.isDestroyed() && sender.id === mainWindow.webContents.id,
  });

  // Unclean previous shutdown ⇒ global halt (spec §4.3). Unreadable config ⇒ treated as true.
  const startHaltedAfterCrash: boolean | null = configService.getConfig()?.limits.server.start_halted_after_crash ?? null;
  shutdownMarker = new ShutdownMarker(getDataDir());
  applyStartupHalt({ marker: shutdownMarker, startHaltedAfterCrash, halts, audit });

  // 3. Seed script templates (compiles with esbuild)
  const templates = getBuiltinTemplates();
  const seeded = await seedTemplates(scriptRepo, templates);
  if (seeded > 0) {
    console.log(`[Main] Seeded ${seeded} script template(s)`);
  } else {
    console.log('[Main] Script templates already present');
  }

  // 4. Register auth handlers (available before window loads)
  registerAuthHandlers(settingsRepo, initializeProtectedServices);

  // 5. Register script handlers (not dependent on encryption key)
  registerScriptHandlers(scriptRepo, audit);

  // 6. Register settings handlers (read-only access doesn't need key)
  registerSettingsHandlers(settingsRepo);

  // 7. Register AI handlers (API key decrypted per-request)
  registerAiHandlers(settingsRepo);

  // 8. Register backtest handlers (no encryption key needed)
  registerBacktestHandlers(db, scriptRepo, backtestRepo, {
    snapshotRepo,
    getFeeRates: feeRatesFor,
    getMaxTtlMinutes: () => configService.getConfig()?.limits.orders.resting_order_ttl_minutes,
  });

  // 9. Risk handlers (halts, kill switch) — available before unlock
  registerRiskHandlers(halts, killSwitch, botRepo, (sender) => !!mainWindow && !mainWindow.isDestroyed() && sender.id === mainWindow.webContents.id);

  // 9b. Config handlers (human only, main window only)
  registerConfigHandlers(configService, (sender) => !!mainWindow && !mainWindow.isDestroyed() && sender.id === mainWindow.webContents.id);

  // 10. App info handlers
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:path', () => app.getPath('userData'));

  console.log('[Main] Phase A complete — auth handlers ready');
}

/**
 * Phase B: Post-auth initialization.
 * Called by authHandlers after successful password verification / setup.
 * Initializes WalletManager, BotManager, and registers protected IPC handlers.
 */
async function initializeProtectedServices(encryptionKey: string): Promise<void> {
  // Guard against double initialization
  if (botManager) {
    console.log('[Main] Protected services already initialized');
    return;
  }

  console.log('[Main] Phase B: Initializing protected services...');

  // 0. One-time re-encryption of legacy CryptoJS secrets to AES-256-GCM (idempotent, audited)
  try {
    migrateSecretsToV2(database, encryptionKey, audit);
  } catch (err) {
    console.error('[Main] Secret migration failed (legacy secrets stay readable):', err);
    audit.record('system', 'secrets.migrate_v2', null, { error: err instanceof Error ? err.message : String(err) }, 'error');
  }

  // 1. Initialize wallet manager with the derived encryption key
  const walletManager = new WalletManager(walletRepo, encryptionKey);
  console.log('[Main] WalletManager initialized');

  // 2. Initialize bot manager
  botManager = new BotManager(
    walletManager,
    botRepo,
    walletRepo,
    settingsRepo,
    scriptRepo,
    storageRepo,
    tradeRepo,
    {
      db: database,
      orderRepo,
      riskStateRepo,
      audit,
      config: configService,
      events: notifications,
      marketCache: marketCache ?? undefined,
      ledger: ledger ?? undefined,
      clock: clockGuard,
    }
  );
  await botManager.initialize();
  console.log('[Main] BotManager initialized');

  // 3. Startup recovery: sync and cancel orphaned open orders (no bot runs yet; starts are
  //    refused until this finishes). Runs in the background so unlocking is not blocked.
  const manager = botManager;
  manager.setRecoveryInProgress(true);
  recoverOpenOrders({ botRepo, canceller, audit, isBotRunning: (id) => manager.isRunning(id) })
    .catch((err) => {
      console.error('[Main] Startup order recovery failed:', err);
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
  const mc = marketCache;
  reconciler = new Reconciler({
    db: database,
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
    marketCache: mc ?? undefined,
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

  // 4. Forward bot events to renderer
  botManager.on('bot:event', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bot:event', event);

      // Also forward log events on the dedicated bot:log channel for the UI Logs tab
      if (event.type === 'log' && event.data) {
        mainWindow.webContents.send('bot:log', {
          botId: event.botId,
          timestamp: event.timestamp,
          level: event.data.level,
          message: event.data.message,
        });
      }
    }
  });

  // 5. Register protected IPC handlers (bots + wallets need encryption key)
  registerBotHandlers(botRepo, walletRepo, scriptRepo, tradeRepo, botManager, walletManager, storageRepo, settingsRepo, audit, orderRepo);
  registerWalletHandlers(walletRepo, walletManager, settingsRepo);

  console.log('[Main] Phase B complete — all services ready');
}

// App lifecycle
// One instance only: a second one would share the DB and overwrite the shutdown marker.
// It quits before touching either.
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  console.error('[Main] Another BotLab instance is running; quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (!hasInstanceLock) return;
  try {
    // Phase A: DB + repos + auth handlers
    await initializePhaseA();

    // Create window (React will call auth:status to decide what to show)
    await createWindow();

    // OS shutdown/logoff: run the graceful path so a reboot does not start halted.
    // Linux/macOS: powerMonitor 'shutdown' can delay it; Windows: 'session-end'.
    // (typed without the event, but Electron passes one whose preventDefault delays the shutdown)
    powerMonitor.on('shutdown', (event?: { preventDefault?: () => void }) => {
      event?.preventDefault?.();
      startGracefulShutdown();
    });

    app.on('activate', () => {
      // On macOS, re-create window when dock icon is clicked
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  } catch (error) {
    console.error('[Main] Failed to initialize:', error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Graceful shutdown: stop the risk monitor, stop all bots, then write the clean-shutdown marker
 * (spec §4.3). Electron does not await async listeners, so the quit is deferred until this
 * finishes; if it takes too long the app exits without the marker (next start is "unclean").
 */
const SHUTDOWN_TIMEOUT_MS = 20_000;
let shutdownStarted = false;
let shutdownDone = false;
let shutdownTimedOut = false;

async function gracefulShutdown(): Promise<void> {
  console.log('[Main] Shutting down...');
  if (riskMonitor) {
    await riskMonitor.stop().catch((error) => console.error('[Main] Error stopping risk monitor:', error));
  }
  await reconciler?.stop().catch((error) => console.error('[Main] Error stopping reconciler:', error));
  if (botManager) {
    await botManager.shutdown();
  }
  await recorder?.stop().catch((error) => console.error('[Main] Error stopping recorder:', error));
  await ledger?.stop().catch((error) => console.error('[Main] Error stopping ledger scorer:', error));
  await marketCache?.stop().catch((error) => console.error('[Main] Error stopping market cache:', error));
  if (shutdownTimedOut) return;
  await notifications?.stop().catch((error) => console.error('[Main] Error stopping notifications:', error));
  await telegram?.stop().catch((error) => console.error('[Main] Error stopping Telegram:', error));
  await configService?.stop().catch((error) => console.error('[Main] Error stopping config watcher:', error));
  try {
    shutdownMarker?.markClean();
    audit?.record('system', 'app.shutdown', null, undefined, 'clean');
  } catch (error) {
    console.error('[Main] Could not write clean-shutdown marker:', error);
  }
}

/** Starts the graceful shutdown once; quits the app when it is done (or timed out). */
function startGracefulShutdown(): void {
  if (shutdownStarted) return;
  shutdownStarted = true;

  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      console.error('[Main] Shutdown timed out; exiting without clean marker');
      shutdownTimedOut = true;
      resolve();
    }, SHUTDOWN_TIMEOUT_MS)
  );
  Promise.race([gracefulShutdown(), timeout])
    .catch((error) => console.error('[Main] Error during shutdown:', error))
    .finally(() => {
      closeDatabase();
      console.log('[Main] Shutdown complete');
      shutdownDone = true;
      app.quit();
    });
}

app.on('before-quit', (event) => {
  // Second instance: never initialised anything, nothing to shut down
  if (!hasInstanceLock || shutdownDone) return;
  event.preventDefault();
  startGracefulShutdown();
});

// Ctrl+C / service stop / Windows console close: quit gracefully (spec §15.2)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
  process.on(signal, () => app.quit());
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason);
});
