import { useState } from 'react';
import type { Bot, CopyLeader } from '../types';
import { useCopyLeaders } from '../hooks/useBots';
import { Badge, type Tone } from './ui';
import { dateTime, errorMessage, pct, shortId, signedUsd } from '../lib/format';

const STATUS_TONE: Record<CopyLeader['status'], Tone> = { active: 'green', dropped: 'red', removed: 'gray' };

/**
 * Copy-trading bots (5c, spec §9.5): each leader's status, copies and score (server-side: realised / unrealised P&L,
 * hit rate, the auto-drop window). A dropped leader can be re-activated by the human here.
 */
export function LeadersPanel({ bot }: { bot: Bot }) {
  const isCopy = bot.role === 'copy';
  const { leaders, isLoading, error, reactivate, isReactivating } = useCopyLeaders(bot.id, isCopy);
  const [actionError, setActionError] = useState<string | null>(null);
  if (!isCopy) return null;
  const shown = (leaders ?? []).filter((l) => l.status !== 'removed' || l.ordersCopied > 0);

  const onReactivate = async (address: string) => {
    setActionError(null);
    try {
      await reactivate(address);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  return (
    <div className="bg-surface border border-[#2a2a2a] rounded-xl p-4 sm:p-6">
      <h3 className="text-lg font-medium text-white mb-1">Leaders</h3>
      <p className="text-xs text-gray-500 mb-4">
        A leader whose last 20 closed copied trades lost money with a hit rate under 50% is dropped automatically. Leader changes in the config apply at the
        next start.
      </p>
      {isLoading && <p className="text-sm text-gray-400">Loading…</p>}
      {error && <p className="text-sm text-red-300">{errorMessage(error)}</p>}
      {!isLoading && !error && shown.length === 0 && (
        <p className="text-sm text-gray-400">No leaders yet (they are recorded when the bot is created or starts).</p>
      )}
      {actionError && <p className="text-sm text-red-300 mb-2">{actionError}</p>}
      {shown.length > 0 && (
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-400 border-b border-[#2a2a2a]">
                <th className="px-4 sm:px-2 py-2 font-medium">Leader</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium text-right">Copied</th>
                <th className="px-2 py-2 font-medium text-right">Closed / open</th>
                <th className="px-2 py-2 font-medium text-right">Hit rate</th>
                <th className="px-2 py-2 font-medium text-right">Realised</th>
                <th className="px-2 py-2 font-medium text-right">Unrealised</th>
                <th className="px-2 py-2 font-medium text-right" title="Last 20 closed copies since the leader became active">
                  Drop window
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.address} className="border-b border-[#2a2a2a] last:border-0 align-top">
                  <td className="px-4 sm:px-2 py-2 font-mono text-xs text-gray-200" title={l.address}>
                    {shortId(l.address, 10)}
                    <div className="text-[11px] text-gray-500 font-sans">
                      added by {l.addedBy} · {dateTime(l.addedAt)}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <Badge tone={STATUS_TONE[l.status]}>{l.status}</Badge>
                    {(l.status === 'dropped' || l.blocked) && (
                      <div className="mt-1 text-xs text-red-300/80 max-w-[16rem] break-words">
                        {l.status === 'dropped'
                          ? `${l.droppedReason ?? 'dropped'} · ${dateTime(l.droppedAt)}`
                          : 'Dropped on another bot: the agent cannot add it'}
                        <div>
                          <button
                            type="button"
                            className="mt-1 text-xs text-accent hover:underline disabled:opacity-50"
                            disabled={isReactivating}
                            onClick={() => onReactivate(l.address)}
                          >
                            Re-activate
                          </button>
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-gray-100">{l.ordersCopied}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-gray-100">
                    {l.closedTrades} / {l.openTrades}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-gray-100">{pct(l.hitRate)}</td>
                  <td className={`px-2 py-2 text-right tabular-nums ${l.realisedPnlUsd < 0 ? 'text-red-400' : 'text-gray-100'}`}>
                    {signedUsd(l.realisedPnlUsd)}
                  </td>
                  <td className={`px-2 py-2 text-right tabular-nums ${(l.unrealisedPnlUsd ?? 0) < 0 ? 'text-red-400' : 'text-gray-100'}`}>
                    {signedUsd(l.unrealisedPnlUsd)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-gray-400 text-xs">
                    {l.window.trades}/{l.window.size} · {signedUsd(l.window.pnlUsd)} · {pct(l.window.hitRate)}
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
