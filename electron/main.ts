import { app, BrowserWindow, ipcMain, powerMonitor, type WebContents } from 'electron';
import path from 'path';
import { createCore, CORE_EVENTS, type Core } from '../packages/core/src/core';
import { registerAuthHandlers } from './ipc/handlers/authHandlers';
import { registerBotHandlers } from './ipc/handlers/botHandlers';
import { registerWalletHandlers } from './ipc/handlers/walletHandlers';
import { registerSettingsHandlers } from './ipc/handlers/settingsHandlers';
import { registerScriptHandlers } from './ipc/handlers/scriptHandlers';
import { registerAiHandlers } from './ipc/handlers/aiHandlers';
import { registerBacktestHandlers } from './ipc/handlers/backtestHandlers';
import { registerRiskHandlers } from './ipc/handlers/riskHandlers';
import { registerLedgerHandlers } from './ipc/handlers/ledgerHandlers';
import { registerConfigHandlers } from './ipc/handlers/configHandlers';
import { registerReconcileHandlers } from './ipc/handlers/reconcileHandlers';

// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

/**
 * Electron shell over `@botlab/core` (packages/core): single-instance lock, window, IPC registration
 * and quit handling. All domain logic and the pre/post-unlock lifecycle live in core (`createCore`).
 */

let mainWindow: BrowserWindow | null = null;
let core: Core | null = null;

const isDev = !app.isPackaged;

/** Only the app's main window may perform human-only actions (R27) */
const isTrustedSender = (sender: WebContents): boolean => !!mainWindow && !mainWindow.isDestroyed() && sender.id === mainWindow.webContents.id;

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
 * Before the window: core with everything that needs no wallet keys (config, halts, kill switch,
 * ledger, recorder, ...) and the IPC that works before unlock. Bot and wallet IPC are registered
 * after unlock (auth handlers → `onUnlock`).
 */
async function initialize(): Promise<void> {
  console.log('[Main] Starting core...');
  const c = createCore({ dataDir: app.getPath('userData') });
  core = c;

  // Core events → renderer (same channel names as before)
  for (const channel of CORE_EVENTS) {
    c.events.on(channel, (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    });
  }

  await c.start();

  const { services } = c;
  registerAuthHandlers(c.repos.settingsRepo, onUnlock);
  registerScriptHandlers(services.scripts);
  registerSettingsHandlers(services.settings, c.repos.settingsRepo);
  registerAiHandlers(c.repos.settingsRepo);
  registerBacktestHandlers(services.backtests);
  // Halts and the kill switch are available before unlock (R22)
  registerRiskHandlers(services.risk, isTrustedSender);
  registerConfigHandlers(services.config, isTrustedSender);
  registerLedgerHandlers(services.ledger, services.markets, isTrustedSender);
  registerReconcileHandlers(services.reconcile, isTrustedSender);

  // App info handlers
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:path', () => app.getPath('userData'));

  console.log('[Main] Core started — auth handlers ready');
}

/** Called by the auth handlers after password verification / setup. */
async function onUnlock(encryptionKey: string): Promise<void> {
  if (!core) throw new Error('Core not started');
  const firstUnlock = await core.unlock(encryptionKey);
  if (firstUnlock) {
    registerBotHandlers(core.services.bots);
    registerWalletHandlers(core.services.wallets);
  }
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
    await initialize();

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
 * Graceful shutdown (core: stop monitor, bots, jobs, then the clean-shutdown marker, spec §4.3).
 * Electron does not await async listeners, so the quit is deferred until this finishes; if it takes
 * too long the app exits without the marker (next start is "unclean").
 */
const SHUTDOWN_TIMEOUT_MS = 20_000;
let shutdownStarted = false;
let shutdownDone = false;

/** Starts the graceful shutdown once; quits the app when it is done (or timed out). */
function startGracefulShutdown(): void {
  if (shutdownStarted) return;
  shutdownStarted = true;

  const done = core ? core.shutdown({ timeoutMs: SHUTDOWN_TIMEOUT_MS }) : Promise.resolve({ clean: true });
  done
    .catch((error) => console.error('[Main] Error during shutdown:', error))
    .finally(() => {
      core?.close();
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
