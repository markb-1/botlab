import { contextBridge, ipcRenderer } from 'electron';

/**
 * Electron preload script.
 * Exposes a typed API to the renderer process via contextBridge.
 * This replaces the Express REST API + Socket.io WebSocket layer.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // === Auth ===
  auth: {
    status: () =>
      ipcRenderer.invoke('auth:status'),
    setup: (data: { password?: string; skip?: boolean }) =>
      ipcRenderer.invoke('auth:setup', data),
    unlock: (data: { password: string }) =>
      ipcRenderer.invoke('auth:unlock', data),
    autoUnlock: () =>
      ipcRenderer.invoke('auth:autoUnlock'),
  },

  // === Bots ===
  bots: {
    list: (filter?: { scriptId?: string; status?: string }) =>
      ipcRenderer.invoke('bots:list', filter),
    get: (id: string) =>
      ipcRenderer.invoke('bots:get', id),
    create: (data: { name: string; scriptId: string; walletId?: string; config?: Record<string, unknown>; mode?: 'live' | 'paper' }) =>
      ipcRenderer.invoke('bots:create', data),
    update: (id: string, data: { name?: string; config?: Record<string, unknown>; enabled?: boolean; walletId?: string }) =>
      ipcRenderer.invoke('bots:update', id, data),
    delete: (id: string) =>
      ipcRenderer.invoke('bots:delete', id),
    start: (id: string) =>
      ipcRenderer.invoke('bots:start', id),
    stop: (id: string) =>
      ipcRenderer.invoke('bots:stop', id),
    restart: (id: string) =>
      ipcRenderer.invoke('bots:restart', id),
    getTrades: (botId: string, hours?: number) =>
      ipcRenderer.invoke('bots:trades', botId, hours),
    getAllTrades: (hours?: number) =>
      ipcRenderer.invoke('bots:trades:all', hours),
    getPositions: (botId: string) =>
      ipcRenderer.invoke('bots:positions', botId),
    getStats: (botId: string) =>
      ipcRenderer.invoke('bots:stats', botId),
    getDashboardStats: () =>
      ipcRenderer.invoke('bots:dashboard-stats'),
  },

  // === Wallets ===
  wallets: {
    list: (filter?: { available?: boolean }) =>
      ipcRenderer.invoke('wallets:list', filter),
    get: (id: string) =>
      ipcRenderer.invoke('wallets:get', id),
    create: (data: { name: string; address: string; privateKey: string; proxyAddress?: string }) =>
      ipcRenderer.invoke('wallets:create', data),
    update: (id: string, data: { name?: string; proxyAddress?: string }) =>
      ipcRenderer.invoke('wallets:update', id, data),
    delete: (id: string) =>
      ipcRenderer.invoke('wallets:delete', id),
    getBalance: (id: string) =>
      ipcRenderer.invoke('wallets:balance', id),
  },

  // === Settings ===
  settings: {
    get: () =>
      ipcRenderer.invoke('settings:get'),
    update: (data: Record<string, unknown>) =>
      ipcRenderer.invoke('settings:update', data),
    testRpc: () =>
      ipcRenderer.invoke('settings:testRpc'),
    testClob: () =>
      ipcRenderer.invoke('settings:testClob'),
    saveBinance: (data: { apiKey: string; apiSecret: string }) =>
      ipcRenderer.invoke('settings:saveBinance', data),
    clearBinance: () =>
      ipcRenderer.invoke('settings:clearBinance'),
    testBinance: (data?: { apiKey: string; apiSecret: string }) =>
      ipcRenderer.invoke('settings:testBinance', data),
    saveClaude: (data: { apiKey: string }) =>
      ipcRenderer.invoke('settings:saveClaude', data),
    clearClaude: () =>
      ipcRenderer.invoke('settings:clearClaude'),
    testClaude: (data?: { apiKey: string }) =>
      ipcRenderer.invoke('settings:testClaude', data),
    getAiSystemPrompt: () =>
      ipcRenderer.invoke('settings:getAiSystemPrompt'),
    saveAiSystemPrompt: (data: { prompt: string }) =>
      ipcRenderer.invoke('settings:saveAiSystemPrompt', data),
  },

  // === AI ===
  ai: {
    generate: (data: { prompt: string }) =>
      ipcRenderer.invoke('ai:generate', data),
    edit: (data: { prompt: string; currentSource: string }) =>
      ipcRenderer.invoke('ai:edit', data),
  },

  // === Scripts ===
  scripts: {
    list: () =>
      ipcRenderer.invoke('scripts:list'),
    get: (id: string) =>
      ipcRenderer.invoke('scripts:get', id),
    create: (data: { name: string; description?: string; source: string; configSchema?: Record<string, unknown> }) =>
      ipcRenderer.invoke('scripts:create', data),
    update: (id: string, data: { name?: string; description?: string; source?: string; configSchema?: Record<string, unknown> }) =>
      ipcRenderer.invoke('scripts:update', id, data),
    delete: (id: string) =>
      ipcRenderer.invoke('scripts:delete', id),
    getSchema: (id: string) =>
      ipcRenderer.invoke('scripts:getSchema', id),
    fork: (id: string, newName?: string) =>
      ipcRenderer.invoke('scripts:fork', id, newName),
    compile: (source: string) =>
      ipcRenderer.invoke('scripts:compile', source),
    export: (id: string) =>
      ipcRenderer.invoke('scripts:export', id),
    import: () =>
      ipcRenderer.invoke('scripts:import'),
  },

  // === Backtesting ===
  backtest: {
    run: (data: { scriptId: string; symbol: string; interval?: string; startTime: number; endTime: number; initialBalance: number; config?: Record<string, unknown> }) =>
      ipcRenderer.invoke('backtest:run', data),
    list: (scriptId?: string) =>
      ipcRenderer.invoke('backtest:list', scriptId),
    get: (runId: string) =>
      ipcRenderer.invoke('backtest:get', runId),
    delete: (runId: string) =>
      ipcRenderer.invoke('backtest:delete', runId),
  },

  // === Risk (halts, kill switch) ===
  risk: {
    getState: () =>
      ipcRenderer.invoke('risk:getState'),
    clearHalt: (scope: string, reason: string) =>
      ipcRenderer.invoke('risk:clearHalt', scope, reason),
    killSwitch: (reason: string) =>
      ipcRenderer.invoke('risk:killSwitch', reason),
  },

  // === Real-time Events (replaces Socket.io) ===
  onBotEvent: (callback: (event: any) => void) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on('bot:event', listener);
    // Return cleanup function
    return () => ipcRenderer.removeListener('bot:event', listener);
  },

  onBotLog: (callback: (log: any) => void) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on('bot:log', listener);
    return () => ipcRenderer.removeListener('bot:log', listener);
  },

  onRiskHalt: (callback: (event: any) => void) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on('risk:halt', listener);
    return () => ipcRenderer.removeListener('risk:halt', listener);
  },

  // === App Info ===
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getAppPath: () => ipcRenderer.invoke('app:path'),
});

// Add TypeScript declaration for window.electronAPI
declare global {
  interface Window {
    electronAPI: {
      auth: {
        status: () => Promise<any>;
        setup: (data: { password?: string; skip?: boolean }) => Promise<any>;
        unlock: (data: { password: string }) => Promise<any>;
        autoUnlock: () => Promise<any>;
      };
      bots: {
        list: (filter?: { scriptId?: string; status?: string }) => Promise<any>;
        get: (id: string) => Promise<any>;
        create: (data: any) => Promise<any>;
        update: (id: string, data: any) => Promise<any>;
        delete: (id: string) => Promise<any>;
        start: (id: string) => Promise<any>;
        stop: (id: string) => Promise<any>;
        restart: (id: string) => Promise<any>;
        getTrades: (botId: string, hours?: number) => Promise<any>;
        getAllTrades: (hours?: number) => Promise<any>;
        getPositions: (botId: string) => Promise<any>;
        getStats: (botId: string) => Promise<any>;
        getDashboardStats: () => Promise<any>;
      };
      wallets: {
        list: (filter?: { available?: boolean }) => Promise<any>;
        get: (id: string) => Promise<any>;
        create: (data: any) => Promise<any>;
        update: (id: string, data: any) => Promise<any>;
        delete: (id: string) => Promise<any>;
        getBalance: (id: string) => Promise<any>;
      };
      settings: {
        get: () => Promise<any>;
        update: (data: any) => Promise<any>;
        testRpc: () => Promise<any>;
        testClob: () => Promise<any>;
        saveBinance: (data: { apiKey: string; apiSecret: string }) => Promise<any>;
        clearBinance: () => Promise<any>;
        testBinance: (data?: { apiKey: string; apiSecret: string }) => Promise<any>;
        saveClaude: (data: { apiKey: string }) => Promise<any>;
        clearClaude: () => Promise<any>;
        testClaude: (data?: { apiKey: string }) => Promise<any>;
        getAiSystemPrompt: () => Promise<any>;
        saveAiSystemPrompt: (data: { prompt: string }) => Promise<any>;
      };
      ai: {
        generate: (data: { prompt: string }) => Promise<any>;
        edit: (data: { prompt: string; currentSource: string }) => Promise<any>;
      };
      scripts: {
        list: () => Promise<any>;
        get: (id: string) => Promise<any>;
        create: (data: any) => Promise<any>;
        update: (id: string, data: any) => Promise<any>;
        delete: (id: string) => Promise<any>;
        getSchema: (id: string) => Promise<any>;
        compile: (source: string) => Promise<any>;
        fork: (id: string, newName?: string) => Promise<any>;
        export: (id: string) => Promise<any>;
        import: () => Promise<any>;
      };
      backtest: {
        run: (data: { scriptId: string; symbol: string; interval?: string; startTime: number; endTime: number; initialBalance: number; config?: Record<string, unknown> }) => Promise<any>;
        list: (scriptId?: string) => Promise<any>;
        get: (runId: string) => Promise<any>;
        delete: (runId: string) => Promise<any>;
      };
      risk: {
        getState: () => Promise<any>;
        clearHalt: (scope: string, reason: string) => Promise<any>;
        killSwitch: (reason: string) => Promise<any>;
      };
      onBotEvent: (callback: (event: any) => void) => () => void;
      onBotLog: (callback: (log: any) => void) => () => void;
      onRiskHalt: (callback: (event: any) => void) => () => void;
      getAppVersion: () => Promise<string>;
      getAppPath: () => Promise<string>;
    };
  }
}
