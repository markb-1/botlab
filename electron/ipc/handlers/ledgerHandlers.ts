import { ipcMain, type WebContents } from 'electron';
import type { LedgerService } from '../../ledger/LedgerService';
import type { MarketCacheService } from '../../ledger/MarketCacheService';
import type { ForecastFilter, ForecastStatus } from '../../database/repositories/ForecastRepository';
import type { CategoryRightsState, HorizonBucket } from '../../risk/types';

/**
 * Forecast ledger and market IPC (spec §6). Everything arriving over IPC comes from the UI, so the
 * actor is `human`. Writes (forecasts, ambiguity, forced rights) are accepted only from the main
 * window; until the agent's MCP server exists (Phase 4) this is how forecasts get into the ledger.
 */
export function registerLedgerHandlers(
  ledger: LedgerService,
  markets: MarketCacheService,
  isTrustedSender: (sender: WebContents) => boolean
): void {
  const untrusted = { success: false, error: 'Not allowed from this window' };
  const fail = (error: unknown) => ({ success: false, error: error instanceof Error ? error.message : String(error) });

  ipcMain.handle('ledger:submitForecast', async (event, input: unknown) => {
    if (!isTrustedSender(event.sender)) return untrusted;
    try {
      return { success: true, data: await ledger.submitForecast(input, 'human') };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('ledger:withdrawForecast', async (event, id: string, reason: string) => {
    if (!isTrustedSender(event.sender)) return untrusted;
    try {
      return { success: true, data: ledger.withdrawForecast(id, reason, 'human') };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('ledger:list', async (_event, filter?: { status?: ForecastStatus | ForecastStatus[]; category?: string; horizonBucket?: HorizonBucket; marketId?: string; tokenId?: string; tradeableOnly?: boolean; limit?: number }) => {
    try {
      const f: ForecastFilter = filter && typeof filter === 'object' ? filter : {};
      return { success: true, data: ledger.list(f) };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('ledger:stats', async () => {
    try {
      return { success: true, data: ledger.stats() };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('ledger:setRightsState', async (event, category: string, bucket: HorizonBucket, state: CategoryRightsState | 'auto', reason: string) => {
    if (!isTrustedSender(event.sender)) return untrusted;
    try {
      return { success: true, data: ledger.forceRightsState(category, bucket, state, reason, 'human') };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('markets:get', async (_event, marketId: string) => {
    try {
      if (typeof marketId !== 'string' || !marketId) throw new Error('marketId required');
      return { success: true, data: await markets.getMarket(marketId) };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('markets:setAmbiguity', async (event, marketId: string, score: number, note?: string) => {
    if (!isTrustedSender(event.sender)) return untrusted;
    try {
      return { success: true, data: await markets.setAmbiguity(marketId, score, 'human', note ?? null) };
    } catch (error) {
      return fail(error);
    }
  });
}
