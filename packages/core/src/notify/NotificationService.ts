/**
 * NotificationService — turns app events into Telegram messages and answers admin commands
 * (spec §11). Pure glue over narrow dependencies so it can be tested with fakes.
 *
 * Event sources:
 * - HaltService events (bot halt, global halt, kill switch, halt cleared)
 * - AuditService records (bot created / deleted / stage changes, new script versions, worker fatal)
 * - OrderService via `OrderEventSink` (live fills batched per 5 min, rejection storms)
 * - ConfigService (risk-raising edits, rejected edits)
 * - Ledger / market cache audit records (category-rights changes, rules changed or UMA dispute on a held market)
 * - Reconciler (chunk 2b): `reconciliationMismatch()` and `reconcilerAlert()` (clock skew, outage)
 * - a daily digest at `digest_time` in `timezone` (server.yaml)
 *
 * Nothing here throws into callers: every entry point catches and logs.
 */

import fs from 'fs';
import path from 'path';
import writeFileAtomic from 'write-file-atomic';
import type { AuditService } from '../audit/AuditService';
import type { AuditEntry } from '../db/repositories/AuditRepository';
import type { HaltService, RiskHaltEvent } from '../risk/HaltService';
import { RISK_HALT_CLEARED_EVENT, RISK_HALT_EVENT } from '../risk/HaltService';
import type { KillSwitch } from '../risk/KillSwitch';
import { UNCLEAN_SHUTDOWN_REASON } from '../risk/StartupRecovery';
import type { BotRepository } from '../db/repositories/BotRepository';
import { GLOBAL_SCOPE, type RiskStateRepository } from '../db/repositories/RiskStateRepository';
import type { ConfigChangedEvent, ConfigInvalidEvent, ConfigService } from '../config/ConfigService';
import { describeChange } from '../config/changes';
import type { LimitsConfig } from '../config/schema';
import type { ServerConfig } from '../config/serverSchema';
import type { OrderEventSink, OrderFillEvent, OrderRejectedEvent } from './events';
import { telegramSettingsFrom, type IncomingUpdate, type TelegramNotifier, type TelegramSettings } from './TelegramNotifier';
import logger from '../utils/logger';

export const FILL_BATCH_MS = 5 * 60_000;
export const REJECTION_STORM_THRESHOLD = 10; // more than this many in the window
export const REJECTION_WINDOW_MS = 3_600_000;
const MAX_LINES = 12;

export interface NotificationDeps {
  notifier: Pick<TelegramNotifier, 'send' | 'flush' | 'answerCallback'>;
  audit?: Pick<AuditService, 'onRecord'>;
  halts?: Pick<HaltService, 'on' | 'off'>;
  killSwitch: Pick<KillSwitch, 'activate'>;
  botRepo: Pick<BotRepository, 'findAll' | 'findById'>;
  riskStateRepo: Pick<RiskStateRepository, 'all' | 'get'>;
  getLimits: () => LimitsConfig | null;
  getServer: () => Pick<ServerConfig, 'timezone' | 'digest_time'> | null;
  /** Live total exposure in USD (open positions at cost + unfilled buy orders) */
  getExposureUsd: () => number;
  stopBot: (botId: string, actor: 'human') => Promise<void>;
  isRunning: (botId: string) => boolean;
  /** Where the last digest date is kept so a restart does not repeat it */
  stateFile?: string;
  now?: () => number;
  fillBatchMs?: number;
}

const usd = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
const signed = (n: number): string => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
const short = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const HELP_TEXT = [
  'BotLab commands',
  '/status - halts, exposure, P&L',
  '/pnl - today\'s P&L',
  '/bots - bots by stage',
  '/halt [reason] - kill switch: global halt, cancel all orders, stop all bots',
  '/pause <bot name or id> - stop a bot',
  '/help',
  '',
  'Clearing a halt is only possible in the BotLab app.',
].join('\n');

export class NotificationService implements OrderEventSink {
  private fills: OrderFillEvent[] = [];
  private fillTimer: NodeJS.Timeout | null = null;
  private rejections = new Map<string, number[]>();
  private stormAlertedAt = new Map<string, number>();
  private unsubs: Array<() => void> = [];
  private digestTimer: NodeJS.Timeout | null = null;
  private lastDigestDate: string | null = null;
  private readonly now: () => number;

  constructor(private deps: NotificationDeps) {
    this.now = deps.now ?? Date.now;
    this.lastDigestDate = this.readDigestState();
    if (deps.halts) this.attachHalts(deps.halts);
    if (deps.audit) this.unsubs.push(deps.audit.onRecord((e) => this.onAudit(e)));
  }

  // ── Wiring ────────────────────────────────────────────────────────

  private attachHalts(halts: Pick<HaltService, 'on' | 'off'>): void {
    const onHalt = (e: RiskHaltEvent) => this.guard(() => this.onHalt(e));
    const onCleared = (e: { scope: string; reason: string; actor: string }) =>
      this.guard(() =>
        this.send(`Halt cleared (${e.scope === GLOBAL_SCOPE ? 'global' : this.botName(e.scope)}) by ${e.actor}: ${short(e.reason)}`, { priority: 'normal' })
      );
    halts.on(RISK_HALT_EVENT, onHalt);
    halts.on(RISK_HALT_CLEARED_EVENT, onCleared);
    this.unsubs.push(() => {
      halts.off(RISK_HALT_EVENT, onHalt);
      halts.off(RISK_HALT_CLEARED_EVENT, onCleared);
    });
  }

  /** Subscribe to config changes (risk-raising edits, rejected edits). */
  attachConfig(config: Pick<ConfigService, 'onChange' | 'onInvalid'>): void {
    this.unsubs.push(config.onChange((e) => this.guard(() => this.onConfigChanged(e))));
    this.unsubs.push(config.onInvalid((e) => this.guard(() => this.onConfigInvalid(e))));
  }

  /** Start the digest scheduler. */
  start(): void {
    if (this.digestTimer) return;
    this.digestTimer = setInterval(() => this.guard(() => this.checkDigest()), 30_000);
    this.digestTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.digestTimer = null;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.flushFills();
    await this.deps.notifier.flush(3000).catch(() => undefined);
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      logger.error(`[Notify] ${err instanceof Error ? err.message : err}`);
    }
  }

  private send(text: string, opts: { priority?: 'high' | 'normal'; keepSeparate?: boolean; via?: TelegramSettings; buttons?: Array<Array<{ text: string; callbackData: string }>> } = {}): void {
    this.deps.notifier.send({ text, ...opts });
  }

  private botName(botId: string): string {
    try {
      return this.deps.botRepo.findById(botId)?.name ?? botId;
    } catch {
      return botId;
    }
  }

  // ── Immediate events ──────────────────────────────────────────────

  private onHalt(e: RiskHaltEvent): void {
    const cancelled = e.cancels.reduce((n, c) => n + c.cancelled, 0);
    const failed = e.cancels.reduce((n, c) => n + c.failed, 0);
    const orders = e.cancels.length > 0 ? ` Orders cancelled: ${cancelled}${failed > 0 ? `, failed: ${failed}` : ''}.` : '';
    if (e.kind === 'kill_switch') {
      this.send(`[KILL SWITCH] Activated by ${e.actor}: ${short(e.reason)}.${orders} All bots stopped. Clear the halt in the app.`, { priority: 'high' });
    } else if (e.kind === 'global') {
      if (e.reason === UNCLEAN_SHUTDOWN_REASON) {
        this.send('[STARTUP HALT] BotLab started after an unclean shutdown and is globally halted. Check positions and orders, then clear the halt in the app.', { priority: 'high' });
      } else {
        this.send(`[GLOBAL HALT] ${short(e.reason)} (by ${e.actor}). Clear it in the app.`, { priority: 'high' });
      }
    } else {
      this.send(`[BOT HALT] ${this.botName(e.scope)}: ${short(e.reason)} (by ${e.actor}).${orders}`, {
        priority: 'high',
        keepSeparate: true,
      });
    }
  }

  /** Reconciler hook (chunk 2b): a mismatch between our records and the exchange. */
  reconciliationMismatch(summary: string): void {
    this.guard(() => this.send(`[RECONCILIATION] Mismatch: ${short(summary, 1500)}`, { priority: 'high' }));
  }

  /** Reconciler state changes: clock skew (blocks live orders), outage after 5 failed runs, recovery. */
  reconcilerAlert(text: string): void {
    this.guard(() => this.send(`[RECONCILER] ${short(text, 800)}`, { priority: 'high' }));
  }

  private onConfigChanged(e: ConfigChangedEvent): void {
    if (e.firstValid) {
      const lines = e.changes.slice(0, MAX_LINES).map(describeChange);
      if (e.changes.length > MAX_LINES) lines.push(`…and ${e.changes.length - MAX_LINES} more`);
      this.send(
        `Config is now valid and loaded (after an invalid start). ${e.changes.length === 0 ? 'It equals the defaults.' : `Differences from the defaults:\n${lines.join('\n')}`}`,
        { priority: 'high' }
      );
      return;
    }
    if (e.raises.length === 0) return; // lowering / neutral changes are silent (spec §3)
    const lines = e.raises.slice(0, MAX_LINES).map(describeChange);
    if (e.raises.length > MAX_LINES) lines.push(`…and ${e.raises.length - MAX_LINES} more`);
    // Use the Telegram settings from before the edit: the same edit may disable Telegram or move the chat,
    // and the old chat must still hear about it
    this.send(`Risk limits raised (in effect now, by ${e.actor}, via ${e.source}):\n${lines.join('\n')}`, {
      priority: 'high',
      via: telegramSettingsFrom(e.before.server),
    });
  }

  private onConfigInvalid(e: ConfigInvalidEvent): void {
    const issues = (e.issues.length > 0 ? e.issues : [e.error]).slice(0, 5).map((i) => `- ${short(i, 300)}`);
    this.send(`Config edit rejected; the previous config stays active:\n${issues.join('\n')}`, { priority: 'high' });
  }

  // ── Audit-driven events ───────────────────────────────────────────

  private onAudit(entry: AuditEntry): void {
    const p = (entry.payload ?? {}) as Record<string, unknown>;
    const target = entry.target ?? '';
    switch (entry.action) {
      case 'bot.create':
        this.send(`Bot created: ${String(p.name ?? target)} (${String(p.stage ?? '?')}, ${String(p.mode ?? '?')}) by ${entry.actor}`);
        break;
      case 'bot.delete':
        this.send(`Bot deleted: ${String(p.name ?? target)} by ${entry.actor}`);
        break;
      case 'bot.stage': {
        const name = this.botName(target);
        if (p.to === 'retired') this.send(`Bot retired: ${name}${p.reason ? ` (${short(String(p.reason))})` : ''}`);
        else this.send(`Bot ${name}: stage ${String(p.from)} -> ${String(p.to)}${p.reason ? ` (${short(String(p.reason))})` : ''}`);
        break;
      }
      case 'script.create':
        this.send(`New template written: ${String(p.name ?? target)} r${String(p.revision ?? 1)} by ${entry.actor}`);
        break;
      case 'script.update':
        if (p.sourceChanged === true) this.send(`New template version: ${String(p.name ?? target)} r${String(p.revision)} (bots on it are back in paper)`);
        break;
      case 'category_rights.change':
        this.send(
          `Category rights ${String(p.category ?? target)}/${String(p.bucket ?? '?')}: ${String(p.from)} -> ${String(p.to)}` +
            `${p.to === 'trading' ? ` (max allocation $${Number(p.maxAllocationUsd ?? 0).toFixed(0)})` : ''}` +
            `${p.forced ? ` forced by ${entry.actor}` : ''}: ${short(String(p.reason ?? ''))}`,
          { priority: p.to === 'suspended' ? 'high' : 'normal' }
        );
        break;
      case 'market.rules_changed':
      case 'market.disputed': {
        // Spec §11: immediate for markets a bot holds; unheld markets are only audited
        const heldBy = Array.isArray(p.heldBy) ? p.heldBy.map(String) : [];
        if (heldBy.length === 0) break;
        const what = entry.action === 'market.rules_changed' ? 'RULES CHANGED' : 'UMA DISPUTE';
        this.send(
          `[${what}] ${short(String(p.question ?? target), 150)} (${target}). Held by: ${heldBy.map((id) => this.botName(id)).join(', ')}. ` +
            'Buys are blocked; review the position.',
          { priority: 'high' }
        );
        break;
      }
      case 'bot.error':
        this.send(`[BOT ERROR] ${this.botName(target)} stopped: ${short(String(p.message ?? p.reason ?? 'worker error'))}`, { priority: 'high' });
        break;
      default:
        break;
    }
  }

  // ── Orders: fills and rejection storms ────────────────────────────

  orderFilled(e: OrderFillEvent): void {
    this.guard(() => {
      if (e.simulated) return;
      this.fills.push(e);
      if (!this.fillTimer) {
        this.fillTimer = setTimeout(() => this.guard(() => this.flushFills()), this.deps.fillBatchMs ?? FILL_BATCH_MS);
        this.fillTimer.unref?.();
      }
    });
  }

  /** Send the buffered fills as one message with a "Pause" button per bot. */
  flushFills(): void {
    if (this.fillTimer) clearTimeout(this.fillTimer);
    this.fillTimer = null;
    const fills = this.fills;
    this.fills = [];
    if (fills.length === 0) return;

    const lines = fills.slice(0, MAX_LINES).map((f) => {
      const what = f.market ? `${short(f.market, 60)}${f.outcome ? ` [${f.outcome}]` : ''}` : f.symbol;
      return `${f.botName}: ${f.side} ${+f.quantity.toFixed(4)} @ ${+f.price.toFixed(4)} (${usd(f.notionalUsd)}) ${what}`;
    });
    if (fills.length > MAX_LINES) lines.push(`…and ${fills.length - MAX_LINES} more`);
    const total = fills.reduce((n, f) => n + f.notionalUsd, 0);

    const bots = new Map<string, string>();
    for (const f of fills) bots.set(f.botId, f.botName);
    const buttons = [...bots].slice(0, 8).map(([id, name]) => [{ text: `Pause ${short(name, 30)}`, callbackData: `pause:${id}` }]);

    this.send(`Live fills: ${fills.length} (${usd(total)})\n${lines.join('\n')}`, { keepSeparate: true, buttons });
  }

  orderRejected(e: OrderRejectedEvent): void {
    this.guard(() => {
      const now = this.now();
      const list = (this.rejections.get(e.botId) ?? []).filter((t) => now - t < REJECTION_WINDOW_MS);
      list.push(now);
      this.rejections.set(e.botId, list);
      if (list.length <= REJECTION_STORM_THRESHOLD) return;
      const last = this.stormAlertedAt.get(e.botId);
      if (last !== undefined && now - last < REJECTION_WINDOW_MS) return;
      this.stormAlertedAt.set(e.botId, now);
      this.send(
        `[REJECTION STORM] ${e.botName}: ${list.length} risk rejections in the last hour. Latest: ${e.failedCheck} - ${short(e.reason)}`,
        { priority: 'high', keepSeparate: true, buttons: [[{ text: `Pause ${short(e.botName, 30)}`, callbackData: `pause:${e.botId}` }]] }
      );
    });
  }

  // ── Daily digest ──────────────────────────────────────────────────

  /** Local date (YYYY-MM-DD) and minutes since midnight in `timeZone`. */
  static localTime(ms: number, timeZone: string): { date: string; minutes: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
    return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
  }

  /** Send the digest once per local day, from `digest_time` until two hours later. */
  checkDigest(): boolean {
    const server = this.deps.getServer();
    if (!server) return false;
    const { date, minutes } = NotificationService.localTime(this.now(), server.timezone);
    const [h, m] = server.digest_time.split(':').map(Number);
    const at = h * 60 + m;
    if (this.lastDigestDate === date || minutes < at || minutes >= at + 120) return false;
    this.lastDigestDate = date;
    this.writeDigestState(date);
    this.send(this.buildDigest(date), { keepSeparate: true });
    return true;
  }

  buildDigest(date: string): string {
    return [`Daily digest ${date}`, '', this.pnlText(), '', this.exposureText(), '', this.haltsText(), '', this.botsByStageText()].join('\n');
  }

  private readDigestState(): string | null {
    if (!this.deps.stateFile) return null;
    try {
      return (JSON.parse(fs.readFileSync(this.deps.stateFile, 'utf8')) as { lastDigestDate?: string }).lastDigestDate ?? null;
    } catch {
      return null;
    }
  }

  private writeDigestState(date: string): void {
    if (!this.deps.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.deps.stateFile), { recursive: true });
      writeFileAtomic.sync(this.deps.stateFile, JSON.stringify({ lastDigestDate: date }));
    } catch (err) {
      logger.error(`[Notify] Could not save digest state: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Text blocks ───────────────────────────────────────────────────

  private pnlText(): string {
    const g = this.deps.riskStateRepo.get(GLOBAL_SCOPE);
    const live = g?.day_live_pnl ?? 0;
    const paper = this.deps.riskStateRepo.all().filter((r) => r.scope !== GLOBAL_SCOPE).reduce((n, r) => n + (r.day_paper_pnl ?? 0), 0);
    return `P&L today (UTC day): live ${signed(live)}, paper ${signed(paper)}`;
  }

  private exposureText(): string {
    const limits = this.deps.getLimits();
    const exposure = this.deps.getExposureUsd();
    if (!limits) return `Exposure: ${usd(exposure)} (limits unavailable: config invalid)`;
    const cap = limits.global.max_total_exposure_usd;
    return `Exposure: ${usd(exposure)} of ${usd(cap)} limit (${cap > 0 ? Math.round((exposure / cap) * 100) : 0}%); daily loss limit ${usd(limits.global.daily_loss_limit_usd)}`;
  }

  private haltsText(): string {
    const rows = this.deps.riskStateRepo.all().filter((r) => r.halted === 1);
    if (rows.length === 0) return 'Halts: none';
    return 'Halts:\n' + rows.map((r) => `- ${r.scope === GLOBAL_SCOPE ? 'GLOBAL' : this.botName(r.scope)}: ${short(r.halted_reason ?? 'no reason')}`).join('\n');
  }

  private botsByStageText(): string {
    const bots = this.deps.botRepo.findAll();
    const counts = new Map<string, number>();
    for (const b of bots) if (b.stage !== 'retired') counts.set(b.stage, (counts.get(b.stage) ?? 0) + 1);
    const running = bots.filter((b) => this.deps.isRunning(b.id)).length;
    const stages = [...counts].map(([s, n]) => `${s} ${n}`).join(', ') || 'none';
    return `Active bots by stage: ${stages} (${running} running)`;
  }

  // ── Commands (admin chat only; the notifier already filtered other chats) ──

  /** Entry point for TelegramNotifier updates. */
  async handleUpdate(update: IncomingUpdate): Promise<void> {
    try {
      if (update.kind === 'callback') {
        await this.handleCallback(update.callbackId, update.data);
      } else {
        await this.handleCommand(update.text);
      }
    } catch (err) {
      logger.error(`[Notify] Command failed: ${err instanceof Error ? err.message : err}`);
      this.reply(`Command failed: ${short(err instanceof Error ? err.message : String(err))}`);
    }
  }

  private reply(text: string): void {
    this.send(text, { keepSeparate: true });
  }

  async handleCommand(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return; // plain chatter is ignored
    const [head, ...rest] = trimmed.split(/\s+/);
    const cmd = head.slice(1).split('@')[0].toLowerCase();
    const args = rest.join(' ').trim();

    switch (cmd) {
      case 'start':
      case 'help':
        this.reply(HELP_TEXT);
        return;
      case 'status':
        this.reply([this.haltsText(), this.exposureText(), this.pnlText(), this.botsByStageText(), this.configText()].join('\n\n'));
        return;
      case 'pnl':
        this.reply(this.perBotPnlText());
        return;
      case 'bots':
        this.reply(this.botsText());
        return;
      case 'halt': {
        const reason = args || 'manual halt from Telegram';
        const result = await this.deps.killSwitch.activate(`Telegram: ${reason}`, 'human');
        this.reply(
          `Kill switch activated. Orders cancelled: ${result.cancelled}${result.failed ? `, failed: ${result.failed}` : ''}; bots stopped: ${result.stopped.length}. ` +
            'Clear the halt in the BotLab app (not possible from Telegram).'
        );
        return;
      }
      case 'pause':
        if (!args) {
          this.reply('Usage: /pause <bot name or id>');
          return;
        }
        await this.pause(args);
        return;
      case 'clear':
      case 'clearhalt':
      case 'clear_halt':
      case 'unhalt':
      case 'resume':
      case 'release':
        this.reply('Clearing a halt is only possible in the BotLab app, not from Telegram.');
        return;
      default:
        this.reply(`Unknown command /${cmd}.\n\n${HELP_TEXT}`);
    }
  }

  private async handleCallback(callbackId: string, data: string): Promise<void> {
    if (data.startsWith('pause:')) {
      const result = await this.pause(data.slice('pause:'.length), true);
      await this.deps.notifier.answerCallback(callbackId, result);
      return;
    }
    await this.deps.notifier.answerCallback(callbackId);
  }

  /**
   * Resolve a bot: exact id; else exact name (non-retired; several ⇒ ask for the id); else a unique
   * name fragment among non-retired bots (several ⇒ the single running one, else ask for the id).
   */
  private findBot(query: string): { bot?: { id: string; name: string }; error?: string } {
    const bots = this.deps.botRepo.findAll();
    const q = query.trim().toLowerCase();
    const byId = bots.find((b) => b.id === query.trim());
    if (byId) return { bot: byId };

    const live = bots.filter((b) => b.stage !== 'retired');
    const describe = (list: typeof bots) =>
      list.slice(0, 8).map((b) => `${b.name} [${b.stage}] ${this.deps.isRunning(b.id) ? 'running' : 'stopped'} id ${b.id}`).join('\n');

    const exact = live.filter((b) => b.name.toLowerCase() === q);
    if (exact.length === 1) return { bot: exact[0] };
    if (exact.length > 1) return { error: `Several bots are named "${query}". Use the id:\n${describe(exact)}` };

    const partial = live.filter((b) => b.name.toLowerCase().includes(q));
    if (partial.length === 1) return { bot: partial[0] };
    if (partial.length > 1) {
      const running = partial.filter((b) => this.deps.isRunning(b.id));
      if (running.length === 1) return { bot: running[0] };
      return { error: `Several bots match "${query}". Use the id:\n${describe(partial)}` };
    }
    return { error: `No bot matches "${query}".` };
  }

  private async pause(query: string, fromButton = false): Promise<string> {
    const { bot, error } = this.findBot(query);
    if (!bot) {
      if (!fromButton) this.reply(error ?? 'Bot not found');
      return error ?? 'Bot not found';
    }
    if (!this.deps.isRunning(bot.id)) {
      const msg = `${bot.name} is not running.`;
      this.reply(msg);
      return msg;
    }
    await this.deps.stopBot(bot.id, 'human');
    const msg = `Paused (stopped) ${bot.name}.`;
    this.reply(msg);
    return msg;
  }

  private configText(): string {
    return this.deps.getLimits() ? 'Config: valid' : 'Config: INVALID or not loaded - bots cannot start';
  }

  private botsText(): string {
    const bots = this.deps.botRepo.findAll().filter((b) => b.stage !== 'retired');
    if (bots.length === 0) return 'No bots.';
    const halted = new Set(this.deps.riskStateRepo.all().filter((r) => r.halted === 1).map((r) => r.scope));
    const lines = bots.slice(0, 30).map(
      (b) => `${b.name} [${b.stage}/${b.mode}] ${this.deps.isRunning(b.id) ? 'running' : 'stopped'}${halted.has(b.id) ? ' HALTED' : ''}`
    );
    if (bots.length > 30) lines.push(`…and ${bots.length - 30} more`);
    return lines.join('\n');
  }

  private perBotPnlText(): string {
    const rows = this.deps.riskStateRepo.all().filter((r) => r.scope !== GLOBAL_SCOPE && ((r.day_live_pnl ?? 0) !== 0 || (r.day_paper_pnl ?? 0) !== 0));
    const lines = rows.slice(0, 25).map((r) => `${this.botName(r.scope)}: live ${signed(r.day_live_pnl ?? 0)}, paper ${signed(r.day_paper_pnl ?? 0)}`);
    return [this.pnlText(), ...(lines.length ? ['', ...lines] : [])].join('\n');
  }
}
