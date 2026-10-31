/**
 * AgentScheduler (chunk 4b) against a real core with a fake runner process (no Claude API, no child process):
 * the server opens the run before the runner starts (with a fresh per-run agent token passed only in the child
 * environment), records the usage the runner reports as the system actor, closes crashed / timed-out runs
 * keeping their cost, refuses runs when disabled / without an API key / while one is active / over budget,
 * runs scheduled slots once, and caps / debounces event-triggered runs. Event runs are maintenance only,
 * enforced in the services (MCP calls refused).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { sqliteAvailable } from '../orders/db';
import { createCore, type Core } from '../../packages/core/src';
import { AGENT_TRIGGER_EVENT } from '../../packages/core/src/core';
import { asAgent, asSystem } from '../../packages/core/src/services/actors';
import { AgentScheduler, RUNNER_TOKEN_NAME, createForkRunner, type SpawnRunnerOptions } from '../../apps/server/src/agent/AgentScheduler';
import { createApp } from '../../apps/server/src/app';
import { LoginLimiter } from '../../apps/server/src/routes/auth';
import { callTool } from '../../apps/server/src/mcp/server';
import type { RunnerMessage, ServerMessage } from '../../apps/agent/src/protocol';

const ENABLED_SERVER_YAML = 'agent:\n  enabled: true\n  model: claude-sonnet-5-5\n';

interface FakeChild {
  opts: SpawnRunnerOptions;
  received: ServerMessage[];
  killed: boolean;
  emit(msg: RunnerMessage): void;
  exit(code: number | null, signal?: string | null): void;
}

describe.skipIf(!sqliteAvailable)('AgentScheduler', () => {
  let tmp: string;
  let configDir: string;
  let core: Core;
  let children: FakeChild[];
  /** Fake Date only (timers stay real): the core's run timestamps and the scheduler share this clock */
  const setNow = (iso: string | number) => vi.setSystemTime(typeof iso === 'number' ? iso : Date.parse(iso));
  const advance = (ms: number) => setNow(Date.now() + ms);
  let scheduler: AgentScheduler;
  let reports: Array<{ status: string; costUsd: number; durationMs?: number | null; kind?: string }>;

  const spawnRunner = (opts: SpawnRunnerOptions) => {
    const child: FakeChild = {
      opts,
      received: [],
      killed: false,
      emit: (m) => opts.onMessage(m),
      exit: (code, signal = null) => opts.onExit(code, signal),
    };
    children.push(child);
    return {
      pid: 1234,
      send: (m: ServerMessage) => child.received.push(m),
      kill: () => {
        child.killed = true;
        setTimeout(() => child.exit(null, 'SIGTERM'), 0);
      },
    };
  };

  function makeScheduler(o: Partial<ConstructorParameters<typeof AgentScheduler>[0]> = {}) {
    return new AgentScheduler({
      core,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test', BOTLAB_MASTER_KEY: 'f'.repeat(64), PATH: process.env.PATH ?? '' },
      mcpUrl: () => 'http://127.0.0.1:3780/mcp',
      spawnRunner,
      tickMs: 0,
      log: () => undefined,
      ...o,
    });
  }

  beforeEach(async () => {
    // Before createCore: services capture Date.now at construction
    vi.useFakeTimers({ toFake: ['Date'] });
    setNow('2026-11-02T10:00:00Z');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-agent-'));
    configDir = path.join(tmp, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'limits.yaml'), 'agent:\n  monthly_llm_budget_usd: 5\n  max_run_cost_usd: 1\n');
    fs.writeFileSync(path.join(configDir, 'server.yaml'), ENABLED_SERVER_YAML);
    core = createCore({ dataDir: path.join(tmp, 'data'), configDir, backups: false });
    await core.start();
    await core.unlock(crypto.randomBytes(32).toString('hex'));
    children = [];
    reports = [];
    vi.spyOn(core.notifications, 'agentRunFinished').mockImplementation((run) => {
      reports.push(run);
    });
    scheduler = makeScheduler();
    scheduler.start();
  }, 60_000);

  afterEach(async () => {
    await scheduler.stop(1000);
    await core.shutdown({ timeoutMs: 20_000 });
    core.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const runnerTokens = () => core.auth.listTokens().filter((t) => t.name === RUNNER_TOKEN_NAME);
  const audit = (action: string) => core.services.auditLog.list({ action, limit: 100 }).entries;

  it('opens the run before the runner starts, passes a per-run token, and records usage as the system actor', async () => {
    const run = (await scheduler.runNow('cycle')) as { id: string; status: string; managed: boolean; trigger: string; kind: string };
    expect(run).toMatchObject({ status: 'running', managed: true, trigger: 'manual', kind: 'cycle' });
    const child = children[0];
    const env = child.opts.env;
    expect(env.BOTLAB_RUN_ID).toBe(run.id);
    expect(env.BOTLAB_RUN_KIND).toBe('cycle');
    expect(env.BOTLAB_AGENT_MAX_COST_USD).toBe('1');
    expect(env.BOTLAB_AGENT_TIMEOUT_MS).toBe(String(30 * 60_000));
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test');
    expect(env.BOTLAB_MASTER_KEY).toBeUndefined();
    // The token is an active agent token; the run belongs to its principal
    const token = env.BOTLAB_AGENT_TOKEN;
    const tokenView = core.auth.findToken(token)!;
    expect(tokenView).toMatchObject({ scope: 'agent', name: RUNNER_TOKEN_NAME });
    // The agent's start_run attaches to the open run instead of being refused or opening another
    const actor = asAgent(`token:${tokenView.id}`);
    const started = core.services.agent.startRun({}, actor);
    expect(started.run.id).toBe(run.id);
    // ...but another agent token cannot start a second run
    expect(() => core.services.agent.startRun({}, asAgent('token:other'))).toThrow(/in progress/);
    // finish_run by the agent: no report yet (cost unknown until the runner exits)
    core.services.agent.finishRun({ summaryMd: '## Done\nChecked 3 bots.' }, actor);
    expect(reports).toHaveLength(0);

    child.emit({ type: 'usage', tokensIn: 1000, tokensOut: 100, costUsd: 0.1, estimated: true });
    child.emit({ type: 'tool', name: 'WebSearch', target: 'cpi' });
    child.emit({ type: 'done', status: 'ok', reason: 'completed', numTurns: 4, usage: { tokensIn: 4000, tokensOut: 400, costUsd: 0.37, estimated: false } });
    child.exit(0);

    const done = core.services.agent.getRun(run.id);
    expect(done).toMatchObject({ status: 'ok', costUsd: 0.37, tokensIn: 4000, tokensOut: 400, summaryMd: '## Done\nChecked 3 bots.' });
    expect(done.actions.some((a) => a.tool === 'WebSearch' && a.target === 'cpi')).toBe(true);
    expect(audit('agent.run_usage')[0]).toMatchObject({ actor: 'system', target: run.id });
    // Token revoked as soon as the run ended
    expect(core.auth.findToken(token)).toBeNull();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ status: 'ok', costUsd: 0.37, kind: 'cycle' });
    expect(typeof reports[0].durationMs).toBe('number');
    expect(core.services.agent.budget().monthSpentUsd).toBeCloseTo(0.37);
  });

  it('a crash closes the run as error and keeps the usage reported so far', async () => {
    const run = (await scheduler.runNow('review')) as { id: string };
    children[0].emit({ type: 'usage', tokensIn: 2000, tokensOut: 300, costUsd: 0.21, estimated: true });
    children[0].exit(1);
    const done = core.services.agent.getRun(run.id);
    expect(done).toMatchObject({ status: 'error', kind: 'review', costUsd: 0.21, tokensIn: 2000 });
    expect(done.summaryMd).toMatch(/exited unexpectedly \(exit code 1\)/);
    expect(reports[0]).toMatchObject({ status: 'error', costUsd: 0.21 });
    expect(runnerTokens().every((t) => t.revoked_at)).toBe(true);
  });

  it('a runner that ignores its 30-minute limit is asked to stop, then killed; the run is timed out with its cost', async () => {
    await scheduler.stop(100);
    scheduler = makeScheduler({ runTimeoutMs: 20, stopGraceMs: 10, killGraceMs: 40 });
    scheduler.start();
    const run = (await scheduler.runNow('cycle')) as { id: string };
    children[0].emit({ type: 'usage', tokensIn: 500, tokensOut: 50, costUsd: 0.05, estimated: true });
    await scheduler.waitForIdle();
    expect(children[0].received).toContainEqual({ type: 'abort', reason: 'timeout' });
    expect(children[0].killed).toBe(true);
    expect(core.services.agent.getRun(run.id)).toMatchObject({ status: 'timeout', costUsd: 0.05 });
    expect(reports[0]).toMatchObject({ status: 'timeout' });
  });

  it('refuses runs while one is active, when disabled, without an API key, and over the monthly budget', async () => {
    await scheduler.runNow('cycle');
    await expect(scheduler.runNow('cycle')).rejects.toThrow(/in progress/);
    children[0].emit({ type: 'done', status: 'ok', reason: 'completed', numTurns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 5, estimated: false } });
    children[0].exit(0);
    // $5 of $5 used ⇒ refused (server-side, AgentService)
    await expect(scheduler.runNow('cycle')).rejects.toThrow(/Monthly LLM budget used/);
    expect(runnerTokens().every((t) => t.revoked_at)).toBe(true); // the token made for the refused run is revoked too

    const noKey = makeScheduler({ env: {} });
    await expect(noKey.runNow('cycle')).rejects.toThrow(/ANTHROPIC_API_KEY/);
    fs.writeFileSync(path.join(configDir, 'server.yaml'), 'agent:\n  enabled: false\n');
    core.configService.load();
    await expect(scheduler.runNow('cycle')).rejects.toThrow(/disabled/);
    expect(scheduler.status()).toMatchObject({ enabled: false, unavailable: expect.stringContaining('disabled') });
  });

  it('runs a scheduled slot once (Europe/Dublin), and skips it while a run is active', async () => {
    // 11:31 local (GMT in November)
    setNow('2026-11-03T11:31:00Z');
    scheduler.tick();
    expect(children).toHaveLength(1);
    expect(children[0].opts.env.BOTLAB_RUN_KIND).toBe('cycle');
    const runId = children[0].opts.env.BOTLAB_RUN_ID;
    expect(core.services.agent.getRun(runId).trigger).toBe('schedule');
    advance(60_000);
    scheduler.tick();
    expect(children).toHaveLength(1);
    children[0].exit(0);
    // A fresh scheduler (server restart) sees the slot was run (DB) and does not run it again
    const restarted = makeScheduler();
    restarted.tick();
    expect(children).toHaveLength(1);
    // Next slot while a manual run is still active ⇒ skipped (audited)
    setNow('2026-11-03T15:29:00Z');
    await scheduler.runNow('review');
    setNow('2026-11-03T15:31:00Z');
    scheduler.tick();
    expect(children).toHaveLength(2);
    expect(audit('agent.run_skipped')[0].payload).toMatchObject({ reason: 'run in progress' });
    const status = scheduler.status();
    expect(status.nextRuns[0]).toMatchObject({ kind: 'cycle', at: '2026-11-03T19:30:00.000Z' });
    expect(status.activeRun).toMatchObject({ kind: 'review', trigger: 'manual' });
  });

  it('event triggers: maintenance run, coalesced while active, debounced 30 min, capped per day; quiet hours only for halts', async () => {
    // 13:00 local: away from the 11:30 / 15:30 scheduled slots (their 60-minute grace windows)
    setNow('2026-11-03T13:00:00Z');
    const trigger = (kind: string, at = Date.now()) => core.events.emit(AGENT_TRIGGER_EVENT, { kind, at, detail: `${kind} test`, ref: 'x' });
    trigger('bot_halt');
    expect(children).toHaveLength(1);
    const env = children[0].opts.env;
    expect(env.BOTLAB_RUN_KIND).toBe('event');
    expect(JSON.parse(env.BOTLAB_RUN_CONTEXT)).toEqual([expect.objectContaining({ kind: 'bot_halt', detail: 'bot_halt test' })]);
    // More triggers while the run is active: queued, not started
    trigger('rules_changed');
    trigger('reconcile_mismatch');
    expect(children).toHaveLength(1);
    children[0].exit(0);
    // Within the 30-minute debounce: still waiting
    advance(10 * 60_000);
    scheduler.tick();
    expect(children).toHaveLength(1);
    advance(21 * 60_000);
    scheduler.tick();
    expect(children).toHaveLength(2);
    expect(JSON.parse(children[1].opts.env.BOTLAB_RUN_CONTEXT).map((t: { kind: string }) => t.kind)).toEqual(['rules_changed', 'reconcile_mismatch']);
    children[1].exit(0);
    // Two more (31 min apart) reach the cap of 4; the fifth is dropped
    for (let i = 0; i < 2; i++) {
      advance(31 * 60_000);
      trigger('bot_halt');
      children.at(-1)!.exit(0);
    }
    expect(children).toHaveLength(4);
    advance(31 * 60_000);
    trigger('bot_halt');
    expect(children).toHaveLength(4);
    expect(audit('agent.event_dropped')[0].payload).toMatchObject({ reason: expect.stringContaining('daily cap') });
    // Next day 03:00 local: a rules change is ignored, a halt starts a run
    setNow('2026-11-04T03:00:00Z');
    trigger('rules_changed');
    expect(children).toHaveLength(4);
    trigger('bot_halt');
    expect(children).toHaveLength(5);
  });

  it('during an event run the agent cannot create bots, templates or forecasts (enforced in the services)', async () => {
    setNow('2026-11-03T12:00:00Z');
    core.events.emit(AGENT_TRIGGER_EVENT, { kind: 'bot_halt', at: Date.now(), detail: 'halt', ref: 'b' });
    const env = children[0].opts.env;
    const tokenView = core.auth.findToken(env.BOTLAB_AGENT_TOKEN)!;
    const opts = { services: core.services, actor: asAgent(`token:${tokenView.id}`), tokenId: tokenView.id };
    const template = core.services.scripts.templates().find((t) => t.builtin)!;
    const createBot = await callTool(opts, 'create_bot', { name: 'x', templateId: template.id, config: {} });
    expect(createBot.isError).toBe(true);
    expect((createBot.content[0] as { text: string }).text).toMatch(/event-triggered run/);
    const createTemplate = await callTool(opts, 'create_template', { name: 't', source: 'export async function onTick(ctx) {}' });
    expect((createTemplate.content[0] as { text: string }).text).toMatch(/event-triggered run/);
    const forecast = await callTool(opts, 'submit_forecast', { tokenId: '111', probability: 0.6, rationale: 'r', sources: [], ambiguityScore: 0 });
    expect((forecast.content[0] as { text: string }).text).toMatch(/event-triggered run/);
    // Maintenance still works: notes, overview, run attach
    expect((await callTool(opts, 'write_note', { scope: 'general', title: 'halt', body_md: 'looked at it' })).isError).toBeFalsy();
    expect((await callTool(opts, 'start_run', {})).isError).toBeFalsy();
    expect(audit('bot.create')[0].result).toMatch(/event run/);
    // After the event run, a human is unaffected and the agent may create again in a cycle run
    children[0].exit(0);
    expect(core.services.agent.currentRun()).toBeNull();
    expect(() => core.services.agent.guardMaintenanceRun(asAgent('token:x'), 'bot.create')).not.toThrow();
  });

  it('review fix: an event run cannot escape maintenance mode through finish_run; the runner token dies with its run', async () => {
    setNow('2026-11-03T13:00:00Z');
    core.events.emit(AGENT_TRIGGER_EVENT, { kind: 'bot_halt', at: Date.now(), detail: 'halt', ref: 'b' });
    const token = children[0].opts.env.BOTLAB_AGENT_TOKEN;
    const tokenView = core.auth.findToken(token)!;
    const opts = { services: core.services, actor: asAgent(`token:${tokenView.id}`), tokenId: tokenView.id };
    const template = core.services.scripts.templates().find((t) => t.builtin)!;
    expect((await callTool(opts, 'start_run', {})).isError).toBeFalsy();
    // Another agent token cannot finish the runner's run
    expect(() => core.services.agent.finishRun({ summaryMd: 'x' }, asAgent('token:other'))).toThrow(/runner/);
    expect((await callTool(opts, 'finish_run', { summary_md: 'done' })).isError).toBeFalsy();
    // Token revoked at once: /mcp answers 401
    expect(core.auth.isTokenActive(tokenView.id)).toBe(false);
    const { app } = createApp({ core, webDir: null, limiter: new LoginLimiter(), loopbackOnly: true });
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { host: '127.0.0.1:3780', authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_bot', arguments: { name: 'x', templateId: template.id } } }),
    });
    expect(res.status).toBe(401);
    // ...and the services refuse that principal anyway (no new run, no writes)
    const createBot = await callTool(opts, 'create_bot', { name: 'x', templateId: template.id, config: {} });
    expect(createBot.isError).toBe(true);
    expect((createBot.content[0] as { text: string }).text).toMatch(/has ended/);
    const startAgain = await callTool(opts, 'start_run', {});
    expect(startAgain.isError).toBe(true);
    expect(() => core.services.agent.startRun({}, opts.actor)).toThrow(/has ended/);
    await expect(core.services.bots.create({ name: 'y', scriptId: template.id } as never, opts.actor)).rejects.toThrow(/has ended/);
    expect(core.services.agent.currentRun()).toBeNull();
    // The runner exits; runs start normally afterwards (nothing blocked for 30 minutes)
    children[0].exit(0);
    const next = (await scheduler.runNow('cycle')) as { id: string; status: string };
    expect(next.status).toBe('running');
  });

  it('review fix: usage is written while the run goes, so a server crash keeps the cost', async () => {
    const run = (await scheduler.runNow('cycle')) as { id: string };
    children[0].emit({ type: 'usage', tokensIn: 1000, tokensOut: 100, costUsd: 0.12, estimated: true });
    expect(core.services.agent.getRun(run.id).costUsd).toBeCloseTo(0.12);
    // Within 5 s: not written yet; after 5 s: written (only the difference is added)
    children[0].emit({ type: 'usage', tokensIn: 2000, tokensOut: 200, costUsd: 0.2, estimated: true });
    expect(core.services.agent.getRun(run.id).costUsd).toBeCloseTo(0.12);
    advance(6_000);
    children[0].emit({ type: 'usage', tokensIn: 3000, tokensOut: 300, costUsd: 0.3, estimated: true });
    expect(core.services.agent.getRun(run.id)).toMatchObject({ tokensIn: 3000, tokensOut: 300 });
    expect(core.services.agent.getRun(run.id).costUsd).toBeCloseTo(0.3);
    // The server dies here (no exit, no completion); the next server closes the run and keeps the cost
    const restarted = makeScheduler();
    restarted.start();
    expect(core.services.agent.getRun(run.id)).toMatchObject({ status: 'error', tokensIn: 3000 });
    expect(core.services.agent.getRun(run.id).costUsd).toBeCloseTo(0.3);
    expect(core.services.agent.budget().monthSpentUsd).toBeCloseTo(0.3);
    await restarted.stop(10);
  });

  it('review fix: a runner that ignores SIGTERM is killed with its child process; the run is closed', async () => {
    await scheduler.stop(100);
    const logs: string[] = [];
    scheduler = makeScheduler({
      spawnRunner: createForkRunner(path.join(__dirname, 'fixtures', 'stubborn-runner.js')),
      runTimeoutMs: 100,
      stopGraceMs: 50,
      killGraceMs: 400,
      log: (m) => logs.push(m),
    });
    scheduler.start();
    const run = (await scheduler.runNow('cycle')) as { id: string };
    const pid = scheduler.status().activeRun!.pid!;
    await scheduler.waitForIdle();
    const run2 = core.services.agent.getRun(run.id);
    expect(run2.status).toBe('timeout');
    expect(run2.costUsd).toBeCloseTo(0.02);
    expect(runnerTokens().every((t) => t.revoked_at)).toBe(true);
    const alive = (p: number) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };
    const grandchild = Number(/grandchild (\d+)/.exec(logs.join('\n'))?.[1]);
    // Date is faked: wait on real timers
    for (let i = 0; i < 60 && (alive(pid) || (process.platform !== 'win32' && alive(grandchild))); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
    if (process.platform !== 'win32') expect(alive(grandchild)).toBe(false);
  }, 20_000);

  it('review fix: a late slot is not run in the quiet hours', () => {
    setNow('2026-11-04T00:10:00Z'); // the 23:30 slot is still within its grace window
    scheduler.tick();
    expect(children).toHaveLength(0);
    expect(audit('agent.run_skipped')[0].payload).toMatchObject({ reason: 'quiet hours' });
  });

  it('review fix: the run cost cap is the smaller of max_run_cost_usd and what is left of the month', async () => {
    const t = core.auth.createToken('x', 'agent');
    const r = core.services.agent.openManagedRun({ kind: 'cycle', trigger: 'manual', principal: `token:${t.view.id}` }, asSystem('test'));
    core.services.agent.completeManagedRun(r.run.id, { usage: { costUsd: 4.6 }, status: 'ok', summary: 's' }, asSystem('test'));
    await scheduler.runNow('cycle');
    expect(Number(children[0].opts.env.BOTLAB_AGENT_MAX_COST_USD)).toBeCloseTo(0.4);
  });

  it('closes runs left open by a previous server process and revokes leftover runner tokens at start', () => {
    const t = core.auth.createToken(RUNNER_TOKEN_NAME, 'agent');
    const open = core.services.agent.openManagedRun({ kind: 'cycle', trigger: 'schedule', principal: `token:${t.view.id}` }, asSystem('test'));
    const fresh = makeScheduler();
    fresh.start();
    expect(core.services.agent.getRun(open.run.id).status).toBe('error');
    expect(core.auth.isTokenActive(t.view.id)).toBe(false);
    void fresh.stop(10);
  });
});
