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
