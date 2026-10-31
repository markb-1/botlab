/**
 * ScriptBotRunner - BaseBotRunner subclass that runs user scripts via ScriptRunner.
 * This is the bridge between the bot management framework and the script runtime.
 */

import type { ClobClient } from '@polymarket/clob-client';
import { BaseBotRunner } from '../../src/core/BaseBotRunner';
import type { BotRecord } from '../../src/core/types';
import type { WalletManager } from '../../src/core/WalletManager';
import { ScriptRunner } from './ScriptRunner';
import type { RpcHandlerDeps } from './RpcHandler';
import { PaperTradingState } from './PaperTradingState';
import type { BotStorageRepository } from '../database/repositories/BotStorageRepository';
import type { BotTradeRepository } from '../database/repositories/BotTradeRepository';
import type { OrderService } from '../orders/OrderService';
import logger from '../../src/utils/logger';

/** Builds the bot's OrderService (BotManager supplies it; throws if orders cannot be risk-checked). */
export type OrderServiceFactory = (args: {
  botId: string;
  botName: string;
  scriptName: string;
  mode: 'live' | 'paper';
  clobClient: ClobClient;
  walletAddress: string;
  proxyAddress?: string;
  paperState?: PaperTradingState;
}) => OrderService;

export interface ScriptBotRunnerDeps {
  compiledCode: string;
  scriptName: string;
  storageRepo: BotStorageRepository;
  tradeRepo: BotTradeRepository;
  rpcUrl: string;
  usdcContractAddress: string;
  clobHttpUrl: string;
  mode: 'live' | 'paper';
  binanceApiKey?: string;
  binanceApiSecret?: string;
  /** Without it the bot runs but every order call fails (fail closed) */
  createOrderService?: OrderServiceFactory;
  /** Hosts ctx.fetch may reach (limits.yaml server.script_fetch_allowlist) */
  fetchAllowlist?: readonly string[];
}

const DEFAULT_PAPER_BALANCE = 10_000;

export class ScriptBotRunner extends BaseBotRunner {
  private scriptRunner: ScriptRunner | null = null;
  private deps: ScriptBotRunnerDeps;
  private lastMetrics: Record<string, number | string> = {};

  constructor(
    doc: BotRecord,
    walletManager: WalletManager,
    clobClient: ClobClient,
    deps: ScriptBotRunnerDeps
  ) {
    super(doc, walletManager, clobClient);
    this.deps = deps;
  }

  protected async doStart(): Promise<void> {
    const credentials = this.walletCredentials;
    if (!credentials) {
      throw new Error('No wallet credentials available');
    }

    const rpcHandlerDeps: RpcHandlerDeps = {
      clobClient: this.clobClient,
      storageRepo: this.deps.storageRepo,
      tradeRepo: this.deps.tradeRepo,
      botId: this.botId,
      botName: this.botName,
      scriptName: this.deps.scriptName,
      walletAddress: credentials.address,
      proxyAddress: credentials.proxyAddress,
      rpcUrl: this.deps.rpcUrl,
      usdcContractAddress: this.deps.usdcContractAddress,
      clobHttpUrl: this.deps.clobHttpUrl,
      binanceApiKey: this.deps.binanceApiKey,
      binanceApiSecret: this.deps.binanceApiSecret,
      fetchAllowlist: this.deps.fetchAllowlist,
    };

    // Create paper trading state if in paper mode
    let paperState: PaperTradingState | undefined;
    if (this.deps.mode === 'paper') {
      const initialBalance = (this.config.paperBalance as number) || DEFAULT_PAPER_BALANCE;
      paperState = new PaperTradingState(this.botId, initialBalance, this.deps.storageRepo);
      paperState.load(); // Restore persisted state if any
    }

    rpcHandlerDeps.orderService = this.deps.createOrderService?.({
      botId: this.botId,
      botName: this.botName,
      scriptName: this.deps.scriptName,
      mode: this.deps.mode,
      clobClient: this.clobClient,
      walletAddress: credentials.address,
      proxyAddress: credentials.proxyAddress,
      paperState,
    });

    this.scriptRunner = new ScriptRunner({
      compiledCode: this.deps.compiledCode,
      botId: this.botId,
      botName: this.botName,
      config: this.config,
      walletAddress: credentials.address,
      proxyAddress: credentials.proxyAddress,
      rpcHandlerDeps,
      paperState,
    });

    // Forward script events to the bot event system
    this.scriptRunner.on('error', ({ message }: { message: string }) => {
      this.emitEvent('error', { message });
    });

    this.scriptRunner.on('event', (event: { type: string; data?: Record<string, unknown> }) => {
      this.emitEvent(event.type as any, event.data);
    });

    this.scriptRunner.on('log', (logData: { botId: string; level: string; message: string }) => {
      this.emitEvent('log', logData);
    });

    // Tick watchdog / unexpected worker exit (spec §5.1)
    this.scriptRunner.on('tick-timeout', ({ strikes, elapsedMs }: { strikes: number; elapsedMs: number }) => {
      const message = `onTick still running after ${Math.round(elapsedMs / 1000)} s (watchdog strike ${strikes})`;
      logger.warning(`[Script:${this.botName}] ${message}`);
      this.emitEvent('log', { botId: this.botId, level: 'warn', message });
    });

    this.scriptRunner.on('fatal', ({ message, reason }: { message: string; reason: string }) => {
      this.scriptRunner = null;
      void this.markFailed(message, { reason });
    });

    this.scriptRunner.on('heartbeat', ({ metrics }: { metrics: Record<string, unknown> }) => {
      this.lastMetrics = {};
      for (const [key, value] of Object.entries(metrics)) {
        if (typeof value === 'number' || typeof value === 'string') {
          this.lastMetrics[key] = value;
        }
      }
    });

    // Start the script
    await this.scriptRunner.start();
  }

  protected async doStop(): Promise<void> {
    if (this.scriptRunner) {
      await this.scriptRunner.stop();
      this.scriptRunner = null;
    }
  }

  protected collectMetrics(): Record<string, number | string> {
    // Request fresh metrics from the worker
    if (this.scriptRunner?.isRunning) {
      this.scriptRunner.requestHeartbeat();
    }
    return { ...this.lastMetrics };
  }
}
