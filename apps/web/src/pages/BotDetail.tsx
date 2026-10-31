import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useBot, useBots, useBotPositions, useBotStats } from '../hooks/useBots';
import { useScript, useScriptSchema } from '../hooks/useScripts';
import { useWallets } from '../hooks/useWallets';
import { useBotActivity } from '../hooks/useBotActivity';
import { ScriptEditor } from '../components/ScriptEditor';
import type { Bot, BotOrder, Forecast, ScriptVersionInfo } from '../types';
import { useQuery } from '@tanstack/react-query';
import { botApi, ledgerApi, scriptApi } from '../lib/api';
import { useOverview } from '../hooks/useRisk';
import { ClearHaltButton } from '../components/HaltControls';
import { DiffView } from '../components/DiffView';
import { StrategyPanel } from '../components/StrategyPanel';
import { ForecastDetail } from './Ledger';
import { Badge, Empty, ErrorBox, Notice, StageBadge, Tabs, tdCls, thCls } from '../components/ui';
import { dateTime, errorMessage, pct, shortId, usd } from '../lib/format';

/** Shorten a long token ID for display */
function truncateId(id: string): string {
  if (id.length > 20) return `${id.slice(0, 8)}...${id.slice(-6)}`;
  return id;
}

function StatusBadge({ status }: { status: Bot['status'] }) {
  const colors = {
    running: 'bg-green-500/10 text-green-400',
    stopped: 'bg-gray-500/10 text-gray-400',
    starting: 'bg-yellow-500/10 text-yellow-400',
    stopping: 'bg-yellow-500/10 text-yellow-400',
    error: 'bg-red-500/10 text-red-400',
  };
  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${colors[status]}`}>
      {status}
    </span>
  );
}

type Tab = 'overview' | 'config' | 'code' | 'orders' | 'logs' | 'events' | 'trades';

export function BotDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { bot, isLoading } = useBot(id!);
  const { updateBot, startBot, stopBot, restartBot, deleteBot } = useBots({ list: false });
  const { wallets } = useWallets();
  const { script } = useScript(bot?.scriptId || '');
  const { schema } = useScriptSchema(bot?.scriptId || '');
  const { data: overview } = useOverview();
  const allocation = overview?.bots.find((a) => a.botId === id);
  const halt = overview?.halts.bots.find((h) => h.botId === id);

  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [isEditing, setIsEditing] = useState(false);
  const [editConfig, setEditConfig] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const { logs, customEvents, historyError, clearLogs, clearEvents } = useBotActivity(id);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const [pnlPeriod, setPnlPeriod] = useState<'allTime' | '24h'>('allTime');

  const wallet = wallets.find((w) => w.id === bot?.walletId);
  const { positions } = useBotPositions(id!);
  const { stats } = useBotStats(id!);

  // Auto-scroll logs
  useEffect(() => {
    if (activeTab === 'logs') {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, activeTab]);

  const handleStartEdit = () => {
    setEditConfig(bot?.config || {});
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (!bot) return;
    setError(null);
    try {
      await updateBot({ id: bot.id, data: { config: editConfig } });
      setIsEditing(false);
    } catch (err: any) {
      setError(err.message || 'Failed to update bot');
    }
  };

  const handleStart = async () => { if (bot) { try { await startBot(bot.id); } catch (err: any) { setError(err.message); } } };
  const handleStop = async () => { if (bot) { try { await stopBot(bot.id); } catch (err: any) { setError(err.message); } } };
  const handleRestart = async () => { if (bot) { try { await restartBot(bot.id); } catch (err: any) { setError(err.message); } } };
  const handleDelete = async () => {
    if (!bot) return;
    if (bot.status === 'running') { alert('Please stop the bot first'); return; }
    if (!confirm(`Delete "${bot.name}"?`)) return;
    try { await deleteBot(bot.id); navigate('/bots'); } catch (err: any) { setError(err.message); }
  };

  const renderConfigValue = (key: string, value: unknown, prop?: any) => {
    if (isEditing) {
      if (prop?.type === 'boolean') {
        return (
          <input type="checkbox" checked={!!editConfig[key]}
            onChange={(e) => setEditConfig({ ...editConfig, [key]: e.target.checked })}
            className="rounded border-[#333] bg-surface-light text-accent focus:ring-accent" />
        );
      }
      if (prop?.type === 'number' || prop?.type === 'integer') {
        return (
          <input type="number" value={editConfig[key] as number ?? ''}
            onChange={(e) => setEditConfig({ ...editConfig, [key]: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
            className="block w-full rounded-md border border-[#333] bg-surface-light text-white shadow-sm focus:border-accent focus:ring-accent sm:text-sm" />
        );
      }
      if (prop?.enum) {
        return (
          <select value={editConfig[key] as string || ''}
            onChange={(e) => setEditConfig({ ...editConfig, [key]: e.target.value })}
            className="block w-full rounded-md border border-[#333] bg-surface-light text-white shadow-sm sm:text-sm">
            {prop.enum.map((opt: string) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        );
      }
      if (Array.isArray(editConfig[key])) {
        return (
          <textarea value={(editConfig[key] as string[]).join('\n')}
            onChange={(e) => setEditConfig({ ...editConfig, [key]: e.target.value.split('\n').filter(Boolean) })}
            rows={3}
            className="block w-full rounded-md border border-[#333] bg-surface-light text-white shadow-sm sm:text-sm font-mono text-sm" />
        );
      }
      return (
        <input type="text" value={editConfig[key] as string || ''}
          onChange={(e) => setEditConfig({ ...editConfig, [key]: e.target.value })}
          className="block w-full rounded-md border border-[#333] bg-surface-light text-white shadow-sm sm:text-sm" />
      );
    }
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'None';
    if (typeof value === 'object' && value !== null) return JSON.stringify(value);
    return String(value ?? '-');
  };

  if (isLoading) return <div className="text-center py-8 text-gray-500">Loading bot...</div>;
  if (!bot) return (
    <div className="text-center py-8">
      <p className="text-gray-500 mb-4">Bot not found</p>
      <Link to="/bots" className="text-accent hover:text-accent-hover">Back to Bots</Link>
    </div>
  );

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'config', label: 'Config' },
    { id: 'code', label: 'Code' },
    { id: 'orders', label: 'Orders' },
    { id: 'logs', label: 'Logs' },
    { id: 'events', label: `Events${customEvents.length ? ` (${customEvents.length})` : ''}` },
    { id: 'trades', label: 'Trades' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/bots" className="text-sm text-gray-500 hover:text-gray-300">← Back to Bots</Link>
          <h2 className="mt-2 text-2xl font-bold text-white">{bot.name}</h2>
          <p className="mt-1 text-sm text-gray-400">{bot.scriptName || bot.scriptId}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <StatusBadge status={bot.status} />
          <StageBadge stage={bot.stage} />
          {halt && <Badge tone="red" title={halt.reason ?? undefined}>halted</Badge>}
          {bot.mode === 'paper' && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
              PAPER
            </span>
          )}
          {bot.status === 'stopped' || bot.status === 'error' ? (
            <button onClick={handleStart} className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-500 text-sm font-medium">Start</button>
          ) : bot.status === 'running' ? (
            <>
              <button onClick={handleStop} className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-500 text-sm font-medium">Stop</button>
              <button onClick={handleRestart} className="px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-500 text-sm font-medium">Restart</button>
            </>
          ) : null}
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* Tabs */}
      <Tabs<Tab> tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {/* Tab content */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {halt && (
            <div className="bg-red-500/10 border border-red-500/40 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-red-300">This bot is halted</p>
                <p className="text-sm text-red-200/80 break-words">
                  {halt.reason ?? 'no reason recorded'} · {dateTime(halt.haltedAt)}
                </p>
              </div>
              <ClearHaltButton scope={bot.id} />
            </div>
          )}
          {overview?.halts.global.halted && <Notice tone="red">Global halt active: no bot can start ({overview.halts.global.reason}).</Notice>}
          {bot.stage === 'retired' && <Notice tone="yellow">Retired{bot.retireReason ? `: ${bot.retireReason}` : ''}. Retired bots never trade again.</Notice>}
          <StrategyPanel bot={bot} events={customEvents} />
          <div className="bg-surface border border-[#2a2a2a] rounded-xl p-4 sm:p-6">
            <h3 className="text-lg font-medium text-white mb-4">Risk & ramp</h3>
            <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
              <div>
                <dt className="text-gray-400">Stage</dt>
                <dd className="mt-1 text-gray-100">
                  <StageBadge stage={bot.stage} /> <span className="text-xs text-gray-500">since {dateTime(bot.stageChangedAt ?? bot.createdAt)}</span>
                </dd>
              </div>
              <div>
                <dt className="text-gray-400">Created by</dt>
                <dd className="mt-1 text-gray-100">{bot.createdBy ?? 'human'}</dd>
              </div>
              <div>
                <dt className="text-gray-400">Allocation used / available</dt>
                <dd className="mt-1 text-gray-100 tabular-nums">
                  {allocation ? (
                    <>
                      {usd(allocation.usedUsd)} / {allocation.availableUsd === null ? '—' : usd(allocation.availableUsd)}{' '}
                      <span className="text-xs text-gray-500">
                        of {usd(allocation.allocationUsd)}
                        {allocation.simulated ? ' (paper)' : ''}
                        {bot.allocationUsd != null ? ` · override ${usd(bot.allocationUsd)}` : ''}
                      </span>
                    </>
                  ) : (
                    '—'
                  )}
                  {bot.mode === 'paper' && (
                    <span className="block text-xs text-gray-500 mt-1">
                      This is the limit: paper orders pass the same risk checks as live ones, so the stage allocation caps
                      the bot&apos;s exposure (it grows as the bot is promoted). The paper balance is only simulated cash
                      {bot.config.paperBalance ? ` (${usd(Number(bot.config.paperBalance))})` : ''}; a buy needs room in both.
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-gray-400">Script revision</dt>
                <dd className="mt-1 text-gray-100">
                  r{bot.scriptRevision ?? '?'} {bot.scriptTrust && <Badge tone={bot.scriptTrust === 'proven' ? 'green' : 'gray'}>{bot.scriptTrust}</Badge>}
                  {bot.templateVersion != null && bot.templateVersion !== bot.scriptRevision && <span className="block text-xs text-gray-500">created on r{bot.templateVersion}</span>}
                </dd>
              </div>
              <div>
                <dt className="text-gray-400">Market scope</dt>
                <dd className="mt-1 text-gray-100 break-all">
                  {bot.marketIds == null ? 'unscoped' : bot.marketIds.length === 0 ? 'none (cannot trade)' : bot.marketIds.map((m) => shortId(m)).join(', ')}
                </dd>
              </div>
              <div>
                <dt className="text-gray-400">Strategy</dt>
                <dd className="mt-1 text-gray-100">{bot.strategy ?? '—'}</dd>
              </div>
            </dl>
          </div>
          {/* Portfolio Stats */}
          {stats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-surface border border-[#2a2a2a] rounded-xl p-4">
                <dt className="text-xs font-medium text-gray-500 uppercase">Cash Balance</dt>
                <dd className="mt-1 text-xl font-semibold text-white">
                  ${stats.cashBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </dd>
              </div>
              <div className="bg-surface border border-[#2a2a2a] rounded-xl p-4">
                <dt className="text-xs font-medium text-gray-500 uppercase">Positions Value</dt>
                <dd className="mt-1 text-xl font-semibold text-white">
                  ${stats.positionsValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </dd>
              </div>
              <div className="bg-surface border border-[#2a2a2a] rounded-xl p-4">
                <dt className="text-xs font-medium text-gray-500 uppercase">Total Value</dt>
                <dd className="mt-1 text-xl font-semibold text-white">
                  ${stats.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </dd>
              </div>
              <div className="bg-surface border border-[#2a2a2a] rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <dt className="text-xs font-medium text-gray-500 uppercase">P&L</dt>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setPnlPeriod('allTime')}
                      className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                        pnlPeriod === 'allTime'
                          ? 'bg-accent/20 text-accent'
                          : 'text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      All
                    </button>
                    <button
                      onClick={() => setPnlPeriod('24h')}
                      className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                        pnlPeriod === '24h'
                          ? 'bg-accent/20 text-accent'
                          : 'text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      24h
                    </button>
                  </div>
                </div>
                {(() => {
                  const pnlValue = pnlPeriod === 'allTime' ? stats.pnlAllTime : stats.pnl24h;
                  if (pnlValue == null) return <dd className="mt-1 text-xl font-semibold text-gray-500">-</dd>;
                  const isPositive = pnlValue >= 0;
                  return (
                    <dd className={`mt-1 text-xl font-semibold ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                      {isPositive ? '+' : ''}{pnlValue < 0 ? '-' : ''}${Math.abs(pnlValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </dd>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Info */}
          <div className="bg-surface border border-[#2a2a2a] rounded-xl p-6">
            <h3 className="text-lg font-medium text-white mb-4">Information</h3>
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <dt className="text-sm font-medium text-gray-400">Wallet</dt>
                <dd className="mt-1 text-sm text-gray-100">
                  {bot.mode === 'paper' ? (
                    <span className="text-gray-500">Auto-generated (paper)</span>
                  ) : wallet ? (
                    <Link to="/wallets" className="text-accent hover:text-accent-hover">
                      {wallet.name} ({wallet.address.slice(0, 6)}...{wallet.address.slice(-4)})
                    </Link>
                  ) : 'Unknown'}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-400">Mode</dt>
                <dd className="mt-1 text-sm text-gray-100">
                  {bot.mode === 'paper' ? (
                    <span className="text-amber-400">
                      Paper Trading
                      {bot.config.paperBalance ? ` ($${Number(bot.config.paperBalance).toLocaleString()} starting balance)` : ''}
                    </span>
                  ) : (
                    <span className="text-green-400">Live Trading</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-400">Created</dt>
                <dd className="mt-1 text-sm text-gray-100">{new Date(bot.createdAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-400">Last Started</dt>
                <dd className="mt-1 text-sm text-gray-100">{bot.lastStartedAt ? new Date(bot.lastStartedAt).toLocaleString() : 'Never'}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-400">Last Heartbeat</dt>
                <dd className="mt-1 text-sm text-gray-100">{bot.lastHeartbeat ? new Date(bot.lastHeartbeat).toLocaleString() : 'None'}</dd>
              </div>
            </dl>
          </div>

          {/* Positions */}
          <div className="bg-surface border border-[#2a2a2a] rounded-xl p-6">
            <h3 className="text-lg font-medium text-white mb-4">Open Positions</h3>
            {positions.length === 0 ? (
              <p className="text-gray-500 text-sm">No open positions</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-[#2a2a2a]">
                  <thead>
                    <tr>
                      <th className="text-left text-xs font-medium text-gray-500 uppercase py-2 pr-4">Market</th>
                      <th className="text-left text-xs font-medium text-gray-500 uppercase py-2 pr-4">Bet</th>
                      <th className="text-left text-xs font-medium text-gray-500 uppercase py-2 pr-4">Exchange</th>
                      <th className="text-right text-xs font-medium text-gray-500 uppercase py-2 pr-4">Quantity</th>
                      <th className="text-right text-xs font-medium text-gray-500 uppercase py-2 pr-4">Cost</th>
                      <th className="text-right text-xs font-medium text-gray-500 uppercase py-2 pr-4">Value</th>
                      <th className="text-right text-xs font-medium text-gray-500 uppercase py-2">P&L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#2a2a2a]">
                    {positions.map((pos) => {
                      const pnl = pos.currentValue != null ? pos.currentValue - pos.totalCost : null;
                      const pnlPct = pos.totalCost > 0 && pnl != null ? (pnl / pos.totalCost) * 100 : null;
                      const isProfit = pnl != null && pnl >= 0;

                      return (
                        <tr key={`${pos.exchange}-${pos.symbol}`} className="hover:bg-[#222222]">
                          <td className="py-3 pr-4 text-sm text-gray-100 max-w-xs truncate" title={pos.market || pos.symbol}>
                            {pos.market || truncateId(pos.symbol)}
                          </td>
                          <td className="py-3 pr-4">
                            {pos.outcome ? (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-500/10 text-purple-400">
                                {pos.outcome}
                              </span>
                            ) : (
                              <span className="text-sm text-gray-500">-</span>
                            )}
                          </td>
                          <td className="py-3 pr-4">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                              pos.exchange === 'binance'
                                ? 'bg-yellow-500/10 text-yellow-400'
                                : 'bg-blue-500/10 text-blue-400'
                            }`}>
                              {pos.exchange || 'polymarket'}
                            </span>
                          </td>
                          <td className="py-3 pr-4 text-sm text-gray-100 text-right">{pos.netQuantity.toFixed(2)}</td>
                          <td className="py-3 pr-4 text-sm text-gray-400 text-right">${pos.totalCost.toFixed(2)}</td>
                          <td className={`py-3 pr-4 text-sm font-medium text-right ${
                            pos.currentValue == null ? 'text-gray-500' : isProfit ? 'text-green-400' : 'text-red-400'
                          }`}>
                            {pos.currentValue != null
                              ? `$${pos.currentValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                              : '-'}
                          </td>
                          <td className={`py-3 text-sm font-medium text-right ${
                            pnl == null ? 'text-gray-500' : isProfit ? 'text-green-400' : 'text-red-400'
                          }`}>
                            {pnl != null ? (
                              <span title={`${pnlPct != null ? pnlPct.toFixed(1) : '0'}%`}>
                                {isProfit ? '+' : ''}{pnl < 0 ? '-' : ''}${Math.abs(pnl).toFixed(2)}
                                {pnlPct != null && (
                                  <span className="text-xs ml-1 opacity-70">
                                    ({isProfit ? '+' : ''}{pnlPct.toFixed(1)}%)
                                  </span>
                                )}
                              </span>
                            ) : '-'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Delete */}
          <div className="flex justify-end">
            <button onClick={handleDelete} disabled={bot.status === 'running'}
              className="px-4 py-2 border border-red-500/30 text-red-400 rounded-lg hover:bg-red-500/10 text-sm font-medium disabled:opacity-50">
              Delete Bot
            </button>
          </div>

          {/* Error Logs */}
          {bot.errorLogs.length > 0 && (
            <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-6">
              <h3 className="text-lg font-medium text-red-400 mb-4">Error Logs</h3>
              <div className="space-y-2">
                {bot.errorLogs.slice(-10).reverse().map((log, i) => (
                  <div key={i} className="text-sm">
                    <span className="text-red-400 font-mono">{new Date(log.timestamp).toLocaleString()}</span>
                    <span className="ml-2 text-red-300">{log.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'config' && (
        <div className="bg-surface border border-[#2a2a2a] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-white">Configuration</h3>
            {bot.status !== 'running' && (
              <div className="flex gap-2">
                {isEditing ? (
                  <>
                    <button onClick={() => setIsEditing(false)} className="px-3 py-1.5 border border-[#333] text-gray-300 rounded-md hover:bg-surface-light text-sm">Cancel</button>
                    <button onClick={handleSave} className="px-3 py-1.5 bg-accent text-white rounded-md hover:bg-accent-hover text-sm">Save</button>
                  </>
                ) : (
                  <button onClick={handleStartEdit} className="px-3 py-1.5 border border-[#333] text-gray-300 rounded-md hover:bg-surface-light text-sm">Edit</button>
                )}
              </div>
            )}
          </div>
          <dl className="space-y-3">
            {Object.entries(bot.config).map(([key, value]) => {
              const prop = schema?.properties?.[key] as any;
              return (
                <div key={key} className="grid grid-cols-3 gap-4">
                  <dt className="text-sm font-medium text-gray-400">{prop?.title || key}</dt>
                  <dd className="col-span-2 text-sm text-gray-100">{renderConfigValue(key, value, prop)}</dd>
                </div>
              );
            })}
          </dl>
        </div>
      )}

      {activeTab === 'code' && <CodeTab bot={bot} isTemplate={!!script?.isTemplate} />}

      {activeTab === 'orders' && <OrdersTab botId={bot.id} />}

      {activeTab === 'logs' && (
        <div className="bg-[#111] border border-[#2a2a2a] rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-[#2a2a2a]">
            <span className="text-sm text-gray-400">
              {logs.length > 0
                ? `${logs.length} log entries (the server keeps the last 500 since it started)`
                : bot.status === 'running' ? 'No log output yet.' : 'No logs yet. Start the bot to see output.'}
              {historyError && <span className="text-red-400"> · history unavailable: {historyError}</span>}
            </span>
            <button onClick={clearLogs} className="text-xs text-gray-500 hover:text-gray-300">Clear</button>
          </div>
          <div className="h-[calc(100vh-350px)] overflow-y-auto p-4 font-mono text-sm space-y-0.5">
            {logs.length === 0 ? (
              <p className="text-gray-600 text-center py-12">Waiting for logs...</p>
            ) : (
              logs.map((log, i) => {
                const levelColor = {
                  info: 'text-blue-400',
                  warn: 'text-yellow-400',
                  error: 'text-red-400',
                  debug: 'text-gray-500',
                }[log.level] || 'text-gray-400';

                return (
                  <div key={i} className="flex gap-3">
                    <span className="text-gray-600 flex-shrink-0">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                    <span className={`flex-shrink-0 w-12 ${levelColor}`}>{log.level}</span>
                    <span className="text-gray-300 break-all">{log.message}</span>
                  </div>
                );
              })
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}

      {activeTab === 'events' && (
        <div className="bg-[#111] border border-[#2a2a2a] rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-[#2a2a2a]">
            <span className="text-sm text-gray-400">
              {customEvents.length > 0
                ? `${customEvents.length} recent events from ctx.emit (newest first; the server keeps the last 100)`
                : 'No custom events yet. Scripts send them with ctx.emit(type, data).'}
            </span>
            <button onClick={clearEvents} className="text-xs text-gray-500 hover:text-gray-300">Clear</button>
          </div>
          <div className="max-h-[calc(100vh-350px)] overflow-y-auto p-4 font-mono text-sm space-y-1">
            {[...customEvents].reverse().map((ev, i) => (
              <div key={`${ev.timestamp}-${i}`} className="flex flex-wrap gap-x-3">
                <span className="text-gray-600 flex-shrink-0">{new Date(ev.timestamp).toLocaleTimeString()}</span>
                <span className="text-accent flex-shrink-0">{ev.type}</span>
                <span className="text-gray-300 break-all">{ev.data === null || ev.data === undefined ? '' : JSON.stringify(ev.data)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'trades' && (
        <div className="bg-surface border border-[#2a2a2a] rounded-xl p-6 text-center">
          <p className="text-gray-400 mb-3">View trade history for this bot</p>
          <Link to={`/bots/${bot.id}/trades`} className="text-accent hover:text-accent-hover font-medium">
            View Trade History →
          </Link>
        </div>
      )}
    </div>
  );
}

/** Read-only source of a script version and its diff against the previous version (spec §12 code view) */
function CodeTab({ bot, isTemplate }: { bot: Bot; isTemplate: boolean }) {
  const { data: versions = [], error } = useQuery({ queryKey: ['scriptVersions', bot.scriptId], queryFn: async () => (await scriptApi.versions(bot.scriptId)) as ScriptVersionInfo[] });
  const [picked, setPicked] = useState<number | null>(null);
  const [view, setView] = useState<'source' | 'diff'>('source');
  const selected = picked ?? bot.scriptRevision ?? versions[0]?.version ?? null;
  const prev = versions.filter((v) => selected !== null && v.version < selected).sort((a, b) => b.version - a.version)[0] ?? null;
  const src = useQuery({
    queryKey: ['scriptVersion', bot.scriptId, selected],
    enabled: selected !== null,
    queryFn: async () => (await scriptApi.version(bot.scriptId, selected!)) as { source: string },
  });
  const prevSrc = useQuery({
    queryKey: ['scriptVersion', bot.scriptId, prev?.version],
    enabled: view === 'diff' && prev !== null,
    queryFn: async () => (await scriptApi.version(bot.scriptId, prev!.version)) as { source: string },
  });
  const info = versions.find((v) => v.version === selected);
  return (
    <div className="space-y-4">
      <ErrorBox>{error ? errorMessage(error) : src.error ? errorMessage(src.error) : null}</ErrorBox>
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-gray-400">
          Version{' '}
          <select className="ml-1 px-2 py-1.5 rounded-lg bg-[#111] border border-[#333] text-sm" value={selected ?? ''} onChange={(e) => setPicked(Number(e.target.value))}>
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                r{v.version} · {new Date(v.createdAt).toLocaleDateString()} · {v.createdBy}
                {v.version === bot.scriptRevision ? ' (runs)' : ''}
                {v.version === bot.templateVersion ? ' (created on)' : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="inline-flex rounded-lg border border-[#333] overflow-hidden text-xs">
          {(['source', 'diff'] as const).map((m) => (
            <button key={m} type="button" onClick={() => setView(m)} className={`px-3 py-1.5 ${view === m ? 'bg-accent text-white' : 'text-gray-400 hover:text-gray-200'}`}>
              {m === 'source' ? 'Source' : 'Diff vs previous'}
            </button>
          ))}
        </div>
        <Link to={`/scripts/${bot.scriptId}`} className="text-sm text-accent hover:text-accent-hover">
          {isTemplate ? 'Open template →' : 'Open in editor →'}
        </Link>
      </div>
      <p className="text-xs text-gray-500">
        A started bot runs the script’s latest revision (r{bot.scriptRevision ?? '?'}); any source change demotes its bots to paper.
        {info ? ` Hash ${info.sourceHash.slice(0, 12)}.` : ''}
      </p>
      {view === 'source' ? (
        <ScriptEditor value={src.data?.source ?? '// loading…'} readOnly height="calc(100vh - 360px)" />
      ) : prev === null ? (
        <Empty>This is the first version: nothing to compare.</Empty>
      ) : src.data && prevSrc.data ? (
        <DiffView before={prevSrc.data.source} after={src.data.source} beforeLabel={`r${prev.version}`} afterLabel={`r${selected}`} />
      ) : (
        <p className="text-sm text-gray-500">Loading…</p>
      )}
    </div>
  );
}

const ORDER_TONE: Record<string, 'green' | 'red' | 'yellow' | 'gray' | 'blue'> = {
  filled: 'green',
  partially_filled: 'blue',
  open: 'blue',
  submitted: 'yellow',
  rejected_risk: 'red',
  failed: 'red',
  cancelled: 'gray',
  expired: 'gray',
};

/** Order attempts including risk rejections, and the ledger forecasts they traded on */
function OrdersTab({ botId }: { botId: string }) {
  const { data: orders = [], error, isFetching } = useQuery({
    queryKey: ['botOrders', botId],
    queryFn: async () => (await botApi.getOrders(botId, 300)) as BotOrder[],
    refetchInterval: 15_000,
  });
  const [onlyRejected, setOnlyRejected] = useState(false);
  const [forecastId, setForecastId] = useState<string | null>(null);
  const shown = onlyRejected ? orders.filter((o) => o.status === 'rejected_risk' || o.status === 'failed') : orders;
  const forecastIds = [...new Set(orders.map((o) => o.forecastId).filter((x): x is string => !!x))];
  return (
    <div className="space-y-6">
      <div className="bg-surface border border-[#2a2a2a] rounded-xl p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 className="text-lg font-medium text-white">Orders{isFetching ? ' …' : ''}</h3>
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input type="checkbox" checked={onlyRejected} onChange={(e) => setOnlyRejected(e.target.checked)} /> rejections and failures only
          </label>
        </div>
        <ErrorBox>{error ? errorMessage(error) : null}</ErrorBox>
        {shown.length === 0 ? (
          <Empty>No orders.</Empty>
        ) : (
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="min-w-full divide-y divide-[#2a2a2a]">
              <thead>
                <tr>
                  <th className={thCls}>Time</th>
                  <th className={thCls}>Order</th>
                  <th className={thCls}>Price × size</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Filled</th>
                  <th className={thCls}>Why</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2a2a2a]">
                {shown.map((o) => (
                  <tr key={o.id}>
                    <td className={`${tdCls} whitespace-nowrap text-xs text-gray-400`}>{dateTime(o.createdAt)}</td>
                    <td className={tdCls}>
                      <span className={o.side === 'buy' ? 'text-green-400' : 'text-red-400'}>{o.side}</span> {o.orderType}
                      {o.simulated && <span className="ml-1 text-xs text-amber-400">paper</span>}
                      <span className="block font-mono text-xs text-gray-500" title={o.tokenId}>
                        {o.exchange} {shortId(o.tokenId)}
                      </span>
                    </td>
                    <td className={`${tdCls} tabular-nums whitespace-nowrap`}>
                      {o.price} × {o.size.toFixed(2)}
                      <span className="block text-xs text-gray-500">{usd(o.notionalUsd)}</span>
                    </td>
                    <td className={tdCls}>
                      <Badge tone={ORDER_TONE[o.status] ?? 'gray'}>{o.status}</Badge>
                    </td>
                    <td className={`${tdCls} tabular-nums whitespace-nowrap`}>
                      {o.filledSize > 0 ? `${o.filledSize.toFixed(2)} @ ${o.avgFillPrice ?? '?'}` : '—'}
                      {o.feeUsd > 0 && <span className="block text-xs text-gray-500">fee {usd(o.feeUsd)}</span>}
                    </td>
                    <td className={`${tdCls} text-xs max-w-xs`}>
                      {o.failedCheck && (
                        <p>
                          <Badge tone="red">{o.failedCheck}</Badge> <span className="text-red-300 break-words">{o.riskReason}</span>
                        </p>
                      )}
                      {o.reason && <p className="text-gray-400 break-words">{o.reason}</p>}
                      {o.forecastId && (
                        <button type="button" className="text-accent hover:text-accent-hover" onClick={() => setForecastId(o.forecastId)}>
                          forecast {shortId(o.forecastId, 4)}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="bg-surface border border-[#2a2a2a] rounded-xl p-4 sm:p-6">
        <h3 className="text-lg font-medium text-white mb-3">Linked forecasts</h3>
        {forecastIds.length === 0 ? (
          <Empty>No order of this bot traded on a ledger forecast.</Empty>
        ) : (
          <ul className="divide-y divide-[#2a2a2a]">
            {forecastIds.map((fid) => (
              <LinkedForecast key={fid} id={fid} onOpen={() => setForecastId(fid)} />
            ))}
          </ul>
        )}
      </div>
      {forecastId && <ForecastDetail id={forecastId} onClose={() => setForecastId(null)} />}
    </div>
  );
}

function LinkedForecast({ id, onOpen }: { id: string; onOpen: () => void }) {
  const { data: f, error } = useQuery({ queryKey: ['forecast', id], queryFn: async () => (await ledgerApi.get(id)) as Forecast });
  return (
    <li className="py-2 text-sm flex flex-wrap items-center gap-2">
      <button type="button" className="text-accent hover:text-accent-hover font-mono text-xs" onClick={onOpen}>
        {shortId(id, 6)}
      </button>
      {error && <span className="text-red-400">{errorMessage(error)}</span>}
      {f && (
        <>
          <span className="text-gray-300">
            {f.category} · {f.horizonBucket}
          </span>
          <span className="text-gray-400">p {pct(f.probability)} vs mid {pct(f.marketPriceAtForecast)}</span>
          <Badge>{f.status}</Badge>
          {f.skill !== null && <span className={f.skill >= 0 ? 'text-green-400' : 'text-red-400'}>skill {f.skill.toFixed(3)}</span>}
        </>
      )}
    </li>
  );
}
