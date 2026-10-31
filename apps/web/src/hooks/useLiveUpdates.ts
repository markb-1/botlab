import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { onServerEvent } from '../lib/api';

/**
 * One SSE subscription for the whole app: halts, config changes, rules changes and bot events refresh
 * the queries that show them, so the Dashboard / Risk / Bots pages update without polling delays.
 */
export function useLiveUpdates(): void {
  const qc = useQueryClient();
  useEffect(() => {
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
      onServerEvent('bot:event', () => {
        qc.invalidateQueries({ queryKey: ['bots'] });
        qc.invalidateQueries({ queryKey: ['bot'] });
        qc.invalidateQueries({ queryKey: ['botOrders'] });
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [qc]);
}
