/**
 * Kill switch (spec §4.3): global halt → cancel all open orders of every bot (running or not,
 * loaded from the `orders` table) → stop all bot workers → cancel again for orders that were in
 * flight → audit + `risk:halt` event. Positions are NOT liquidated.
 *
 * Also used for the global daily loss limit (§4.2: global halt = kill switch).
 * Activating while already halted still cancels and stops everything.
 */

import { GLOBAL_SCOPE } from '../database/repositories/RiskStateRepository';
import type { AuditActor } from '../audit/AuditService';
import type { BotCancelResult } from '../orders/OrderCanceller';
import { RISK_HALT_EVENT, sumCancels, type HaltService, type RiskHaltEvent } from './HaltService';
import logger from '../../src/utils/logger';

export interface KillSwitchResult {
  stopped: string[];
  cancels: BotCancelResult[];
  cancelled: number;
  failed: number;
  unknownOutcome: number;
  errors: string[];
}

export class KillSwitch {
  private inFlight: Promise<KillSwitchResult> | null = null;

  constructor(private halts: HaltService) {}

  activate(reason: string, actor: AuditActor): Promise<KillSwitchResult> {
    if (typeof reason !== 'string' || reason.trim().length === 0) reason = 'kill switch';
    // A second activation while one runs joins it (its halt flag is already set)
    if (this.inFlight) {
      this.halts.haltDeps.audit.record(actor, 'risk.kill_switch', GLOBAL_SCOPE, { reason }, 'joined running activation');
      return this.inFlight;
    }
    this.inFlight = this.run(reason.trim(), actor).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(reason: string, actor: AuditActor): Promise<KillSwitchResult> {
    const { riskStateRepo, audit, canceller, bots } = this.halts.haltDeps;

    // 1. Block every new order first (RiskEngine step 1)
    riskStateRepo.setHalted(GLOBAL_SCOPE, true, reason);
    audit.record(actor, 'risk.kill_switch', GLOBAL_SCOPE, { reason });
    logger.error(`[KillSwitch] Activated by ${actor}: ${reason}`);

    // 2. Cancel all open orders of all bots
    const cancels: BotCancelResult[] = await canceller.cancelAllBots();

    // 3. Stop every bot worker
    const running = bots.runningBotIds();
    const stopped: string[] = [];
    await Promise.all(
      running.map(async (id) => {
        try {
          await bots.stopBot(id, 'system');
          stopped.push(id);
        } catch (err) {
          logger.error(`[KillSwitch] Could not stop bot ${id}: ${err instanceof Error ? err.message : err}`);
        }
      })
    );

    // 4. Orders that landed while we were cancelling/stopping
    cancels.push(...(await canceller.cancelAllBots()));

    const summary = sumCancels(cancels);
    const result: KillSwitchResult = { stopped, cancels, ...summary };
    audit.record(
      'system',
      'risk.kill_switch.done',
      GLOBAL_SCOPE,
      { stopped, ...summary },
      summary.failed > 0 || summary.errors.length > 0 || stopped.length < running.length ? 'partial' : 'ok'
    );
    this.halts.emit(RISK_HALT_EVENT, {
      scope: GLOBAL_SCOPE,
      kind: 'kill_switch',
      reason,
      actor,
      at: new Date().toISOString(),
      cancels,
    } satisfies RiskHaltEvent);
    return result;
  }
}
