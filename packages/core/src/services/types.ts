/**
 * Shared types for IPC communication between main and renderer processes.
 */

// Standard response wrapper
export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Bot types for IPC
export interface IpcBot {
  id: string;
  name: string;
  scriptId: string;
  scriptName: string;
  walletId: string;
  walletAddress?: string;
  config: Record<string, unknown>;
  status: string;
  enabled: boolean;
  mode: 'live' | 'paper';
  /** Ramp stage (spec §4.5) */
  stage?: string;
  /** human | agent */
  createdBy?: string;
  /** Per-bot allocation override (can only lower the configured one); null = configured */
  allocationUsd?: number | null;
  retireReason?: string | null;
  pausedBy?: string | null;
  strategy?: string | null;
  /** Markets the bot may trade; null = unscoped */
  marketIds?: string[] | null;
  /** scripts.revision the bot was created on */
  templateVersion?: number | null;
  /** The script's current revision and trust (the bot runs the latest compiled code, R20) */
  scriptRevision?: number | null;
  scriptTrust?: string | null;
  stageChangedAt?: string | null;
  lastStartedAt?: string | null;
  lastStoppedAt?: string | null;
  lastHeartbeat?: string | null;
  errorLogs: Array<{ message: string; timestamp: string; stack?: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface IpcCreateBot {
  name: string;
  scriptId: string;
  walletId?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
  mode?: 'live' | 'paper';
}

export interface IpcUpdateBot {
  name?: string;
  scriptId?: string;
  walletId?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

// Wallet types for IPC
export interface IpcWallet {
  id: string;
  name: string;
  address: string;
  proxyAddress?: string | null;
  currentBotId?: string | null;
  inUse: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IpcCreateWallet {
  name: string;
  address: string;
  privateKey: string;
  proxyAddress?: string;
}

// Script types for IPC
export interface IpcScript {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  source: string;
  configSchema: Record<string, unknown>;
  isTemplate: boolean;
  /** template | custom (agent templates are kind template but not isTemplate, which marks builtin ones) */
  kind?: string;
  origin?: string;
  /** Integer source version (spec §2.1) */
  revision?: number;
  /** Ramp trust: new | proven */
  trust?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IpcCreateScript {
  name: string;
  description?: string;
  version?: string;
  author?: string;
  source: string;
  configSchema?: Record<string, unknown>;
}

export interface IpcUpdateScript {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  source?: string;
  configSchema?: Record<string, unknown>;
}

// Settings types for IPC
export interface IpcSettings {
  rpcUrl: string;
  clobHttpUrl: string;
  clobWsUrl: string;
  usdcContractAddress: string;
  alchemyApiKey?: string | null;
  hasBinanceCredentials: boolean;
}

// Trade types for IPC
export interface IpcBotTrade {
  id: string;
  botId: string;
  botName?: string;
  scriptName?: string;
  traderAddress?: string;
  market?: string;
  outcome?: string;
  side?: string;
  traderBetSize?: number;
  botBetSize?: number;
  executedAt: string;
  metadata?: Record<string, unknown>;
  // Auto-recorded trade fields
  exchange?: string;
  symbol?: string;
  price?: number;
  quantity?: number;
  quoteAmount?: number;
  simulated?: number;
}

// Position types (computed from trade history)
export interface IpcBotPosition {
  symbol: string;
  exchange: string;
  market: string | null;
  outcome: string | null;
  netQuantity: number;
  totalCost: number;
  tradeCount: number;
  currentPrice: number | null;
  currentValue: number | null;
}

// Bot stats (balance, P&L summary)
export interface IpcBotStats {
  cashBalance: number;
  positionsValue: number;
  totalValue: number;
  initialBalance: number | null;
  pnlAllTime: number | null;
  pnl24h: number;
  mode: 'live' | 'paper';
}

// Dashboard stats per bot (batch endpoint)
export interface IpcDashboardBotStats {
  botId: string;
  totalValue: number;
  positionCount: number;
  pnlAllTime: number | null;
  pnl24h: number;
}

// Balance types
export interface IpcBalance {
  usdc: number;
  address: string;
}

// Bot event pushed from main to renderer
export interface IpcBotEvent {
  type: string;
  botId: string;
  botType: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

/**
 * Type-safe IPC channel map.
 * Maps channel names to their request/response types.
 */
export interface IpcChannelMap {
  // Bots
  'bots:list': { request: { scriptId?: string; status?: string }; response: IpcBot[] };
  'bots:get': { request: string; response: IpcBot };
  'bots:create': { request: IpcCreateBot; response: IpcBot };
  'bots:update': { request: { id: string; data: IpcUpdateBot }; response: IpcBot };
  'bots:delete': { request: string; response: void };
  'bots:start': { request: string; response: void };
  'bots:stop': { request: string; response: void };
  'bots:restart': { request: string; response: void };
  'bots:trades': { request: { botId: string; hours?: number }; response: IpcBotTrade[] };
  'bots:positions': { request: string; response: IpcBotPosition[] };
  'bots:stats': { request: string; response: IpcBotStats };
  'bots:balances': { request: void; response: Array<{ botId: string; botName: string; address: string; balance: number }> };
  'bots:dashboard-stats': { request: void; response: IpcDashboardBotStats[] };

  // Wallets
  'wallets:list': { request: { available?: boolean }; response: IpcWallet[] };
  'wallets:create': { request: IpcCreateWallet; response: IpcWallet };
  'wallets:update': { request: { id: string; data: { name?: string; proxyAddress?: string } }; response: IpcWallet };
  'wallets:delete': { request: string; response: void };
  'wallets:balance': { request: string; response: IpcBalance };

  // Settings
  'settings:get': { request: void; response: IpcSettings };
  'settings:update': { request: Partial<IpcSettings>; response: IpcSettings };

  // Scripts
  'scripts:list': { request: void; response: IpcScript[] };
  'scripts:get': { request: string; response: IpcScript };
  'scripts:create': { request: IpcCreateScript; response: IpcScript };
  'scripts:update': { request: { id: string; data: IpcUpdateScript }; response: IpcScript };
  'scripts:delete': { request: string; response: void };
  'scripts:getSchema': { request: string; response: Record<string, unknown> };
}
