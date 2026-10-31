/**
 * Nightly SQLite backup (spec §15, §15.1): better-sqlite3's online `.backup()` API into
 * `<dataDir>/backups/botlab-<UTC timestamp>.db`, keeping the newest `keep` (default 14).
 *
 * Runs daily at `hour:minute` local time (TZ, e.g. Europe/Dublin in Docker). If the newest backup is
 * older than a day when the job starts (server was off at the scheduled time), one runs shortly after
 * start. A failure is logged and reported through `onResult`; it never affects trading.
 */

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';

const FILE_RE = /^botlab-\d{8}T\d{6}Z\.db$/;
const DAY_MS = 24 * 3600_000;

export interface BackupJobOptions {
  db: Database.Database;
  dir: string;
  keep?: number;
  /** Local time of the nightly run (default 03:30) */
  hour?: number;
  minute?: number;
  /** Delay of the catch-up run after start when the last backup is stale (default 5 min) */
  catchUpDelayMs?: number;
  now?: () => Date;
  onResult?: (result: { ok: true; file: string; pruned: string[] } | { ok: false; error: string }) => void;
}

export class BackupJob {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private running: Promise<unknown> | null = null;
  private readonly keep: number;
  private readonly now: () => Date;

  constructor(private opts: BackupJobOptions) {
    this.keep = Math.max(1, opts.keep ?? 14);
    this.now = opts.now ?? (() => new Date());
  }

  /** Existing backups, oldest first */
  list(): string[] {
    try {
      return fs
        .readdirSync(this.opts.dir)
        .filter((f) => FILE_RE.test(f))
        .sort();
    } catch {
      return [];
    }
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const newest = this.list().at(-1);
    const newestAt = newest ? fileTime(newest) : null;
    const stale = newestAt === null || this.now().getTime() - newestAt > DAY_MS;
    this.schedule(stale ? (this.opts.catchUpDelayMs ?? 5 * 60_000) : this.msUntilNext());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** One backup now (also used by tests and by a manual trigger) */
  async runOnce(): Promise<string> {
    if (this.running) await this.running.catch(() => undefined);
    const p = this.backup();
    this.running = p;
    try {
      return await p;
    } finally {
      if (this.running === p) this.running = null;
    }
  }

  private async backup(): Promise<string> {
    fs.mkdirSync(this.opts.dir, { recursive: true });
    const file = path.join(this.opts.dir, `botlab-${stamp(this.now())}.db`);
    const tmp = `${file}.partial`;
    try {
      await this.opts.db.backup(tmp);
      fs.renameSync(tmp, file);
      const pruned = this.prune();
      console.log(`[Backup] Database backed up to ${file}${pruned.length ? ` (removed ${pruned.length} old)` : ''}`);
      this.opts.onResult?.({ ok: true, file, pruned });
      return file;
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[Backup] Backup failed: ${error}`);
      this.opts.onResult?.({ ok: false, error });
      throw err;
    }
  }

  private prune(): string[] {
    const files = this.list();
    const remove = files.slice(0, Math.max(0, files.length - this.keep));
    for (const f of remove) fs.rmSync(path.join(this.opts.dir, f), { force: true });
    return remove;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runOnce()
        .catch(() => undefined)
        .finally(() => {
          // stop() may have run meanwhile: only reschedule while started
          if (this.stopped) return;
          this.schedule(this.msUntilNext());
        });
    }, delayMs);
    this.timer.unref?.();
  }

  /** Milliseconds until the next hour:minute local time (at least one minute ahead) */
  msUntilNext(): number {
    const now = this.now();
    const next = new Date(now.getTime());
    next.setHours(this.opts.hour ?? 3, this.opts.minute ?? 30, 0, 0);
    if (next.getTime() - now.getTime() < 60_000) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function fileTime(name: string): number | null {
  const m = /^botlab-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db$/.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}
