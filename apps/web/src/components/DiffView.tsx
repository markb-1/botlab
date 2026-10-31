import { useMemo, useState } from 'react';
import { diffLines, diffStats, withContext } from '../lib/lineDiff';

/** Unified line diff (old → new) with collapsed unchanged runs */
export function DiffView({ before, after, beforeLabel, afterLabel }: { before: string; after: string; beforeLabel?: string; afterLabel?: string }) {
  const [full, setFull] = useState(false);
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const stats = diffStats(lines);
  const rows = full ? lines : withContext(lines, 3);
  return (
    <div className="rounded-lg border border-[#2a2a2a] overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-[#111] text-xs text-gray-400 border-b border-[#2a2a2a]">
        <span>
          {beforeLabel ?? 'before'} → {afterLabel ?? 'after'}: <span className="text-green-400">+{stats.added}</span>{' '}
          <span className="text-red-400">−{stats.removed}</span>
        </span>
        <button type="button" className="text-accent hover:text-accent-hover" onClick={() => setFull((f) => !f)}>
          {full ? 'Show changes only' : 'Show whole file'}
        </button>
      </div>
      {stats.added + stats.removed === 0 ? (
        <p className="p-3 text-sm text-gray-500">No differences.</p>
      ) : (
        <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
          <table className="min-w-full font-mono text-xs leading-5">
            <tbody>
              {rows.map((r, i) =>
                r.type === 'skip' ? (
                  <tr key={i} className="bg-[#151515] text-gray-600">
                    <td colSpan={3} className="px-3 py-0.5">
                      ⋯ {r.count} unchanged line{r.count === 1 ? '' : 's'}
                    </td>
                  </tr>
                ) : (
                  <tr key={i} className={r.type === 'add' ? 'bg-green-500/10' : r.type === 'del' ? 'bg-red-500/10' : ''}>
                    <td className="px-2 text-right text-gray-600 select-none w-10">{r.type !== 'add' ? r.oldNo : ''}</td>
                    <td className="px-2 text-right text-gray-600 select-none w-10">{r.type !== 'del' ? r.newNo : ''}</td>
                    <td className={`px-2 whitespace-pre ${r.type === 'add' ? 'text-green-300' : r.type === 'del' ? 'text-red-300' : 'text-gray-300'}`}>
                      {r.type === 'add' ? '+ ' : r.type === 'del' ? '− ' : '  '}
                      {r.text}
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
