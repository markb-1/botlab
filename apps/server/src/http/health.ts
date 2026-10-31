/**
 * `/healthz` (spec §15): unauthenticated, minimal. 200 when healthy, 503 otherwise.
 * - db: `SELECT 1` succeeds
 * - unlocked: the core holds the master key
 * - reconciler: `risk_state.reconciled_at` (set when a reconciler run fully succeeded) is < 3 min old;
 *   during the first 3 minutes after unlock "starting" counts as healthy
 * - workers: no running bot is in the `error` state
 */

import type { Core } from '../../../../packages/core/src/core';

const RECONCILE_FRESH_MS = 3 * 60_000;

export interface HealthReport {
  ok: boolean;
  db: 'ok' | 'error';
  unlocked: boolean;
  reconciler: 'ok' | 'starting' | 'stale' | 'locked';
  workers: { running: number; failed: number };
}

export function healthReport(core: Core, unlockedAt: number | null, now = Date.now()): HealthReport {
  let db: HealthReport['db'] = 'ok';
  try {
    core.db.prepare('SELECT 1').get();
  } catch {
    db = 'error';
  }
  const unlocked = core.isUnlocked();
  let reconciler: HealthReport['reconciler'] = 'locked';
  if (unlocked && db === 'ok') {
    const at = core.repos.riskStateRepo.getGlobal()?.reconciled_at ?? null;
    const age = at ? now - Date.parse(at) : Infinity;
    if (age < RECONCILE_FRESH_MS) reconciler = 'ok';
    else if (unlockedAt !== null && now - unlockedAt < RECONCILE_FRESH_MS) reconciler = 'starting';
    else reconciler = 'stale';
  }
  const health = core.botManager?.getAllHealthInfo() ?? [];
  const workers = { running: health.filter((h) => h.status === 'running').length, failed: health.filter((h) => h.status === 'error').length };
  const ok = db === 'ok' && unlocked && (reconciler === 'ok' || reconciler === 'starting') && workers.failed === 0;
  return { ok, db, unlocked, reconciler, workers };
}
