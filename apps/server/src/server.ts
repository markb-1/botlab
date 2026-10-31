/**
 * Server lifecycle (spec §1.2, §8, §15): data dir + instance lock → master key → `createCore` →
 * `start()` → `unlock(masterKey)` → HTTP listen. `close()` stops the HTTP server and SSE streams, then
 * `core.shutdown()` (clean-shutdown marker) and `core.close()`.
 *
 * A key that does not match the database (or secrets still under the old password-derived key) leaves
 * the core locked: the server still runs, the UI shows the reason, `/healthz` reports 503.
 */

import type { AddressInfo } from 'net';
import path from 'path';
import { serve, type ServerType } from '@hono/node-server';
import { createCore, type Core } from '../../../packages/core/src/core';
import { legacyConfigDirWarning, resolveConfigDir } from '../../../packages/core/src/config/loader';
import { createApp } from './app';
import { listSecrets } from '../../../packages/core/src/security/migrateSecrets';
import { loadMasterKey, type LoadedMasterKey } from './masterKey';
import { acquireInstanceLock } from './instanceLock';
import { isProduction, resolveDataDir, resolveWebDir } from './paths';

export interface ServerOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides BOTLAB_DATA_DIR / defaults */
  dataDir?: string;
  configDir?: string;
  templatesDir?: string;
  /** Overrides BOTLAB_HOST / server.yaml */
  host?: string;
  /** Overrides BOTLAB_PORT / server.yaml; 0 = any free port */
  port?: number;
  /** null disables static serving; default: resolveWebDir() */
  webDir?: string | null;
  /** Default true */
  backups?: boolean;
  log?: (msg: string) => void;
}

export interface RunningServer {
  core: Core;
  url: string;
  host: string;
  port: number;
  dataDir: string;
  masterKey: Omit<LoadedMasterKey, 'key'>;
  lockReason: string | null;
  /** The first-run setup code printed at boot (null when an admin password exists) */
  setupCode: string | null;
  /** Graceful stop; `clean` is false when the core shutdown timed out */
  close(opts?: { timeoutMs?: number }): Promise<{ clean: boolean }>;
}

function envPort(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`BOTLAB_PORT must be a port number, got "${v}"`);
  return n;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(m));
  const production = isProduction(env);
  const dataDir = opts.dataDir ?? resolveDataDir(env);
  const configDir = opts.configDir ?? resolveConfigDir(env);

  const releaseLock = acquireInstanceLock(dataDir);
  let core: Core | null = null;
  try {
    // Fatal before anything starts: no usable master key (missing in production, malformed)
    const master = loadMasterKey({ env, dataDir, production, log });

    // Daily log files (core logger) in <data dir>/logs unless BOTLAB_LOG_DIR says otherwise
    if (!process.env.BOTLAB_LOG_DIR) process.env.BOTLAB_LOG_DIR = env.BOTLAB_LOG_DIR || path.join(dataDir, 'logs');
    log(`[Server] Data dir: ${dataDir}`);
    log(`[Server] Config dir: ${configDir}`);
    const legacyWarning = opts.configDir ? null : legacyConfigDirWarning(env);
    if (legacyWarning) {
      const bar = '!'.repeat(78);
      log(`${bar}\n[Server] WARNING: ${legacyWarning}\n${bar}`);
    }
    core = createCore({ dataDir, configDir, ...(opts.templatesDir ? { templatesDir: opts.templatesDir } : {}), backups: opts.backups ?? true });
    const c = core;
    await c.start();

    let lockReason: string | null = null;
    let unlockedAt: number | null = null;
    try {
      await c.unlock(master.key);
      unlockedAt = Date.now();
      log(`[Server] Unlocked with the master key from ${master.source === 'env' ? 'BOTLAB_MASTER_KEY' : master.file}`);
    } catch (err) {
      lockReason = err instanceof Error ? err.message : String(err);
      console.error(`[Server] Core stays LOCKED: ${lockReason}`);
    }

    const http = c.configService.getConfig()?.server.http;
    const host = opts.host ?? (env.BOTLAB_HOST || http?.host || '127.0.0.1');
    const port = opts.port ?? envPort(env.BOTLAB_PORT) ?? http?.port ?? 3780;
    const allowedHosts = [
      ...(http?.allowed_hosts ?? []),
      ...(env.BOTLAB_ALLOWED_HOSTS ?? '')
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean),
      host,
    ];
    const webDir = opts.webDir === undefined ? resolveWebDir(env) : opts.webDir;

    const loopbackOnly = host === 'localhost' || host === '::1' || /^127\./.test(host);
    const { app, sse } = createApp({ core: c, webDir, allowedHosts, loopbackOnly, lockReason: () => lockReason, unlockedAt: () => unlockedAt });

    // First run: a one-time setup code guards /api/auth/setup against whoever reaches the UI first
    let setupCode: string | null = null;
    if (!c.auth.hasAdminPassword()) {
      setupCode = c.auth.createSetupCode();
      const bar = '='.repeat(72);
      log(`${bar}\n[Server] FIRST RUN: no admin password yet. Setup code: ${setupCode}\n` +
        `  Open the UI and choose a password${loopbackOnly ? ' (from this machine the code is not needed)' : '; enter this code on the setup screen'}.\n${bar}`);
      if (listSecrets(c.db).length > 0) {
        console.warn(
          `[Server] WARNING: this database holds wallet keys / exchange credentials but has NO admin password. ` +
            'Anyone who can reach the UI and has the setup code can take it over: set the password now (or `npm run cli -- set-password`).'
        );
      }
    }

    const server: ServerType = await new Promise((resolve, reject) => {
      const s = serve({ fetch: app.fetch, hostname: host, port }, () => resolve(s));
      s.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    const shownHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    const url = `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : shownHost}:${address.port}`;
    log(`[Server] Listening on http://${shownHost}:${address.port}${webDir ? '' : ' (API only: web UI not built)'}`);
    if (host === '0.0.0.0' || host === '::') {
      console.warn(
        `[Server] WARNING: bound to ${host} — reachable from every network interface. BotLab must never be exposed publicly: ` +
          'use 127.0.0.1, the Tailscale IP, or a firewall / Docker port mapping to 127.0.0.1 (spec §8.2).'
      );
    }

    let closing: Promise<{ clean: boolean }> | null = null;
    const close = (closeOpts: { timeoutMs?: number } = {}): Promise<{ clean: boolean }> => {
      if (closing) return closing;
      closing = (async () => {
        log('[Server] Shutting down...');
        sse.closeAll();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          // Idle keep-alive sockets would hold close() open
          (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
          setTimeout(() => {
            (server as { closeAllConnections?: () => void }).closeAllConnections?.();
            resolve();
          }, 2000).unref();
        });
        const result = await c.shutdown({ timeoutMs: closeOpts.timeoutMs ?? 20_000 });
        c.close();
        releaseLock();
        log(`[Server] Stopped${result.clean ? '' : ' (shutdown timed out: next start is treated as unclean)'}`);
        return result;
      })();
      return closing;
    };

    const { key: _key, ...masterInfo } = master;
    void _key;
    return { core: c, url, host, port: address.port, dataDir, masterKey: masterInfo, lockReason, setupCode, close };
  } catch (err) {
    if (core) {
      await core.shutdown({ timeoutMs: 10_000 }).catch(() => undefined);
      core.close();
    }
    releaseLock();
    throw err;
  }
}
