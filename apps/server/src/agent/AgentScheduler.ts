/**
 * AgentScheduler (spec §7.1, chunk 4b): starts the agent runner (`apps/agent`) as a child process for
 * scheduled runs (server.yaml `agent.schedule`, local times in `timezone`), event-triggered maintenance runs
 * and manual runs (Agent page "Run now", Telegram `/run`).
 *
 * Run accounting cannot be skipped by the agent: for every run the server
 * 1. creates a fresh agent API token for the runner (Decision R150: per run; revoked when the run ends and at
 *    startup, plaintext only in the child's environment),
 * 2. opens the run itself (`AgentService.openManagedRun`, system actor: budget and one-run-at-a-time checks),
 * 3. starts the child with the run id, kind, limits, MCP URL and token in its environment (no BotLab secrets),
 * 4. keeps the usage the child reports (cumulative) and, when the child exits for any reason, records it and
 *    closes the run (`completeManagedRun`: crash ⇒ error, over 30 min ⇒ timeout) and sends the run report.
 *
 * The 30-minute limit is enforced twice: the runner aborts its query, and the server asks it to stop shortly
 * after and kills it if it does not exit. One run at a time; a scheduled run is skipped when a run is active,
 * the agent is disabled, `ANTHROPIC_API_KEY` is missing, or the monthly budget is used (notified once a month).
 */

import { execFile, fork, type ChildProcess } from 'child_process';
import path from 'path';
import type { Core } from '../../../../packages/core/src/core';
import { AGENT_RUN_EVENT, AGENT_TRIGGER_EVENT } from '../../../../packages/core/src/core';
import { asSystem } from '../../../../packages/core/src/services/actors';
import { ServiceError } from '../../../../packages/core/src/services/errors';
import type { AgentRunView } from '../../../../packages/core/src/services/AgentService';
import type { AgentRunKind, AgentRunTrigger } from '../../../../packages/core/src/db/repositories/AgentRepository';
import type { ServerConfig } from '../../../../packages/core/src/config/serverSchema';
import { resolveWorkerEntry } from '../../../../packages/core/src/runtime/workerPath';
import {
  acceptTrigger,
  isQuietHours,
  decideEventRun,
  dueScheduledRun,
  nextScheduledRuns,
  startOfLocalDay,
  type AgentTrigger,
  type ScheduledSlot,
} from '../../../../packages/core/src/agent/schedule';
import { RUNNER_ENV, isRunnerMessage, type RunnerMessage, type RunnerUsage, type ServerMessage } from '../../../agent/src/protocol';

/** Spec §7.1: runs over 30 minutes are cancelled */
export const RUN_TIMEOUT_MS = 30 * 60_000;
/** After the runner's own timeout: ask it to stop, then kill it */
const STOP_GRACE_MS = 30_000;
const KILL_GRACE_MS = 60_000;
/** Name of the per-run agent tokens (revoked at startup if a previous server left one active) */
export const RUNNER_TOKEN_NAME = 'botlab-runner (automatic)';
const TICK_MS = 30_000;
/** After the hard kill: close the run even if no exit event ever arrives */
const FINALIZE_AFTER_KILL_MS = 5_000;
/** Usage reported by the runner is written to the run at most this often (plus once at the end) */
const USAGE_PERSIST_MS = 5_000;
/** After an event run failed to start, retry the queued triggers no sooner than this */
const EVENT_RETRY_MS = 5 * 60_000;
const MAX_PENDING_TRIGGERS = 20;

export interface RunnerHandle {
  send(msg: ServerMessage): void;
  kill(): void;
  readonly pid?: number;
}

export interface SpawnRunnerOptions {
  env: Record<string, string>;
  onMessage: (msg: RunnerMessage) => void;
  onExit: (code: number | null, signal: string | null) => void;
  log: (line: string) => void;
}

export type SpawnRunner = (opts: SpawnRunnerOptions) => RunnerHandle;

export interface AgentSchedulerDeps {
  core: Pick<Core, 'services' | 'auth' | 'events' | 'configService' | 'notifications' | 'dataDir' | 'isUnlocked'>;
  /** URL of this server's /mcp (known after listen) */
  mcpUrl: () => string | null;
  env?: NodeJS.ProcessEnv;
  spawnRunner?: SpawnRunner;
  now?: () => number;
  /** 0 disables the interval (tests call tick()) */
  tickMs?: number;
  runTimeoutMs?: number;
  /** After the runner's timeout: ask it to stop after this, kill it after `killGraceMs` (defaults 30 s / 60 s) */
  stopGraceMs?: number;
  killGraceMs?: number;
  log?: (msg: string) => void;
}

interface ActiveRun {
  runId: string;
  kind: AgentRunKind;
  trigger: AgentRunTrigger;
  tokenId: string;
  startedAt: number;
  handle: RunnerHandle;
  usage: RunnerUsage | null;
  /** Usage already written to the run (recordRunUsage adds; only the difference is written) */
  recorded: { tokensIn: number; tokensOut: number; costUsd: number };
  lastPersistAt: number;
  done: Extract<RunnerMessage, { type: 'done' }> | null;
  timedOut: boolean;
  stopReason: 'timeout' | 'shutdown' | 'cancelled' | null;
  timers: NodeJS.Timeout[];
  exited: Promise<AgentRunView | null>;
}

export interface AgentScheduleStatus {
  enabled: boolean;
  /** Why runs cannot start right now (null = they can) */
  unavailable: string | null;
  apiKeyPresent: boolean;
  model: string | null;
  maxTurns: number | null;
  timezone: string;
  review: string | null;
  cycles: string[];
  nextRuns: Array<{ kind: string; at: string; local: string }>;
  quietHours: string;
  events: { enabled: boolean; maxPerDay: number; debounceMinutes: number; today: number; pending: number };
  activeRun: { runId: string; kind: string; trigger: string; startedAt: string; pid: number | null } | null;
}

/**
 * Kill a process and everything it started (the SDK's Claude Code child): `taskkill /T /F` on Windows;
 * elsewhere SIGKILL to the process group (the runner is forked detached, i.e. as a group leader), falling
 * back to the process itself. SIGKILL because the runner handles SIGTERM (graceful abort).
 */
export function killProcessTree(pid: number | undefined, platform: NodeJS.Platform = process.platform): void {
  if (!pid) return;
  if (platform === 'win32') {
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * The runner as a child process: `node <entry>` with an IPC channel, no shell (Windows-safe); tsx in dev.
 * On macOS / Linux it is its own process group (`detached`), so a hard kill reaches the SDK's Claude Code
 * child too; on Windows `taskkill /T` kills the tree. `entry` is for tests.
 */
export function createForkRunner(entry = resolveWorkerEntry(path.join(__dirname, '..', '..', '..', 'agent', 'src'), 'main')): SpawnRunner {
  return ({ env, onMessage, onExit, log }) => {
    const child: ChildProcess = fork(entry, [], {
      execArgv: entry.endsWith('.ts') ? ['--import', 'tsx'] : [],
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
      detached: process.platform !== 'win32',
    });
    const pipe = (stream: NodeJS.ReadableStream | null) => {
      let buf = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trimEnd();
          buf = buf.slice(i + 1);
          if (line) log(line.slice(0, 500));
        }
        if (buf.length > 10_000) buf = buf.slice(-10_000);
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on('message', (m) => {
      if (isRunnerMessage(m)) onMessage(m);
    });
    let exited = false;
    const exit = (code: number | null, signal: string | null) => {
      if (exited) return;
      exited = true;
      // Leftovers of the group (a Claude Code child that outlived the runner) go with it
      if (process.platform !== 'win32') killProcessTree(child.pid);
      onExit(code, signal);
    };
    child.on('exit', (code, signal) => exit(code, signal));
    child.on('error', (err) => {
      log(`runner process error: ${err.message}`);
      if (child.exitCode === null && child.pid === undefined) exit(null, null);
    });
    return {
      pid: child.pid,
      send: (msg) => {
        if (child.connected) child.send(msg, () => undefined);
      },
      kill: () => {
        if (!exited) killProcessTree(child.pid);
      },
    };
  };
}

export const forkRunner: SpawnRunner = (opts) => createForkRunner()(opts);

const SYSTEM = asSystem('agent-scheduler');

export class AgentScheduler {
  private timer: NodeJS.Timeout | null = null;
  private active: ActiveRun | null = null;
  private handledSlots = new Set<string>();
  private pending: AgentTrigger[] = [];
  private budgetNoticeMonth: string | null = null;
  private warnedConfig: string | null = null;
  private unsubs: Array<() => void> = [];
  private stopped = false;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (msg: string) => void;
  private readonly spawnRunner: SpawnRunner;

  constructor(private deps: AgentSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.env = deps.env ?? process.env;
    this.log = deps.log ?? ((m) => console.log(m));
    this.spawnRunner = deps.spawnRunner ?? forkRunner;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  start(): void {
    const { core } = this.deps;
    // A previous server process may have died mid-run: close its run and revoke leftover runner tokens
    const orphaned = core.services.agent.closeOrphanedManagedRuns(SYSTEM);
    if (orphaned > 0) this.log(`[Agent] Closed ${orphaned} run(s) left open by a previous server process`);
    for (const t of core.auth.listTokens()) if (t.name === RUNNER_TOKEN_NAME && !t.revoked_at) core.auth.revokeToken(t.id);

    const onTrigger = (t: AgentTrigger) => this.onTrigger(t);
    core.events.on(AGENT_TRIGGER_EVENT, onTrigger);
    this.unsubs.push(() => core.events.off(AGENT_TRIGGER_EVENT, onTrigger));
    core.notifications.setAgentRunHandler((kind) => this.telegramRun(kind));
    this.unsubs.push(() => core.notifications.setAgentRunHandler(null));

    this.checkConfigWarning();
    const tickMs = this.deps.tickMs ?? TICK_MS;
    if (tickMs > 0) {
      this.timer = setInterval(() => this.tick(), tickMs);
      this.timer.unref?.();
    }
  }

  /** Stop scheduling; an active run is asked to stop, then killed; its usage is recorded */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    const run = this.active;
    if (!run) return;
    this.requestStop(run, 'shutdown');
    const killTimer = setTimeout(() => run.handle?.kill(), Math.max(0, timeoutMs - 2000));
    await Promise.race([run.exited, new Promise((r) => setTimeout(r, timeoutMs))]);
    clearTimeout(killTimer);
    if (this.active === run) this.finalize(run, null, 'shutdown');
  }

  // ── Config / availability ──────────────────────────────────────────

  private server(): ServerConfig | null {
    return this.deps.core.configService.getConfig()?.server ?? null;
  }

  private apiKeyPresent(): boolean {
    return !!this.env.ANTHROPIC_API_KEY?.trim();
  }

  /** Null when a run may start, else why not */
  unavailableReason(): string | null {
    const server = this.server();
    if (!server) return 'config unavailable (server.yaml invalid)';
    if (!server.agent.enabled) return 'the agent is disabled (server.yaml agent.enabled: false)';
    if (!this.apiKeyPresent()) return 'ANTHROPIC_API_KEY is not set in the server environment';
    if (!this.deps.core.isUnlocked()) return 'BotLab is locked (master key not loaded)';
    if (!this.deps.mcpUrl()) return 'the server is not listening yet';
    if (this.stopped) return 'the server is shutting down';
    return null;
  }

  /** Log (once per config state) when the agent is enabled without an API key */
  private checkConfigWarning(): void {
    const server = this.server();
    const state = server?.agent.enabled ? (this.apiKeyPresent() ? 'ok' : 'nokey') : 'off';
    if (state === this.warnedConfig) return;
    this.warnedConfig = state;
    if (state === 'nokey') {
      console.warn(
        '[Agent] WARNING: agent.enabled is true in server.yaml but ANTHROPIC_API_KEY is not set: no agent runs are scheduled. Set it in the server environment (README "Running the agent").'
      );
    } else if (state === 'ok') {
      this.log(`[Agent] Scheduled agent enabled (${server!.agent.model}); next: ${this.status().nextRuns[0]?.local ?? 'none'}`);
    }
  }

  status(): AgentScheduleStatus {
    const server = this.server();
    const tz = server?.timezone ?? 'Europe/Dublin';
    const a = server?.agent ?? null;
    const now = this.now();
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const next = a ? nextScheduledRuns(now, a.schedule, tz, 6) : [];
    const today = this.eventStats().count;
    return {
      enabled: a?.enabled ?? false,
      unavailable: this.unavailableReason(),
      apiKeyPresent: this.apiKeyPresent(),
      model: a?.model ?? null,
      maxTurns: a?.max_turns ?? null,
      timezone: tz,
      review: a?.schedule.review ?? null,
      cycles: a ? [...a.schedule.cycles] : [],
      nextRuns: next.map((s) => ({ kind: s.kind, at: new Date(s.at).toISOString(), local: fmt.format(new Date(s.at)) })),
      quietHours: '00:00–07:00',
      events: {
        enabled: a?.events.enabled ?? false,
        maxPerDay: a?.events.max_per_day ?? 0,
        debounceMinutes: a?.events.debounce_minutes ?? 30,
        today,
        pending: this.pending.length,
      },
      activeRun: this.active
        ? {
            runId: this.active.runId,
            kind: this.active.kind,
            trigger: this.active.trigger,
            startedAt: new Date(this.active.startedAt).toISOString(),
            pid: this.active.handle.pid ?? null,
          }
        : null,
    };
  }

  // ── Scheduling ─────────────────────────────────────────────────────

  private eventStats(): { count: number; lastStartedAt: number | null } {
    const tz = this.server()?.timezone ?? 'Europe/Dublin';
    const now = this.now();
    const today = this.deps.core.services.agent.triggerStats('event', new Date(startOfLocalDay(now, tz)).toISOString());
    const recent = this.deps.core.services.agent.triggerStats('event', new Date(now - 86_400_000).toISOString());
    return { count: today.count, lastStartedAt: recent.lastStartedAt ? Date.parse(recent.lastStartedAt) : null };
  }

  /** A slot counts as handled once decided in this process, or when a scheduled run started at or after it */
  private isSlotHandled(slot: ScheduledSlot): boolean {
    if (this.handledSlots.has(slot.key)) return true;
    return this.deps.core.services.agent.triggerStats('schedule', new Date(slot.at).toISOString()).count > 0;
  }

  /** One scheduling step (every 30 s): scheduled slot, then pending event triggers. Never throws. */
  tick(): void {
    try {
      this.checkConfigWarning();
      const server = this.server();
      if (!server || this.stopped) return;
      if (!server.agent.enabled && this.active) {
        this.log('[Agent] agent.enabled was switched off: stopping the active run');
        this.requestStop(this.active, 'cancelled');
      }
      const slot = dueScheduledRun(this.now(), server.agent.schedule, server.timezone, (s) => this.isSlotHandled(s));
      if (slot) {
        this.handledSlots.add(slot.key);
        if (this.handledSlots.size > 200) this.handledSlots = new Set([...this.handledSlots].slice(-50));
        this.startScheduled(slot);
      }
      this.processPending();
    } catch (err) {
      console.error('[Agent] scheduler tick failed:', err);
    }
  }

  private startScheduled(slot: ScheduledSlot): void {
    // A late slot (e.g. 23:30 still due at 00:10) must not run in the quiet hours
    if (isQuietHours(this.now(), this.server()?.timezone ?? 'Europe/Dublin')) {
      this.log(`[Agent] Skipped the ${slot.time} ${slot.kind} run: quiet hours (00:00–07:00)`);
      this.deps.core.services.audit.record('system', 'agent.run_skipped', null, { slot: slot.key, reason: 'quiet hours' });
      return;
    }
    const why = this.unavailableReason();
    if (why) {
      this.log(`[Agent] Skipped the ${slot.time} ${slot.kind} run: ${why}`);
      return;
    }
    if (this.active) {
      this.log(`[Agent] Skipped the ${slot.time} ${slot.kind} run: run ${this.active.runId} is still in progress`);
      this.deps.core.services.audit.record('system', 'agent.run_skipped', null, { slot: slot.key, reason: 'run in progress', activeRun: this.active.runId });
      return;
    }
    this.launch(slot.kind, 'schedule', null).catch((err) => this.onLaunchError(err, `${slot.time} ${slot.kind} run`));
  }

  private onLaunchError(err: unknown, what: string): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.log(`[Agent] Could not start the ${what}: ${msg}`);
    this.deps.core.services.audit.record('system', 'agent.run_skipped', null, { what, reason: msg.slice(0, 300) });
    if (err instanceof ServiceError && err.code === 'forbidden' && /budget/i.test(msg)) {
      const month = new Date(this.now()).toISOString().slice(0, 7);
      if (this.budgetNoticeMonth !== month) {
        this.budgetNoticeMonth = month;
        this.deps.core.notifications.agentNotice(`Scheduled runs are skipped: ${msg}`, 'high');
      }
    }
  }

  private onTrigger(t: AgentTrigger): void {
    try {
      const server = this.server();
      if (!server?.agent.enabled || !server.agent.events.enabled) return;
      const verdict = acceptTrigger(t, server.timezone);
      if (!verdict.accepted) {
        this.log(`[Agent] Event trigger ignored (${t.kind}): ${verdict.reason}`);
        return;
      }
      if (this.pending.length < MAX_PENDING_TRIGGERS) this.pending.push(t);
      this.processPending();
    } catch (err) {
      console.error('[Agent] trigger handling failed:', err);
    }
  }

  private eventRetryAfter = 0;

  private processPending(): void {
    if (this.pending.length === 0 || this.stopped || this.now() < this.eventRetryAfter) return;
    const server = this.server();
    if (!server) return;
    // Queued non-halt triggers do not start a run in the quiet hours (checked again when it would fire)
    if (isQuietHours(this.now(), server.timezone)) {
      const late = this.pending.filter((t) => t.kind !== 'bot_halt');
      if (late.length > 0) {
        this.pending = this.pending.filter((t) => t.kind === 'bot_halt');
        this.deps.core.services.audit.record('system', 'agent.event_dropped', null, { triggers: late.map((t) => t.kind), reason: 'quiet hours (00:00–07:00)' });
      }
      if (this.pending.length === 0) return;
    }
    const stats = this.eventStats();
    const decision = decideEventRun({
      nowMs: this.now(),
      enabled: server.agent.enabled && server.agent.events.enabled,
      maxPerDay: server.agent.events.max_per_day,
      debounceMs: server.agent.events.debounce_minutes * 60_000,
      eventRunsToday: stats.count,
      lastEventRunAt: stats.lastStartedAt,
      runActive: this.active !== null,
    });
    if (decision.action === 'wait') return;
    const triggers = this.pending;
    this.pending = [];
    if (decision.action === 'drop') {
      this.log(`[Agent] ${triggers.length} event trigger(s) dropped: ${decision.why}`);
      this.deps.core.services.audit.record('system', 'agent.event_dropped', null, { triggers: triggers.map((t) => t.kind), reason: decision.why });
      return;
    }
    const requeue = (why: string) => {
      // Kept (still subject to the cap and debounce), retried after a pause; the failure is audited
      this.pending = [...triggers, ...this.pending].slice(-MAX_PENDING_TRIGGERS);
      this.eventRetryAfter = this.now() + EVENT_RETRY_MS;
      this.log(`[Agent] Event run not started (${triggers.length} trigger(s) kept): ${why}`);
      this.deps.core.services.audit.record('system', 'agent.event_failed', null, { triggers: triggers.map((t) => t.kind), reason: why.slice(0, 300) });
    };
    const why = this.unavailableReason();
    if (why) return requeue(why);
    this.launch('event', 'event', triggers).catch((err) => {
      this.onLaunchError(err, 'event run');
      requeue(err instanceof Error ? err.message : String(err));
    });
  }

  // ── Manual runs ────────────────────────────────────────────────────

  /** Agent page "Run now" (admin) — refused when unavailable, a run is active or the budget is used */
  async runNow(kind: unknown): Promise<AgentRunView> {
    if (kind !== 'cycle' && kind !== 'review' && kind !== 'event') throw new ServiceError('invalid_input', 'kind must be cycle, review or event');
    const why = this.unavailableReason();
    if (why) throw new ServiceError('conflict', `Cannot start a run: ${why}`);
    if (this.active) throw new ServiceError('conflict', `Run ${this.active.runId} is in progress`);
    return this.launch(kind, 'manual', null);
  }

  /** Stop the active run (admin) */
  cancel(): { cancelled: boolean; runId: string | null } {
    if (!this.active) return { cancelled: false, runId: null };
    this.requestStop(this.active, 'cancelled');
    return { cancelled: true, runId: this.active.runId };
  }

  private async telegramRun(kind: 'cycle' | 'review'): Promise<string> {
    try {
      const run = await this.runNow(kind);
      return `Agent ${kind} run started (${run.id}). The report follows when it ends.`;
    } catch (err) {
      return `Agent run not started: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── Running ────────────────────────────────────────────────────────

  private async launch(kind: AgentRunKind, trigger: AgentRunTrigger, context: AgentTrigger[] | null): Promise<AgentRunView> {
    const { core } = this.deps;
    const server = this.server()!;
    const mcpUrl = this.deps.mcpUrl()!;
    if (this.active) throw new ServiceError('conflict', `Run ${this.active.runId} is in progress`);
    const { token, view: tokenView } = core.auth.createToken(RUNNER_TOKEN_NAME, 'agent');
    let opened: ReturnType<Core['services']['agent']['openManagedRun']>;
    try {
      opened = core.services.agent.openManagedRun({ kind, trigger, principal: `token:${tokenView.id}`, model: server.agent.model }, SYSTEM);
    } catch (err) {
      core.auth.revokeToken(tokenView.id);
      throw err;
    }
    const timeoutMs = this.deps.runTimeoutMs ?? RUN_TIMEOUT_MS;
    const env = this.childEnv({
      [RUNNER_ENV.runId]: opened.run.id,
      [RUNNER_ENV.kind]: kind,
      [RUNNER_ENV.mcpUrl]: mcpUrl,
      [RUNNER_ENV.agentToken]: token,
      [RUNNER_ENV.model]: server.agent.model,
      [RUNNER_ENV.maxTurns]: String(server.agent.max_turns),
      [RUNNER_ENV.maxCostUsd]: String(opened.maxRunCostUsd),
      [RUNNER_ENV.timeoutMs]: String(timeoutMs),
      [RUNNER_ENV.workDir]: path.join(core.dataDir, 'agent-runner'),
      ...(context ? { [RUNNER_ENV.context]: JSON.stringify(context.map((t) => ({ ...t, at: new Date(t.at).toISOString() }))) } : {}),
    });

    let resolveExit!: (v: AgentRunView | null) => void;
    const exited = new Promise<AgentRunView | null>((r) => (resolveExit = r));
    const run: ActiveRun = {
      runId: opened.run.id,
      kind,
      trigger,
      tokenId: tokenView.id,
      startedAt: this.now(),
      handle: null as unknown as RunnerHandle,
      usage: null,
      recorded: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      lastPersistAt: 0,
      done: null,
      timedOut: false,
      stopReason: null,
      timers: [],
      exited,
    };
    this.active = run;
    try {
      run.handle = this.spawnRunner({
        env,
        log: (line) => this.log(`[Agent runner] ${line}`),
        onMessage: (msg) => this.onRunnerMessage(run, msg),
        onExit: (code, signal) => resolveExit(this.finalize(run, code, signal)),
      });
    } catch (err) {
      this.finalize(run, null, null, `could not start the runner: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    run.timers.push(
      setTimeout(
        () => {
          run.timedOut = true;
          this.requestStop(run, 'timeout');
        },
        timeoutMs + (this.deps.stopGraceMs ?? STOP_GRACE_MS)
      ),
      setTimeout(
        () => {
          run.timedOut = true;
          run.handle.kill();
          // No exit event (e.g. the kill failed): close the run and revoke the token anyway
          const fallback = setTimeout(() => resolveExit(this.finalize(run, null, 'SIGKILL')), FINALIZE_AFTER_KILL_MS);
          fallback.unref?.();
          run.timers.push(fallback);
        },
        timeoutMs + (this.deps.killGraceMs ?? KILL_GRACE_MS)
      )
    );
    for (const t of run.timers) t.unref?.();
    this.log(`[Agent] Started ${kind} run ${run.runId} (${trigger}, ${server.agent.model}, max $${opened.maxRunCostUsd.toFixed(2)})`);
    core.events.emit(AGENT_RUN_EVENT, { phase: 'started', runId: run.runId, kind, trigger });
    return opened.run;
  }

  /** Environment of the runner: what the OS and the SDK need plus the run's variables; no BotLab secrets */
  private childEnv(vars: Record<string, string>): Record<string, string> {
    const keep =
      /^(PATH|Path|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|SystemRoot|SYSTEMROOT|ComSpec|LANG|LC_ALL|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ANTHROPIC_API_KEY)$/;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.env)) if (v !== undefined && keep.test(k)) env[k] = v;
    return { ...env, ...vars };
  }

  /** Write the usage not yet recorded on the run (system actor; recordRunUsage adds) */
  private persistUsage(run: ActiveRun): void {
    run.lastPersistAt = this.now();
    const delta = this.usageDelta(run);
    if (!delta) return;
    try {
      this.deps.core.services.agent.recordRunUsage(run.runId, delta, SYSTEM);
      run.recorded = {
        tokensIn: run.recorded.tokensIn + delta.tokensIn,
        tokensOut: run.recorded.tokensOut + delta.tokensOut,
        costUsd: run.recorded.costUsd + delta.costUsd,
      };
    } catch (err) {
      console.error(`[Agent] could not record usage of run ${run.runId}:`, err);
    }
  }

  private usageDelta(run: ActiveRun): { tokensIn: number; tokensOut: number; costUsd: number } | null {
    if (!run.usage) return null;
    const d = {
      tokensIn: Math.max(0, run.usage.tokensIn - run.recorded.tokensIn),
      tokensOut: Math.max(0, run.usage.tokensOut - run.recorded.tokensOut),
      costUsd: Math.max(0, run.usage.costUsd - run.recorded.costUsd),
    };
    return d.tokensIn > 0 || d.tokensOut > 0 || d.costUsd > 0 ? d : null;
  }

  private requestStop(run: ActiveRun, reason: 'timeout' | 'shutdown' | 'cancelled'): void {
    run.stopReason ??= reason;
    try {
      run.handle?.send({ type: 'abort', reason });
    } catch {
      /* the process may be gone */
    }
  }

  private onRunnerMessage(run: ActiveRun, msg: RunnerMessage): void {
    if (this.active !== run) return;
    switch (msg.type) {
      case 'usage': {
        const u = { tokensIn: num(msg.tokensIn), tokensOut: num(msg.tokensOut), costUsd: num(msg.costUsd), estimated: msg.estimated === true };
        // Cumulative: never let a report lower what was already seen
        run.usage = run.usage
          ? {
              tokensIn: Math.max(run.usage.tokensIn, u.tokensIn),
              tokensOut: Math.max(run.usage.tokensOut, u.tokensOut),
              costUsd: Math.max(run.usage.costUsd, u.costUsd),
              estimated: u.estimated,
            }
          : u;
        // Written to the run as it goes, so a server crash mid-run keeps the cost reported so far
        if (this.now() - run.lastPersistAt >= USAGE_PERSIST_MS) this.persistUsage(run);
        this.deps.core.events.emit(AGENT_RUN_EVENT, { phase: 'usage', runId: run.runId, costUsd: run.usage.costUsd });
        break;
      }
      case 'tool':
        try {
          this.deps.core.services.agent.recordRunnerAction(run.runId, { tool: String(msg.name), target: msg.target }, SYSTEM);
        } catch {
          /* best effort */
        }
        break;
      case 'done':
        run.done = msg;
        if (msg.usage) this.onRunnerMessage(run, { type: 'usage', ...msg.usage });
        break;
      case 'started':
        this.log(`[Agent] Runner ${run.runId}: prompt ${String(msg.promptVersion).slice(0, 20)}, model ${String(msg.model).slice(0, 40)}`);
        break;
      case 'log':
        this.log(`[Agent runner] ${String(msg.text).slice(0, 500)}`);
        break;
    }
  }

  /** The child is gone (or never started): record usage, close the run, revoke the token, report */
  private finalize(run: ActiveRun, code: number | null, signal: string | null, startError?: string): AgentRunView | null {
    if (this.active !== run) return null;
    this.active = null;
    for (const t of run.timers) clearTimeout(t);
    const { core } = this.deps;
    try {
      core.auth.revokeToken(run.tokenId);
    } catch (err) {
      console.error('[Agent] could not revoke the runner token:', err);
    }
    let status: 'ok' | 'error' | 'aborted' | 'timeout';
    let reason: string;
    if (startError) {
      status = 'error';
      reason = startError;
    } else if (run.done && !(run.timedOut && run.done.status === 'ok')) {
      status = run.done.status;
      reason = run.done.reason;
    } else if (run.timedOut || run.stopReason === 'timeout') {
      status = 'timeout';
      reason = 'the runner did not finish within 30 minutes and was stopped by the server';
    } else if (run.stopReason) {
      status = 'aborted';
      reason = run.stopReason === 'shutdown' ? 'the server is shutting down' : 'cancelled by the owner';
    } else {
      status = 'error';
      reason = `the runner exited unexpectedly (${signal ? `signal ${signal}` : `exit code ${code}`})`;
    }
    let view: AgentRunView | null = null;
    try {
      view = core.services.agent.completeManagedRun(
        run.runId,
        {
          usage: this.usageDelta(run),
          status,
          summary: `Run ended without finish_run: ${reason}.`,
        },
        SYSTEM
      );
    } catch (err) {
      console.error(`[Agent] could not complete run ${run.runId}:`, err);
    }
    this.log(`[Agent] Run ${run.runId} ended: ${view?.status ?? status} (${reason}); $${(run.usage?.costUsd ?? 0).toFixed(2)}`);
    core.events.emit(AGENT_RUN_EVENT, { phase: 'finished', runId: run.runId, status: view?.status ?? status });
    // Triggers that waited for this run
    setTimeout(() => this.processPending(), 0).unref?.();
    return view;
  }

  /** For tests: resolves when the active run's process has exited and the run is completed */
  async waitForIdle(): Promise<void> {
    while (this.active) await this.active.exited;
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}
