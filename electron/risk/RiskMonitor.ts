/**
 * RiskMonitor (spec §4.2, §4.5) — runs every 60 s in the main process.
 *
 * Each run:
 * 1. Daily P&L per bot (live and paper fills separately) and global (all live fills), via the
 *    pure `computeDailyPnl`. Marks are order-book mids (`getMark`); a symbol without a fresh mid
 *    uses its last known mark and is reported (log + audit when the stale set changes).
 * 2. At the first run of a UTC day the day-start marks are captured into risk_state (global row).
 *    The daily reset never clears a halt.
 * 3. Bot daily loss ≥ per_bot_defaults.daily_loss_limit_usd ⇒ bot halt (loss halt: full ⇒ probation).
 *    Global daily loss (live) ≥ global.daily_loss_limit_usd ⇒ kill switch.
 * 4. Probation drawdown tracking and the ramp promotion job.
 *
 * A run that throws is audited; 5 consecutive failed runs trigger the kill switch (losses can no
 * longer be watched).
 */

import type { LimitsConfig } from '../config';
import type { BotRepository, BotRow } from '../database/repositories/BotRepository';
import type { ScriptRepository } from '../database/repositories/ScriptRepository';
import type { BotTradeRepository, PnlFillRow } from '../database/repositories/BotTradeRepository';
import { GLOBAL_SCOPE, type RiskStateRepository, type RiskStateRow } from '../database/repositories/RiskStateRepository';
import type { AuditService } from '../audit/AuditService';
import { parseDbTime } from '../orders/DbRiskStateProvider';
import { computeDailyPnl, markKey, utcDayStart, type DailyPnlResult, type PnlFill } from './dailyPnl';
import { decideRampTransition, templateTrustAfter, type ScriptTrust } from './ramp';
import type { HaltService } from './HaltService';
import type { KillSwitch } from './KillSwitch';
import type { BotStage } from './types';
import logger from '../../src/utils/logger';

export const RISK_MONITOR_INTERVAL_MS = 60_000;
const MARK_TIMEOUT_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const QTY_EPS = 1e-9;

export interface RiskMonitorDeps {
  botRepo: Pick<BotRepository, 'findAll' | 'setStage' | 'countReachedFull' | 'countRunDays'>;
  scriptRepo: Pick<ScriptRepository, 'findById' | 'setTrust'>;
  tradeRepo: Pick<BotTradeRepository, 'findPnlFills'>;
  riskStateRepo: RiskStateRepository;
  audit: AuditService;
  halts: Pick<HaltService, 'haltBot'>;
  killSwitch: Pick<KillSwitch, 'activate'>;
  /** Current limits; null when the config failed to load (limits are then not enforced here, and no bot can start) */
  getLimits: () => LimitsConfig | null;
  /** Order-book mid for a symbol; null/throw = unavailable */
  getMark: (exchange: string, symbol: string) => Promise<number | null>;
  now?: () => number;
}

export interface ScopePnl {
  scope: string;
  simulated: boolean;
  result: DailyPnlResult;
}

export interface RiskMonitorRunResult {
  dayStart: string;
  newDay: boolean;
  bots: ScopePnl[];
  global: { totalPnl: number; realizedPnl: number; unrealizedChange: number };
  staleMarks: string[];
  halted: string[];
  killSwitch: boolean;
  promotions: Array<{ botId: string; from: BotStage; to: BotStage }>;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

const toPnlFill = (r: PnlFillRow): PnlFill => ({
  exchange: r.exchange,
  symbol: r.symbol,
  side: r.side,
  quantity: r.quantity ?? 0,
  quoteAmount: r.quote_amount ?? 0,
  feeUsd: r.fee_usd ?? 0,
  executedAt: parseDbTime(r.executed_at),
});

const usd = (n: number) => n.toFixed(2);

/** Bot runs paper orders: paper stage (regardless of mode) or paper mode. */
export function runsInPaper(bot: Pick<BotRow, 'stage' | 'mode'>): boolean {
  return bot.stage === 'paper' || bot.mode === 'paper';
}

export class RiskMonitor {
  private deps: RiskMonitorDeps;
  private now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private lastStaleReport = '';
  private lastFailureMessage = '';
  /** "botId:reason" already audited as blocked (once per process) */
  private blockedReported = new Set<string>();

  constructor(deps: RiskMonitorDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(intervalMs = RISK_MONITOR_INTERVAL_MS): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  /** Stop the timer and wait for a run in progress. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  private tick(): void {
    if (this.running) return; // previous run still going
    this.running = this.runSafe().finally(() => {
      this.running = null;
    });
  }

  private async runSafe(): Promise<void> {
    try {
      await this.runOnce();
      this.consecutiveFailures = 0;
      this.lastFailureMessage = '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.consecutiveFailures++;
      logger.error(`[RiskMonitor] Run failed (${this.consecutiveFailures} in a row): ${msg}`);
      if (msg !== this.lastFailureMessage) {
        this.deps.audit.record('system', 'risk.monitor_error', null, { error: msg, consecutive: this.consecutiveFailures });
        this.lastFailureMessage = msg;
      }
      if (this.consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
        await this.deps.killSwitch
          .activate(`risk monitor failed ${MAX_CONSECUTIVE_FAILURES} times in a row: ${msg}`, 'system')
          .catch((e) => logger.error(`[RiskMonitor] Kill switch failed: ${e}`));
      }
    }
  }

  async runOnce(): Promise<RiskMonitorRunResult> {
    const { riskStateRepo, audit } = this.deps;
    const now = this.now();
    const limits = this.deps.getLimits();
    const dayStartMs = utcDayStart(now);
    const dayStart = new Date(dayStartMs).toISOString();

    const bots = this.deps.botRepo.findAll();
    const fillRows = this.deps.tradeRepo.findPnlFills();

    // Group fills by bot and mode; collect symbols held now or at the day start
    const groups = new Map<string, { botId: string; simulated: boolean; fills: PnlFill[] }>();
    const net = new Map<string, { now: number; start: number }>();
    for (const row of fillRows) {
      const f = toPnlFill(row);
      const simulated = row.simulated === 1;
      const g = `${row.bot_id}|${simulated ? 1 : 0}`;
      if (!groups.has(g)) groups.set(g, { botId: row.bot_id, simulated, fills: [] });
      groups.get(g)!.fills.push(f);

      const k = `${g}|${markKey(f.exchange, f.symbol)}`;
      const n = net.get(k) ?? { now: 0, start: 0 };
      const q = f.side === 'BUY' ? f.quantity : -f.quantity;
      n.now = Math.max(0, n.now + q);
      if (f.executedAt < dayStartMs) n.start = n.now;
      net.set(k, n);
    }
    const heldKeys = new Set<string>();
    const heldAtStart = new Set<string>();
    for (const [k, n] of net) {
      const key = k.split('|').slice(2).join('|');
      if (n.now > QTY_EPS || n.start > QTY_EPS) heldKeys.add(key);
      if (n.start > QTY_EPS) heldAtStart.add(key);
    }

    // Current marks
    const currentMarks: Record<string, number | null> = {};
    const markErrors: Record<string, string> = {};
    await Promise.all(
      [...heldKeys].map(async (key) => {
        const i = key.indexOf(':');
        const exchange = key.slice(0, i);
        const symbol = key.slice(i + 1);
        try {
          const m = await withTimeout(this.deps.getMark(exchange, symbol), MARK_TIMEOUT_MS);
          currentMarks[key] = typeof m === 'number' && Number.isFinite(m) && m >= 0 ? m : null;
          if (currentMarks[key] === null) markErrors[key] = 'no price';
        } catch (err) {
          currentMarks[key] = null;
          markErrors[key] = err instanceof Error ? err.message : String(err);
        }
      })
    );

    // Day-start marks and last known marks (global row)
    const globalRow = riskStateRepo.getGlobal();
    const lastMarksStored = parseJson<Record<string, { price: number; at: string }>>(globalRow?.last_marks ?? null, {});
    const lastKnown: Record<string, number> = {};
    for (const [k, v] of Object.entries(lastMarksStored)) if (v && Number.isFinite(v.price)) lastKnown[k] = v.price;

    const newDay = globalRow?.day_start !== dayStart;
    let dayStartMarks = parseJson<Record<string, number>>(globalRow?.day_start_marks ?? null, {});
    if (newDay) {
      dayStartMarks = {};
      const missing: string[] = [];
      for (const key of heldAtStart) {
        const m = currentMarks[key] ?? lastKnown[key];
        if (typeof m === 'number') dayStartMarks[key] = m;
        else missing.push(key);
      }
      riskStateRepo.setMarks({ dayStart, dayStartMarks });
      audit.record('system', 'risk.day_reset', GLOBAL_SCOPE, { dayStart, marks: Object.keys(dayStartMarks).length, missing });
      logger.info(`[RiskMonitor] New UTC day ${dayStart}: captured ${Object.keys(dayStartMarks).length} day-start marks`);
    }

    const updatedLast = { ...lastMarksStored };
    const nowIso = new Date(now).toISOString();
    for (const [k, m] of Object.entries(currentMarks)) if (typeof m === 'number') updatedLast[k] = { price: m, at: nowIso };
    riskStateRepo.setMarks({ lastMarks: updatedLast });

    // P&L per bot and mode
    const compute = (fills: PnlFill[]) =>
      computeDailyPnl({ fills, dayStartMs, dayStartMarks, currentMarks, lastKnownMarks: lastKnown });
    const results: ScopePnl[] = [];
    for (const g of groups.values()) results.push({ scope: g.botId, simulated: g.simulated, result: compute(g.fills) });

    const stale = new Set<string>();
    for (const r of results) for (const k of r.result.staleMarks) stale.add(k);
    const staleList = [...stale].sort();
    const staleReport = staleList.join(',');
    if (staleList.length > 0) {
      logger.warning(
        `[RiskMonitor] No fresh price for ${staleList.join(', ')}; using last known marks (${staleList
          .map((k) => `${k}: ${markErrors[k] ?? 'n/a'}`)
          .join('; ')})`
      );
    }
    if (staleReport !== this.lastStaleReport) {
      if (staleList.length > 0) {
        audit.record('system', 'risk.marks_stale', null, { symbols: staleList, errors: markErrors }, 'warning');
      } else if (this.lastStaleReport) {
        audit.record('system', 'risk.marks_recovered', null, {});
      }
      this.lastStaleReport = staleReport;
    }

    const stateByScope = new Map<string, RiskStateRow>(riskStateRepo.all().map((r) => [r.scope, r]));
    const empty: DailyPnlResult = {
      realizedPnl: 0,
      unrealizedChange: 0,
      totalPnl: 0,
      dayStartValue: 0,
      cumulativePnl: 0,
      positions: [],
      staleMarks: [],
    };
    const pnlFor = (botId: string, simulated: boolean) =>
      results.find((r) => r.scope === botId && r.simulated === simulated)?.result ?? empty;

    const halted: string[] = [];
    for (const bot of bots) {
      const live = pnlFor(bot.id, false);
      const paper = pnlFor(bot.id, true);
      const shown = runsInPaper(bot) ? paper : live;
      riskStateRepo.updateDaily(bot.id, {
        dayStartEquity: shown.dayStartValue,
        dayRealizedPnl: shown.realizedPnl,
        dayUnrealizedPnl: shown.unrealizedChange,
        dayLivePnl: live.totalPnl,
        dayPaperPnl: paper.totalPnl,
      });

      this.trackDrawdown(bot, live, stateByScope.get(bot.id));

      if (!limits) continue;
      const limit = limits.per_bot_defaults.daily_loss_limit_usd;
      const baseline = riskStateRepo.getLossBaseline(bot.id);
      for (const [mode, r] of [['live', live], ['paper', paper]] as const) {
        // After a human cleared a halt today, the loss counts from the P&L at that moment
        const base = baseline?.day === dayStart ? baseline[mode] : 0;
        const loss = -(r.totalPnl - base);
        if (loss > 0 && loss >= limit && !riskStateRepo.isHalted(bot.id)) {
          const since = base !== 0 ? ` since the halt was cleared at ${baseline!.at}` : '';
          const reason = `daily loss limit: ${mode} loss ${usd(loss)} USD${since} ≥ ${usd(limit)} USD`;
          await this.deps.halts.haltBot(bot.id, reason, 'system', { lossHalt: true });
          halted.push(bot.id);
        }
      }
    }

    // Global: every live fill (including bots deleted since)
    const liveResults = results.filter((r) => !r.simulated).map((r) => r.result);
    const global = {
      totalPnl: liveResults.reduce((s, r) => s + r.totalPnl, 0),
      realizedPnl: liveResults.reduce((s, r) => s + r.realizedPnl, 0),
      unrealizedChange: liveResults.reduce((s, r) => s + r.unrealizedChange, 0),
    };
    riskStateRepo.updateDaily(GLOBAL_SCOPE, {
      dayStartEquity: liveResults.reduce((s, r) => s + r.dayStartValue, 0),
      dayRealizedPnl: global.realizedPnl,
      dayUnrealizedPnl: global.unrealizedChange,
      dayLivePnl: global.totalPnl,
    });

    let killSwitch = false;
    if (limits) {
      const baseline = riskStateRepo.getLossBaseline(GLOBAL_SCOPE);
      const loss = -(global.totalPnl - (baseline?.day === dayStart ? baseline.live : 0));
      const limit = limits.global.daily_loss_limit_usd;
      if (loss > 0 && loss >= limit && !riskStateRepo.isHalted(GLOBAL_SCOPE)) {
        await this.deps.killSwitch.activate(`global daily loss limit: loss ${usd(loss)} USD ≥ ${usd(limit)} USD`, 'system');
        killSwitch = true;
      }
    }

    const promotions = limits && !riskStateRepo.isHalted(GLOBAL_SCOPE) ? this.runRamp(fillRows, limits, now) : [];

    return { dayStart, newDay, bots: results, global, staleMarks: staleList, halted, killSwitch, promotions };
  }

  /** Probation: peak cumulative live P&L and worst drop from it since entering probation. */
  private trackDrawdown(bot: BotRow, live: DailyPnlResult, state: RiskStateRow | undefined): void {
    if (bot.stage !== 'probation') return;
    const since = bot.stage_changed_at ?? bot.created_at;
    const cum = live.cumulativePnl;
    if (!Number.isFinite(cum)) return;
    if (!state || state.ramp_since !== since || state.ramp_pnl_peak === null) {
      this.deps.riskStateRepo.setRampTracking(bot.id, { since, peak: cum, maxDrawdownUsd: 0 });
      return;
    }
    const peak = Math.max(state.ramp_pnl_peak, cum);
    const dd = Math.max(state.ramp_max_drawdown_usd ?? 0, peak - cum);
    this.deps.riskStateRepo.setRampTracking(bot.id, { since, peak, maxDrawdownUsd: dd });
  }

  private runRamp(fillRows: PnlFillRow[], limits: LimitsConfig, now: number): RiskMonitorRunResult['promotions'] {
    const { botRepo, scriptRepo, riskStateRepo, audit } = this.deps;
    const promotions: RiskMonitorRunResult['promotions'] = [];
    const states = new Map<string, RiskStateRow>(riskStateRepo.all().map((r) => [r.scope, r]));

    for (const bot of botRepo.findAll()) {
      const stage = bot.stage as BotStage;
      if (stage !== 'paper' && stage !== 'probation') continue;
      const script = scriptRepo.findById(bot.script_id);
      const trust: ScriptTrust = script?.trust === 'proven' ? 'proven' : 'new';
      const since = bot.stage_changed_at ?? bot.created_at;
      const stageSince = parseDbTime(since);
      const state = states.get(bot.id);

      let drawdownPct: number | null = null;
      if (stage === 'probation' && state?.ramp_since === since && state.ramp_max_drawdown_usd !== null) {
        const configured = trust === 'new' ? limits.ramp.new_template_probation_allocation_usd : limits.ramp.probation_allocation_usd;
        const allocation = bot.allocation_usd != null ? Math.min(bot.allocation_usd, configured) : configured;
        const dd = state.ramp_max_drawdown_usd;
        drawdownPct = allocation > 0 ? dd / allocation : dd > 0 ? Infinity : 0;
      }
      const liveFills = fillRows.filter(
        (f) => f.bot_id === bot.id && f.simulated !== 1 && parseDbTime(f.executed_at) >= stageSince
      ).length;
      const runDays = this.deps.botRepo.countRunDays(bot.id, new Date(utcDayStart(stageSince)).toISOString().slice(0, 10));

      const decision = decideRampTransition(
        {
          stage,
          stageSince,
          now,
          templateTrust: trust,
          runDaysSinceStageChange: runDays,
          lastErrorAt: bot.last_error_at ? parseDbTime(bot.last_error_at) : null,
          halted: state?.halted === 1,
          lastHaltedAt: state?.last_halted_at ? parseDbTime(state.last_halted_at) : null,
          liveFillsSinceStageChange: liveFills,
          drawdownPct,
        },
        limits.ramp,
        limits.approvals
      );

      if (decision.action === 'blocked') {
        const key = `${bot.id}:${decision.reason}`;
        if (!this.blockedReported.has(key)) {
          this.blockedReported.add(key);
          audit.record('system', 'bot.stage_blocked', bot.id, { stage, reason: decision.reason });
          logger.info(`[Ramp] Bot ${bot.name}: promotion blocked: ${decision.reason}`);
        }
        continue;
      }
      if (decision.action !== 'promote') continue;

      botRepo.setStage(bot.id, decision.to, { reachedFull: decision.to === 'full' });
      audit.record('system', 'bot.stage', bot.id, { from: stage, to: decision.to, reason: decision.reason });
      promotions.push({ botId: bot.id, from: stage, to: decision.to });
      logger.info(
        `[Ramp] Bot ${bot.name} promoted ${stage} → ${decision.to}: ${decision.reason}` +
          (stage === 'paper' && bot.status === 'running' ? ' (still running in paper until restarted)' : '')
      );

      if (decision.to === 'full' && script && script.trust !== 'proven' && bot.template_version === script.revision) {
        const reached = botRepo.countReachedFull(script.id, script.revision);
        if (templateTrustAfter(trust, reached) === 'proven') {
          scriptRepo.setTrust(script.id, 'proven');
          audit.record('system', 'script.trust', script.id, { from: 'new', to: 'proven', revision: script.revision, botsReachedFull: reached });
          logger.info(`[Ramp] Template ${script.name} r${script.revision} is now proven (${reached} bots reached full)`);
        }
      }
    }
    return promotions;
  }
}
