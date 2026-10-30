import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { initializeDatabase, closeDatabase } from './database/index';
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
import { seedTemplates, getBuiltinTemplates } from './database/seed';

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
  registerScriptHandlers(scriptRepo);

  // 6. Register settings handlers (read-only access doesn't need key)
  registerSettingsHandlers(settingsRepo);

  // 7. Register AI handlers (API key decrypted per-request)
  registerAiHandlers(settingsRepo);

  // 8. Register backtest handlers (no encryption key needed)
  registerBacktestHandlers(db, scriptRepo, backtestRepo);

  // 9. App info handlers
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
    { db: database, orderRepo, riskStateRepo }
  );
  await botManager.initialize();
  console.log('[Main] BotManager initialized');

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
  registerBotHandlers(botRepo, walletRepo, scriptRepo, tradeRepo, botManager, walletManager, storageRepo, settingsRepo);
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

app.on('before-quit', async () => {
  console.log('[Main] Shutting down...');

  // Gracefully stop all bots
  if (botManager) {
    try {
      await botManager.shutdown();
    } catch (error) {
      console.error('[Main] Error during bot shutdown:', error);
    }
  }

  // Close database
  closeDatabase();
  console.log('[Main] Shutdown complete');
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason);
});
