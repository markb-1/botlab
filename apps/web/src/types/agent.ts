/** Agent runs, notes and budget (server: packages/core/src/services/AgentService.ts) */

export interface AgentRunAction {
  tool: string;
  at: string;
  ok: boolean;
  target?: string | null;
}

export interface AgentRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: 'schedule' | 'manual' | 'event';
  /** review (daily), cycle, event (maintenance only) */
  kind: 'review' | 'cycle' | 'event';
  /** Started by the server's runner (scheduled / manual / event), not an interactive client */
  managed: boolean;
  model: string | null;
  durationMs: number | null;
  status: 'running' | 'ok' | 'error' | 'aborted' | 'timeout';
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  summaryMd: string | null;
  toolCalls: number;
  actions: AgentRunAction[];
}

/** One MCP call of a run (from the audit log) */
export interface AgentRunCall {
  id: number;
  ts: string;
  tool: string;
  target: string | null;
  result: string | null;
  ms: number | null;
}

/** GET /api/agent/schedule */
export interface AgentSchedule {
  enabled: boolean;
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

export interface AgentNote {
  id: string;
  scope: string;
  title: string;
  bodyMd: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentBudget {
  month: string;
  monthSpentUsd: number;
  monthlyBudgetUsd: number | null;
  remainingUsd: number | null;
  maxRunCostUsd: number | null;
  maxToolCallsPerRun: number | null;
  maxToolCallsPerHour: number | null;
  runsThisMonth: number;
  botsCreatedLast24h: number;
  maxBotsCreatedPerDay: number | null;
  activeAgentBots: number;
  maxActiveBots: number | null;
  currentRun: AgentRun | null;
  limitsError: string | null;
}

export interface PositionExitFlag {
  id: string;
  botId: string;
  botName: string | null;
  tokenId: string;
  marketId: string | null;
  simulated: boolean;
  reason: string;
  status: 'open' | 'done' | 'cancelled';
  createdBy: string;
  createdAt: string;
  handledAt: string | null;
  handledNote: string | null;
}
