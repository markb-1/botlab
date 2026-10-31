/**
 * Electron API wrapper for the React client.
 * Provides the same interface as the REST API hooks but uses IPC.
 * Falls back to HTTP for development without Electron.
 */

const isElectron = typeof window !== 'undefined' && 'electronAPI' in window;

// Unwrap the IPC response format { success, data, error }
function unwrapResponse<T>(response: { success: boolean; data?: T; error?: string; message?: string }): T {
  if (!response.success) {
    throw new Error(response.error || 'Unknown error');
  }
  return response.data as T;
}

/**
 * Auth API
 */
export const authApi = {
  status: async (): Promise<{ needsSetup: boolean; hasPassword: boolean; unlocked: boolean }> => {
    if (isElectron) return unwrapResponse(await window.electronAPI.auth.status());
    throw new Error('Not in Electron environment');
  },

  setup: async (data: { password?: string; skip?: boolean }): Promise<{ unlocked: boolean }> => {
    if (isElectron) return unwrapResponse(await window.electronAPI.auth.setup(data));
    throw new Error('Not in Electron environment');
  },

  unlock: async (data: { password: string }): Promise<{ unlocked: boolean }> => {
    if (isElectron) return unwrapResponse(await window.electronAPI.auth.unlock(data));
    throw new Error('Not in Electron environment');
  },

  autoUnlock: async (): Promise<{ unlocked: boolean }> => {
    if (isElectron) return unwrapResponse(await window.electronAPI.auth.autoUnlock());
    throw new Error('Not in Electron environment');
  },
};

/**
 * Bot API
 */
export const botApi = {
  list: async (filter?: { scriptId?: string; status?: string }) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.bots.list(filter));
    throw new Error('Not in Electron environment');
  },

  get: async (id: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.bots.get(id));
    throw new Error('Not in Electron environment');
  },

  create: async (data: { name: string; scriptId: string; walletId?: string; config?: Record<string, unknown>; mode?: 'live' | 'paper' }) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.bots.create(data));
    throw new Error('Not in Electron environment');
  },

  update: async (id: string, data: { name?: string; config?: Record<string, unknown>; enabled?: boolean; walletId?: string }) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.bots.update(id, data));
    throw new Error('Not in Electron environment');
  },

  delete: async (id: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.bots.delete(id));
    throw new Error('Not in Electron environment');
  },

  start: async (id: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.bots.start(id));
    throw new Error('Not in Electron environment');
  },

  stop: async (id: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.bots.stop(id));
    throw new Error('Not in Electron environment');
  },

  restart: async (id: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.bots.restart(id));
    throw new Error('Not in Electron environment');
  },

  getTrades: async (botId: string, hours?: number) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.bots.getTrades(botId, hours));
    throw new Error('Not in Electron environment');
  },

  getAllTrades: async (hours?: number) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.bots.getAllTrades(hours));
    throw new Error('Not in Electron environment');
  },

  getPositions: async (botId: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.bots.getPositions(botId));
    throw new Error('Not in Electron environment');
  },

  getStats: async (botId: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.bots.getStats(botId));
    throw new Error('Not in Electron environment');
  },

  getDashboardStats: async () => {
    if (isElectron) return unwrapResponse(await window.electronAPI.bots.getDashboardStats());
    throw new Error('Not in Electron environment');
  },
};

/**
 * Wallet API
 */
export const walletApi = {
  list: async (filter?: { available?: boolean }) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.wallets.list(filter));
    throw new Error('Not in Electron environment');
  },

  get: async (id: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.wallets.get(id));
    throw new Error('Not in Electron environment');
  },

  create: async (data: { name: string; address: string; privateKey: string; proxyAddress?: string }) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.wallets.create(data));
    throw new Error('Not in Electron environment');
  },

  update: async (id: string, data: { name?: string; proxyAddress?: string }) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.wallets.update(id, data));
    throw new Error('Not in Electron environment');
  },

  delete: async (id: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.wallets.delete(id));
    throw new Error('Not in Electron environment');
  },

  getBalance: async (id: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.wallets.getBalance(id));
    throw new Error('Not in Electron environment');
  },
};

/**
 * Settings API
 */
export const settingsApi = {
  get: async () => {
    if (isElectron) return unwrapResponse(await window.electronAPI.settings.get());
    throw new Error('Not in Electron environment');
  },

  update: async (data: Record<string, unknown>) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.settings.update(data));
    throw new Error('Not in Electron environment');
  },

  testRpc: async () => {
    if (isElectron) return await window.electronAPI.settings.testRpc();
    throw new Error('Not in Electron environment');
  },

  testClob: async () => {
    if (isElectron) return await window.electronAPI.settings.testClob();
    throw new Error('Not in Electron environment');
  },

  saveBinance: async (data: { apiKey: string; apiSecret: string }) => {
    if (isElectron) return await window.electronAPI.settings.saveBinance(data);
    throw new Error('Not in Electron environment');
  },

  clearBinance: async () => {
    if (isElectron) return await window.electronAPI.settings.clearBinance();
    throw new Error('Not in Electron environment');
  },

  testBinance: async (data?: { apiKey: string; apiSecret: string }) => {
    if (isElectron) return await window.electronAPI.settings.testBinance(data);
    throw new Error('Not in Electron environment');
  },

  saveClaude: async (data: { apiKey: string }) => {
    if (isElectron) return await window.electronAPI.settings.saveClaude(data);
    throw new Error('Not in Electron environment');
  },

  clearClaude: async () => {
    if (isElectron) return await window.electronAPI.settings.clearClaude();
    throw new Error('Not in Electron environment');
  },

  testClaude: async (data?: { apiKey: string }) => {
    if (isElectron) return await window.electronAPI.settings.testClaude(data);
    throw new Error('Not in Electron environment');
  },

  getAiSystemPrompt: async () => {
    if (isElectron) return unwrapResponse(await window.electronAPI.settings.getAiSystemPrompt());
    throw new Error('Not in Electron environment');
  },

  saveAiSystemPrompt: async (data: { prompt: string }) => {
    if (isElectron) return await window.electronAPI.settings.saveAiSystemPrompt(data);
    throw new Error('Not in Electron environment');
  },
};

/**
 * AI API
 */
export const aiApi = {
  generate: async (data: { prompt: string }) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.ai.generate(data));
    throw new Error('Not in Electron environment');
  },

  edit: async (data: { prompt: string; currentSource: string }) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.ai.edit(data));
    throw new Error('Not in Electron environment');
  },
};

/**
 * Script API
 */
export const scriptApi = {
  list: async () => {
    if (isElectron) return unwrapResponse(await window.electronAPI.scripts.list());
    throw new Error('Not in Electron environment');
  },

  get: async (id: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.scripts.get(id));
    throw new Error('Not in Electron environment');
  },

  create: async (data: { name: string; description?: string; source: string; configSchema?: Record<string, unknown> }) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.scripts.create(data));
    throw new Error('Not in Electron environment');
  },

  update: async (id: string, data: { name?: string; description?: string; source?: string; configSchema?: Record<string, unknown> }) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.scripts.update(id, data));
    throw new Error('Not in Electron environment');
  },

  delete: async (id: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.scripts.delete(id));
    throw new Error('Not in Electron environment');
  },

  getSchema: async (id: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.scripts.getSchema(id));
    throw new Error('Not in Electron environment');
  },

  compile: async (source: string): Promise<{ compiled: boolean; error?: string }> => {
    if (isElectron) return unwrapResponse(await window.electronAPI.scripts.compile(source));
    throw new Error('Not in Electron environment');
  },

  fork: async (id: string, newName?: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.scripts.fork(id, newName));
    throw new Error('Not in Electron environment');
  },

  export: async (id: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.scripts.export(id));
    throw new Error('Not in Electron environment');
  },

  import: async () => {
    if (isElectron) return unwrapResponse(await window.electronAPI.scripts.import());
    throw new Error('Not in Electron environment');
  },
};

/**
 * Backtest API
 */
export const backtestApi = {
  run: async (data: { scriptId: string; symbol: string; interval?: string; startTime: number; endTime: number; initialBalance: number; config?: Record<string, unknown> }) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.backtest.run(data));
    throw new Error('Not in Electron environment');
  },

  list: async (scriptId?: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.backtest.list(scriptId));
    throw new Error('Not in Electron environment');
  },

  get: async (runId: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.backtest.get(runId));
    throw new Error('Not in Electron environment');
  },

  delete: async (runId: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.backtest.delete(runId));
    throw new Error('Not in Electron environment');
  },
};

/**
 * Config API (limits, mandate, fees, server). No UI yet (chunk 3c).
 */
export const configApi = {
  get: async () => {
    if (isElectron) return unwrapResponse(await window.electronAPI.config.get());
    throw new Error('Not in Electron environment');
  },

  write: async (file: 'limits' | 'mandate' | 'fees' | 'server', value: unknown) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.config.write(file, value));
    throw new Error('Not in Electron environment');
  },

  history: async (file: 'limits' | 'mandate' | 'fees' | 'server') => {
    if (isElectron) return unwrapResponse(await window.electronAPI.config.history(file));
    throw new Error('Not in Electron environment');
  },

  restore: async (file: 'limits' | 'mandate' | 'fees' | 'server', versionId: string) => {
    if (isElectron) return unwrapResponse(await window.electronAPI.config.restore(file, versionId));
    throw new Error('Not in Electron environment');
  },
};

/**
 * Real-time events (replaces Socket.io)
 */
export const events = {
  onBotEvent: (callback: (event: any) => void): (() => void) => {
    if (isElectron) {
      return window.electronAPI.onBotEvent(callback);
    }
    return () => {}; // No-op cleanup
  },

  onBotLog: (callback: (log: any) => void): (() => void) => {
    if (isElectron) {
      return window.electronAPI.onBotLog(callback);
    }
    return () => {};
  },
};

/**
 * Check if running in Electron
 */
export { isElectron };
