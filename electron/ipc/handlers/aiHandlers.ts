import { ipcMain } from 'electron';
import CryptoJS from 'crypto-js';
import type { SettingsRepository } from '../../database/repositories/SettingsRepository';
import { keyManager } from '../../security/keyManager';
import { callClaude, extractCodeFromResponse } from '../../sdk/claude';
import { buildSystemPrompt } from '../../sdk/claudeSystemPrompt';

/**
 * Get the decrypted Claude API key from settings.
 */
function getClaudeApiKey(settingsRepo: SettingsRepository): string {
  const settings = settingsRepo.get();
  if (!settings.claude_api_key_encrypted) {
    throw new Error('No Claude API key configured. Add one in Settings.');
  }
  const encKey = keyManager.getKey();
  const apiKey = CryptoJS.AES.decrypt(settings.claude_api_key_encrypted, encKey).toString(CryptoJS.enc.Utf8);
  if (!apiKey) {
    throw new Error('Failed to decrypt Claude API key. Try re-saving it in Settings.');
  }
  return apiKey;
}

export function registerAiHandlers(
  settingsRepo: SettingsRepository
): void {
  // Generate a new script from a description
  ipcMain.handle('ai:generate', async (_event, data: { prompt: string }) => {
    try {
      const apiKey = getClaudeApiKey(settingsRepo);
      const settings = settingsRepo.get();
      const systemPrompt = buildSystemPrompt(settings.ai_custom_system_prompt);

      const response = await callClaude({
        apiKey,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `Create a bot script that does the following:\n\n${data.prompt}`,
          },
        ],
      });

      const code = extractCodeFromResponse(response);
      return { success: true, data: { code } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Edit an existing script with instructions
  ipcMain.handle('ai:edit', async (_event, data: { prompt: string; currentSource: string }) => {
    try {
      const apiKey = getClaudeApiKey(settingsRepo);
      const settings = settingsRepo.get();
      const systemPrompt = buildSystemPrompt(settings.ai_custom_system_prompt);

      const response = await callClaude({
        apiKey,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `Here is the current script:\n\n\`\`\`typescript\n${data.currentSource}\n\`\`\`\n\nPlease make the following changes:\n\n${data.prompt}`,
          },
        ],
      });

      const code = extractCodeFromResponse(response);
      return { success: true, data: { code } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
