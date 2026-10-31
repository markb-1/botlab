/**
 * Master key (spec §8.3): loading from env / file / data dir, dev generation, the key check that
 * keeps a wrong key from unlocking, and the `migrate-key` round trip from an Electron-era database
 * encrypted with the password-derived key (real password and skipped password).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { sqliteAvailable } from '../orders/db';
import { createCore } from '../../packages/core/src';
import { initializeDatabase, closeDatabase } from '../../packages/core/src/db/index';
import { encrypt, decrypt } from '../../packages/core/src/security/crypto';
import { deriveEncryptionKey, generateSalt, hashForVerification, LEGACY_SKIPPED_PASSWORD } from '../../packages/core/src/security/passwordManager';
import { AdminAuthStore } from '../../packages/core/src/security/adminAuth';
import { loadMasterKey, MasterKeyError } from '../../apps/server/src/masterKey';
import { migrateKey } from '../../apps/server/src/migrateKey';

const hex = () => crypto.randomBytes(32).toString('hex');
let tmp: string | null = null;
const mkTmp = () => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-key-')));

afterEach(() => {
  vi.unstubAllGlobals();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('loadMasterKey', () => {
  it('env, then file, then <dataDir>/master.key; validates 64 hex', () => {
    const dir = mkTmp();
    const k = hex();
    expect(loadMasterKey({ env: { BOTLAB_MASTER_KEY: k.toUpperCase() }, dataDir: dir, production: true })).toEqual({ key: k, source: 'env' });
    expect(() => loadMasterKey({ env: { BOTLAB_MASTER_KEY: 'abc' }, dataDir: dir, production: true })).toThrow(MasterKeyError);

    const file = path.join(dir, 'key.txt');
    fs.writeFileSync(file, `${k}\r\n`); // Windows editors add CRLF
    expect(loadMasterKey({ env: { BOTLAB_MASTER_KEY_FILE: file }, dataDir: dir, production: true })).toMatchObject({ key: k, source: 'file' });
    expect(() => loadMasterKey({ env: { BOTLAB_MASTER_KEY_FILE: path.join(dir, 'missing') }, dataDir: dir, production: true })).toThrow(/cannot read/);
  });

  it('production without a key is fatal; dev generates <dataDir>/master.key once (0600 on POSIX)', () => {
    const dir = mkTmp();
    expect(() => loadMasterKey({ env: {}, dataDir: dir, production: true })).toThrow(/No master key/);
    const log = vi.fn();
    const gen = loadMasterKey({ env: {}, dataDir: dir, production: false, log });
    expect(gen.source).toBe('generated');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/WARNING.*generated a new master key/));
    const file = path.join(dir, 'master.key');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Next start (dev or production) reuses it
    expect(loadMasterKey({ env: {}, dataDir: dir, production: true })).toMatchObject({ key: gen.key, source: 'data-dir' });
  });
});

describe.skipIf(!sqliteAvailable)('master key check and migrate-key', () => {
  function offline() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline (test)');
      })
    );
  }

  async function bootAndUnlock(dataDir: string, key: string) {
    offline();
    const core = createCore({ dataDir, configDir: path.join(tmp!, 'config'), backups: false });
    await core.start();
    try {
      await core.unlock(key);
    } finally {
      await core.shutdown({ timeoutMs: 20_000 });
      core.close();
    }
  }

  it('the first unlock records the key; another key is refused (core stays locked)', async () => {
    const dataDir = path.join(mkTmp(), 'data');
    const key = hex();
    await bootAndUnlock(dataDir, key);
    await expect(bootAndUnlock(dataDir, hex())).rejects.toMatchObject({ code: 'locked', message: expect.stringMatching(/does not match/) });
    await bootAndUnlock(dataDir, key);
  }, 60_000);

  /** An Electron-era database: secrets under PBKDF2(password, salt), one in the legacy CryptoJS format */
  function legacyDb(dataDir: string, password: string | null) {
    fs.mkdirSync(dataDir, { recursive: true });
    const db = initializeDatabase(path.join(dataDir, 'botlab.db'));
    const salt = generateSalt();
    const oldKey = deriveEncryptionKey(password ?? LEGACY_SKIPPED_PASSWORD, salt);
    db.prepare("UPDATE settings SET password_hash = ?, password_salt = ?, password_skipped = ? WHERE id = 'global'").run(
      password ? hashForVerification(password, salt) : null,
      salt,
      password ? 0 : 1
    );
    db.prepare("INSERT INTO wallets (id, name, address, private_key_encrypted) VALUES ('w1', 'w1', '0xabc', ?)").run(encrypt('ab'.repeat(32), oldKey));
    db.prepare("UPDATE settings SET binance_api_key_encrypted = ?, binance_api_secret_encrypted = ? WHERE id = 'global'").run(encrypt('api-key', oldKey), encrypt('api-secret', oldKey));
    return db;
  }

  it('round trip: locked until migrate-key; wrong password changes nothing; then unlocks with the master key', async () => {
    const dataDir = path.join(mkTmp(), 'data');
    const master = hex();
    const db = legacyDb(dataDir, 'old password 1');
    closeDatabase(db);

    await expect(bootAndUnlock(dataDir, master)).rejects.toMatchObject({ code: 'locked', message: expect.stringMatching(/migrate-key/) });

    const db2 = initializeDatabase(path.join(dataDir, 'botlab.db'));
    try {
      const before = db2.prepare("SELECT private_key_encrypted AS v FROM wallets WHERE id = 'w1'").get() as { v: string };
      await expect(migrateKey(db2, master)).rejects.toThrow(/BOTLAB_OLD_PASSWORD/);
      await expect(migrateKey(db2, master, { oldPassword: 'wrong' })).rejects.toThrow(/Incorrect password/);
      expect((db2.prepare("SELECT private_key_encrypted AS v FROM wallets WHERE id = 'w1'").get() as { v: string }).v).toBe(before.v);

      const r = await migrateKey(db2, master, { oldPassword: 'old password 1' });
      expect(r).toMatchObject({ status: 'migrated', adminPassword: 'old' });
      expect(r.reencrypted.sort()).toEqual(['settings.binance_api_key_encrypted', 'settings.binance_api_secret_encrypted', 'wallet:w1']);
      const w = db2.prepare("SELECT private_key_encrypted AS v FROM wallets WHERE id = 'w1'").get() as { v: string };
      expect(decrypt(w.v, master)).toBe('ab'.repeat(32));
      const s = db2.prepare("SELECT * FROM settings WHERE id = 'global'").get() as Record<string, string | null>;
      expect(decrypt(s.binance_api_secret_encrypted!, master)).toBe('api-secret');
      expect(s.password_salt).toBeNull();
      expect(s.password_hash).toBeNull();
      expect(await new AdminAuthStore(db2).verifyAdminPassword('old password 1')).toBe(true);
      // Idempotent
      expect((await migrateKey(db2, master)).status).toBe('already-migrated');
    } finally {
      closeDatabase(db2);
    }

    await bootAndUnlock(dataDir, master);
  }, 60_000);

  it('a skipped-password database needs no old password but must get an admin password (all or nothing)', async () => {
    const dataDir = path.join(mkTmp(), 'data');
    const master = hex();
    const db = legacyDb(dataDir, null);
    try {
      const before = db.prepare("SELECT private_key_encrypted AS v FROM wallets WHERE id = 'w1'").get() as { v: string };
      // No admin password would be set ⇒ refused before anything is written
      await expect(migrateKey(db, master)).rejects.toThrow(/admin password/);
      await expect(migrateKey(db, master, { newAdminPassword: 'short' })).rejects.toThrow(/at least 8/);
      expect((db.prepare("SELECT private_key_encrypted AS v FROM wallets WHERE id = 'w1'").get() as { v: string }).v).toBe(before.v);
      expect((db.prepare("SELECT password_salt FROM settings WHERE id = 'global'").get() as { password_salt: string | null }).password_salt).not.toBeNull();

      const r = await migrateKey(db, master, { newAdminPassword: 'brand new admin pw' });
      expect(r).toMatchObject({ status: 'migrated', adminPassword: 'new' });
      expect(await new AdminAuthStore(db).verifyAdminPassword('brand new admin pw')).toBe(true);
      const w = db.prepare("SELECT private_key_encrypted AS v FROM wallets WHERE id = 'w1'").get() as { v: string };
      expect(decrypt(w.v, master)).toBe('ab'.repeat(32));
    } finally {
      closeDatabase(db);
    }
    await bootAndUnlock(dataDir, master);
  }, 60_000);
});

describe('instance lock', () => {
  it('one server per data dir: a live holder refuses, a stale lock (dead pid) is replaced', async () => {
    const { acquireInstanceLock, lockFile } = await import('../../apps/server/src/instanceLock');
    const dir = mkTmp();
    const boot = Date.now() - os.uptime() * 1000;
    // Stale: a pid that does not exist
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), bootTime: boot, startedAt: 'earlier' }));
    const release = acquireInstanceLock(dir);
    expect(JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')).pid).toBe(process.pid);
    release();
    expect(fs.existsSync(lockFile(dir))).toBe(false);
    // Live: our parent process on this host and boot
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.ppid, host: os.hostname(), bootTime: boot, startedAt: 'now' }));
    expect(() => acquireInstanceLock(dir)).toThrow(/Another BotLab server/);
  });
});
