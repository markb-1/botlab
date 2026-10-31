/**
 * `npm run cli -- check-polymarket [--prod] [--json] [--with-credentials] [--binance] [--wallet <id|name|address>]
 * [--address <0x…>]`: can this machine / IP use the Polymarket endpoints BotLab depends on? The checks live in
 * core (`ops/connectivityCheck.ts`); this file is the CLI glue: proxy, database, master key, wallet.
 *
 * - Read-only throughout: GET requests only, no order placed or cancelled, no API key created.
 * - The database is opened **read-only** (no migrations, no key-check write), so the check is allowed while the
 *   server runs on the same data dir (SQLite WAL readers do not block it). Without a database the defaults are used.
 * - `--with-credentials`: the master key the server would use (`BOTLAB_MASTER_KEY`, `_FILE`, `<data dir>/master.key`;
 *   never generated here), checked against `settings.key_check`, decrypts the wallet's private key in this process
 *   only; the CLOB probes sign with it and print no key, secret or passphrase.
 * - `HTTPS_PROXY` / `HTTP_PROXY`: Node 22's fetch ignores them unless `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21), so the
 *   command re-runs itself with it; the report then says the results reflect the proxy's IP.
 */

import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { decrypt } from '../../../packages/core/src/security/crypto';
import { keyCheckMatches } from '../../../packages/core/src/security/masterKey';
import { createClobReadOnlyAuth } from '../../../packages/core/src/exchange/polymarket/authHeaders';
import { DEFAULT_CLOB_URL, formatReport, runConnectivityCheck, type ConnectivityOptions } from '../../../packages/core/src/ops/connectivityCheck';
import { defaultKeyFile, loadMasterKey } from './masterKey';

type Flags = Record<string, string | true>;

/** The proxy URL from the environment, as host:port (credentials never shown), or null */
export function envProxy(env: NodeJS.ProcessEnv = process.env): { raw: string; display: string } | null {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return { raw, display: `${u.hostname}${u.port ? `:${u.port}` : ''}` };
  } catch {
    return { raw, display: '(unparseable proxy URL)' };
  }
}

function nodeSupportsEnvProxy(version: string = process.versions.node): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 21);
}

function envProxyActive(): boolean {
  return process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy');
}

/**
 * When a proxy is configured but fetch would ignore it, re-run this command with `NODE_USE_ENV_PROXY=1` and
 * return its exit code; null to go on in this process.
 */
function reexecWithProxy(): number | null {
  if (!envProxy() || envProxyActive() || !nodeSupportsEnvProxy()) return null;
  // NODE_OPTIONS (not argv) also reaches a loader's own child process; the warning is Node's "experimental" notice
  const nodeOptions = [process.env.NODE_OPTIONS, '--disable-warning=UNDICI-EHPA'].filter(Boolean).join(' ');
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_OPTIONS: nodeOptions },
  });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

interface WalletRow {
  id: string;
  name: string;
  address: string;
  proxy_address: string | null;
  private_key_encrypted: string;
}

function openReadOnly(dbFile: string): Database.Database | null {
  if (!fs.existsSync(dbFile)) return null;
  try {
    return new Database(dbFile, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function settingsClobUrl(db: Database.Database | null): string | null {
  if (!db) return null;
  try {
    const row = db.prepare("SELECT clob_http_url FROM settings WHERE id = 'global'").get() as { clob_http_url?: string } | undefined;
    return row?.clob_http_url && /^https?:\/\//.test(row.clob_http_url) ? row.clob_http_url : null;
  } catch {
    return null;
  }
}

function pickWallet(db: Database.Database, which: string | undefined): { wallet: WalletRow; note: string | null } | string {
  const rows = db.prepare('SELECT id, name, address, proxy_address, private_key_encrypted FROM wallets ORDER BY created_at').all() as WalletRow[];
  if (rows.length === 0) return 'no wallet is configured in BotLab (add one in Wallets first)';
  if (which) {
    const w = rows.find(
      (r) => r.id === which || r.name === which || r.address.toLowerCase() === which.toLowerCase() || r.proxy_address?.toLowerCase() === which.toLowerCase()
    );
    return w ? { wallet: w, note: null } : `no wallet matches --wallet ${which}`;
  }
  return {
    wallet: rows[0],
    note: rows.length > 1 ? `${rows.length} wallets configured; using "${rows[0].name}" (choose with --wallet <id|name|address>)` : null,
  };
}

/** The read-only auth probe, or why it is skipped. Never throws for a missing key / wallet. */
function buildAuth(db: Database.Database | null, dataDir: string, flags: Flags): { auth: ConnectivityOptions['auth']; address?: string; notes: string[] } {
  const notes: string[] = [];
  if (!db) return { auth: { skip: `no BotLab database in ${dataDir} (use --data-dir, or --prod for the npm start location)` }, notes };
  const env = process.env;
  const hasKey = !!env.BOTLAB_MASTER_KEY || !!env.BOTLAB_MASTER_KEY_FILE || fs.existsSync(defaultKeyFile(dataDir));
  if (!hasKey) return { auth: { skip: 'no master key (BOTLAB_MASTER_KEY, BOTLAB_MASTER_KEY_FILE or <data dir>/master.key)' }, notes };
  let key: string;
  try {
    // production: true ⇒ never generates a key file here
    key = loadMasterKey({ dataDir, production: true, log: () => undefined }).key;
  } catch (err) {
    return { auth: { skip: `master key: ${err instanceof Error ? err.message : String(err)}` }, notes };
  }
  let picked: ReturnType<typeof pickWallet>;
  try {
    const row = db.prepare("SELECT key_check FROM settings WHERE id = 'global'").get() as { key_check: string | null } | undefined;
    if (row?.key_check && !keyCheckMatches(row.key_check, key)) return { auth: { skip: 'the master key does not match this database' }, notes };
    picked = pickWallet(db, typeof flags.wallet === 'string' ? flags.wallet : undefined);
  } catch (err) {
    return { auth: { skip: `cannot read the database: ${err instanceof Error ? err.message : String(err)}` }, notes };
  }
  if (typeof picked === 'string') return { auth: { skip: picked }, notes };
  if (picked.note) notes.push(picked.note);
  let privateKey: string;
  try {
    privateKey = decrypt(picked.wallet.private_key_encrypted, key);
  } catch {
    return { auth: { skip: `cannot decrypt the private key of wallet "${picked.wallet.name}" with this master key` }, notes };
  }
  return {
    auth: createClobReadOnlyAuth(privateKey, `wallet "${picked.wallet.name}" ${picked.wallet.address}`),
    address: picked.wallet.proxy_address || picked.wallet.address,
    notes,
  };
}

/** Runs the check; returns the exit code (0 ok, 1 blocked, 2 degraded). */
export async function checkPolymarketCommand(flags: Flags, dataDir: string): Promise<number> {
  const reexec = reexecWithProxy();
  if (reexec !== null) return reexec;

  const json = flags.json === true;
  const notes: string[] = [];
  const proxy = envProxy();
  if (proxy && !envProxyActive()) {
    notes.push(`HTTPS_PROXY is set but Node ${process.versions.node} cannot use it from fetch (needs ≥ 22.21): requests go out directly from this machine`);
  }

  const db = openReadOnly(path.join(dataDir, 'botlab.db'));
  try {
    const opts: ConnectivityOptions = {
      clobUrl: settingsClobUrl(db) ?? DEFAULT_CLOB_URL,
      binance: flags.binance === true,
      proxy: proxy && envProxyActive() ? proxy.display : null,
    };
    if (flags['with-credentials']) {
      const a = buildAuth(db, dataDir, flags);
      opts.auth = a.auth;
      if (a.address) opts.sampleAddress = a.address;
      notes.push(...a.notes);
    }
    if (typeof flags.address === 'string') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(flags.address)) throw new Error('--address must be a 0x address');
      opts.sampleAddress = flags.address;
    }
    if (!json) console.log('Checking Polymarket endpoints (read-only, ~10 s timeout each)…\n');
    const report = await runConnectivityCheck(opts);
    if (json) console.log(JSON.stringify({ ...report, notes }, null, 2));
    else {
      console.log(formatReport(report));
      for (const n of notes) console.log(`Note: ${n}`);
    }
    return report.verdict.exitCode;
  } finally {
    db?.close();
  }
}
