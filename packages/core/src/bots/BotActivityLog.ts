/**
 * Recent bot output kept in memory for the UI (Bot detail → Logs / Events tabs): per bot, the last
 * `maxLogs` log lines and the last `maxEvents` custom `ctx.emit` events. Filled from the BotManager's
 * `bot:event` stream in core.ts, so history matches what SSE delivers live. Not persisted: a server
 * restart starts empty (the full text log stays in the server log files).
 */

import type { BotEvent } from './types';

export interface BotLogLine {
  botId: string;
  timestamp: string;
  level: string;
  message: string;
}

export interface BotCustomEvent {
  botId: string;
  timestamp: string;
  type: string;
  data: unknown;
}

/** Event types the runtime itself emits; anything else came from a script's ctx.emit */
export const BUILTIN_BOT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'status_changed',
  'heartbeat',
  'trade_executed',
  'trade_detected',
  'position_redeemed',
  'error',
  'log',
]);

export const DEFAULT_MAX_LOG_LINES = 500;
export const DEFAULT_MAX_EVENTS = 100;
/** Cap on a stored log message / serialized event payload (a script could log megabytes) */
const MAX_TEXT = 4_000;

class Ring<T> {
  private items: T[] = [];
  constructor(private max: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }
  list(limit?: number): T[] {
    return limit !== undefined && limit < this.items.length ? this.items.slice(-limit) : [...this.items];
  }
}

function toIso(ts: unknown): string {
  const d = ts instanceof Date ? ts : new Date(typeof ts === 'string' || typeof ts === 'number' ? ts : Date.now());
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function capData(data: unknown): unknown {
  try {
    const text = JSON.stringify(data);
    if (text === undefined) return null;
    return text.length > MAX_TEXT ? { truncated: true, preview: text.slice(0, MAX_TEXT) } : JSON.parse(text);
  } catch {
    return { unserializable: true };
  }
}

export class BotActivityLog {
  private logs = new Map<string, Ring<BotLogLine>>();
  private events = new Map<string, Ring<BotCustomEvent>>();

  constructor(private opts: { maxLogs?: number; maxEvents?: number } = {}) {}

  /** Record a BotManager event; returns what was stored (for callers that re-emit it) */
  record(event: BotEvent): { log?: BotLogLine; custom?: BotCustomEvent } {
    if (!event || typeof event.botId !== 'string') return {};
    const timestamp = toIso(event.timestamp);
    if (event.type === 'log') {
      const d = (event.data ?? {}) as { level?: unknown; message?: unknown };
      const message = typeof d.message === 'string' ? d.message : String(d.message ?? '');
      const line: BotLogLine = {
        botId: event.botId,
        timestamp,
        level: typeof d.level === 'string' ? d.level : 'info',
        message: message.length > MAX_TEXT ? `${message.slice(0, MAX_TEXT)}…` : message,
      };
      this.ring(this.logs, event.botId, this.opts.maxLogs ?? DEFAULT_MAX_LOG_LINES).push(line);
      return { log: line };
    }
    if (!BUILTIN_BOT_EVENT_TYPES.has(event.type)) {
      const custom: BotCustomEvent = { botId: event.botId, timestamp, type: String(event.type), data: capData(event.data ?? null) };
      this.ring(this.events, event.botId, this.opts.maxEvents ?? DEFAULT_MAX_EVENTS).push(custom);
      return { custom };
    }
    return {};
  }

  /** Oldest first */
  getLogs(botId: string, limit?: number): BotLogLine[] {
    return this.logs.get(botId)?.list(limit) ?? [];
  }

  /** Oldest first */
  getEvents(botId: string, limit?: number): BotCustomEvent[] {
    return this.events.get(botId)?.list(limit) ?? [];
  }

  /** Bot deleted */
  forget(botId: string): void {
    this.logs.delete(botId);
    this.events.delete(botId);
  }

  private ring<T>(map: Map<string, Ring<T>>, botId: string, max: number): Ring<T> {
    let r = map.get(botId);
    if (!r) {
      r = new Ring<T>(max);
      map.set(botId, r);
    }
    return r;
  }
}
