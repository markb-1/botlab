/** Settings page sections added in 3c: Telegram, admin password, API tokens, reconciliation + adoption */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi, botApi, reconcileApi, tokenApi, walletApi } from '../lib/api';
import { ConfigEditor } from './ConfigEditor';
import { Badge, Card, ConfirmDialog, Empty, ErrorBox, Notice, btnDanger, btnPrimary, btnSecondary, inputCls, tdCls, thCls } from './ui';
import { dateTime, errorMessage, relTime, shortId, usd } from '../lib/format';
import type { AdoptResult, ApiToken, Bot, ReconcileStatus, Wallet } from '../types';

export function TelegramSettings() {
  return (
    <ConfigEditor
      file="server"
      pick={['notify']}
      intro={
        <>
          <p>
            Alerts (halts, fills, risk raises, rules changes, reconciliation) and commands (<code>/halt</code>, <code>/pause</code>) through your own Telegram
            bot. Written to <code>server.yaml</code>; no restart needed.
          </p>
          <p>
            The bot token is never shown: leave <code>***</code> to keep it, or type a new one. Disabling Telegram or changing the chat counts as raising risk.
          </p>
        </>
      }
    />
  );
}

export function PasswordSettings() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const mismatch = again !== '' && next !== again;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(false);
    setBusy(true);
    try {
      await authApi.changePassword({ currentPassword: current, newPassword: next });
      setDone(true);
      setCurrent('');
      setNext('');
      setAgain('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Admin password">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-gray-400">
          Changing it logs out every other browser. Forgot it? Run <code>npm run cli -- set-password</code> on the server.
        </p>
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Current password"
          className={inputCls}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="New password (8+ characters)"
          className={inputCls}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="New password again"
          className={inputCls}
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
        {mismatch && <p className="text-xs text-red-400">The new passwords differ.</p>}
        <ErrorBox>{error}</ErrorBox>
        {done && <Notice tone="green">Password changed. Other sessions were logged out.</Notice>}
        <div className="flex justify-end">
          <button type="submit" className={btnPrimary} disabled={busy || !current || next.length < 8 || next !== again}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </form>
    </Card>
  );
}

export function TokenSettings() {
  const qc = useQueryClient();
  const { data: tokens = [], error } = useQuery({ queryKey: ['tokens'], queryFn: async () => (await tokenApi.list()) as ApiToken[] });
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'agent' | 'readonly'>('readonly');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [shown, setShown] = useState<{ token: string; name: string } | null>(null);
  const [revoke, setRevoke] = useState<ApiToken | null>(null);
  const [copied, setCopied] = useState(false);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = (await tokenApi.create(name.trim() || scope, scope)) as { token: string; name: string };
      setShown({ token: r.token, name: r.name });
      setCopied(false);
      setName('');
      qc.invalidateQueries({ queryKey: ['tokens'] });
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  const active = tokens.filter((t) => !t.revoked_at);
  const revoked = tokens.filter((t) => t.revoked_at);
  return (
    <Card title="API tokens">
      <div className="space-y-4">
        <p className="text-sm text-gray-400">
          Bearer tokens for scripts and the agent (MCP). <strong>readonly</strong>: GET requests except wallets, settings and config. <strong>agent</strong>:
          the agent tools — paper bots, scripts, backtests, forecasts, kill switch; never wallets, config writes, clearing halts or anything else only a human
          may do.
        </p>
        <ErrorBox>{error ? errorMessage(error) : err}</ErrorBox>
        {shown && (
          <Notice tone="green">
            <p className="font-medium">Token “{shown.name}” created. Copy it now — it is not shown again.</p>
            <div className="mt-2 flex flex-col sm:flex-row gap-2">
              <input readOnly className={`${inputCls} font-mono text-xs`} value={shown.token} onFocus={(e) => e.target.select()} />
              <button
                type="button"
                className={btnSecondary}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(shown.token);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button type="button" className={btnSecondary} onClick={() => setShown(null)}>
                Done
              </button>
            </div>
          </Notice>
        )}
        <form onSubmit={create} className="flex flex-col sm:flex-row gap-2">
          <input type="text" className={inputCls} placeholder="Name (e.g. claude-code)" value={name} onChange={(e) => setName(e.target.value)} />
          <select className={`${inputCls} sm:w-40`} value={scope} onChange={(e) => setScope(e.target.value as 'agent' | 'readonly')}>
            <option value="readonly">readonly</option>
            <option value="agent">agent</option>
          </select>
          <button type="submit" className={btnPrimary} disabled={busy}>
            {busy ? 'Creating…' : 'Create token'}
          </button>
        </form>
        {active.length === 0 ? (
          <Empty>No active tokens.</Empty>
        ) : (
          <ul className="divide-y divide-[#2a2a2a]">
            {active.map((t) => (
              <li key={t.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <span className="text-gray-100">{t.name}</span> <Badge tone={t.scope === 'agent' ? 'purple' : 'blue'}>{t.scope}</Badge>
                  <span className="block text-xs text-gray-500">
                    created {dateTime(t.created_at)} · last used {relTime(t.last_used_at)}
                  </span>
                </span>
                <button type="button" className="text-sm text-red-400 hover:text-red-300" onClick={() => setRevoke(t)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        {revoked.length > 0 && <p className="text-xs text-gray-600">{revoked.length} revoked token(s) not shown.</p>}
      </div>
      {revoke && (
        <ConfirmDialog
          title={`Revoke “${revoke.name}”?`}
          danger
          confirmLabel="Revoke"
          body={<p>Requests with this token fail from now on; an open event stream ends within 25 s.</p>}
          onConfirm={async () => {
            await tokenApi.revoke(revoke.id);
            qc.invalidateQueries({ queryKey: ['tokens'] });
          }}
          onClose={() => setRevoke(null)}
        />
      )}
    </Card>
  );
}

export function ReconcileSettings() {
  const { data: status, error } = useQuery({
    queryKey: ['reconcileStatus'],
    queryFn: async () => (await reconcileApi.status()) as ReconcileStatus | null,
    refetchInterval: 30_000,
  });
  const r = status?.result;
  return (
    <Card title="Reconciliation">
      <div className="space-y-4">
        <p className="text-sm text-gray-400">
          Every 60 s the server compares orders and positions with Polymarket and Binance. Unexplained exposure above{' '}
          <code>limits.reconcile.max_unexplained_usd</code> halts everything.
        </p>
        <ErrorBox>{error ? errorMessage(error) : null}</ErrorBox>
        {status === null && <p className="text-sm text-gray-500">No run yet.</p>}
        {status && r && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={r.ok ? 'green' : 'yellow'}>{r.ok ? 'complete' : 'incomplete'}</Badge>
              <span className="text-gray-300">last run {relTime(status.at)}</span>
              {status.consecutiveFailures > 0 && <span className="text-yellow-400">{status.consecutiveFailures} incomplete in a row</span>}
              <Badge tone={status.clockSkewed ? 'red' : 'gray'}>
                clock {status.clockSkewed ? 'skewed' : r.clockSkewMs === null ? 'unknown' : `${(r.clockSkewMs / 1000).toFixed(1)} s`}
              </Badge>
              <span className="text-gray-500">{r.ordersChecked} order(s) checked</span>
            </div>
            {r.errors.length > 0 && (
              <ul className="text-xs text-yellow-300 list-disc pl-5 space-y-0.5">
                {r.errors.slice(0, 8).map((e) => (
                  <li key={e} className="break-words">
                    {e}
                  </li>
                ))}
              </ul>
            )}
            {r.mismatches.length === 0 ? (
              <p className="text-sm text-gray-400">No position mismatches.</p>
            ) : (
              <div className="overflow-x-auto -mx-4 sm:mx-0">
                <table className="min-w-full divide-y divide-[#2a2a2a]">
                  <thead>
                    <tr>
                      <th className={thCls}>Wallet</th>
                      <th className={thCls}>Token / asset</th>
                      <th className={thCls}>Direction</th>
                      <th className={thCls}>Exchange / local</th>
                      <th className={thCls}>Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#2a2a2a]">
                    {r.mismatches.map((m) => (
                      <tr key={m.key}>
                        <td className={`${tdCls} font-mono text-xs`}>{shortId(m.walletId)}</td>
                        <td className={`${tdCls} font-mono text-xs`} title={m.symbol}>
                          {m.exchange} {shortId(m.symbol)}
                        </td>
                        <td className={tdCls}>
                          {m.direction}
                          {m.preExisting && (
                            <span className="ml-1">
                              <Badge tone="yellow">pre-existing</Badge>
                            </span>
                          )}
                        </td>
                        <td className={`${tdCls} tabular-nums`}>
                          {m.exchangeQty.toFixed(2)} / {m.localQty.toFixed(2)}
                        </td>
                        <td className={`${tdCls} tabular-nums`}>{usd(m.valueUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <AdoptPositions />
      </div>
    </Card>
  );
}

/**
 * Adopt positions the wallet held before BotLab traded on it (R8/R67): pick wallet + bot, preview,
 * optionally include positions bought after the wallet's first order (dangerous), then adopt.
 */
function AdoptPositions() {
  const qc = useQueryClient();
  const { data: wallets = [] } = useQuery({ queryKey: ['wallets'], queryFn: async () => (await walletApi.list()) as Wallet[] });
  const { data: bots = [] } = useQuery({ queryKey: ['bots'], queryFn: async () => (await botApi.list()) as Bot[] });
  const [walletId, setWalletId] = useState('');
  const [botId, setBotId] = useState('');
  const [includePost, setIncludePost] = useState(false);
  const [preview, setPreview] = useState<AdoptResult | null>(null);
  const [result, setResult] = useState<AdoptResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const walletBots = bots.filter((b) => b.walletId === walletId && b.mode === 'live' && b.stage !== 'retired');

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    setResult(null);
    try {
      setPreview((await reconcileApi.adoptPreview(walletId, botId, { includePostFirstOrder: includePost })) as AdoptResult);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-[#2a2a2a] rounded-lg p-4 space-y-3">
      <p className="text-sm font-medium text-white">Adopt existing positions</p>
      <p className="text-sm text-gray-400">
        Positions the wallet held before its first BotLab order are invisible to the risk engine and only warn. Adopting records them as fills of one live bot
        on that wallet (at the current price), so they count as exposure and the bot may sell them.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <select
          className={inputCls}
          value={walletId}
          onChange={(e) => {
            setWalletId(e.target.value);
            setBotId('');
            setPreview(null);
          }}
          aria-label="Wallet"
        >
          <option value="">Wallet…</option>
          {wallets.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({shortId(w.proxyAddress || w.address, 4)})
            </option>
          ))}
        </select>
        <select
          className={inputCls}
          value={botId}
          onChange={(e) => {
            setBotId(e.target.value);
            setPreview(null);
          }}
          aria-label="Bot"
          disabled={!walletId}
        >
          <option value="">{walletId && walletBots.length === 0 ? 'No live bot uses this wallet' : 'Bot…'}</option>
          {walletBots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-start gap-2 text-sm text-gray-300">
        <input
          type="checkbox"
          className="mt-1"
          checked={includePost}
          onChange={(e) => {
            setIncludePost(e.target.checked);
            setPreview(null);
          }}
        />
        <span>
          Also adopt quantities bought <strong>after</strong> the wallet’s first BotLab order
          {includePost && (
            <span className="block mt-1 text-xs text-red-300">
              These are normally unexplained fills (manual trading on a bot wallet, or a fill BotLab missed). Adopting them turns them into a sellable position
              of this bot; only do this if you know where they came from. The adoption is audited with these quantities.
            </span>
          )}
        </span>
      </label>
      <ErrorBox>{error}</ErrorBox>
      {preview && (
        <div className="space-y-2">
          <p className="text-sm text-gray-300">Would adopt:</p>
          {preview.adopted.length === 0 ? (
            <Empty>Nothing to adopt.</Empty>
          ) : (
            <ul className="text-sm space-y-1">
              {preview.adopted.map((a) => (
                <li key={a.tokenId} className="font-mono text-xs text-gray-200">
                  {shortId(a.tokenId)}: {a.quantity.toFixed(2)} @ {a.price} = {usd(a.quantity * a.price)}
                  {a.postFirstOrderQuantity ? <span className="text-red-300"> (incl. {a.postFirstOrderQuantity.toFixed(2)} after the first order)</span> : null}
                </li>
              ))}
            </ul>
          )}
          {preview.skipped.length > 0 && (
            <ul className="text-xs text-yellow-300 list-disc pl-5">
              {preview.skipped.map((s) => (
                <li key={s.tokenId}>
                  {shortId(s.tokenId)}: {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {result && (
        <Notice tone="green">
          Adopted {result.adopted.length} position(s){result.skipped.length ? `, skipped ${result.skipped.length}` : ''}.
        </Notice>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btnSecondary} disabled={!walletId || !botId || busy} onClick={runPreview}>
          {busy ? 'Checking…' : 'Preview'}
        </button>
        <button
          type="button"
          className={includePost ? btnDanger : btnPrimary}
          disabled={!preview || preview.adopted.length === 0 || busy}
          onClick={() => setConfirm(true)}
        >
          Adopt
        </button>
      </div>
      {confirm && (
        <ConfirmDialog
          title="Adopt these positions?"
          danger={includePost}
          confirmLabel="Adopt"
          body={<p>This cannot be undone from the UI. The positions count toward the bot’s exposure from now on.</p>}
          onConfirm={async () => {
            const r = (await reconcileApi.adoptPositions(walletId, botId, { includePostFirstOrder: includePost })) as AdoptResult;
            setResult(r);
            setPreview(null);
            qc.invalidateQueries({ queryKey: ['reconcileStatus'] });
            qc.invalidateQueries({ queryKey: ['overview'] });
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  );
}
