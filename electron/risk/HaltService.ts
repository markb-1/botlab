/**
 * Halts (spec §4.2, §4.3).
 *
 * Bot halt: set risk_state halted + reason (RiskEngine step 1 then rejects every order of the
 * bot, live and paper) → cancel the bot's open orders → stop its worker → cancel again for
 * anything that landed meanwhile → audit + `risk:halt` event. A loss halt of a `full` bot
 * demotes it to `probation` (§4.5).
 *
 * Halts are cleared only by a human (`clearHalt` with actor `human` and a reason). Nothing
 * else in the app clears them — the daily reset only resets P&L figures.
 */

import { EventEmitter } from 'events';
import { GLOBAL_SCOPE, type RiskStateRepository, type RiskStateRow } from '../database/repositories/RiskStateRepository';
import type { BotRepository } from '../database/repositories/BotRepository';
import type { BotCancelResult, OrderCanceller } from '../orders/OrderCanceller';
import type { AuditActor, AuditService } from '../audit/AuditService';
import type { BotStage } from './types';
import { demoteOnLossHalt } from './ramp';
import logger from '../../src/utils/logger';

export const RISK_HALT_EVENT = 'risk:halt';
export const RISK_HALT_CLEARED_EVENT = 'risk:halt-cleared';

export interface RiskHaltEvent {
  /** 'global' or a bot id */
  scope: string;
  kind: 'bot' | 'global' | 'kill_switch';
  reason: string;
  actor: AuditActor;
  at: string;
  /** Per-bot cancellation results (none for a flag-only global halt) */
  cancels: BotCancelResult[];
}

/** What the halt flow needs from the bot runtime (BotManager). */
export interface BotControl {
  /** Stop the bot's worker if it is running; never throws for a stopped bot. */
  stopBot(botId: string, actor: AuditActor): Promise<void>;
  runningBotIds(): string[];
}

export interface HaltDeps {
  riskStateRepo: RiskStateRepository;
  botRepo: Pick<BotRepository, 'findById' | 'setStage'>;
  audit: AuditService;
  canceller: Pick<OrderCanceller, 'cancelBot' | 'cancelAllBots'>;
  bots: BotControl;
}

export interface RiskStateView {
  scope: string;
  halted: boolean;
  reason: string | null;
  haltedAt: string | null;
  dayStartEquity: number | null;
  dayRealizedPnl: number;
  dayUnrealizedPnl: number;
  updatedAt: string;
}

export function toRiskStateView(row: RiskStateRow): RiskStateView {
  return {
    scope: row.scope,
    halted: row.halted === 1,
    reason: row.halted_reason,
    haltedAt: row.halted_at,
    dayStartEquity: row.day_start_equity,
    dayRealizedPnl: row.day_realized_pnl,
    dayUnrealizedPnl: row.day_unrealized_pnl,
    updatedAt: row.updated_at,
  };
}

const sumCancels = (rs: BotCancelResult[]) => ({
  cancelled: rs.reduce((n, r) => n + r.cancelled, 0),
  failed: rs.reduce((n, r) => n + r.failed, 0),
  unknownOutcome: rs.reduce((n, r) => n + r.unknownOutcome, 0),
  errors: rs.flatMap((r) => r.errors.map((e) => `${r.botId}: ${e}`)),
});

export class HaltService extends EventEmitter {
  constructor(private deps: HaltDeps) {
    super();
  }

  isHalted(scope: string): boolean {
    return this.deps.riskStateRepo.isHalted(scope);
  }

  /**
   * Halt one bot. Returns false if it was already halted (nothing done).
   * `lossHalt`: the halt was caused by a loss limit (demotes a full bot to probation).
   */
  async haltBot(botId: string, reason: string, actor: AuditActor, opts: { lossHalt?: boolean } = {}): Promise<boolean> {
    const { riskStateRepo, audit } = this.deps;
    if (riskStateRepo.isHalted(botId)) return false;

    riskStateRepo.setHalted(botId, true, reason);
    audit.record(actor, 'risk.halt', botId, { kind: 'bot', reason, lossHalt: opts.lossHalt === true });
    logger.warning(`[Halt] Bot ${botId} halted by ${actor}: ${reason}`);

    if (opts.lossHalt) this.demote(botId, reason);

    const cancels = [await this.deps.canceller.cancelBot(botId)];
    try {
      await this.deps.bots.stopBot(botId, 'system');
    } catch (err) {
      logger.error(`[Halt] Could not stop bot ${botId}: ${err instanceof Error ? err.message : err}`);
    }
    // Orders that were in flight while the first pass ran
    cancels.push(await this.deps.canceller.cancelBot(botId));

    const summary = sumCancels(cancels);
    audit.record('system', 'risk.halt.orders_cancelled', botId, summary, summary.failed > 0 || summary.errors.length > 0 ? 'partial' : 'ok');
    this.emit(RISK_HALT_EVENT, {
      scope: botId,
      kind: 'bot',
      reason,
      actor,
      at: new Date().toISOString(),
      cancels,
    } satisfies RiskHaltEvent);
    return true;
  }

  private demote(botId: string, reason: string): void {
    const bot = this.deps.botRepo.findById(botId);
    const to = bot ? demoteOnLossHalt(bot.stage as BotStage) : null;
    if (!bot || !to) return;
    this.deps.botRepo.setStage(botId, to);
    this.deps.audit.record('system', 'bot.stage', botId, { from: bot.stage, to, reason: `loss halt: ${reason}` });
    logger.warning(`[Halt] Bot ${botId} demoted ${bot.stage} → ${to}`);
  }

  /**
   * Set the global halt flag only (no cancels/stops) — used at startup before any bot runs.
   * The kill switch is the full global halt.
   */
  setGlobalHaltFlag(reason: string, actor: AuditActor): boolean {
    if (this.deps.riskStateRepo.isHalted(GLOBAL_SCOPE)) return false;
    this.deps.riskStateRepo.setHalted(GLOBAL_SCOPE, true, reason);
    this.deps.audit.record(actor, 'risk.halt', GLOBAL_SCOPE, { kind: 'global', reason });
    logger.warning(`[Halt] Global halt set by ${actor}: ${reason}`);
    this.emit(RISK_HALT_EVENT, { scope: GLOBAL_SCOPE, kind: 'global', reason, actor, at: new Date().toISOString(), cancels: [] } satisfies RiskHaltEvent);
    return true;
  }

  /** Clear a halt. Human-only, reason required. Throws if not allowed or not halted. */
  clearHalt(scope: string, reason: string, actor: AuditActor): void {
    if (actor !== 'human') {
      this.deps.audit.record(actor, 'risk.halt_clear', scope, { reason }, 'denied: human only');
      throw new Error('Only a human can clear a halt');
    }
    if (typeof scope !== 'string' || !scope) throw new Error('scope required');
    if (typeof reason !== 'string' || reason.trim().length === 0) throw new Error('A reason is required to clear a halt');
    const row = this.deps.riskStateRepo.get(scope);
    if (!row || row.halted !== 1) throw new Error(`${scope === GLOBAL_SCOPE ? 'Global scope' : `Bot ${scope}`} is not halted`);

    this.deps.riskStateRepo.setHalted(scope, false);
    // The daily loss limit applies afresh from here: losing another full limit today halts again
    const day = this.deps.riskStateRepo.getGlobal()?.day_start ?? null;
    const baseline = day
      ? { day, live: row.day_live_pnl ?? 0, paper: row.day_paper_pnl ?? 0, at: new Date().toISOString() }
      : null;
    this.deps.riskStateRepo.setLossBaseline(scope, baseline);
    this.deps.audit.record(actor, 'risk.halt_clear', scope, {
      reason: reason.trim(),
      previousReason: row.halted_reason,
      haltedAt: row.halted_at,
      lossBaseline: baseline,
    });
    logger.info(`[Halt] ${scope} halt cleared by ${actor}: ${reason.trim()}`);
    this.emit(RISK_HALT_CLEARED_EVENT, { scope, reason: reason.trim(), actor, at: new Date().toISOString() });
  }

  getState(): { global: RiskStateView | null; bots: RiskStateView[] } {
    const rows = this.deps.riskStateRepo.all();
    const global = rows.find((r) => r.scope === GLOBAL_SCOPE);
    return {
      global: global ? toRiskStateView(global) : null,
      bots: rows.filter((r) => r.scope !== GLOBAL_SCOPE).map(toRiskStateView),
    };
  }

  /** Used by KillSwitch. */
  get haltDeps(): HaltDeps {
    return this.deps;
  }
}

export { sumCancels };
