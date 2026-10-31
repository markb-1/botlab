/**
 * Telegram transport (spec §11): Bot API over fetch, no SDK, no webhook, no inbound port.
 *
 * - Outgoing: `send()` only enqueues and never throws or waits for the network, so order, halt
 *   and kill-switch paths cannot be slowed or broken by Telegram. A single sender drains the queue
 *   at most once per `minIntervalMs` (Telegram allows ~1 message/s per chat); queued plain
 *   messages are coalesced into one. High-priority messages jump the queue. Failures are logged
 *   (token redacted) and dropped after a few attempts.
 * - Incoming: long-polling `getUpdates`. Only updates from the configured admin chat are passed on.
 * - Disabled / unconfigured ⇒ `send()` is a no-op and nothing is polled.
 */

import logger from '../../src/utils/logger';

export interface TelegramSettings {
  enabled: boolean;
  token: string;
  chatId: string;
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface OutgoingMessage {
  text: string;
  /** Rows of inline buttons */
  buttons?: InlineButton[][];
  /** Immediate, ahead of queued messages, retried */
  priority?: 'high' | 'normal';
  /** Never merged with other messages (replies, messages with buttons) */
  keepSeparate?: boolean;
  /** Send with these settings instead of the live ones (e.g. an alert about a change that turns Telegram off or moves the chat) */
  via?: TelegramSettings;
}

export interface IncomingMessage {
  kind: 'message';
  text: string;
  chatId: string;
  /** Unix seconds */
  date: number;
}

export interface IncomingCallback {
  kind: 'callback';
  data: string;
  chatId: string;
  callbackId: string;
}

export type IncomingUpdate = IncomingMessage | IncomingCallback;

export interface TelegramNotifierOptions {
  getSettings: () => TelegramSettings;
  /** Called for each update from the admin chat. Errors are caught here. */
  onUpdate?: (update: IncomingUpdate) => Promise<void> | void;
  fetchImpl?: typeof fetch;
  /** Minimum gap between outgoing messages (default 1100 ms) */
  minIntervalMs?: number;
  /** Updates older than this at startup are dropped (default 5 min) */
  maxUpdateAgeSec?: number;
  now?: () => number;
}

const API = 'https://api.telegram.org';
const MAX_TEXT = 3900; // Telegram limit is 4096
const MAX_QUEUE = 200;
const MAX_ATTEMPTS = 3;
const POLL_TIMEOUT_SEC = 25;

interface Queued extends OutgoingMessage {
  attempts: number;
}

export class TelegramNotifier {
  private queue: Queued[] = [];
  private sending = false;
  private lastSentAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private idleWaiters: Array<() => void> = [];
  private running = false;
  private pollAbort: AbortController | null = null;
  private offset: number | null = null;
  private offsetToken: string | null = null;
  private pollLoop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private nextAllowedAt = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly minInterval: number;
  private readonly now: () => number;

  constructor(private opts: TelegramNotifierOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.minInterval = opts.minIntervalMs ?? 1100;
    this.now = opts.now ?? Date.now;
  }

  /** True when Telegram is enabled and has a token and an admin chat id. */
  get active(): boolean {
    return this.settings() !== null;
  }

  private settings(): TelegramSettings | null {
    try {
      const s = this.opts.getSettings();
      return s.enabled && s.token && s.chatId ? s : null;
    } catch {
      return null;
    }
  }

  // ── Outgoing ──────────────────────────────────────────────────────

  /** Queue a message. Never throws, never waits for the network. */
  send(message: OutgoingMessage): void {
    try {
      const usable = message.via ?? this.settings();
      if (!usable || !usable.enabled || !usable.token || !usable.chatId) return;
      const q: Queued = { ...message, attempts: 0 };
      if (message.priority === 'high') {
        const firstNormal = this.queue.findIndex((m) => m.priority !== 'high');
        if (firstNormal === -1) this.queue.push(q);
        else this.queue.splice(firstNormal, 0, q);
      } else {
        this.queue.push(q);
        // Bound memory if Telegram is unreachable: drop the oldest normal messages
        while (this.queue.length > MAX_QUEUE) {
          const i = this.queue.findIndex((m) => m.priority !== 'high');
          this.queue.splice(i === -1 ? 0 : i, 1);
        }
      }
      this.schedule(0);
    } catch (err) {
      logger.error(`[Telegram] Could not queue message: ${this.redact(err)}`);
    }
  }

  /** Resolves when the queue is empty (tests, shutdown). */
  flush(timeoutMs = 10_000): Promise<void> {
    if (this.queue.length === 0 && !this.sending) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      t.unref?.();
      this.idleWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.sending) return;
    const wait = Math.max(delayMs, this.lastSentAt + this.minInterval - this.now(), this.nextAllowedAt - this.now(), 0);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, wait);
    this.timer.unref?.();
  }

  private notifyIdle(): void {
    if (this.queue.length > 0 || this.sending) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private takeNext(): Queued | null {
    const first = this.queue.shift();
    if (!first) return null;
    if (first.keepSeparate || first.buttons || first.via || first.priority === 'high') return first;
    // Coalesce following plain normal-priority messages into one
    let text = first.text;
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next.keepSeparate || next.buttons || next.via || next.priority === 'high' || text.length + next.text.length + 2 > MAX_TEXT) break;
      text += `\n\n${next.text}`;
      this.queue.shift();
    }
    return { ...first, text };
  }

  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      const item = this.takeNext();
      if (!item) return;
      const settings = item.via ?? this.settings();
      if (!settings) return; // disabled meanwhile: drop this item
      this.lastSentAt = this.now();
      try {
        await this.call(settings, 'sendMessage', {
          chat_id: settings.chatId,
          text: item.text.slice(0, 4096),
          disable_web_page_preview: true,
          ...(item.buttons
            ? { reply_markup: { inline_keyboard: item.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.callbackData }))) } }
            : {}),
        });
      } catch (err) {
        item.attempts++;
        logger.error(`[Telegram] sendMessage failed (attempt ${item.attempts}): ${this.redact(err, item.via?.token)}`);
        if (item.priority === 'high' && item.attempts < MAX_ATTEMPTS) this.queue.unshift(item);
      }
    } finally {
      this.sending = false;
      if (this.queue.length > 0) this.schedule(0);
      this.notifyIdle();
    }
  }

  /** Bot API call; throws on transport errors and on `ok: false`. Honors 429 retry_after. */
  private async call(settings: TelegramSettings, method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const res = await this.fetchImpl(`${API}/bot${settings.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    let json: { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } } = {};
    try {
      json = (await res.json()) as typeof json;
    } catch {
      /* non-JSON body */
    }
    if (res.status === 429) {
      this.nextAllowedAt = this.now() + (json.parameters?.retry_after ?? 5) * 1000;
    }
    if (!res.ok || json.ok === false) throw new Error(`${method}: HTTP ${res.status} ${json.description ?? ''}`.trim());
    return json.result;
  }

  private redact(err: unknown, extraToken?: string): string {
    let msg = err instanceof Error ? err.message : String(err);
    if (extraToken) msg = msg.split(extraToken).join('***');
    msg = msg.replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, '***');
    const token = (() => {
      try {
        return this.opts.getSettings().token;
      } catch {
        return '';
      }
    })();
    return token ? msg.split(token).join('***') : msg;
  }

  // ── Incoming ──────────────────────────────────────────────────────

  /** Start long-polling (idempotent). The loop idles while Telegram is disabled. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollLoop = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pollAbort?.abort();
    this.wake?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.pollLoop?.catch(() => undefined);
    this.pollLoop = null;
  }

  private async loop(): Promise<void> {
    let backoff = 1000;
    while (this.running) {
      if (!this.settings()) {
        await this.sleep(5000); // re-check: config may enable Telegram later
        continue;
      }
      try {
        await this.pollOnce();
        backoff = 1000;
      } catch (err) {
        if (!this.running) return;
        logger.error(`[Telegram] getUpdates failed: ${this.redact(err)}`);
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      t.unref?.();
      this.wake = done;
      function done() {
        clearTimeout(t);
        resolve();
      }
    });
  }

  /** One getUpdates request and dispatch of the admin chat's updates. Throws on transport errors. */
  async pollOnce(timeoutSec = POLL_TIMEOUT_SEC): Promise<void> {
    const settings = this.settings();
    if (!settings) return;
    this.pollAbort = new AbortController();
    const signal = AbortSignal.any([this.pollAbort.signal, AbortSignal.timeout((timeoutSec + 10) * 1000)]);
    if (this.offsetToken !== settings.token) {
      // A different bot has its own update numbering: an old offset would skip or repeat its updates
      this.offset = null;
      this.offsetToken = settings.token;
    }
    const first = this.offset === null;
    const result = (await this.call(
      settings,
      'getUpdates',
      { timeout: timeoutSec, allowed_updates: ['message', 'callback_query'], ...(this.offset !== null ? { offset: this.offset } : {}) },
      signal
    )) as TelegramUpdate[] | undefined;

    const maxAge = this.opts.maxUpdateAgeSec ?? 300;
    for (const u of result ?? []) {
      this.offset = Math.max(this.offset ?? 0, u.update_id + 1);
      const parsed = this.parse(u, settings.chatId);
      if (!parsed) continue;
      // Updates queued while the app was down are not acted on
      if (first && parsed.kind === 'message' && this.now() / 1000 - parsed.date > maxAge) continue;
      try {
        await this.opts.onUpdate?.(parsed);
      } catch (err) {
        logger.error(`[Telegram] Update handler failed: ${this.redact(err)}`);
      }
    }
    if (first && this.offset === null) this.offset = 0;
  }

  /**
   * Admin only. The sender (`from.id`) must equal the configured `chat_id` as well as the chat, which
   * holds only in a private chat with the owner (in a group other members would have other ids).
   * Forwarded messages are ignored.
   */
  private parse(u: TelegramUpdate, adminChatId: string): IncomingUpdate | null {
    const m = u.message;
    if (m?.text !== undefined) {
      if (m.forward_origin !== undefined || m.forward_from !== undefined || m.forward_from_chat !== undefined || m.forward_date !== undefined) {
        logger.warning('[Telegram] Ignored a forwarded message');
        return null;
      }
      if (String(m.chat?.id) !== adminChatId || String(m.from?.id) !== adminChatId) {
        logger.warning('[Telegram] Ignored a message from an unknown chat or sender');
        return null;
      }
      return { kind: 'message', text: m.text, chatId: String(m.chat.id), date: m.date ?? 0 };
    }
    const cb = u.callback_query;
    if (cb?.data !== undefined) {
      if (String(cb.message?.chat?.id) !== adminChatId || String(cb.from?.id) !== adminChatId) {
        logger.warning('[Telegram] Ignored a button press from an unknown chat or sender');
        return null;
      }
      return { kind: 'callback', data: cb.data, chatId: adminChatId, callbackId: cb.id };
    }
    return null;
  }

  /** Acknowledge a button press (stops the spinner). Best effort. */
  async answerCallback(callbackId: string, text?: string): Promise<void> {
    const settings = this.settings();
    if (!settings) return;
    try {
      await this.call(settings, 'answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text: text.slice(0, 200) } : {}) });
    } catch (err) {
      logger.error(`[Telegram] answerCallbackQuery failed: ${this.redact(err)}`);
    }
  }
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    date?: number;
    chat: { id: number | string };
    from?: { id: number | string };
    forward_origin?: unknown;
    forward_from?: unknown;
    forward_from_chat?: unknown;
    forward_date?: unknown;
  };
  callback_query?: { id: string; data?: string; from?: { id: number | string }; message?: { chat?: { id: number | string } } };
}

/** Settings from server.yaml with the TELEGRAM_BOT_TOKEN override. */
export function telegramSettingsFrom(
  server: { notify: { telegram: { enabled: boolean; bot_token: string; chat_id: string } } },
  env: NodeJS.ProcessEnv = process.env
): TelegramSettings {
  const t = server.notify.telegram;
  return { enabled: t.enabled, token: (env.TELEGRAM_BOT_TOKEN || t.bot_token || '').trim(), chatId: t.chat_id };
}
