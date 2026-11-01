import type Database from 'better-sqlite3';
import { generateId } from '../index';

/** agent_runs (spec §2.2) */
export type AgentRunTrigger = 'schedule' | 'manual' | 'event';
export type AgentRunStatus = 'running' | 'ok' | 'error' | 'aborted' | 'timeout';
/** review (daily), cycle (scan → act), event (maintenance only: no new bots / templates / forecasts) */
export type AgentRunKind = 'review' | 'cycle' | 'event';
export const AGENT_RUN_KINDS: readonly AgentRunKind[] = ['review', 'cycle', 'event'];

export interface AgentRunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: AgentRunTrigger;
  status: AgentRunStatus;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  summary_md: string | null;
  /** JSON array of { tool, at, ok, target? } */
  actions: string;
  tool_calls: number;
  principal: string | null;
  kind: AgentRunKind;
  /** 1 = opened by the server for its runner process (spec §7.1) */
  managed: number;
  model: string | null;
}

/** One tool call recorded on a run */
export interface AgentRunAction {
  tool: string;
  at: string;
  ok: boolean;
  target?: string | null;
}

/** Actions kept per run (the audit log has every call) */
export const MAX_RUN_ACTIONS = 500;

export class AgentRunRepository {
  constructor(private db: Database.Database) {}

  findById(id: string): AgentRunRow | undefined {
    return this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as AgentRunRow | undefined;
  }

  /** The run in progress (newest), if any */
  findRunning(): AgentRunRow | undefined {
    return this.db.prepare("SELECT * FROM agent_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1").get() as AgentRunRow | undefined;
  }

  list(limit = 50, beforeIso?: string): AgentRunRow[] {
    const n = Math.min(Math.max(Math.floor(limit), 1), 500);
    return beforeIso
      ? (this.db.prepare('SELECT * FROM agent_runs WHERE started_at < ? ORDER BY started_at DESC LIMIT ?').all(beforeIso, n) as AgentRunRow[])
      : (this.db.prepare('SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?').all(n) as AgentRunRow[]);
  }

  create(data: { trigger: AgentRunTrigger; principal: string | null; startedAt: string; kind?: AgentRunKind; managed?: boolean; model?: string | null }): AgentRunRow {
    const id = generateId();
    this.db
      .prepare("INSERT INTO agent_runs (id, started_at, trigger, status, principal, kind, managed, model) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)")
      .run(id, data.startedAt, data.trigger, data.principal, data.kind ?? 'cycle', data.managed ? 1 : 0, data.model ?? null);
    return this.findById(id)!;
  }

  /** Runs started in [fromIso, now), oldest first (digest) */
  listSince(fromIso: string): AgentRunRow[] {
    return this.db.prepare('SELECT * FROM agent_runs WHERE started_at >= ? ORDER BY started_at').all(fromIso) as AgentRunRow[];
  }

  /** Runs with this trigger started at or after `fromIso` (event-run cap, scheduled-slot dedupe) */
  countTriggerSince(trigger: AgentRunTrigger, fromIso: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE trigger = ? AND started_at >= ?').get(trigger, fromIso) as { n: number }).n;
  }

  /** The managed run of a runner-token principal (each runner token belongs to one run) */
  findManagedByPrincipal(principal: string): AgentRunRow | undefined {
    return this.db.prepare('SELECT * FROM agent_runs WHERE managed = 1 AND principal = ? ORDER BY started_at DESC LIMIT 1').get(principal) as AgentRunRow | undefined;
  }

  /** Open runs the server opened for a runner (closed when the server starts again) */
  findOpenManaged(): AgentRunRow[] {
    return this.db.prepare("SELECT * FROM agent_runs WHERE status = 'running' AND managed = 1").all() as AgentRunRow[];
  }

  /** Reserve one tool call on a running run, synchronously (R146); false when the run is not running */
  reserveCall(id: string): boolean {
    return this.db.prepare("UPDATE agent_runs SET tool_calls = tool_calls + 1 WHERE id = ? AND status = 'running'").run(id).changes > 0;
  }

  /** Keep a finished tool call in `actions` (bounded); the count was reserved by reserveCall */
  recordAction(id: string, action: AgentRunAction): void {
    this.db.transaction(() => {
      const row = this.findById(id);
      if (!row) return;
      let actions: AgentRunAction[] = [];
      try {
        const v = JSON.parse(row.actions) as unknown;
        if (Array.isArray(v)) actions = v as AgentRunAction[];
      } catch {
        /* rewrite */
      }
      if (actions.length >= MAX_RUN_ACTIONS) return;
      actions.push(action);
      this.db.prepare('UPDATE agent_runs SET actions = ? WHERE id = ?').run(JSON.stringify(actions), id);
    })();
  }

  /** Token usage and cost recorded by the runner (any status: a timed-out run keeps its cost) */
  addUsage(id: string, usage: { tokensIn: number; tokensOut: number; costUsd: number }): AgentRunRow | undefined {
    this.db
      .prepare('UPDATE agent_runs SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_usd = cost_usd + ? WHERE id = ?')
      .run(usage.tokensIn, usage.tokensOut, usage.costUsd, id);
    return this.findById(id);
  }

  finish(id: string, data: { status: Exclude<AgentRunStatus, 'running'>; finishedAt: string; summaryMd: string | null }): AgentRunRow | undefined {
    this.db
      .prepare("UPDATE agent_runs SET status = ?, finished_at = ?, summary_md = ? WHERE id = ? AND status = 'running'")
      .run(data.status, data.finishedAt, data.summaryMd, id);
    return this.findById(id);
  }

  /** LLM cost of runs started in [fromIso, toIso) */
  costSince(fromIso: string, toIso?: string): number {
    const row = toIso
      ? (this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM agent_runs WHERE started_at >= ? AND started_at < ?').get(fromIso, toIso) as {
          c: number;
        })
      : (this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM agent_runs WHERE started_at >= ?').get(fromIso) as { c: number });
    return row.c;
  }

  countSince(fromIso: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE started_at >= ?').get(fromIso) as { n: number }).n;
  }
}

/** agent_notes (spec §2.2): the agent's memory */
export interface AgentNoteRow {
  id: string;
  scope: string;
  title: string;
  body_md: string;
  created_at: string;
  updated_at: string;
}

export class AgentNoteRepository {
  constructor(private db: Database.Database) {}

  findById(id: string): AgentNoteRow | undefined {
    return this.db.prepare('SELECT * FROM agent_notes WHERE id = ?').get(id) as AgentNoteRow | undefined;
  }

  /** Newest first. `scope` exact, or a prefix ending in ':' (e.g. `market:`); `query` matches title/body */
  list(filter: { scope?: string; query?: string; limit?: number } = {}): AgentNoteRow[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter.scope) {
      if (filter.scope.endsWith(':')) {
        conditions.push("scope LIKE ? ESCAPE '\\'");
        values.push(`${filter.scope.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      } else {
        conditions.push('scope = ?');
        values.push(filter.scope);
      }
    }
    if (filter.query) {
      const like = `%${filter.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push("(title LIKE ? ESCAPE '\\' OR body_md LIKE ? ESCAPE '\\')");
      values.push(like, like);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(Math.min(Math.max(Math.floor(filter.limit ?? 100), 1), 1000));
    return this.db.prepare(`SELECT * FROM agent_notes ${where} ORDER BY updated_at DESC LIMIT ?`).all(...values) as AgentNoteRow[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM agent_notes').get() as { n: number }).n;
  }

  create(data: { scope: string; title: string; bodyMd: string; at: string }): AgentNoteRow {
    const id = generateId();
    this.db
      .prepare('INSERT INTO agent_notes (id, scope, title, body_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, data.scope, data.title, data.bodyMd, data.at, data.at);
    return this.findById(id)!;
  }

  update(id: string, data: { scope: string; title: string; bodyMd: string; at: string }): AgentNoteRow | undefined {
    this.db
      .prepare('UPDATE agent_notes SET scope = ?, title = ?, body_md = ?, updated_at = ? WHERE id = ?')
      .run(data.scope, data.title, data.bodyMd, data.at, id);
    return this.findById(id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM agent_notes WHERE id = ?').run(id).changes > 0;
  }
}

/** position_exit_flags: exits requested for the position manager (spec §7.3 flag_position_exit, §9.2) */
export interface PositionExitFlagRow {
  id: string;
  bot_id: string;
  token_id: string;
  market_id: string | null;
  simulated: number;
  reason: string;
  status: 'open' | 'done' | 'cancelled';
  created_by: string;
  created_at: string;
  handled_at: string | null;
  handled_note: string | null;
}

export class PositionExitFlagRepository {
  constructor(private db: Database.Database) {}

  findById(id: string): PositionExitFlagRow | undefined {
    return this.db.prepare('SELECT * FROM position_exit_flags WHERE id = ?').get(id) as PositionExitFlagRow | undefined;
  }

  findOpen(botId: string, tokenId: string): PositionExitFlagRow | undefined {
    return this.db.prepare("SELECT * FROM position_exit_flags WHERE bot_id = ? AND token_id = ? AND status = 'open'").get(botId, tokenId) as
      | PositionExitFlagRow
      | undefined;
  }

  /** Open flags in one mode (paper / live), newest first (ctx.risk.getFlaggedTokens). */
  listOpen(simulated: boolean): PositionExitFlagRow[] {
    return this.db
      .prepare("SELECT * FROM position_exit_flags WHERE status = 'open' AND simulated = ? ORDER BY created_at DESC")
      .all(simulated ? 1 : 0) as PositionExitFlagRow[];
  }

  list(filter: { status?: string; limit?: number } = {}): PositionExitFlagRow[] {
    const n = Math.min(Math.max(Math.floor(filter.limit ?? 200), 1), 1000);
    return filter.status
      ? (this.db.prepare('SELECT * FROM position_exit_flags WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(filter.status, n) as PositionExitFlagRow[])
      : (this.db.prepare('SELECT * FROM position_exit_flags ORDER BY created_at DESC LIMIT ?').all(n) as PositionExitFlagRow[]);
  }

  create(data: {
    botId: string;
    tokenId: string;
    marketId: string | null;
    simulated: boolean;
    reason: string;
    createdBy: string;
    at: string;
  }): PositionExitFlagRow {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO position_exit_flags (id, bot_id, token_id, market_id, simulated, reason, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`
      )
      .run(id, data.botId, data.tokenId, data.marketId, data.simulated ? 1 : 0, data.reason, data.createdBy, data.at);
    return this.findById(id)!;
  }

  close(id: string, status: 'done' | 'cancelled', note: string | null, at: string): boolean {
    return (
      this.db.prepare("UPDATE position_exit_flags SET status = ?, handled_at = ?, handled_note = ? WHERE id = ? AND status = 'open'").run(status, at, note, id)
        .changes > 0
    );
  }
}
