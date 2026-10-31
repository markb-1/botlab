/**
 * Ramp stages (spec §4.5) — pure transition rules, no I/O.
 *
 *   paper → probation : ≥ new_template_paper_days in paper, running on ≥ ceil(days / 2) distinct
 *                       UTC days (at least 1) in that time, no runtime
 *                       errors, not halted; blocked for a `new` template when
 *                       approvals.new_template_live is true (approval records come later)
 *   probation → full  : ≥ probation_min_fills live fills, ≥ probation_min_days, no halt since
 *                       entering probation, drawdown ≤ probation_max_drawdown_pct (unknown ⇒ wait)
 *   full → probation  : on a loss halt (see demoteOnLossHalt)
 *   retired           : terminal
 */

import type { LimitsConfig } from '../config';
import type { BotStage } from './types';

export type ScriptTrust = 'new' | 'proven';

const DAY_MS = 86_400_000;

export interface RampInput {
  stage: BotStage;
  /** When the current stage was entered (epoch ms) */
  stageSince: number;
  now: number;
  templateTrust: ScriptTrust;
  /** Distinct UTC days on which the bot was running since entering the stage (incl. that day) */
  runDaysSinceStageChange: number;
  /** Last runtime error (epoch ms) or null */
  lastErrorAt: number | null;
  halted: boolean;
  /** Last time a halt was set on the bot (epoch ms) or null */
  lastHaltedAt: number | null;
  /** Live (non-simulated) order fills since entering the stage */
  liveFillsSinceStageChange: number;
  /** Max drawdown since entering probation as a fraction of the probation allocation; null = unknown */
  drawdownPct: number | null;
}

export type RampDecision =
  | { action: 'none'; reason: string }
  | { action: 'promote'; to: BotStage; reason: string }
  | { action: 'blocked'; reason: string };

/** Stage for a new bot on a script with this trust. */
export function initialStage(trust: ScriptTrust | null | undefined): BotStage {
  return trust === 'proven' ? 'probation' : 'paper';
}

const STAGE_ORDER: Record<BotStage, number> = { paper: 0, probation: 1, full: 2, retired: -1 };

/** The less-trusted of two stages (retired stays retired). Used when a bot's script changes. */
export function lowerStage(a: BotStage, b: BotStage): BotStage {
  if (a === 'retired' || b === 'retired') return 'retired';
  return STAGE_ORDER[a] <= STAGE_ORDER[b] ? a : b;
}

/** A loss halt of a full-stage bot sends it back to probation. */
export function demoteOnLossHalt(stage: BotStage): BotStage | null {
  return stage === 'full' ? 'probation' : null;
}

/** Template trust after counting its bots that the ramp promoted to full. */
export function templateTrustAfter(trust: ScriptTrust, botsReachedFull: number): ScriptTrust {
  return trust === 'proven' || botsReachedFull >= 2 ? 'proven' : 'new';
}

export function decideRampTransition(
  input: RampInput,
  ramp: LimitsConfig['ramp'],
  approvals: LimitsConfig['approvals']
): RampDecision {
  const days = (input.now - input.stageSince) / DAY_MS;
  if (!Number.isFinite(days)) return { action: 'none', reason: 'stage start unknown' };
  if (input.halted) return { action: 'none', reason: 'bot is halted' };

  switch (input.stage) {
    case 'paper': {
      if (days < ramp.new_template_paper_days) {
        return { action: 'none', reason: `${days.toFixed(1)} of ${ramp.new_template_paper_days} paper days` };
      }
      const needDays = Math.max(1, Math.ceil(ramp.new_template_paper_days / 2));
      if (!(input.runDaysSinceStageChange >= needDays)) {
        return { action: 'none', reason: `ran on ${input.runDaysSinceStageChange} of ${needDays} required days in paper` };
      }
      if (input.lastErrorAt !== null && input.lastErrorAt >= input.stageSince) {
        return { action: 'none', reason: 'runtime error during paper stage' };
      }
      if (input.lastHaltedAt !== null && input.lastHaltedAt >= input.stageSince) {
        return { action: 'none', reason: 'halted during paper stage' };
      }
      if (approvals.new_template_live && input.templateTrust === 'new') {
        return { action: 'blocked', reason: 'approval required (approvals.new_template_live) for a new template to trade live' };
      }
      return { action: 'promote', to: 'probation', reason: `${days.toFixed(1)} days in paper without errors` };
    }
    case 'probation': {
      if (input.lastHaltedAt !== null && input.lastHaltedAt >= input.stageSince) {
        return { action: 'none', reason: 'halted during probation' };
      }
      if (input.liveFillsSinceStageChange < ramp.probation_min_fills) {
        return { action: 'none', reason: `${input.liveFillsSinceStageChange} of ${ramp.probation_min_fills} fills` };
      }
      if (days < ramp.probation_min_days) {
        return { action: 'none', reason: `${days.toFixed(1)} of ${ramp.probation_min_days} probation days` };
      }
      if (input.drawdownPct === null || !Number.isFinite(input.drawdownPct)) {
        return { action: 'none', reason: 'drawdown unknown' };
      }
      if (input.drawdownPct > ramp.probation_max_drawdown_pct) {
        return {
          action: 'none',
          reason: `drawdown ${(input.drawdownPct * 100).toFixed(1)}% > ${(ramp.probation_max_drawdown_pct * 100).toFixed(1)}%`,
        };
      }
      return {
        action: 'promote',
        to: 'full',
        reason: `${input.liveFillsSinceStageChange} fills, ${days.toFixed(1)} days, drawdown ${(input.drawdownPct * 100).toFixed(1)}%`,
      };
    }
    default:
      return { action: 'none', reason: `no automatic transition from ${input.stage}` };
  }
}
