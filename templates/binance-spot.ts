export const meta = {
  name: 'Binance Spot',
  description: 'Monitor Binance spot prices and execute trades based on simple price thresholds',
  version: '1.0.0',
  author: 'BotLab',
  configSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        title: 'Trading Pair',
        description: 'Binance spot pair symbol (e.g., BTCUSDT, ETHUSDT)',
        default: 'BTCUSDT',
      },
      tradeAmountUsdt: {
        type: 'number',
        title: 'Trade Amount (USDT)',
        description: 'Amount in USDT per trade',
        default: 10,
        minimum: 1,
      },
      pollingIntervalMs: {
        type: 'number',
        title: 'Polling Interval (ms)',
        description: 'How often to check prices',
        default: 30000,
        minimum: 5000,
      },
    },
  },
};

export async function onStart(ctx) {
  const symbol = ctx.config.symbol || 'BTCUSDT';

  // Log initial state
  const price = await ctx.binance.getPrice(symbol);
  ctx.log.info(`Starting Binance Spot bot for ${symbol}`);
  ctx.log.info(`Current price: $${price.price.toFixed(2)}`);

  try {
    const balance = await ctx.binance.getBalance('USDT');
    ctx.log.info(`USDT balance: $${balance.toFixed(2)}`);
  } catch {
    ctx.log.warn('Could not fetch balance (credentials may not be configured)');
  }
}

// Called every tick — monitor prices and trade
export async function onTick(ctx) {
  const symbol = ctx.config.symbol || 'BTCUSDT';

  const current = await ctx.binance.getPrice(symbol);
  ctx.log.debug(`${symbol} price: $${current.price.toFixed(2)}`);

  // Emit price data as event for UI
  ctx.emit('price', {
    symbol,
    price: current.price,
    timestamp: ctx.now,
  });

  // Example: add your trading logic here
  // const result = await ctx.binance.buy(symbol, ctx.config.tradeAmountUsdt || 10);
  // ctx.log.info(`Buy result: ${JSON.stringify(result)}`);
}

export async function onStop(ctx) {
  ctx.log.info('Binance Spot bot stopped');
}

export function onHeartbeat(ctx) {
  return { status: 'monitoring' };
}
