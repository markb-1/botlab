import type { Bot } from '../types';
import type { CustomEvent } from '../lib/botActivity';
import { Badge } from './ui';
import { dateTime, shortId, usd } from '../lib/format';

/** The newest custom event of a type (events arrive oldest first) */
function latest(events: CustomEvent[], type: string): { at: string; data: Record<string, unknown> } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === type && e.data && typeof e.data === 'object') return { at: e.timestamp, data: e.data as Record<string, unknown> };
  }
  return null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const CONSTRAINT_TEXT: Record<string, string> = {
  implies: 'Token 1 implies token 2: P(1) ≤ P(2)',
  date_ladder: 'Date ladder (earliest deadline first): prices non-decreasing',
  exclusive_sum: 'Mutually exclusive outcomes: Σ P ≤ max',
};

/**
 * Per-opportunity strategy bots (5b): the consistency constraint with its current gap, or the resolution-rule
 * thesis with its state. Config comes from the bot; live values from the bot's emitted events.
 */
export function StrategyPanel({ bot, events }: { bot: Bot; events: CustomEvent[] }) {
  if (bot.role !== 'consistency' && bot.role !== 'resolution-rule') return null;
  const c = bot.config as Record<string, unknown>;

  if (bot.role === 'consistency') {
    const ev = latest(events, 'consistency');
    const gap = num(ev?.data.gap);
    const minGap = num(ev?.data.minGap) ?? num(c.min_gap) ?? 0.03;
    const tokens = Array.isArray(c.tokens) ? (c.tokens as unknown[]).map(String) : [];
    const constraint = str(c.constraint) ?? '?';
    const error = str(ev?.data.error);
    return (
      <div className="bg-surface border border-[#2a2a2a] rounded-xl p-4 sm:p-6">
        <h3 className="text-lg font-medium text-white mb-1">Consistency constraint</h3>
        <p className="text-sm text-gray-300">
          {CONSTRAINT_TEXT[constraint] ?? constraint}
          {constraint === 'exclusive_sum' && ` (max ${String(c.max_sum ?? 1)}${c.exhaustive ? ', exhaustive' : ''})`}
        </p>
        <ol className="mt-2 text-xs text-gray-400 font-mono list-decimal list-inside break-all">
          {tokens.map((t) => (
            <li key={t}>{shortId(t)}</li>
          ))}
        </ol>
        <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <dt className="text-gray-400">Current gap (after fees)</dt>
            <dd className={`mt-1 tabular-nums font-semibold ${gap !== null && gap >= minGap ? 'text-green-400' : 'text-gray-100'}`}>
              {gap === null ? '—' : gap.toFixed(3)} <span className="text-xs text-gray-500 font-normal">min {minGap}</span>
            </dd>
          </div>
          <div>
            <dt className="text-gray-400">Best basket</dt>
            <dd className="mt-1 text-gray-100">{str(ev?.data.basket) ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-400">State</dt>
            <dd className="mt-1">
              <Badge tone={ev?.data.phase === 'unhedged' ? 'red' : ev?.data.phase === 'resting' || ev?.data.phase === 'escalating' ? 'yellow' : 'gray'}>
                {str(ev?.data.phase) ?? 'no data yet'}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-gray-400">Baskets opened / hedged</dt>
            <dd className="mt-1 text-gray-100 tabular-nums">
              {num(ev?.data.baskets) ?? 0} / {num(ev?.data.hedged) ?? 0}
            </dd>
          </div>
        </dl>
        {error && <p className="mt-3 text-sm text-red-300 break-words">{error}</p>}
        {ev && <p className="mt-3 text-xs text-gray-500">Updated {dateTime(ev.at)}{str(ev.data.detail) ? ` · ${str(ev.data.detail)}` : ''}</p>}
      </div>
    );
  }

  const ev = latest(events, 'resolution_rule');
  const state = str(ev?.data.state);
  return (
    <div className="bg-surface border border-[#2a2a2a] rounded-xl p-4 sm:p-6">
      <h3 className="text-lg font-medium text-white mb-2">Resolution-rule thesis</h3>
      <p className="text-sm text-gray-200 whitespace-pre-wrap break-words">{str(c.thesis) ?? 'No thesis recorded'}</p>
      <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
        <div>
          <dt className="text-gray-400">Token</dt>
          <dd className="mt-1 text-gray-100 font-mono break-all">{shortId(String(c.token_id ?? '—'))}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Target entry</dt>
          <dd className="mt-1 text-gray-100 tabular-nums">≤ {String(c.target_entry_price ?? '—')}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Max size</dt>
          <dd className="mt-1 text-gray-100 tabular-nums">{num(c.max_size_usd) !== null ? usd(num(c.max_size_usd) as number) : '—'}</dd>
        </div>
        <div>
          <dt className="text-gray-400">State</dt>
          <dd className="mt-1">
            <Badge tone={state === 'invalidated' || state === 'error' ? 'red' : state === 'bid' || state === 'kept' ? 'green' : 'gray'}>{state ?? 'no data yet'}</Badge>
          </dd>
        </div>
      </dl>
      {ev && str(ev.data.reason) && <p className="mt-3 text-sm text-gray-300 break-words">{str(ev.data.reason)}</p>}
      {ev && <p className="mt-1 text-xs text-gray-500">Updated {dateTime(ev.at)}</p>}
    </div>
  );
}
