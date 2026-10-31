/**
 * HTTP API routes (spec §8.1): one route per former IPC channel, calling the core services with
 * input parsed by the shared schemas (`services/schemas.ts`) and the actor derived from the principal.
 *
 * Scopes (spec §8.2, §4.6, §7.3): GET routes are open to admin and readonly tokens unless noted;
 * mutations are admin-only. The agent scope is granted only where the MCP tool list of §7.3 has a
 * counterpart (scripts, backtests, bot create/update/start/stop, forecasts, kill switch, recorder
 * watchlist and read routes); never wallets, credentials, settings, config writes or anything in §4.6.
 * Human-only admin actions (clear halt, config write/restore, adopt, set ambiguity, force rights,
 * API tokens) also need a password check within 15 minutes (`recentAuth`).
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
import { queryBool, queryNumber, type RouteDef } from '../http/routes';
import type { Scope } from '../http/principal';

const READ_ALL: Scope[] = ['admin', 'readonly', 'agent'];
const ADMIN_AGENT: Scope[] = ['admin', 'agent'];

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
    { method: 'post', path: '/api/bots', allow: ADMIN_AGENT, handler: ({ body, actor }) => bots.create(parseInput(BotCreateSchema, body), actor()) },
    { method: 'patch', path: '/api/bots/:id', allow: ADMIN_AGENT, handler: ({ param, body, actor }) => bots.update(param('id'), parseInput(BotUpdateSchema, body), actor()) },
    { method: 'delete', path: '/api/bots/:id', handler: ({ param, actor }) => bots.delete(param('id'), actor()) },
    { method: 'post', path: '/api/bots/:id/start', allow: ADMIN_AGENT, handler: ({ param, actor }) => bots.start(param('id'), actor()) },
    { method: 'post', path: '/api/bots/:id/stop', allow: ADMIN_AGENT, handler: ({ param, actor }) => bots.stop(param('id'), actor()) },
    { method: 'post', path: '/api/bots/:id/restart', allow: ADMIN_AGENT, handler: ({ param, actor }) => bots.restart(param('id'), actor()) },
    { method: 'get', path: '/api/bots/:id/trades', allow: READ_ALL, handler: ({ param, query }) => bots.trades(param('id'), queryNumber(query('hours'))) },
    { method: 'get', path: '/api/bots/:id/positions', allow: READ_ALL, handler: ({ param }) => bots.positions(param('id')) },
    { method: 'get', path: '/api/bots/:id/stats', allow: READ_ALL, handler: ({ param }) => bots.stats(param('id')) },
  ];
}

// ── Wallets (human only, spec §4.6) ─────────────────────────────────────

export function walletRoutes(wallets: CoreServices['wallets']): RouteDef[] {
  return [
    { method: 'get', path: '/api/wallets', handler: ({ query }) => wallets.list(parseInput(WalletListFilterSchema, { available: queryBool(query('available')) })) },
    { method: 'get', path: '/api/wallets/:id', handler: ({ param }) => wallets.get(param('id')) },
    { method: 'post', path: '/api/wallets', handler: ({ body }) => wallets.create(parseInput(WalletCreateSchema, body)) },
    { method: 'patch', path: '/api/wallets/:id', handler: ({ param, body }) => wallets.update(param('id'), parseInput(WalletUpdateSchema, body)) },
    { method: 'delete', path: '/api/wallets/:id', handler: ({ param }) => wallets.delete(param('id')) },
    { method: 'get', path: '/api/wallets/:id/balance', handler: ({ param }) => wallets.balance(param('id')) },
  ];
}

// ── Settings (human only) ───────────────────────────────────────────────

const TestBinanceSchema = z.object({ apiKey: z.string().optional(), apiSecret: z.string().optional() }).optional();

export function settingsRoutes(settings: CoreServices['settings']): RouteDef[] {
  return [
    { method: 'get', path: '/api/settings', handler: () => settings.get() },
    {
      method: 'patch',
      path: '/api/settings',
      message: 'Settings updated. Restart running bots for changes to take effect.',
      handler: ({ body }) => settings.update(parseInput(SettingsUpdateSchema, body)),
    },
    { method: 'put', path: '/api/settings/binance', message: 'Binance credentials saved.', handler: ({ body }) => settings.saveBinance(parseInput(BinanceCredentialsSchema, body)) },
    { method: 'delete', path: '/api/settings/binance', message: 'Binance credentials removed.', handler: () => settings.clearBinance() },
    {
      method: 'post',
      path: '/api/settings/binance/test',
      message: 'Binance API connected successfully.',
      handler: ({ body }) => {
        const creds = parseInput(TestBinanceSchema, body);
        return settings.testBinance(creds?.apiKey && creds?.apiSecret ? creds : undefined);
      },
    },
    {
      method: 'post',
      path: '/api/settings/rpc/test',
      message: (data) => `RPC connected successfully. Current block: ${(data as { blockNumber: number }).blockNumber}`,
      handler: () => settings.testRpc(),
    },
    { method: 'post', path: '/api/settings/clob/test', message: 'CLOB API connected successfully.', handler: () => settings.testClob() },
  ];
}

// ── Scripts ─────────────────────────────────────────────────────────────

const CompileSchema = z.object({ source: z.string() });
const ForkSchema = z.object({ newName: z.string().optional() }).optional();
const ImportBodySchema = z.object({ files: ScriptImportSchema });

export function scriptRoutes(scripts: CoreServices['scripts']): RouteDef[] {
  return [
    { method: 'get', path: '/api/scripts', allow: READ_ALL, handler: () => scripts.list() },
    { method: 'post', path: '/api/scripts/compile', allow: ADMIN_AGENT, handler: ({ body }) => scripts.compile(parseInput(CompileSchema, body).source) },
    { method: 'post', path: '/api/scripts/import', handler: ({ body, actor }) => scripts.importScripts(parseInput(ImportBodySchema, body).files, actor()) },
    { method: 'get', path: '/api/scripts/:id', allow: READ_ALL, handler: ({ param }) => scripts.get(param('id')) },
    { method: 'post', path: '/api/scripts', allow: ADMIN_AGENT, handler: ({ body, actor }) => scripts.create(parseInput(ScriptCreateSchema, body), actor()) },
    { method: 'patch', path: '/api/scripts/:id', allow: ADMIN_AGENT, handler: ({ param, body, actor }) => scripts.update(param('id'), parseInput(ScriptUpdateSchema, body), actor()) },
    { method: 'delete', path: '/api/scripts/:id', handler: ({ param, actor }) => scripts.delete(param('id'), actor()) },
    { method: 'get', path: '/api/scripts/:id/schema', allow: READ_ALL, handler: ({ param }) => scripts.getSchema(param('id')) },
    { method: 'post', path: '/api/scripts/:id/fork', allow: ADMIN_AGENT, handler: ({ param, body, actor }) => scripts.fork(param('id'), parseInput(ForkSchema, body)?.newName, actor()) },
    /** `.botlab` file content; the browser saves it (formerly a native save dialog) */
    { method: 'get', path: '/api/scripts/:id/export', handler: ({ param }) => scripts.exportScript(param('id')) },
  ];
}

// ── Backtests ───────────────────────────────────────────────────────────

export function backtestRoutes(backtests: CoreServices['backtests']): RouteDef[] {
  return [
    { method: 'post', path: '/api/backtests', allow: ADMIN_AGENT, handler: ({ body }) => backtests.run(parseInput(BacktestRunSchema, body)) },
    { method: 'get', path: '/api/backtests', allow: READ_ALL, handler: ({ query }) => backtests.list(query('scriptId') || undefined) },
    { method: 'get', path: '/api/backtests/:id', allow: READ_ALL, handler: ({ param }) => backtests.get(param('id')) },
    { method: 'delete', path: '/api/backtests/:id', handler: ({ param }) => backtests.delete(param('id')) },
  ];
}

// ── Risk (halts, kill switch) ───────────────────────────────────────────

const ReasonSchema = z.object({ reason: z.string() });

export function riskRoutes(risk: CoreServices['risk']): RouteDef[] {
  return [
    { method: 'get', path: '/api/risk/state', allow: READ_ALL, handler: () => risk.getState() },
    {
      method: 'post',
      path: '/api/risk/clear-halt',
      recentAuth: true,
      handler: ({ body, human }) => {
        const { scope, reason } = parseInput(ClearHaltSchema, body);
        return risk.clearHalt(scope, reason, human());
      },
    },
    // Anyone may reduce risk (spec D5): admin or agent
    { method: 'post', path: '/api/risk/kill-switch', allow: ADMIN_AGENT, handler: ({ body, actor }) => risk.killSwitch(parseInput(KillSwitchSchema, body ?? {}).reason, actor()) },
  ];
}

// ── Config files ────────────────────────────────────────────────────────

const ConfigWriteBody = z.object({ value: z.unknown(), expectedSha256: z.string().optional() });
const ConfigRestoreBody = z.object({ versionId: z.string() });

export function configRoutes(config: CoreServices['config']): RouteDef[] {
  return [
    // Secrets masked; the agent reads limits/mandate (spec §7.3 resources)
    { method: 'get', path: '/api/config', allow: ADMIN_AGENT, handler: ({ actor }) => config.get(actor()) },
    {
      method: 'put',
      path: '/api/config/:file',
      recentAuth: true,
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
      handler: ({ param, body, human }) => config.restore(parseInput(ConfigFileSchema, param('file')), parseInput(ConfigRestoreBody, body).versionId, human()),
    },
  ];
}

// ── Forecast ledger and markets ─────────────────────────────────────────

const SetAmbiguityBody = z.object({ score: z.number(), note: z.string().nullish() });

export function ledgerRoutes(ledger: CoreServices['ledger'], markets: CoreServices['markets']): RouteDef[] {
  return [
    // Forecasts: human (UI) or agent (MCP submit_forecast); the service validates the input
    { method: 'post', path: '/api/ledger/forecasts', allow: ADMIN_AGENT, handler: ({ body, actor }) => ledger.submitForecast(body, actor()) },
    {
      method: 'post',
      path: '/api/ledger/forecasts/:id/withdraw',
      allow: ADMIN_AGENT,
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
    { method: 'get', path: '/api/ledger/stats', allow: READ_ALL, handler: () => ledger.stats() },
    {
      method: 'post',
      path: '/api/ledger/rights',
      recentAuth: true,
      handler: ({ body, human }) => {
        const { category, bucket, state, reason } = parseInput(SetRightsStateSchema, body);
        return ledger.forceRightsState(category, bucket as HorizonBucket, state as CategoryRightsState | 'auto', reason, human());
      },
    },
    { method: 'get', path: '/api/markets/:id', allow: READ_ALL, handler: ({ param }) => markets.get(param('id')) },
    {
      method: 'post',
      path: '/api/markets/:id/ambiguity',
      recentAuth: true,
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
      handler: ({ body, human }) => {
        const { walletId, botId, includePostFirstOrder } = parseInput(AdoptPositionsSchema, body);
        return reconcile.adoptPositions(walletId, botId, human(), { includePostFirstOrder });
      },
    },
    { method: 'get', path: '/api/recorder/watchlist', allow: READ_ALL, handler: () => reconcile.watchlistList() },
    {
      method: 'post',
      path: '/api/recorder/watchlist',
      allow: ADMIN_AGENT,
      handler: ({ body, actor }) => {
        const { tokenId, marketId, note } = parseInput(WatchlistAddSchema, body);
        return reconcile.watchlistAdd(tokenId, marketId, note, actor());
      },
    },
    { method: 'delete', path: '/api/recorder/watchlist/:tokenId', allow: ADMIN_AGENT, handler: ({ param, actor }) => reconcile.watchlistRemove(param('tokenId'), actor()) },
  ];
}

export function apiRoutes(services: CoreServices): RouteDef[] {
  return [
    ...botRoutes(services.bots),
    ...walletRoutes(services.wallets),
    ...settingsRoutes(services.settings),
    ...scriptRoutes(services.scripts),
    ...backtestRoutes(services.backtests),
    ...riskRoutes(services.risk),
    ...configRoutes(services.config),
    ...ledgerRoutes(services.ledger, services.markets),
    ...reconcileRoutes(services.reconcile),
  ];
}

