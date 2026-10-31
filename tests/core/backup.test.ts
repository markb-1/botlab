/**
 * Nightly SQLite backup (spec §15): `.backup()` into <dataDir>/backups, newest `keep` retained, the
 * copy is a readable database, and the next run is scheduled at the configured local time.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../orders/db';
import { initializeDatabase, closeDatabase } from '../../packages/core/src/db/index';
import { BackupJob } from '../../packages/core/src/ops/BackupJob';
import Database from 'better-sqlite3';

describe.skipIf(!sqliteAvailable)('BackupJob', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('backs up to a readable copy and keeps only the newest N', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-backup-'));
    const db = initializeDatabase(path.join(tmp, 'botlab.db'));
    try {
      db.prepare("INSERT INTO wallets (id, name, address, private_key_encrypted) VALUES ('w1', 'w1', '0xabc', 'x')").run();
      let t = Date.UTC(2026, 9, 1, 2, 0, 0);
      const dir = path.join(tmp, 'backups');
      const job = new BackupJob({ db, dir, keep: 3, now: () => new Date(t) });
      for (let i = 0; i < 5; i++) {
        await job.runOnce();
        t += 24 * 3600_000;
      }
      const files = job.list();
      expect(files).toEqual(['botlab-20261003T020000Z.db', 'botlab-20261004T020000Z.db', 'botlab-20261005T020000Z.db']);
      expect(fs.readdirSync(dir).some((f) => f.endsWith('.partial'))).toBe(false);
      const copy = new Database(path.join(dir, files[2]), { readonly: true });
      expect(copy.prepare('SELECT address FROM wallets').get()).toEqual({ address: '0xabc' });
      copy.close();
    } finally {
      closeDatabase(db);
    }
  });

  it('next run is at hour:minute local time, at least a minute ahead', () => {
    const now = new Date(2026, 9, 31, 3, 0, 0); // local 03:00
    const job = new BackupJob({ db: {} as never, dir: '.', hour: 3, minute: 30, now: () => now });
    expect(job.msUntilNext()).toBe(30 * 60_000);
    const later = new Date(2026, 9, 31, 4, 0, 0);
    const job2 = new BackupJob({ db: {} as never, dir: '.', hour: 3, minute: 30, now: () => later });
    const next = new Date(later.getTime() + job2.msUntilNext());
    expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([1, 3, 30]);
  });
});
