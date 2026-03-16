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
      const activities = await response.json();

      if (!Array.isArray(activities)) continue;

      // Filter new trades (API returns timestamps in seconds, convert to ms)
      const newTrades = activities.filter((a: any) => {
        const ts = (a.timestamp < 1e12 ? a.timestamp * 1000 : a.timestamp);
        return ts > lastCheck && (now - ts) < tooOldMs;
      });

      if (newTrades.length > 0) {
        ctx.log.info(`Found ${newTrades.length} new trade(s) from ${trader.slice(0, 8)}...`);
        totalNewTrades += newTrades.length;
      }

      for (const trade of newTrades) {
        await processTrade(ctx, trade, trader);
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

async function processTrade(ctx, trade: any, traderAddress: string) {
  const config = ctx.config;
  const side = trade.side || trade.type;
  const tokenId = trade.asset || trade.tokenId;
  // API returns usdcSize (USD value) and size (token quantity) — use USD value for copy sizing
  const traderSize = parseFloat(trade.usdcSize || trade.size || trade.amount || '0');

  if (!tokenId || traderSize <= 0) return;

  // Check daily volume limit
  if (dailyVolume >= (config.maxDailyVolumeUsd || 500)) {
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
  if (copySize < (config.minOrderSizeUsd || 1)) {
    ctx.log.debug(`Trade too small ($${copySize.toFixed(2)}), skipping`);
    return;
  }

  // Execute
  try {
    let result;
    if (side === 'BUY') {
      result = await ctx.buy(tokenId, copySize);
    } else if (side === 'SELL') {
      result = await ctx.sell(tokenId, copySize);
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
