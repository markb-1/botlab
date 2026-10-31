import { ipcMain, type WebContents } from 'electron';
import type { Reconciler } from '../../../packages/core/src/reconcile/Reconciler';
import type { OrderbookSnapshotRepository } from '../../../packages/core/src/db/repositories/OrderbookSnapshotRepository';
import type { AuditService } from '../../../packages/core/src/audit/AuditService';

/**
 * Reconciler and recorder IPC (spec §10, §13). Writes are human-only and accepted from the main window only.
 * The reconciler exists after unlock (it needs wallet keys); before that its calls fail.
 */
export function registerReconcileHandlers(deps: {
  getReconciler: () => Reconciler | null;
  snapshotRepo: OrderbookSnapshotRepository;
  audit: AuditService;
  isTrustedSender: (sender: WebContents) => boolean;
}): void {
  const untrusted = { success: false, error: 'Not allowed from this window' };
  const locked = { success: false, error: 'Unlock BotLab first (the reconciler needs wallet keys)' };

  ipcMain.handle('reconcile:status', async () => {
    const r = deps.getReconciler();
    if (!r) return locked;
    return { success: true, data: r.lastRun() };
  });

  /** One-time adoption of pre-existing exchange positions (R8) into a bot on the same wallet. */
  ipcMain.handle('reconcile:adoptPositions', async (event, walletId: string, botId: string, opts?: { includePostFirstOrder?: boolean }) => {
    if (!deps.isTrustedSender(event.sender)) return untrusted;
    const r = deps.getReconciler();
    if (!r) return locked;
    if (typeof walletId !== 'string' || !walletId || typeof botId !== 'string' || !botId) return { success: false, error: 'walletId and botId are required' };
    try {
      return { success: true, data: await r.adoptPositions(walletId, botId, 'human', { includePostFirstOrder: opts?.includePostFirstOrder === true }) };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('recorder:watchlistList', async () => {
    try {
      return { success: true, data: deps.snapshotRepo.watchlist() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('recorder:watchlistAdd', async (event, tokenId: string, marketId?: string | null, note?: string | null) => {
    if (!deps.isTrustedSender(event.sender)) return untrusted;
    if (typeof tokenId !== 'string' || !/^[0-9A-Za-z]{1,100}$/.test(tokenId)) return { success: false, error: 'tokenId must be a token id' };
    try {
      const m = typeof marketId === 'string' && marketId ? marketId.slice(0, 100) : null;
      const n = typeof note === 'string' && note ? note.slice(0, 500) : null;
      deps.snapshotRepo.addWatch(tokenId, m, n, 'human');
      deps.audit.record('human', 'recorder.watch_add', tokenId, { marketId: m, note: n });
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('recorder:watchlistRemove', async (event, tokenId: string) => {
    if (!deps.isTrustedSender(event.sender)) return untrusted;
    if (typeof tokenId !== 'string' || !tokenId) return { success: false, error: 'tokenId required' };
    try {
      const removed = deps.snapshotRepo.removeWatch(tokenId);
      deps.audit.record('human', 'recorder.watch_remove', tokenId, undefined, removed ? 'ok' : 'not found');
      return { success: true, data: { removed } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
