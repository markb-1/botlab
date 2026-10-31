import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useBots, useDashboardStats } from '../hooks/useBots';
import { useWallets } from '../hooks/useWallets';
import { useSettings } from '../hooks/useSettings';
import type { Bot, Overview } from '../types';
import { useOverview } from '../hooks/useRisk';
import { HaltBanner, KillSwitchButton } from '../components/HaltControls';
import { Badge, Card, LimitBar, Notice, PageHeader, RightsBadge, StageBadge } from '../components/ui';
import { dateTime, pct, relTime, signedUsd, usd } from '../lib/format';

function StatusBadge({ status }: { status: Bot['status'] }) {
  const colors = {
    running: 'bg-green-500/10 text-green-400',
    stopped: 'bg-gray-500/10 text-gray-400',
    starting: 'bg-yellow-500/10 text-yellow-400',
    stopping: 'bg-yellow-500/10 text-yellow-400',
    error: 'bg-red-500/10 text-red-400',
  };

  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colors[status]}`}>{status}</span>;
}

export function Dashboard() {
  const [pnlPeriod, setPnlPeriod] = useState<'all' | '24h'>('all');
  const { bots, isLoading: botsLoading, startBot, stopBot } = useBots();
  const { statsMap, isLoading: statsLoading } = useDashboardStats();
  const { wallets, isLoading: walletsLoading } = useWallets();
  const { settings, isLoading: settingsLoading } = useSettings();
  const { data: overview, error: overviewQueryError } = useOverview();
  const overviewError = overviewQueryError ? (overviewQueryError as Error).message : null;
  const allocationOf = new Map((overview?.bots ?? []).map((a) => [a.botId, a]));

  const runningBots = bots.filter((b) => b.status === 'running');
  const stoppedBots = bots.filter((b) => b.status === 'stopped');
  const errorBots = bots.filter((b) => b.status === 'error');
  const availableWallets = wallets.filter((w) => !w.currentBotId);

  const handleStartBot = async (id: string) => {
    try {
      await startBot(id);
    } catch (err) {
      console.error('Failed to start bot:', err);
    }
  };

  const handleStopBot = async (id: string) => {
    try {
      await stopBot(id);
    } catch (err) {
      console.error('Failed to stop bot:', err);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" subtitle="Risk, halts and bots at a glance" actions={<KillSwitchButton />} />

      <RiskSummary overview={overview} error={overviewError} />

      {/* Setup Warning */}
      {!settingsLoading && (!settings?.rpcUrl || settings.rpcUrl === '') && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-yellow-300">Setup Required</h3>
              <p className="mt-1 text-sm text-yellow-300/80">Please configure your RPC URL and other settings before starting bots.</p>
              <Link to="/settings" className="mt-2 inline-block text-sm font-medium text-accent hover:text-accent-hover">
                Go to Settings →
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6">
        <div className="bg-surface border border-[#2a2a2a] rounded-xl p-6">
          <h3 className="text-sm font-medium text-gray-400">Total Bots</h3>
          <p className="mt-2 text-3xl font-semibold text-white">{botsLoading ? '...' : bots.length}</p>
          <Link to="/bots" className="mt-2 text-sm text-accent hover:text-accent-hover">
            Manage bots →
          </Link>
        </div>

        <div className="bg-surface border border-[#2a2a2a] rounded-xl p-6">
          <h3 className="text-sm font-medium text-gray-400">Running</h3>
          <p className="mt-2 text-3xl font-semibold text-green-400">{botsLoading ? '...' : runningBots.length}</p>
          <p className="mt-1 text-sm text-gray-500">
            {stoppedBots.length} stopped, {errorBots.length} errors
          </p>
        </div>

        <div className="bg-surface border border-[#2a2a2a] rounded-xl p-6">
          <h3 className="text-sm font-medium text-gray-400">Wallets</h3>
          <p className="mt-2 text-3xl font-semibold text-white">{walletsLoading ? '...' : wallets.length}</p>
          <p className="mt-1 text-sm text-gray-500">{availableWallets.length} available</p>
          <Link to="/wallets" className="mt-2 text-sm text-accent hover:text-accent-hover">
            Manage wallets →
          </Link>
        </div>

        <div className="bg-surface border border-[#2a2a2a] rounded-xl p-6">
          <h3 className="text-sm font-medium text-gray-400">Settings</h3>
          <p className="mt-2 text-xl font-semibold text-white">{settingsLoading ? '...' : settings?.rpcUrl ? 'Configured' : 'Not Set'}</p>
          <Link to="/settings" className="mt-2 text-sm text-accent hover:text-accent-hover">
            View settings →
          </Link>
        </div>
      </div>

      {/* Bot Overview */}
      <div className="bg-surface border border-[#2a2a2a] rounded-xl">
        <div className="px-6 py-4 border-b border-[#2a2a2a] flex items-center justify-between">
          <div>
            <h3 className="text-lg font-medium text-white">Bot Overview</h3>
            <p className="text-sm text-gray-400">
              {bots.length} bot{bots.length !== 1 ? 's' : ''} configured
            </p>
          </div>
          <div className="flex items-center space-x-3">
            <Link
              to="/bots/new"
              className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-lg text-white bg-accent hover:bg-accent-hover"
            >
              + New Bot
            </Link>
          </div>
        </div>

        {botsLoading ? (
          <div className="p-6 text-center text-gray-500">Loading...</div>
        ) : bots.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-gray-500 mb-4">No bots created yet</p>
            <Link
              to="/bots/new"
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-lg text-white bg-accent hover:bg-accent-hover"
            >
              Create your first bot
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-[#2a2a2a]">
              <thead className="bg-surface-dark">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Bot Name</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    <div className="flex items-center justify-end gap-1.5">
                      <span>P&L</span>
                      <div className="inline-flex rounded-md border border-[#333]">
                        <button
                          onClick={() => setPnlPeriod('all')}
                          className={`px-1.5 py-0.5 text-[10px] font-medium rounded-l-md transition-colors ${
                            pnlPeriod === 'all' ? 'bg-accent text-white' : 'text-gray-500 hover:text-gray-300'
                          }`}
                        >
                          All
                        </button>
                        <button
                          onClick={() => setPnlPeriod('24h')}
                          className={`px-1.5 py-0.5 text-[10px] font-medium rounded-r-md transition-colors ${
                            pnlPeriod === '24h' ? 'bg-accent text-white' : 'text-gray-500 hover:text-gray-300'
                          }`}
                        >
                          24h
                        </button>
                      </div>
                    </div>
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Value</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Positions</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Script</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Heartbeat</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-surface divide-y divide-[#2a2a2a]">
                {bots.map((bot) => {
                  const botStats = statsMap.get(bot.id);
                  const pnlValue = botStats ? (pnlPeriod === 'all' ? botStats.pnlAllTime : botStats.pnl24h) : null;
                  return (
                    <tr key={bot.id} className="hover:bg-surface-light">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Link to={`/bots/${bot.id}`} className="text-sm font-medium text-accent hover:text-accent-hover">
                          {bot.name}
                        </Link>
                        {bot.mode === 'paper' && <span className="ml-2 text-xs bg-yellow-500/10 text-yellow-400 px-1.5 py-0.5 rounded">PAPER</span>}
                        <span className="ml-2">
                          <StageBadge stage={bot.stage} />
                        </span>
                        {allocationOf.get(bot.id)?.allocationUsd != null && (
                          <span className="block text-xs text-gray-500 mt-0.5">
                            {usd(allocationOf.get(bot.id)!.usedUsd, 0)} of {usd(allocationOf.get(bot.id)!.allocationUsd, 0)} allocation
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <StatusBadge status={bot.status} />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                        {statsLoading ? (
                          <span className="text-gray-500">...</span>
                        ) : pnlValue != null ? (
                          <span className={`font-medium ${pnlValue >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {pnlValue >= 0 ? '+' : ''}${pnlValue.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                        {statsLoading ? (
                          <span className="text-gray-500">...</span>
                        ) : botStats ? (
                          <span className="text-white font-medium">${botStats.totalValue.toFixed(2)}</span>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                        {statsLoading ? (
                          <span className="text-gray-500">...</span>
                        ) : botStats ? (
                          <span className="text-gray-300">{botStats.positionCount}</span>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">{bot.scriptName || bot.scriptId}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                        {bot.lastHeartbeat ? new Date(bot.lastHeartbeat).toLocaleString() : 'Never'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm space-x-3">
                        <Link to={`/bots/${bot.id}/trades`} className="text-accent hover:text-accent-hover font-medium">
                          Trades
                        </Link>
                        {bot.status === 'stopped' || bot.status === 'error' ? (
                          <button onClick={() => handleStartBot(bot.id)} className="text-green-400 hover:text-green-300 font-medium">
                            Start
                          </button>
                        ) : bot.status === 'running' ? (
                          <button onClick={() => handleStopBot(bot.id)} className="text-red-400 hover:text-red-300 font-medium">
                            Stop
                          </button>
                        ) : (
                          <span className="text-gray-500">...</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent Errors */}
      {errorBots.length > 0 && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-6">
          <h3 className="text-lg font-medium text-red-300 mb-4">Bots with Errors</h3>
          <div className="space-y-3">
            {errorBots.map((bot) => (
              <div key={bot.id} className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-red-300">{bot.name}</p>
                  {bot.errorLogs.length > 0 && <p className="text-sm text-red-400">{bot.errorLogs[bot.errorLogs.length - 1].message}</p>}
                </div>
                <Link to={`/bots/${bot.id}`} className="text-sm text-red-400 hover:text-red-300 font-medium">
                  View Details →
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-green-500' : warn ? 'bg-yellow-500' : 'bg-red-500'}`} />;
}

/** Equity, exposure vs limits, daily P&L vs loss limit, halts, reconciler/clock, category rights (spec §12) */
function RiskSummary({ overview, error }: { overview: Overview | undefined; error: string | null }) {
  if (error) return <Notice tone="red">Risk overview unavailable: {error}</Notice>;
  if (!overview) return <p className="text-sm text-gray-500">Loading risk overview…</p>;
  const o = overview;
  const loss = o.dailyPnl;
  return (
    <div className="space-y-4">
      {!o.config.valid && (
        <Notice tone="red">
          <strong>Config is invalid</strong> — no bot can start until it is fixed (Risk page): {o.config.error}
        </Notice>
      )}
      <HaltBanner global={o.halts.global} bots={o.halts.bots} />
      {o.liveTradingEnabled === false && (
        <Notice tone="yellow">
          <strong>Live trading is disabled</strong> (<code>limits.yaml live_trading.enabled: false</code>). Paper bots run normally; live bots cannot start and
          live orders are rejected. Enable it on the{' '}
          <Link to="/risk" className="underline">
            Risk page
          </Link>{' '}
          when you are ready.
        </Notice>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Equity">
          <p className="text-3xl font-semibold text-white tabular-nums">{usd(o.equity.usd)}</p>
          <p className="mt-1 text-sm text-gray-400">
            cash {usd(o.equity.cashUsd)} + live positions at cost {usd(o.equity.positionsUsd)}
          </p>
          {o.equity.error && <p className="mt-1 text-xs text-yellow-400 break-words">Balance unavailable: {o.equity.error}</p>}
          <p className="mt-1 text-xs text-gray-500">Cash of the wallets live bots use (+ Binance USDT); refreshed every 30 s.</p>
        </Card>

        <Card title="Exposure (live)">
          <div className="space-y-4">
            <LimitBar
              label="Total"
              value={o.exposure.totalUsd}
              limit={o.exposure.totalLimitUsd}
              format={(n) => usd(n, 0)}
              hint={
                o.equity.usd === null
                  ? `Equity unknown: showing the USD cap only`
                  : `Lower of ${usd(o.exposure.totalCapUsd, 0)} and ${pct(o.exposure.totalCapPct)} of equity`
              }
            />
            <LimitBar
              label="Long horizon (> 30 days)"
              value={o.exposure.longHorizonUsd}
              limit={o.exposure.longHorizonLimitUsd}
              format={(n) => usd(n, 0)}
              hint={
                o.exposure.longHorizonUnknownUsd > 0
                  ? `${usd(o.exposure.longHorizonUnknownUsd, 0)} counted long because the end date is unknown`
                  : `${pct(o.exposure.longHorizonPct)} of equity`
              }
            />
            <LimitBar label="Open orders" value={o.exposure.openOrders} limit={o.exposure.maxOpenOrders} format={(n) => (n === null ? '—' : String(n))} />
          </div>
        </Card>

        <Card title="Daily P&L (UTC day)">
          <p className={`text-3xl font-semibold tabular-nums ${(loss.liveUsd ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>{signedUsd(loss.liveUsd)}</p>
          <p className="mt-1 text-sm text-gray-400">paper {signedUsd(loss.paperUsd)}</p>
          <div className="mt-3">
            <LimitBar
              label="Loss vs daily limit"
              value={loss.lossUsd}
              limit={loss.limitUsd}
              format={(n) => usd(n, 0)}
              hint={loss.baselineUsd !== null ? `Counted from ${signedUsd(loss.baselineUsd)} (halt cleared today)` : `Updated ${relTime(loss.updatedAt)}`}
            />
          </div>
        </Card>

        <Card title="Reconciler & clock">
          <ul className="space-y-2 text-sm">
            <li className="flex items-center gap-2">
              <StatusDot ok={!o.reconciler.stale} warn={o.reconciler.locked} />
              <span className="text-gray-300">
                {o.reconciler.locked
                  ? 'Not running (server locked)'
                  : o.reconciler.reconciledAt
                    ? `Last full run ${relTime(o.reconciler.reconciledAt)}`
                    : 'No complete run yet'}
              </span>
            </li>
            {o.reconciler.consecutiveFailures > 0 && (
              <li className="text-xs text-yellow-400 break-words">
                {o.reconciler.consecutiveFailures} incomplete run(s) in a row{o.reconciler.lastErrors[0] ? `: ${o.reconciler.lastErrors[0]}` : ''}
              </li>
            )}
            <li className="flex items-center gap-2">
              <StatusDot ok={o.reconciler.mismatches === 0} />
              <span className="text-gray-300">
                {o.reconciler.mismatches === 0 ? 'No position mismatches' : `${o.reconciler.mismatches} position mismatch(es)`}
              </span>
            </li>
            <li className="flex items-center gap-2">
              <StatusDot ok={o.reconciler.clock.ok} />
              <span className="text-gray-300 break-words">
                Clock{' '}
                {o.reconciler.clock.ok && o.reconciler.clock.skewMs === null
                  ? 'not checked yet (live orders allowed for 3 min after start)'
                  : o.reconciler.clock.ok
                    ? 'OK'
                    : o.reconciler.clock.reason === 'clock_skew'
                      ? 'skewed — live orders refused'
                      : o.reconciler.clock.reason === 'clock_unverified'
                        ? 'unverified — live orders refused'
                        : 'unknown'}
                {o.reconciler.clock.skewMs !== null ? ` (${(o.reconciler.clock.skewMs / 1000).toFixed(1)} s)` : ''}
              </span>
            </li>
          </ul>
          <Link to="/settings" className="mt-3 inline-block text-sm text-accent hover:text-accent-hover">
            Reconciliation details →
          </Link>
        </Card>

        <Card title="Category rights">
          <div className="flex flex-wrap gap-2">
            {Object.keys(o.rights.counts).length === 0 ? (
              <span className="text-sm text-gray-500">No buckets yet: rights appear once forecasts are scored.</span>
            ) : (
              Object.entries(o.rights.counts).map(([state, n]) => (
                <span key={state} className="text-sm text-gray-300">
                  <RightsBadge state={state} /> {n}
                </span>
              ))
            )}
          </div>
          {o.rights.trading.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm text-gray-300">
              {o.rights.trading.map((t) => (
                <li key={`${t.category}|${t.horizonBucket}`}>
                  {t.category} · {t.horizonBucket} <span className="text-gray-500">up to {usd(t.maxAllocationUsd, 0)}</span>
                </li>
              ))}
            </ul>
          )}
          <Link to="/ledger" className="mt-3 inline-block text-sm text-accent hover:text-accent-hover">
            Ledger →
          </Link>
        </Card>

        <Card title="Approvals">
          <p className="text-sm text-gray-400">
            New-template live approvals: {o.approvalsNewTemplateLive ? <Badge tone="yellow">required</Badge> : <Badge tone="gray">disabled</Badge>}
          </p>
          <p className="mt-2 text-xs text-gray-500">Updated {dateTime(o.at)}</p>
        </Card>
      </div>
    </div>
  );
}
