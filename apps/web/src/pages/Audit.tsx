import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { auditApi } from '../lib/api';
import { Badge, Card, Empty, ErrorBox, PageHeader, btnSecondary, inputCls } from '../components/ui';
import { dateTime, errorMessage } from '../lib/format';
import type { AuditEntry, AuditPage } from '../types';

interface Filters {
  actor: string;
  action: string;
  actionPrefix: string;
  target: string;
  since: string;
  until: string;
}

const EMPTY: Filters = { actor: '', action: '', actionPrefix: '', target: '', since: '', until: '' };

/** `datetime-local` value (local time) → ISO */
const toIso = (v: string) => (v ? new Date(v).toISOString() : undefined);

function resultTone(result: string | null) {
  if (!result || result === 'ok') return 'gray' as const;
  if (result.startsWith('denied') || result === 'error' || result.startsWith('failed')) return 'red' as const;
  return 'yellow' as const;
}

/** Audit log (spec §12): filter by actor, action, target and time range; newest first, paged by id */
export function Audit() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [cursors, setCursors] = useState<number[]>([]); // stack of `before` cursors (pages visited)
  const [open, setOpen] = useState<number | null>(null);
  const before = cursors[cursors.length - 1];

  const { data: actions = [] } = useQuery({ queryKey: ['auditActions'], queryFn: () => auditApi.actions(), staleTime: 60_000 });
  const { data, error, isFetching } = useQuery({
    queryKey: ['audit', 'page', filters, before],
    queryFn: async () =>
      (await auditApi.list({
        actor: filters.actor || undefined,
        action: filters.action || undefined,
        actionPrefix: filters.actionPrefix || undefined,
        target: filters.target || undefined,
        since: toIso(filters.since),
        until: toIso(filters.until),
        before,
        limit: 50,
      })) as AuditPage,
  });

  const apply = (e?: React.FormEvent) => {
    e?.preventDefault();
    setFilters(draft);
    setCursors([]);
  };
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft({ ...draft, [k]: e.target.value });

  return (
    <div className="space-y-6">
      <PageHeader title="Audit log" subtitle="Every action by humans, the agent, bots and the system. Append-only." />
      <Card>
        <form onSubmit={apply} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <label className="text-sm text-gray-400">
            Actor (human, agent, system or bot:&lt;id&gt;)
            <input type="text" list="audit-actors" className={`${inputCls} mt-1`} value={draft.actor} onChange={set('actor')} />
            <datalist id="audit-actors">
              <option value="human" />
              <option value="agent" />
              <option value="system" />
            </datalist>
          </label>
          <label className="text-sm text-gray-400">
            Action
            <select className={`${inputCls} mt-1`} value={draft.action} onChange={set('action')}>
              <option value="">any</option>
              {actions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-gray-400">
            Action prefix
            <input type="text" className={`${inputCls} mt-1`} placeholder="e.g. risk. or config." value={draft.actionPrefix} onChange={set('actionPrefix')} />
          </label>
          <label className="text-sm text-gray-400">
            Target (bot id, market, scope …)
            <input type="text" className={`${inputCls} mt-1`} value={draft.target} onChange={set('target')} />
          </label>
          <label className="text-sm text-gray-400">
            From
            <input type="datetime-local" className={`${inputCls} mt-1`} value={draft.since} onChange={set('since')} />
          </label>
          <label className="text-sm text-gray-400">
            To (exclusive)
            <input type="datetime-local" className={`${inputCls} mt-1`} value={draft.until} onChange={set('until')} />
          </label>
          <div className="sm:col-span-2 lg:col-span-3 flex flex-wrap gap-2 justify-end">
            <button
              type="button"
              className={btnSecondary}
              onClick={() => {
                setDraft(EMPTY);
                setFilters(EMPTY);
                setCursors([]);
              }}
            >
              Reset
            </button>
            <button type="submit" className={btnSecondary}>
              Apply filters
            </button>
          </div>
        </form>
      </Card>

      <Card
        title={`Entries${isFetching ? ' …' : ''}`}
        actions={
          <div className="flex gap-2">
            <button type="button" className={btnSecondary} disabled={cursors.length === 0} onClick={() => setCursors(cursors.slice(0, -1))}>
              ← Newer
            </button>
            <button
              type="button"
              className={btnSecondary}
              disabled={data?.nextBefore == null}
              onClick={() => data?.nextBefore != null && setCursors([...cursors, data.nextBefore])}
            >
              Older →
            </button>
          </div>
        }
      >
        <ErrorBox>{error ? errorMessage(error) : null}</ErrorBox>
        {data && data.entries.length === 0 && <Empty>No entries match.</Empty>}
        <ul className="divide-y divide-[#2a2a2a]">
          {data?.entries.map((e: AuditEntry) => (
            <li key={e.id} className="py-2">
              <button type="button" className="w-full text-left" onClick={() => setOpen(open === e.id ? null : e.id)}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="text-gray-500 tabular-nums">{dateTime(e.ts)}</span>
                  <span className="font-mono text-gray-100">{e.action}</span>
                  <Badge tone={e.actor === 'human' ? 'blue' : e.actor === 'agent' ? 'purple' : e.actor.startsWith('bot:') ? 'orange' : 'gray'}>{e.actor}</Badge>
                  {e.target && <span className="text-gray-400 font-mono text-xs break-all">{e.target}</span>}
                  {e.result && <Badge tone={resultTone(e.result)}>{e.result.length > 60 ? `${e.result.slice(0, 60)}…` : e.result}</Badge>}
                </div>
              </button>
              {open === e.id && (
                <pre className="mt-2 p-3 bg-[#111] rounded-lg text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify({ id: e.id, result: e.result, payload: e.payload }, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
