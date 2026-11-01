/**
 * ScriptBotRunner - BaseBotRunner subclass that runs user scripts via ScriptRunner.
 * This is the bridge between the bot management framework and the script runtime.
 */

import type { ClobClient } from '@polymarket/clob-client';
import { BaseBotRunner } from '../bots/BaseBotRunner';
import type { BotRecord } from '../bots/types';
import type { WalletManager } from '../bots/WalletManager';
import { ScriptRunner } from './ScriptRunner';
import type { LedgerReader, RpcHandlerDeps } from './RpcHandler';
import { PaperTradingState, DEFAULT_PAPER_BALANCE } from './PaperTradingState';
import type { BotStorageRepository } from '../db/repositories/BotStorageRepository';
import type { BotTradeRepository } from '../db/repositories/BotTradeRepository';
import type { OrderService } from '../orders/OrderService';
import type { PortfolioAccess } from '../orders/PortfolioService';
import type { BuiltinRole } from '../db/repositories/ScriptRepository';
import type { BotPushEventName } from '../sdk/types';
import logger from '../utils/logger';

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
  fetchAllowlist?: readonly string[] | (() => readonly string[] | undefined);
  /** Forecast ledger, read-only for bots (ctx.ledger) */
  ledger?: LedgerReader;
  /** Standing builtin role of the script (BotManager, from the script row) */
  role?: BuiltinRole | null;
  /**
   * ctx.portfolio for the builtin position manager: built once the bot's mode is known. Never set for
   * other scripts.
   */
  createPortfolio?: (args: { botId: string; simulated: boolean }) => PortfolioAccess;
  /** ctx.polymarket.getMarket (market cache) */
  getMarket?: RpcHandlerDeps['getMarket'];
  /** The bot's current market_ids (null = unscoped) */
  marketScope?: RpcHandlerDeps['marketScope'];
  /** Open exit flags on this bot's positions; the runner passes its mode */
  exitFlags?: (simulated: boolean) => ReturnType<NonNullable<RpcHandlerDeps['exitFlags']>>;
  /** ctx.requestRetire */
  requestRetire?: RpcHandlerDeps['requestRetire'];
  /** The Position Manager's exit thresholds; the runner passes its mode */
  exitPolicy?: (simulated: boolean) => ReturnType<NonNullable<RpcHandlerDeps['exitPolicy']>>;
  /** ctx.polymarket.getEventMarketIds */
  eventMarketIds?: RpcHandlerDeps['eventMarketIds'];
  /** Flagged tokens on any bot's position; the runner passes its mode (ctx.risk.getFlaggedTokens) */
  flaggedTokens?: (simulated: boolean) => ReturnType<NonNullable<RpcHandlerDeps['flaggedTokens']>>;
  /** ctx.risk.getMandateSummary */
  mandateSummary?: RpcHandlerDeps['mandateSummary'];
  /** ctx.copy and copy-order attribution: builtin Copy Trading template only */
  copy?: RpcHandlerDeps['copy'];
}

export { DEFAULT_PAPER_BALANCE };

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
      ledger: this.deps.ledger,
      role: this.deps.role ?? null,
      ...(this.deps.role === 'position-manager' && this.deps.createPortfolio
        ? { portfolio: this.deps.createPortfolio({ botId: this.botId, simulated: this.deps.mode === 'paper' }) }
        : {}),
      getMarket: this.deps.getMarket,
      marketScope: this.deps.marketScope,
      ...(this.deps.exitFlags ? { exitFlags: () => this.deps.exitFlags!(this.deps.mode === 'paper') } : {}),
      requestRetire: this.deps.requestRetire,
      ...(this.deps.exitPolicy ? { exitPolicy: () => this.deps.exitPolicy!(this.deps.mode === 'paper') } : {}),
      eventMarketIds: this.deps.eventMarketIds,
      mandateSummary: this.deps.mandateSummary,
      ...(this.deps.flaggedTokens ? { flaggedTokens: () => this.deps.flaggedTokens!(this.deps.mode === 'paper') } : {}),
      ...(this.deps.role === 'copy' && this.deps.copy ? { copy: this.deps.copy } : {}),
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

  /** ctx.events push (spec §5.2); dropped while the worker is not running. */
  pushEvent(name: BotPushEventName, data: Record<string, unknown>): void {
    this.scriptRunner?.pushEvent(name, data);
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
