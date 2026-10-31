/**
 * One-time migration of secrets at rest from CryptoJS (passphrase mode, MD5 KDF) to AES-256-GCM v2
 * (spec §8.3). Runs after unlock, once the key is available. Idempotent: rows already in v2 are skipped.
 *
 * Covers wallet private keys (incl. paper wallets), Binance API key/secret and the Claude API key
 * (until the AI assistant is removed). A row that cannot be decrypted is left untouched (still readable
 * through the legacy path if the key is right) and reported; the rest are migrated in one transaction.
 */

import type Database from 'better-sqlite3';
import { decrypt, encrypt, isV2 } from './crypto';
import type { AuditService } from '../audit/AuditService';
import logger from '../../src/utils/logger';

export interface SecretMigrationResult {
  wallets: number;
  settingsFields: string[];
  failed: string[];
}

const SETTINGS_FIELDS = ['binance_api_key_encrypted', 'binance_api_secret_encrypted', 'claude_api_key_encrypted'] as const;

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
      for (const field of SETTINGS_FIELDS) {
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
