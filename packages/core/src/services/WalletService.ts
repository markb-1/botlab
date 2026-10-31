/**
 * WalletService — wallet CRUD and USDC balance (moved out of the Electron `walletHandlers`).
 * Creating and deleting wallets needs the unlocked WalletManager (encryption key).
 */

import type { WalletRepository } from '../db/repositories/WalletRepository';
import type { WalletManager } from '../bots/WalletManager';
import type { SettingsRepository } from '../db/repositories/SettingsRepository';
import type { IpcWallet, IpcBalance } from './types';
import { ServiceError, notFound } from './errors';
import type { WalletCreateInput, WalletUpdateInput } from './schemas';

function walletRowToIpc(row: any): IpcWallet {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    proxyAddress: row.proxy_address,
    currentBotId: row.current_bot_id,
    inUse: row.current_bot_id != null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface WalletServiceDeps {
  walletRepo: WalletRepository;
  settingsRepo: SettingsRepository;
  /** The WalletManager once the core is unlocked, else null */
  walletManager: () => Pick<WalletManager, 'createWallet' | 'deleteWallet'> | null;
}

export class WalletService {
  constructor(private deps: WalletServiceDeps) {}

  private manager() {
    const m = this.deps.walletManager();
    if (!m) throw new ServiceError('locked', 'App is locked: unlock BotLab first');
    return m;
  }

  list(filter?: { available?: boolean }): IpcWallet[] {
    const { walletRepo } = this.deps;
    const rows = filter?.available ? walletRepo.findAvailable() : walletRepo.findAll();
    return rows.map(walletRowToIpc);
  }

  get(id: string): IpcWallet {
    const row = this.deps.walletRepo.findById(id);
    if (!row) throw notFound('Wallet not found');
    return walletRowToIpc(row);
  }

  async create(data: WalletCreateInput): Promise<IpcWallet> {
    const { walletRepo } = this.deps;
    const record = await this.manager().createWallet(data.name, data.address, data.privateKey);

    // Update proxy address if provided
    if (data.proxyAddress) {
      walletRepo.update(record.id, { proxyAddress: data.proxyAddress });
    }

    const row = walletRepo.findById(record.id);
    return walletRowToIpc(row!);
  }

  update(id: string, data: WalletUpdateInput): IpcWallet {
    const row = this.deps.walletRepo.update(id, {
      name: data.name,
      proxyAddress: data.proxyAddress,
    });
    if (!row) throw notFound('Wallet not found');
    return walletRowToIpc(row);
  }

  async delete(id: string): Promise<void> {
    await this.manager().deleteWallet(id);
  }

  /** USDC balance; uses the proxy address when set (Polymarket funds live there) */
  async balance(id: string): Promise<IpcBalance> {
    const { walletRepo, settingsRepo } = this.deps;
    const wallet = walletRepo.findById(id);
    if (!wallet) throw notFound('Wallet not found');

    const balanceAddress = wallet.proxy_address || wallet.address;

    // Read RPC settings from SQLite
    const settings = settingsRepo.get();
    if (!settings?.rpc_url || !settings?.usdc_contract_address) {
      throw new ServiceError('unavailable', 'RPC URL or USDC contract address not configured in settings');
    }

    const { default: getMyBalance } = await import('../utils/getMyBalance');
    const balance = await getMyBalance(balanceAddress, settings.rpc_url, settings.usdc_contract_address);

    return {
      usdc: balance,
      address: balanceAddress,
    };
  }
}
