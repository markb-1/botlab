/**
 * Type declarations for the Electron preload API.
 * This makes window.electronAPI available to TypeScript in the client.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IpcResponse = { success: boolean; data?: any; error?: string; message?: string };

interface AuthStatus {
  needsSetup: boolean;
  hasPassword: boolean;
  unlocked: boolean;
}

interface ElectronAPI {
  auth: {
    status: () => Promise<IpcResponse>;
    setup: (data: { password?: string; skip?: boolean }) => Promise<IpcResponse>;
    unlock: (data: { password: string }) => Promise<IpcResponse>;
    autoUnlock: () => Promise<IpcResponse>;
  };
  bots: {
    list: (filter?: { scriptId?: string; status?: string }) => Promise<IpcResponse>;
    get: (id: string) => Promise<IpcResponse>;
    create: (data: { name: string; scriptId: string; walletId?: string; config?: Record<string, unknown>; mode?: 'live' | 'paper' }) => Promise<IpcResponse>;
    update: (id: string, data: { name?: string; config?: Record<string, unknown>; enabled?: boolean; walletId?: string }) => Promise<IpcResponse>;
    delete: (id: string) => Promise<IpcResponse>;
    start: (id: string) => Promise<IpcResponse>;
    stop: (id: string) => Promise<IpcResponse>;
    restart: (id: string) => Promise<IpcResponse>;
    getTrades: (botId: string, hours?: number) => Promise<IpcResponse>;
    getAllTrades: (hours?: number) => Promise<IpcResponse>;
    getPositions: (botId: string) => Promise<IpcResponse>;
    getStats: (botId: string) => Promise<IpcResponse>;
    getDashboardStats: () => Promise<IpcResponse>;
  };
  wallets: {
    list: (filter?: { available?: boolean }) => Promise<IpcResponse>;
    get: (id: string) => Promise<IpcResponse>;
    create: (data: { name: string; address: string; privateKey: string; proxyAddress?: string }) => Promise<IpcResponse>;
    update: (id: string, data: { name?: string; proxyAddress?: string }) => Promise<IpcResponse>;
    delete: (id: string) => Promise<IpcResponse>;
    getBalance: (id: string) => Promise<IpcResponse>;
  };
  settings: {
    get: () => Promise<IpcResponse>;
    update: (data: Record<string, unknown>) => Promise<IpcResponse>;
    testRpc: () => Promise<IpcResponse>;
    testClob: () => Promise<IpcResponse>;
    saveBinance: (data: { apiKey: string; apiSecret: string }) => Promise<IpcResponse>;
    clearBinance: () => Promise<IpcResponse>;
    testBinance: (data?: { apiKey: string; apiSecret: string }) => Promise<IpcResponse>;
    saveClaude: (data: { apiKey: string }) => Promise<IpcResponse>;
    clearClaude: () => Promise<IpcResponse>;
    testClaude: (data?: { apiKey: string }) => Promise<IpcResponse>;
    getAiSystemPrompt: () => Promise<IpcResponse>;
    saveAiSystemPrompt: (data: { prompt: string }) => Promise<IpcResponse>;
  };
  scripts: {
    list: () => Promise<IpcResponse>;
    get: (id: string) => Promise<IpcResponse>;
    create: (data: { name: string; description?: string; source: string; configSchema?: Record<string, unknown> }) => Promise<IpcResponse>;
    update: (id: string, data: { name?: string; description?: string; source?: string; configSchema?: Record<string, unknown> }) => Promise<IpcResponse>;
    delete: (id: string) => Promise<IpcResponse>;
    getSchema: (id: string) => Promise<IpcResponse>;
    compile: (source: string) => Promise<IpcResponse>;
    fork: (id: string, newName?: string) => Promise<IpcResponse>;
    export: (id: string) => Promise<IpcResponse>;
    import: () => Promise<IpcResponse>;
  };
  ai: {
    generate: (data: { prompt: string }) => Promise<IpcResponse>;
    edit: (data: { prompt: string; currentSource: string }) => Promise<IpcResponse>;
  };
  backtest: {
    run: (data: { scriptId: string; symbol?: string; interval?: string; startTime: number; endTime: number; initialBalance: number; config?: Record<string, unknown>; source?: 'binance-klines' | 'polymarket-snapshots'; tokenIds?: string[] }) => Promise<IpcResponse>;
    list: (scriptId?: string) => Promise<IpcResponse>;
    get: (runId: string) => Promise<IpcResponse>;
    delete: (runId: string) => Promise<IpcResponse>;
  };
  /** Halts and kill switch (spec §4.2–4.3). `scope` is 'global' or a bot id. */
  risk: {
    getState: () => Promise<IpcResponse>;
    clearHalt: (scope: string, reason: string) => Promise<IpcResponse>;
    killSwitch: (reason: string) => Promise<IpcResponse>;
  };
  /** Config files (spec §3). Human only. `file` is 'limits' | 'mandate' | 'fees' | 'server' | 'categories'. */
  config: {
    get: () => Promise<IpcResponse>;
    /** `expectedSha256`: the file's hash from `config.get().hashes`; the write is refused if the file changed since. */
    write: (file: string, value: unknown, expectedSha256?: string) => Promise<IpcResponse>;
    history: (file: string) => Promise<IpcResponse>;
    restore: (file: string, versionId: string) => Promise<IpcResponse>;
  };
  /**
   * Forecast ledger (spec §6). Forecasts are human-submitted until the agent exists; the server
   * captures market prices. `state` for setRightsState: shadow | trading | suspended | deprioritised | auto.
   */
  ledger: {
    submitForecast: (input: { tokenId: string; probability: number; rationale: string; sources: string[]; ambiguityScore: number }) => Promise<IpcResponse>;
    withdrawForecast: (id: string, reason: string) => Promise<IpcResponse>;
    list: (filter?: Record<string, unknown>) => Promise<IpcResponse>;
    stats: () => Promise<IpcResponse>;
    setRightsState: (category: string, bucket: string, state: string, reason: string) => Promise<IpcResponse>;
  };
  /** Market cache. `setAmbiguity`: human assessment 0-3 (buys need an assessed market). */
  markets: {
    get: (marketId: string) => Promise<IpcResponse>;
    setAmbiguity: (marketId: string, score: number, note?: string) => Promise<IpcResponse>;
  };
  reconcile: {
    status: () => Promise<IpcResponse>;
    /** One-time: record a wallet's pre-existing exchange positions as adopted fills of a bot on that wallet */
    adoptPositions: (walletId: string, botId: string, opts?: { includePostFirstOrder?: boolean }) => Promise<IpcResponse>;
  };
  recorder: {
    watchlistList: () => Promise<IpcResponse>;
    watchlistAdd: (tokenId: string, marketId?: string, note?: string) => Promise<IpcResponse>;
    watchlistRemove: (tokenId: string) => Promise<IpcResponse>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onMarketRulesChanged: (callback: (event: any) => void) => () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onConfigChanged: (callback: (event: any) => void) => () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onRiskHalt: (callback: (event: any) => void) => () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onBotEvent: (callback: (event: any) => void) => () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onBotLog: (callback: (log: any) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
