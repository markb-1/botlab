/**
 * AuditService — records who did what (spec §2.2 audit_log).
 *
 * Recording never throws: a failed audit write is logged and the caller's action
 * (e.g. a kill switch) still goes ahead.
 */

import type { AuditActor, AuditEntry, AuditRepository } from '../database/repositories/AuditRepository';
import logger from '../../src/utils/logger';

export type { AuditActor };

export class AuditService {
  constructor(private repo: Pick<AuditRepository, 'append'>) {}

  record(actor: AuditActor, action: string, target?: string | null, payload?: unknown, result?: string | null): void {
    const entry: AuditEntry = { actor, action, target: target ?? null, payload, result: result ?? null };
    try {
      this.repo.append(entry);
    } catch (err) {
      logger.error(`[Audit] Failed to record ${action} (${actor}, ${target ?? '-'}): ${err instanceof Error ? err.message : err}`);
    }
  }
}

export const botActor = (botId: string): AuditActor => `bot:${botId}`;
