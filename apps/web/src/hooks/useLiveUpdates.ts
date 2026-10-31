import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { onServerEvent } from '../lib/api';

/** Bot events that change what the bot list / detail / orders show (heartbeats, logs and ctx.emit do not) */
const BOT_STATE_EVENTS = new Set(['status_changed', 'trade_executed', 'trade_detected', 'position_redeemed', 'error']);
const THROTTLE_MS = 2_000;

/**
 * Invalidate a query at most once per `ms` (leading call runs at once, later ones collapse into one
 * trailing call), so a chatty bot cannot turn every SSE event into a refetch.
 */
function throttledInvalidator(qc: QueryClient, ms: number) {
  const last = new Map<string, number>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const invalidate = (queryKey: string[]) => {
    const k = queryKey.join('\u0000');
    if (pending.has(k)) return;
    const wait = Math.max(0, (last.get(k) ?? 0) + ms - Date.now());
    const run = () => {
      pending.delete(k);
      last.set(k, Date.now());
      void qc.invalidateQueries({ queryKey });
    };
    if (wait === 0) run();
    else pending.set(k, setTimeout(run, wait));
  };
  const dispose = () => {
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
  };
  return { invalidate, dispose };
}

/**
 * One SSE subscription for the whole app: halts, config changes, rules changes and bot events refresh
 * the queries that show them, so the Dashboard / Risk / Bots pages update without polling delays.
 * Bot events refresh only on state changes, throttled per query (R128).
 */
export function useLiveUpdates(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const throttle = throttledInvalidator(qc, THROTTLE_MS);
    const risk = () => {
      qc.invalidateQueries({ queryKey: ['overview'] });
      qc.invalidateQueries({ queryKey: ['riskState'] });
      qc.invalidateQueries({ queryKey: ['audit'] });
      qc.invalidateQueries({ queryKey: ['bots'] });
    };
    const unsubs = [
      onServerEvent('risk:halt', risk),
      onServerEvent('risk:halt-cleared', risk),
      onServerEvent('config:changed', () => {
        qc.invalidateQueries({ queryKey: ['config'] });
        qc.invalidateQueries({ queryKey: ['configHistory'] });
        qc.invalidateQueries({ queryKey: ['overview'] });
        qc.invalidateQueries({ queryKey: ['audit'] });
      }),
      onServerEvent('market:rulesChanged', () => qc.invalidateQueries({ queryKey: ['market'] })),
      onServerEvent('bot:event', (e: { type?: string; botId?: string }) => {
        if (!e?.type || !BOT_STATE_EVENTS.has(e.type)) return;
        throttle.invalidate(['bots']);
        if (e.botId) {
          throttle.invalidate(['bot', e.botId]);
          throttle.invalidate(['botOrders', e.botId]);
        } else {
          throttle.invalidate(['bot']);
          throttle.invalidate(['botOrders']);
        }
      }),
    ];
    return () => {
      unsubs.forEach((u) => u());
      throttle.dispose();
    };
  }, [qc]);
}
