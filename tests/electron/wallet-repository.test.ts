import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WalletRepository, type WalletRow } from '../../electron/database/repositories/WalletRepository';

// Mock generateId for deterministic IDs
let idCounter = 0;
vi.mock('../../electron/database/index', () => ({
  generateId: () => `wallet-${++idCounter}`,
}));

/**
 * better-sqlite3 is compiled for Electron (not Node.js), so we mock the database
 * and verify the repository's SQL queries and logic via mock assertions.
 */

function makeWalletRow(overrides: Partial<WalletRow> = {}): WalletRow {
  return {
    id: 'wallet-1',
    name: 'Test Wallet',
    address: '0x' + '11'.repeat(20),
    proxy_address: null,
    private_key_encrypted: 'encrypted',
    current_bot_id: null,
    is_paper: 0,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeMockDb() {
  const mockStatement = {
    get: vi.fn(),
    all: vi.fn().mockReturnValue([]),
    run: vi.fn().mockReturnValue({ changes: 1 }),
  };
  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    _stmt: mockStatement,
  };
}

describe('WalletRepository', () => {
  let db: ReturnType<typeof makeMockDb>;
  let repo: WalletRepository;

  beforeEach(() => {
    idCounter = 0;
    vi.clearAllMocks();
    db = makeMockDb();
    repo = new WalletRepository(db as any);
  });

  describe('findById()', () => {
    it('should query by id and return result', () => {
      const row = makeWalletRow();
      db._stmt.get.mockReturnValue(row);

      const result = repo.findById('wallet-1');
      expect(db.prepare).toHaveBeenCalledWith('SELECT * FROM wallets WHERE id = ?');
      expect(db._stmt.get).toHaveBeenCalledWith('wallet-1');
      expect(result).toEqual(row);
    });

    it('should return undefined when not found', () => {
      db._stmt.get.mockReturnValue(undefined);
      expect(repo.findById('bad')).toBeUndefined();
    });
  });

  describe('findByAddress()', () => {
    it('should query by lowercase address', () => {
      db._stmt.get.mockReturnValue(makeWalletRow());
      repo.findByAddress('0xABCD');
      expect(db._stmt.get).toHaveBeenCalledWith('0xabcd');
    });
  });

  describe('findAll()', () => {
    it('should query for non-paper wallets ordered DESC', () => {
      const rows = [makeWalletRow({ id: 'w-2' }), makeWalletRow({ id: 'w-1' })];
      db._stmt.all.mockReturnValue(rows);

      const result = repo.findAll();
      expect(db.prepare).toHaveBeenCalledWith(
        'SELECT * FROM wallets WHERE is_paper = 0 ORDER BY created_at DESC'
      );
      expect(result).toHaveLength(2);
    });
  });

  describe('findAvailable()', () => {
    it('should query for unassigned non-paper wallets', () => {
      db._stmt.all.mockReturnValue([makeWalletRow()]);
      repo.findAvailable();
      expect(db.prepare).toHaveBeenCalledWith(
        'SELECT * FROM wallets WHERE current_bot_id IS NULL AND is_paper = 0 ORDER BY created_at DESC'
      );
    });
  });

  describe('create()', () => {
    it('should insert and return via findById', () => {
      const row = makeWalletRow({ id: 'wallet-1' });
      db._stmt.get.mockReturnValue(row);

      const result = repo.create({
        name: 'Test Wallet',
        address: '0xABCD' + '11'.repeat(18),
        privateKeyEncrypted: 'encrypted',
      });

      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO wallets'));
      const runCall = db._stmt.run.mock.calls[0];
      expect(runCall[0]).toBe('wallet-1'); // generated id
      expect(runCall[1]).toBe('Test Wallet'); // name
      expect(runCall[2]).toBe(('0xABCD' + '11'.repeat(18)).toLowerCase()); // address lowercased
      expect(result).toEqual(row);
    });

    it('should store proxyAddress when provided', () => {
      db._stmt.get.mockReturnValue(makeWalletRow({ proxy_address: '0xproxy' }));
      repo.create({
        name: 'Test',
        address: '0x' + '11'.repeat(20),
        proxyAddress: '0xproxy',
        privateKeyEncrypted: 'enc',
      });
      const runCall = db._stmt.run.mock.calls[0];
      expect(runCall[3]).toBe('0xproxy');
    });

    it('should store null when proxyAddress not provided', () => {
      db._stmt.get.mockReturnValue(makeWalletRow());
      repo.create({
        name: 'Test',
        address: '0x' + '11'.repeat(20),
        privateKeyEncrypted: 'enc',
      });
      const runCall = db._stmt.run.mock.calls[0];
      expect(runCall[3]).toBeNull();
    });
  });

  describe('update()', () => {
    it('should build SET clause for name', () => {
      db._stmt.get.mockReturnValue(makeWalletRow({ name: 'New Name' }));
      repo.update('wallet-1', { name: 'New Name' });
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('name = ?'));
    });

    it('should return findById result when no updates', () => {
      const row = makeWalletRow();
      db._stmt.get.mockReturnValue(row);
      const result = repo.update('wallet-1', {});
      expect(result).toEqual(row);
    });
  });

  describe('delete()', () => {
    it('should delete with guard for current_bot_id IS NULL', () => {
      db._stmt.run.mockReturnValue({ changes: 1 });
      expect(repo.delete('wallet-1')).toBe(true);
      expect(db.prepare).toHaveBeenCalledWith(
        'DELETE FROM wallets WHERE id = ? AND current_bot_id IS NULL'
      );
    });

    it('should return false when no rows affected', () => {
      db._stmt.run.mockReturnValue({ changes: 0 });
      expect(repo.delete('wallet-1')).toBe(false);
    });
  });

  describe('assignToBot() and release()', () => {
    it('should update current_bot_id', () => {
      repo.assignToBot('wallet-1', 'bot-1');
      expect(db._stmt.run).toHaveBeenCalledWith('bot-1', 'wallet-1');
    });

    it('should clear current_bot_id on release', () => {
      repo.release('wallet-1');
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('current_bot_id = NULL')
      );
      expect(db._stmt.run).toHaveBeenCalledWith('wallet-1');
    });
  });

  describe('isInUse()', () => {
    it('should return true when current_bot_id is set', () => {
      db._stmt.get.mockReturnValue(makeWalletRow({ current_bot_id: 'bot-1' }));
      expect(repo.isInUse('wallet-1')).toBe(true);
    });

    it('should return false when current_bot_id is null', () => {
      db._stmt.get.mockReturnValue(makeWalletRow({ current_bot_id: null }));
      expect(repo.isInUse('wallet-1')).toBe(false);
    });

    it('should return false when wallet not found', () => {
      db._stmt.get.mockReturnValue(undefined);
      expect(repo.isInUse('bad')).toBe(false);
    });
  });

  describe('createPaperWallet()', () => {
    it('should insert with is_paper in the SQL', () => {
      db._stmt.get.mockReturnValue(makeWalletRow({ is_paper: 1 }));
      const result = repo.createPaperWallet({
        name: 'Paper Test',
        address: '0x' + '11'.repeat(20),
        privateKeyEncrypted: 'enc',
      });
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('is_paper')
      );
      expect(result.is_paper).toBe(1);
    });
  });

  describe('deletePaperWallet()', () => {
    it('should only delete if is_paper = 1', () => {
      db._stmt.run.mockReturnValue({ changes: 1 });
      expect(repo.deletePaperWallet('wallet-1')).toBe(true);
      expect(db.prepare).toHaveBeenCalledWith(
        'DELETE FROM wallets WHERE id = ? AND is_paper = 1'
      );
    });

    it('should return false when wallet is not paper', () => {
      db._stmt.run.mockReturnValue({ changes: 0 });
      expect(repo.deletePaperWallet('wallet-1')).toBe(false);
    });
  });
});
