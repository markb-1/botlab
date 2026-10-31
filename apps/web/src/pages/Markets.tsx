import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { marketApi, reconcileApi } from '../lib/api';
import { useConfig } from '../hooks/useRisk';
import { Badge, Card, ConfirmDialog, Empty, ErrorBox, Facts, Notice, PageHeader, btnPrimary, btnSecondary, inputCls, tdCls, thCls } from '../components/ui';
import { dateOnly, dateTime, errorMessage, shortId, usd } from '../lib/format';
import type { MarketSearchRow, MarketView, WatchlistEntry } from '../types';

/**
 * Markets (spec §6, §7.4, §10): search the market cache, view rules / category / ambiguity / rules
 * changes / disputes, set the human ambiguity assessment (required before any buy, R51), and manage the
 * order-book recorder watchlist.
 */
export function Markets() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('id');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const select = (id: string | null) =>
    setParams((p) => {
      if (id) p.set('id', id);
      else p.delete('id');
      return p;
    });
  const {
    data: rows = [],
    error,
    isFetching,
  } = useQuery({
    queryKey: ['marketSearch', query],
    queryFn: async () => (await marketApi.search(query, 100)) as MarketSearchRow[],
  });
  const looksLikeId = /^0x[0-9a-fA-F]{64}$/.test(q.trim());
  return (
    <div className="space-y-6">
      <PageHeader title="Markets" subtitle="Cached Polymarket markets: rules, category, ambiguity. A market must be assessed before any bot may buy it." />
      <Card>
        <form
          className="flex flex-col sm:flex-row gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (looksLikeId) select(q.trim());
            else setQuery(q.trim());
          }}
        >
          <input
            type="text"
            className={inputCls}
            placeholder="Search question / event / slug, or paste a condition id (0x…) or token id"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit" className={btnPrimary}>
            {looksLikeId ? 'Open market' : 'Search'}
          </button>
        </form>
        <p className="mt-2 text-xs text-gray-500">
          Search covers markets already in the cache (held, ordered, forecast or opened before). Paste a condition id to fetch any market from Gamma.
        </p>
      </Card>

      {selected && <MarketDetail id={selected} onClose={() => select(null)} />}

      <Card title={`Cached markets${isFetching ? ' …' : ''}`}>
        <ErrorBox>{error ? errorMessage(error) : null}</ErrorBox>
        {rows.length === 0 ? (
          <Empty>{query ? 'No cached market matches.' : 'The cache is empty.'}</Empty>
        ) : (
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="min-w-full divide-y divide-[#2a2a2a]">
              <thead>
                <tr>
                  <th className={thCls}>Question</th>
                  <th className={thCls}>Category</th>
                  <th className={thCls}>Ends</th>
                  <th className={thCls}>Ambiguity</th>
                  <th className={thCls}>Flags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2a2a2a]">
                {rows.map((m) => (
                  <tr key={m.marketId} className="hover:bg-surface-light cursor-pointer" onClick={() => select(m.marketId)}>
                    <td className={`${tdCls} max-w-md`}>{m.question}</td>
                    <td className={tdCls}>{m.category}</td>
                    <td className={`${tdCls} whitespace-nowrap`}>{dateOnly(m.endDate)}</td>
                    <td className={tdCls}>{m.ambiguityScore === null ? <Badge tone="yellow">not assessed</Badge> : m.ambiguityScore}</td>
                    <td className={tdCls}>
                      <div className="flex flex-wrap gap-1">
                        {m.closed && <Badge>closed</Badge>}
                        {m.rulesChangedAt && <Badge tone="red">rules changed</Badge>}
                        {m.disputed && <Badge tone="red">disputed</Badge>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Watchlist />
    </div>
  );
}

function MarketDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: m, error, isLoading } = useQuery({ queryKey: ['market', id], queryFn: async () => (await marketApi.get(id)) as MarketView | null });
  const { data: watch = [] } = useQuery({ queryKey: ['watchlist'], queryFn: async () => (await reconcileApi.watchlistList()) as WatchlistEntry[] });
  const watched = new Set(watch.map((w) => w.token_id));
  const toggleWatch = async (tokenId: string) => {
    if (watched.has(tokenId)) await reconcileApi.watchlistRemove(tokenId);
    else await reconcileApi.watchlistAdd(tokenId, id, m?.question.slice(0, 200));
    qc.invalidateQueries({ queryKey: ['watchlist'] });
  };
  return (
    <Card
      title={m ? m.question : 'Market'}
      actions={
        <button type="button" className={btnSecondary} onClick={onClose}>
          Close
        </button>
      }
    >
      <ErrorBox>{error ? errorMessage(error) : null}</ErrorBox>
      {isLoading && <p className="text-sm text-gray-500">Loading (fetching from Gamma if not cached)…</p>}
      {!isLoading && !m && !error && <Empty>Market not found.</Empty>}
      {m && (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2">
            <Badge tone="blue">{m.category}</Badge>
            {m.closed ? <Badge>closed</Badge> : m.active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}
            {m.rulesChangedAt && <Badge tone="red">rules changed {dateTime(m.rulesChangedAt)}</Badge>}
            {m.disputed && <Badge tone="red">UMA dispute</Badge>}
            {m.umaResolutionStatus && <Badge tone="yellow">UMA: {m.umaResolutionStatus}</Badge>}
            {m.negRisk && <Badge>neg-risk</Badge>}
          </div>
          <Facts
            items={[
              ['Event', m.eventTitle ?? '—'],
              [
                'Condition id',
                <span key="c" className="font-mono text-xs break-all">
                  {m.marketId}
                </span>,
              ],
              ['Ends', dateTime(m.endDate)],
              ['Fee category', m.feeCategory ?? 'unknown (highest rate assumed)'],
              ['Liquidity / 24 h volume', `${usd(m.liquidityUsd, 0)} / ${usd(m.volume24hUsd, 0)}`],
              ['Tags', m.tags.join(', ') || '—'],
              ['Cached', dateTime(m.updatedAt)],
              ['Outcome prices', m.outcomePrices?.join(' / ') ?? '—'],
            ]}
          />

          <div>
            <p className="text-xs font-medium text-gray-500 uppercase">Tokens</p>
            <ul className="mt-1 space-y-1">
              {m.tokens.map((t) => (
                <li key={t.tokenId} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone="purple">{t.outcome}</Badge>
                  <span className="font-mono text-xs text-gray-400 break-all">{t.tokenId}</span>
                  <button type="button" className="text-xs text-accent hover:text-accent-hover" onClick={() => toggleWatch(t.tokenId)}>
                    {watched.has(t.tokenId) ? 'Stop recording' : 'Record order book'}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="text-xs font-medium text-gray-500 uppercase">Resolution rules</p>
            {m.rulesChangedAt && (
              <div className="mt-1">
                <Notice tone="red">
                  The rules text changed on {dateTime(m.rulesChangedAt)}: the effective ambiguity is raised to ≥ 2 for 7 days (buys blocked).
                </Notice>
              </div>
            )}
            <pre className="mt-1 p-3 bg-[#111] rounded-lg text-xs text-gray-300 whitespace-pre-wrap break-words max-h-80 overflow-y-auto">
              {m.rulesText ?? '(no rules text)'}
            </pre>
          </div>

          <AmbiguityForm market={m} />
        </div>
      )}
    </Card>
  );
}

function AmbiguityForm({ market }: { market: MarketView }) {
  const qc = useQueryClient();
  // No default: the score must be an explicit choice (an unassessed market blocks buys, R51)
  const [score, setScore] = useState('');
  const [note, setNote] = useState(market.ambiguityNote ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const { data: cfg } = useConfig();
  const maxAllowed = (cfg?.config?.mandate as { markets?: { max_ambiguity_score?: number } } | undefined)?.markets?.max_ambiguity_score ?? null;

  /** Reasons to confirm: the score unblocks buys, or lowers the current assessment */
  const confirmReasons = (n: number): string[] => {
    const reasons: string[] = [];
    if (maxAllowed === null) reasons.push('The mandate could not be read, so it is unknown whether this score allows buys.');
    else if (n <= maxAllowed)
      reasons.push(
        `A score of ${n} is within the mandate's max_ambiguity_score (${maxAllowed}): bots may buy this market${market.ambiguityScore !== null && market.ambiguityScore > n ? ` once the server raise (${market.ambiguityRaisedBecause ?? 'rules change / dispute'}) lapses` : ''}.`
      );
    if (market.assessedAmbiguity !== null && n < market.assessedAmbiguity)
      reasons.push(`This lowers the current assessment (${market.assessedAmbiguity} by ${market.ambiguitySource ?? 'unknown'}).`);
    return reasons;
  };

  const requestSave = () => {
    if (score === '') return;
    const reasons = confirmReasons(Number(score));
    if (reasons.length > 0) setConfirm(reasons);
    else void save();
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await marketApi.setAmbiguity(market.marketId, Number(score), note.trim() || undefined);
      qc.invalidateQueries({ queryKey: ['market', market.marketId] });
      qc.invalidateQueries({ queryKey: ['marketSearch'] });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border border-[#2a2a2a] rounded-lg p-4 space-y-3">
      <p className="text-sm font-medium text-white">Ambiguity assessment</p>
      <p className="text-sm text-gray-400">
        {market.assessedAmbiguity === null ? (
          <span className="text-yellow-300">Not assessed: every buy in this market is rejected until it is.</span>
        ) : (
          <>
            Assessed {market.assessedAmbiguity} by {market.ambiguitySource ?? 'unknown'}
            {market.ambiguityScore !== market.assessedAmbiguity && (
              <>
                , effective <strong>{market.ambiguityScore}</strong> ({market.ambiguityRaisedBecause})
              </>
            )}
            {market.ambiguityNote ? ` — “${market.ambiguityNote}”` : ''}
          </>
        )}
      </p>
      <p className="text-xs text-gray-500">
        0 = unambiguous rules, 3 = very ambiguous. Buys need a score ≤ the mandate’s <code>max_ambiguity_score</code>. A human assessment always wins over
        forecasts until a human changes it.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-[8rem_1fr_auto] gap-2 items-end">
        <label className="text-sm text-gray-400">
          Score
          <select className={`${inputCls} mt-1`} value={score} onChange={(e) => setScore(e.target.value)}>
            <option value="" disabled>
              choose…
            </option>
            {['0', '1', '2', '3'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-gray-400">
          Note
          <input type="text" className={`${inputCls} mt-1`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why (optional)" />
        </label>
        <button type="button" className={btnPrimary} onClick={requestSave} disabled={busy || score === ''}>
          {busy ? 'Saving…' : 'Set ambiguity'}
        </button>
      </div>
      <ErrorBox>{error}</ErrorBox>
      {done && <Notice tone="green">Saved.</Notice>}
      {confirm && (
        <ConfirmDialog
          title={`Set ambiguity ${score}?`}
          confirmLabel="Set ambiguity"
          body={
            <>
              {confirm.map((r) => (
                <p key={r}>{r}</p>
              ))}
              <p>Only do this after reading the resolution rules above.</p>
            </>
          }
          onConfirm={async () => {
            await marketApi.setAmbiguity(market.marketId, Number(score), note.trim() || undefined);
            qc.invalidateQueries({ queryKey: ['market', market.marketId] });
            qc.invalidateQueries({ queryKey: ['marketSearch'] });
            setDone(true);
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function Watchlist() {
  const qc = useQueryClient();
  const { data = [], error } = useQuery({ queryKey: ['watchlist'], queryFn: async () => (await reconcileApi.watchlistList()) as WatchlistEntry[] });
  const [tokenId, setTokenId] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await reconcileApi.watchlistAdd(tokenId.trim(), undefined, note.trim() || undefined);
      setTokenId('');
      setNote('');
      qc.invalidateQueries({ queryKey: ['watchlist'] });
    } catch (x) {
      setErr(errorMessage(x));
    }
  };
  const remove = async (id: string) => {
    setErr(null);
    try {
      await reconcileApi.watchlistRemove(id);
      qc.invalidateQueries({ queryKey: ['watchlist'] });
    } catch (x) {
      setErr(errorMessage(x));
    }
  };
  return (
    <Card title="Order-book recorder watchlist">
      <p className="text-sm text-gray-400 mb-3">Extra tokens to snapshot for backtests, besides held tokens, active forecasts and bot-scoped markets.</p>
      <ErrorBox>{error ? errorMessage(error) : err}</ErrorBox>
      <form onSubmit={add} className="flex flex-col sm:flex-row gap-2 mb-3">
        <input type="text" className={`${inputCls} font-mono`} placeholder="Token id" value={tokenId} onChange={(e) => setTokenId(e.target.value)} />
        <input type="text" className={inputCls} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="submit" className={btnSecondary} disabled={!tokenId.trim()}>
          Add
        </button>
      </form>
      {data.length === 0 ? (
        <Empty>The watchlist is empty.</Empty>
      ) : (
        <ul className="divide-y divide-[#2a2a2a]">
          {data.map((w) => (
            <li key={w.token_id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="min-w-0">
                <span className="font-mono text-xs text-gray-300" title={w.token_id}>
                  {shortId(w.token_id, 10)}
                </span>
                {w.note && <span className="ml-2 text-gray-400">{w.note}</span>}
                {w.added_by && <span className="ml-2 text-xs text-gray-600">by {w.added_by}</span>}
              </span>
              <button type="button" className="text-xs text-red-400 hover:text-red-300" onClick={() => remove(w.token_id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
