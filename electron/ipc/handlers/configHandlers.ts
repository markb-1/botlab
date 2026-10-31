import { ipcMain, type WebContents } from 'electron';
import type { ConfigService } from '../../../packages/core/src/config/ConfigService';
import { CONFIG_FILE_NAMES, type ConfigFileName } from '../../../packages/core/src/config/changes';

/**
 * Config IPC (spec §3). Human only: every call must come from the app's main window; the actor
 * is `human`. Secrets (the Telegram token) are masked in `config:get`; sending the mask back
 * unchanged in `config:write` keeps the stored value.
 */
export function registerConfigHandlers(config: ConfigService, isTrustedSender: (sender: WebContents) => boolean): void {
  const untrusted = { success: false, error: 'Not allowed from this window' };
  const asFile = (file: unknown): ConfigFileName => {
    if (typeof file !== 'string' || !CONFIG_FILE_NAMES.includes(file as ConfigFileName)) throw new Error(`Unknown config file: ${String(file)}`);
    return file as ConfigFileName;
  };
  const summary = (e: Awaited<ReturnType<ConfigService['write']>>) =>
    e ? { changes: e.changes, raises: e.raises.map((c) => `${c.file}.${c.path}`) } : { changes: [], raises: [] };

  ipcMain.handle('config:get', async (event) => {
    if (!isTrustedSender(event.sender)) return untrusted;
    try {
      return { success: true, data: { config: config.getRedacted(), error: config.getLastError(), hashes: config.getFileHashes() } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('config:write', async (event, file: string, value: unknown, expectedSha256?: string) => {
    if (!isTrustedSender(event.sender)) return untrusted;
    try {
      return { success: true, data: summary(await config.write(asFile(file), value, 'human', typeof expectedSha256 === 'string' ? expectedSha256 : undefined)) };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('config:history', async (event, file: string) => {
    if (!isTrustedSender(event.sender)) return untrusted;
    try {
      return { success: true, data: config.history(asFile(file)) };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('config:restore', async (event, file: string, versionId: string) => {
    if (!isTrustedSender(event.sender)) return untrusted;
    try {
      return { success: true, data: summary(await config.restore(asFile(file), String(versionId), 'human')) };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
