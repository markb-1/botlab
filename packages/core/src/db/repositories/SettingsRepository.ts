import type Database from 'better-sqlite3';

export interface SettingsRow {
  id: string;
  rpc_url: string;
  clob_http_url: string;
  clob_ws_url: string;
  usdc_contract_address: string;
  alchemy_api_key: string | null;
  password_hash: string | null;
  password_salt: string | null;
  password_skipped: number;
  binance_api_key_encrypted: string | null;
  binance_api_secret_encrypted: string | null;
  claude_api_key_encrypted: string | null;
  ai_custom_system_prompt: string | null;
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

  /**
   * Update authentication fields (password hash, salt, skipped flag).
   */
  updateAuth(data: {
    passwordHash: string | null;
    passwordSalt: string;
    passwordSkipped: boolean;
  }): SettingsRow {
    this.get(); // Ensure the row exists
    this.db.prepare(
      `UPDATE settings SET password_hash = ?, password_salt = ?, password_skipped = ?, updated_at = datetime('now') WHERE id = 'global'`
    ).run(data.passwordHash, data.passwordSalt, data.passwordSkipped ? 1 : 0);
    return this.get();
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

  /**
   * Update encrypted Claude API key.
   */
  updateClaudeCredentials(data: {
    claudeApiKeyEncrypted: string | null;
  }): SettingsRow {
    this.get(); // Ensure the row exists
    this.db.prepare(
      `UPDATE settings SET claude_api_key_encrypted = ?, updated_at = datetime('now') WHERE id = 'global'`
    ).run(data.claudeApiKeyEncrypted);
    return this.get();
  }

  /**
   * Update AI custom system prompt.
   */
  updateAiSystemPrompt(data: {
    prompt: string | null;
  }): SettingsRow {
    this.get(); // Ensure the row exists
    this.db.prepare(
      `UPDATE settings SET ai_custom_system_prompt = ?, updated_at = datetime('now') WHERE id = 'global'`
    ).run(data.prompt);
    return this.get();
  }
}
