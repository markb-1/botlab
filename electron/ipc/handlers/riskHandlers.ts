import { ipcMain } from 'electron';
import type { HaltService } from '../../risk/HaltService';
import type { KillSwitch } from '../../risk/KillSwitch';
import type { BotRepository } from '../../database/repositories/BotRepository';

/**
 * Risk IPC (spec §4.2, §4.3, §4.6). Everything arriving over IPC comes from the UI, so the actor
 * is `human` — the only actor allowed to clear a halt.
 */
export function registerRiskHandlers(halts: HaltService, killSwitch: KillSwitch, botRepo: BotRepository): void {
  ipcMain.handle('risk:getState', async () => {
    try {
      const state = halts.getState();
      const byScope = new Map(state.bots.map((b) => [b.scope, b]));
      const bots = botRepo.findAll().map((bot) => {
        const s = byScope.get(bot.id);
        return {
          botId: bot.id,
          name: bot.name,
          stage: bot.stage,
          mode: bot.mode,
          status: bot.status,
          halted: s?.halted ?? false,
          haltReason: s?.reason ?? null,
          haltedAt: s?.haltedAt ?? null,
          dayRealizedPnl: s?.dayRealizedPnl ?? 0,
          dayUnrealizedPnl: s?.dayUnrealizedPnl ?? 0,
          dayStartEquity: s?.dayStartEquity ?? null,
          updatedAt: s?.updatedAt ?? null,
        };
      });
      return { success: true, data: { global: state.global, bots } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('risk:clearHalt', async (_event, scope: string, reason: string) => {
    try {
      halts.clearHalt(scope, reason, 'human');
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('risk:killSwitch', async (_event, reason: string) => {
    try {
      const result = await killSwitch.activate(typeof reason === 'string' && reason.trim() ? reason : 'manual kill switch', 'human');
      return {
        success: true,
        data: {
          stopped: result.stopped,
          cancelled: result.cancelled,
          failed: result.failed,
          unknownOutcome: result.unknownOutcome,
          errors: result.errors,
        },
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
