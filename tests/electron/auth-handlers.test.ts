import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so mock variables are available inside vi.mock factories
const { handlers, mockKeyManager, mockGenerateSalt, mockDeriveEncryptionKey, mockHashForVerification, mockVerifyPassword } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  mockKeyManager: {
    isReady: vi.fn().mockReturnValue(false),
    setKey: vi.fn(),
  },
  mockGenerateSalt: vi.fn().mockReturnValue('aabbccdd'.repeat(8)),
  mockDeriveEncryptionKey: vi.fn().mockReturnValue('derived-key-hex'),
  mockHashForVerification: vi.fn().mockReturnValue('verification-hash'),
  mockVerifyPassword: vi.fn().mockReturnValue(true),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../packages/core/src/security/keyManager', () => ({
  keyManager: mockKeyManager,
}));

vi.mock('../../packages/core/src/security/passwordManager', () => ({
  generateSalt: (...args: unknown[]) => mockGenerateSalt(...args),
  deriveEncryptionKey: (...args: unknown[]) => mockDeriveEncryptionKey(...args),
  hashForVerification: (...args: unknown[]) => mockHashForVerification(...args),
  verifyPassword: (...args: unknown[]) => mockVerifyPassword(...args),
  FALLBACK_PASSWORD: 'botlab-default-no-password',
}));

import { registerAuthHandlers } from '../../electron/ipc/handlers/authHandlers';

function makeSettingsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'global',
    rpc_url: '',
    clob_http_url: '',
    clob_ws_url: '',
    usdc_contract_address: '',
    alchemy_api_key: null,
    password_hash: null,
    password_salt: null,
    password_skipped: 0,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('authHandlers', () => {
  let mockSettingsRepo: Record<string, ReturnType<typeof vi.fn>>;
  let mockOnAuthSuccess: ReturnType<typeof vi.fn>;

  async function invoke(channel: string, ...args: unknown[]) {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({}, ...args);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();

    mockSettingsRepo = {
      get: vi.fn().mockReturnValue(makeSettingsRow()),
      updateAuth: vi.fn(),
    };
    mockOnAuthSuccess = vi.fn().mockResolvedValue(undefined);
    mockKeyManager.isReady.mockReturnValue(false);

    registerAuthHandlers(mockSettingsRepo as any, mockOnAuthSuccess);
  });

  describe('auth:status', () => {
    it('should return needsSetup when no password and not skipped', async () => {
      mockSettingsRepo.get.mockReturnValue(makeSettingsRow());
      const result = await invoke('auth:status');
      expect(result.success).toBe(true);
      expect(result.data.needsSetup).toBe(true);
      expect(result.data.hasPassword).toBe(false);
      expect(result.data.unlocked).toBe(false);
    });

    it('should return hasPassword when password_hash is set', async () => {
      mockSettingsRepo.get.mockReturnValue(
        makeSettingsRow({ password_hash: 'somehash', password_salt: 'somesalt' })
      );
      const result = await invoke('auth:status');
      expect(result.data.needsSetup).toBe(false);
      expect(result.data.hasPassword).toBe(true);
    });

    it('should return needsSetup=false when password was skipped', async () => {
      mockSettingsRepo.get.mockReturnValue(
        makeSettingsRow({ password_skipped: 1 })
      );
      const result = await invoke('auth:status');
      expect(result.data.needsSetup).toBe(false);
      expect(result.data.hasPassword).toBe(false);
    });

    it('should return unlocked=true when keyManager is ready', async () => {
      mockKeyManager.isReady.mockReturnValue(true);
      const result = await invoke('auth:status');
      expect(result.data.unlocked).toBe(true);
    });

    it('should return error on exception', async () => {
      mockSettingsRepo.get.mockImplementation(() => { throw new Error('DB error'); });
      const result = await invoke('auth:status');
      expect(result.success).toBe(false);
      expect(result.error).toBe('DB error');
    });
  });

  describe('auth:setup', () => {
    it('should set password with hash and salt', async () => {
      const result = await invoke('auth:setup', { password: 'my-password' });

      expect(result.success).toBe(true);
      expect(result.data.unlocked).toBe(true);

      // Should derive encryption key
      expect(mockDeriveEncryptionKey).toHaveBeenCalledWith('my-password', expect.any(String));
      // Should create verification hash
      expect(mockHashForVerification).toHaveBeenCalledWith('my-password', expect.any(String));

      // Should store hash, salt, and skipped=false
      expect(mockSettingsRepo.updateAuth).toHaveBeenCalledWith({
        passwordHash: 'verification-hash',
        passwordSalt: expect.any(String),
        passwordSkipped: false,
      });

      // Should set key and call onAuthSuccess
      expect(mockKeyManager.setKey).toHaveBeenCalledWith('derived-key-hex');
      expect(mockOnAuthSuccess).toHaveBeenCalledWith('derived-key-hex');
    });

    it('should skip password with fallback', async () => {
      const result = await invoke('auth:setup', { skip: true });

      expect(result.success).toBe(true);

      // Should derive key from fallback password
      expect(mockDeriveEncryptionKey).toHaveBeenCalledWith(
        'botlab-default-no-password',
        expect.any(String)
      );

      // Should NOT create verification hash (skipped)
      expect(mockHashForVerification).not.toHaveBeenCalled();

      // Should store null hash, salt, and skipped=true
      expect(mockSettingsRepo.updateAuth).toHaveBeenCalledWith({
        passwordHash: null,
        passwordSalt: expect.any(String),
        passwordSkipped: true,
      });

      expect(mockKeyManager.setKey).toHaveBeenCalledWith('derived-key-hex');
      expect(mockOnAuthSuccess).toHaveBeenCalledWith('derived-key-hex');
    });

    it('should return error when no password and not skipping', async () => {
      const result = await invoke('auth:setup', {});
      expect(result.success).toBe(false);
      expect(result.error).toBe('Password is required unless skipping');
    });

    it('should return error when password is empty string and not skipping', async () => {
      const result = await invoke('auth:setup', { password: '' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Password is required unless skipping');
    });

    it('should return error when onAuthSuccess throws', async () => {
      mockOnAuthSuccess.mockRejectedValue(new Error('Init failed'));
      const result = await invoke('auth:setup', { password: 'test' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Init failed');
    });
  });

  describe('auth:unlock', () => {
    it('should unlock with correct password', async () => {
      mockSettingsRepo.get.mockReturnValue(
        makeSettingsRow({ password_hash: 'stored-hash', password_salt: 'stored-salt' })
      );
      mockVerifyPassword.mockReturnValue(true);

      const result = await invoke('auth:unlock', { password: 'correct' });

      expect(result.success).toBe(true);
      expect(result.data.unlocked).toBe(true);

      expect(mockVerifyPassword).toHaveBeenCalledWith('correct', 'stored-hash', 'stored-salt');
      expect(mockDeriveEncryptionKey).toHaveBeenCalledWith('correct', 'stored-salt');
      expect(mockKeyManager.setKey).toHaveBeenCalledWith('derived-key-hex');
      expect(mockOnAuthSuccess).toHaveBeenCalledWith('derived-key-hex');
    });

    it('should reject incorrect password', async () => {
      mockSettingsRepo.get.mockReturnValue(
        makeSettingsRow({ password_hash: 'stored-hash', password_salt: 'stored-salt' })
      );
      mockVerifyPassword.mockReturnValue(false);

      const result = await invoke('auth:unlock', { password: 'wrong' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Incorrect password');
      expect(mockKeyManager.setKey).not.toHaveBeenCalled();
      expect(mockOnAuthSuccess).not.toHaveBeenCalled();
    });

    it('should auto-unlock when password was skipped', async () => {
      mockSettingsRepo.get.mockReturnValue(
        makeSettingsRow({ password_skipped: 1, password_salt: 'stored-salt' })
      );

      const result = await invoke('auth:unlock', { password: 'anything' });

      expect(result.success).toBe(true);
      expect(result.data.unlocked).toBe(true);

      // Should use fallback password, not the provided one
      expect(mockDeriveEncryptionKey).toHaveBeenCalledWith(
        'botlab-default-no-password',
        'stored-salt'
      );
      expect(mockVerifyPassword).not.toHaveBeenCalled();
    });

    it('should return error when no salt configured', async () => {
      mockSettingsRepo.get.mockReturnValue(makeSettingsRow());
      const result = await invoke('auth:unlock', { password: 'test' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('No authentication configured. Please run setup.');
    });

    it('should return error when hash is missing but not skipped', async () => {
      mockSettingsRepo.get.mockReturnValue(
        makeSettingsRow({ password_salt: 'some-salt', password_skipped: 0 })
      );
      const result = await invoke('auth:unlock', { password: 'test' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Password hash missing. Please reset setup.');
    });

    it('should return error when onAuthSuccess throws', async () => {
      mockSettingsRepo.get.mockReturnValue(
        makeSettingsRow({ password_hash: 'hash', password_salt: 'salt' })
      );
      mockVerifyPassword.mockReturnValue(true);
      mockOnAuthSuccess.mockRejectedValue(new Error('Service init failed'));

      const result = await invoke('auth:unlock', { password: 'test' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Service init failed');
    });
  });

  describe('auth:autoUnlock', () => {
    it('should return unlocked=true when keyManager already ready', async () => {
      mockKeyManager.isReady.mockReturnValue(true);
      const result = await invoke('auth:autoUnlock');
      expect(result.success).toBe(true);
      expect(result.data.unlocked).toBe(true);
      // Should not derive key again
      expect(mockDeriveEncryptionKey).not.toHaveBeenCalled();
    });

    it('should auto-unlock when password was skipped', async () => {
      mockSettingsRepo.get.mockReturnValue(
        makeSettingsRow({ password_skipped: 1, password_salt: 'stored-salt' })
      );

      const result = await invoke('auth:autoUnlock');

      expect(result.success).toBe(true);
      expect(result.data.unlocked).toBe(true);
      expect(mockDeriveEncryptionKey).toHaveBeenCalledWith(
        'botlab-default-no-password',
        'stored-salt'
      );
      expect(mockKeyManager.setKey).toHaveBeenCalled();
      expect(mockOnAuthSuccess).toHaveBeenCalled();
    });

    it('should return unlocked=false when password is required', async () => {
      mockSettingsRepo.get.mockReturnValue(
        makeSettingsRow({ password_hash: 'hash', password_salt: 'salt' })
      );

      const result = await invoke('auth:autoUnlock');
      expect(result.success).toBe(true);
      expect(result.data.unlocked).toBe(false);
      expect(mockKeyManager.setKey).not.toHaveBeenCalled();
    });

    it('should return unlocked=false when no setup done', async () => {
      mockSettingsRepo.get.mockReturnValue(makeSettingsRow());

      const result = await invoke('auth:autoUnlock');
      expect(result.success).toBe(true);
      expect(result.data.unlocked).toBe(false);
    });

    it('should return error on exception', async () => {
      mockSettingsRepo.get.mockImplementation(() => { throw new Error('DB crash'); });
      const result = await invoke('auth:autoUnlock');
      expect(result.success).toBe(false);
      expect(result.error).toBe('DB crash');
    });
  });
});
