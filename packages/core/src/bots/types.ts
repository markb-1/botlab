// Bot lifecycle status
export type BotStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

/**
 * Plain bot record object (database-agnostic).
 * Used by BaseBotRunner and BotManager.
 */
export interface BotRecord {
  id: string;
  name: string;
  scriptId: string;
  walletId: string;
  config: Record<string, unknown>;
  status: BotStatus;
  enabled: boolean;
  mode: 'live' | 'paper';
  lastStartedAt?: string | null;
  lastStoppedAt?: string | null;
  lastHeartbeat?: string | null;
  errorLogs: Array<{
    message: string;
    timestamp: string;
    stack?: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Plain wallet record object (database-agnostic).
 */
export interface WalletRecord {
  id: string;
  name: string;
  address: string;
  proxyAddress?: string | null;
  privateKeyEncrypted: string;
  currentBotId?: string | null;
  createdAt: string;
  updatedAt: string;
}

// Decrypted wallet credentials for use by bots
export interface WalletCredentials {
  address: string;
  proxyAddress?: string;
  privateKey: string;
}

// Health information returned by bot instances
export interface BotHealthInfo {
  botId: string;
  botType: string;
  status: BotStatus;
  uptime?: number; // seconds
  lastHeartbeat?: Date;
  metrics: Record<string, number | string>;
  errors: Array<{ message: string; timestamp: Date }>;
}

// Events emitted by bot instances
export type BotEventType =
  | 'status_changed'
  | 'heartbeat'
  | 'trade_executed'
  | 'trade_detected'
  | 'position_redeemed'
  | 'error'
  | 'log';

export interface BotEvent {
  type: BotEventType;
  botId: string;
  botType: string;
  timestamp: Date;
  data?: Record<string, unknown>;
}

// API response types
export interface BotSummary {
  id: string;
  name: string;
  status: BotStatus;
  enabled: boolean;
  walletId: string;
  walletAddress?: string;
  scriptId?: string;
  scriptName?: string;
  lastHeartbeat?: Date;
}

export interface WalletSummary {
  id: string;
  name: string;
  address: string;
  currentBotId?: string;
  inUse: boolean;
}
