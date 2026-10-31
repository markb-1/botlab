import { ipcMain } from 'electron';
import type { BotService } from '../../../packages/core/src/services/BotService';
import { BotCreateSchema, BotListFilterSchema, BotUpdateSchema, HoursSchema, parseInput } from '../../../packages/core/src/services/schemas';
import { respond } from '../respond';

/** Bot IPC. Everything arriving over IPC comes from the UI, so the actor is `human`. */
export function registerBotHandlers(bots: BotService): void {
  ipcMain.handle('bots:list', (_event, filter?: unknown) => respond(() => bots.list(parseInput(BotListFilterSchema, filter))));

  ipcMain.handle('bots:get', (_event, id: string) => respond(() => bots.get(id)));

  ipcMain.handle('bots:create', (_event, data: unknown) => respond(() => bots.create(parseInput(BotCreateSchema, data), 'human')));

  ipcMain.handle('bots:update', (_event, id: string, data: unknown) => respond(() => bots.update(id, parseInput(BotUpdateSchema, data), 'human')));

  ipcMain.handle('bots:delete', (_event, id: string) => respond(() => bots.delete(id, 'human')));

  ipcMain.handle('bots:start', (_event, id: string) => respond(() => bots.start(id, 'human')));

  ipcMain.handle('bots:stop', (_event, id: string) => respond(() => bots.stop(id, 'human')));

  ipcMain.handle('bots:restart', (_event, id: string) => respond(() => bots.restart(id, 'human')));

  // Resolves missing market names from the Polymarket API and backfills the database
  ipcMain.handle('bots:trades', (_event, botId: string, hours?: unknown) => respond(() => bots.trades(botId, parseInput(HoursSchema, hours))));

  // Live mode: Polymarket Data API; paper mode: trade history + Gamma prices
  ipcMain.handle('bots:positions', (_event, botId: string) => respond(() => bots.positions(botId)));

  ipcMain.handle('bots:stats', (_event, botId: string) => respond(() => bots.stats(botId)));

  ipcMain.handle('bots:dashboard-stats', () => respond(() => bots.dashboardStats()));

  ipcMain.handle('bots:trades:all', (_event, hours?: unknown) => respond(() => bots.allTrades(parseInput(HoursSchema, hours))));
}
