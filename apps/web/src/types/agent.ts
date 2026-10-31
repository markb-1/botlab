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
  status: 'running' | 'ok' | 'error' | 'aborted' | 'timeout';
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  summaryMd: string | null;
  toolCalls: number;
  actions: AgentRunAction[];
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
