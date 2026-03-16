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
    };

    // Create paper trading state if in paper mode
    let paperState: PaperTradingState | undefined;
    if (this.deps.mode === 'paper') {
      const initialBalance = (this.config.paperBalance as number) || DEFAULT_PAPER_BALANCE;
      paperState = new PaperTradingState(this.botId, initialBalance, this.deps.storageRepo);
      paperState.load(); // Restore persisted state if any
    }

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
