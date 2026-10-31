import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ledgerApi } from '../lib/api';
import { calibration } from '../lib/calibration';
import {
  Badge,
  Card,
  ConfirmDialog,
  Empty,
  ErrorBox,
  Facts,
  Modal,
  Notice,
  PageHeader,
  RightsBadge,
  Tabs,
  btnPrimary,
  btnSecondary,
  inputCls,
  tdCls,
  thCls,
} from '../components/ui';
import { dateOnly, dateTime, errorMessage, num, pct, shortId, usd } from '../lib/format';
import type { BucketStats, Forecast } from '../types';

type Tab = 'forecasts' | 'rights' | 'calibration' | 'submit';

const STATUS_TONE: Record<string, 'green' | 'gray' | 'yellow' | 'blue' | 'red'> = {
  active: 'green',
  superseded: 'gray',
  withdrawn: 'yellow',
  resolved: 'blue',
  void: 'red',
};

/** Forecast ledger (spec §6, §12): forecasts, category rights per (category, horizon), calibration, manual forecasts */
export function Ledger() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'forecasts';
  const setTab = (t: Tab) =>
    setParams((p) => {
      p.set('tab', t);
      return p;
    });
  const { data: stats = [], error: statsError } = useQuery({
    queryKey: ['ledgerStats'],
    queryFn: async () => (await ledgerApi.stats()) as BucketStats[],
    refetchInterval: 60_000,
  });
  return (
    <div className="space-y-6">
      <PageHeader title="Ledger" subtitle="Forecasts, scoring and the category rights they earn" />
      <Tabs<Tab>
        tabs={[
          { id: 'forecasts', label: 'Forecasts' },
          { id: 'rights', label: 'Category rights' },
          { id: 'calibration', label: 'Calibration' },
          { id: 'submit', label: 'Submit forecast' },
        ]}
        active={tab}
        onChange={setTab}
      />
      <ErrorBox>{statsError ? errorMessage(statsError) : null}</ErrorBox>
      {tab === 'forecasts' && <Forecasts stats={stats} />}
      {tab === 'rights' && <Rights stats={stats} />}
      {tab === 'calibration' && <Calibration />}
      {tab === 'submit' && <SubmitForecast />}
    </div>
  );
}

function Forecasts({ stats }: { stats: BucketStats[] }) {
  const [status, setStatus] = useState('active');
  const [category, setCategory] = useState('');
  const [bucket, setBucket] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const categories = useMemo(() => [...new Set(stats.map((s) => s.category))].sort(), [stats]);
  const {
    data = [],
    error,
    isFetching,
  } = useQuery({
    queryKey: ['forecasts', status, category, bucket],
    queryFn: async () =>
      (await ledgerApi.list({ status: status || undefined, category: category || undefined, horizonBucket: bucket || undefined, limit: 500 })) as Forecast[],
  });
  return (
    <Card
      title={`Forecasts${isFetching ? ' …' : ''} (${data.length})`}
      actions={
        <div className="flex flex-wrap gap-2">
          <select className={`${inputCls} w-auto`} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">any status</option>
            {['active', 'superseded', 'withdrawn', 'resolved', 'void'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select className={`${inputCls} w-auto`} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="">any category</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select className={`${inputCls} w-auto`} value={bucket} onChange={(e) => setBucket(e.target.value)} aria-label="Horizon bucket">
            <option value="">any horizon</option>
            {['short', 'medium', 'long'].map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
      }
    >
      <ErrorBox>{error ? errorMessage(error) : null}</ErrorBox>
      {data.length === 0 ? (
        <Empty>No forecasts match.</Empty>
      ) : (
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="min-w-full divide-y divide-[#2a2a2a]">
            <thead>
              <tr>
                <th className={thCls}>Created</th>
                <th className={thCls}>Market / token</th>
                <th className={thCls}>Category</th>
                <th className={thCls}>p</th>
                <th className={thCls}>Mid</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>Skill</th>
                <th className={thCls}>By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2a2a2a]">
              {data.map((f) => (
                <tr key={f.id} className="hover:bg-surface-light cursor-pointer" onClick={() => setOpenId(f.id)}>
                  <td className={`${tdCls} whitespace-nowrap`}>{dateOnly(f.createdAt)}</td>
                  <td className={`${tdCls} font-mono text-xs`}>
                    {shortId(f.marketId)}
                    <br />
                    <span className="text-gray-500">{shortId(f.tokenId)}</span>
                  </td>
                  <td className={tdCls}>
                    {f.category} <span className="text-xs text-gray-500">{f.horizonBucket}</span>
                    {f.tradeable && (
                      <span className="ml-1">
                        <Badge tone="green">tradeable</Badge>
                      </span>
                    )}
                  </td>
                  <td className={`${tdCls} tabular-nums`}>{pct(f.probability)}</td>
                  <td className={`${tdCls} tabular-nums`}>{pct(f.marketPriceAtForecast)}</td>
                  <td className={tdCls}>
                    <Badge tone={STATUS_TONE[f.status] ?? 'gray'}>{f.status}</Badge>
                  </td>
                  <td className={`${tdCls} tabular-nums ${f.skill === null ? 'text-gray-500' : f.skill >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {num(f.skill)}
                  </td>
                  <td className={tdCls}>{f.createdBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId && <ForecastDetail id={openId} onClose={() => setOpenId(null)} />}
    </Card>
  );
}

/** Forecast with rationale, sources and scores; active forecasts can be withdrawn */
export function ForecastDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: f, error } = useQuery({ queryKey: ['forecast', id], queryFn: async () => (await ledgerApi.get(id)) as Forecast });
  const [withdraw, setWithdraw] = useState(false);
  return (
    <Modal title="Forecast" onClose={onClose} wide>
      <ErrorBox>{error ? errorMessage(error) : null}</ErrorBox>
      {f && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[f.status] ?? 'gray'}>{f.status}</Badge>
            <Badge tone={f.tradeable ? 'green' : 'gray'}>{f.tradeable ? 'tradeable at forecast' : 'not tradeable at forecast'}</Badge>
            <span className="text-sm text-gray-400">
              {f.category} · {f.horizonBucket} ({f.daysToResolutionAtForecast.toFixed(1)} days to settlement)
            </span>
          </div>
          <Facts
            items={[
              ['Probability (YES of token)', pct(f.probability, 1)],
              ['Market mid at forecast', `${pct(f.marketPriceAtForecast, 1)} (bid ${num(f.bestBid, 3)} / ask ${num(f.bestAsk, 3)})`],
              [
                'Market',
                <Link
                  key="m"
                  to={`/markets?id=${encodeURIComponent(f.marketId)}`}
                  className="text-accent hover:text-accent-hover font-mono text-xs break-all"
                  onClick={onClose}
                >
                  {f.marketId}
                </Link>,
              ],
              [
                'Token',
                <span key="t" className="font-mono text-xs break-all">
                  {f.tokenId}
                </span>,
              ],
              ['Ambiguity score', String(f.ambiguityScore)],
              ['Order-book liquidity at forecast', usd(f.liquidityUsd, 0)],
              ['Created', `${dateTime(f.createdAt)} by ${f.createdBy}`],
              ['Resolved', f.resolvedAt ? `${dateTime(f.resolvedAt)} → outcome ${f.outcome}` : '—'],
              ['Brier (forecast / market)', `${num(f.brierAgent)} / ${num(f.brierMarket)}`],
              ['Skill', num(f.skill)],
              ['Price at 7 days / convergence', `${num(f.priceAt7d)} / ${num(f.convergence)}`],
              ['Withdrawn', f.withdrawnAt ? `${dateTime(f.withdrawnAt)}: ${f.withdrawnReason ?? ''}` : '—'],
            ]}
          />
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase">Rationale</p>
            <p className="mt-1 text-sm text-gray-200 whitespace-pre-wrap break-words">{f.rationale}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase">Sources</p>
            {f.sources.length === 0 ? (
              <p className="text-sm text-gray-500">none</p>
            ) : (
              <ul className="mt-1 list-disc pl-5 text-sm space-y-0.5">
                {f.sources.map((s) => (
                  <li key={s} className="break-all">
                    <a href={s} target="_blank" rel="noreferrer noopener" className="text-accent hover:text-accent-hover">
                      {s}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {f.supersededBy && (
            <p className="text-sm text-gray-400">
              Superseded by <span className="font-mono text-xs">{f.supersededBy}</span>
            </p>
          )}
          {f.status === 'active' && (
            <div className="flex justify-end">
              <button type="button" className={btnSecondary} onClick={() => setWithdraw(true)}>
                Withdraw…
              </button>
            </div>
          )}
          {withdraw && (
            <ConfirmDialog
              title="Withdraw this forecast?"
              confirmLabel="Withdraw"
              reasonLabel="Reason"
              reasonRequired
              body={<p>It is still scored when the market resolves. A new forecast on this token can be written at once.</p>}
              onConfirm={async (reason) => {
                await ledgerApi.withdrawForecast(f.id, reason);
                qc.invalidateQueries({ queryKey: ['forecast', id] });
                qc.invalidateQueries({ queryKey: ['forecasts'] });
              }}
              onClose={() => setWithdraw(false)}
            />
          )}
        </>
      )}
    </Modal>
  );
}

function Rights({ stats }: { stats: BucketStats[] }) {
  const [force, setForce] = useState<BucketStats | null>(null);
  return (
    <Card title="Category rights per (category, horizon)">
      <p className="text-sm text-gray-400 mb-3">
        A bucket trades after ≥ {30} scored events with a skill lower bound above 0 (medium: 20 when the short bucket trades). Expected date = remaining events
        at the scoring rate of the last 30 days.
      </p>
      {stats.length === 0 ? (
        <Empty>No buckets yet. They appear when the first forecast in a category is written.</Empty>
      ) : (
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="min-w-full divide-y divide-[#2a2a2a]">
            <thead>
              <tr>
                <th className={thCls}>Category</th>
                <th className={thCls}>Horizon</th>
                <th className={thCls}>State</th>
                <th className={thCls}>Mandate</th>
                <th className={thCls}>Scored</th>
                <th className={thCls}>Skill mean / LB</th>
                <th className={thCls}>Convergence mean / LB</th>
                <th className={thCls}>Max alloc.</th>
                <th className={thCls}>Expected threshold</th>
                <th className={thCls}></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2a2a2a]">
              {stats.map((s) => (
                <tr key={`${s.category}|${s.horizonBucket}`}>
                  <td className={tdCls}>{s.category}</td>
                  <td className={tdCls}>{s.horizonBucket}</td>
                  <td className={tdCls}>
                    <RightsBadge state={s.state} forced={s.forced} />
                    {s.changedReason && <p className="text-xs text-gray-500 mt-0.5 max-w-[16rem] break-words">{s.changedReason}</p>}
                  </td>
                  <td className={tdCls}>
                    <Badge tone={s.mandate === 'allow' ? 'green' : s.mandate === 'deny' ? 'red' : 'gray'}>{s.mandate}</Badge>
                  </td>
                  <td className={`${tdCls} tabular-nums`}>
                    {s.nScored} / {s.threshold.required}
                  </td>
                  <td className={`${tdCls} tabular-nums`}>
                    {num(s.skillMean)} /{' '}
                    <span className={s.skillLowerBound !== null && s.skillLowerBound > 0 ? 'text-green-400' : ''}>{num(s.skillLowerBound)}</span>
                  </td>
                  <td className={`${tdCls} tabular-nums`}>
                    {num(s.convergenceMean)} / {num(s.convergenceLowerBound)} <span className="text-xs text-gray-500">n={s.nConvergence}</span>
                  </td>
                  <td className={`${tdCls} tabular-nums`}>{usd(s.maxAllocationUsd, 0)}</td>
                  <td className={tdCls}>
                    {s.threshold.remaining === 0 ? (
                      <span className="text-green-400">reached</span>
                    ) : s.threshold.expectedAt ? (
                      <span>
                        {dateOnly(s.threshold.expectedAt)} <span className="text-xs text-gray-500">({s.threshold.ratePerDay.toFixed(2)}/day)</span>
                      </span>
                    ) : (
                      <span className="text-gray-500">no recent scoring</span>
                    )}
                  </td>
                  <td className={tdCls}>
                    <button type="button" className="text-sm text-accent hover:text-accent-hover whitespace-nowrap" onClick={() => setForce(s)}>
                      Force state…
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {force && <ForceState bucket={force} onClose={() => setForce(null)} />}
    </Card>
  );
}

function ForceState({ bucket, onClose }: { bucket: BucketStats; onClose: () => void }) {
  const qc = useQueryClient();
  const [state, setState] = useState<string>('auto');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await ledgerApi.setRightsState(bucket.category, bucket.horizonBucket, state, reason.trim());
      qc.invalidateQueries({ queryKey: ['ledgerStats'] });
      qc.invalidateQueries({ queryKey: ['overview'] });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Force rights: ${bucket.category} · ${bucket.horizonBucket}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnSecondary} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !reason.trim()} onClick={submit}>
            {busy ? 'Saving…' : 'Apply'}
          </button>
        </>
      }
    >
      <p className="text-sm text-gray-400">
        Currently <RightsBadge state={bucket.state} forced={bucket.forced} />. A forced state blocks automatic promotion and deprioritisation; suspension and
        the mandate rule still apply. <strong>auto</strong> hands the bucket back to the rules and runs them at once (a forced <strong>trading</strong> bucket restarts from shadow and trades again only if its record qualifies). Forcing <strong>trading</strong> is refused unless the category
        is in the mandate allow list.
      </p>
      {state === 'trading' && (
        <Notice tone="red">Forcing trading lets ledger-driven bots buy in this bucket (allocation at least $50) without the scored track record.</Notice>
      )}
      <label className="block text-sm text-gray-400">
        State
        <select className={`${inputCls} mt-1`} value={state} onChange={(e) => setState(e.target.value)}>
          {['auto', 'shadow', 'trading', 'suspended', 'deprioritised'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm text-gray-400">
        Reason (required)
        <textarea className={`${inputCls} mt-1`} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <ErrorBox>{error}</ErrorBox>
    </Modal>
  );
}

function Calibration() {
  const { data = [], error } = useQuery({
    queryKey: ['forecasts', 'scored'],
    queryFn: async () => (await ledgerApi.list({ status: ['resolved', 'superseded', 'withdrawn'], limit: 5000 })) as Forecast[],
  });
  const c = useMemo(() => calibration(data), [data]);
  const W = 300;
  const H = 300;
  return (
    <Card title="Calibration (scored forecasts)">
      <ErrorBox>{error ? errorMessage(error) : null}</ErrorBox>
      {c.n === 0 ? (
        <Empty>No scored forecasts yet.</Empty>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            {c.n} scored · mean Brier {num(c.brierAgent)} (market {num(c.brierMarket)}) · mean skill {num(c.meanSkill)}
          </p>
          <div className="flex flex-col lg:flex-row gap-6">
            <svg viewBox={`-30 -10 ${W + 40} ${H + 40}`} className="w-full max-w-sm" role="img" aria-label="Predicted probability vs observed frequency">
              <rect x={0} y={0} width={W} height={H} fill="#111" />
              {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                <g key={t}>
                  <line x1={0} x2={W} y1={H - t * H} y2={H - t * H} stroke="#222" />
                  <text x={-6} y={H - t * H + 4} fontSize={10} fill="#666" textAnchor="end">
                    {t}
                  </text>
                  <text x={t * W} y={H + 14} fontSize={10} fill="#666" textAnchor="middle">
                    {t}
                  </text>
                </g>
              ))}
              <line x1={0} y1={H} x2={W} y2={0} stroke="#555" strokeDasharray="4 4" />
              {c.buckets.map((b, i) =>
                b.n > 0 && b.observed !== null ? (
                  <rect
                    key={i}
                    x={b.from * W + 3}
                    width={W / c.buckets.length - 6}
                    y={H - b.observed * H}
                    height={b.observed * H}
                    fill="#e8622c"
                    fillOpacity={0.75}
                  >
                    <title>{`${pct(b.from)}–${pct(b.to)}: observed ${pct(b.observed)} over ${b.n}`}</title>
                  </rect>
                ) : null
              )}
              {c.buckets.map((b, i) =>
                b.meanForecast !== null ? <circle key={`p${i}`} cx={b.meanForecast * W} cy={H - b.meanForecast * H} r={3} fill="#9ca3af" /> : null
              )}
              <text x={W / 2} y={H + 28} fontSize={10} fill="#888" textAnchor="middle">
                predicted probability
              </text>
            </svg>
            <div className="overflow-x-auto flex-1">
              <table className="min-w-full divide-y divide-[#2a2a2a]">
                <thead>
                  <tr>
                    <th className={thCls}>Bucket</th>
                    <th className={thCls}>n</th>
                    <th className={thCls}>Mean forecast</th>
                    <th className={thCls}>Observed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2a2a2a]">
                  {c.buckets.map((b) => (
                    <tr key={b.from}>
                      <td className={tdCls}>
                        {pct(b.from)}–{pct(b.to)}
                      </td>
                      <td className={`${tdCls} tabular-nums`}>{b.n}</td>
                      <td className={`${tdCls} tabular-nums`}>{pct(b.meanForecast, 1)}</td>
                      <td className={`${tdCls} tabular-nums`}>{pct(b.observed, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-xs text-gray-500">Bars: observed YES frequency per bucket; dots: mean predicted probability; dashed line: perfect calibration.</p>
        </div>
      )}
    </Card>
  );
}

function SubmitForecast() {
  const qc = useQueryClient();
  const [tokenId, setTokenId] = useState('');
  const [probability, setProbability] = useState('');
  const [ambiguity, setAmbiguity] = useState('0');
  const [rationale, setRationale] = useState('');
  const [sources, setSources] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Forecast | null>(null);
  const p = Number(probability);
  const valid = tokenId.trim() !== '' && Number.isFinite(p) && p >= 0.01 && p <= 0.99 && rationale.trim() !== '';
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const f = (await ledgerApi.submitForecast({
        tokenId: tokenId.trim(),
        probability: p,
        rationale: rationale.trim(),
        sources: sources
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        ambiguityScore: Number(ambiguity),
      })) as Forecast;
      setCreated(f);
      qc.invalidateQueries({ queryKey: ['forecasts'] });
      qc.invalidateQueries({ queryKey: ['ledgerStats'] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Submit a forecast (human)">
      <form onSubmit={submit} className="space-y-3 max-w-2xl">
        <p className="text-sm text-gray-400">
          The probability that the token resolves YES. The server captures the market price, checks spread, 24 h volume (min_liquidity_usd) and UMA status, and files the forecast in
          its (category, horizon) bucket. A token’s active forecast can be superseded after 6 hours.
        </p>
        <label className="block text-sm text-gray-400">
          Token id (CLOB)
          <input type="text" className={`${inputCls} mt-1 font-mono`} value={tokenId} onChange={(e) => setTokenId(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm text-gray-400">
            Probability (0.01–0.99)
            <input type="text" inputMode="decimal" className={`${inputCls} mt-1`} value={probability} onChange={(e) => setProbability(e.target.value)} />
          </label>
          <label className="block text-sm text-gray-400">
            Ambiguity of the rules (0–3)
            <select className={`${inputCls} mt-1`} value={ambiguity} onChange={(e) => setAmbiguity(e.target.value)}>
              {['0', '1', '2', '3'].map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block text-sm text-gray-400">
          Rationale
          <textarea className={`${inputCls} mt-1`} rows={5} value={rationale} onChange={(e) => setRationale(e.target.value)} />
        </label>
        <label className="block text-sm text-gray-400">
          Sources (http(s) URLs, one per line)
          <textarea className={`${inputCls} mt-1 font-mono text-xs`} rows={3} value={sources} onChange={(e) => setSources(e.target.value)} />
        </label>
        <ErrorBox>{error}</ErrorBox>
        {created && (
          <Notice tone="green">
            Forecast recorded in {created.category} · {created.horizonBucket} at mid {pct(created.marketPriceAtForecast, 1)}
            {created.tradeable ? ' (tradeable)' : ' (shadow: not tradeable yet)'}.
          </Notice>
        )}
        <div className="flex justify-end">
          <button type="submit" className={btnPrimary} disabled={!valid || busy}>
            {busy ? 'Submitting…' : 'Submit forecast'}
          </button>
        </div>
      </form>
    </Card>
  );
}
