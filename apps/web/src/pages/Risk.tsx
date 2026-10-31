import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { auditApi } from '../lib/api';
import { ConfigEditor } from '../components/ConfigEditor';
import { ClearHaltButton, HaltBanner, KillSwitchButton } from '../components/HaltControls';
import { Badge, Card, Empty, ErrorBox, PageHeader, Tabs, tdCls, thCls } from '../components/ui';
import { useOverview, useRiskState } from '../hooks/useRisk';
import { dateTime, errorMessage } from '../lib/format';
import type { AuditPage } from '../types';

type Tab = 'limits' | 'mandate' | 'categories' | 'fees' | 'server' | 'halts';
/** `#/risk?tab=server` opens a tab directly (the Agent page links to the server.yaml editor) */
const TABS: Tab[] = ['limits', 'mandate', 'categories', 'fees', 'server', 'halts'];

/**
 * Risk page (spec §12): editors for the human-owned config files (limits, mandate, category mapping,
 * fees, server) generated from their zod schemas, config history with diff + restore, current halts
 * with "clear halt", and the halt history from the audit log.
 */
export function Risk() {
  const [params] = useSearchParams();
  const initial = params.get('tab');
  const [tab, setTab] = useState<Tab>(TABS.includes(initial as Tab) ? (initial as Tab) : 'limits');
  return (
    <div className="space-y-6">
      <PageHeader title="Risk" subtitle="Limits, mandate and halts. Every change is validated, audited and kept in history." actions={<KillSwitchButton />} />
      <Tabs<Tab>
        tabs={[
          { id: 'limits', label: 'Limits' },
          { id: 'mandate', label: 'Mandate' },
          { id: 'categories', label: 'Categories' },
          { id: 'fees', label: 'Fees' },
          { id: 'server', label: 'Server' },
          { id: 'halts', label: 'Halts' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'limits' && (
        <ConfigEditor
          key="limits"
          file="limits"
          intro={
            <>
              <p>
                Global, per-bot, per-market and order limits, the ramp, and the <strong>live trading switch</strong> (<code>live_trading.enabled</code>).
                Raising any limit takes effect immediately and sends a Telegram confirmation.
              </p>
            </>
          }
        />
      )}
      {tab === 'mandate' && (
        <ConfigEditor
          key="mandate"
          file="mandate"
          intro={
            <p>
              What may be traded: budget, allowed / later / denied categories, horizon and liquidity, strategies. Only <code>allow</code> categories can ever
              trade.
            </p>
          }
        />
      )}
      {tab === 'categories' && (
        <ConfigEditor
          key="categories"
          file="categories"
          defaultMode="yaml"
          intro={
            <p>
              Market → category mapping: ordered rules, first match wins (denied categories first). Any edit counts as raising risk. Unmapped markets are{' '}
              <code>other</code>.
            </p>
          }
        />
      )}
      {tab === 'fees' && (
        <ConfigEditor
          key="fees"
          file="fees"
          intro={<p>Assumed taker / maker fee rates per fee category. Lowering an assumed rate counts as raising risk.</p>}
        />
      )}
      {tab === 'server' && (
        <ConfigEditor
          key="server"
          file="server"
          intro={<p>Time zone and digest, HTTP bind (restart to apply), order-book recorder, the scheduled agent (agent.enabled, model, schedule; ANTHROPIC_API_KEY comes from the environment), Telegram. Telegram is also on the Settings page.</p>}
        />
      )}
      {tab === 'halts' && <Halts />}
    </div>
  );
}

function Halts() {
  const { data: overview } = useOverview();
  const { data: state, error } = useRiskState();
  const [before, setBefore] = useState<number | undefined>(undefined);
  const history = useQuery({
    queryKey: ['audit', 'halts', before],
    queryFn: async () => (await auditApi.list({ actionPrefix: 'risk.', limit: 50, before })) as AuditPage,
  });
  const halted = state?.bots.filter((b) => b.halted) ?? [];
  return (
    <div className="space-y-6">
      <ErrorBox>{error ? errorMessage(error) : null}</ErrorBox>
      {overview && <HaltBanner global={overview.halts.global} bots={overview.halts.bots} />}
      {state && !state.global?.halted && halted.length === 0 && (
        <Card title="Current halts">
          <Empty>Nothing is halted.</Empty>
        </Card>
      )}
      {state && (
        <Card title="Bots: today's P&L and halt state">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-[#2a2a2a]">
              <thead>
                <tr>
                  <th className={thCls}>Bot</th>
                  <th className={thCls}>Stage</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Day P&L</th>
                  <th className={thCls}>Halt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2a2a2a]">
                {state.bots.map((b) => (
                  <tr key={b.botId}>
                    <td className={tdCls}>
                      <Link to={`/bots/${b.botId}`} className="text-accent hover:text-accent-hover">
                        {b.name}
                      </Link>{' '}
                      <span className="text-xs text-gray-500">{b.mode}</span>
                    </td>
                    <td className={tdCls}>{b.stage}</td>
                    <td className={tdCls}>{b.status}</td>
                    <td className={`${tdCls} tabular-nums`}>{(b.dayRealizedPnl + b.dayUnrealizedPnl).toFixed(2)}</td>
                    <td className={tdCls}>
                      {b.halted ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone="red" title={b.haltReason ?? undefined}>
                            halted
                          </Badge>
                          <span className="text-xs text-gray-400 break-words">{b.haltReason}</span>
                          <ClearHaltButton scope={b.botId} label="Clear" />
                        </div>
                      ) : (
                        <span className="text-gray-500">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {state.bots.length === 0 && <Empty>No bots.</Empty>}
          </div>
        </Card>
      )}
      <Card title="Halt history (audit log, risk.*)">
        <ErrorBox>{history.error ? errorMessage(history.error) : null}</ErrorBox>
        {history.data && history.data.entries.length === 0 && <Empty>No halts recorded.</Empty>}
        <ul className="divide-y divide-[#2a2a2a]">
          {history.data?.entries.map((e) => {
            const p = (e.payload ?? {}) as Record<string, unknown>;
            return (
              <li key={e.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-gray-400">{dateTime(e.ts)}</span>
                  <Badge tone={e.action === 'risk.halt_clear' ? 'green' : e.action.includes('halt') || e.action.includes('kill') ? 'red' : 'gray'}>
                    {e.action}
                  </Badge>
                  <span className="text-gray-300">{e.target === 'global' ? 'global' : e.target}</span>
                  <span className="text-gray-500">by {e.actor}</span>
                  {e.result && e.result !== 'ok' && <span className="text-xs text-yellow-400">{e.result}</span>}
                </div>
                {typeof p.reason === 'string' && <p className="text-gray-400 break-words mt-0.5">{p.reason}</p>}
              </li>
            );
          })}
        </ul>
        <div className="mt-3 flex gap-2">
          {before !== undefined && (
            <button type="button" className="text-sm text-accent" onClick={() => setBefore(undefined)}>
              ← Newest
            </button>
          )}
          {history.data?.nextBefore != null && (
            <button type="button" className="text-sm text-accent" onClick={() => setBefore(history.data!.nextBefore!)}>
              Older →
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}
