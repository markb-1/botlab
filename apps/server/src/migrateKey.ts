/**
 * `npm run migrate-key`: one-time move of an existing (Electron-era) database from the
 * password-derived encryption key to the master key (spec §8.3).
 *
 * The old key was PBKDF2(password or, if the user skipped the password, a built-in constant, salt).
 * Every secret (wallet private keys, Binance credentials) is decrypted with it and re-encrypted with
 * the master key, the master-key check is written and the legacy password fields are cleared — all in
 * one transaction. If no admin password is set yet, the old password becomes it (when it is a real
 * password of 8+ characters); otherwise a new admin password must be given, or nothing is migrated.
 */

import type Database from 'better-sqlite3';
import { deriveEncryptionKey, verifyPassword, LEGACY_SKIPPED_PASSWORD } from '../../../packages/core/src/security/passwordManager';
import { rekeySecrets, listSecrets } from '../../../packages/core/src/security/migrateSecrets';
import { keyCheckMatches, makeKeyCheck } from '../../../packages/core/src/security/masterKey';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../../../packages/core/src/security/adminAuth';
import { decrypt } from '../../../packages/core/src/security/crypto';

export interface MigrateKeyResult {
  status: 'migrated' | 'nothing-to-do' | 'already-migrated';
  reencrypted: string[];
  /** Which password became the admin login password: the old one, the new one given, or none (one existed) */
  adminPassword: 'old' | 'new' | null;
}

export interface MigrateKeyOptions {
  /** The old BotLab password (not needed for a "skipped password" install) */
  oldPassword?: string;
  /** Admin login password to set when none exists and the old password cannot be used (skipped, < 8 chars) */
  newAdminPassword?: string;
}

interface LegacyRow {
  password_hash: string | null;
  password_salt: string | null;
  password_skipped: number | null;
  key_check: string | null;
  admin_password_hash: string | null;
}

function legacyRow(db: Database.Database): LegacyRow | undefined {
  return db.prepare("SELECT password_hash, password_salt, password_skipped, key_check, admin_password_hash FROM settings WHERE id = 'global'").get() as LegacyRow | undefined;
}

export function needsPassword(db: Database.Database): boolean {
  const row = legacyRow(db);
  return !!row?.password_salt && !row.password_skipped;
}

/**
 * True when migrating will leave the server without an admin password unless `newAdminPassword` is
 * given: there is something to migrate, no admin password yet, and the old password cannot become it.
 */
export function needsNewAdminPassword(db: Database.Database, oldPassword?: string): boolean {
  const row = legacyRow(db);
  if (!row?.password_salt || row.admin_password_hash) return false;
  return !!row.password_skipped || !oldPassword || oldPassword.length < MIN_PASSWORD_LENGTH;
}

/**
 * Everything is written in one transaction (secrets, admin password, key check, legacy fields cleared);
 * any failure (wrong password, an unreadable secret, missing admin password) changes nothing.
 */
export async function migrateKey(db: Database.Database, masterKey: string, opts: MigrateKeyOptions = {}): Promise<MigrateKeyResult> {
  const row = legacyRow(db);
  const secrets = listSecrets(db);
  const readable = (key: string) =>
    secrets.every((s) => {
      try {
        decrypt(s.payload, key);
        return true;
      } catch {
        return false;
      }
    });

  if (row?.key_check && keyCheckMatches(row.key_check, masterKey) && readable(masterKey)) {
    return { status: 'already-migrated', reencrypted: [], adminPassword: null };
  }
  if (!row?.password_salt) {
    if (secrets.length > 0 && !readable(masterKey)) {
      throw new Error('This database has no password-derived key to migrate from, and its secrets do not decrypt with this master key');
    }
    db.prepare("UPDATE settings SET key_check = ? WHERE id = 'global'").run(makeKeyCheck(masterKey));
    return { status: 'nothing-to-do', reencrypted: [], adminPassword: null };
  }

  const skipped = !!row.password_skipped;
  let oldPassword: string;
  if (skipped) {
    oldPassword = LEGACY_SKIPPED_PASSWORD;
  } else {
    if (!opts.oldPassword) throw new Error('This database was protected by a password: enter it when asked (or set BOTLAB_OLD_PASSWORD)');
    if (row.password_hash && !verifyPassword(opts.oldPassword, row.password_hash, row.password_salt)) throw new Error('Incorrect password');
    oldPassword = opts.oldPassword;
  }
  const oldKey = deriveEncryptionKey(oldPassword, row.password_salt);

  // Admin login password: decided (and hashed) before anything is written
  let adminPassword: MigrateKeyResult['adminPassword'] = null;
  let adminHash: string | null = null;
  if (!row.admin_password_hash) {
    if (!skipped && oldPassword.length >= MIN_PASSWORD_LENGTH) {
      adminPassword = 'old';
      adminHash = await hashPassword(oldPassword);
    } else if (opts.newAdminPassword) {
      if (opts.newAdminPassword.length < MIN_PASSWORD_LENGTH) throw new Error(`The new admin password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      adminPassword = 'new';
      adminHash = await hashPassword(opts.newAdminPassword);
    } else {
      throw new Error('No admin password would be set: choose a new admin password (prompted, or BOTLAB_NEW_ADMIN_PASSWORD)');
    }
  }

  let reencrypted: string[] = [];
  db.transaction(() => {
    reencrypted = rekeySecrets(db, oldKey, masterKey).reencrypted;
    if (adminHash) db.prepare("UPDATE settings SET admin_password_hash = ?, setup_code_hash = NULL WHERE id = 'global'").run(adminHash);
    db.prepare("UPDATE settings SET key_check = ?, password_hash = NULL, password_salt = NULL, password_skipped = 0, updated_at = datetime('now') WHERE id = 'global'").run(makeKeyCheck(masterKey));
  })();
  return { status: 'migrated', reencrypted, adminPassword };
}
