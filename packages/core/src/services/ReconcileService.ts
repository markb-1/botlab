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
import { scrubPublicText } from './redact';

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
    const last = this.reconciler().lastRun();
    if (!last) return null;
    // Exchange / Data API errors may embed request URLs (signed Binance queries): host only
    return { ...last, result: { ...last.result, errors: last.result.errors.map(scrubPublicText) } };
  }

  /** One-time adoption of pre-existing exchange positions (R8) into a bot on the same wallet */
  async adoptPositions(walletId: unknown, botId: unknown, actor: HumanActor, opts?: { includePostFirstOrder?: unknown }) {
    const r = this.reconciler();
    if (typeof walletId !== 'string' || !walletId || typeof botId !== 'string' || !botId) throw invalidInput('walletId and botId are required');
    return r.adoptPositions(walletId, botId, actor, { includePostFirstOrder: opts?.includePostFirstOrder === true });
  }

  /**
   * What `adoptPositions` would adopt now (same checks). Writes no adopted fill, but first syncs the wallet's
   * orders with the exchange like a reconciler run (may record real fills, expire or link orders). Human only.
   */
  async adoptPreview(walletId: unknown, botId: unknown, actor: HumanActor, opts?: { includePostFirstOrder?: unknown }) {
    const r = this.reconciler();
    if (typeof walletId !== 'string' || !walletId || typeof botId !== 'string' || !botId) throw invalidInput('walletId and botId are required');
    return r.adoptPositions(walletId, botId, actor, { includePostFirstOrder: opts?.includePostFirstOrder === true, dryRun: true });
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
    // The agent removes only tokens it added (R145)
    const row = this.deps.snapshotRepo.watchlist().find((w) => w.token_id === tokenId);
    if (actor === 'agent' && row && row.added_by !== 'agent') {
      this.deps.audit.record(actor, 'recorder.watch_remove', tokenId, undefined, 'denied: added by a human');
      throw new ServiceError('forbidden', 'recorder.watchlistRemove: the agent may only remove tokens it added');
    }
    const removed = this.deps.snapshotRepo.removeWatch(tokenId);
    this.deps.audit.record(actor, 'recorder.watch_remove', tokenId, undefined, removed ? 'ok' : 'not found');
    return { removed };
  }
}
