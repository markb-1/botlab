import { ipcMain } from 'electron';
import type { RiskService } from '../../../packages/core/src/services/RiskService';
import { respond, UNTRUSTED, type TrustedSenderCheck } from '../respond';

/**
 * Risk IPC (spec §4.2, §4.3, §4.6). Everything arriving over IPC comes from the UI, so the actor
 * is `human` — the only actor allowed to clear a halt.
 */
export function registerRiskHandlers(
  risk: RiskService,
  /** Only the app's main window may clear halts or press the kill switch */
  isTrustedSender: TrustedSenderCheck
): void {
  ipcMain.handle('risk:getState', () => respond(() => risk.getState()));

  ipcMain.handle('risk:clearHalt', async (event, scope: string, reason: string) => {
    if (!isTrustedSender(event.sender)) return UNTRUSTED;
    return respond(() => risk.clearHalt(scope, reason, 'human'));
  });

  ipcMain.handle('risk:killSwitch', async (event, reason: string) => {
    if (!isTrustedSender(event.sender)) return UNTRUSTED;
    return respond(() => risk.killSwitch(reason, 'human'));
  });
}
