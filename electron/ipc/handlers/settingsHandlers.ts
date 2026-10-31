import { ipcMain } from 'electron';
import type { SettingsRepository } from '../../../packages/core/src/db/repositories/SettingsRepository';
import type { IpcSettings } from '../../../packages/core/src/services/types';
import { keyManager } from '../../../packages/core/src/security/keyManager';
import { encrypt, decrypt } from '../../../packages/core/src/security/crypto';
import { testConnection } from '../../../packages/core/src/exchange/binance/client';
import { testClaudeConnection } from '../../ai/claude';

function settingsRowToIpc(row: any): IpcSettings {
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

export function registerSettingsHandlers(
  settingsRepo: SettingsRepository
): void {
  // Get settings
  ipcMain.handle('settings:get', async () => {
    try {
      const settings = settingsRepo.get();
      return {
        success: true,
        data: settingsRowToIpc(settings),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Update settings
  ipcMain.handle('settings:update', async (_event, data: Partial<IpcSettings>) => {
    try {
      const updated = settingsRepo.update({
        rpcUrl: data.rpcUrl,
        clobHttpUrl: data.clobHttpUrl,
        clobWsUrl: data.clobWsUrl,
        usdcContractAddress: data.usdcContractAddress,
        alchemyApiKey: data.alchemyApiKey,
      });
      return {
        success: true,
        data: settingsRowToIpc(updated),
        message: 'Settings updated. Restart running bots for changes to take effect.',
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Save Binance credentials (encrypted)
  ipcMain.handle('settings:saveBinance', async (_event, data: { apiKey: string; apiSecret: string }) => {
    try {
      const encKey = keyManager.getKey();
      const encryptedKey = encrypt(data.apiKey, encKey);
      const encryptedSecret = encrypt(data.apiSecret, encKey);

      const updated = settingsRepo.updateBinanceCredentials({
        binanceApiKeyEncrypted: encryptedKey,
        binanceApiSecretEncrypted: encryptedSecret,
      });
      return {
        success: true,
        data: settingsRowToIpc(updated),
        message: 'Binance credentials saved.',
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Clear Binance credentials
  ipcMain.handle('settings:clearBinance', async () => {
    try {
      const updated = settingsRepo.updateBinanceCredentials({
        binanceApiKeyEncrypted: null,
        binanceApiSecretEncrypted: null,
      });
      return {
        success: true,
        data: settingsRowToIpc(updated),
        message: 'Binance credentials removed.',
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Test Binance connection
  ipcMain.handle('settings:testBinance', async (_event, data?: { apiKey: string; apiSecret: string }) => {
    try {
      let apiKey: string;
      let apiSecret: string;

      if (data?.apiKey && data?.apiSecret) {
        // Use provided credentials (for testing before save)
        apiKey = data.apiKey;
        apiSecret = data.apiSecret;
      } else {
        // Use saved credentials
        const settings = settingsRepo.get();
        if (!settings.binance_api_key_encrypted || !settings.binance_api_secret_encrypted) {
          return { success: false, error: 'No Binance credentials configured.' };
        }
        const encKey = keyManager.getKey();
        apiKey = decrypt(settings.binance_api_key_encrypted, encKey);
        apiSecret = decrypt(settings.binance_api_secret_encrypted, encKey);
      }

      await testConnection({ apiKey, apiSecret });
      return {
        success: true,
        message: 'Binance API connected successfully.',
      };
    } catch (error) {
      return { success: false, error: `Binance connection failed: ${(error as Error).message}` };
    }
  });

  // Test RPC connection
  ipcMain.handle('settings:testRpc', async () => {
    try {
      const settings = settingsRepo.get();
      const { ethers } = await import('ethers');
      const provider = new ethers.providers.JsonRpcProvider(settings.rpc_url);
      const blockNumber = await provider.getBlockNumber();
      return {
        success: true,
        data: { blockNumber },
        message: `RPC connected successfully. Current block: ${blockNumber}`,
      };
    } catch (error) {
      return { success: false, error: `RPC connection failed: ${(error as Error).message}` };
    }
  });

  // Test CLOB connection
  ipcMain.handle('settings:testClob', async () => {
    try {
      const settings = settingsRepo.get();
      const response = await fetch(`${settings.clob_http_url}/time`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {
        success: true,
        message: 'CLOB API connected successfully.',
      };
    } catch (error) {
      return { success: false, error: `CLOB connection failed: ${(error as Error).message}` };
    }
  });

  // Save Claude API key (encrypted)
  ipcMain.handle('settings:saveClaude', async (_event, data: { apiKey: string }) => {
    try {
      const encKey = keyManager.getKey();
      const encrypted = encrypt(data.apiKey, encKey);

      const updated = settingsRepo.updateClaudeCredentials({
        claudeApiKeyEncrypted: encrypted,
      });
      return {
        success: true,
        data: settingsRowToIpc(updated),
        message: 'Claude API key saved.',
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Clear Claude API key
  ipcMain.handle('settings:clearClaude', async () => {
    try {
      const updated = settingsRepo.updateClaudeCredentials({
        claudeApiKeyEncrypted: null,
      });
      return {
        success: true,
        data: settingsRowToIpc(updated),
        message: 'Claude API key removed.',
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Test Claude connection
  ipcMain.handle('settings:testClaude', async (_event, data?: { apiKey: string }) => {
    try {
      let apiKey: string;

      if (data?.apiKey) {
        apiKey = data.apiKey;
      } else {
        const settings = settingsRepo.get();
        if (!settings.claude_api_key_encrypted) {
          return { success: false, error: 'No Claude API key configured.' };
        }
        const encKey = keyManager.getKey();
        apiKey = decrypt(settings.claude_api_key_encrypted, encKey);
      }

      await testClaudeConnection(apiKey);
      return {
        success: true,
        message: 'Claude API connected successfully.',
      };
    } catch (error) {
      return { success: false, error: `Claude connection failed: ${(error as Error).message}` };
    }
  });

  // Get AI custom system prompt
  ipcMain.handle('settings:getAiSystemPrompt', async () => {
    try {
      const settings = settingsRepo.get();
      return {
        success: true,
        data: { prompt: settings.ai_custom_system_prompt || '' },
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Save AI custom system prompt
  ipcMain.handle('settings:saveAiSystemPrompt', async (_event, data: { prompt: string }) => {
    try {
      settingsRepo.updateAiSystemPrompt({
        prompt: data.prompt || null,
      });
      return {
        success: true,
        message: 'AI system prompt saved.',
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
