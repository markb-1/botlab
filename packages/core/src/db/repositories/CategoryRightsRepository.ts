import type Database from 'better-sqlite3';
import type { CategoryRightsState, HorizonBucket } from '../../risk/types';

export interface CategoryRightsRow {
  category: string;
  horizon_bucket: HorizonBucket;
  state: CategoryRightsState;
  n_scored: number;
  skill_mean: number | null;
  skill_lower_bound: number | null;
  n_convergence: number;
  convergence_mean: number | null;
  convergence_lower_bound: number | null;
  max_allocation_usd: number;
  /** Total n_scored when the bucket last qualified for trading (allocation growth counts from here) */
  qualified_n: number | null;
  /** 1 = state set by a human; automatic promotions/deprioritisation are skipped (suspension still applies) */
  forced: number;
  last_evaluated_at: string | null;
  changed_at: string;
  changed_reason: string | null;
}

export interface RightsStatsUpdate {
  nScored: number;
  skillMean: number | null;
  skillLowerBound: number | null;
  nConvergence: number;
  convergenceMean: number | null;
  convergenceLowerBound: number | null;
  evaluatedAt: string;
}

/** category_rights (spec §2.2, §6.3). New buckets start in `shadow`. */
export class CategoryRightsRepository {
  constructor(private db: Database.Database) {}

  get(category: string, bucket: HorizonBucket): CategoryRightsRow | undefined {
    return this.db
      .prepare('SELECT * FROM category_rights WHERE category = ? AND horizon_bucket = ?')
      .get(category, bucket) as CategoryRightsRow | undefined;
  }

  all(): CategoryRightsRow[] {
    return this.db.prepare('SELECT * FROM category_rights ORDER BY category, horizon_bucket').all() as CategoryRightsRow[];
  }

  /** Row for the bucket, created in `shadow` when missing. */
  ensure(category: string, bucket: HorizonBucket, at: string): CategoryRightsRow {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO category_rights (category, horizon_bucket, state, changed_at, changed_reason)
         VALUES (?, ?, 'shadow', ?, 'new bucket')`
      )
      .run(category, bucket, at);
    return this.get(category, bucket)!;
  }

  updateStats(category: string, bucket: HorizonBucket, s: RightsStatsUpdate): void {
    this.db
      .prepare(
        `UPDATE category_rights SET n_scored = ?, skill_mean = ?, skill_lower_bound = ?, n_convergence = ?,
           convergence_mean = ?, convergence_lower_bound = ?, last_evaluated_at = ?
         WHERE category = ? AND horizon_bucket = ?`
      )
      .run(s.nScored, s.skillMean, s.skillLowerBound, s.nConvergence, s.convergenceMean, s.convergenceLowerBound, s.evaluatedAt, category, bucket);
  }

  /** State change (or allocation change when `state` equals the current one). */
  setState(
    category: string,
    bucket: HorizonBucket,
    u: { state: CategoryRightsState; maxAllocationUsd: number; qualifiedN: number | null; forced: boolean; reason: string; at: string; stateChanged: boolean }
  ): void {
    this.db
      .prepare(
        `UPDATE category_rights SET state = ?, max_allocation_usd = ?, qualified_n = ?, forced = ?,
           changed_at = CASE WHEN ? THEN ? ELSE changed_at END,
           changed_reason = CASE WHEN ? THEN ? ELSE changed_reason END
         WHERE category = ? AND horizon_bucket = ?`
      )
      .run(
        u.state, u.maxAllocationUsd, u.qualifiedN, u.forced ? 1 : 0,
        u.stateChanged ? 1 : 0, u.at, u.stateChanged ? 1 : 0, u.reason,
        category, bucket
      );
  }
}
