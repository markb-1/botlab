import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WalletManager } from '../../src/core/WalletManager';
import type { WalletRepository, WalletRow } from '../../electron/database/repositories/WalletRepository';

// Mock logger to prevent file I/O
vi.mock('../../src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

// Mock ethers for createPaperWallet
vi.mock('ethers', () => ({
  ethers: {
    Wallet: {
      createRandom: vi.fn().mockReturnValue({
        privateKey: '0x' + 'ab'.repeat(32),
        address: '0x' + 'cd'.repeat(20),
      }),
    },
  },
}));

const VALID_KEY = 'a'.repeat(64);
const SAMPLE_HEX_KEY = 'ab'.repeat(32); // 64 hex chars

function makeMockRepo() {
  return {
    findById: vi.fn(),
    findByAddress: vi.fn(),
    findAll: vi.fn().mockReturnValue([]),
    findAvailable: vi.fn().mockReturnValue([]),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    assignToBot: vi.fn(),
    release: vi.fn(),
    isInUse: vi.fn().mockReturnValue(false),
    createPaperWallet: vi.fn(),
    deletePaperWallet: vi.fn(),
  } as unknown as WalletRepository & {
    findById: ReturnType<typeof vi.fn>;
    findByAddress: ReturnType<typeof vi.fn>;
    findAll: ReturnType<typeof vi.fn>;
    findAvailable: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    assignToBot: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    isInUse: ReturnType<typeof vi.fn>;
    createPaperWallet: ReturnType<typeof vi.fn>;
    deletePaperWallet: ReturnType<typeof vi.fn>;
  };
}

function makeWalletRow(overrides: Partial<WalletRow> = {}): WalletRow {
  return {
    id: 'w-1',
    name: 'Test Wallet',
    address: '0x' + '11'.repeat(20),
    proxy_address: null,
    private_key_encrypted: '',
    current_bot_id: null,
    is_paper: 0,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('WalletManager', () => {
  let repo: ReturnType<typeof makeMockRepo>;
  let manager: WalletManager;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = makeMockRepo();
    manager = new WalletManager(repo as unknown as WalletRepository, VALID_KEY);
  });

  describe('constructor', () => {
    it('should throw when encryption key is empty', () => {
      expect(() => new WalletManager(repo as unknown as WalletRepository, '')).toThrow(
        'Encryption key is not set'
      );
    });

    it('should throw when encryption key is too short', () => {
      expect(() => new WalletManager(repo as unknown as WalletRepository, 'short')).toThrow(
        '64 hex characters'
      );
    });

    it('should succeed with valid encryption key', () => {
      expect(() => new WalletManager(repo as unknown as WalletRepository, VALID_KEY)).not.toThrow();
    });
  });

  describe('encryptPrivateKey / decryptPrivateKey', () => {
    it('should round-trip encrypt and decrypt', () => {
      const encrypted = manager.encryptPrivateKey(SAMPLE_HEX_KEY);
      expect(encrypted).not.toBe(SAMPLE_HEX_KEY);
      const decrypted = manager.decryptPrivateKey(encrypted);
      expect(decrypted).toBe(SAMPLE_HEX_KEY);
    });

    it('should strip 0x prefix before encrypting', () => {
      const encrypted = manager.encryptPrivateKey('0x' + SAMPLE_HEX_KEY);
      const decrypted = manager.decryptPrivateKey(encrypted);
      expect(decrypted).toBe(SAMPLE_HEX_KEY);
    });

    it('should throw when encrypting empty string', () => {
      expect(() => manager.encryptPrivateKey('')).toThrow('Private key cannot be empty');
    });

    it('should throw when decrypting empty string', () => {
      expect(() => manager.decryptPrivateKey('')).toThrow('Encrypted key cannot be empty');
    });

    it('should throw when decrypting with wrong key', () => {
      const encrypted = manager.encryptPrivateKey(SAMPLE_HEX_KEY);
      const otherManager = new WalletManager(repo as unknown as WalletRepository, 'b'.repeat(64));
      expect(() => otherManager.decryptPrivateKey(encrypted)).toThrow('Failed to decrypt');
    });
  });

  describe('getWallet()', () => {
    it('should return decrypted wallet credentials', async () => {
      const encrypted = manager.encryptPrivateKey(SAMPLE_HEX_KEY);
      repo.findById.mockReturnValue(
        makeWalletRow({
          private_key_encrypted: encrypted,
          proxy_address: '0xproxy',
        })
      );

      const creds = await manager.getWallet('w-1');
      expect(creds.address).toBe('0x' + '11'.repeat(20));
      expect(creds.proxyAddress).toBe('0xproxy');
      expect(creds.privateKey).toBe(SAMPLE_HEX_KEY);
    });

    it('should throw when wallet not found', async () => {
      repo.findById.mockReturnValue(undefined);
      await expect(manager.getWallet('bad-id')).rejects.toThrow('Wallet not found');
    });

    it('should set proxyAddress to undefined when null in DB', async () => {
      const encrypted = manager.encryptPrivateKey(SAMPLE_HEX_KEY);
      repo.findById.mockReturnValue(
        makeWalletRow({ private_key_encrypted: encrypted, proxy_address: null })
      );
      const creds = await manager.getWallet('w-1');
      expect(creds.proxyAddress).toBeUndefined();
    });
  });

  describe('assignWalletToBot()', () => {
    it('should assign wallet to bot', async () => {
      repo.findById.mockReturnValue(makeWalletRow({ current_bot_id: null }));
      await manager.assignWalletToBot('w-1', 'b-1');
      expect(repo.assignToBot).toHaveBeenCalledWith('w-1', 'b-1');
    });

    it('should throw when wallet not found', async () => {
      repo.findById.mockReturnValue(undefined);
      await expect(manager.assignWalletToBot('bad', 'b-1')).rejects.toThrow('Wallet not found');
    });

    it('should throw when wallet already assigned to different bot', async () => {
      repo.findById.mockReturnValue(makeWalletRow({ current_bot_id: 'other-bot' }));
      await expect(manager.assignWalletToBot('w-1', 'b-1')).rejects.toThrow('already assigned');
    });

    it('should allow re-assignment to same bot', async () => {
      repo.findById.mockReturnValue(makeWalletRow({ current_bot_id: 'b-1' }));
      await expect(manager.assignWalletToBot('w-1', 'b-1')).resolves.not.toThrow();
    });
  });

  describe('releaseWallet()', () => {
    it('should release wallet', async () => {
      repo.findById.mockReturnValue(makeWalletRow());
      await manager.releaseWallet('w-1');
      expect(repo.release).toHaveBeenCalledWith('w-1');
    });

    it('should not throw when wallet not found', async () => {
      repo.findById.mockReturnValue(undefined);
      await expect(manager.releaseWallet('bad')).resolves.not.toThrow();
    });
  });

  describe('createWallet()', () => {
    it('should create wallet with encrypted key', async () => {
      repo.findByAddress.mockReturnValue(undefined);
      repo.create.mockReturnValue(makeWalletRow());

      await manager.createWallet('My Wallet', '0x' + '11'.repeat(20), '0x' + SAMPLE_HEX_KEY);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Wallet',
          address: '0x' + '11'.repeat(20),
          privateKeyEncrypted: expect.any(String),
        })
      );
    });

    it('should reject invalid private key format', async () => {
      await expect(manager.createWallet('Test', '0xaddr', 'not-hex')).rejects.toThrow(
        'Invalid private key format'
      );
    });

    it('should reject duplicate address', async () => {
      repo.findByAddress.mockReturnValue(makeWalletRow());
      await expect(
        manager.createWallet('Test', '0x' + '11'.repeat(20), '0x' + SAMPLE_HEX_KEY)
      ).rejects.toThrow('already exists');
    });

    it('should normalize address to lowercase', async () => {
      repo.findByAddress.mockReturnValue(undefined);
      repo.create.mockReturnValue(makeWalletRow());

      await manager.createWallet('Test', '0xABCD' + '11'.repeat(18), '0x' + SAMPLE_HEX_KEY);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          address: ('0xABCD' + '11'.repeat(18)).toLowerCase(),
        })
      );
    });
  });

  describe('deleteWallet()', () => {
    it('should delete unassigned wallet', async () => {
      repo.findById.mockReturnValue(makeWalletRow({ current_bot_id: null }));
      repo.delete.mockReturnValue(true);
      await expect(manager.deleteWallet('w-1')).resolves.not.toThrow();
      expect(repo.delete).toHaveBeenCalledWith('w-1');
    });

    it('should throw when wallet not found', async () => {
      repo.findById.mockReturnValue(undefined);
      await expect(manager.deleteWallet('bad')).rejects.toThrow('Wallet not found');
    });

    it('should throw when wallet is assigned to a bot', async () => {
      repo.findById.mockReturnValue(makeWalletRow({ current_bot_id: 'b-1' }));
      await expect(manager.deleteWallet('w-1')).rejects.toThrow('currently assigned');
    });

    it('should throw when repository delete fails', async () => {
      repo.findById.mockReturnValue(makeWalletRow({ current_bot_id: null }));
      repo.delete.mockReturnValue(false);
      await expect(manager.deleteWallet('w-1')).rejects.toThrow('Failed to delete');
    });
  });

  describe('createPaperWallet()', () => {
    it('should generate random wallet and store as paper', async () => {
      repo.createPaperWallet.mockReturnValue(
        makeWalletRow({ id: 'pw-1', name: 'Paper - TestBot', is_paper: 1 })
      );

      const result = await manager.createPaperWallet('TestBot');

      expect(repo.createPaperWallet).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Paper - TestBot',
          address: ('0x' + 'cd'.repeat(20)).toLowerCase(),
          privateKeyEncrypted: expect.any(String),
        })
      );
      expect(result.name).toBe('Paper - TestBot');
    });
  });

  describe('deletePaperWallet()', () => {
    it('should release then delete', async () => {
      await manager.deletePaperWallet('pw-1');

      expect(repo.release).toHaveBeenCalledWith('pw-1');
      expect(repo.deletePaperWallet).toHaveBeenCalledWith('pw-1');
    });
  });
});
