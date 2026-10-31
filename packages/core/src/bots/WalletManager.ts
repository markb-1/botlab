import { encrypt, decrypt } from '../security/crypto';
import { ethers } from 'ethers';
import type { WalletCredentials, WalletRecord } from './types';
import type { WalletRepository } from '../db/repositories/WalletRepository';
import logger from '../utils/logger';

/**
 * Manages wallet operations including encryption, decryption,
 * and assignment tracking for bot instances.
 */
export class WalletManager {
  private encryptionKey: string;
  private walletRepo: WalletRepository;

  constructor(walletRepo: WalletRepository, encryptionKey: string) {
    if (!encryptionKey) {
      throw new Error('Encryption key is not set');
    }
    if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
      throw new Error('Encryption key must be 64 hex characters (32 bytes)');
    }
    this.encryptionKey = encryptionKey;
    this.walletRepo = walletRepo;
    logger.info('WalletManager initialized');
  }

  /**
   * Encrypt a private key for storage
   */
  encryptPrivateKey(privateKey: string): string {
    if (!privateKey) {
      throw new Error('Private key cannot be empty');
    }

    // Remove 0x prefix if present
    const cleanKey = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;

    // AES-256-GCM (v2); legacy CryptoJS rows are still readable and migrated at unlock
    return encrypt(cleanKey, this.encryptionKey);
  }

  /**
   * Decrypt an encrypted private key
   */
  decryptPrivateKey(encryptedKey: string): string {
    if (!encryptedKey) {
      throw new Error('Encrypted key cannot be empty');
    }

    try {
      const privateKey = decrypt(encryptedKey, this.encryptionKey);

      if (!privateKey) {
        throw new Error('Decryption failed - invalid key or corrupted data');
      }

      return privateKey;
    } catch (error) {
      throw new Error(
        `Failed to decrypt private key: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get wallet credentials (decrypted) for use by a bot
   */
  async getWallet(walletId: string): Promise<WalletCredentials> {
    const wallet = this.walletRepo.findById(walletId);

    if (!wallet) {
      throw new Error(`Wallet not found: ${walletId}`);
    }

    const privateKey = this.decryptPrivateKey(wallet.private_key_encrypted);

    return {
      address: wallet.address,
      proxyAddress: wallet.proxy_address || undefined,
      privateKey,
    };
  }

  /**
   * Check if a wallet is currently assigned to a bot
   */
  async isWalletInUse(walletId: string): Promise<boolean> {
    return this.walletRepo.isInUse(walletId);
  }

  /**
   * Assign a wallet to a bot
   */
  async assignWalletToBot(walletId: string, botId: string): Promise<void> {
    const wallet = this.walletRepo.findById(walletId);

    if (!wallet) {
      throw new Error(`Wallet not found: ${walletId}`);
    }

    if (wallet.current_bot_id && wallet.current_bot_id !== botId) {
      throw new Error(
        `Wallet ${walletId} is already assigned to bot ${wallet.current_bot_id}`
      );
    }

    this.walletRepo.assignToBot(walletId, botId);
    logger.info(`Wallet ${wallet.address} assigned to bot ${botId}`);
  }

  /**
   * Release a wallet from a bot
   */
  async releaseWallet(walletId: string): Promise<void> {
    const wallet = this.walletRepo.findById(walletId);

    if (!wallet) {
      logger.warning(`Wallet not found when releasing: ${walletId}`);
      return;
    }

    this.walletRepo.release(walletId);
    logger.info(`Wallet ${wallet.address} released`);
  }

  /**
   * Get all available (unassigned) wallets
   */
  async getAvailableWallets(): Promise<WalletRecord[]> {
    const rows = this.walletRepo.findAvailable();
    return rows.map(this.toWalletRecord);
  }

  /**
   * Get all wallets
   */
  async getAllWallets(): Promise<WalletRecord[]> {
    const rows = this.walletRepo.findAll();
    return rows.map(this.toWalletRecord);
  }

  /**
   * Create a new wallet
   */
  async createWallet(
    name: string,
    address: string,
    privateKey: string
  ): Promise<WalletRecord> {
    // Validate private key format
    const cleanKey = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
    const hexRegex = /^[0-9a-fA-F]{64}$/;
    if (!hexRegex.test(cleanKey)) {
      throw new Error('Invalid private key format');
    }

    // Normalize address to lowercase
    const normalizedAddress = address.toLowerCase();

    // Check for existing wallet with same address
    const existing = this.walletRepo.findByAddress(normalizedAddress);
    if (existing) {
      throw new Error(`Wallet with address ${address} already exists`);
    }

    const encryptedKey = this.encryptPrivateKey(privateKey);

    const row = this.walletRepo.create({
      name,
      address: normalizedAddress,
      privateKeyEncrypted: encryptedKey,
    });

    logger.info(`Wallet created: ${name} (${normalizedAddress})`);

    return this.toWalletRecord(row);
  }

  /**
   * Delete a wallet (only if not in use)
   */
  async deleteWallet(walletId: string): Promise<void> {
    const wallet = this.walletRepo.findById(walletId);

    if (!wallet) {
      throw new Error(`Wallet not found: ${walletId}`);
    }

    if (wallet.current_bot_id) {
      throw new Error(
        `Cannot delete wallet that is currently assigned to bot ${wallet.current_bot_id}`
      );
    }

    const deleted = this.walletRepo.delete(walletId);
    if (!deleted) {
      throw new Error(`Failed to delete wallet ${walletId}`);
    }
    logger.info(`Wallet deleted: ${wallet.address}`);
  }

  /**
   * Create an auto-generated throwaway wallet for paper trading.
   * The wallet has a random private key and is marked with is_paper=1 in the DB.
   */
  async createPaperWallet(botName: string): Promise<WalletRecord> {
    const randomWallet = ethers.Wallet.createRandom();
    const privateKey = randomWallet.privateKey.slice(2); // strip 0x
    const encryptedKey = this.encryptPrivateKey(privateKey);

    const row = this.walletRepo.createPaperWallet({
      name: `Paper - ${botName}`,
      address: randomWallet.address.toLowerCase(),
      privateKeyEncrypted: encryptedKey,
    });

    logger.info(`Paper wallet created: ${randomWallet.address} for bot "${botName}"`);
    return this.toWalletRecord(row);
  }

  /**
   * Delete a paper wallet (used when its associated paper bot is deleted).
   */
  async deletePaperWallet(walletId: string): Promise<void> {
    // Release assignment first so the delete can proceed
    this.walletRepo.release(walletId);
    this.walletRepo.deletePaperWallet(walletId);
    logger.info(`Paper wallet deleted: ${walletId}`);
  }

  /**
   * Convert a database row to a WalletRecord
   */
  private toWalletRecord(row: { id: string; name: string; address: string; proxy_address: string | null; private_key_encrypted: string; current_bot_id: string | null; created_at: string; updated_at: string }): WalletRecord {
    return {
      id: row.id,
      name: row.name,
      address: row.address,
      proxyAddress: row.proxy_address || undefined,
      privateKeyEncrypted: row.private_key_encrypted,
      currentBotId: row.current_bot_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export default WalletManager;
