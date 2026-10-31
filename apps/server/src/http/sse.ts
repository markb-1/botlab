/**
 * Server-sent events at `/api/events` (spec §8.1): every `core.events` event (`CORE_EVENTS`: bot:event,
 * bot:log, risk:halt, risk:halt-cleared, config:changed, market:rulesChanged) is forwarded as an SSE
 * event of the same name with a JSON payload. A comment line every 25 s keeps proxies from closing
 * the stream; the principal is re-checked at the same time, so a logged-out or revoked session stops
 * receiving events. `closeAll()` ends every stream (shutdown).
 */

import type { EventEmitter } from 'events';
import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';

const KEEPALIVE_MS = 25_000;

interface Client {
  stream: SSEStreamingApi;
  close: () => void;
}

export class SseHub {
  private clients = new Set<Client>();
  private unsubs: Array<() => void> = [];
  private closed = false;

  constructor(events: EventEmitter, names: readonly string[]) {
    for (const name of names) {
      const fn = (payload: unknown) => this.broadcast(name, payload);
      events.on(name, fn);
      this.unsubs.push(() => events.off(name, fn));
    }
  }

  get size(): number {
    return this.clients.size;
  }

  private broadcast(event: string, payload: unknown): void {
    let data: string;
    try {
      data = JSON.stringify(payload ?? null);
    } catch {
      return;
    }
    for (const client of this.clients) {
      client.stream.writeSSE({ event, data }).catch(() => client.close());
    }
  }

  /** The SSE response for one client; `stillAuthorized` is re-checked on every keepalive */
  handle(c: Context, stillAuthorized: () => boolean): Response {
    return streamSSE(c, async (stream) => {
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | null = null;
        const client: Client = {
          stream,
          close: () => {
            if (timer) clearInterval(timer);
            timer = null;
            if (this.clients.delete(client)) resolve();
          },
        };
        this.clients.add(client);
        stream.onAbort(() => client.close());
        timer = setInterval(() => {
          if (!stillAuthorized()) return client.close();
          stream.write(': keepalive\n\n').catch(() => client.close());
        }, KEEPALIVE_MS);
        timer.unref?.();
        stream.writeSSE({ event: 'ready', data: JSON.stringify({ at: new Date().toISOString() }) }).catch(() => client.close());
      });
    });
  }

  /** Ends every stream and stops forwarding (shutdown) */
  closeAll(): void {
    this.closed = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const client of [...this.clients]) {
      client.close();
      void client.stream.close().catch(() => undefined);
    }
  }
}
