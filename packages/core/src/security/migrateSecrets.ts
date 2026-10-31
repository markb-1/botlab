/**
 * Re-encryption of secrets at rest (spec §8.3): wallet private keys (incl. paper wallets) and the
 * Binance API key/secret.
 *
 * - `migrateSecretsToV2` — one-time migration from CryptoJS (passphrase mode, MD5 KDF) to AES-256-GCM
 *   v2 with the same key. Runs after unlock; idempotent (rows already in v2 are skipped). A row that
 *   cannot be decrypted is left untouched and reported; the rest are migrated in one transaction.
 * - `rekeySecrets` — `migrate-key`: decrypts every secret with the old (password-derived) key, in
 *   either format, and re-encrypts it as v2 with the new master key. All or nothing.
 */

import type Database from 'better-sqlite3';
import { decrypt, encrypt, isV2 } from './crypto';
import type { AuditService } from '../audit/AuditService';
import logger from '../utils/logger';

export interface SecretMigrationResult {
  wallets: number;
  settingsFields: string[];
  failed: string[];
}

export const SECRET_SETTINGS_FIELDS = ['binance_api_key_encrypted', 'binance_api_secret_encrypted'] as const;

export function migrateSecretsToV2(db: Database.Database, keyHex: string, audit?: AuditService): SecretMigrationResult {
  const result: SecretMigrationResult = { wallets: 0, settingsFields: [], failed: [] };

  const reencrypt = (payload: string, label: string): string | null => {
    try {
      return encrypt(decrypt(payload, keyHex), keyHex);
    } catch (err) {
      result.failed.push(label);
      logger.error(`[Secrets] Could not migrate ${label}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  };

  db.transaction(() => {
    const wallets = db.prepare('SELECT id, private_key_encrypted FROM wallets').all() as Array<{ id: string; private_key_encrypted: string | null }>;
    const updateWallet = db.prepare('UPDATE wallets SET private_key_encrypted = ? WHERE id = ?');
    for (const w of wallets) {
      if (!w.private_key_encrypted || isV2(w.private_key_encrypted)) continue;
      const v2 = reencrypt(w.private_key_encrypted, `wallet:${w.id}`);
      if (v2) {
        updateWallet.run(v2, w.id);
        result.wallets++;
      }
    }

    const settings = db.prepare("SELECT * FROM settings WHERE id = 'global'").get() as Record<string, string | null> | undefined;
    if (settings) {
      for (const field of SECRET_SETTINGS_FIELDS) {
        const value = settings[field];
        if (!value || isV2(value)) continue;
        const v2 = reencrypt(value, `settings.${field}`);
        if (v2) {
          db.prepare(`UPDATE settings SET ${field} = ? WHERE id = 'global'`).run(v2);
          result.settingsFields.push(field);
        }
      }
    }
  })();

  if (result.wallets > 0 || result.settingsFields.length > 0 || result.failed.length > 0) {
    logger.info(`[Secrets] Migrated to AES-256-GCM: ${result.wallets} wallet key(s), settings: ${result.settingsFields.join(', ') || 'none'}${result.failed.length ? `; failed: ${result.failed.join(', ')}` : ''}`);
    audit?.record('system', 'secrets.migrate_v2', null, result, result.failed.length ? 'partial' : 'ok');
  }
  return result;
}

/** Every encrypted secret in the database, labelled (`wallet:<id>`, `settings.<field>`) */
export function listSecrets(db: Database.Database): Array<{ label: string; payload: string; write: (v: string) => void }> {
  const out: Array<{ label: string; payload: string; write: (v: string) => void }> = [];
  const wallets = db.prepare('SELECT id, private_key_encrypted FROM wallets').all() as Array<{ id: string; private_key_encrypted: string | null }>;
  const updateWallet = db.prepare('UPDATE wallets SET private_key_encrypted = ? WHERE id = ?');
  for (const w of wallets) {
    if (w.private_key_encrypted) out.push({ label: `wallet:${w.id}`, payload: w.private_key_encrypted, write: (v) => updateWallet.run(v, w.id) });
  }
  const settings = db.prepare("SELECT * FROM settings WHERE id = 'global'").get() as Record<string, string | null> | undefined;
  for (const field of SECRET_SETTINGS_FIELDS) {
    const value = settings?.[field];
    if (value) out.push({ label: `settings.${field}`, payload: value, write: (v) => db.prepare(`UPDATE settings SET ${field} = ? WHERE id = 'global'`).run(v) });
  }
  return out;
}

export interface RekeyResult {
  reencrypted: string[];
}

/**
 * Decrypt every secret with `oldKeyHex` and re-encrypt it with `newKeyHex` (v2). Throws, changing
 * nothing, if any secret cannot be decrypted with the old key.
 */
export function rekeySecrets(db: Database.Database, oldKeyHex: string, newKeyHex: string, audit?: AuditService): RekeyResult {
  const secrets = listSecrets(db);
  const failed: string[] = [];
  const plain = secrets.map((s) => {
    try {
      return decrypt(s.payload, oldKeyHex);
    } catch {
      failed.push(s.label);
      return null;
    }
  });
  if (failed.length > 0) throw new Error(`Cannot decrypt with the old key: ${failed.join(', ')} (wrong password?)`);
  db.transaction(() => {
    secrets.forEach((s, i) => s.write(encrypt(plain[i] as string, newKeyHex)));
  })();
  const result = { reencrypted: secrets.map((s) => s.label) };
  audit?.record('system', 'secrets.rekey', null, result, 'ok');
  return result;
}
