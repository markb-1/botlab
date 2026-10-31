import { ipcMain } from 'electron';
import type { WalletService } from '../../../packages/core/src/services/WalletService';
import { WalletCreateSchema, WalletListFilterSchema, WalletUpdateSchema, parseInput } from '../../../packages/core/src/services/schemas';
import { respond } from '../respond';

export function registerWalletHandlers(wallets: WalletService): void {
  ipcMain.handle('wallets:list', (_event, filter?: unknown) => respond(() => wallets.list(parseInput(WalletListFilterSchema, filter))));

  ipcMain.handle('wallets:get', (_event, id: string) => respond(() => wallets.get(id)));

  ipcMain.handle('wallets:create', (_event, data: unknown) => respond(() => wallets.create(parseInput(WalletCreateSchema, data))));

  ipcMain.handle('wallets:update', (_event, id: string, data: unknown) => respond(() => wallets.update(id, parseInput(WalletUpdateSchema, data))));

  ipcMain.handle('wallets:delete', (_event, id: string) => respond(() => wallets.delete(id)));

  // USDC balance (proxy address when set)
  ipcMain.handle('wallets:balance', (_event, id: string) => respond(() => wallets.balance(id)));
}
