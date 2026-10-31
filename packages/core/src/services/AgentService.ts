/**
 * AgentService — agent runs, memory, budget and exit flags (spec §2.2 agent_runs / agent_notes, §7.1, §7.3).
 * Transport-free: the MCP server (apps/server/src/mcp) and the HTTP API call it with an actor.
 *
 * Budget and limits (limits.yaml `agent:`, human-owned; enforced here, not in the MCP layer):
 * - `start_run` is refused while this month's run costs (UTC month) ≥ `monthly_llm_budget_usd`, or the
 *   limits cannot be read (fail closed).
 * - One run at a time; a run open for more than 30 minutes is closed as `timeout` when the next one starts
 *   (or on the next tool call).
 * - Tool calls during an open run are counted; beyond `max_tool_calls_per_run` every tool except
 *   `finish_run` and `kill_switch` is refused. Calls outside a run (interactive use) are not counted but
 *   are still audited by the transport.
 * - `max_run_cost_usd` is reported to the runner (4b), which stops a run above it; `finish_run` records
 *   the cost and flags an overrun.
 */

import type {
  AgentNoteRepository,
  AgentNoteRow,
  AgentRunAction,
  AgentRunRepository,
  AgentRunRow,
  AgentRunTrigger,
  PositionExitFlagRepository,
  PositionExitFlagRow,
} from '../db/repositories/AgentRepository';
import type { BotRepository } from '../db/repositories/BotRepository';
import type { BotTradeRepository } from '../db/repositories/BotTradeRepository';
import type { AuditService } from '../audit/AuditService';
import type { LimitsConfig } from '../config/schema';
import { auditActorOf, requireActor, type Actor } from './actors';
import { conflict, invalidInput, notFound, ServiceError } from './errors';

/** A run open longer than this is closed as `timeout` (spec §7.1: runs over 30 min are cancelled) */
export const RUN_TIMEOUT_MS = 30 * 60_000;
/** Tools still allowed after the per-run tool-call cap */
export const TOOLS_EXEMPT_FROM_CAP = new Set(['finish_run', 'kill_switch']);
export const MAX_NOTES = 2000;
export const MAX_NOTE_BODY_CHARS = 20_000;
export const MAX_SUMMARY_CHARS = 20_000;

const NOTE_SCOPE_RE = /^(general|market:[0-9A-Za-z_-]{1,100}|category:[a-z0-9_-]{1,60}|strategy:[a-z0-9_-]{1,60})$/;

export interface AgentRunView {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: AgentRunTrigger;
  status: AgentRunRow['status'];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  summaryMd: string | null;
  toolCalls: number;
  actions: AgentRunAction[];
}

export interface AgentNoteView {
  id: string;
  scope: string;
  title: string;
  bodyMd: string;
  createdAt: string;
  updatedAt: string;
}

export interface PositionExitFlagView {
  id: string;
  botId: string;
  botName: string | null;
  tokenId: string;
  marketId: string | null;
  simulated: boolean;
  reason: string;
  status: PositionExitFlagRow['status'];
  createdBy: string;
  createdAt: string;
  handledAt: string | null;
  handledNote: string | null;
}

export interface AgentBudgetView {
  /** UTC month, YYYY-MM */
  month: string;
  monthSpentUsd: number;
  monthlyBudgetUsd: number | null;
  remainingUsd: number | null;
  maxRunCostUsd: number | null;
  maxToolCallsPerRun: number | null;
  runsThisMonth: number;
  botsCreatedLast24h: number;
  maxBotsCreatedPerDay: number | null;
  activeAgentBots: number;
  maxActiveBots: number | null;
  currentRun: AgentRunView | null;
  limitsError: string | null;
}

export interface AgentServiceDeps {
  runRepo: AgentRunRepository;
  noteRepo: AgentNoteRepository;
  flagRepo: PositionExitFlagRepository;
  botRepo: Pick<BotRepository, 'findById' | 'countCreatedSince' | 'countActiveCreatedBy'>;
  tradeRepo: Pick<BotTradeRepository, 'getRiskPositions'>;
  audit?: Pick<AuditService, 'record'>;
  getLimits: () => LimitsConfig | null;
  /** Telegram: run summary (spec §7.2 step 7, §11) and exit flags */
  notify?: {
    agentRunFinished(run: AgentRunView, overBudget: boolean): void;
    positionExitFlagged(flag: PositionExitFlagView): void;
  };
  now?: () => number;
}

function runView(r: AgentRunRow): AgentRunView {
  let actions: AgentRunAction[] = [];
  try {
    const v = JSON.parse(r.actions) as unknown;
    if (Array.isArray(v)) actions = v as AgentRunAction[];
  } catch {
    /* empty */
  }
  return {
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    trigger: r.trigger,
    status: r.status,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    costUsd: r.cost_usd,
    summaryMd: r.summary_md,
    toolCalls: r.tool_calls,
    actions,
  };
}

function noteView(n: AgentNoteRow): AgentNoteView {
  return { id: n.id, scope: n.scope, title: n.title, bodyMd: n.body_md, createdAt: n.created_at, updatedAt: n.updated_at };
}

const nonNegative = (v: unknown, what: string): number => {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw invalidInput(`${what} must be a non-negative number`);
  return v;
};

export class AgentService {
  private now: () => number;

  constructor(private deps: AgentServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  private monthStart(): { month: string; startIso: string } {
    const d = new Date(this.now());
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    return { month: start.toISOString().slice(0, 7), startIso: start.toISOString() };
  }

  // ── Runs ─────────────────────────────────────────────────────────

  /** The open run; one older than RUN_TIMEOUT_MS is closed as `timeout` first */
  currentRun(): AgentRunView | null {
    const row = this.deps.runRepo.findRunning();
    if (!row) return null;
    if (this.now() - Date.parse(row.started_at) > RUN_TIMEOUT_MS) {
      this.deps.runRepo.finish(row.id, {
        status: 'timeout',
        finishedAt: this.iso(),
        summaryMd: row.summary_md ?? '(run exceeded 30 minutes; closed by the server)',
      });
      this.deps.audit?.record('system', 'agent.run_timeout', row.id, { startedAt: row.started_at, toolCalls: row.tool_calls });
      return null;
    }
    return runView(row);
  }

  budget(): AgentBudgetView {
    const limits = this.deps.getLimits();
    const { month, startIso } = this.monthStart();
    const spent = this.deps.runRepo.costSince(startIso);
    const a = limits?.agent ?? null;
    return {
      month,
      monthSpentUsd: Math.round(spent * 10_000) / 10_000,
      monthlyBudgetUsd: a?.monthly_llm_budget_usd ?? null,
      remainingUsd: a ? Math.max(0, a.monthly_llm_budget_usd - spent) : null,
      maxRunCostUsd: a?.max_run_cost_usd ?? null,
      maxToolCallsPerRun: a?.max_tool_calls_per_run ?? null,
      runsThisMonth: this.deps.runRepo.countSince(startIso),
      botsCreatedLast24h: this.deps.botRepo.countCreatedSince('agent', this.iso(this.now() - 86_400_000)),
      maxBotsCreatedPerDay: a?.max_bots_created_per_day ?? null,
      activeAgentBots: this.deps.botRepo.countActiveCreatedBy('agent'),
      maxActiveBots: a?.max_active_bots ?? null,
      currentRun: this.currentRun(),
      limitsError: limits ? null : 'limits unavailable (config invalid)',
    };
  }

  /** Start a run (agent, or the runner / UI in 4b). Refused over the monthly budget or while another run is open. */
  startRun(input: { trigger?: unknown }, by: Actor): { run: AgentRunView; budget: AgentBudgetView; lastRun: AgentRunView | null } {
    const who = requireActor(by, ['agent', 'human', 'system'], 'agent.startRun');
    const actor = auditActorOf(who);
    const trigger = input.trigger ?? 'manual';
    if (trigger !== 'manual' && trigger !== 'schedule' && trigger !== 'event') throw invalidInput('trigger must be manual, schedule or event');
    const limits = this.deps.getLimits();
    if (!limits) {
      this.deps.audit?.record(actor, 'agent.run_start', null, { trigger }, 'denied: limits unavailable');
      throw new ServiceError('conflict', 'Cannot start a run: limits unavailable (config invalid)');
    }
    const { startIso } = this.monthStart();
    const spent = this.deps.runRepo.costSince(startIso);
    if (spent >= limits.agent.monthly_llm_budget_usd) {
      this.deps.audit?.record(actor, 'agent.run_start', null, { trigger, spent, budget: limits.agent.monthly_llm_budget_usd }, 'denied: monthly budget used');
      throw new ServiceError(
        'forbidden',
        `Monthly LLM budget used: $${spent.toFixed(2)} of $${limits.agent.monthly_llm_budget_usd.toFixed(2)} (agent.monthly_llm_budget_usd); no runs until next month`
      );
    }
    const open = this.currentRun();
    if (open) throw conflict(`Run ${open.id} is in progress (started ${open.startedAt}); finish it first`);
    const lastRow = this.deps.runRepo.list(1)[0];
    const row = this.deps.runRepo.create({ trigger, principal: who.principal, startedAt: this.iso() });
    this.deps.audit?.record(actor, 'agent.run_start', row.id, { trigger });
    return { run: runView(row), budget: this.budget(), lastRun: lastRow ? runView(lastRow) : null };
  }

  /** Close the open run with the summary (spec §7.2 step 7); sends the Telegram run report */
  finishRun(
    input: { runId?: unknown; summaryMd: unknown; status?: unknown; tokensIn?: unknown; tokensOut?: unknown; costUsd?: unknown },
    by: Actor
  ): AgentRunView {
    const who = requireActor(by, ['agent', 'human', 'system'], 'agent.finishRun');
    const actor = auditActorOf(who);
    const summary = typeof input.summaryMd === 'string' ? input.summaryMd.trim() : '';
    if (!summary) throw invalidInput('summary_md is required');
    if (summary.length > MAX_SUMMARY_CHARS) throw invalidInput(`summary_md must be at most ${MAX_SUMMARY_CHARS} characters`);
    const status = input.status ?? 'ok';
    if (status !== 'ok' && status !== 'error' && status !== 'aborted') throw invalidInput('status must be ok, error or aborted');
    const tokensIn = Math.floor(nonNegative(input.tokensIn, 'tokens_in'));
    const tokensOut = Math.floor(nonNegative(input.tokensOut, 'tokens_out'));
    const costUsd = nonNegative(input.costUsd, 'cost_usd');
    const row = typeof input.runId === 'string' && input.runId ? this.deps.runRepo.findById(input.runId) : this.deps.runRepo.findRunning();
    if (!row) throw notFound(typeof input.runId === 'string' && input.runId ? 'Run not found' : 'No run in progress (call start_run first)');
    if (row.status !== 'running') throw conflict(`Run ${row.id} is already ${row.status}`);
    const done = this.deps.runRepo.finish(row.id, { status, finishedAt: this.iso(), summaryMd: summary, tokensIn, tokensOut, costUsd })!;
    const view = runView(done);
    const maxCost = this.deps.getLimits()?.agent.max_run_cost_usd ?? null;
    const overBudget = maxCost !== null && view.costUsd > maxCost;
    this.deps.audit?.record(actor, 'agent.run_finish', row.id, {
      status,
      tokensIn,
      tokensOut,
      costUsd: view.costUsd,
      toolCalls: view.toolCalls,
      ...(overBudget ? { overRunBudget: maxCost } : {}),
    });
    try {
      this.deps.notify?.agentRunFinished(view, overBudget);
    } catch {
      /* notifications never fail the call */
    }
    return view;
  }

  /**
   * Before a tool call (transport hook): refuses beyond `max_tool_calls_per_run` within the open run.
   * Returns the open run id (or null when no run is open).
   */
  beforeToolCall(tool: string): string | null {
    const run = this.currentRun();
    if (!run) return null;
    const max = this.deps.getLimits()?.agent.max_tool_calls_per_run ?? 0;
    if (!TOOLS_EXEMPT_FROM_CAP.has(tool) && run.toolCalls >= max) {
      throw new ServiceError('conflict', `Tool-call limit for this run reached (${run.toolCalls} of agent.max_tool_calls_per_run = ${max}); call finish_run`);
    }
    return run.id;
  }

  /** After a tool call: counted on the run and kept in its actions (bounded) */
  afterToolCall(runId: string | null, action: { tool: string; ok: boolean; target?: string | null }): void {
    if (!runId) return;
    this.deps.runRepo.recordAction(runId, { tool: action.tool, at: this.iso(), ok: action.ok, ...(action.target ? { target: action.target } : {}) });
  }

  listRuns(limit?: number, before?: string): AgentRunView[] {
    this.currentRun(); // close a timed-out run first
    return this.deps.runRepo.list(limit ?? 50, before).map(runView);
  }

  getRun(id: string): AgentRunView {
    const r = this.deps.runRepo.findById(id);
    if (!r) throw notFound('Run not found');
    return runView(r);
  }

  // ── Notes (memory) ───────────────────────────────────────────────

  listNotes(filter: { scope?: unknown; query?: unknown; limit?: unknown } = {}): AgentNoteView[] {
    const scope = typeof filter.scope === 'string' && filter.scope ? filter.scope.slice(0, 120) : undefined;
    const query = typeof filter.query === 'string' && filter.query.trim() ? filter.query.trim().slice(0, 200) : undefined;
    const limit = typeof filter.limit === 'number' ? filter.limit : 100;
    return this.deps.noteRepo.list({ scope, query, limit }).map(noteView);
  }

  getNote(id: string): AgentNoteView {
    const n = this.deps.noteRepo.findById(id);
    if (!n) throw notFound('Note not found');
    return noteView(n);
  }

  /** Create, or replace by id. Scope: general | market:<conditionId> | category:<c> | strategy:<key> */
  writeNote(input: { id?: unknown; scope: unknown; title: unknown; bodyMd: unknown }, by: Actor): AgentNoteView {
    const actor = auditActorOf(requireActor(by, ['agent', 'human'], 'agent.writeNote'));
    const scope = typeof input.scope === 'string' ? input.scope.trim() : '';
    if (!NOTE_SCOPE_RE.test(scope)) throw invalidInput('scope must be general, market:<conditionId>, category:<category> or strategy:<key>');
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > 200) throw invalidInput('title is required (at most 200 characters)');
    const body = typeof input.bodyMd === 'string' ? input.bodyMd : '';
    if (!body.trim() || body.length > MAX_NOTE_BODY_CHARS) throw invalidInput(`body_md is required (at most ${MAX_NOTE_BODY_CHARS} characters)`);
    const at = this.iso();
    if (typeof input.id === 'string' && input.id) {
      if (!this.deps.noteRepo.findById(input.id)) throw notFound('Note not found');
      const row = this.deps.noteRepo.update(input.id, { scope, title, bodyMd: body, at })!;
      this.deps.audit?.record(actor, 'agent.note_update', row.id, { scope, title, chars: body.length });
      return noteView(row);
    }
    if (this.deps.noteRepo.count() >= MAX_NOTES) throw conflict(`Too many notes (${MAX_NOTES}); delete or merge old ones first`);
    const row = this.deps.noteRepo.create({ scope, title, bodyMd: body, at });
    this.deps.audit?.record(actor, 'agent.note_create', row.id, { scope, title, chars: body.length });
    return noteView(row);
  }

  deleteNote(id: unknown, by: Actor): { deleted: boolean } {
    const actor = auditActorOf(requireActor(by, ['agent', 'human'], 'agent.deleteNote'));
    if (typeof id !== 'string' || !id) throw invalidInput('id required');
    const existing = this.deps.noteRepo.findById(id);
    if (!existing) throw notFound('Note not found');
    const deleted = this.deps.noteRepo.delete(id);
    this.deps.audit?.record(actor, 'agent.note_delete', id, { scope: existing.scope, title: existing.title });
    return { deleted };
  }

  // ── Exit flags (position manager acts on them in Phase 5) ────────

  private flagView(f: PositionExitFlagRow): PositionExitFlagView {
    return {
      id: f.id,
      botId: f.bot_id,
      botName: this.deps.botRepo.findById(f.bot_id)?.name ?? null,
      tokenId: f.token_id,
      marketId: f.market_id,
      simulated: f.simulated === 1,
      reason: f.reason,
      status: f.status,
      createdBy: f.created_by,
      createdAt: f.created_at,
      handledAt: f.handled_at,
      handledNote: f.handled_note,
    };
  }

  /**
   * Ask the position manager to exit a bot's position (spec §7.3 flag_position_exit; exits flagged this way are
   * `riskExit` orders, R1). The bot must hold the token (order-linked fills, paper or live). Idempotent: an
   * open flag for the same bot and token is returned as is. Recorded, audited and sent to Telegram; no order
   * is placed here.
   */
  flagPositionExit(input: { botId: unknown; tokenId: unknown; reason: unknown }, by: Actor): PositionExitFlagView & { alreadyFlagged: boolean } {
    const who = requireActor(by, ['agent', 'human'], 'positions.flagExit');
    const actor = auditActorOf(who);
    if (typeof input.botId !== 'string' || !input.botId) throw invalidInput('botId required');
    if (typeof input.tokenId !== 'string' || !/^[0-9A-Za-z]{1,100}$/.test(input.tokenId)) throw invalidInput('tokenId must be a token id');
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 2000) : '';
    if (!reason) throw invalidInput('reason is required');
    const bot = this.deps.botRepo.findById(input.botId);
    if (!bot) throw notFound('Bot not found');
    const held = [false, true]
      .flatMap((simulated) => this.deps.tradeRepo.getRiskPositions({ simulated, botId: bot.id }).map((p) => ({ ...p, simulated })))
      .find((p) => p.symbol === input.tokenId && p.net_quantity > 1e-9);
    if (!held) throw conflict(`Bot ${bot.name} holds no position in token ${input.tokenId}`);
    const existing = this.deps.flagRepo.findOpen(bot.id, input.tokenId);
    if (existing) return { ...this.flagView(existing), alreadyFlagged: true };
    const row = this.deps.flagRepo.create({
      botId: bot.id,
      tokenId: input.tokenId,
      marketId: held.condition_id ?? null,
      simulated: held.simulated,
      reason,
      createdBy: actor,
      at: this.iso(),
    });
    const view = this.flagView(row);
    this.deps.audit?.record(actor, 'position.exit_flag', bot.id, {
      flagId: row.id,
      tokenId: input.tokenId,
      marketId: row.market_id,
      simulated: held.simulated,
      quantity: held.net_quantity,
      reason,
    });
    try {
      this.deps.notify?.positionExitFlagged(view);
    } catch {
      /* never fails the call */
    }
    return { ...view, alreadyFlagged: false };
  }

  listExitFlags(status?: unknown): PositionExitFlagView[] {
    const s = typeof status === 'string' && ['open', 'done', 'cancelled'].includes(status) ? status : undefined;
    return this.deps.flagRepo.list({ status: s }).map((f) => this.flagView(f));
  }
}
