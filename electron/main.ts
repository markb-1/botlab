import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { initializeDatabase, closeDatabase, getDataDir } from './database/index';
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
} from './database/repositories/index';
import type { Database } from './database/index';
import { keyManager } from './security/keyManager';
import { WalletManager } from '../src/core/WalletManager';
import { BotManager } from '../src/core/BotManager';
import { registerAuthHandlers } from './ipc/handlers/authHandlers';
import { registerBotHandlers } from './ipc/handlers/botHandlers';
import { registerWalletHandlers } from './ipc/handlers/walletHandlers';
import { registerSettingsHandlers } from './ipc/handlers/settingsHandlers';
import { registerScriptHandlers } from './ipc/handlers/scriptHandlers';
import { registerAiHandlers } from './ipc/handlers/aiHandlers';
import { registerBacktestHandlers } from './ipc/handlers/backtestHandlers';
import { registerRiskHandlers } from './ipc/handlers/riskHandlers';
import { seedTemplates, getBuiltinTemplates } from './database/seed';
import { AuditService } from './audit/AuditService';
import { OrderCanceller } from './orders/OrderCanceller';
import { fetchPolymarketMid, bookMid } from './orders/MarketDataService';
import { HaltService, RISK_HALT_EVENT, RISK_HALT_CLEARED_EVENT, type BotControl } from './risk/HaltService';
import { KillSwitch } from './risk/KillSwitch';
import { RiskMonitor } from './risk/RiskMonitor';
import { ShutdownMarker, applyStartupHalt, recoverOpenOrders } from './risk/StartupRecovery';
import { loadLimits, resolveConfigDir } from './config';
import { getBinanceOrderBook } from './sdk/binance';

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

  // Unclean previous shutdown ⇒ global halt (spec §4.3). Unreadable config ⇒ treated as true.
  let startHaltedAfterCrash: boolean | null = null;
  try {
    startHaltedAfterCrash = loadLimits(resolveConfigDir()).server.start_halted_after_crash;
  } catch (err) {
    console.error('[Main] Could not read limits config for startup:', err);
    audit.record('system', 'config.load', resolveConfigDir(), { stage: 'startup', error: err instanceof Error ? err.message : String(err) }, 'error');
  }
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
  registerBacktestHandlers(db, scriptRepo, backtestRepo);

  // 9. Risk handlers (halts, kill switch) — available before unlock
  registerRiskHandlers(halts, killSwitch, botRepo);

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
    { db: database, orderRepo, riskStateRepo, audit }
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
  registerBotHandlers(botRepo, walletRepo, scriptRepo, tradeRepo, botManager, walletManager, storageRepo, settingsRepo, audit);
  registerWalletHandlers(walletRepo, walletManager, settingsRepo);

  console.log('[Main] Phase B complete — all services ready');
}

// App lifecycle
app.whenReady().then(async () => {
  try {
    // Phase A: DB + repos + auth handlers
    await initializePhaseA();

    // Create window (React will call auth:status to decide what to show)
    await createWindow();

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
  if (botManager) {
    await botManager.shutdown();
  }
  if (shutdownTimedOut) return;
  try {
    shutdownMarker?.markClean();
    audit?.record('system', 'app.shutdown', null, undefined, 'clean');
  } catch (error) {
    console.error('[Main] Could not write clean-shutdown marker:', error);
  }
}

app.on('before-quit', (event) => {
  if (shutdownDone) return;
  event.preventDefault();
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
