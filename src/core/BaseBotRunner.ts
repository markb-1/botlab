import { EventEmitter } from 'events';
import type { ClobClient } from '@polymarket/clob-client';
import type {
  BotStatus,
  BotRecord,
  BotHealthInfo,
  BotEvent,
  BotEventType,
  WalletCredentials,
} from './types';
import type { WalletManager } from './WalletManager';
import logger from '../utils/logger';

/**
 * Abstract base class for all bot implementations.
 * Provides lifecycle management, wallet handling, and event emission.
 */
export abstract class BaseBotRunner extends EventEmitter {
  protected botId: string;
  protected botType: string;
  protected botName: string;
  protected walletId: string;
  protected config: Record<string, unknown>;
  protected walletManager: WalletManager;
  protected clobClient: ClobClient;
  protected walletCredentials: WalletCredentials | null = null;

  private _status: BotStatus = 'stopped';
  private startTime: Date | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly heartbeatIntervalMs = 60000; // 60 seconds

  constructor(
    doc: BotRecord,
    walletManager: WalletManager,
    clobClient: ClobClient
  ) {
    super();
    this.botId = doc.id;
    this.botType = doc.scriptId || 'unknown';
    this.botName = doc.name;
    this.walletId = doc.walletId;
    this.config = doc.config;
    this.walletManager = walletManager;
    this.clobClient = clobClient;
  }

  /**
   * Current status of the bot
   */
  get status(): BotStatus {
    return this._status;
  }

  /**
   * Protected setter for status - emits status_changed event
   */
  protected setStatus(newStatus: BotStatus): void {
    const oldStatus = this._status;
    this._status = newStatus;
    if (oldStatus !== newStatus) {
      this.emitEvent('status_changed', { oldStatus, newStatus });
      logger.info(`[${this.botName}] Status changed: ${oldStatus} -> ${newStatus}`);
    }
  }

  /**
   * Uptime in seconds, or undefined if not running
   */
  get uptime(): number | undefined {
    if (!this.startTime || this._status !== 'running') {
      return undefined;
    }
    return Math.floor((Date.now() - this.startTime.getTime()) / 1000);
  }

  /**
   * Start the bot instance.
   * Acquires wallet, initializes resources, then calls doStart().
   */
  async start(): Promise<void> {
    if (this._status === 'running' || this._status === 'starting') {
      logger.warning(`[${this.botName}] Already ${this._status}, ignoring start request`);
      return;
    }

    this.setStatus('starting');

    try {
      // Acquire wallet credentials
      this.walletCredentials = await this.walletManager.getWallet(this.walletId);
      await this.walletManager.assignWalletToBot(this.walletId, this.botId);

      // Call implementation-specific start logic
      await this.doStart();

      this.startTime = new Date();
      this.startHeartbeat();
      this.setStatus('running');

      logger.info(`[${this.botName}] Started successfully`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[${this.botName}] Failed to start: ${errorMsg}`);

      // Release wallet on failure
      try {
        await this.walletManager.releaseWallet(this.walletId);
      } catch (releaseError) {
        logger.error(`[${this.botName}] Failed to release wallet after start failure`);
      }

      this.walletCredentials = null;
      this.setStatus('error');
      this.emitEvent('error', { message: errorMsg });
      throw error;
    }
  }

  /**
   * Stop the bot instance.
   * Calls doStop(), releases wallet, cleans up resources.
   */
  async stop(): Promise<void> {
    if (this._status === 'stopped' || this._status === 'stopping') {
      logger.warning(`[${this.botName}] Already ${this._status}, ignoring stop request`);
      return;
    }

    this.setStatus('stopping');

    try {
      this.stopHeartbeat();

      // Call implementation-specific stop logic
      await this.doStop();

      // Release wallet
      await this.walletManager.releaseWallet(this.walletId);
      this.walletCredentials = null;
      this.startTime = null;

      this.setStatus('stopped');
      logger.info(`[${this.botName}] Stopped successfully`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[${this.botName}] Error during stop: ${errorMsg}`);

      // Still try to release wallet
      try {
        await this.walletManager.releaseWallet(this.walletId);
      } catch (releaseError) {
        logger.error(`[${this.botName}] Failed to release wallet during stop`);
      }

      this.walletCredentials = null;
      this.startTime = null;
      this.setStatus('error');
      this.emitEvent('error', { message: errorMsg });
      throw error;
    }
  }

  /**
   * Get health information for this bot instance
   */
  getHealthInfo(): BotHealthInfo {
    return {
      botId: this.botId,
      botType: this.botType,
      status: this._status,
      uptime: this.uptime,
      lastHeartbeat: this.startTime ? new Date() : undefined,
      metrics: this.collectMetrics(),
      errors: [],
    };
  }

  /**
   * Emit a typed bot event
   */
  protected emitEvent(type: BotEventType, data?: Record<string, unknown>): void {
    const event: BotEvent = {
      type,
      botId: this.botId,
      botType: this.botType,
      timestamp: new Date(),
      data,
    };
    this.emit('bot:event', event);
    this.emit(`bot:${type}`, event);
  }

  /**
   * Start the heartbeat interval
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this.emitEvent('heartbeat', {
        uptime: this.uptime,
        metrics: this.collectMetrics(),
      });
    }, this.heartbeatIntervalMs);
  }

  /**
   * Stop the heartbeat interval
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Implementation-specific start logic.
   * Override in subclass to initialize and start services.
   */
  protected abstract doStart(): Promise<void>;

  /**
   * Implementation-specific stop logic.
   * Override in subclass to stop services and clean up.
   */
  protected abstract doStop(): Promise<void>;

  /**
   * Collect bot-specific metrics.
   * Override in subclass to return relevant metrics.
   */
  protected abstract collectMetrics(): Record<string, number | string>;
}

export default BaseBotRunner;
