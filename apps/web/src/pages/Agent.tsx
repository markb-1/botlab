import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { agentApi } from '../lib/api';
import { Badge, Card, ConfirmDialog, Empty, ErrorBox, Facts, LimitBar, Notice, PageHeader, Tabs, btnSecondary, inputCls, tdCls, thCls } from '../components/ui';
import { dateTime, errorMessage, relTime, usd } from '../lib/format';
import type { AgentBudget, AgentNote, AgentRun, PositionExitFlag } from '../types';

type Tab = 'runs' | 'notes' | 'flags';

function statusTone(s: AgentRun['status']) {
  if (s === 'ok') return 'green' as const;
  if (s === 'running') return 'blue' as const;
  if (s === 'timeout' || s === 'aborted') return 'yellow' as const;
  return 'red' as const;
}

/** Summary text as preformatted markdown (rendered as text: it is written by the agent) */
function Markdown({ text }: { text: string | null }) {
  if (!text) return <span className="text-gray-500">—</span>;
  return <pre className="whitespace-pre-wrap break-words text-sm text-gray-200 font-sans">{text}</pre>;
}

function BudgetCard({ budget }: { budget: AgentBudget }) {
  return (
    <Card title={`Budget ${budget.month}`}>
      <div className="space-y-4">
        {budget.limitsError && <Notice tone="red">{budget.limitsError}: the agent cannot start runs or create bots.</Notice>}
        <LimitBar
          label="LLM spend this month"
          value={budget.monthSpentUsd}
          limit={budget.monthlyBudgetUsd}
          format={(n) => usd(n)}
          hint="Cost recorded by the agent runner; runs are refused once the monthly budget is reached (agent.monthly_llm_budget_usd). Interactive use from Claude Code / Desktop is not cost-tracked here."
        />
        <LimitBar
          label="Bots created (last 24 h)"
          value={budget.botsCreatedLast24h}
          limit={budget.maxBotsCreatedPerDay}
          format={(n) => (n === null ? '—' : String(n))}
        />
        <LimitBar label="Agent bots not retired" value={budget.activeAgentBots} limit={budget.maxActiveBots} format={(n) => (n === null ? '—' : String(n))} />
        <Facts
          items={[
            ['Runs this month', budget.runsThisMonth],
            [
              'Per run',
              `${usd(budget.maxRunCostUsd)} · ${budget.maxToolCallsPerRun ?? '—'} tool calls; ${budget.maxToolCallsPerHour ?? '—'} calls per hour per token`,
            ],
            [
              'Current run',
              budget.currentRun
                ? `${budget.currentRun.trigger}, started ${relTime(budget.currentRun.startedAt)} (${budget.currentRun.toolCalls} calls)`
                : 'none',
            ],
            [
              'Agent access',
              <span key="t">
                MCP at <code>/mcp</code> with an agent token —{' '}
                <Link to="/settings" className="text-accent hover:underline">
                  manage API tokens
                </Link>
              </span>,
            ],
          ]}
        />
      </div>
    </Card>
  );
}

function RunRow({ run }: { run: AgentRun }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-t border-[#222] cursor-pointer hover:bg-[#151515]" onClick={() => setOpen(!open)}>
        <td className={tdCls}>{dateTime(run.startedAt)}</td>
        <td className={tdCls}>{run.trigger}</td>
        <td className={tdCls}>
          <Badge tone={statusTone(run.status)}>{run.status}</Badge>
        </td>
        <td className={`${tdCls} tabular-nums`}>{usd(run.costUsd)}</td>
        <td className={`${tdCls} tabular-nums`}>{run.toolCalls}</td>
        <td className={`${tdCls} max-w-[28rem] truncate`}>{run.summaryMd?.split('\n').find((l) => l.trim()) ?? '—'}</td>
      </tr>
      {open && (
        <tr className="bg-[#111]">
          <td className={tdCls} colSpan={6}>
            <div className="space-y-3">
              <Markdown text={run.summaryMd} />
              <p className="text-xs text-gray-500">
                {run.tokensIn.toLocaleString()} tokens in · {run.tokensOut.toLocaleString()} out · finished {dateTime(run.finishedAt)}
              </p>
              {run.actions.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {run.actions.map((a, i) => (
                    <Badge key={i} tone={a.ok ? 'gray' : 'red'} title={`${dateTime(a.at)}${a.target ? ` · ${a.target}` : ''}`}>
                      {a.tool}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Runs() {
  const { data, error } = useQuery({ queryKey: ['agent', 'runs'], queryFn: async () => (await agentApi.runs(50)) as AgentRun[], refetchInterval: 30_000 });
  if (error) return <ErrorBox>{errorMessage(error)}</ErrorBox>;
  if (!data) return <Empty>Loading…</Empty>;
  if (data.length === 0) return <Empty>No agent runs yet.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            <th className={thCls}>Started</th>
            <th className={thCls}>Trigger</th>
            <th className={thCls}>Status</th>
            <th className={thCls}>Cost</th>
            <th className={thCls}>Calls</th>
            <th className={thCls}>Summary</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Notes() {
  const qc = useQueryClient();
  const [scope, setScope] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AgentNote | null>(null);
  const { data, error } = useQuery({
    queryKey: ['agent', 'notes', scope, q],
    queryFn: async () => (await agentApi.notes({ scope: scope || undefined, q: q || undefined, limit: 200 })) as AgentNote[],
  });
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input className={inputCls} placeholder="Scope (general, market:, category:…, strategy:…)" value={scope} onChange={(e) => setScope(e.target.value)} />
        <input className={inputCls} placeholder="Search title / text" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <ErrorBox>{errorMessage(error)}</ErrorBox>}
      {data && data.length === 0 && <Empty>No notes.</Empty>}
      <ul className="divide-y divide-[#222]">
        {data?.map((n) => (
          <li key={n.id} className="py-2">
            <div className="flex items-start justify-between gap-3">
              <button type="button" className="text-left min-w-0" onClick={() => setOpen(open === n.id ? null : n.id)}>
                <div className="text-sm text-gray-100 break-words">{n.title}</div>
                <div className="text-xs text-gray-500">
                  <Badge>{n.scope}</Badge> updated {relTime(n.updatedAt)}
                </div>
              </button>
              <button type="button" className={btnSecondary} onClick={() => setDeleting(n)}>
                Delete
              </button>
            </div>
            {open === n.id && (
              <div className="mt-2 bg-[#111] rounded-lg p-3">
                <Markdown text={n.bodyMd} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {deleting && (
        <ConfirmDialog
          title="Delete note"
          body={`Delete the agent's note "${deleting.title}"?`}
          confirmLabel="Delete"
          danger
          onConfirm={async () => {
            await agentApi.deleteNote(deleting.id);
            await qc.invalidateQueries({ queryKey: ['agent', 'notes'] });
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function ExitFlags() {
  const { data, error } = useQuery({ queryKey: ['agent', 'flags'], queryFn: async () => (await agentApi.exitFlags()) as PositionExitFlag[] });
  if (error) return <ErrorBox>{errorMessage(error)}</ErrorBox>;
  if (!data) return <Empty>Loading…</Empty>;
  if (data.length === 0) return <Empty>No exit flags.</Empty>;
  return (
    <div className="space-y-3">
      <Notice tone="blue">Exit requests for the position manager (Phase 5). Until it runs, act on open flags by hand.</Notice>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className={thCls}>When</th>
              <th className={thCls}>Bot</th>
              <th className={thCls}>Token</th>
              <th className={thCls}>Status</th>
              <th className={thCls}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {data.map((f) => (
              <tr key={f.id} className="border-t border-[#222]">
                <td className={tdCls}>{dateTime(f.createdAt)}</td>
                <td className={tdCls}>
                  <Link to={`/bots/${f.botId}`} className="text-accent hover:underline">
                    {f.botName ?? f.botId}
                  </Link>
                  {f.simulated && <span className="text-gray-500"> (paper)</span>}
                </td>
                <td className={`${tdCls} font-mono text-xs break-all`}>{f.tokenId}</td>
                <td className={tdCls}>
                  <Badge tone={f.status === 'open' ? 'yellow' : 'gray'}>{f.status}</Badge>
                </td>
                <td className={`${tdCls} break-words`}>{f.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Agent (spec §12): run history, memory, budget and exit flags. Scheduled runs and the trigger button come in 4b. */
export function Agent() {
  const [tab, setTab] = useState<Tab>('runs');
  const { data: budget, error } = useQuery({
    queryKey: ['agent', 'budget'],
    queryFn: async () => (await agentApi.budget()) as AgentBudget,
    refetchInterval: 30_000,
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Agent"
        subtitle="The AI agent works through MCP with an agent token: paper bots, forecasts, notes. It cannot change limits, wallets or credentials."
      />
      {error && <ErrorBox>{errorMessage(error)}</ErrorBox>}
      {budget && <BudgetCard budget={budget} />}
      <Card>
        <Tabs
          tabs={[
            { id: 'runs', label: 'Runs' },
            { id: 'notes', label: 'Notes' },
            { id: 'flags', label: 'Exit flags' },
          ]}
          active={tab}
          onChange={setTab}
        />
        <div className="pt-4">
          {tab === 'runs' && <Runs />}
          {tab === 'notes' && <Notes />}
          {tab === 'flags' && <ExitFlags />}
        </div>
      </Card>
    </div>
  );
}
