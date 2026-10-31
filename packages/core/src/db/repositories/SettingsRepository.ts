import type Database from 'better-sqlite3';

export interface SettingsRow {
  id: string;
  rpc_url: string;
  clob_http_url: string;
  clob_ws_url: string;
  usdc_contract_address: string;
  alchemy_api_key: string | null;
  /** Legacy (Electron) password-derived key: verification hash, salt and "skipped" flag; kept only until `migrate-key` */
  password_hash: string | null;
  password_salt: string | null;
  password_skipped: number;
  binance_api_key_encrypted: string | null;
  binance_api_secret_encrypted: string | null;
  /** Admin UI password (scrypt, `security/adminAuth.ts`); null until first-run setup */
  admin_password_hash: string | null;
  /** Master-key check value: a constant encrypted with the master key (`security/masterKey.ts`) */
  key_check: string | null;
  created_at: string;
  updated_at: string;
}

export class SettingsRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Get global settings. Creates default row if it doesn't exist.
   */
  get(): SettingsRow {
    let settings = this.db.prepare("SELECT * FROM settings WHERE id = 'global'").get() as
      | SettingsRow
      | undefined;

    if (!settings) {
      this.db.prepare("INSERT OR IGNORE INTO settings (id) VALUES ('global')").run();
      settings = this.db.prepare("SELECT * FROM settings WHERE id = 'global'").get() as SettingsRow;
    }

    return settings;
  }

  /**
   * Update global settings.
   */
  update(data: Partial<{
    rpcUrl: string;
    clobHttpUrl: string;
    clobWsUrl: string;
    usdcContractAddress: string;
    alchemyApiKey: string | null;
  }>): SettingsRow {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (data.rpcUrl !== undefined) { sets.push('rpc_url = ?'); values.push(data.rpcUrl); }
    if (data.clobHttpUrl !== undefined) { sets.push('clob_http_url = ?'); values.push(data.clobHttpUrl); }
    if (data.clobWsUrl !== undefined) { sets.push('clob_ws_url = ?'); values.push(data.clobWsUrl); }
    if (data.usdcContractAddress !== undefined) { sets.push('usdc_contract_address = ?'); values.push(data.usdcContractAddress); }
    if (data.alchemyApiKey !== undefined) { sets.push('alchemy_api_key = ?'); values.push(data.alchemyApiKey); }

    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')");
      values.push('global');
      this.db.prepare(`UPDATE settings SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }

    return this.get();
  }

  /** Forget the legacy password-derived key fields (after `migrate-key` re-encrypted the secrets). */
  clearLegacyAuth(): void {
    this.get(); // Ensure the row exists
    this.db.prepare(`UPDATE settings SET password_hash = NULL, password_salt = NULL, password_skipped = 0, updated_at = datetime('now') WHERE id = 'global'`).run();
  }

  setAdminPasswordHash(hash: string | null): void {
    this.get(); // Ensure the row exists
    this.db.prepare(`UPDATE settings SET admin_password_hash = ?, updated_at = datetime('now') WHERE id = 'global'`).run(hash);
  }

  setKeyCheck(value: string | null): void {
    this.get(); // Ensure the row exists
    this.db.prepare(`UPDATE settings SET key_check = ?, updated_at = datetime('now') WHERE id = 'global'`).run(value);
  }

  /**
   * Update encrypted Binance API credentials.
   */
  updateBinanceCredentials(data: {
    binanceApiKeyEncrypted: string | null;
    binanceApiSecretEncrypted: string | null;
  }): SettingsRow {
    this.get(); // Ensure the row exists
    this.db.prepare(
      `UPDATE settings SET binance_api_key_encrypted = ?, binance_api_secret_encrypted = ?, updated_at = datetime('now') WHERE id = 'global'`
    ).run(data.binanceApiKeyEncrypted, data.binanceApiSecretEncrypted);
    return this.get();
  }
}
