import type Database from 'better-sqlite3';
import { generateId } from '../index';

export interface WalletRow {
  id: string;
  name: string;
  address: string;
  proxy_address: string | null;
  private_key_encrypted: string;
  current_bot_id: string | null;
  is_paper: number;
  created_at: string;
  updated_at: string;
}

export class WalletRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  findById(id: string): WalletRow | undefined {
    return this.db.prepare('SELECT * FROM wallets WHERE id = ?').get(id) as WalletRow | undefined;
  }

  findByAddress(address: string): WalletRow | undefined {
    return this.db
      .prepare('SELECT * FROM wallets WHERE address = ?')
      .get(address.toLowerCase()) as WalletRow | undefined;
  }

  findAll(): WalletRow[] {
    return this.db.prepare('SELECT * FROM wallets WHERE is_paper = 0 ORDER BY created_at DESC').all() as WalletRow[];
  }

  findAvailable(): WalletRow[] {
    return this.db
      .prepare('SELECT * FROM wallets WHERE current_bot_id IS NULL AND is_paper = 0 ORDER BY created_at DESC')
      .all() as WalletRow[];
  }

  create(data: {
    name: string;
    address: string;
    proxyAddress?: string;
    privateKeyEncrypted: string;
  }): WalletRow {
    const id = generateId();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO wallets (id, name, address, proxy_address, private_key_encrypted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, data.name, data.address.toLowerCase(), data.proxyAddress || null, data.privateKeyEncrypted, now, now);

    return this.findById(id)!;
  }

  update(id: string, data: Partial<{ name: string; proxyAddress: string | null }>): WalletRow | undefined {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined) {
      sets.push('name = ?');
      values.push(data.name);
    }
    if (data.proxyAddress !== undefined) {
      sets.push('proxy_address = ?');
      values.push(data.proxyAddress);
    }

    if (sets.length === 0) return this.findById(id);

    sets.push("updated_at = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE wallets SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    return this.findById(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM wallets WHERE id = ? AND current_bot_id IS NULL').run(id);
    return result.changes > 0;
  }

  assignToBot(walletId: string, botId: string): void {
    this.db
      .prepare("UPDATE wallets SET current_bot_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(botId, walletId);
  }

  release(walletId: string): void {
    this.db
      .prepare("UPDATE wallets SET current_bot_id = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(walletId);
  }

  isInUse(walletId: string): boolean {
    const wallet = this.findById(walletId);
    return wallet?.current_bot_id != null;
  }

  createPaperWallet(data: {
    name: string;
    address: string;
    privateKeyEncrypted: string;
  }): WalletRow {
    const id = generateId();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO wallets (id, name, address, proxy_address, private_key_encrypted, is_paper, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, 1, ?, ?)`
      )
      .run(id, data.name, data.address.toLowerCase(), data.privateKeyEncrypted, now, now);

    return this.findById(id)!;
  }

  deletePaperWallet(id: string): boolean {
    const result = this.db.prepare('DELETE FROM wallets WHERE id = ? AND is_paper = 1').run(id);
    return result.changes > 0;
  }
}
