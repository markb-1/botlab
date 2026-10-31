import { ipcMain } from 'electron';
import type { SettingsRepository } from '../../../packages/core/src/db/repositories/SettingsRepository';
import type { SettingsService } from '../../../packages/core/src/services/SettingsService';
import { settingsRowToIpc } from '../../../packages/core/src/services/SettingsService';
import { BinanceCredentialsSchema, SettingsUpdateSchema, parseInput } from '../../../packages/core/src/services/schemas';
import { keyManager } from '../../../packages/core/src/security/keyManager';
import { encrypt, decrypt } from '../../../packages/core/src/security/crypto';
import { testClaudeConnection } from '../../ai/claude';
import { respond } from '../respond';

/**
 * Settings IPC. App settings and Binance credentials go through the core SettingsService; the Claude
 * (AI assistant) settings below stay here until the assistant is removed in 3b.
 */
export function registerSettingsHandlers(settings: SettingsService, settingsRepo: SettingsRepository): void {
  ipcMain.handle('settings:get', () => respond(() => settings.get()));

  ipcMain.handle('settings:update', (_event, data: unknown) =>
    respond(() => settings.update(parseInput(SettingsUpdateSchema, data)), 'Settings updated. Restart running bots for changes to take effect.')
  );

  // Save Binance credentials (encrypted)
  ipcMain.handle('settings:saveBinance', (_event, data: unknown) =>
    respond(() => settings.saveBinance(parseInput(BinanceCredentialsSchema, data)), 'Binance credentials saved.')
  );

  ipcMain.handle('settings:clearBinance', () => respond(() => settings.clearBinance(), 'Binance credentials removed.'));

  // Test Binance connection (given credentials before saving, else the saved ones)
  ipcMain.handle('settings:testBinance', (_event, data?: { apiKey?: string; apiSecret?: string }) =>
    respond(() => settings.testBinance(data), 'Binance API connected successfully.')
  );

  ipcMain.handle('settings:testRpc', async () => {
    const result = await respond(() => settings.testRpc());
    return result.success && result.data ? { ...result, message: `RPC connected successfully. Current block: ${result.data.blockNumber}` } : result;
  });

  ipcMain.handle('settings:testClob', () => respond(() => settings.testClob(), 'CLOB API connected successfully.'));

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
