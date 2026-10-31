/**
 * BotLab server entrypoint (`npm run dev` via tsx, `npm start` / Docker / Windows service via the
 * compiled `dist/apps/server/src/main.js`).
 *
 * Graceful shutdown (spec §15.2) on SIGINT (Ctrl+C; also what NSSM sends when the Windows service
 * stops), SIGTERM (Docker, systemd, launchd), SIGBREAK (Ctrl+Break on Windows) and SIGHUP (on Windows:
 * the console window was closed, and Windows kills the process ~10 s later; elsewhere: the terminal
 * went away). Never used for config reload — that is the file watcher. A second signal (more than 2 s
 * after the first) exits at once.
 */

import dotenv from 'dotenv';
import { startServer, type RunningServer } from './server';
import { MasterKeyError } from './masterKey';

// `npm start` passes --production (no cross-env: one process less between the terminal and the server)
if (process.argv.includes('--production')) process.env.NODE_ENV = 'production';
dotenv.config();

const SHUTDOWN_TIMEOUT_MS = 20_000;
/** Windows console close leaves ~10 s before the process is killed */
const CONSOLE_CLOSE_TIMEOUT_MS = 7_000;

let server: RunningServer | null = null;
let stopping = false;
let firstSignalAt = 0;
/** Ctrl+C reaches the whole process group and npm forwards it too: repeats within this window are one signal */
const REPEAT_WINDOW_MS = 2_000;

function stop(signal: string): void {
  if (stopping) {
    if (Date.now() - firstSignalAt < REPEAT_WINDOW_MS) return;
    console.error(`[Server] ${signal} again: exiting immediately (next start is treated as unclean)`);
    process.exit(1);
  }
  stopping = true;
  firstSignalAt = Date.now();
  console.log(`[Server] ${signal} received`);
  const timeoutMs = signal === 'SIGHUP' && process.platform === 'win32' ? CONSOLE_CLOSE_TIMEOUT_MS : SHUTDOWN_TIMEOUT_MS;
  const done = server ? server.close({ timeoutMs }) : Promise.resolve({ clean: true });
  done
    .catch((err) => console.error('[Server] Error during shutdown:', err))
    .finally(() => process.exit(0));
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
  try {
    process.on(signal, () => stop(signal));
  } catch {
    /* signal not supported on this platform */
  }
}

process.on('uncaughtException', (error) => {
  console.error('[Server] Uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection:', reason);
});

startServer()
  .then((s) => {
    server = s;
    if (stopping) void s.close().finally(() => process.exit(0));
    else console.log(`[Server] BotLab ready: ${s.url}`);
  })
  .catch((err) => {
    console.error(err instanceof MasterKeyError ? `[Server] ${err.message}` : '[Server] Failed to start:');
    if (!(err instanceof MasterKeyError)) console.error(err);
    process.exit(1);
  });
