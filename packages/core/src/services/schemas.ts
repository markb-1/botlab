/**
 * Input schemas for the service layer (spec §1.1, §8.1). Shared by every transport: the Electron IPC
 * handlers today, the HTTP API and MCP tools in chunk 3b. Transports parse their raw input with these
 * and pass the typed result to the service.
 *
 * The schemas check shape and types only. Value rules that already had their own error messages
 * (e.g. "startTime must be before endTime", "Wallet is required for live bots") stay in the services,
 * so callers see the same messages as before. Unknown keys are stripped, not rejected.
 */

import { z } from 'zod';
import { ServiceError } from './errors';

const id = z.string();
const jsonObject = z.record(z.string(), z.unknown());

// ─── Bots ─────────────────────────────────────────────────────────────────────

export const BotListFilterSchema = z.object({ scriptId: z.string().optional(), status: z.string().optional() }).optional();

export const BotCreateSchema = z.object({
  name: z.string(),
  scriptId: id,
  walletId: id.optional(),
  config: jsonObject.optional(),
  enabled: z.boolean().optional(),
  mode: z.enum(['live', 'paper']).optional(),
  /** Condition ids the bot is scoped to (spec §2.1 market_ids; the recorder records their books) */
  marketIds: z.array(z.string().min(1).max(100)).max(50).optional(),
});

export const BotUpdateSchema = z.object({
  name: z.string().optional(),
  scriptId: id.optional(),
  walletId: id.optional(),
  config: jsonObject.optional(),
  enabled: z.boolean().optional(),
});

/** Hours of history; omitted (or 0) ⇒ the service default */
export const HoursSchema = z.number().nullish();

// ─── Wallets ──────────────────────────────────────────────────────────────────

export const WalletListFilterSchema = z.object({ available: z.boolean().optional() }).optional();

export const WalletCreateSchema = z.object({
  name: z.string(),
  address: z.string(),
  privateKey: z.string(),
  proxyAddress: z.string().optional(),
});

export const WalletUpdateSchema = z.object({ name: z.string().optional(), proxyAddress: z.string().optional() });

// ─── Scripts ──────────────────────────────────────────────────────────────────

export const ScriptCreateSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  author: z.string().optional(),
  source: z.string(),
  configSchema: jsonObject.optional(),
});

export const ScriptUpdateSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  author: z.string().optional(),
  source: z.string().optional(),
  configSchema: jsonObject.optional(),
});

/** One `.botlab` file to import: its name (for messages) and raw text */
export const ScriptImportFileSchema = z.object({ name: z.string(), content: z.string() });
export const ScriptImportSchema = z.array(ScriptImportFileSchema);

// ─── Settings ─────────────────────────────────────────────────────────────────

export const SettingsUpdateSchema = z.object({
  rpcUrl: z.string().optional(),
  clobHttpUrl: z.string().optional(),
  clobWsUrl: z.string().optional(),
  usdcContractAddress: z.string().optional(),
  alchemyApiKey: z.string().nullable().optional(),
});

export const BinanceCredentialsSchema = z.object({ apiKey: z.string(), apiSecret: z.string() });

// ─── Backtests ────────────────────────────────────────────────────────────────

/** Required fields are optional here so the service reports them with its own messages */
export const BacktestRunSchema = z.object({
  scriptId: z.string().optional(),
  symbol: z.string().optional(),
  interval: z.string().optional(),
  startTime: z.number().optional(),
  endTime: z.number().optional(),
  initialBalance: z.number().optional(),
  config: jsonObject.optional(),
  /** Default 'binance-klines'; 'polymarket-snapshots' replays recorded order books */
  source: z.string().optional(),
  /** polymarket-snapshots: tokens to replay */
  tokenIds: z.array(z.unknown()).optional(),
});

// The schemas below describe inputs whose services also check them themselves (the IPC handlers pass
// the raw values through, as before); HTTP/MCP can validate with them up front.

// ─── Risk ─────────────────────────────────────────────────────────────────────

export const ClearHaltSchema = z.object({ scope: z.string(), reason: z.string() });
export const KillSwitchSchema = z.object({ reason: z.string().optional() });

// ─── Config files ─────────────────────────────────────────────────────────────

export const ConfigFileSchema = z.enum(['limits', 'mandate', 'fees', 'server', 'categories']);
export const ConfigWriteSchema = z.object({ file: ConfigFileSchema, value: z.unknown(), expectedSha256: z.string().optional() });
export const ConfigRestoreSchema = z.object({ file: ConfigFileSchema, versionId: z.string() });

// ─── Ledger and markets ───────────────────────────────────────────────────────

export const ForecastListFilterSchema = z
  .object({
    status: z.union([z.string(), z.array(z.string())]).optional(),
    category: z.string().optional(),
    horizonBucket: z.string().optional(),
    marketId: z.string().optional(),
    tokenId: z.string().optional(),
    tradeableOnly: z.boolean().optional(),
    limit: z.number().optional(),
  })
  .optional();

export const WithdrawForecastSchema = z.object({ id: z.string(), reason: z.string() });

export const SetRightsStateSchema = z.object({ category: z.string(), bucket: z.string(), state: z.string(), reason: z.string() });

export const SetAmbiguitySchema = z.object({ marketId: z.string(), score: z.number(), note: z.string().nullish() });

// ─── Reconciler and recorder ──────────────────────────────────────────────────

export const AdoptPositionsSchema = z.object({
  walletId: z.string(),
  botId: z.string(),
  includePostFirstOrder: z.boolean().optional(),
});

export const WatchlistAddSchema = z.object({ tokenId: z.string(), marketId: z.string().nullish(), note: z.string().nullish() });

// ─── Agent tools (MCP, spec §7.3) ─────────────────────────────────────────────
// Field descriptions end up in the tool's JSON Schema, which the agent reads.

const tokenIdField = z.string().min(1).max(100).describe('Polymarket token (outcome) id');
const marketIdField = z.string().min(1).max(100).describe('Polymarket condition id');
const botIdField = z.string().min(1).max(100).describe('BotLab bot id');
const modeFilter = z.enum(['paper', 'live']).optional().describe('Only paper or only live (default both)');

export const AgentSearchMarketsSchema = z.object({
  q: z.string().max(200).optional().describe('Search text; empty ⇒ the most traded open markets'),
  category: z.string().max(60).optional().describe('BotLab category (categories.yaml), e.g. weather-climate'),
  minVolume24hUsd: z.number().nonnegative().optional().describe('Minimum 24h volume (USD)'),
  minLiquidityUsd: z.number().nonnegative().optional().describe('Deprecated alias of minVolume24hUsd (it always filtered on 24h volume)'),
  endWithinDays: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).optional().describe('[min, max] days until the market ends'),
  minPrice: z.number().min(0).max(1).optional().describe('Minimum YES price'),
  maxPrice: z.number().min(0).max(1).optional().describe('Maximum YES price'),
  inMandateOnly: z.boolean().optional().describe('Drop markets the mandate / limits flag (default false: they are returned with flags)'),
  includeClosed: z.boolean().optional().describe('Include closed markets (default false)'),
  source: z.enum(['live', 'cache']).optional().describe('live = Polymarket search (default); cache = markets BotLab already knows'),
  limit: z.number().int().min(1).max(100).optional(),
});

export const MarketIdInputSchema = z.object({ marketId: marketIdField });
export const OrderbookInputSchema = z.object({ tokenId: tokenIdField, depth: z.number().int().min(1).max(50).optional().describe('Levels per side (default 10)') });
export const PriceHistoryInputSchema = z.object({
  tokenId: tokenIdField,
  interval: z.enum(['1h', '6h', '1d', '1w', '1m', 'max']).optional().describe('Window (default 1w)'),
  fidelityMinutes: z.number().int().min(1).max(1440).optional().describe('Polymarket resolution in minutes (default 60)'),
});
export const PositionsFilterSchema = z.object({ botId: botIdField.optional(), marketId: marketIdField.optional(), mode: modeFilter });
export const TradesFilterSchema = z.object({
  botId: botIdField.optional(),
  marketId: marketIdField.optional(),
  hours: z.number().positive().max(24 * 90).optional().describe('History window in hours (default 168)'),
  limit: z.number().int().min(1).max(500).optional(),
});
export const AgentBotListSchema = z.object({
  status: z.string().max(20).optional().describe('stopped | running | error | …'),
  createdBy: z.enum(['human', 'agent']).optional(),
  stage: z.enum(['paper', 'probation', 'full', 'retired']).optional(),
});
export const BotIdInputSchema = z.object({ botId: botIdField });
export const BotLogsInputSchema = z.object({
  botId: botIdField,
  limit: z.number().int().min(1).max(500).optional().describe('Lines (default 100), newest first'),
  offset: z.number().int().min(0).max(500).optional().describe('Skip this many of the newest lines (paging)'),
});
export const GetScriptInputSchema = z.object({
  scriptId: z.string().min(1).max(100),
  version: z.number().int().positive().optional().describe('A past version (default: current source)'),
});
export const AgentForecastFilterSchema = z.object({
  status: z.enum(['active', 'superseded', 'withdrawn', 'resolved', 'void']).optional(),
  category: z.string().max(60).optional(),
  marketId: marketIdField.optional(),
  tokenId: tokenIdField.optional(),
  tradeableOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export const NotesFilterSchema = z.object({
  scope: z.string().max(120).optional().describe('Exact scope, or a prefix ending in ":" (e.g. market:)'),
  query: z.string().max(200).optional().describe('Text in the title or body'),
  limit: z.number().int().min(1).max(500).optional(),
});
export const RunHistorySchema = z.object({ limit: z.number().int().min(1).max(100).optional() });
export const LeaderboardInputSchema = z.object({
  period: z.enum(['DAY', 'WEEK', 'MONTH', 'ALL']).optional(),
  orderBy: z.enum(['PNL', 'VOL']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe('Also return this wallet’s recent activity'),
  activityLimit: z.number().int().min(1).max(200).optional(),
});
export const ValidateScriptSchema = z.object({ source: z.string().min(1).max(65_536).describe('TypeScript bot script (≤ 64 KB)') });
export const CreateTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  source: z.string().min(1).max(65_536),
  configSchema: jsonObject.optional().describe('JSON Schema of the bot config (also exported as meta.configSchema)'),
});
export const UpdateTemplateSchema = z.object({
  templateId: z.string().min(1).max(100),
  source: z.string().min(1).max(65_536).optional(),
  description: z.string().max(2000).optional(),
  configSchema: jsonObject.optional(),
});
export const BacktestIdSchema = z.object({ backtestId: z.string().min(1).max(100) });
/** Strict: an unknown key (walletId, mode, stage…) is an error, not silently dropped */
export const AgentCreateBotSchema = z.strictObject({
  templateId: z.string().min(1).max(100).describe('A template id from list_templates'),
  name: z.string().min(1).max(100),
  marketIds: z.array(marketIdField).max(50).optional().describe('Markets the bot is scoped to (their books are recorded)'),
  config: jsonObject.optional().describe('Bot config (see the template configSchema)'),
});
export const UpdateBotConfigSchema = z.strictObject({ botId: botIdField, config: jsonObject });
export const RetireBotSchema = z.object({ botId: botIdField, reason: z.string().min(1).max(1000) });
export const WithdrawForecastInputSchema = z.object({ forecastId: z.string().min(1).max(100), reason: z.string().min(1).max(1000) });
export const AssessMarketSchema = z.object({
  marketId: marketIdField,
  score: z.number().int().min(0).max(3).describe('Ambiguity 0-3 (spec §7.4)'),
  rationale: z.string().min(1).max(2000),
});
export const FlagPositionExitSchema = z.object({ botId: botIdField, tokenId: tokenIdField, reason: z.string().min(1).max(2000) });
export const AgentKillSwitchSchema = z.object({ reason: z.string().min(1).max(1000) });
export const UnwatchInputSchema = z.object({ tokenId: tokenIdField });
export const WriteNoteSchema = z.object({
  id: z.string().max(100).optional().describe('Existing note to replace; omit to create'),
  scope: z.string().min(1).max(120).describe('general | market:<conditionId> | category:<category> | strategy:<key>'),
  title: z.string().min(1).max(200),
  body_md: z.string().min(1).max(20_000),
});
export const NoteIdSchema = z.object({ id: z.string().min(1).max(100) });
export const StartRunSchema = z.object({ trigger: z.enum(['manual', 'schedule', 'event']).optional() });
/** Strict: the agent cannot report cost or tokens (the runner records them, R146) */
export const FinishRunSchema = z.strictObject({
  summary_md: z.string().min(1).max(20_000).describe('Run report (markdown), sent to the owner'),
  status: z.enum(['ok', 'error', 'aborted']).optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse with a schema; failures become a `ServiceError('invalid_input')` with a readable message. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const msg = r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
  throw new ServiceError('invalid_input', `Invalid input: ${msg}`);
}

export type BotCreateInput = z.infer<typeof BotCreateSchema>;
export type BotUpdateInput = z.infer<typeof BotUpdateSchema>;
export type WalletCreateInput = z.infer<typeof WalletCreateSchema>;
export type WalletUpdateInput = z.infer<typeof WalletUpdateSchema>;
export type ScriptCreateInput = z.infer<typeof ScriptCreateSchema>;
export type ScriptUpdateInput = z.infer<typeof ScriptUpdateSchema>;
export type ScriptImportFile = z.infer<typeof ScriptImportFileSchema>;
export type SettingsUpdateInput = z.infer<typeof SettingsUpdateSchema>;
export type BinanceCredentials = z.infer<typeof BinanceCredentialsSchema>;
export type BacktestRunInput = z.infer<typeof BacktestRunSchema>;
export type ForecastListFilterInput = z.infer<typeof ForecastListFilterSchema>;
