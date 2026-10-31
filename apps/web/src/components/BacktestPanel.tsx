import { useState } from 'react';
import { useBacktestRuns, useBacktestResult, useRunBacktest, useDeleteBacktest } from '../hooks/useBacktest';
import type { BacktestRun } from '../types/backtest';

interface BacktestPanelProps {
  scriptId: string;
}

export function BacktestPanel({ scriptId }: BacktestPanelProps) {
  // Config state
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [interval, setInterval] = useState('1h');
  const [daysBack, setDaysBack] = useState(7);
  const [initialBalance, setInitialBalance] = useState(1000);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'results' | 'history'>('results');
  const [localError, setLocalError] = useState<string | null>(null);

  // Hooks
  const { runs, isLoading: runsLoading } = useBacktestRuns(scriptId);
  const { result: selectedResult, isLoading: resultLoading } = useBacktestResult(selectedRunId || undefined);
  const { runBacktest, isRunning, error: _runError, result: latestResult, reset: resetResult } = useRunBacktest();
  const { deleteRun } = useDeleteBacktest();

  const handleRun = async () => {
    resetResult();
    setSelectedRunId(null);
    setLocalError(null);
    const now = Date.now();
    const startTime = now - daysBack * 24 * 60 * 60 * 1000;

    try {
      const result = await runBacktest({
        scriptId,
        symbol: symbol.toUpperCase(),
        interval,
        startTime,
        endTime: now,
        initialBalance,
      });
      if (result.runId) {
        setSelectedRunId(result.runId);
        setActiveTab('results');
      }
    } catch (err: any) {
      setLocalError(err.message || 'Backtest failed');
    }
  };

  const handleDelete = async (runId: string) => {
    await deleteRun(runId);
    if (selectedRunId === runId) {
      setSelectedRunId(null);
    }
  };

  const handleSelectRun = (run: BacktestRun) => {
    setSelectedRunId(run.id);
    setActiveTab('results');
  };

  // Current stats to display
  const displayStats = selectedRunId && selectedResult
    ? {
        initialBalance: selectedResult.run.initialBalance,
        finalBalance: selectedResult.run.finalBalance ?? 0,
        totalPnl: selectedResult.run.totalPnl ?? 0,
        totalPnlPct: selectedResult.run.initialBalance > 0
          ? ((selectedResult.run.totalPnl ?? 0) / selectedResult.run.initialBalance) * 100
          : 0,
        totalTrades: selectedResult.run.totalTrades,
        winTrades: selectedResult.run.winTrades,
        loseTrades: selectedResult.run.loseTrades,
        winRate: selectedResult.run.totalTrades > 0
          ? (selectedResult.run.winTrades / selectedResult.run.totalTrades) * 100
          : 0,
        maxDrawdown: selectedResult.run.maxDrawdown ?? 0,
        sharpeRatio: selectedResult.run.sharpeRatio ?? 0,
        durationMs: selectedResult.run.durationMs ?? 0,
      }
    : latestResult?.stats ?? null;

  return (
    <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl flex flex-col h-full overflow-hidden">
      {/* Config Bar */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[#2a2a2a] flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-gray-500">Symbol</label>
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            className="w-24 px-2 py-1 text-xs bg-[#111] border border-[#333] rounded text-white focus:border-accent focus:outline-none"
            placeholder="BTCUSDT"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-gray-500">Interval</label>
          <select
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            className="px-2 py-1 text-xs bg-[#111] border border-[#333] rounded text-white focus:border-accent focus:outline-none"
          >
            <option value="1m">1m</option>
            <option value="5m">5m</option>
            <option value="15m">15m</option>
            <option value="30m">30m</option>
            <option value="1h">1h</option>
            <option value="4h">4h</option>
            <option value="1d">1d</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-gray-500">Period</label>
          <select
            value={daysBack}
            onChange={(e) => setDaysBack(Number(e.target.value))}
            className="px-2 py-1 text-xs bg-[#111] border border-[#333] rounded text-white focus:border-accent focus:outline-none"
          >
            <option value={1}>1 day</option>
            <option value={3}>3 days</option>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-gray-500">Balance</label>
          <input
            type="number"
            value={initialBalance}
            onChange={(e) => setInitialBalance(Number(e.target.value))}
            className="w-20 px-2 py-1 text-xs bg-[#111] border border-[#333] rounded text-white focus:border-accent focus:outline-none"
            min={1}
          />
        </div>
        <button
          onClick={handleRun}
          disabled={isRunning || !symbol}
          className="px-3 py-1 text-xs font-medium text-white bg-accent rounded hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
        >
          {isRunning ? (
            <>
              <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Running...
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              </svg>
              Run Backtest
            </>
          )}
        </button>

        {/* Tab toggles */}
        <div className="ml-auto flex gap-1">
          <button
            onClick={() => setActiveTab('results')}
            className={`px-2.5 py-1 text-xs rounded ${
              activeTab === 'results'
                ? 'bg-accent/10 text-accent'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            Results
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`px-2.5 py-1 text-xs rounded ${
              activeTab === 'history'
                ? 'bg-accent/10 text-accent'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            History{runs.length > 0 && ` (${runs.length})`}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto min-h-0">
        {activeTab === 'results' ? (
          <ResultsTab
            stats={displayStats}
            trades={selectedResult?.trades || []}
            isRunning={isRunning}
            resultLoading={resultLoading}
            error={localError || (latestResult?.status === 'error' ? latestResult.error : undefined)}
          />
        ) : (
          <HistoryTab
            runs={runs}
            isLoading={runsLoading}
            selectedRunId={selectedRunId}
            onSelect={handleSelectRun}
            onDelete={handleDelete}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Results Tab
// ============================================================================

interface StatsData {
  initialBalance: number;
  finalBalance: number;
  totalPnl: number;
  totalPnlPct: number;
  totalTrades: number;
  winTrades: number;
  loseTrades: number;
  winRate: number;
  maxDrawdown: number;
  sharpeRatio: number;
  durationMs: number;
  klinesProcessed?: number;
  tickErrors?: number;
  firstTickError?: string;
}

function ResultsTab({
  stats,
  trades,
  isRunning,
  resultLoading,
  error,
}: {
  stats: StatsData | null;
  trades: Array<{ id: string; side: string; symbol: string; price: number; quantity: number; quoteAmount: number; timestamp: number; balanceAfter: number | null }>;
  isRunning: boolean;
  resultLoading: boolean;
  error?: string;
}) {
  if (isRunning) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        <svg className="animate-spin w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Running backtest... This may take a moment.
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
          <p className="text-sm text-red-300">Backtest failed: {error}</p>
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-full text-gray-600 text-sm">
        Run a backtest to see results
      </div>
    );
  }

  if (resultLoading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Loading results...
      </div>
    );
  }

  const isProfitable = stats.totalPnl >= 0;

  return (
    <div className="p-3 space-y-3">
      {/* Stats Row */}
      <div className="grid grid-cols-4 lg:grid-cols-8 gap-2">
        <StatCard label="Initial" value={`$${stats.initialBalance.toFixed(2)}`} />
        <StatCard
          label="Final"
          value={`$${stats.finalBalance.toFixed(2)}`}
          color={isProfitable ? 'green' : 'red'}
        />
        <StatCard
          label="PnL"
          value={`${isProfitable ? '+' : ''}$${stats.totalPnl.toFixed(2)}`}
          sub={`${isProfitable ? '+' : ''}${stats.totalPnlPct.toFixed(1)}%`}
          color={isProfitable ? 'green' : 'red'}
        />
        <StatCard label="Trades" value={String(stats.totalTrades)} />
        <StatCard
          label="Win Rate"
          value={`${stats.winRate.toFixed(1)}%`}
          sub={`${stats.winTrades}W / ${stats.loseTrades}L`}
          color={stats.winRate >= 50 ? 'green' : 'red'}
        />
        <StatCard
          label="Max DD"
          value={`${(stats.maxDrawdown * 100).toFixed(1)}%`}
          color={stats.maxDrawdown > 0.1 ? 'red' : 'default'}
        />
        <StatCard
          label="Sharpe"
          value={stats.sharpeRatio.toFixed(2)}
          color={stats.sharpeRatio > 1 ? 'green' : stats.sharpeRatio < 0 ? 'red' : 'default'}
        />
        <StatCard label="Duration" value={formatDuration(stats.durationMs)} />
      </div>

      {/* Diagnostics — shown when there are tick errors or 0 trades with processed klines */}
      {(stats.tickErrors != null && stats.tickErrors > 0) && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-2.5">
          <p className="text-xs text-yellow-300">
            {stats.tickErrors} of {stats.klinesProcessed ?? '?'} ticks threw errors.
            {stats.firstTickError && (
              <span className="block mt-1 text-yellow-400/80 font-mono">
                First error: {stats.firstTickError}
              </span>
            )}
          </p>
        </div>
      )}
      {stats.totalTrades === 0 && !stats.tickErrors && stats.klinesProcessed != null && (
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-4 py-2.5">
          <p className="text-xs text-blue-300">
            Processed {stats.klinesProcessed} candles with no errors. The strategy conditions were not met during this period.
          </p>
        </div>
      )}

      {/* Trades Table */}
      {trades.length > 0 && (
        <div className="overflow-auto max-h-[200px]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[#1a1a1a]">
              <tr className="text-gray-500 border-b border-[#2a2a2a]">
                <th className="text-left py-1.5 px-2 font-medium">Time</th>
                <th className="text-left py-1.5 px-2 font-medium">Side</th>
                <th className="text-left py-1.5 px-2 font-medium">Symbol</th>
                <th className="text-right py-1.5 px-2 font-medium">Price</th>
                <th className="text-right py-1.5 px-2 font-medium">Qty</th>
                <th className="text-right py-1.5 px-2 font-medium">Amount</th>
                <th className="text-right py-1.5 px-2 font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => (
                <tr key={trade.id} className="border-b border-[#222] hover:bg-[#222]">
                  <td className="py-1.5 px-2 text-gray-400">
                    {new Date(trade.timestamp).toLocaleString(undefined, {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </td>
                  <td className={`py-1.5 px-2 font-medium ${
                    trade.side === 'BUY' ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {trade.side}
                  </td>
                  <td className="py-1.5 px-2 text-white">{trade.symbol}</td>
                  <td className="py-1.5 px-2 text-right text-gray-300">${trade.price.toFixed(2)}</td>
                  <td className="py-1.5 px-2 text-right text-gray-300">{trade.quantity.toFixed(6)}</td>
                  <td className="py-1.5 px-2 text-right text-gray-300">${trade.quoteAmount.toFixed(2)}</td>
                  <td className="py-1.5 px-2 text-right text-white">
                    {trade.balanceAfter !== null ? `$${trade.balanceAfter.toFixed(2)}` : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// History Tab
// ============================================================================

function HistoryTab({
  runs,
  isLoading,
  selectedRunId,
  onSelect,
  onDelete,
}: {
  runs: BacktestRun[];
  isLoading: boolean;
  selectedRunId: string | null;
  onSelect: (run: BacktestRun) => void;
  onDelete: (runId: string) => void;
}) {
  if (isLoading) {
    return <div className="p-4 text-sm text-gray-500">Loading history...</div>;
  }

  if (runs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-600 text-sm">
        No backtest runs yet
      </div>
    );
  }

  return (
    <div className="overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-[#1a1a1a]">
          <tr className="text-gray-500 border-b border-[#2a2a2a]">
            <th className="text-left py-1.5 px-3 font-medium">Date</th>
            <th className="text-left py-1.5 px-3 font-medium">Symbol</th>
            <th className="text-left py-1.5 px-3 font-medium">Period</th>
            <th className="text-right py-1.5 px-3 font-medium">PnL</th>
            <th className="text-right py-1.5 px-3 font-medium">Trades</th>
            <th className="text-right py-1.5 px-3 font-medium">Win Rate</th>
            <th className="text-left py-1.5 px-3 font-medium">Status</th>
            <th className="text-right py-1.5 px-3 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const pnl = run.totalPnl ?? 0;
            const isProfitable = pnl >= 0;
            const winRate = run.totalTrades > 0
              ? (run.winTrades / run.totalTrades) * 100
              : 0;
            const periodDays = Math.round(
              (run.endTime - run.startTime) / (24 * 60 * 60 * 1000)
            );

            return (
              <tr
                key={run.id}
                onClick={() => onSelect(run)}
                className={`border-b border-[#222] cursor-pointer transition-colors ${
                  selectedRunId === run.id ? 'bg-accent/5' : 'hover:bg-[#222]'
                }`}
              >
                <td className="py-1.5 px-3 text-gray-400">
                  {new Date(run.createdAt).toLocaleDateString(undefined, {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })}
                </td>
                <td className="py-1.5 px-3 text-white">{run.symbol}</td>
                <td className="py-1.5 px-3 text-gray-400">{periodDays}d</td>
                <td className={`py-1.5 px-3 text-right font-medium ${
                  isProfitable ? 'text-green-400' : 'text-red-400'
                }`}>
                  {run.status === 'completed'
                    ? `${isProfitable ? '+' : ''}$${pnl.toFixed(2)}`
                    : '-'
                  }
                </td>
                <td className="py-1.5 px-3 text-right text-gray-300">{run.totalTrades}</td>
                <td className="py-1.5 px-3 text-right text-gray-300">
                  {run.totalTrades > 0 ? `${winRate.toFixed(0)}%` : '-'}
                </td>
                <td className="py-1.5 px-3">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    run.status === 'completed'
                      ? 'bg-green-500/10 text-green-400'
                      : run.status === 'error'
                      ? 'bg-red-500/10 text-red-400'
                      : 'bg-yellow-500/10 text-yellow-400'
                  }`}>
                    {run.status}
                  </span>
                </td>
                <td className="py-1.5 px-3 text-right">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(run.id);
                    }}
                    className="text-gray-600 hover:text-red-400 transition-colors"
                    title="Delete run"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function StatCard({
  label,
  value,
  sub,
  color = 'default',
}: {
  label: string;
  value: string;
  sub?: string;
  color?: 'green' | 'red' | 'default';
}) {
  const colorClass =
    color === 'green' ? 'text-green-400' :
    color === 'red' ? 'text-red-400' :
    'text-white';

  return (
    <div className="bg-[#111] rounded-lg px-2.5 py-2">
      <div className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-semibold ${colorClass} mt-0.5`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
