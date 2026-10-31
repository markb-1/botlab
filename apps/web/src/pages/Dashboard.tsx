import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useBots, useDashboardStats } from '../hooks/useBots';
import { useWallets } from '../hooks/useWallets';
import { useSettings } from '../hooks/useSettings';
import type { Bot } from '../types';

function StatusBadge({ status }: { status: Bot['status'] }) {
  const colors = {
    running: 'bg-green-500/10 text-green-400',
    stopped: 'bg-gray-500/10 text-gray-400',
    starting: 'bg-yellow-500/10 text-yellow-400',
    stopping: 'bg-yellow-500/10 text-yellow-400',
    error: 'bg-red-500/10 text-red-400',
  };

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colors[status]}`}>
      {status}
    </span>
  );
}

export function Dashboard() {
  const [pnlPeriod, setPnlPeriod] = useState<'all' | '24h'>('all');
  const { bots, isLoading: botsLoading, startBot, stopBot } = useBots();
  const { statsMap, isLoading: statsLoading } = useDashboardStats();
  const { wallets, isLoading: walletsLoading } = useWallets();
  const { settings, isLoading: settingsLoading } = useSettings();

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
      <div>
        <h2 className="text-2xl font-bold text-white">Dashboard</h2>
        <p className="mt-1 text-sm text-gray-400">
          Overview of your multi-bot trading system
        </p>
      </div>

      {/* Setup Warning */}
      {!settingsLoading && (!settings?.rpcUrl || settings.rpcUrl === '') && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-yellow-300">Setup Required</h3>
              <p className="mt-1 text-sm text-yellow-300/80">
                Please configure your RPC URL and other settings before starting bots.
              </p>
              <Link to="/settings" className="mt-2 inline-block text-sm font-medium text-accent hover:text-accent-hover">
                Go to Settings →
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-surface border border-[#2a2a2a] rounded-xl p-6">
          <h3 className="text-sm font-medium text-gray-400">Total Bots</h3>
          <p className="mt-2 text-3xl font-semibold text-white">
            {botsLoading ? '...' : bots.length}
          </p>
          <Link to="/bots" className="mt-2 text-sm text-accent hover:text-accent-hover">
            Manage bots →
          </Link>
        </div>

        <div className="bg-surface border border-[#2a2a2a] rounded-xl p-6">
          <h3 className="text-sm font-medium text-gray-400">Running</h3>
          <p className="mt-2 text-3xl font-semibold text-green-400">
            {botsLoading ? '...' : runningBots.length}
          </p>
          <p className="mt-1 text-sm text-gray-500">
            {stoppedBots.length} stopped, {errorBots.length} errors
          </p>
        </div>

        <div className="bg-surface border border-[#2a2a2a] rounded-xl p-6">
          <h3 className="text-sm font-medium text-gray-400">Wallets</h3>
          <p className="mt-2 text-3xl font-semibold text-white">
            {walletsLoading ? '...' : wallets.length}
          </p>
          <p className="mt-1 text-sm text-gray-500">
            {availableWallets.length} available
          </p>
          <Link to="/wallets" className="mt-2 text-sm text-accent hover:text-accent-hover">
            Manage wallets →
          </Link>
        </div>

        <div className="bg-surface border border-[#2a2a2a] rounded-xl p-6">
          <h3 className="text-sm font-medium text-gray-400">Settings</h3>
          <p className="mt-2 text-xl font-semibold text-white">
            {settingsLoading ? '...' : settings?.rpcUrl ? 'Configured' : 'Not Set'}
          </p>
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
                            pnlPeriod === 'all'
                              ? 'bg-accent text-white'
                              : 'text-gray-500 hover:text-gray-300'
                          }`}
                        >
                          All
                        </button>
                        <button
                          onClick={() => setPnlPeriod('24h')}
                          className={`px-1.5 py-0.5 text-[10px] font-medium rounded-r-md transition-colors ${
                            pnlPeriod === '24h'
                              ? 'bg-accent text-white'
                              : 'text-gray-500 hover:text-gray-300'
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
                  const pnlValue = botStats
                    ? pnlPeriod === 'all' ? botStats.pnlAllTime : botStats.pnl24h
                    : null;
                  return (
                    <tr key={bot.id} className="hover:bg-surface-light">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Link to={`/bots/${bot.id}`} className="text-sm font-medium text-accent hover:text-accent-hover">
                          {bot.name}
                        </Link>
                        {bot.mode === 'paper' && (
                          <span className="ml-2 text-xs bg-yellow-500/10 text-yellow-400 px-1.5 py-0.5 rounded">
                            PAPER
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
                          <span className="text-white font-medium">
                            ${botStats.totalValue.toFixed(2)}
                          </span>
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
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                        {bot.scriptName || bot.scriptId}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                        {bot.lastHeartbeat
                          ? new Date(bot.lastHeartbeat).toLocaleString()
                          : 'Never'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm space-x-3">
                        <Link
                          to={`/bots/${bot.id}/trades`}
                          className="text-accent hover:text-accent-hover font-medium"
                        >
                          Trades
                        </Link>
                        {bot.status === 'stopped' || bot.status === 'error' ? (
                          <button
                            onClick={() => handleStartBot(bot.id)}
                            className="text-green-400 hover:text-green-300 font-medium"
                          >
                            Start
                          </button>
                        ) : bot.status === 'running' ? (
                          <button
                            onClick={() => handleStopBot(bot.id)}
                            className="text-red-400 hover:text-red-300 font-medium"
                          >
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
                  {bot.errorLogs.length > 0 && (
                    <p className="text-sm text-red-400">
                      {bot.errorLogs[bot.errorLogs.length - 1].message}
                    </p>
                  )}
                </div>
                <Link
                  to={`/bots/${bot.id}`}
                  className="text-sm text-red-400 hover:text-red-300 font-medium"
                >
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
