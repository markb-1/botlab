// Bot types
export type BotStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface Bot {
  id: string;
  name: string;
  scriptId: string;
  scriptName: string;
  walletId: string;
  walletAddress?: string;
  config: Record<string, unknown>;
  status: BotStatus;
  enabled: boolean;
  mode: 'live' | 'paper';
  lastStartedAt?: string | null;
  lastStoppedAt?: string | null;
  lastHeartbeat?: string | null;
  errorLogs: Array<{ message: string; timestamp: string; stack?: string }>;
  createdAt: string;
  updatedAt: string;
}

// Script types
export interface Script {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  source: string;
  configSchema: Record<string, unknown>;
  isTemplate: boolean;
  createdAt: string;
  updatedAt: string;
}

// JSON Schema type used by script configSchema
export interface ConfigSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

// Wallet types
export interface Wallet {
  id: string;
  name: string;
  address: string;
  proxyAddress?: string | null;
  currentBotId?: string | null;
  inUse?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WalletBalance {
  address: string;
  usdc: number;
}

export interface BotBalance {
  botId: string;
  botName: string;
  address: string;
  balance: number;
  error?: string;
}

// Settings types
export interface Settings {
  rpcUrl: string;
  clobHttpUrl: string;
  clobWsUrl: string;
  usdcContractAddress: string;
  alchemyApiKey?: string | null;
  hasBinanceCredentials: boolean;
}

// Bot Trade types
export interface BotTrade {
  id: string;
  botId: string;
  botName?: string;
  scriptName?: string;
  traderAddress?: string;
  traderName?: string;
  market?: string;
  marketSlug?: string;
  conditionId?: string;
  outcome?: string;
  side?: 'BUY' | 'SELL' | string;
  traderBetSize?: number;
  botBetSize?: number;
  traderWinRate?: number;
  traderSampleSize?: number;
  kellyFraction?: number;
  kellyEdge?: number;
  kellyPercentage?: number;
  sizingReason?: string;
  currentPositionValue?: number;
  maxPositionSize?: number;
  executedAt: string;
  traderTradeTimestamp?: number;
  metadata?: Record<string, unknown>;
  // Auto-recorded trade fields
  exchange?: string;
  symbol?: string;
  price?: number;
  quantity?: number;
  quoteAmount?: number;
  simulated?: number;
}

// Bot position (computed from trade history)
export interface BotPosition {
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
export interface BotStats {
  cashBalance: number;
  positionsValue: number;
  totalValue: number;
  initialBalance: number | null;
  pnlAllTime: number | null;
  pnl24h: number;
  mode: 'live' | 'paper';
}

// Dashboard stats per bot (batch endpoint)
export interface DashboardBotStats {
  botId: string;
  totalValue: number;
  positionCount: number;
  pnlAllTime: number | null;
  pnl24h: number;
}

// Bot event from IPC
export interface BotEvent {
  type: string;
  botId: string;
  botType: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

// API response envelope (same shape as the server returns)
export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}
