/**
 * AuditLogService — read side of `audit_log` for the Audit page and halt history (spec §12).
 * Paginated newest first with an id cursor (`before`): the next page asks for ids below the last one.
 * Writing stays with `AuditService.record`; rows are never changed (R15).
 */

import type { AuditRepository, AuditRow } from '../db/repositories/AuditRepository';
import { invalidInput } from './errors';

export const AUDIT_PAGE_MAX = 500;

export interface AuditQuery {
  action?: string;
  /** Action prefix, e.g. `risk.` (halt history) */
  actionPrefix?: string;
  actor?: string;
  target?: string;
  /** ISO time range; `until` is exclusive */
  since?: string;
  until?: string;
  /** Cursor: return rows with an id below this one */
  before?: number;
  limit?: number;
}

export interface AuditEntryView {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  payload: unknown;
  result: string | null;
}

export interface AuditPage {
  entries: AuditEntryView[];
  /** Pass as `before` for the next (older) page; null when this is the last page */
  nextBefore: number | null;
}

function isoOrUndefined(v: string | undefined, name: string): string | undefined {
  if (v === undefined || v === '') return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw invalidInput(`${name} must be a date/time`);
  return new Date(t).toISOString();
}

function toView(r: AuditRow): AuditEntryView {
  let payload: unknown = null;
  if (r.payload !== null) {
    try {
      payload = JSON.parse(r.payload);
    } catch {
      payload = r.payload;
    }
  }
  return { id: r.id, ts: r.ts, actor: r.actor, action: r.action, target: r.target, payload, result: r.result };
}

export class AuditLogService {
  constructor(private repo: Pick<AuditRepository, 'list' | 'actions'>) {}

  list(q: AuditQuery = {}): AuditPage {
    const limit = Math.min(Math.max(Math.floor(q.limit ?? 100), 1), AUDIT_PAGE_MAX);
    const rows = this.repo.list({
      action: q.action || undefined,
      actionPrefix: q.actionPrefix || undefined,
      actor: q.actor || undefined,
      target: q.target || undefined,
      sinceIso: isoOrUndefined(q.since, 'since'),
      untilIso: isoOrUndefined(q.until, 'until'),
      beforeId: q.before,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    return { entries: page.map(toView), nextBefore: rows.length > limit ? page[page.length - 1].id : null };
  }

  actions(): string[] {
    return this.repo.actions();
  }
}
