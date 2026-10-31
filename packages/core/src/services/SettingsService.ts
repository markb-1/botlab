/**
 * SettingsService — app settings and Binance credentials (moved out of the Electron
 * `settingsHandlers`). Binance credentials are encrypted with the unlocked key and never returned:
 * views only carry `hasBinanceCredentials`. Claude (AI assistant) settings stay in the Electron
 * layer until the assistant is removed (3b); the view still reports them.
 */

import type { SettingsRepository } from '../db/repositories/SettingsRepository';
import type { IpcSettings } from './types';
import { keyManager } from '../security/keyManager';
import { encrypt, decrypt } from '../security/crypto';
import { testConnection } from '../exchange/binance/client';
import { ServiceError } from './errors';
import type { BinanceCredentials, SettingsUpdateInput } from './schemas';

export function settingsRowToIpc(row: any): IpcSettings {
  return {
    rpcUrl: row.rpc_url,
    clobHttpUrl: row.clob_http_url,
    clobWsUrl: row.clob_ws_url,
    usdcContractAddress: row.usdc_contract_address,
    alchemyApiKey: row.alchemy_api_key,
    hasBinanceCredentials: !!(row.binance_api_key_encrypted && row.binance_api_secret_encrypted),
    hasClaudeApiKey: !!row.claude_api_key_encrypted,
    aiCustomSystemPrompt: row.ai_custom_system_prompt || null,
  };
}

export class SettingsService {
  constructor(private deps: { settingsRepo: SettingsRepository }) {}

  get(): IpcSettings {
    return settingsRowToIpc(this.deps.settingsRepo.get());
  }

  /** Running bots pick up changes on restart */
  update(data: SettingsUpdateInput): IpcSettings {
    const updated = this.deps.settingsRepo.update({
      rpcUrl: data.rpcUrl,
      clobHttpUrl: data.clobHttpUrl,
      clobWsUrl: data.clobWsUrl,
      usdcContractAddress: data.usdcContractAddress,
      alchemyApiKey: data.alchemyApiKey,
    });
    return settingsRowToIpc(updated);
  }

  /** Save Binance credentials (encrypted with the unlocked key) */
  saveBinance(data: BinanceCredentials): IpcSettings {
    const encKey = keyManager.getKey();
    const encryptedKey = encrypt(data.apiKey, encKey);
    const encryptedSecret = encrypt(data.apiSecret, encKey);

    const updated = this.deps.settingsRepo.updateBinanceCredentials({
      binanceApiKeyEncrypted: encryptedKey,
      binanceApiSecretEncrypted: encryptedSecret,
    });
    return settingsRowToIpc(updated);
  }

  clearBinance(): IpcSettings {
    const updated = this.deps.settingsRepo.updateBinanceCredentials({
      binanceApiKeyEncrypted: null,
      binanceApiSecretEncrypted: null,
    });
    return settingsRowToIpc(updated);
  }

  /**
   * Test Binance credentials: the given ones (before saving) or the saved ones.
   * Throws `Binance connection failed: …` on any failure.
   */
  async testBinance(data?: Partial<BinanceCredentials>): Promise<void> {
    const settings = data?.apiKey && data?.apiSecret ? null : this.deps.settingsRepo.get();
    if (settings && (!settings.binance_api_key_encrypted || !settings.binance_api_secret_encrypted)) {
      throw new ServiceError('unavailable', 'No Binance credentials configured.');
    }
    try {
      let apiKey: string;
      let apiSecret: string;

      if (!settings) {
        // Use provided credentials (for testing before save)
        apiKey = data!.apiKey!;
        apiSecret = data!.apiSecret!;
      } else {
        // Use saved credentials
        const encKey = keyManager.getKey();
        apiKey = decrypt(settings.binance_api_key_encrypted!, encKey);
        apiSecret = decrypt(settings.binance_api_secret_encrypted!, encKey);
      }

      await testConnection({ apiKey, apiSecret });
    } catch (error) {
      throw new ServiceError('unavailable', `Binance connection failed: ${(error as Error).message}`);
    }
  }

  /** Current block number from the configured Polygon RPC */
  async testRpc(): Promise<{ blockNumber: number }> {
    try {
      const settings = this.deps.settingsRepo.get();
      const { ethers } = await import('ethers');
      const provider = new ethers.providers.JsonRpcProvider(settings.rpc_url);
      const blockNumber = await provider.getBlockNumber();
      return { blockNumber };
    } catch (error) {
      throw new ServiceError('unavailable', `RPC connection failed: ${(error as Error).message}`);
    }
  }

  async testClob(): Promise<void> {
    try {
      const settings = this.deps.settingsRepo.get();
      const response = await fetch(`${settings.clob_http_url}/time`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      throw new ServiceError('unavailable', `CLOB connection failed: ${(error as Error).message}`);
    }
  }
}
