import { useEffect, useState } from 'react';
import { botApi, events } from '../lib/api';
import { BUILTIN_EVENT_TYPES, mergeHistory, type CustomEvent, type LogLine } from '../lib/botActivity';

const MAX_LOGS = 500;
const MAX_EVENTS = 100;

/**
 * A bot's recent log lines and custom events: the server's history (GET /api/bots/:id/logs, /events),
 * then live lines from SSE. Subscribes before loading so nothing that arrives meanwhile is lost.
 */
export function useBotActivity(botId: string | undefined) {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [customEvents, setCustomEvents] = useState<CustomEvent[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    setLogs([]);
    setCustomEvents([]);
    setHistoryError(null);

    const offLog = events.onBotLog((log: { botId?: string; timestamp?: string; level?: string; message?: string }) => {
      if (log?.botId !== botId) return;
      const line: LogLine = { timestamp: log.timestamp || new Date().toISOString(), level: log.level || 'info', message: log.message ?? '' };
      setLogs((prev) => [...prev.slice(-(MAX_LOGS - 1)), line]);
    });
    const offEvent = events.onBotEvent((e: { botId?: string; type?: string; timestamp?: string; data?: unknown }) => {
      if (e?.botId !== botId || !e.type || BUILTIN_EVENT_TYPES.has(e.type)) return;
      const ev: CustomEvent = { timestamp: e.timestamp || new Date().toISOString(), type: e.type, data: e.data ?? null };
      setCustomEvents((prev) => [...prev.slice(-(MAX_EVENTS - 1)), ev]);
    });

    const strip = <T extends { botId?: string }>(x: T) => {
      const { botId: _b, ...rest } = x;
      return rest;
    };
    Promise.all([
      botApi.getLogs(botId) as Promise<Array<LogLine & { botId?: string }>>,
      botApi.getEvents(botId) as Promise<Array<CustomEvent & { botId?: string }>>,
    ])
      .then(([histLogs, histEvents]) => {
        if (cancelled) return;
        setLogs((live) => mergeHistory(histLogs.map(strip) as LogLine[], live, MAX_LOGS));
        setCustomEvents((live) => mergeHistory(histEvents.map(strip) as CustomEvent[], live, MAX_EVENTS));
      })
      .catch((err: unknown) => {
        if (!cancelled) setHistoryError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      offLog();
      offEvent();
    };
  }, [botId]);

  return { logs, customEvents, historyError, clearLogs: () => setLogs([]), clearEvents: () => setCustomEvents([]) };
}
