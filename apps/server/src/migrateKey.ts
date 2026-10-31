/**
 * `npm run migrate-key`: one-time move of an existing (Electron-era) database from the
 * password-derived encryption key to the master key (spec §8.3).
 *
 * The old key was PBKDF2(password or, if the user skipped the password, a built-in constant, salt).
 * Every secret (wallet private keys, Binance credentials) is decrypted with it and re-encrypted with
 * the master key in one transaction (`rekeySecrets`, all or nothing); then the master-key check is
 * written and the legacy password fields are cleared. If no admin password is set yet and the old one
 * was a real password, it becomes the admin login password.
 */

import type Database from 'better-sqlite3';
import { deriveEncryptionKey, verifyPassword, LEGACY_SKIPPED_PASSWORD } from '../../../packages/core/src/security/passwordManager';
import { rekeySecrets, listSecrets } from '../../../packages/core/src/security/migrateSecrets';
import { keyCheckMatches, makeKeyCheck } from '../../../packages/core/src/security/masterKey';
import { AdminAuthStore } from '../../../packages/core/src/security/adminAuth';
import { decrypt } from '../../../packages/core/src/security/crypto';

export interface MigrateKeyResult {
  status: 'migrated' | 'nothing-to-do' | 'already-migrated';
  reencrypted: string[];
  adminPasswordSet: boolean;
}

interface LegacyRow {
  password_hash: string | null;
  password_salt: string | null;
  password_skipped: number | null;
  key_check: string | null;
  admin_password_hash: string | null;
}

export function needsPassword(db: Database.Database): boolean {
  const row = db.prepare("SELECT password_salt, password_skipped FROM settings WHERE id = 'global'").get() as { password_salt: string | null; password_skipped: number | null } | undefined;
  return !!row?.password_salt && !row.password_skipped;
}

export async function migrateKey(db: Database.Database, masterKey: string, password: string | undefined): Promise<MigrateKeyResult> {
  const row = db.prepare("SELECT password_hash, password_salt, password_skipped, key_check, admin_password_hash FROM settings WHERE id = 'global'").get() as LegacyRow | undefined;
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
    return { status: 'already-migrated', reencrypted: [], adminPasswordSet: false };
  }
  if (!row?.password_salt) {
    if (secrets.length > 0 && !readable(masterKey)) {
      throw new Error('This database has no password-derived key to migrate from, and its secrets do not decrypt with this master key');
    }
    db.prepare("UPDATE settings SET key_check = ? WHERE id = 'global'").run(makeKeyCheck(masterKey));
    return { status: 'nothing-to-do', reencrypted: [], adminPasswordSet: false };
  }

  const skipped = !!row.password_skipped;
  let oldPassword: string;
  if (skipped) {
    oldPassword = LEGACY_SKIPPED_PASSWORD;
  } else {
    if (!password) throw new Error('This database was protected by a password: pass it with --password (or enter it when asked)');
    if (row.password_hash && !verifyPassword(password, row.password_hash, row.password_salt)) throw new Error('Incorrect password');
    oldPassword = password;
  }
  const oldKey = deriveEncryptionKey(oldPassword, row.password_salt);

  const { reencrypted } = rekeySecrets(db, oldKey, masterKey);
  let adminPasswordSet = false;
  if (!skipped && !row.admin_password_hash) {
    adminPasswordSet = await new AdminAuthStore(db).setInitialAdminPassword(oldPassword).catch(() => false);
  }
  db.transaction(() => {
    db.prepare("UPDATE settings SET key_check = ?, password_hash = NULL, password_salt = NULL, password_skipped = 0, updated_at = datetime('now') WHERE id = 'global'").run(makeKeyCheck(masterKey));
  })();
  return { status: 'migrated', reencrypted, adminPasswordSet };
}
