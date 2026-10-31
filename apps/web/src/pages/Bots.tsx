import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useBots } from '../hooks/useBots';
import type { Bot } from '../types';
import { useOverview } from '../hooks/useRisk';
import { Badge, ErrorBox, StageBadge } from '../components/ui';
import { usd } from '../lib/format';

/** Builtin roles: standing (spec §9.1, §9.2; one running instance per mode) and per-opportunity strategies (§9.3, §9.4) */
const ROLE_LABELS: Record<string, string> = {
  'forecast-executor': 'executor',
  'position-manager': 'position manager',
  consistency: 'consistency',
  'resolution-rule': 'resolution rule',
};
const ROLE_TITLES: Record<string, string> = {
  'forecast-executor': 'Standing forecast executor: bids on tradeable ledger forecasts (one per mode)',
  'position-manager': "Standing position manager: exits every bot's positions as risk exits (one per mode)",
  consistency: 'Consistency bot: trades violations of a constraint between markets with hedged baskets',
  'resolution-rule': 'Resolution-rule bot: bids up to a target on one outcome per its thesis, holds to resolution',
};

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

export function Bots() {
  const { bots, isLoading, startBot, stopBot, deleteBot } = useBots();
  const [filterType, setFilterType] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [actionError, setActionError] = useState<string | null>(null);
  const { data: overview } = useOverview();
  const allocationOf = new Map((overview?.bots ?? []).map((a) => [a.botId, a]));
  const haltOf = new Map((overview?.halts.bots ?? []).map((h) => [h.botId, h]));

  const filteredBots = bots.filter((bot) => {
    if (filterType !== 'all' && bot.scriptName !== filterType) return false;
    if (filterStatus !== 'all' && bot.status !== filterStatus) return false;
    return true;
  });

  const scriptNames = [...new Set(bots.map((b) => b.scriptName).filter(Boolean))];

  const handleStartBot = async (id: string) => {
    setActionError(null);
    try {
      await startBot(id);
    } catch (err) {
      setActionError(`Could not start the bot: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleStopBot = async (id: string) => {
    setActionError(null);
    try {
      await stopBot(id);
    } catch (err) {
      setActionError(`Could not stop the bot: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDeleteBot = async (bot: Bot) => {
    if (bot.status === 'running') {
      alert('Please stop the bot before deleting');
      return;
    }
    if (!confirm(`Are you sure you want to delete "${bot.name}"?`)) return;

    try {
      await deleteBot(bot.id);
    } catch (err) {
      console.error('Failed to delete bot:', err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Bots</h2>
          <p className="mt-1 text-sm text-gray-400">
            Manage your trading bots
          </p>
        </div>
        <Link
          to="/bots/new"
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-lg text-white bg-accent hover:bg-accent-hover"
        >
          + Create Bot
        </Link>
      </div>

      {/* Filters */}
      <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-4">
        <div className="flex gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Script</label>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="block w-40 rounded-md bg-[#111111] border-[#333] text-gray-200 shadow-sm focus:border-accent focus:ring-accent sm:text-sm"
            >
              <option value="all">All Scripts</option>
              {scriptNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Status</label>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="block w-40 rounded-md bg-[#111111] border-[#333] text-gray-200 shadow-sm focus:border-accent focus:ring-accent sm:text-sm"
            >
              <option value="all">All Statuses</option>
              <option value="running">Running</option>
              <option value="stopped">Stopped</option>
              <option value="error">Error</option>
            </select>
          </div>
        </div>
      </div>

      <ErrorBox>{actionError}</ErrorBox>

      {/* Bots Table */}
      <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl overflow-x-auto">
        {isLoading ? (
          <div className="p-6 text-center text-gray-500">Loading bots...</div>
        ) : filteredBots.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-gray-500 mb-4">
              {bots.length === 0 ? 'No bots created yet' : 'No bots match the filters'}
            </p>
            {bots.length === 0 && (
              <Link
                to="/bots/new"
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-lg text-white bg-accent hover:bg-accent-hover"
              >
                Create your first bot
              </Link>
            )}
          </div>
        ) : (
          <table className="min-w-full divide-y divide-[#2a2a2a]">
            <thead className="bg-[#111111]">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Script</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Stage</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Allocation used / available</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Activity</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-[#1a1a1a] divide-y divide-[#2a2a2a]">
              {filteredBots.map((bot) => (
                <tr key={bot.id} className="hover:bg-[#222222]">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Link to={`/bots/${bot.id}`} className="text-sm font-medium text-accent hover:text-accent-hover">
                      {bot.name}
                    </Link>
                    <span className="block text-xs text-gray-500">by {bot.createdBy ?? 'human'}</span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                    {bot.scriptName || bot.scriptId}
                    {bot.role && (
                      <span className="block mt-1">
                        <Badge tone="blue" title={ROLE_TITLES[bot.role] ?? 'Standing builtin bot'}>
                          {ROLE_LABELS[bot.role] ?? bot.role}
                        </Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <StatusBadge status={bot.status} />
                      {bot.mode === 'paper' && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400">
                          PAPER
                        </span>
                      )}
                      {haltOf.has(bot.id) && (
                        <Badge tone="red" title={haltOf.get(bot.id)!.reason ?? undefined}>
                          halted
                        </Badge>
                      )}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <StageBadge stage={bot.stage} />
                    {bot.stage === 'retired' && bot.retireReason && <span className="block text-xs text-gray-500 max-w-[14rem] truncate" title={bot.retireReason}>{bot.retireReason}</span>}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300 tabular-nums">
                    {(() => {
                      const a = allocationOf.get(bot.id);
                      if (!a) return <span className="text-gray-500">—</span>;
                      return (
                        <span title={a.simulated ? 'paper orders and fills' : 'live orders and fills'}>
                          {usd(a.usedUsd, 0)} / {a.availableUsd === null ? '—' : usd(a.availableUsd, 0)}
                          {a.simulated && <span className="ml-1 text-xs text-gray-500">paper</span>}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                    {bot.lastHeartbeat
                      ? new Date(bot.lastHeartbeat).toLocaleString()
                      : bot.lastStartedAt
                        ? new Date(bot.lastStartedAt).toLocaleString()
                        : 'Never'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm space-x-3">
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
                    <Link
                      to={`/bots/${bot.id}`}
                      className="text-accent hover:text-accent-hover font-medium"
                    >
                      Edit
                    </Link>
                    <button
                      onClick={() => handleDeleteBot(bot)}
                      className="text-red-400 hover:text-red-300 font-medium"
                      disabled={bot.status === 'running'}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
