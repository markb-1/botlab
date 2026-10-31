/**
 * HTTP client for the BotLab server (spec §8.1). Same exported functions as the former Electron IPC
 * wrapper (`electronApi.ts`); every call goes to `/api/*` with the session cookie, and real-time
 * events arrive over one shared EventSource (`/api/events`).
 *
 * Responses use the IPC envelope `{ success, data?, error?, message?, code? }`. Mutations send the
 * `X-BotLab: 1` header the server requires as CSRF protection. Human-only admin actions answer
 * `reauth_required` when the session's password check is older than 15 minutes: the call then asks the
 * registered re-auth handler (a password dialog) and retries once.
 */

export interface ApiEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  /** Machine-readable error code (`unauthenticated`, `reauth_required`, `forbidden`, `not_found`, ...) */
  code?: string;
}

export class ApiError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

// ── Session / re-auth hooks (set by the app shell) ────────────────────────

type ReauthHandler = () => Promise<boolean>;
let reauthHandler: ReauthHandler | null = null;
let unauthenticatedHandler: (() => void) | null = null;

/** The UI registers a password prompt; it resolves true once `/api/auth/reauth` succeeded. */
export function setReauthHandler(handler: ReauthHandler | null): void {
  reauthHandler = handler;
}

/** Called when the server says the session is gone (expired or logged out elsewhere). */
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  unauthenticatedHandler = handler;
}

// ── Core request helpers ──────────────────────────────────────────────────

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function qs(params?: Record<string, unknown>): string {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function send<T>(method: Method, path: string, body?: unknown, retried = false): Promise<ApiEnvelope<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-BotLab'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let resp: Response;
  try {
    resp = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return { success: false, error: `Server unreachable: ${err instanceof Error ? err.message : String(err)}`, code: 'network' };
  }
  let env: ApiEnvelope<T>;
  try {
    env = (await resp.json()) as ApiEnvelope<T>;
  } catch {
    env = { success: resp.ok, error: resp.ok ? undefined : `HTTP ${resp.status}` };
  }
  if (!env.success && env.code === 'reauth_required' && !retried && reauthHandler) {
    if (await reauthHandler()) return send<T>(method, path, body, true);
  }
  if (!env.success && resp.status === 401 && env.code === 'unauthenticated' && !path.startsWith('/auth/')) {
    unauthenticatedHandler?.();
  }
  return env;
}

/** Throws on `{ success: false }`, returns `data` */
async function call<T = any>(method: Method, path: string, body?: unknown): Promise<T> {
  const env = await send<T>(method, path, body);
  if (!env.success) throw new ApiError(env.error || 'Unknown error', env.code);
  return env.data as T;
}

/** Returns the whole envelope (callers that show `message`) */
function raw<T = any>(method: Method, path: string, body?: unknown): Promise<ApiEnvelope<T>> {
  return send<T>(method, path, body);
}

const enc = encodeURIComponent;

// ── Auth ──────────────────────────────────────────────────────────────────

export interface SessionInfo {
  /** No admin password yet: show the first-run setup screen */
  needsSetup: boolean;
  authenticated: boolean;
  scope: 'admin' | 'agent' | 'readonly' | null;
  /** The password was checked less than 15 minutes ago (human-only admin actions) */
  recentAuth: boolean;
  /** The core holds the master key (wallets and bots available) */
  unlocked: boolean;
  /** Why the core is locked (e.g. the master key does not match this database) */
  lockReason: string | null;
}

export const authApi = {
  session: (): Promise<SessionInfo> => call('GET', '/auth/session'),
  setup: (data: { password: string }): Promise<SessionInfo> => call('POST', '/auth/setup', data),
  login: (data: { password: string }): Promise<SessionInfo> => call('POST', '/auth/login', data),
  logout: (): Promise<void> => call('POST', '/auth/logout'),
  reauth: (data: { password: string }): Promise<SessionInfo> => call('POST', '/auth/reauth', data),
  changePassword: (data: { currentPassword: string; newPassword: string }): Promise<void> => call('POST', '/auth/password', data),
};

// ── Bots ──────────────────────────────────────────────────────────────────

export const botApi = {
  list: (filter?: { scriptId?: string; status?: string }) => call('GET', `/bots${qs(filter)}`),
  get: (id: string) => call('GET', `/bots/${enc(id)}`),
  create: (data: { name: string; scriptId: string; walletId?: string; config?: Record<string, unknown>; mode?: 'live' | 'paper' }) => call('POST', '/bots', data),
  update: (id: string, data: { name?: string; config?: Record<string, unknown>; enabled?: boolean; walletId?: string }) => call('PATCH', `/bots/${enc(id)}`, data),
  delete: (id: string) => call('DELETE', `/bots/${enc(id)}`),
  start: (id: string) => call('POST', `/bots/${enc(id)}/start`),
  stop: (id: string) => call('POST', `/bots/${enc(id)}/stop`),
  restart: (id: string) => call('POST', `/bots/${enc(id)}/restart`),
  getTrades: (botId: string, hours?: number) => call('GET', `/bots/${enc(botId)}/trades${qs({ hours })}`),
  getAllTrades: (hours?: number) => call('GET', `/trades${qs({ hours })}`),
  getPositions: (botId: string) => call('GET', `/bots/${enc(botId)}/positions`),
  getStats: (botId: string) => call('GET', `/bots/${enc(botId)}/stats`),
  getDashboardStats: () => call('GET', '/dashboard/stats'),
};

// ── Wallets ───────────────────────────────────────────────────────────────

export const walletApi = {
  list: (filter?: { available?: boolean }) => call('GET', `/wallets${qs(filter)}`),
  get: (id: string) => call('GET', `/wallets/${enc(id)}`),
  create: (data: { name: string; address: string; privateKey: string; proxyAddress?: string }) => call('POST', '/wallets', data),
  update: (id: string, data: { name?: string; proxyAddress?: string }) => call('PATCH', `/wallets/${enc(id)}`, data),
  delete: (id: string) => call('DELETE', `/wallets/${enc(id)}`),
  getBalance: (id: string) => call('GET', `/wallets/${enc(id)}/balance`),
};

// ── Settings ──────────────────────────────────────────────────────────────

export const settingsApi = {
  get: () => call('GET', '/settings'),
  update: (data: Record<string, unknown>) => call('PATCH', '/settings', data),
  testRpc: () => raw('POST', '/settings/rpc/test'),
  testClob: () => raw('POST', '/settings/clob/test'),
  saveBinance: (data: { apiKey: string; apiSecret: string }) => raw('PUT', '/settings/binance', data),
  clearBinance: () => raw('DELETE', '/settings/binance'),
  testBinance: (data?: { apiKey: string; apiSecret: string }) => raw('POST', '/settings/binance/test', data ?? {}),
};

// ── Scripts ───────────────────────────────────────────────────────────────

/** Opens the browser's file picker; resolves with the chosen files (empty when cancelled). */
function pickFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.style.display = 'none';
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}

function downloadJson(fileName: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const scriptApi = {
  list: () => call('GET', '/scripts'),
  get: (id: string) => call('GET', `/scripts/${enc(id)}`),
  create: (data: { name: string; description?: string; source: string; configSchema?: Record<string, unknown> }) => call('POST', '/scripts', data),
  update: (id: string, data: { name?: string; description?: string; source?: string; configSchema?: Record<string, unknown> }) => call('PATCH', `/scripts/${enc(id)}`, data),
  delete: (id: string) => call('DELETE', `/scripts/${enc(id)}`),
  getSchema: (id: string) => call('GET', `/scripts/${enc(id)}/schema`),
  compile: (source: string): Promise<{ compiled: boolean; error?: string }> => call('POST', '/scripts/compile', { source }),
  fork: (id: string, newName?: string) => call('POST', `/scripts/${enc(id)}/fork`, { newName }),
  /** Downloads the script as a `.botlab` file */
  export: async (id: string): Promise<{ exported: boolean; filePath?: string }> => {
    const { fileName, file } = await call<{ fileName: string; file: unknown }>('GET', `/scripts/${enc(id)}/export`);
    downloadJson(fileName, file);
    return { exported: true, filePath: fileName };
  },
  /** Lets the user pick `.botlab` files and imports them */
  import: async () => {
    const picked = await pickFiles('.botlab,application/json');
    if (picked.length === 0) return { imported: 0, scripts: [] };
    const files = await Promise.all(picked.map(async (f) => ({ name: f.name, content: await f.text() })));
    return call('POST', '/scripts/import', { files });
  },
};

// ── Backtests ─────────────────────────────────────────────────────────────

export const backtestApi = {
  run: (data: {
    scriptId: string;
    symbol?: string;
    interval?: string;
    startTime: number;
    endTime: number;
    initialBalance: number;
    config?: Record<string, unknown>;
    source?: 'binance-klines' | 'polymarket-snapshots';
    tokenIds?: string[];
  }) => call('POST', '/backtests', data),
  list: (scriptId?: string) => call('GET', `/backtests${qs({ scriptId })}`),
  get: (runId: string) => call('GET', `/backtests/${enc(runId)}`),
  delete: (runId: string) => call('DELETE', `/backtests/${enc(runId)}`),
};

// ── Risk, config, ledger, markets, reconciler (pages in chunk 3c) ─────────

type ConfigFile = 'limits' | 'mandate' | 'fees' | 'server' | 'categories';

export const riskApi = {
  getState: () => call('GET', '/risk/state'),
  /** Human only; needs a password check within the last 15 minutes */
  clearHalt: (scope: string, reason: string) => call('POST', '/risk/clear-halt', { scope, reason }),
  killSwitch: (reason: string) => call('POST', '/risk/kill-switch', { reason }),
};

export const configApi = {
  get: () => call('GET', '/config'),
  write: (file: ConfigFile, value: unknown, expectedSha256?: string) => call('PUT', `/config/${file}`, { value, expectedSha256 }),
  history: (file: ConfigFile) => call('GET', `/config/${file}/history`),
  restore: (file: ConfigFile, versionId: string) => call('POST', `/config/${file}/restore`, { versionId }),
};

export const ledgerApi = {
  submitForecast: (input: { tokenId: string; probability: number; rationale: string; sources: string[]; ambiguityScore: number }) => call('POST', '/ledger/forecasts', input),
  withdrawForecast: (id: string, reason: string) => call('POST', `/ledger/forecasts/${enc(id)}/withdraw`, { reason }),
  list: (filter?: { status?: string | string[]; category?: string; horizonBucket?: string; marketId?: string; tokenId?: string; tradeableOnly?: boolean; limit?: number }) =>
    call('GET', `/ledger/forecasts${qs(filter)}`),
  stats: () => call('GET', '/ledger/stats'),
  setRightsState: (category: string, bucket: string, state: string, reason: string) => call('POST', '/ledger/rights', { category, bucket, state, reason }),
};

export const marketApi = {
  get: (marketId: string) => call('GET', `/markets/${enc(marketId)}`),
  setAmbiguity: (marketId: string, score: number, note?: string) => call('POST', `/markets/${enc(marketId)}/ambiguity`, { score, note }),
};

export const reconcileApi = {
  status: () => call('GET', '/reconcile/status'),
  adoptPositions: (walletId: string, botId: string, opts?: { includePostFirstOrder?: boolean }) => call('POST', '/reconcile/adopt', { walletId, botId, ...opts }),
  watchlistList: () => call('GET', '/recorder/watchlist'),
  watchlistAdd: (tokenId: string, marketId?: string, note?: string) => call('POST', '/recorder/watchlist', { tokenId, marketId, note }),
  watchlistRemove: (tokenId: string) => call('DELETE', `/recorder/watchlist/${enc(tokenId)}`),
};

// ── Real-time events (SSE) ────────────────────────────────────────────────

type Listener = (payload: any) => void;
const listeners = new Map<string, Set<Listener>>();
let source: EventSource | null = null;

const EVENT_NAMES = ['bot:event', 'bot:log', 'risk:halt', 'risk:halt-cleared', 'config:changed', 'market:rulesChanged'] as const;
export type ServerEventName = (typeof EVENT_NAMES)[number];

function ensureSource(): void {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/events', { withCredentials: true });
  for (const name of EVENT_NAMES) {
    source.addEventListener(name, (e) => {
      let payload: unknown;
      try {
        payload = JSON.parse((e as MessageEvent<string>).data);
      } catch {
        return;
      }
      for (const fn of listeners.get(name) ?? []) fn(payload);
    });
  }
}

function closeSourceIfIdle(): void {
  if (source && [...listeners.values()].every((s) => s.size === 0)) {
    source.close();
    source = null;
  }
}

/** Subscribe to a server event; returns the unsubscribe function. The EventSource reconnects by itself. */
export function onServerEvent(name: ServerEventName, callback: Listener): () => void {
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  set.add(callback);
  ensureSource();
  return () => {
    set.delete(callback);
    closeSourceIfIdle();
  };
}

/** Closes the event stream (logout) */
export function closeEvents(): void {
  source?.close();
  source = null;
}

export const events = {
  onBotEvent: (callback: Listener) => onServerEvent('bot:event', callback),
  onBotLog: (callback: Listener) => onServerEvent('bot:log', callback),
  onRiskHalt: (callback: Listener) => onServerEvent('risk:halt', callback),
  onRiskHaltCleared: (callback: Listener) => onServerEvent('risk:halt-cleared', callback),
  onConfigChanged: (callback: Listener) => onServerEvent('config:changed', callback),
  onMarketRulesChanged: (callback: Listener) => onServerEvent('market:rulesChanged', callback),
};
