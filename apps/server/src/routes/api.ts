/**
 * HTTP API routes (spec §8.1): one route per former IPC channel, calling the core services with
 * input parsed by the shared schemas (`services/schemas.ts`) and the actor derived from the principal.
 *
 * Scopes (spec §8.2, §4.6, §7.3): GET routes are open to admin and readonly tokens unless noted;
 * mutations are admin-only. Wallets, settings (credentials, API keys) and script export are admin-only
 * even for reads (`ADMIN`). The agent scope is granted only where the MCP tool list of §7.3 has a
 * counterpart (scripts, backtests, bot create/update(config only)/start/stop, forecasts, kill switch,
 * recorder watchlist and read routes); never wallets, credentials, settings, config writes or anything
 * in §4.6. Human-only admin actions (§4.6: clear halt, config write/restore, adopt, set ambiguity, force
 * rights; wallets and exchange credentials; settings; API tokens) also need a password check within
 * 15 minutes (`recentAuth`).
 *
 * Read routes added for the 3c pages: `/api/risk/overview` (get_overview; all scopes), `/api/audit`
 * (admin + readonly), `/api/config/schema` (admin + readonly), `/api/config/:file/preview` and
 * `/api/config/:file/history/:versionId` (admin session only), script versions, bot orders, forecast by
 * id and market search (all scopes), `/api/reconcile/adopt/preview` (admin session only; syncs the wallet's orders, adopts nothing).
 */

import type { CoreServices } from '../../../../packages/core/src/core';
import {
  AdoptPositionsSchema,
  BacktestRunSchema,
  BinanceCredentialsSchema,
  BotCreateSchema,
  BotListFilterSchema,
  BotUpdateSchema,
  ClearHaltSchema,
  ConfigFileSchema,
  ForecastListFilterSchema,
  KillSwitchSchema,
  ScriptCreateSchema,
  ScriptImportSchema,
  ScriptUpdateSchema,
  SetRightsStateSchema,
  SettingsUpdateSchema,
  WalletCreateSchema,
  WalletListFilterSchema,
  WalletUpdateSchema,
  WatchlistAddSchema,
  parseInput,
} from '../../../../packages/core/src/services/schemas';
import type { ForecastFilter } from '../../../../packages/core/src/db/repositories/ForecastRepository';
import type { CategoryRightsState, HorizonBucket } from '../../../../packages/core/src/risk/types';
import { z } from 'zod';
import { ServiceError } from '../../../../packages/core/src/services/errors';
import { queryBool, queryNumber, type RouteDef } from '../http/routes';
import type { Principal, Scope } from '../http/principal';
import { HttpError } from '../http/respond';

const READ_ALL: Scope[] = ['admin', 'readonly', 'agent'];
const ADMIN_AGENT: Scope[] = ['admin', 'agent'];
const ADMIN: Scope[] = ['admin'];

// ── Bots ────────────────────────────────────────────────────────────────

export function botRoutes(bots: CoreServices['bots']): RouteDef[] {
  return [
    {
      method: 'get',
      path: '/api/bots',
      allow: READ_ALL,
      handler: ({ query }) => bots.list(parseInput(BotListFilterSchema, { scriptId: query('scriptId'), status: query('status') })),
    },
    { method: 'get', path: '/api/dashboard/stats', handler: () => bots.dashboardStats() },
    { method: 'get', path: '/api/trades', handler: ({ query }) => bots.allTrades(queryNumber(query('hours'))) },
    { method: 'get', path: '/api/bots/:id', allow: READ_ALL, handler: ({ param }) => bots.get(param('id')) },
    { method: 'post', path: '/api/bots', allow: ADMIN_AGENT, domainErrors: 'conflict', handler: ({ body, actor }) => bots.create(parseInput(BotCreateSchema, body), actor()) },
    { method: 'patch', path: '/api/bots/:id', allow: ADMIN_AGENT, domainErrors: 'conflict', handler: ({ param, body, actor }) => bots.update(param('id'), parseInput(BotUpdateSchema, body), actor()) },
    { method: 'delete', path: '/api/bots/:id', domainErrors: 'conflict', handler: ({ param, actor }) => bots.delete(param('id'), actor()) },
    { method: 'post', path: '/api/bots/:id/start', allow: ADMIN_AGENT, domainErrors: 'conflict', handler: ({ param, actor }) => bots.start(param('id'), actor()) },
    { method: 'post', path: '/api/bots/:id/stop', allow: ADMIN_AGENT, domainErrors: 'conflict', handler: ({ param, actor }) => bots.stop(param('id'), actor()) },
    { method: 'post', path: '/api/bots/:id/restart', allow: ADMIN_AGENT, domainErrors: 'conflict', handler: ({ param, actor }) => bots.restart(param('id'), actor()) },
    { method: 'get', path: '/api/bots/:id/trades', allow: READ_ALL, domainErrors: 'unavailable', handler: ({ param, query }) => bots.trades(param('id'), queryNumber(query('hours'))) },
    { method: 'get', path: '/api/bots/:id/positions', allow: READ_ALL, domainErrors: 'unavailable', handler: ({ param }) => bots.positions(param('id')) },
    { method: 'get', path: '/api/bots/:id/stats', allow: READ_ALL, domainErrors: 'unavailable', handler: ({ param }) => bots.stats(param('id')) },
    // Order attempts incl. risk rejections (spec §12 Bot detail; §7.3 get_open_orders)
    // Recent log lines / ctx.emit events (in memory; the same data SSE /api/events delivers live to any principal)
    { method: 'get', path: '/api/bots/:id/logs', allow: READ_ALL, handler: ({ param, query }) => bots.logs(param('id'), queryNumber(query('limit'))) },
    { method: 'get', path: '/api/bots/:id/events', allow: READ_ALL, handler: ({ param, query }) => bots.events(param('id'), queryNumber(query('limit'))) },
    { method: 'get', path: '/api/bots/:id/orders', allow: READ_ALL, handler: ({ param, query }) => bots.orders(param('id'), queryNumber(query('limit'))) },
  ];
}

// ── Wallets (human only, spec §4.6; changes need a recent password check) ─

export function walletRoutes(wallets: CoreServices['wallets']): RouteDef[] {
  return [
    { method: 'get', path: '/api/wallets', allow: ADMIN, handler: ({ query }) => wallets.list(parseInput(WalletListFilterSchema, { available: queryBool(query('available')) })) },
    { method: 'get', path: '/api/wallets/:id', allow: ADMIN, handler: ({ param }) => wallets.get(param('id')) },
    { method: 'post', path: '/api/wallets', recentAuth: true, domainErrors: 'invalid_input', handler: ({ body }) => wallets.create(parseInput(WalletCreateSchema, body)) },
    { method: 'patch', path: '/api/wallets/:id', recentAuth: true, domainErrors: 'invalid_input', handler: ({ param, body }) => wallets.update(param('id'), parseInput(WalletUpdateSchema, body)) },
    { method: 'delete', path: '/api/wallets/:id', recentAuth: true, domainErrors: 'conflict', handler: ({ param }) => wallets.delete(param('id')) },
    { method: 'get', path: '/api/wallets/:id/balance', allow: ADMIN, domainErrors: 'unavailable', handler: ({ param }) => wallets.balance(param('id')) },
  ];
}

// ── Settings (human only; holds API keys, so reads are admin-only too) ─────

const TestBinanceSchema = z.object({ apiKey: z.string().optional(), apiSecret: z.string().optional() }).optional();

export function settingsRoutes(settings: CoreServices['settings']): RouteDef[] {
  return [
    { method: 'get', path: '/api/settings', allow: ADMIN, handler: () => settings.get() },
    {
      method: 'patch',
      path: '/api/settings',
      recentAuth: true,
      message: 'Settings updated. Restart running bots for changes to take effect.',
      handler: ({ body }) => settings.update(parseInput(SettingsUpdateSchema, body)),
    },
    { method: 'put', path: '/api/settings/binance', recentAuth: true, message: 'Binance credentials saved.', handler: ({ body }) => settings.saveBinance(parseInput(BinanceCredentialsSchema, body)) },
    { method: 'delete', path: '/api/settings/binance', recentAuth: true, message: 'Binance credentials removed.', handler: () => settings.clearBinance() },
    {
      method: 'post',
      path: '/api/settings/binance/test',
      domainErrors: 'unavailable',
      message: 'Binance API connected successfully.',
      handler: ({ body }) => {
        const creds = parseInput(TestBinanceSchema, body);
        return settings.testBinance(creds?.apiKey && creds?.apiSecret ? creds : undefined);
      },
    },
    {
      method: 'post',
      path: '/api/settings/rpc/test',
      domainErrors: 'unavailable',
      message: (data) => `RPC connected successfully. Current block: ${(data as { blockNumber: number }).blockNumber}`,
      handler: () => settings.testRpc(),
    },
    { method: 'post', path: '/api/settings/clob/test', domainErrors: 'unavailable', message: 'CLOB API connected successfully.', handler: () => settings.testClob() },
  ];
}

// ── Scripts ─────────────────────────────────────────────────────────────

const CompileSchema = z.object({ source: z.string() });
const ForkSchema = z.object({ newName: z.string().optional() }).optional();
const ImportBodySchema = z.object({ files: ScriptImportSchema });

export function scriptRoutes(scripts: CoreServices['scripts']): RouteDef[] {
  return [
    { method: 'get', path: '/api/scripts', allow: READ_ALL, handler: () => scripts.list() },
    { method: 'post', path: '/api/scripts/compile', allow: ADMIN_AGENT, domainErrors: 'invalid_input', handler: ({ body }) => scripts.compile(parseInput(CompileSchema, body).source) },
    { method: 'post', path: '/api/scripts/import', domainErrors: 'invalid_input', handler: ({ body, actor }) => scripts.importScripts(parseInput(ImportBodySchema, body).files, actor()) },
    { method: 'get', path: '/api/scripts/:id', allow: READ_ALL, handler: ({ param }) => scripts.get(param('id')) },
    { method: 'post', path: '/api/scripts', allow: ADMIN_AGENT, domainErrors: 'invalid_input', handler: ({ body, actor }) => scripts.create(parseInput(ScriptCreateSchema, body), actor()) },
    { method: 'patch', path: '/api/scripts/:id', allow: ADMIN_AGENT, domainErrors: 'invalid_input', handler: ({ param, body, actor }) => scripts.update(param('id'), parseInput(ScriptUpdateSchema, body), actor()) },
    { method: 'delete', path: '/api/scripts/:id', domainErrors: 'conflict', handler: ({ param, actor }) => scripts.delete(param('id'), actor()) },
    { method: 'get', path: '/api/scripts/:id/schema', allow: READ_ALL, handler: ({ param }) => scripts.getSchema(param('id')) },
    // Version history + source of one version (code view / diff; §7.3 get_script "source + version history")
    { method: 'get', path: '/api/scripts/:id/versions', allow: READ_ALL, handler: ({ param }) => scripts.versions(param('id')) },
    {
      method: 'get',
      path: '/api/scripts/:id/versions/:version',
      allow: READ_ALL,
      handler: ({ param }) => scripts.version(param('id'), parseInput(z.coerce.number().int().positive(), param('version'))),
    },
    { method: 'post', path: '/api/scripts/:id/fork', allow: ADMIN_AGENT, domainErrors: 'invalid_input', handler: ({ param, body, actor }) => scripts.fork(param('id'), parseInput(ForkSchema, body)?.newName, actor()) },
    /** `.botlab` file content; the browser saves it (formerly a native save dialog) */
    { method: 'get', path: '/api/scripts/:id/export', allow: ADMIN, handler: ({ param }) => scripts.exportScript(param('id')) },
  ];
}

// ── Backtests ───────────────────────────────────────────────────────────

export function backtestRoutes(backtests: CoreServices['backtests']): RouteDef[] {
  return [
    { method: 'post', path: '/api/backtests', allow: ADMIN_AGENT, domainErrors: 'invalid_input', handler: ({ body }) => backtests.run(parseInput(BacktestRunSchema, body)) },
    { method: 'get', path: '/api/backtests', allow: READ_ALL, handler: ({ query }) => backtests.list(query('scriptId') || undefined) },
    { method: 'get', path: '/api/backtests/:id', allow: READ_ALL, handler: ({ param }) => backtests.get(param('id')) },
    { method: 'delete', path: '/api/backtests/:id', handler: ({ param }) => backtests.delete(param('id')) },
  ];
}

// ── Risk (halts, kill switch) ───────────────────────────────────────────

const ReasonSchema = z.object({ reason: z.string() });

export function riskRoutes(risk: CoreServices['risk'], overview: CoreServices['overview']): RouteDef[] {
  return [
    { method: 'get', path: '/api/risk/state', allow: READ_ALL, handler: () => risk.getState() },
    // Dashboard: equity, exposure vs limits, daily P&L, halts, reconciler, rights, allocations (§7.3 get_overview)
    { method: 'get', path: '/api/risk/overview', allow: READ_ALL, handler: () => overview.overview() },
    {
      method: 'post',
      path: '/api/risk/clear-halt',
      recentAuth: true,
      domainErrors: 'conflict',
      handler: ({ body, human }) => {
        const { scope, reason } = parseInput(ClearHaltSchema, body);
        return risk.clearHalt(scope, reason, human());
      },
    },
    // Anyone may reduce risk (spec D5): admin or agent
    { method: 'post', path: '/api/risk/kill-switch', allow: ADMIN_AGENT, domainErrors: 'conflict', handler: ({ body, actor }) => risk.killSwitch(parseInput(KillSwitchSchema, body ?? {}).reason, actor()) },
  ];
}

// ── Config files ────────────────────────────────────────────────────────

const ConfigWriteBody = z.object({ value: z.unknown(), expectedSha256: z.string().optional() });
const ConfigRestoreBody = z.object({ versionId: z.string(), expectedSha256: z.string().optional() });
const ConfigPreviewBody = z.object({ value: z.unknown() });

export function configRoutes(config: CoreServices['config']): RouteDef[] {
  return [
    // Secrets masked; the agent reads limits/mandate (spec §7.3 resources)
    { method: 'get', path: '/api/config', allow: ADMIN_AGENT, handler: ({ actor }) => config.get(actor()) },
    // JSON Schema of each file (the UI form is generated from the loader's zod schemas, spec §3)
    { method: 'get', path: '/api/config/schema', handler: () => config.schemas() },
    // Dry run of a write: validation issues + risk classification of each change (no recent password needed: nothing is written)
    {
      method: 'post',
      path: '/api/config/:file/preview',
      handler: ({ param, body, human }) => config.preview(parseInput(ConfigFileSchema, param('file')), parseInput(ConfigPreviewBody, body).value, human()),
    },
    // Text of one history version, secrets redacted (diff in the UI)
    {
      method: 'get',
      path: '/api/config/:file/history/:versionId',
      allow: ADMIN,
      handler: ({ param, human }) => config.versionText(parseInput(ConfigFileSchema, param('file')), param('versionId'), human()),
    },
    {
      method: 'put',
      path: '/api/config/:file',
      recentAuth: true,
      domainErrors: 'invalid_input',
      handler: ({ param, body, human }) => {
        const file = parseInput(ConfigFileSchema, param('file'));
        const { value, expectedSha256 } = parseInput(ConfigWriteBody, body);
        return config.write(file, value, human(), expectedSha256);
      },
    },
    { method: 'get', path: '/api/config/:file/history', allow: ADMIN_AGENT, handler: ({ param, actor }) => config.history(parseInput(ConfigFileSchema, param('file')), actor()) },
    {
      method: 'post',
      path: '/api/config/:file/restore',
      recentAuth: true,
      domainErrors: 'invalid_input',
      handler: ({ param, body, human }) => {
        const { versionId, expectedSha256 } = parseInput(ConfigRestoreBody, body);
        return config.restore(parseInput(ConfigFileSchema, param('file')), versionId, human(), expectedSha256);
      },
    },
    // Dry run of a restore: the version classified against the current file (UI review before restoring)
    {
      method: 'post',
      path: '/api/config/:file/restore/preview',
      handler: ({ param, body, human }) => config.previewRestore(parseInput(ConfigFileSchema, param('file')), parseInput(ConfigRestoreBody, body).versionId, human()),
    },
  ];
}

// ── Forecast ledger and markets ─────────────────────────────────────────

const SetAmbiguityBody = z.object({ score: z.number(), note: z.string().nullish() });

/** Live market search: requests per principal per minute (each may reach Gamma) */
export const MARKET_SEARCH_PER_MINUTE = 30;

/** Sliding one-minute window per principal (session or token) */
function perPrincipalLimiter(perMinute: number) {
  const hits = new Map<string, number[]>();
  return (principal: Principal, now = Date.now()): void => {
    const key = principal.via === 'session' ? `s:${principal.sessionId}` : `t:${principal.tokenId}`;
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) {
      hits.set(key, recent);
      throw new HttpError(429, 'rate_limited', `Too many market searches (max ${perMinute} per minute); try again shortly`);
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 1000) for (const [k, v] of hits) if (v.every((t) => now - t >= 60_000)) hits.delete(k);
  };
}

export function ledgerRoutes(ledger: CoreServices['ledger'], markets: CoreServices['markets']): RouteDef[] {
  const searchLimit = perPrincipalLimiter(MARKET_SEARCH_PER_MINUTE);
  return [
    // Forecasts: human (UI) or agent (MCP submit_forecast); the service validates the input
    { method: 'post', path: '/api/ledger/forecasts', allow: ADMIN_AGENT, domainErrors: 'invalid_input', handler: ({ body, actor }) => ledger.submitForecast(body, actor()) },
    {
      method: 'post',
      path: '/api/ledger/forecasts/:id/withdraw',
      allow: ADMIN_AGENT,
      domainErrors: 'invalid_input',
      handler: ({ param, body, actor }) => ledger.withdrawForecast(param('id'), parseInput(ReasonSchema, body).reason, actor()),
    },
    {
      method: 'get',
      path: '/api/ledger/forecasts',
      allow: READ_ALL,
      handler: ({ query }) => {
        const status = query('status');
        const filter = parseInput(ForecastListFilterSchema, {
          status: status?.includes(',') ? status.split(',') : status || undefined,
          category: query('category') || undefined,
          horizonBucket: query('horizonBucket') || undefined,
          marketId: query('marketId') || undefined,
          tokenId: query('tokenId') || undefined,
          tradeableOnly: queryBool(query('tradeableOnly')),
          limit: queryNumber(query('limit')),
        });
        return ledger.list((filter ?? {}) as ForecastFilter);
      },
    },
    {
      method: 'get',
      path: '/api/ledger/forecasts/:id',
      allow: READ_ALL,
      handler: ({ param }) => {
        const f = ledger.getForecast(param('id'));
        if (!f) throw new ServiceError('not_found', 'Forecast not found');
        return f;
      },
    },
    { method: 'get', path: '/api/ledger/stats', allow: READ_ALL, handler: () => ledger.stats() },
    // Search of the market cache (§7.3 search_markets, cached markets only)
    { method: 'get', path: '/api/markets', allow: READ_ALL, handler: ({ query }) => markets.search(query('q') ?? '', queryNumber(query('limit'))) },
    {
      method: 'post',
      path: '/api/ledger/rights',
      recentAuth: true,
      domainErrors: 'invalid_input',
      handler: ({ body, human }) => {
        const { category, bucket, state, reason } = parseInput(SetRightsStateSchema, body);
        return ledger.forceRightsState(category, bucket as HorizonBucket, state as CategoryRightsState | 'auto', reason, human());
      },
    },
    // Live Polymarket search via Gamma (Markets page): q, active (default true), category (BotLab), limit
    {
      method: 'get',
      path: '/api/markets/search',
      allow: READ_ALL,
      handler: ({ query, principal }) => {
        searchLimit(principal);
        return markets.searchLive({ q: query('q') ?? '', active: queryBool(query('active')) ?? true, category: query('category'), limit: queryNumber(query('limit')) });
      },
    },
    { method: 'get', path: '/api/markets/:id', allow: READ_ALL, domainErrors: 'unavailable', handler: ({ param }) => markets.get(param('id')) },
    {
      method: 'post',
      path: '/api/markets/:id/ambiguity',
      recentAuth: true,
      domainErrors: 'invalid_input',
      handler: ({ param, body, human }) => {
        const { score, note } = parseInput(SetAmbiguityBody, body);
        return markets.setAmbiguity(param('id'), score, human(), note ?? null);
      },
    },
  ];
}

// ── Reconciler and recorder ─────────────────────────────────────────────

export function reconcileRoutes(reconcile: CoreServices['reconcile']): RouteDef[] {
  return [
    { method: 'get', path: '/api/reconcile/status', allow: READ_ALL, handler: () => reconcile.status() },
    {
      method: 'post',
      path: '/api/reconcile/adopt',
      recentAuth: true,
      domainErrors: 'conflict',
      handler: ({ body, human }) => {
        const { walletId, botId, includePostFirstOrder } = parseInput(AdoptPositionsSchema, body);
        return reconcile.adoptPositions(walletId, botId, human(), { includePostFirstOrder });
      },
    },
    // What adoption would do now (same checks; writes no adopted fill, but syncs the wallet's orders like a
    // reconciler run, which may record real fills / expire orders); human admin, no recent password needed
    {
      method: 'post',
      path: '/api/reconcile/adopt/preview',
      domainErrors: 'conflict',
      handler: ({ body, human }) => {
        const { walletId, botId, includePostFirstOrder } = parseInput(AdoptPositionsSchema, body);
        return reconcile.adoptPreview(walletId, botId, human(), { includePostFirstOrder });
      },
    },
    { method: 'get', path: '/api/recorder/watchlist', allow: READ_ALL, handler: () => reconcile.watchlistList() },
    {
      method: 'post',
      path: '/api/recorder/watchlist',
      allow: ADMIN_AGENT,
      domainErrors: 'invalid_input',
      handler: ({ body, actor }) => {
        const { tokenId, marketId, note } = parseInput(WatchlistAddSchema, body);
        return reconcile.watchlistAdd(tokenId, marketId, note, actor());
      },
    },
    { method: 'delete', path: '/api/recorder/watchlist/:tokenId', allow: ADMIN_AGENT, handler: ({ param, actor }) => reconcile.watchlistRemove(param('tokenId'), actor()) },
  ];
}

// ── Audit log (read; admin + readonly) ──────────────────────────────────

export function auditRoutes(auditLog: CoreServices['auditLog']): RouteDef[] {
  return [
    {
      method: 'get',
      path: '/api/audit',
      handler: ({ query }) =>
        auditLog.list({
          action: query('action'),
          actionPrefix: query('actionPrefix'),
          actor: query('actor'),
          target: query('target'),
          since: query('since'),
          until: query('until'),
          before: queryNumber(query('before')),
          limit: queryNumber(query('limit')),
        }),
    },
    { method: 'get', path: '/api/audit/actions', handler: () => auditLog.actions() },
  ];
}

export function apiRoutes(services: CoreServices): RouteDef[] {
  return [
    ...botRoutes(services.bots),
    ...walletRoutes(services.wallets),
    ...settingsRoutes(services.settings),
    ...scriptRoutes(services.scripts),
    ...backtestRoutes(services.backtests),
    ...riskRoutes(services.risk, services.overview),
    ...configRoutes(services.config),
    ...ledgerRoutes(services.ledger, services.markets),
    ...reconcileRoutes(services.reconcile),
    ...auditRoutes(services.auditLog),
  ];
}

