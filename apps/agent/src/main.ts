/**
 * Agent runner entry point (spec §7.1): a child process the server's AgentScheduler starts for one run
 * (`node dist/apps/agent/src/main.js`, or the .ts file under tsx in dev), with an IPC channel. Everything comes
 * from the environment (`RUNNER_ENV`: run id, kind, model, limits, MCP URL and a per-run agent token) plus
 * `ANTHROPIC_API_KEY`. It runs one query, reports usage / web tool calls / the outcome to the server, and
 * exits. It never opens the database: the server opened the run and records what is reported.
 */

import fs from 'fs';
import path from 'path';
import { RUNNER_ENV, type RunnerKind, type RunnerMessage, type ServerMessage } from './protocol';
import { runAgent, type QueryFn, type RunnerConfig } from './runner';
import { loadSystemPrompt } from './prompt';

/** Variables the Claude Code process gets: the API key, proxies, and what the OS needs (no BotLab secrets) */
const PASSTHROUGH_ENV = [
  'ANTHROPIC_API_KEY',
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (the runner is started by the BotLab server)`);
  return v;
}

function positive(name: string): number {
  const n = Number(requireEnv(name));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

/** The ESM-only SDK, loaded with a real dynamic import (this file compiles to CommonJS) */
async function loadQuery(): Promise<QueryFn> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<{ query: QueryFn }>;
  return (await dynamicImport('@anthropic-ai/claude-agent-sdk')).query;
}

function send(msg: RunnerMessage): void {
  if (process.send) process.send(msg);
  else process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function main(): Promise<number> {
  const kind = requireEnv(RUNNER_ENV.kind) as RunnerKind;
  if (!['review', 'cycle', 'event'].includes(kind)) throw new Error(`${RUNNER_ENV.kind} must be review, cycle or event`);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const prompt = loadSystemPrompt();
  const workDir = requireEnv(RUNNER_ENV.workDir);
  fs.mkdirSync(workDir, { recursive: true });
  const env: Record<string, string> = {};
  for (const k of PASSTHROUGH_ENV) if (process.env[k]) env[k] = process.env[k] as string;
  // Claude Code's own config / state stays inside the BotLab data dir, away from the user's ~/.claude
  env.CLAUDE_CONFIG_DIR = path.join(workDir, '.claude');
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'botlab-agent/1';
  let context: unknown[] | null = null;
  try {
    const raw = process.env[RUNNER_ENV.context];
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    context = Array.isArray(parsed) ? parsed : null;
  } catch {
    context = null;
  }
  const cfg: RunnerConfig = {
    runId: requireEnv(RUNNER_ENV.runId),
    kind,
    model: requireEnv(RUNNER_ENV.model),
    maxTurns: positive(RUNNER_ENV.maxTurns),
    maxCostUsd: positive(RUNNER_ENV.maxCostUsd),
    timeoutMs: positive(RUNNER_ENV.timeoutMs),
    mcpUrl: requireEnv(RUNNER_ENV.mcpUrl),
    agentToken: requireEnv(RUNNER_ENV.agentToken),
    systemPrompt: prompt.text,
    promptVersion: prompt.version,
    context,
    cwd: workDir,
    env,
  };

  const external = new AbortController();
  process.on('message', (m: ServerMessage) => {
    if (m && m.type === 'abort') external.abort(m.reason);
  });
  // The server went away: stop spending
  process.on('disconnect', () => external.abort('shutdown'));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => external.abort('shutdown'));

  const outcome = await runAgent(cfg, { query: await loadQuery(), send, signal: external.signal });
  return outcome.status === 'ok' ? 0 : 2;
}

/** Wait until everything sent so far left over IPC (messages go out in order), then exit */
function flushAndExit(code: number): void {
  const exit = () => process.exit(code);
  if (!process.send || !process.connected) return exit();
  process.send({ type: 'log', text: `runner exiting (${code})` } satisfies RunnerMessage, undefined, undefined, () => exit());
  setTimeout(exit, 5000).unref();
}

main()
  .then((code) => flushAndExit(code))
  .catch((err) => {
    const text = err instanceof Error ? err.message : String(err);
    send({
      type: 'done',
      status: 'error',
      reason: `runner failed to start: ${text}`,
      numTurns: null,
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, estimated: true },
    });
    flushAndExit(1);
  });
