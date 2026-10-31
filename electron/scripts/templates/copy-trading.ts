/**
 * Copy Trading Bot Template
 *
 * Monitors selected Polymarket traders and copies their trades.
 * Supports configurable multipliers and position limits.
 *
 * How it works:
 *   1. Polls the Polymarket activity API for each tracked trader
 *   2. Detects new trades since last check
 *   3. Evaluates whether to copy (size limits, daily volume caps)
 *   4. Executes buy/sell orders proportional to the trader's bet
 *
 * Sells (hotfix, spec §9.5): ctx.sell takes TOKENS. A leader sell is copied as the same fraction of our
 * position as the leader sold of theirs (leader position read from the data API); if that cannot be
 * determined, the USD copy size is converted to tokens at the current bid. Always capped at what this
 * bot holds (ctx.getPositions). Only activity rows with type TRADE are considered.
 */

export const meta = {
  name: 'Copy Trading',
  description: 'Copy trades from top Polymarket traders with configurable sizing and limits',
  version: '1.0.0',
  author: 'BotLab',
  configSchema: {
    type: 'object',
    properties: {
      traders: {
        type: 'array',
        title: 'Trader Addresses',
        description: 'Ethereum addresses of traders to copy',
        items: { type: 'string' },
        default: [],
      },
      baseMultiplier: {
        type: 'number',
        title: 'Base Multiplier',
        description: 'Fraction of trader bet to copy (e.g., 0.5 = 50%)',
        default: 0.1,
        minimum: 0.01,
        maximum: 10,
      },
      maxOrderSizeUsd: {
        type: 'number',
        title: 'Max Order Size (USD)',
        description: 'Maximum single order size',
        default: 50,
        minimum: 1,
      },
      minOrderSizeUsd: {
        type: 'number',
        title: 'Min Order Size (USD)',
        description: 'Minimum order size (skip smaller trades)',
        default: 1,
        minimum: 0.1,
      },
      maxDailyVolumeUsd: {
        type: 'number',
        title: 'Max Daily Volume (USD)',
        description: 'Maximum total volume per day',
        default: 500,
        minimum: 1,
      },
      smallTradeThreshold: {
        type: 'number',
        title: 'Small Trade Threshold (USD)',
        description: 'Trades below this size get a boost',
        default: 10,
      },
      smallTradePercentage: {
        type: 'number',
        title: 'Small Trade Percentage',
        description: 'Copy percentage for small trades (e.g., 1.0 = 100%)',
        default: 1.0,
      },
      pollingIntervalMs: {
        type: 'number',
        title: 'Polling Interval (ms)',
        description: 'How often to check for new trades',
        default: 15000,
        minimum: 5000,
      },
      tooOldTimestampHours: {
        type: 'number',
        title: 'Ignore Trades Older Than (hours)',
        description: 'Skip trades older than this threshold',
        default: 1,
      },
    },
    required: ['traders'],
  },
};

// Track state across ticks
let lastCheckTimestamps: Record<string, number> = {};
let dailyVolume = 0;
let dailyVolumeDate = '';

export async function onStart(ctx) {
  const config = ctx.config;
  const traders = (config.traders as string[]) || [];

  if (traders.length === 0) {
    ctx.log.error('No trader addresses configured. Please add at least one trader.');
    return;
  }

  ctx.log.info(`Copy Trading Bot started - tracking ${traders.length} trader(s)`);
  const balance = await ctx.getBalance();
  ctx.log.info(`Wallet balance: $${balance.toFixed(2)}`);

  // Restore state from storage
  const savedTimestamps = await ctx.storage.get('lastCheckTimestamps');
  if (savedTimestamps) {
    lastCheckTimestamps = savedTimestamps as Record<string, number>;
  }

  // Reset daily volume tracker
  const today = new Date().toISOString().slice(0, 10);
  const savedDate = await ctx.storage.get('dailyVolumeDate');
  if (savedDate === today) {
    dailyVolume = (await ctx.storage.get('dailyVolume')) as number || 0;
    dailyVolumeDate = today;
  } else {
    dailyVolume = 0;
    dailyVolumeDate = today;
  }

  // Main polling loop
  ctx.setInterval(async () => {
    try {
      await pollTraders(ctx, traders);
    } catch (err) {
      ctx.log.error(`Polling error: ${err}`);
    }
  }, config.pollingIntervalMs || 15000);
}

async function pollTraders(ctx, traders: string[]) {
  const config = ctx.config;
  const tooOldMs = (config.tooOldTimestampHours || 1) * 60 * 60 * 1000;
  const now = ctx.now;

  // Reset daily volume if new day
  const today = new Date().toISOString().slice(0, 10);
  if (dailyVolumeDate !== today) {
    dailyVolume = 0;
    dailyVolumeDate = today;
  }

  ctx.log.info(`Polling ${traders.length} trader(s)... (daily vol: $${dailyVolume.toFixed(2)})`);
  let totalNewTrades = 0;

  for (const trader of traders) {
    try {
      const lastCheck = lastCheckTimestamps[trader] || (now - tooOldMs);

      // Fetch trader activity from Polymarket
      const response = await ctx.fetch(
        `https://data-api.polymarket.com/activity?user=${trader}&limit=20`
      );
      if (!response.ok) throw new Error(`activity API HTTP ${response.status}`);
      const activities = await response.json();

      if (!Array.isArray(activities)) continue;

      // Filter new trades (API returns timestamps in seconds, convert to ms).
      // Only TRADE rows: REDEEM/SPLIT/MERGE/REWARD/CONVERSION are not trades to copy.
      const newTrades = activities.filter((a: any) => {
        if (a.type !== 'TRADE') return false;
        const ts = (a.timestamp < 1e12 ? a.timestamp * 1000 : a.timestamp);
        return ts > lastCheck && (now - ts) < tooOldMs;
      });

      if (newTrades.length > 0) {
        ctx.log.info(`Found ${newTrades.length} new trade(s) from ${trader.slice(0, 8)}...`);
        totalNewTrades += newTrades.length;
      }

      // Oldest first. For a sell, the leader's position right after it = their current position minus
      // the net tokens they traded in this asset later in the batch.
      const tsOf = (a: any) => (a.timestamp < 1e12 ? a.timestamp * 1000 : a.timestamp);
      newTrades.sort((a: any, b: any) => tsOf(a) - tsOf(b));
      for (let i = 0; i < newTrades.length; i++) {
        const trade = newTrades[i];
        let laterNetTokens = 0;
        for (const later of newTrades.slice(i + 1)) {
          if (later.asset !== trade.asset || tsOf(later) <= tsOf(trade)) continue;
          const size = parseFloat(later.size || '0') || 0;
          laterNetTokens += later.side === 'BUY' ? size : later.side === 'SELL' ? -size : 0;
        }
        await processTrade(ctx, trade, trader, laterNetTokens);
      }

      // Update last check timestamp
      lastCheckTimestamps[trader] = now;
    } catch (err) {
      ctx.log.warn(`Failed to poll trader ${trader.slice(0, 8)}...: ${err}`);
    }
  }

  if (totalNewTrades === 0) {
    ctx.log.debug(`No new trades found`);
  }

  // Persist timestamps
  await ctx.storage.set('lastCheckTimestamps', lastCheckTimestamps);
  await ctx.storage.set('dailyVolume', dailyVolume);
  await ctx.storage.set('dailyVolumeDate', dailyVolumeDate);
}

/**
 * Token amount to sell when copying a leader's sell. Pure (unit-tested).
 * - Leader's sold fraction known (sold tokens + leader's remaining position): sell that fraction of ours.
 * - Otherwise: copy size in USD converted to tokens at `price`.
 * Always capped at our held tokens; rounded down to 0.01 tokens.
 */
export function copySellSize(p: {
  heldTokens: number;
  leaderSoldTokens?: number | null;
  leaderRemainingTokens?: number | null;
  copyUsd: number;
  price?: number | null;
}): { tokens: number; basis: 'fraction' | 'usd' | 'none'; reason?: string } {
  const held = Number(p.heldTokens);
  if (!(held > 0)) return { tokens: 0, basis: 'none', reason: 'no position held' };

  let tokens: number;
  let basis: 'fraction' | 'usd';
  const sold = Number(p.leaderSoldTokens);
  const remaining = p.leaderRemainingTokens === null || p.leaderRemainingTokens === undefined ? NaN : Number(p.leaderRemainingTokens);
  if (sold > 0 && Number.isFinite(sold) && remaining >= 0 && Number.isFinite(remaining)) {
    const fraction = Math.min(1, sold / (sold + remaining));
    tokens = held * fraction;
    basis = 'fraction';
  } else if (Number(p.price) > 0 && Number(p.copyUsd) > 0) {
    tokens = Number(p.copyUsd) / Number(p.price);
    basis = 'usd';
  } else {
    return { tokens: 0, basis: 'none', reason: 'leader fraction and price unknown' };
  }

  tokens = Math.floor(Math.min(tokens, held) * 100 + 1e-9) / 100;
  if (!(tokens > 0)) return { tokens: 0, basis, reason: 'size rounds to zero' };
  return { tokens, basis };
}

/** Leader's remaining position in `tokenId` after their sell, from the data API; null if unknown. */
async function fetchLeaderRemaining(ctx, traderAddress: string, conditionId: string | undefined, tokenId: string): Promise<number | null> {
  if (!conditionId) return null;
  try {
    const resp = await ctx.fetch(
      `https://data-api.polymarket.com/positions?user=${traderAddress}&market=${conditionId}&sizeThreshold=0`
    );
    if (!resp.ok) return null;
    const positions = await resp.json();
    if (!Array.isArray(positions)) return null;
    // If the API did not filter by market, "absent" would not mean "exited": treat as unknown
    if (positions.some((x: any) => x.conditionId && String(x.conditionId).toLowerCase() !== String(conditionId).toLowerCase())) return null;
    const pos = positions.find((x: any) => String(x.asset) === String(tokenId));
    // Absent from the market's positions ⇒ the leader exited completely
    return pos ? Math.max(0, parseFloat(pos.size) || 0) : 0;
  } catch {
    return null;
  }
}

async function processTrade(ctx, trade: any, traderAddress: string, laterNetTokens = 0) {
  const config = ctx.config;
  const side = trade.side;
  const tokenId = trade.asset || trade.tokenId;
  // API returns usdcSize (USD value) and size (token quantity) — use USD value for copy sizing
  const traderSize = parseFloat(trade.usdcSize || '0') || (parseFloat(trade.size || '0') * parseFloat(trade.price || '0'));

  if (!tokenId || traderSize <= 0) return;

  // Check daily volume limit (buys only: never block reducing a position)
  if (side === 'BUY' && dailyVolume >= (config.maxDailyVolumeUsd || 500)) {
    ctx.log.warn('Daily volume limit reached, skipping trade');
    return;
  }

  // Calculate copy size
  let copySize = traderSize * (config.baseMultiplier || 0.1);

  // Small trade boost
  if (traderSize < (config.smallTradeThreshold || 10)) {
    copySize = traderSize * (config.smallTradePercentage || 1.0);
  }

  // Enforce limits
  copySize = Math.min(copySize, config.maxOrderSizeUsd || 50);
  if (side === 'BUY' && copySize < (config.minOrderSizeUsd || 1)) {
    ctx.log.debug(`Trade too small ($${copySize.toFixed(2)}), skipping`);
    return;
  }

  // Execute
  try {
    let result;
    if (side === 'BUY') {
      result = await ctx.buy(tokenId, copySize);
    } else if (side === 'SELL') {
      // ctx.sell takes tokens: mirror the leader's sold fraction, else USD → tokens; capped at our holding
      const positions = await ctx.getPositions();
      const held = (positions || []).find((p: any) => String(p.tokenId) === String(tokenId));
      const heldTokens = held ? Number(held.size) || 0 : 0;
      if (heldTokens <= 0) {
        ctx.log.debug(`Leader sold ${String(tokenId).slice(0, 10)}... but we hold none, skipping`);
        return;
      }
      const leaderNow = await fetchLeaderRemaining(ctx, traderAddress, trade.conditionId, tokenId);
      const leaderRemaining = leaderNow === null ? null : Math.max(0, leaderNow - laterNetTokens);
      let price: number | null = null;
      if (leaderRemaining === null) {
        try {
          const mp = await ctx.getMarketPrice(tokenId);
          price = mp.bid > 0 ? mp.bid : mp.mid;
        } catch {
          price = null;
        }
      }
      const sizing = copySellSize({
        heldTokens,
        leaderSoldTokens: parseFloat(trade.size || '0'),
        leaderRemainingTokens: leaderRemaining,
        copyUsd: copySize,
        price,
      });
      if (sizing.tokens <= 0) {
        ctx.log.debug(`Sell not copied: ${sizing.reason}`);
        return;
      }
      ctx.log.info(`Copying SELL: ${sizing.tokens} of ${heldTokens} tokens held (${sizing.basis})`);
      result = await ctx.sell(tokenId, sizing.tokens);
    } else {
      ctx.log.debug(`Unknown trade side: ${side}`);
      return;
    }

    if (result.success) {
      dailyVolume += result.executedAmount;
      ctx.log.info(
        `Copied ${side} from ${traderAddress.slice(0, 8)}... ` +
        `$${result.executedAmount.toFixed(2)} @ ${result.price.toFixed(4)}`
      );
      ctx.emit('trade', {
        side,
        traderAddress,
        amount: result.executedAmount,
        price: result.price,
      });
    } else {
      ctx.log.warn(`Copy trade failed: ${result.error}`);
    }
  } catch (err) {
    ctx.log.error(`Trade execution error: ${err}`);
  }
}

export async function onStop(ctx) {
  ctx.log.info(`Copy Trading Bot stopped. Daily volume: $${dailyVolume.toFixed(2)}`);
  await ctx.storage.set('lastCheckTimestamps', lastCheckTimestamps);
  await ctx.storage.set('dailyVolume', dailyVolume);
  await ctx.storage.set('dailyVolumeDate', dailyVolumeDate);
}

export function onHeartbeat(ctx) {
  return {
    trackedTraders: ((ctx.config.traders as string[]) || []).length,
    dailyVolume: dailyVolume.toFixed(2),
  };
}
