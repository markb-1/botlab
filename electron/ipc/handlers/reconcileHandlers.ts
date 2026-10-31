import { ipcMain } from 'electron';
import type { ReconcileService } from '../../../packages/core/src/services/ReconcileService';
import { respond, UNTRUSTED, type TrustedSenderCheck } from '../respond';

/**
 * Reconciler and recorder IPC (spec §10, §13). Writes are human-only and accepted from the main window only.
 * The reconciler exists after unlock (it needs wallet keys); before that its calls fail.
 */
export function registerReconcileHandlers(reconcile: ReconcileService, isTrustedSender: TrustedSenderCheck): void {
  ipcMain.handle('reconcile:status', () => respond(() => reconcile.status()));

  /** One-time adoption of pre-existing exchange positions (R8) into a bot on the same wallet. */
  ipcMain.handle('reconcile:adoptPositions', async (event, walletId: string, botId: string, opts?: { includePostFirstOrder?: boolean }) => {
    if (!isTrustedSender(event.sender)) return UNTRUSTED;
    return respond(() => reconcile.adoptPositions(walletId, botId, 'human', opts));
  });

  ipcMain.handle('recorder:watchlistList', () => respond(() => reconcile.watchlistList()));

  ipcMain.handle('recorder:watchlistAdd', async (event, tokenId: string, marketId?: string | null, note?: string | null) => {
    if (!isTrustedSender(event.sender)) return UNTRUSTED;
    return respond(() => reconcile.watchlistAdd(tokenId, marketId, note, 'human'));
  });

  ipcMain.handle('recorder:watchlistRemove', async (event, tokenId: string) => {
    if (!isTrustedSender(event.sender)) return UNTRUSTED;
    return respond(() => reconcile.watchlistRemove(tokenId, 'human'));
  });
}
