import { MAX_HORIZON_DAYS, type BotLabConfig, type MandateConfig } from '../config/schema';
import type {
  BotRiskInfo,
  Exchange,
  HorizonBucket,
  OrderRequest,
  RiskCheckName,
  RiskCheckResult,
  RiskDecision,
  RiskStateProvider,
  RiskStateSnapshot,
} from './types';

/**
 * RiskEngine — the single pre-trade check every live order passes (spec §4.1).
 *
 * Pure and deterministic: given an order, a state snapshot and the config, it
 * returns a decision. All I/O (DB, exchange, clock) lives in the RiskStateProvider.
 *
 * Checks run in spec order and stop at the first failure. Every check that ran is
 * recorded in the decision so it can be stored in `orders.risk_decision`.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** Tolerance so floating-point sums exactly at a limit still pass */
const EPS = 1e-9;

/** Polymarket price bounds */
const MIN_PRICE = 0.01;
const MAX_PRICE = 0.99;

/** Minimum edge for ledger-driven orders, regardless of template config */
const MIN_EDGE_FLOOR = 0.03;

/** Buys are blocked this long after a market's rules change */
const RULES_CHANGED_BLOCK_MS = 24 * 60 * MS_PER_MINUTE;

// ─── Helpers shared with RiskStateProvider implementations ────────────

/** Days from `now` until `endDate`; null when the end date is unknown/invalid. */
export function daysToSettlement(endDate: string | null, now: number): number | null {
  if (!endDate) return null;
  const end = Date.parse(endDate);
  if (Number.isNaN(end)) return null;
  return (end - now) / MS_PER_DAY;
}

/** Category-rights bucket (spec §6.3): short ≤ 7 days, medium 7–30, long 30–90. */
export function horizonBucket(days: number): HorizonBucket {
  if (days <= 7) return 'short';
  if (days <= 30) return 'medium';
  return 'long';
}

/** Market counts toward the long-horizon budget when it settles after the default horizon. */
export function isLongHorizon(days: number, mandate: MandateConfig): boolean {
  return days > mandate.markets.resolves_within_days[1];
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export class RiskEngine {
  private config: BotLabConfig;

  constructor(config: BotLabConfig) {
    this.config = config;
  }

  /** Replace the config (callers validate before calling). */
  setConfig(config: BotLabConfig): void {
    this.config = config;
  }

  getConfig(): BotLabConfig {
    return this.config;
  }

  /** Max exposure for a bot given its stage (spec §4.5). 0 for paper/retired. */
  effectiveAllocation(bot: BotRiskInfo, exchange: Exchange): number {
    const { limits } = this.config;
    const configured = exchange === 'binance' ? limits.binance.allocation_usd : limits.per_bot_defaults.allocation_usd;
    // Per-bot override can only lower the configured allocation
    const base = bot.allocationUsd != null ? Math.min(bot.allocationUsd, configured) : configured;

    switch (bot.stage) {
      case 'full':
        return base;
      case 'probation':
        return Math.min(
          base,
          bot.newTemplate ? limits.ramp.new_template_probation_allocation_usd : limits.ramp.probation_allocation_usd
        );
      default:
        return 0;
    }
  }

  /** Fetch state from the provider and check the order. */
  async evaluate(order: OrderRequest, provider: RiskStateProvider): Promise<RiskDecision> {
    const state = await provider.getSnapshot(order);
    return this.check(order, state);
  }

  check(order: OrderRequest, state: RiskStateSnapshot): RiskDecision {
    const { limits, mandate } = this.config;
    const { now, bot, exposure } = state;
    const checks: RiskCheckResult[] = [];
    const isBuy = order.side === 'buy';
    const isPoly = order.exchange === 'polymarket';
    const market = order.market;

    const record = (
      step: number,
      name: RiskCheckName,
      passed: boolean,
      detail: string,
      values?: RiskCheckResult['values']
    ): boolean => {
      checks.push({ step, name, passed, detail, ...(values ? { values } : {}) });
      return passed;
    };
    const decide = (): RiskDecision => {
      const failed = checks.find((c) => !c.passed);
      return {
        allowed: !failed,
        ...(failed ? { failedCheck: failed.name, reason: failed.detail } : {}),
        checks,
        evaluatedAt: new Date(now).toISOString(),
      };
    };

    // ── Step 1: halts and stage ──────────────────────────────────────
    if (!record(1, 'global_halt', !state.globalHalted,
      state.globalHalted ? `Global halt active: ${state.globalHaltReason || 'no reason given'}` : 'No global halt')) {
      return decide();
    }
    if (!bot) {
      record(1, 'bot_halt', false, `Unknown bot ${order.botId}`);
      return decide();
    }
    if (!record(1, 'bot_halt', !bot.halted,
      bot.halted ? `Bot halted: ${bot.haltReason || 'no reason given'}` : 'Bot not halted')) {
      return decide();
    }
    const liveStage = bot.stage === 'probation' || bot.stage === 'full';
    if (!record(1, 'bot_stage', liveStage,
      liveStage ? `Stage ${bot.stage} allows live orders` : `Stage ${bot.stage} does not allow live orders`,
      { stage: bot.stage })) {
      return decide();
    }

    // ── Step 2: market allowed ───────────────────────────────────────
    if (!isPoly) {
      if (!record(2, 'exchange_enabled', limits.binance.enabled,
        limits.binance.enabled ? 'Binance enabled' : 'Binance trading disabled in limits.yaml')) {
        return decide();
      }
    } else if (!record(2, 'market_data', market !== null,
      market ? 'Market metadata present' : 'Missing market metadata for Polymarket order')) {
      return decide();
    }

    const inScope = bot.marketIds === null || bot.marketIds.includes(order.marketId);
    if (!record(2, 'market_scope', inScope,
      bot.marketIds === null ? 'Bot is not market-scoped'
        : inScope ? 'Market in bot scope' : `Market ${order.marketId} not in bot's market_ids`)) {
      return decide();
    }

    const days = market ? daysToSettlement(market.endDate, now) : null;

    if (market) {
      // Category, ambiguity, rules and liquidity gate new risk only; exits stay possible.
      if (isBuy) {
        const category = market.category;
        const allowed = category !== null && mandate.categories.allow.includes(category);
        if (!record(2, 'category', allowed,
          allowed ? `Category ${category} allowed` : `Category ${category ?? '(unknown)'} not in mandate allow list`,
          { category })) {
          return decide();
        }
      }

      // End-of-market buffer applies to sells too, except flagged risk exits
      if (!(order.side === 'sell' && order.riskExit)) {
        const minutesToEnd = days === null ? null : (days * MS_PER_DAY) / MS_PER_MINUTE;
        const minMinutes = limits.per_market.no_trade_before_end_minutes;
        const ok = minutesToEnd === null ? !isBuy : minutesToEnd >= minMinutes;
        if (!record(2, 'end_buffer', ok,
          minutesToEnd === null
            ? (ok ? 'End date unknown (sell allowed)' : 'End date unknown')
            : ok ? `${round(minutesToEnd)} min to end` : `${round(minutesToEnd)} min to end < ${minMinutes}`,
          { minutesToEnd: minutesToEnd === null ? null : round(minutesToEnd), limit: minMinutes })) {
          return decide();
        }
      }

      if (isBuy) {
        const maxAmb = mandate.markets.max_ambiguity_score;
        const amb = market.ambiguityScore;
        const ambOk = amb !== null && amb <= maxAmb;
        if (!record(2, 'ambiguity', ambOk,
          amb === null ? 'Ambiguity not rated' : ambOk ? `Ambiguity ${amb} <= ${maxAmb}` : `Ambiguity ${amb} > ${maxAmb}`,
          { ambiguity: amb, limit: maxAmb })) {
          return decide();
        }

        const changedAt = market.rulesChangedAt ? Date.parse(market.rulesChangedAt) : NaN;
        const recentlyChanged = !Number.isNaN(changedAt) && now - changedAt < RULES_CHANGED_BLOCK_MS;
        if (!record(2, 'rules_changed', !recentlyChanged,
          recentlyChanged ? `Market rules changed at ${market.rulesChangedAt} (< 24h ago)` : 'No recent rules change',
          { rulesChangedAt: market.rulesChangedAt })) {
          return decide();
        }

        const minLiq = Math.max(limits.per_market.min_liquidity_usd, mandate.markets.min_liquidity_usd);
        const liq = market.liquidityUsd;
        const liqOk = liq !== null && liq + EPS >= minLiq;
        if (!record(2, 'liquidity', liqOk,
          liq === null ? 'Liquidity unknown' : liqOk ? `Liquidity ${liq} >= ${minLiq}` : `Liquidity ${liq} < ${minLiq}`,
          { liquidityUsd: liq, limit: minLiq })) {
          return decide();
        }
      }
    }

    // ── Step 3: order shape ──────────────────────────────────────────
    const { price, size, notionalUsd } = order;
    const finitePositive = [price, size, notionalUsd].every((n) => Number.isFinite(n) && n > 0);
    // Limit orders: notional must not understate price × size (it drives every exposure check)
    const notionalOk = order.orderType !== 'limit' || notionalUsd >= price * size * (1 - 1e-6);
    if (!record(3, 'order_input', finitePositive && notionalOk,
      !finitePositive ? 'Price, size and notional must be positive numbers'
        : notionalOk ? 'Order input valid' : `Notional ${notionalUsd} < price × size ${round(price * size)}`,
      { price, size, notionalUsd })) {
      return decide();
    }

    const maxOrder = isPoly ? limits.per_bot_defaults.max_order_usd : limits.binance.max_order_usd;
    if (!record(3, 'max_order', notionalUsd <= maxOrder + EPS,
      notionalUsd <= maxOrder + EPS ? `Notional ${notionalUsd} <= ${maxOrder}` : `Notional ${notionalUsd} > max_order_usd ${maxOrder}`,
      { notionalUsd, limit: maxOrder })) {
      return decide();
    }

    if (market) {
      const inRange = price >= MIN_PRICE - EPS && price <= MAX_PRICE + EPS;
      if (!record(3, 'price_range', inRange,
        inRange ? `Price ${price} within [${MIN_PRICE}, ${MAX_PRICE}]` : `Price ${price} outside [${MIN_PRICE}, ${MAX_PRICE}]`,
        { price })) {
        return decide();
      }

      const { bestBid, bestAsk } = market;
      const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
      const maxSpread = limits.per_market.max_spread;
      const spreadOk = spread !== null && spread <= maxSpread + EPS;
      if (!record(3, 'spread', spreadOk,
        spread === null ? 'Order book incomplete (no best bid/ask)'
          : spreadOk ? `Spread ${round(spread)} <= ${maxSpread}` : `Spread ${round(spread)} > ${maxSpread}`,
        { bestBid, bestAsk, spread: spread === null ? null : round(spread), limit: maxSpread })) {
        return decide();
      }

      // Order crosses the book (takes liquidity)?
      const marketable =
        order.orderType === 'market' ||
        (isBuy ? bestAsk !== null && price >= bestAsk : bestBid !== null && price <= bestBid);

      if (marketable) {
        if (!record(3, 'marketable_allowed', limits.orders.allow_marketable,
          limits.orders.allow_marketable ? 'Marketable orders allowed' : 'Marketable orders disabled (orders.allow_marketable)')) {
          return decide();
        }

        const best = (isBuy ? bestAsk : bestBid) as number;
        const slip = Math.abs(price - best);
        const maxSlip = limits.per_market.max_slippage;
        if (!record(3, 'slippage', slip <= maxSlip + EPS,
          slip <= maxSlip + EPS ? `Price ${price} within ${maxSlip} of best ${best}` : `Price ${price} is ${round(slip)} from best ${best} > ${maxSlip}`,
          { price, best, slippage: round(slip), limit: maxSlip })) {
          return decide();
        }

        const depth = isBuy ? market.bestAskSizeUsd : market.bestBidSizeUsd;
        const minDepth = limits.per_market.min_top_of_book_usd;
        const depthOk = depth !== null && depth + EPS >= minDepth;
        if (!record(3, 'top_of_book', depthOk,
          depth === null ? 'Top-of-book size unknown' : depthOk ? `Top of book $${depth} >= $${minDepth}` : `Top of book $${depth} < $${minDepth}`,
          { depthUsd: depth, limit: minDepth })) {
          return decide();
        }
      }
    }

    // ── Step 4: rate ─────────────────────────────────────────────────
    const maxPerHour = limits.per_bot_defaults.max_orders_per_hour;
    if (!record(4, 'bot_rate', state.botOrdersLastHour < maxPerHour,
      `${state.botOrdersLastHour} orders in the last hour (max ${maxPerHour})`,
      { ordersLastHour: state.botOrdersLastHour, limit: maxPerHour })) {
      return decide();
    }
    const maxOpen = limits.global.max_open_orders;
    if (!record(4, 'open_orders', state.openOrdersCount < maxOpen,
      `${state.openOrdersCount} open orders (max ${maxOpen})`,
      { openOrders: state.openOrdersCount, limit: maxOpen })) {
      return decide();
    }

    // ── Step 5: exposure ─────────────────────────────────────────────
    if (!isBuy) {
      // A sell can only reduce exposure if the bot holds at least that much
      const held = state.position?.size ?? 0;
      if (!record(5, 'sell_position', size <= held + EPS,
        size <= held + EPS ? `Sell ${size} <= held ${held} (reduces exposure)` : `Sell ${size} > held ${held}`,
        { size, held })) {
        return decide();
      }
    } else {
      if (isPoly) {
        const [minDays, maxDefault] = mandate.markets.resolves_within_days;
        const [longMin, longMax] = mandate.markets.long_horizon_days;
        const inHorizon =
          days !== null &&
          days <= MAX_HORIZON_DAYS &&
          ((days >= minDays && days <= maxDefault) || (days >= longMin && days <= longMax));
        if (!record(5, 'horizon', inHorizon,
          days === null ? 'Days to settlement unknown'
            : inHorizon ? `Settles in ${round(days)} days`
              : `Settles in ${round(days)} days, outside mandate horizons [${minDays}, ${maxDefault}] / [${longMin}, ${longMax}] (hard max ${MAX_HORIZON_DAYS})`,
          { days: days === null ? null : round(days) })) {
          return decide();
        }
      }

      const allocation = this.effectiveAllocation(bot, order.exchange);
      const botAfter = exposure.botUsd + notionalUsd;
      if (!record(5, 'bot_exposure', botAfter <= allocation + EPS,
        `Bot exposure ${round(botAfter)} after order vs allocation ${allocation} (${bot.stage})`,
        { exposureAfter: round(botAfter), limit: allocation })) {
        return decide();
      }

      if (isPoly) {
        const maxMarket = limits.per_market.max_exposure_usd;
        const marketAfter = exposure.marketUsd + notionalUsd;
        if (!record(5, 'market_exposure', marketAfter <= maxMarket + EPS,
          `Market exposure ${round(marketAfter)} after order vs ${maxMarket}`,
          { exposureAfter: round(marketAfter), limit: maxMarket })) {
          return decide();
        }
      }

      const totalLimit = this.totalExposureLimit(state.equityUsd);
      const totalAfter = exposure.totalUsd + notionalUsd;
      if (!record(5, 'total_exposure', totalAfter <= totalLimit + EPS,
        `Total exposure ${round(totalAfter)} after order vs ${round(totalLimit)}`,
        { exposureAfter: round(totalAfter), limit: round(totalLimit), equityUsd: state.equityUsd })) {
        return decide();
      }

      if (isPoly && days !== null && isLongHorizon(days, mandate)) {
        const longLimit = limits.global.max_long_horizon_pct * totalLimit;
        const longAfter = exposure.longHorizonUsd + notionalUsd;
        if (!record(5, 'long_horizon', longAfter <= longLimit + EPS,
          `Long-horizon exposure ${round(longAfter)} after order vs ${round(longLimit)}`,
          { exposureAfter: round(longAfter), limit: round(longLimit) })) {
          return decide();
        }
      }

      if (order.forecast) {
        const bucket = state.categoryBucket;
        const trading = bucket !== null && bucket.state === 'trading';
        const bucketAfter = (bucket?.exposureUsd ?? 0) + notionalUsd;
        const ok = trading && bucketAfter <= bucket.maxAllocationUsd + EPS;
        if (!record(5, 'category_exposure', ok,
          !bucket ? 'No category rights for this category/horizon'
            : !trading ? `Category rights are ${bucket.state}, not trading`
              : `Category bucket exposure ${round(bucketAfter)} after order vs ${bucket.maxAllocationUsd}`,
          { state: bucket?.state ?? null, exposureAfter: round(bucketAfter), limit: bucket?.maxAllocationUsd ?? null })) {
          return decide();
        }
      }
    }

    // ── Step 6: hold time ────────────────────────────────────────────
    if (!isBuy) {
      const minHold = limits.per_bot_defaults.min_hold_minutes;
      const openedAt = state.position?.openedAt ?? null;
      const ageMinutes = openedAt === null ? null : (now - openedAt) / MS_PER_MINUTE;
      const ok = order.riskExit === true || (ageMinutes !== null && ageMinutes + EPS >= minHold);
      if (!record(6, 'hold_time', ok,
        order.riskExit ? 'Risk exit (hold time exempt)'
          : ageMinutes === null ? 'Position open time unknown'
            : ok ? `Position held ${round(ageMinutes)} min` : `Position held ${round(ageMinutes)} min < ${minHold}`,
        { ageMinutes: ageMinutes === null ? null : round(ageMinutes), limit: minHold, riskExit: !!order.riskExit })) {
        return decide();
      }
    }

    // ── Step 7: edge (ledger-driven only) ────────────────────────────
    if (order.forecast) {
      const p = order.forecast.probability;
      const minEdge = Math.max(order.forecast.minEdge ?? MIN_EDGE_FLOOR, MIN_EDGE_FLOOR);
      // Makers pay no fee; a marketable order pays the taker rate on notional
      const takes =
        !!market &&
        (order.orderType === 'market' ||
          (isBuy ? market.bestAsk !== null && price >= market.bestAsk : market.bestBid !== null && price <= market.bestBid));
      const feePerShare = takes ? market.takerFeeRate * price : 0;
      // Directional: buying only pays when p > price, selling when price > p
      const edge = (isBuy ? p - price : price - p) - feePerShare;
      const ok = !!market && edge + EPS >= minEdge;
      if (!record(7, 'edge', ok,
        !market ? 'Ledger-driven orders need market metadata'
          : ok ? `Edge ${round(edge)} >= ${minEdge}` : `Edge ${round(edge)} after fees < ${minEdge}`,
        { probability: p, price, fee: round(feePerShare), edge: round(edge), limit: minEdge, forecastId: order.forecast.forecastId })) {
        return decide();
      }
    }

    return decide();
  }

  /** min(max_total_exposure_usd, max_total_exposure_pct × equity) */
  totalExposureLimit(equityUsd: number): number {
    const g = this.config.limits.global;
    return Math.min(g.max_total_exposure_usd, g.max_total_exposure_pct * Math.max(equityUsd, 0));
  }
}
