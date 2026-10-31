/** Bot log / event history merged with live SSE lines (Bot detail → Logs, Events). Pure helpers. */

export interface LogLine {
  timestamp: string;
  level: string;
  message: string;
}

export interface CustomEvent {
  timestamp: string;
  type: string;
  data: unknown;
}

/** Event types the runtime emits itself; everything else is a script's ctx.emit (server: BotActivityLog) */
export const BUILTIN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'status_changed',
  'heartbeat',
  'trade_executed',
  'trade_detected',
  'position_redeemed',
  'error',
  'log',
]);

/**
 * History first, then the live items that arrived while it was loading and are not already in it
 * (same timestamp + content). Keeps the last `max`.
 */
export function mergeHistory<T extends { timestamp: string }>(history: T[], live: T[], max: number): T[] {
  const key = (x: T) => JSON.stringify(x);
  const seen = new Set(history.map(key));
  const merged = [...history, ...live.filter((x) => !seen.has(key(x)))];
  return merged.length > max ? merged.slice(-max) : merged;
}
