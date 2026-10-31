/**
 * Messages between the BotLab server (AgentScheduler) and the agent runner child process, over the Node
 * child-process IPC channel (`process.send`, JSON serialization). Shared by both sides.
 *
 * The server passes everything the runner needs in its environment (`RUNNER_ENV`); the runner reports
 * usage (cumulative, so the last message wins), web tool calls and the outcome. The server never trusts the
 * runner for anything but its own usage figures: the run row is opened and closed by the server.
 */

export const RUNNER_ENV = {
  runId: 'BOTLAB_RUN_ID',
  kind: 'BOTLAB_RUN_KIND',
  mcpUrl: 'BOTLAB_MCP_URL',
  agentToken: 'BOTLAB_AGENT_TOKEN',
  model: 'BOTLAB_AGENT_MODEL',
  maxTurns: 'BOTLAB_AGENT_MAX_TURNS',
  maxCostUsd: 'BOTLAB_AGENT_MAX_COST_USD',
  timeoutMs: 'BOTLAB_AGENT_TIMEOUT_MS',
  /** JSON array of AgentTrigger (event runs) */
  context: 'BOTLAB_RUN_CONTEXT',
  /** Working directory for the SDK session (empty, inside the data dir) */
  workDir: 'BOTLAB_AGENT_WORKDIR',
} as const;

export type RunnerKind = 'review' | 'cycle' | 'event';

export interface RunnerUsage {
  /** Input tokens incl. cache reads / writes */
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** true until the SDK's final result (cost estimated from per-message usage and list prices) */
  estimated: boolean;
}

export type RunnerOutcomeStatus = 'ok' | 'error' | 'aborted' | 'timeout';

export type RunnerMessage =
  | { type: 'started'; promptVersion: string; model: string }
  | ({ type: 'usage' } & RunnerUsage)
  | { type: 'tool'; name: string; target: string | null }
  | { type: 'log'; text: string }
  | { type: 'done'; status: RunnerOutcomeStatus; reason: string; numTurns: number | null; usage: RunnerUsage };

export type ServerMessage = { type: 'abort'; reason: 'timeout' | 'shutdown' | 'cancelled' };

export function isRunnerMessage(v: unknown): v is RunnerMessage {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}
