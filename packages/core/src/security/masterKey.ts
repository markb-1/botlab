/**
 * Master key (spec §8.3). The server loads a 32-byte key (64 hex) from `BOTLAB_MASTER_KEY` or
 * `BOTLAB_MASTER_KEY_FILE` at boot and unlocks the core with it; there is no password-derived key any
 * more. `settings.key_check` holds a constant encrypted with the master key, so a wrong key is
 * detected before anything is decrypted or written with it.
 */

import type Database from 'better-sqlite3';
import { decrypt, encrypt } from './crypto';
import { listSecrets } from './migrateSecrets';
import { ServiceError } from '../services/errors';

const KEY_CHECK_PLAINTEXT = 'botlab-master-key-check-v1';
const KEY_RE = /^[0-9a-fA-F]{64}$/;

export function isValidMasterKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_RE.test(value);
}

export function keyCheckMatches(keyCheck: string, keyHex: string): boolean {
  try {
    return decrypt(keyCheck, keyHex) === KEY_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

export function makeKeyCheck(keyHex: string): string {
  return encrypt(KEY_CHECK_PLAINTEXT, keyHex);
}

/**
 * Throws `ServiceError('locked')` unless `keyHex` is this database's master key. On the first unlock of
 * a database (no key check yet) every stored secret must decrypt with the key; then the key check is
 * written. A database still encrypted with the old password-derived key needs `npm run migrate-key`.
 */
export function verifyMasterKey(db: Database.Database, keyHex: string): void {
  if (!isValidMasterKey(keyHex)) throw new ServiceError('locked', 'The master key must be 64 hex characters (32 bytes)');
  const row = db.prepare("SELECT key_check, password_salt FROM settings WHERE id = 'global'").get() as { key_check: string | null; password_salt: string | null } | undefined;
  if (row?.key_check) {
    if (keyCheckMatches(row.key_check, keyHex)) return;
    throw new ServiceError('locked', 'The master key does not match this database (check BOTLAB_MASTER_KEY / BOTLAB_MASTER_KEY_FILE)');
  }
  const unreadable = listSecrets(db)
    .filter((s) => {
      try {
        decrypt(s.payload, keyHex);
        return false;
      } catch {
        return true;
      }
    })
    .map((s) => s.label);
  if (unreadable.length > 0) {
    throw new ServiceError(
      'locked',
      row?.password_salt
        ? `Secrets in this database are encrypted with the old password-derived key (${unreadable.join(', ')}): stop the server and run \`npm run migrate-key\` once`
        : `Secrets in this database cannot be decrypted with this master key (${unreadable.join(', ')})`
    );
  }
  db.prepare("UPDATE settings SET key_check = ?, updated_at = datetime('now') WHERE id = 'global'").run(makeKeyCheck(keyHex));
}
