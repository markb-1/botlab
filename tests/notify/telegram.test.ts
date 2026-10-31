import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { TelegramNotifier, telegramSettingsFrom, type IncomingUpdate } from '../../electron/notify/TelegramNotifier';
import { NotificationService, REJECTION_STORM_THRESHOLD } from '../../electron/notify/NotificationService';
import { EventEmitter } from 'events';

const ADMIN = '4242';
const settings = { enabled: true, token: 'TOKEN123', chatId: ADMIN };

interface Sent {
  method: string;
  body: any;
}

/** Fake Telegram: records calls, serves queued getUpdates results. */
function fakeTelegram() {
  const sent: Sent[] = [];
  const updates: any[][] = [];
  let failWith: Error | null = null;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (failWith) throw failWith;
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push({ method, body });
    const result = method === 'getUpdates' ? (updates.shift() ?? []) : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    sent,
    messages: () => sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.text as string),
    pushUpdates: (u: any[]) => updates.push(u),
    failWith: (e: Error | null) => (failWith = e),
  };
}

const msg = (text: string, chat: number | string = ADMIN, id = 1) => ({
  update_id: id,
  message: { text, date: Math.floor(Date.now() / 1000), chat: { id: chat }, from: { id: chat } },
});

function setup(overrides: Partial<ConstructorParameters<typeof NotificationService>[0]> = {}, s = settings) {
  const tg = fakeTelegram();
  const holder: { service?: NotificationService } = {};
  const updates: IncomingUpdate[] = [];
  const notifier = new TelegramNotifier({
    getSettings: () => s,
    fetchImpl: tg.fetchImpl,
    minIntervalMs: 0,
    onUpdate: (u) => {
      updates.push(u);
      return holder.service!.handleUpdate(u);
    },
  });
  const killSwitch = { activate: vi.fn(async () => ({ stopped: ['b1'], cancels: [], cancelled: 3, failed: 0, unknownOutcome: 0, errors: [] })) };
  const bots = [
    { id: 'b1', name: 'Weather Bot', stage: 'full', mode: 'live' },
    { id: 'b2', name: 'Econ Bot', stage: 'paper', mode: 'paper' },
  ];
  const stopBot = vi.fn(async () => undefined);
  const halts = new EventEmitter();
  const service = new NotificationService({
    notifier,
    halts: halts as never,
    killSwitch: killSwitch as never,
    botRepo: { findAll: () => bots, findById: (id: string) => bots.find((b) => b.id === id) } as never,
    riskStateRepo: { all: () => [], get: () => undefined } as never,
    getLimits: () => null,
    getServer: () => ({ timezone: 'Europe/Dublin', digest_time: '08:00' }),
    getExposureUsd: () => 0,
    stopBot,
    isRunning: (id) => id === 'b1',
    fillBatchMs: 10_000_000,
    ...overrides,
  });
  holder.service = service;
  return { tg, notifier, service, killSwitch, stopBot, halts, updates };
}

describe('Telegram commands', () => {
  it('ignores messages and button presses from any chat other than the admin chat', async () => {
    const { tg, notifier, killSwitch, stopBot, updates } = setup();
    tg.pushUpdates([
      msg('/halt now', '999', 1),
      msg('/pause Weather Bot', '999', 2),
      { update_id: 3, callback_query: { id: 'cb', data: 'pause:b1', from: { id: 999 }, message: { chat: { id: 999 } } } },
    ]);
    await notifier.pollOnce(0);
    await notifier.flush();
    expect(updates).toHaveLength(0);
    expect(killSwitch.activate).not.toHaveBeenCalled();
    expect(stopBot).not.toHaveBeenCalled();
    expect(tg.messages()).toEqual([]);
  });

  it('ignores another sender in the admin chat (group), forwarded messages, and button presses by other users', async () => {
    const { tg, notifier, killSwitch, stopBot, updates } = setup();
    const inGroup = { update_id: 1, message: { text: '/halt', date: Math.floor(Date.now() / 1000), chat: { id: Number(ADMIN) }, from: { id: 777 } } };
    const forwarded = { update_id: 2, message: { ...msg('/halt', ADMIN, 2).message, forward_origin: { type: 'user' } } };
    const oldForward = { update_id: 3, message: { ...msg('/halt', ADMIN, 3).message, forward_from: { id: 5 } } };
    const otherPress = { update_id: 4, callback_query: { id: 'c', data: 'pause:b1', from: { id: 777 }, message: { chat: { id: Number(ADMIN) } } } };
    tg.pushUpdates([inGroup, forwarded, oldForward, otherPress]);
    await notifier.pollOnce(0);
    await notifier.flush();
    expect(updates).toHaveLength(0);
    expect(killSwitch.activate).not.toHaveBeenCalled();
    expect(stopBot).not.toHaveBeenCalled();
  });

  it('/halt from the admin chat activates the kill switch as human and replies', async () => {
    const { tg, notifier, killSwitch } = setup();
    tg.pushUpdates([msg('/halt something looks wrong')]);
    await notifier.pollOnce(0);
    await notifier.flush();
    expect(killSwitch.activate).toHaveBeenCalledWith('Telegram: something looks wrong', 'human');
    expect(tg.messages()[0]).toMatch(/Kill switch activated.*cancelled: 3.*stopped: 1/s);
  });

  it('clearing a halt is refused and points to the UI', async () => {
    const { tg, notifier } = setup();
    for (const cmd of ['/clearhalt', '/unhalt global', '/resume']) {
      tg.pushUpdates([msg(cmd)]);
      await notifier.pollOnce(0);
    }
    await notifier.flush();
    const replies = tg.messages();
    expect(replies).toHaveLength(3);
    for (const r of replies) expect(r).toMatch(/only possible in the BotLab app/);
  });

  it('/pause stops a running bot by name or id; the inline button does the same', async () => {
    const { tg, notifier, stopBot } = setup();
    tg.pushUpdates([msg('/pause weather', ADMIN, 1), { update_id: 2, callback_query: { id: 'cb1', data: 'pause:b1', from: { id: Number(ADMIN) }, message: { chat: { id: Number(ADMIN) } } } }]);
    await notifier.pollOnce(0);
    await notifier.flush();
    expect(stopBot).toHaveBeenCalledTimes(2);
    expect(stopBot).toHaveBeenCalledWith('b1', 'human');
    expect(tg.sent.some((s) => s.method === 'answerCallbackQuery' && s.body.callback_query_id === 'cb1')).toBe(true);
  });

  it('/pause of a stopped or unknown bot does not stop anything', async () => {
    const { tg, notifier, stopBot } = setup();
    tg.pushUpdates([msg('/pause econ', ADMIN, 1), msg('/pause nonsense', ADMIN, 2)]);
    await notifier.pollOnce(0);
    await notifier.flush();
    expect(stopBot).not.toHaveBeenCalled();
    expect(tg.messages().join('\n')).toMatch(/not running/);
    expect(tg.messages().join('\n')).toMatch(/No bot matches/);
  });

  it('/pause with duplicate names asks for the id; retired bots are ignored by name', async () => {
    const bots = [
      { id: 'a1', name: 'Twin', stage: 'full', mode: 'live' },
      { id: 'a2', name: 'Twin', stage: 'paper', mode: 'paper' },
      { id: 'r1', name: 'Old Weather', stage: 'retired', mode: 'live' },
      { id: 'w1', name: 'Weather One', stage: 'full', mode: 'live' },
      { id: 'w2', name: 'Weather Two', stage: 'full', mode: 'live' },
    ];
    const { tg, notifier, stopBot } = setup({
      botRepo: { findAll: () => bots, findById: (id: string) => bots.find((b) => b.id === id) } as never,
      isRunning: (id) => id === 'a1' || id === 'r1' || id === 'w2',
    });
    tg.pushUpdates([msg('/pause twin', ADMIN, 1), msg('/pause old weather', ADMIN, 2), msg('/pause weather', ADMIN, 3), msg('/pause a1', ADMIN, 4)]);
    await notifier.pollOnce(0);
    await notifier.flush();
    const m = tg.messages();
    expect(m[0]).toMatch(/Several bots are named "twin"[\s\S]*id a1[\s\S]*id a2/);
    expect(m[1]).toMatch(/No bot matches/); // retired is not matched by name
    expect(stopBot.mock.calls).toEqual([['w2', 'human'], ['a1', 'human']]); // 'weather': the one running bot; then explicit id
  });

  it('/status, /bots and /help answer; /run and /code are unknown', async () => {
    const { tg, notifier } = setup();
    tg.pushUpdates([msg('/status', ADMIN, 1), msg('/bots', ADMIN, 2), msg('/help', ADMIN, 3), msg('/run', ADMIN, 4)]);
    await notifier.pollOnce(0);
    await notifier.flush();
    const all = tg.messages();
    expect(all).toHaveLength(4);
    expect(all[1]).toMatch(/Weather Bot \[full\/live\] running/);
    expect(all[3]).toMatch(/Unknown command/);
  });
});

describe('Telegram notifications', () => {
  beforeEach(() => vi.useRealTimers());

  it('batches live fills into one message with a Pause button per bot; paper fills are not sent', async () => {
    const { tg, notifier, service } = setup();
    const fill = (botId: string, botName: string, simulated = false) => ({
      botId,
      botName,
      exchange: 'polymarket',
      side: 'BUY' as const,
      symbol: 't1',
      market: 'Will CPI exceed 3%?',
      outcome: 'Yes',
      quantity: 10,
      price: 0.5,
      notionalUsd: 5,
      simulated,
    });
    service.orderFilled(fill('b1', 'Weather Bot'));
    service.orderFilled(fill('b1', 'Weather Bot'));
    service.orderFilled(fill('b2', 'Econ Bot'));
    service.orderFilled(fill('b2', 'Econ Bot', true));
    await notifier.flush();
    expect(tg.messages()).toEqual([]); // still buffered

    service.flushFills();
    await notifier.flush();
    expect(tg.messages()).toHaveLength(1);
    expect(tg.messages()[0]).toMatch(/Live fills: 3 \(\$15\.00\)/);
    const kb = tg.sent.find((s) => s.method === 'sendMessage')!.body.reply_markup.inline_keyboard;
    expect(kb.flat().map((b: any) => b.callback_data).sort()).toEqual(['pause:b1', 'pause:b2']);
  });

  it('flushes fills by itself after the batch interval', async () => {
    const { tg, notifier, service } = setup({ fillBatchMs: 20 });
    service.orderFilled({ botId: 'b1', botName: 'Weather Bot', exchange: 'polymarket', side: 'SELL', symbol: 't', quantity: 1, price: 0.4, notionalUsd: 0.4, simulated: false });
    await new Promise((r) => setTimeout(r, 80));
    await notifier.flush();
    expect(tg.messages()).toHaveLength(1);
  });

  it('a rejection storm (more than 10 per hour per bot) alerts once', async () => {
    let now = 1_000_000;
    const { tg, notifier, service } = setup({ now: () => now });
    for (let i = 0; i < REJECTION_STORM_THRESHOLD + 5; i++) {
      now += 1000;
      service.orderRejected({ botId: 'b1', botName: 'Weather Bot', failedCheck: 'max_order', reason: 'too big', simulated: false });
    }
    await notifier.flush();
    const storms = tg.messages().filter((m) => m.includes('REJECTION STORM'));
    expect(storms).toHaveLength(1);
    expect(storms[0]).toMatch(/11 risk rejections/);
  });

  it('halt events are sent immediately; a global halt after a crash says so', async () => {
    const { tg, notifier, halts } = setup();
    halts.emit('risk:halt', { scope: 'b1', kind: 'bot', reason: 'daily loss', actor: 'system', at: '', cancels: [{ cancelled: 2, failed: 0 }] });
    halts.emit('risk:halt', { scope: 'global', kind: 'global', reason: 'unclean shutdown', actor: 'system', at: '', cancels: [] });
    halts.emit('risk:halt', { scope: 'global', kind: 'kill_switch', reason: 'manual', actor: 'human', at: '', cancels: [] });
    await notifier.flush();
    const m = tg.messages();
    expect(m).toHaveLength(3);
    expect(m.some((t) => /BOT HALT\] Weather Bot: daily loss.*cancelled: 2/s.test(t))).toBe(true);
    expect(m.some((t) => /STARTUP HALT/.test(t))).toBe(true);
    expect(m.some((t) => /KILL SWITCH.*human/.test(t))).toBe(true);
  });

  it('does nothing when disabled or unconfigured (no requests)', async () => {
    for (const s of [{ ...settings, enabled: false }, { ...settings, token: '' }, { ...settings, chatId: '' }]) {
      const { tg, notifier, service } = setup({}, s);
      service.reconciliationMismatch('x');
      await notifier.flush();
      expect(notifier.active).toBe(false);
      expect(tg.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('a throwing Telegram API never throws into the caller and the token is not logged', async () => {
    const { tg, notifier, service, halts } = setup();
    tg.failWith(new Error('network down for https://api.telegram.org/botTOKEN123/sendMessage'));
    expect(() => service.reconciliationMismatch('x')).not.toThrow();
    expect(() => halts.emit('risk:halt', { scope: 'global', kind: 'kill_switch', reason: 'r', actor: 'human', at: '', cancels: [] })).not.toThrow();
    expect(() => notifier.send({ text: 'hello' })).not.toThrow();
    await notifier.flush();

    // Polling errors surface from pollOnce (the loop catches and backs off), never from send paths
    await expect(notifier.pollOnce(0)).rejects.toThrow();
    const { default: logger } = await import('../../src/utils/logger');
    const logged = JSON.stringify((logger.error as any).mock.calls);
    expect(logged).not.toContain('TOKEN123');
  });

  it('coalesces plain queued messages into one request but keeps replies separate', async () => {
    const { tg, notifier } = setup();
    notifier.send({ text: 'a' });
    notifier.send({ text: 'b' });
    notifier.send({ text: 'c', keepSeparate: true });
    await notifier.flush();
    expect(tg.messages()).toEqual(['a\n\nb', 'c']);
  });

  it('TELEGRAM_BOT_TOKEN overrides the configured token', () => {
    const server = { notify: { telegram: { enabled: true, bot_token: 'file', chat_id: '1' } } };
    expect(telegramSettingsFrom(server, { TELEGRAM_BOT_TOKEN: 'env' } as never).token).toBe('env');
    expect(telegramSettingsFrom(server, {} as never).token).toBe('file');
  });
});

describe('config alerts and transport details', () => {
  it('a risk-raising edit that also disables Telegram still alerts the old chat', async () => {
    const { classifyChange } = await import('../../electron/config');
    const { LimitsSchema, MandateSchema, ServerSchema } = await import('../../electron/config');
    const { FeesSchema } = await import('../../electron/orders/FeeService');
    const base = () => ({ limits: LimitsSchema.parse({}), mandate: MandateSchema.parse({}), fees: FeesSchema.parse({}), server: ServerSchema.parse({}) });
    const before = base();
    before.server.notify.telegram = { enabled: true, bot_token: 'OLDTOKEN-1234', chat_id: '111' };
    const after = structuredClone(before);
    after.server.notify.telegram = { enabled: false, bot_token: 'OLDTOKEN-1234', chat_id: '111' };
    after.limits.per_bot_defaults.max_order_usd = 30;

    // The notifier's live settings are already the NEW ones (disabled)
    const { tg, notifier, service } = setup({}, { enabled: false, token: 'OLDTOKEN-1234', chatId: '111' });
    let listener: ((e: any) => void) | undefined;
    service.attachConfig({ onChange: (l: any) => ((listener = l), () => undefined), onInvalid: () => () => undefined });
    const changes = classifyChange(before, after);
    listener!({ before, after, changes, raises: changes.filter((c) => c.effect === 'raises'), actor: 'human', source: 'write' });
    await notifier.flush();

    const sent = tg.sent.filter((s) => s.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0].body.chat_id).toBe('111');
    expect(sent[0].body.text).toMatch(/Risk limits raised[\s\S]*max_order_usd: 25 → 30/);
    expect(sent[0].body.text).toMatch(/notify\.telegram\.enabled: true → false/);
  });

  it('announces the first valid config after an invalid start', async () => {
    const { tg, notifier, service } = setup();
    let listener: ((e: any) => void) | undefined;
    service.attachConfig({ onChange: (l: any) => ((listener = l), () => undefined), onInvalid: () => () => undefined });
    listener!({ before: {}, after: {}, changes: [{ file: 'limits', path: 'global.max_open_orders', old: 50, new: 7, effect: 'lowers' }], raises: [], actor: 'system', source: 'file', firstValid: true });
    await notifier.flush();
    expect(tg.messages()[0]).toMatch(/now valid and loaded[\s\S]*max_open_orders: 50 → 7/);
  });

  it('resets the update offset when the token changes', async () => {
    let s = settings;
    const tg = fakeTelegram();
    const notifier = new TelegramNotifier({ getSettings: () => s, fetchImpl: tg.fetchImpl, minIntervalMs: 0 });
    tg.pushUpdates([msg('/help', ADMIN, 50)]);
    await notifier.pollOnce(0);
    await notifier.pollOnce(0);
    s = { ...settings, token: 'OTHERTOKEN' };
    await notifier.pollOnce(0);
    const polls = tg.sent.filter((x) => x.method === 'getUpdates');
    expect(polls[1].body.offset).toBe(51);
    expect(polls[2].body.offset).toBeUndefined();
  });
});

describe('daily digest', () => {
  it('is sent once per local day inside the window, in the configured time zone', async () => {
    // 2026-07-01 07:30 UTC = 08:30 in Dublin (IST, UTC+1)
    let now = Date.parse('2026-07-01T07:30:00Z');
    const { tg, notifier, service } = setup({ now: () => now });
    expect(service.checkDigest()).toBe(true);
    expect(service.checkDigest()).toBe(false);
    await notifier.flush();
    expect(tg.messages()[0]).toMatch(/Daily digest 2026-07-01/);

    now = Date.parse('2026-07-01T06:30:00Z'); // 07:30 local on the same day: before 08:00 anyway
    expect(service.checkDigest()).toBe(false);
    now = Date.parse('2026-07-02T06:30:00Z'); // 07:30 local next day: too early
    expect(service.checkDigest()).toBe(false);
    now = Date.parse('2026-07-02T07:05:00Z'); // 08:05 local
    expect(service.checkDigest()).toBe(true);
    now = Date.parse('2026-07-03T19:00:00Z'); // app started late in the evening: skipped
    expect(service.checkDigest()).toBe(false);
  });
});
