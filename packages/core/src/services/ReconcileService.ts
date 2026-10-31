/**
 * ReconcileService — reconciler status, adoption of pre-existing positions, recorder watchlist
 * (moved out of the Electron `reconcileHandlers`, spec §10, §13). The reconciler exists after unlock
 * (it needs wallet keys); before that its calls throw `ServiceError('locked')`. Adoption and
 * watchlist writes are audited with the given actor; adoption is human-only (Reconciler refuses others).
 */

import type { Reconciler } from '../reconcile/Reconciler';
import type { OrderbookSnapshotRepository } from '../db/repositories/OrderbookSnapshotRepository';
import type { AuditService } from '../audit/AuditService';
import { auditActorOf, requireActor, type Actor, type HumanActor } from './actors';
import { ServiceError, invalidInput } from './errors';

export class ReconcileService {
  constructor(
    private deps: {
      getReconciler: () => Reconciler | null;
      snapshotRepo: OrderbookSnapshotRepository;
      audit: AuditService;
    }
  ) {}

  private reconciler(): Reconciler {
    const r = this.deps.getReconciler();
    if (!r) throw new ServiceError('locked', 'Unlock BotLab first (the reconciler needs wallet keys)');
    return r;
  }

  /** Last reconciler run (null before the first one) */
  status() {
    return this.reconciler().lastRun();
  }

  /** One-time adoption of pre-existing exchange positions (R8) into a bot on the same wallet */
  async adoptPositions(walletId: unknown, botId: unknown, actor: HumanActor, opts?: { includePostFirstOrder?: unknown }) {
    const r = this.reconciler();
    if (typeof walletId !== 'string' || !walletId || typeof botId !== 'string' || !botId) throw invalidInput('walletId and botId are required');
    return r.adoptPositions(walletId, botId, actor, { includePostFirstOrder: opts?.includePostFirstOrder === true });
  }

  watchlistList() {
    return this.deps.snapshotRepo.watchlist();
  }

  /** Human or agent */
  watchlistAdd(tokenId: unknown, marketId: unknown, note: unknown, by: Actor): void {
    const actor = auditActorOf(requireActor(by, ['human', 'agent'], 'recorder.watchlistAdd'));
    if (typeof tokenId !== 'string' || !/^[0-9A-Za-z]{1,100}$/.test(tokenId)) throw invalidInput('tokenId must be a token id');
    const m = typeof marketId === 'string' && marketId ? marketId.slice(0, 100) : null;
    const n = typeof note === 'string' && note ? note.slice(0, 500) : null;
    this.deps.snapshotRepo.addWatch(tokenId, m, n, actor);
    this.deps.audit.record(actor, 'recorder.watch_add', tokenId, { marketId: m, note: n });
  }

  /** Human or agent */
  watchlistRemove(tokenId: unknown, by: Actor): { removed: boolean } {
    const actor = auditActorOf(requireActor(by, ['human', 'agent'], 'recorder.watchlistRemove'));
    if (typeof tokenId !== 'string' || !tokenId) throw invalidInput('tokenId required');
    const removed = this.deps.snapshotRepo.removeWatch(tokenId);
    this.deps.audit.record(actor, 'recorder.watch_remove', tokenId, undefined, removed ? 'ok' : 'not found');
    return { removed };
  }
}
