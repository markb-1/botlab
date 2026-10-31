/**
 * AuditService — records who did what (spec §2.2 audit_log).
 *
 * Recording never throws: a failed audit write is logged and the caller's action
 * (e.g. a kill switch) still goes ahead.
 */

import type { AuditActor, AuditEntry, AuditRepository } from '../db/repositories/AuditRepository';
import logger from '../utils/logger';

export type { AuditActor };

export class AuditService {
  private listeners = new Set<(entry: AuditEntry) => void>();

  constructor(private repo: Pick<AuditRepository, 'append'>) {}

  /** Called after each successfully recorded entry (notifications). Listener errors are swallowed. */
  onRecord(listener: (entry: AuditEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(actor: AuditActor, action: string, target?: string | null, payload?: unknown, result?: string | null): void {
    const entry: AuditEntry = { actor, action, target: target ?? null, payload, result: result ?? null };
    try {
      this.repo.append(entry);
    } catch (err) {
      logger.error(`[Audit] Failed to record ${action} (${actor}, ${target ?? '-'}): ${err instanceof Error ? err.message : err}`);
      return;
    }
    for (const l of this.listeners) {
      try {
        l(entry);
      } catch (err) {
        logger.error(`[Audit] Listener failed for ${action}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}

export const botActor = (botId: string): AuditActor => `bot:${botId}`;
