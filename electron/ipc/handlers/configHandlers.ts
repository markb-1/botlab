import { ipcMain } from 'electron';
import type { ConfigFileService } from '../../../packages/core/src/services/ConfigFileService';
import { respond, UNTRUSTED, type TrustedSenderCheck } from '../respond';

/**
 * Config IPC (spec §3). Human only: every call must come from the app's main window; the actor
 * is `human`. Secrets (the Telegram token) are masked in `config:get`; sending the mask back
 * unchanged in `config:write` keeps the stored value.
 */
export function registerConfigHandlers(config: ConfigFileService, isTrustedSender: TrustedSenderCheck): void {
  ipcMain.handle('config:get', async (event) => {
    if (!isTrustedSender(event.sender)) return UNTRUSTED;
    return respond(() => config.get());
  });

  ipcMain.handle('config:write', async (event, file: string, value: unknown, expectedSha256?: string) => {
    if (!isTrustedSender(event.sender)) return UNTRUSTED;
    return respond(() => config.write(file, value, 'human', expectedSha256));
  });

  ipcMain.handle('config:history', async (event, file: string) => {
    if (!isTrustedSender(event.sender)) return UNTRUSTED;
    return respond(() => config.history(file));
  });

  ipcMain.handle('config:restore', async (event, file: string, versionId: string) => {
    if (!isTrustedSender(event.sender)) return UNTRUSTED;
    return respond(() => config.restore(file, versionId, 'human'));
  });
}
