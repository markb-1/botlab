import { ipcMain } from 'electron';
import type { WalletRepository } from '../../../packages/core/src/db/repositories/WalletRepository';
import type { WalletManager } from '../../../packages/core/src/bots/WalletManager';
import type { SettingsRepository } from '../../../packages/core/src/db/repositories/SettingsRepository';
import type { IpcWallet, IpcBalance } from '../../../packages/core/src/services/types';

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

export function registerWalletHandlers(
  walletRepo: WalletRepository,
  walletManager: WalletManager,
  settingsRepo: SettingsRepository
): void {
  // List all wallets
  ipcMain.handle('wallets:list', async (_event, filter?: { available?: boolean }) => {
    try {
      const rows = filter?.available ? walletRepo.findAvailable() : walletRepo.findAll();
      return {
        success: true,
        data: rows.map(walletRowToIpc),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get single wallet
  ipcMain.handle('wallets:get', async (_event, id: string) => {
    try {
      const row = walletRepo.findById(id);
      if (!row) return { success: false, error: 'Wallet not found' };
      return {
        success: true,
        data: walletRowToIpc(row),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Create wallet
  ipcMain.handle('wallets:create', async (_event, data: {
    name: string;
    address: string;
    privateKey: string;
    proxyAddress?: string;
  }) => {
    try {
      const record = await walletManager.createWallet(data.name, data.address, data.privateKey);

      // Update proxy address if provided
      if (data.proxyAddress) {
        walletRepo.update(record.id, { proxyAddress: data.proxyAddress });
      }

      const row = walletRepo.findById(record.id);
      return {
        success: true,
        data: walletRowToIpc(row!),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Update wallet
  ipcMain.handle('wallets:update', async (_event, id: string, data: {
    name?: string;
    proxyAddress?: string;
  }) => {
    try {
      const row = walletRepo.update(id, {
        name: data.name,
        proxyAddress: data.proxyAddress,
      });
      if (!row) return { success: false, error: 'Wallet not found' };
      return {
        success: true,
        data: walletRowToIpc(row),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Delete wallet
  ipcMain.handle('wallets:delete', async (_event, id: string) => {
    try {
      await walletManager.deleteWallet(id);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get wallet balance
  ipcMain.handle('wallets:balance', async (_event, id: string) => {
    try {
      const wallet = walletRepo.findById(id);
      if (!wallet) return { success: false, error: 'Wallet not found' };

      // Use proxy address for balance if available (Polymarket funds live there)
      const balanceAddress = wallet.proxy_address || wallet.address;

      // Read RPC settings from SQLite
      const settings = settingsRepo.get();
      if (!settings?.rpc_url || !settings?.usdc_contract_address) {
        return { success: false, error: 'RPC URL or USDC contract address not configured in settings' };
      }

      const { default: getMyBalance } = await import('../../../packages/core/src/utils/getMyBalance');
      const balance = await getMyBalance(balanceAddress, settings.rpc_url, settings.usdc_contract_address);

      const result: IpcBalance = {
        usdc: balance,
        address: balanceAddress,
      };

      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
