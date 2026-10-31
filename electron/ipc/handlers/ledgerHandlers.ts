import { ipcMain } from 'electron';
import type { LedgerService } from '../../../packages/core/src/ledger/LedgerService';
import type { MarketService } from '../../../packages/core/src/services/MarketService';
import type { ForecastFilter } from '../../../packages/core/src/db/repositories/ForecastRepository';
import type { CategoryRightsState, HorizonBucket } from '../../../packages/core/src/risk/types';
import { ForecastListFilterSchema, parseInput } from '../../../packages/core/src/services/schemas';
import { respond, UNTRUSTED, type TrustedSenderCheck } from '../respond';

/**
 * Forecast ledger and market IPC (spec §6). Everything arriving over IPC comes from the UI, so the
 * actor is `human`. Writes (forecasts, ambiguity, forced rights) are accepted only from the main
 * window; until the agent's MCP server exists (Phase 4) this is how forecasts get into the ledger.
 */
export function registerLedgerHandlers(ledger: LedgerService, markets: MarketService, isTrustedSender: TrustedSenderCheck): void {
  ipcMain.handle('ledger:submitForecast', async (event, input: unknown) => {
    if (!isTrustedSender(event.sender)) return UNTRUSTED;
    return respond(() => ledger.submitForecast(input, 'human'));
  });

  ipcMain.handle('ledger:withdrawForecast', async (event, id: string, reason: string) => {
    if (!isTrustedSender(event.sender)) return UNTRUSTED;
    return respond(() => ledger.withdrawForecast(id, reason, 'human'));
  });

  ipcMain.handle('ledger:list', (_event, filter?: unknown) =>
    respond(() => ledger.list((parseInput(ForecastListFilterSchema, filter && typeof filter === 'object' ? filter : undefined) ?? {}) as ForecastFilter))
  );

  ipcMain.handle('ledger:stats', () => respond(() => ledger.stats()));

  ipcMain.handle('ledger:setRightsState', async (event, category: string, bucket: HorizonBucket, state: CategoryRightsState | 'auto', reason: string) => {
    if (!isTrustedSender(event.sender)) return UNTRUSTED;
    return respond(() => ledger.forceRightsState(category, bucket, state, reason, 'human'));
  });

  ipcMain.handle('markets:get', (_event, marketId: string) => respond(() => markets.get(marketId)));

  ipcMain.handle('markets:setAmbiguity', async (event, marketId: string, score: number, note?: string) => {
    if (!isTrustedSender(event.sender)) return UNTRUSTED;
    return respond(() => markets.setAmbiguity(marketId, score, 'human', note ?? null));
  });
}
