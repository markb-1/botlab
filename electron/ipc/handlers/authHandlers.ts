import { ipcMain } from 'electron';
import type { SettingsRepository } from '../../../packages/core/src/db/repositories/SettingsRepository';
import { keyManager } from '../../../packages/core/src/security/keyManager';
import {
  generateSalt,
  deriveEncryptionKey,
  hashForVerification,
  verifyPassword,
  FALLBACK_PASSWORD,
} from '../../../packages/core/src/security/passwordManager';

/**
 * Callback invoked after successful authentication.
 * main.ts uses this to initialize protected services (WalletManager, BotManager, etc.)
 */
type OnAuthSuccessCallback = (encryptionKey: string) => Promise<void>;

/**
 * Register authentication IPC handlers.
 * These must be registered BEFORE the window is created so React can call them immediately.
 */
export function registerAuthHandlers(
  settingsRepo: SettingsRepository,
  onAuthSuccess: OnAuthSuccessCallback
): void {
  /**
   * auth:status — Check current authentication state.
   * Returns whether setup is needed, whether a password is set, and if already unlocked.
   */
  ipcMain.handle('auth:status', () => {
    try {
      const settings = settingsRepo.get();
      const needsSetup = !settings.password_hash && !settings.password_skipped;
      const hasPassword = !!settings.password_hash;
      const unlocked = keyManager.isReady();

      return {
        success: true,
        data: { needsSetup, hasPassword, unlocked },
      };
    } catch (error: any) {
      console.error('[Auth] Status check failed:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * auth:setup — First-time setup. Set a password or skip.
   * If password is provided, stores hash + salt and derives encryption key.
   * If skipped, uses FALLBACK_PASSWORD.
   */
  ipcMain.handle('auth:setup', async (_event, data: { password?: string; skip?: boolean }) => {
    try {
      const salt = generateSalt();
      const password = data.skip ? FALLBACK_PASSWORD : data.password;

      if (!password) {
        return { success: false, error: 'Password is required unless skipping' };
      }

      // Derive the encryption key
      const encryptionKey = deriveEncryptionKey(password, salt);

      if (data.skip) {
        // Mark as skipped — no password hash stored, just salt for key derivation
        settingsRepo.updateAuth({
          passwordHash: null,
          passwordSalt: salt,
          passwordSkipped: true,
        });
      } else {
        // Store verification hash + salt
        const hash = hashForVerification(password, salt);
        settingsRepo.updateAuth({
          passwordHash: hash,
          passwordSalt: salt,
          passwordSkipped: false,
        });
      }

      // Set the key and initialize protected services
      keyManager.setKey(encryptionKey);
      await onAuthSuccess(encryptionKey);

      console.log(`[Auth] Setup complete (${data.skip ? 'skipped' : 'password set'})`);
      return { success: true, data: { unlocked: true } };
    } catch (error: any) {
      console.error('[Auth] Setup failed:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * auth:unlock — Unlock with existing password.
   * Verifies password against stored hash, derives key, initializes services.
   */
  ipcMain.handle('auth:unlock', async (_event, data: { password: string }) => {
    try {
      const settings = settingsRepo.get();

      if (!settings.password_salt) {
        return { success: false, error: 'No authentication configured. Please run setup.' };
      }

      // If password was skipped, auto-unlock with fallback
      if (settings.password_skipped) {
        const encryptionKey = deriveEncryptionKey(FALLBACK_PASSWORD, settings.password_salt);
        keyManager.setKey(encryptionKey);
        await onAuthSuccess(encryptionKey);
        console.log('[Auth] Auto-unlocked (no password)');
        return { success: true, data: { unlocked: true } };
      }

      // Verify the password
      if (!settings.password_hash) {
        return { success: false, error: 'Password hash missing. Please reset setup.' };
      }

      const valid = verifyPassword(data.password, settings.password_hash, settings.password_salt);
      if (!valid) {
        return { success: false, error: 'Incorrect password' };
      }

      // Derive the encryption key and initialize
      const encryptionKey = deriveEncryptionKey(data.password, settings.password_salt);
      keyManager.setKey(encryptionKey);
      await onAuthSuccess(encryptionKey);

      console.log('[Auth] Unlocked successfully');
      return { success: true, data: { unlocked: true } };
    } catch (error: any) {
      console.error('[Auth] Unlock failed:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * auth:autoUnlock — Try auto-unlock for skipped-password setups.
   * Called by the renderer on startup to check if we can skip the unlock screen.
   */
  ipcMain.handle('auth:autoUnlock', async () => {
    try {
      if (keyManager.isReady()) {
        return { success: true, data: { unlocked: true } };
      }

      const settings = settingsRepo.get();

      // Only auto-unlock if password was explicitly skipped
      if (settings.password_skipped && settings.password_salt) {
        const encryptionKey = deriveEncryptionKey(FALLBACK_PASSWORD, settings.password_salt);
        keyManager.setKey(encryptionKey);
        await onAuthSuccess(encryptionKey);
        console.log('[Auth] Auto-unlocked (skipped password)');
        return { success: true, data: { unlocked: true } };
      }

      return { success: true, data: { unlocked: false } };
    } catch (error: any) {
      console.error('[Auth] Auto-unlock failed:', error);
      return { success: false, error: error.message };
    }
  });
}
