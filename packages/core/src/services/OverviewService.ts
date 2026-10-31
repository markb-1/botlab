/**
 * OverviewService — the dashboard's risk picture (spec §12 Dashboard, §7.3 `get_overview`): equity,
 * exposure vs limits, daily P&L vs the loss limit, halts, live-trading switch, reconciler freshness and
 * clock, category rights summary, and each bot's allocation used / available.
 *
 * Read-only. Exposure is computed like `DbRiskStateProvider` (order-linked positions at cost + unfilled
 * open buys); long-horizon exposure uses the market cache's end dates only (no network), and a token
 * with no cached end date counts as long (fail closed, as in the engine). Equity needs wallet balances
 * (network): it is cached for 30 s and reported as null with the error when unavailable.
 */

import type { BotRepository } from '../db/repositories/BotRepository';
import type { ScriptRepository } from '../db/repositories/ScriptRepository';
import type { BotTradeRepository, RiskPositionRow } from '../db/repositories/BotTradeRepository';
import type { OrderRepository, OrderRow } from '../db/repositories/OrderRepository';
import { GLOBAL_SCOPE, type LossBaseline, type RiskStateRepository } from '../db/repositories/RiskStateRepository';
import type { AppConfig } from '../config/changes';
import type { MarketView } from '../ledger/MarketCacheService';
import type { BucketStatsView } from '../ledger/LedgerService';
import type { Reconciler } from '../reconcile/Reconciler';
import { RiskEngine, daysToSettlement, isLongHorizon } from '../risk/RiskEngine';
import type { BotStage } from '../risk/types';
import { unfilledNotional } from '../orders/DbRiskStateProvider';
import { publicLookupError, scrubPublicText } from './redact';
import logger from '../utils/logger';

const EQUITY_CACHE_MS = 30_000;
const EQUITY_TIMEOUT_MS = 10_000;
/** Matches /healthz: a successful reconciler run older than this is stale */
export const RECONCILE_STALE_MS = 3 * 60_000;

export interface OverviewDeps {
  botRepo: Pick<BotRepository, 'findAll'>;
  scriptRepo: Pick<ScriptRepository, 'findById'>;
  tradeRepo: Pick<BotTradeRepository, 'getRiskPositions'>;
  orderRepo: Pick<OrderRepository, 'findOpen'>;
  riskStateRepo: Pick<RiskStateRepository, 'all'>;
  getConfig: () => AppConfig | null;
  getConfigError: () => string | null;
  getCachedMarketByToken: (tokenId: string) => MarketView | null;
  ledgerStats: () => BucketStatsView[];
  getReconciler: () => Reconciler | null;
  /** Free cash of the wallets live bots trade from (+ Binance USDT); throws when unavailable */
  getLiveCashUsd: () => Promise<number>;
  now?: () => number;
}

export interface BotAllocationView {
  botId: string;
  name: string;
  stage: string;
  /** Bot run state: running / stopped / error / ... */
  status: string;
  /** Paper bots are measured against their own paper orders and fills (stage paper counts as full) */
  simulated: boolean;
  /** Effective Polymarket allocation for the stage; null when the config is invalid */
  allocationUsd: number | null;
  usedUsd: number;
  availableUsd: number | null;
}

export interface OverviewView {
  at: string;
  config: { valid: boolean; error: string | null };
  liveTradingEnabled: boolean | null;
  approvalsNewTemplateLive: boolean | null;
  equity: { usd: number | null; cashUsd: number | null; positionsUsd: number; error: string | null; at: string | null };
  exposure: {
    totalUsd: number;
    /** min(max_total_exposure_usd, max_total_exposure_pct × equity); USD cap alone when equity is unknown */
    totalLimitUsd: number | null;
    /** limits.global caps the total limit is derived from */
    totalCapUsd: number | null;
    totalCapPct: number | null;
    longHorizonPct: number | null;
    longHorizonUsd: number;
    /** Part of longHorizonUsd counted long only because the end date is not cached */
    longHorizonUnknownUsd: number;
    longHorizonLimitUsd: number | null;
    openOrders: number;
    maxOpenOrders: number | null;
  };
  dailyPnl: {
    liveUsd: number | null;
    paperUsd: number | null;
    limitUsd: number | null;
    /** P&L at the last human halt clear today (the loss limit counts from there, R23) */
    baselineUsd: number | null;
    /** Loss counted against the limit (≥ 0) */
    lossUsd: number | null;
    dayStart: string | null;
    updatedAt: string | null;
  };
  halts: {
    global: { halted: boolean; reason: string | null; haltedAt: string | null };
    bots: Array<{ botId: string; name: string; reason: string | null; haltedAt: string | null }>;
  };
  reconciler: {
    reconciledAt: string | null;
    stale: boolean;
    locked: boolean;
    lastRunAt: string | null;
    lastRunOk: boolean | null;
    lastErrors: string[];
    consecutiveFailures: number;
    mismatches: number;
    clock: { ok: boolean; reason: string | null; detail: string | null; skewMs: number | null };
  };
  rights: { counts: Record<string, number>; trading: Array<{ category: string; horizonBucket: string; maxAllocationUsd: number }> };
  bots: BotAllocationView[];
}

function parseBaseline(raw: string | null | undefined): LossBaseline | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LossBaseline;
  } catch {
    return null;
  }
}

export class OverviewService {
  private equityCache: { at: number; cash: number | null; error: string | null } | null = null;
  private equityInflight: Promise<void> | null = null;
  private now: () => number;

  constructor(private deps: OverviewDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async cash(): Promise<{ cash: number | null; error: string | null; at: number }> {
    const hit = this.equityCache;
    if (hit && this.now() - hit.at < EQUITY_CACHE_MS) return hit;
    if (!this.equityInflight) {
      this.equityInflight = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`balance lookup timed out after ${EQUITY_TIMEOUT_MS / 1000} s`)), EQUITY_TIMEOUT_MS);
          });
          const cash = await Promise.race([this.deps.getLiveCashUsd(), timeout]);
          this.equityCache =
            Number.isFinite(cash) && cash >= 0 ? { at: this.now(), cash, error: null } : { at: this.now(), cash: null, error: 'balance not a number' };
        } catch (err) {
          // Library errors carry the RPC URL (API key) and request body: log them, return a short message
          logger.warning(`[Overview] Equity cash lookup failed: ${err instanceof Error ? err.message : String(err)}`);
          this.equityCache = { at: this.now(), cash: null, error: publicLookupError(err, 'balance lookup') };
        } finally {
          clearTimeout(timer);
          this.equityInflight = null;
        }
      })();
    }
    await this.equityInflight;
    return this.equityCache ?? { cash: null, error: 'unavailable', at: this.now() };
  }

  async overview(): Promise<OverviewView> {
    const { deps } = this;
    const now = this.now();
    const config = deps.getConfig();
    const limits = config?.limits ?? null;

    // ── Exposure (live) ───────────────────────────────────────────
    const livePositions = deps.tradeRepo.getRiskPositions({ simulated: false });
    const liveOpen = deps.orderRepo.findOpen(undefined, false);
    const liveBuys = liveOpen.filter((o) => o.side === 'buy');
    const positionsUsd = livePositions.reduce((n, p) => n + p.cost_basis, 0);
    const totalUsd = positionsUsd + liveBuys.reduce((n, o) => n + unfilledNotional(o), 0);

    const longOf = new Map<string, { long: boolean; unknown: boolean }>();
    const classify = (tokenId: string) => {
      let v = longOf.get(tokenId);
      if (!v) {
        const days = daysToSettlement(deps.getCachedMarketByToken(tokenId)?.endDate ?? null, now);
        v = { long: days === null || isLongHorizon(days), unknown: days === null };
        longOf.set(tokenId, v);
      }
      return v;
    };
    let longHorizonUsd = 0;
    let longHorizonUnknownUsd = 0;
    const addLong = (tokenId: string, usd: number) => {
      const c = classify(tokenId);
      if (!c.long) return;
      longHorizonUsd += usd;
      if (c.unknown) longHorizonUnknownUsd += usd;
    };
    for (const p of livePositions) if (p.exchange === 'polymarket') addLong(p.symbol, p.cost_basis);
    for (const o of liveBuys) if (o.exchange === 'polymarket') addLong(o.token_id, unfilledNotional(o));

    // ── Equity ────────────────────────────────────────────────────
    const cash = await this.cash();
    const equityUsd = cash.cash === null ? null : cash.cash + positionsUsd;
    const g = limits?.global ?? null;
    const totalLimitUsd = g
      ? equityUsd === null
        ? g.max_total_exposure_usd
        : Math.min(g.max_total_exposure_usd, g.max_total_exposure_pct * Math.max(equityUsd, 0))
      : null;
    const longHorizonLimitUsd = g && equityUsd !== null ? g.max_long_horizon_pct * Math.max(equityUsd, 0) : null;

    // ── Daily P&L and halts ───────────────────────────────────────
    const rows = deps.riskStateRepo.all();
    const globalRow = rows.find((r) => r.scope === GLOBAL_SCOPE);
    const baseline = parseBaseline(globalRow?.loss_baseline);
    const baselineUsd = baseline && globalRow?.day_start && baseline.day === globalRow.day_start ? baseline.live : null;
    const liveUsd = globalRow?.day_live_pnl ?? null;
    const lossUsd = liveUsd === null ? null : Math.max(0, -(liveUsd - (baselineUsd ?? 0)));

    const bots = deps.botRepo.findAll();
    const nameOf = new Map(bots.map((b) => [b.id, b.name]));
    const haltedBots = rows
      .filter((r) => r.scope !== GLOBAL_SCOPE && r.halted === 1)
      .map((r) => ({ botId: r.scope, name: nameOf.get(r.scope) ?? r.scope, reason: r.halted_reason, haltedAt: r.halted_at }));

    // ── Reconciler and clock ──────────────────────────────────────
    const reconciler = deps.getReconciler();
    const last = reconciler?.lastRun() ?? null;
    const clock = reconciler?.status() ?? null;
    const reconciledAt = globalRow?.reconciled_at ?? null;
    const reconciledMs = reconciledAt ? Date.parse(reconciledAt) : NaN;

    // ── Category rights ───────────────────────────────────────────
    let stats: BucketStatsView[] = [];
    try {
      stats = deps.ledgerStats();
    } catch {
      stats = [];
    }
    const counts: Record<string, number> = {};
    for (const s of stats) counts[s.state] = (counts[s.state] ?? 0) + 1;

    return {
      at: new Date(now).toISOString(),
      config: { valid: config !== null, error: deps.getConfigError() },
      liveTradingEnabled: limits ? limits.live_trading.enabled : null,
      approvalsNewTemplateLive: limits ? limits.approvals.new_template_live : null,
      equity: { usd: equityUsd, cashUsd: cash.cash, positionsUsd, error: cash.error, at: new Date(cash.at).toISOString() },
      exposure: {
        totalUsd,
        totalLimitUsd,
        totalCapUsd: g?.max_total_exposure_usd ?? null,
        totalCapPct: g?.max_total_exposure_pct ?? null,
        longHorizonPct: g?.max_long_horizon_pct ?? null,
        longHorizonUsd,
        longHorizonUnknownUsd,
        longHorizonLimitUsd,
        openOrders: liveOpen.length,
        maxOpenOrders: g?.max_open_orders ?? null,
      },
      dailyPnl: {
        liveUsd,
        paperUsd: globalRow?.day_paper_pnl ?? null,
        limitUsd: g?.daily_loss_limit_usd ?? null,
        baselineUsd,
        lossUsd,
        dayStart: globalRow?.day_start ?? null,
        updatedAt: globalRow?.updated_at ?? null,
      },
      halts: {
        global: { halted: globalRow?.halted === 1, reason: globalRow?.halted_reason ?? null, haltedAt: globalRow?.halted_at ?? null },
        bots: haltedBots,
      },
      reconciler: {
        reconciledAt,
        stale: !(now - reconciledMs < RECONCILE_STALE_MS),
        locked: reconciler === null,
        lastRunAt: last?.at ?? null,
        lastRunOk: last ? last.result.ok : null,
        lastErrors: last?.result.errors.slice(0, 10).map(scrubPublicText) ?? [],
        consecutiveFailures: last?.consecutiveFailures ?? 0,
        mismatches: last?.result.mismatches.length ?? 0,
        clock: {
          ok: clock ? !clock.skewed : false,
          reason: clock?.reason ?? (clock ? null : 'reconciler not running'),
          detail: clock?.detail ? scrubPublicText(clock.detail) : null,
          skewMs: last?.result.clockSkewMs ?? null,
        },
      },
      rights: {
        counts,
        trading: stats
          .filter((s) => s.state === 'trading')
          .map((s) => ({ category: s.category, horizonBucket: s.horizonBucket, maxAllocationUsd: s.maxAllocationUsd })),
      },
      bots: this.allocations(config, bots, livePositions, liveOpen),
    };
  }

  private allocations(
    config: AppConfig | null,
    bots: ReturnType<OverviewDeps['botRepo']['findAll']>,
    livePositions: RiskPositionRow[],
    liveOpen: OrderRow[]
  ): BotAllocationView[] {
    const engine = config ? new RiskEngine({ limits: config.limits, mandate: config.mandate }) : null;
    const paperPositions = this.deps.tradeRepo.getRiskPositions({ simulated: true });
    const paperOpen = this.deps.orderRepo.findOpen(undefined, true);
    const used = (botId: string, positions: RiskPositionRow[], open: OrderRow[]) =>
      positions.filter((p) => p.bot_id === botId && p.exchange === 'polymarket').reduce((n, p) => n + p.cost_basis, 0) +
      open.filter((o) => o.bot_id === botId && o.side === 'buy' && o.exchange === 'polymarket').reduce((n, o) => n + unfilledNotional(o), 0);

    return bots.map((b) => {
      const simulated = b.mode === 'paper' || b.stage === 'paper';
      let stage = (b.stage || 'full') as BotStage;
      if (simulated && stage === 'paper') stage = 'full';
      const allocationUsd = engine
        ? engine.effectiveAllocation(
            {
              id: b.id,
              stage,
              allocationUsd: b.allocation_usd ?? null,
              marketIds: null,
              halted: false,
              newTemplate: this.deps.scriptRepo.findById(b.script_id)?.trust !== 'proven',
            },
            'polymarket'
          )
        : null;
      const usedUsd = simulated ? used(b.id, paperPositions, paperOpen) : used(b.id, livePositions, liveOpen);
      return {
        botId: b.id,
        name: b.name,
        stage: b.stage,
        status: b.status,
        simulated,
        allocationUsd,
        usedUsd,
        availableUsd: allocationUsd === null ? null : Math.max(0, allocationUsd - usedUsd),
      };
    });
  }
}
