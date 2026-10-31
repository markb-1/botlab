/**
 * RiskService — halt state per bot, clearing halts, kill switch (moved out of the Electron
 * `riskHandlers`, spec §4.2, §4.3, §4.6). Clearing a halt is human-only (HaltService refuses other
 * actors); transports must only pass `human` for callers authenticated as the human admin.
 */

import type { HaltService } from '../risk/HaltService';
import type { KillSwitch } from '../risk/KillSwitch';
import type { BotRepository } from '../db/repositories/BotRepository';
import { auditActorOf, requireActor, type Actor, type HumanActor } from './actors';

export class RiskService {
  constructor(private deps: { halts: HaltService; killSwitch: KillSwitch; botRepo: BotRepository }) {}

  /** Global halt plus every bot's halt flag and day P&L */
  getState() {
    const state = this.deps.halts.getState();
    const byScope = new Map(state.bots.map((b) => [b.scope, b]));
    const bots = this.deps.botRepo.findAll().map((bot) => {
      const s = byScope.get(bot.id);
      return {
        botId: bot.id,
        name: bot.name,
        stage: bot.stage,
        mode: bot.mode,
        status: bot.status,
        halted: s?.halted ?? false,
        haltReason: s?.reason ?? null,
        haltedAt: s?.haltedAt ?? null,
        dayRealizedPnl: s?.dayRealizedPnl ?? 0,
        dayUnrealizedPnl: s?.dayUnrealizedPnl ?? 0,
        dayStartEquity: s?.dayStartEquity ?? null,
        updatedAt: s?.updatedAt ?? null,
      };
    });
    return { global: state.global, bots };
  }

  /** `scope` is 'global' or a bot id. Human only (HaltService re-checks and audits a denial). */
  clearHalt(scope: string, reason: string, actor: HumanActor): void {
    this.deps.halts.clearHalt(scope, reason, actor);
  }

  /**
   * Global halt + cancel every open order + stop every bot. Anyone may press it (human, agent or
   * system), but only as an authenticated actor, which is recorded in the audit log.
   */
  async killSwitch(reason: unknown, by: Actor) {
    const actor = auditActorOf(requireActor(by, ['human', 'agent', 'system'], 'risk.killSwitch'));
    const result = await this.deps.killSwitch.activate(typeof reason === 'string' && reason.trim() ? reason : 'manual kill switch', actor);
    return {
      stopped: result.stopped,
      cancelled: result.cancelled,
      failed: result.failed,
      unknownOutcome: result.unknownOutcome,
      errors: result.errors,
    };
  }
}
