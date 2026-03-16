import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useBot, useBots, useBotPositions, useBotStats } from '../hooks/useBots';
import { useScript, useScriptSchema } from '../hooks/useScripts';
import { useWallets } from '../hooks/useWallets';
import { events } from '../lib/electronApi';
import { ScriptEditor } from '../components/ScriptEditor';
import type { Bot } from '../types';

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

type Tab = 'overview' | 'config' | 'script' | 'logs' | 'trades';

export function BotDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { bot, isLoading } = useBot(id!);
  const { updateBot, startBot, stopBot, restartBot, deleteBot } = useBots();
  const { wallets } = useWallets();
  const { script } = useScript(bot?.scriptId || '');
  const { schema } = useScriptSchema(bot?.scriptId || '');

  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [isEditing, setIsEditing] = useState(false);
  const [editConfig, setEditConfig] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<Array<{ timestamp: string; level: string; message: string }>>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const [pnlPeriod, setPnlPeriod] = useState<'allTime' | '24h'>('allTime');

  const wallet = wallets.find((w) => w.id === bot?.walletId);
  const { positions } = useBotPositions(id!);
  const { stats } = useBotStats(id!);

  // Subscribe to bot logs
  useEffect(() => {
    const cleanup = events.onBotLog((log: any) => {
      if (log.botId === id) {
        setLogs((prev) => [...prev.slice(-500), {
          timestamp: log.timestamp || new Date().toISOString(),
          level: log.level || 'info',
          message: log.message || JSON.stringify(log),
        }]);
      }
    });
    return cleanup;
  }, [id]);

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
    { id: 'script', label: 'Script' },
    { id: 'logs', label: 'Logs' },
    { id: 'trades', label: 'Trades' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link to="/bots" className="text-sm text-gray-500 hover:text-gray-300">← Back to Bots</Link>
          <h2 className="mt-2 text-2xl font-bold text-white">{bot.name}</h2>
          <p className="mt-1 text-sm text-gray-400">{bot.scriptName || bot.scriptId}</p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={bot.status} />
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
      <div className="flex gap-1 border-b border-[#2a2a2a]">
        {tabs.map((tab) => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-accent text-accent'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Portfolio Stats */}
          {stats && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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

      {activeTab === 'script' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-400">
              {script?.isTemplate ? 'Template script (read-only)' : 'Custom script'}
              {script && (
                <Link to={`/scripts/${script.id}`} className="ml-2 text-accent hover:text-accent-hover">
                  Open in editor →
                </Link>
              )}
            </p>
          </div>
          <ScriptEditor
            value={script?.source || '// Script source not available'}
            readOnly
            height="calc(100vh - 320px)"
          />
        </div>
      )}

      {activeTab === 'logs' && (
        <div className="bg-[#111] border border-[#2a2a2a] rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-[#2a2a2a]">
            <span className="text-sm text-gray-400">
              {logs.length > 0 ? `${logs.length} log entries` : 'No logs yet. Start the bot to see output.'}
            </span>
            <button onClick={() => setLogs([])} className="text-xs text-gray-500 hover:text-gray-300">Clear</button>
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
