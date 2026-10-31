/**
 * CopyLeaderService (spec §9.5 leader scoring, 5c): the leaders of copy-trading bots, which leader each copied order
 * came from, per-leader P&L / hit rate (pure scoring in `copy/scoring.ts`) and the automatic drop of a leader whose
 * copies lose (R182) — audited `copy.leader_dropped` (Telegram via NotificationService). A dropped leader is never
 * copied again until a human re-activates it on the bot page.
 *
 * Rows are kept in step with the bot's config (`leaders`) by BotService on create / config update; the running bot
 * asks for its leaders' status each cycle (`ctx.copy.getLeaders`), which also creates rows for leaders of bots made
 * before 5c and runs the auto-drop check.
 */

import type { CopyLeaderRepository, CopyLeaderRow } from '../db/repositories/CopyLeaderRepository';
import type { BotRepository } from '../db/repositories/BotRepository';
import type { AuditService } from '../audit/AuditService';
import { autoDropDecision, scoreCopyFills, AUTO_DROP_WINDOW, type ScoringResult } from '../copy/scoring';
import { auditActorOf, requireActor, type Actor } from './actors';
import { ServiceError, notFound } from './errors';

export const MAX_COPY_LEADERS = 20;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** The running bot asks every cycle; scoring runs at most this often per bot */
const EVALUATE_EVERY_MS = 60_000;

/** The leader addresses in a copy bot's config (`leaders`, or the pre-5c `traders`), lower-case, unique; invalid ones in `invalid` */
export function copyLeadersOf(config: Record<string, unknown> | null | undefined): { leaders: string[]; invalid: string[] } {
  const c = config ?? {};
  const raw = Array.isArray(c.leaders) ? c.leaders : Array.isArray(c.traders) ? c.traders : [];
  const leaders: string[] = [];
  const invalid: string[] = [];
  for (const v of raw) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!ADDRESS_RE.test(s)) {
      invalid.push(String(v).slice(0, 60));
      continue;
    }
    if (!leaders.includes(s.toLowerCase())) leaders.push(s.toLowerCase());
  }
  return { leaders, invalid };
}

export interface CopyLeaderView {
  address: string;
  status: CopyLeaderRow['status'];
  addedAt: string;
  addedBy: string;
  activeSince: string;
  droppedAt: string | null;
  droppedReason: string | null;
  /** Orders placed copying this leader (any outcome) */
  ordersCopied: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  hitRate: number | null;
  realisedPnlUsd: number;
  /** Open copied shares at the market cache's last outcome price minus cost; null when a price is unknown */
  unrealisedPnlUsd: number | null;
  openCostUsd: number;
  /** The auto-drop window: last 20 closed copied trades since `activeSince` */
  window: { trades: number; size: number; pnlUsd: number; hitRate: number | null };
}

export interface CopyLeaderStatusView {
  address: string;
  status: CopyLeaderRow['status'] | 'unknown';
  droppedReason: string | null;
}

export interface CopyLeaderServiceDeps {
  repo: CopyLeaderRepository;
  botRepo: Pick<BotRepository, 'findById'>;
  audit?: Pick<AuditService, 'record'>;
  /** Current price of a token (market cache outcome prices); null = unknown */
  mark?: (tokenId: string) => number | null;
  now?: () => number;
}

export class CopyLeaderService {
  private readonly now: () => number;
  private lastEvaluated = new Map<string, number>();

  constructor(private deps: CopyLeaderServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * Keep the leader rows in step with a copy bot's config (BotService, create / config update): new addresses are
   * added active (by `addedBy`), addresses no longer in the config become `removed`, a removed one added back is
   * active again with a new auto-drop window. A dropped leader stays dropped (a human re-activates it).
   */
  sync(botId: string, config: Record<string, unknown> | null | undefined, addedBy: 'human' | 'agent' | 'system'): void {
    const { leaders } = copyLeadersOf(config);
    const at = this.iso();
    const rows = this.deps.repo.list(botId);
    for (const address of leaders) {
      const row = rows.find((r) => r.address === address);
      if (!row) this.deps.repo.insert(botId, address, addedBy, at);
      else if (row.status === 'removed') this.deps.repo.reAdd(row.id, addedBy, at);
    }
    for (const row of rows) if (row.status === 'active' && !leaders.includes(row.address)) this.deps.repo.setRemoved(row.id, at);
  }

  /** Dropped leaders among `addresses` (BotService refuses the agent re-adding them) */
  droppedAmong(botId: string, addresses: string[]): string[] {
    const rows = this.deps.repo.list(botId);
    return addresses.filter((a) => rows.some((r) => r.address === a.toLowerCase() && r.status === 'dropped'));
  }

  /** Attribution of an order a copy-role bot placed (RpcHandler, after placing it) */
  recordOrder(
    botId: string,
    orderId: string,
    info: { leader: string; key?: string | null; side: 'buy' | 'sell'; leaderPrice?: number | null; leaderUsd?: number | null }
  ): void {
    if (!orderId || !ADDRESS_RE.test(info.leader)) return;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    this.deps.repo.recordTrade(
      {
        order_id: orderId,
        bot_id: botId,
        leader: info.leader.toLowerCase(),
        leader_key: typeof info.key === 'string' ? info.key.slice(0, 200) : null,
        side: info.side,
        leader_price: num(info.leaderPrice),
        leader_usd: num(info.leaderUsd),
      },
      this.iso()
    );
  }

  private score(botId: string): ScoringResult {
    const fills = this.deps.repo.fills(botId).map((f) => ({
      tokenId: f.symbol,
      side: f.side,
      shares: Number(f.quantity) || 0,
      usd: Number(f.quote_amount) || 0,
      feeUsd: Number(f.fee_usd) || 0,
      at: f.executed_at,
      simulated: f.simulated === 1,
      leader: f.leader,
    }));
    return scoreCopyFills(fills, this.deps.mark ?? (() => null));
  }

  /**
   * Auto-drop (R182): every active leader whose last 20 closed copied trades (since it became active) lost money with a
   * hit rate under 50 % is dropped, audited `copy.leader_dropped` as the system (Telegram). Returns the dropped addresses.
   */
  evaluate(botId: string): string[] {
    this.lastEvaluated.set(botId, this.now());
    const rows = this.deps.repo.list(botId).filter((r) => r.status === 'active');
    if (rows.length === 0) return [];
    const { closed } = this.score(botId);
    const dropped: string[] = [];
    for (const row of rows) {
      const d = autoDropDecision(closed, row.address, row.active_since);
      if (!d.drop) continue;
      const at = this.iso();
      if (!this.deps.repo.drop(row.id, `auto-drop: ${d.reason}`, at)) continue;
      dropped.push(row.address);
      this.deps.audit?.record('system', 'copy.leader_dropped', botId, {
        botName: this.deps.botRepo.findById(botId)?.name ?? null,
        leader: row.address,
        trades: d.trades,
        windowPnlUsd: d.windowPnlUsd,
        windowHitRate: d.windowHitRate,
        reason: d.reason,
      });
    }
    return dropped;
  }

  /**
   * The running bot's view (ctx.copy.getLeaders): the status of each address of its config. Rows missing for a
   * pre-5c bot are created (added by `system`); the auto-drop check runs first (at most once a minute).
   */
  statusFor(botId: string, addresses: unknown): CopyLeaderStatusView[] {
    const list = (Array.isArray(addresses) ? addresses : []).slice(0, MAX_COPY_LEADERS);
    const valid = list.filter((a): a is string => typeof a === 'string' && ADDRESS_RE.test(a.trim())).map((a) => a.trim().toLowerCase());
    const rows = this.deps.repo.list(botId);
    const at = this.iso();
    for (const a of valid) if (!rows.some((r) => r.address === a)) this.deps.repo.insert(botId, a, 'system', at);
    if (this.now() - (this.lastEvaluated.get(botId) ?? 0) >= EVALUATE_EVERY_MS) this.evaluate(botId);
    const fresh = this.deps.repo.list(botId);
    return list.map((a) => {
      const addr = typeof a === 'string' ? a.trim().toLowerCase() : '';
      const row = fresh.find((r) => r.address === addr);
      return { address: addr || String(a).slice(0, 60), status: row ? row.status : 'unknown', droppedReason: row?.dropped_reason ?? null };
    });
  }

  /** Per-leader stats of a bot (Bot page, MCP get_copy_leaders, digest) */
  leaders(botId: string): { botId: string; botName: string; leaders: CopyLeaderView[] } {
    const bot = this.deps.botRepo.findById(botId);
    if (!bot) throw notFound('Bot not found');
    const rows = this.deps.repo.list(botId);
    const result = this.score(botId);
    const orders = this.deps.repo.orderCounts(botId);
    const views = rows.map((row): CopyLeaderView => {
      const s = result.leaders.get(row.address);
      const w = autoDropDecision(result.closed, row.address, row.active_since);
      return {
        address: row.address,
        status: row.status,
        addedAt: row.added_at,
        addedBy: row.added_by,
        activeSince: row.active_since,
        droppedAt: row.dropped_at,
        droppedReason: row.dropped_reason,
        ordersCopied: orders.get(row.address) ?? 0,
        closedTrades: s?.closedTrades ?? 0,
        openTrades: s?.openTrades ?? 0,
        wins: s?.wins ?? 0,
        hitRate: s?.hitRate ?? null,
        realisedPnlUsd: s?.realisedPnlUsd ?? 0,
        unrealisedPnlUsd: s ? s.unrealisedPnlUsd : 0,
        openCostUsd: s?.openCostUsd ?? 0,
        window: { trades: w.trades, size: AUTO_DROP_WINDOW, pnlUsd: w.windowPnlUsd, hitRate: w.windowHitRate },
      };
    });
    return { botId, botName: bot.name, leaders: views };
  }

  /** Re-activate a dropped leader (human only): a new auto-drop window starts now. Audited. */
  reactivate(botId: string, address: unknown, by: Actor): CopyLeaderView[] {
    const who = requireActor(by, ['human'], 'copy.reactivateLeader');
    if (typeof address !== 'string' || !ADDRESS_RE.test(address.trim())) throw new ServiceError('invalid_input', 'address must be a 0x address');
    if (!this.deps.botRepo.findById(botId)) throw notFound('Bot not found');
    const row = this.deps.repo.find(botId, address.trim());
    if (!row) throw notFound('Leader not found on this bot');
    if (row.status !== 'dropped') throw new ServiceError('conflict', `Leader is ${row.status}, not dropped`);
    this.deps.repo.reactivate(row.id, this.iso());
    this.deps.audit?.record(auditActorOf(who), 'copy.leader_reactivated', botId, { leader: row.address, droppedReason: row.dropped_reason });
    return this.leaders(botId).leaders;
  }

  forgetBot(botId: string): void {
    this.deps.repo.deleteForBot(botId);
    this.lastEvaluated.delete(botId);
  }

  /** Per-leader lines for the daily digest; null without copy bots */
  digestText(maxLines = 15): string | null {
    const lines: string[] = [];
    const money = (n: number) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
    for (const botId of this.deps.repo.botIds()) {
      let view: ReturnType<CopyLeaderService['leaders']>;
      try {
        view = this.leaders(botId);
      } catch {
        continue;
      }
      for (const l of view.leaders) {
        if (l.status === 'removed') continue;
        lines.push(
          `- ${view.botName} ${l.address.slice(0, 6)}…${l.address.slice(-4)}: ${l.status}, ${l.closedTrades} closed / ${l.openTrades} open, ` +
            `hit ${l.hitRate === null ? '—' : `${Math.round(l.hitRate * 100)}%`}, realised ${money(l.realisedPnlUsd)}` +
            `${l.unrealisedPnlUsd === null ? '' : `, unrealised ${money(l.unrealisedPnlUsd)}`}`
        );
      }
    }
    if (lines.length === 0) return null;
    const shown = lines.slice(0, maxLines);
    if (lines.length > maxLines) shown.push(`… ${lines.length - maxLines} more on the bot pages`);
    return ['Copy leaders:', ...shown].join('\n');
  }
}
