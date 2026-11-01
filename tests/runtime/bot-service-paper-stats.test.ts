import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BotService } from '../../packages/core/src/services/BotService';

/**
 * Paper bot valuation (bot Overview, dashboard Bot Overview, Open Positions). A paper bot has two simulated
 * pots seeded with the same starting balance: Polymarket USDC (`balance`) and Binance (`binanceBalances`).
 * Both must count, priced at the current market.
 */

const ETH_PRICE = 2300;
const ETH_QTY = 0.0088;

function makeBotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bot-1',
    name: 'Paper Bot',
    script_id: 'script-1',
    wallet_id: 'wallet-1',
    config: JSON.stringify({ paperBalance: 100 }),
    status: 'running',
    enabled: 1,
    mode: 'paper',
    ...overrides,
  };
}

function position(symbol: string, exchange: string, netQuantity: number, totalCost: number) {
  return { symbol, exchange, market: null, outcome: null, netQuantity, totalCost, tradeCount: 1 };
}

function makeService(opts: {
  row?: Record<string, unknown>;
  paperState: unknown;
  positions: ReturnType<typeof position>[];
  binancePrice?: (symbol: string) => Promise<number>;
}) {
  const row = makeBotRow(opts.row);
  const binancePrice = opts.binancePrice ?? vi.fn(async (symbol: string) => (symbol === 'ETHUSDT' ? ETH_PRICE : Promise.reject(new Error(`no price for ${symbol}`))));
  const service = new BotService({
    botRepo: { findById: vi.fn().mockReturnValue(row), findAll: vi.fn().mockReturnValue([row]) } as any,
    walletRepo: { findById: vi.fn().mockReturnValue(null) } as any,
    scriptRepo: {} as any,
    tradeRepo: {
      getPositions: vi.fn().mockReturnValue(opts.positions),
      findByBotId: vi.fn().mockReturnValue([]),
      updateMarketInfo: vi.fn(),
    } as any,
    storageRepo: { get: vi.fn((_id: string, key: string) => (key === '__paper_state' ? opts.paperState : null)) } as any,
    settingsRepo: { get: vi.fn().mockReturnValue({}) } as any,
    botManager: () => null,
    walletManager: () => null,
    binancePrice,
  });
  return { service, binancePrice };
}

describe('BotService paper valuation', () => {
  beforeEach(() => {
    // Gamma: every Polymarket token is priced 0.6
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const tokenId = new URL(url).searchParams.get('clob_token_ids');
        return new Response(JSON.stringify([{ clobTokenIds: JSON.stringify([tokenId]), outcomePrices: JSON.stringify(['0.6']) }]));
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  describe('a bot trading on Binance', () => {
    const paperState = { balance: 100, positions: [], binanceBalances: { USDT: 80, ETH: ETH_QTY } };
    const positions = [position('ETHUSDT', 'binance', ETH_QTY, 20)];

    it('stats count the Binance USDT cash and the held asset at its price', async () => {
      const { service } = makeService({ paperState, positions });
      const stats = await service.stats('bot-1');
      expect(stats.cashBalance).toBeCloseTo(80);
      expect(stats.positionsValue).toBeCloseTo(ETH_QTY * ETH_PRICE);
      expect(stats.totalValue).toBeCloseTo(80 + ETH_QTY * ETH_PRICE);
      expect(stats.initialBalance).toBe(100);
      expect(stats.pnlAllTime).toBeCloseTo(80 + ETH_QTY * ETH_PRICE - 100);
    });

    it('dashboard stats value the bot the same way', async () => {
      const { service } = makeService({ paperState, positions });
      const [stat] = await service.dashboardStats();
      expect(stat.totalValue).toBeCloseTo(80 + ETH_QTY * ETH_PRICE);
      expect(stat.pnlAllTime).toBeCloseTo(80 + ETH_QTY * ETH_PRICE - 100);
      expect(stat.positionCount).toBe(1);
    });

    it('positions price the Binance row', async () => {
      const { service } = makeService({ paperState, positions });
      const [row] = await service.positions('bot-1');
      expect(row.currentPrice).toBe(ETH_PRICE);
      expect(row.currentValue).toBeCloseTo(ETH_QTY * ETH_PRICE);
    });

    it('a failed price leaves that asset out (cash still counts)', async () => {
      const { service } = makeService({ paperState, positions, binancePrice: vi.fn().mockRejectedValue(new Error('down')) });
      const stats = await service.stats('bot-1');
      expect(stats.cashBalance).toBeCloseTo(80);
      expect(stats.positionsValue).toBe(0);
      const [row] = await service.positions('bot-1');
      expect(row.currentPrice).toBeNull();
    });

    it('without paperBalance the Binance pot is measured against the default seed', async () => {
      const { service } = makeService({
        row: { config: '{}' },
        paperState: { balance: 10_000, positions: [], binanceBalances: { USDT: 9_980, ETH: ETH_QTY } },
        positions,
      });
      const stats = await service.stats('bot-1');
      expect(stats.cashBalance).toBeCloseTo(9_980);
      expect(stats.positionsValue).toBeCloseTo(ETH_QTY * ETH_PRICE);
      expect(stats.initialBalance).toBeNull();
      expect(stats.pnlAllTime).toBeNull();
    });
  });

  describe('a bot trading on Polymarket only', () => {
    const positions = [position('tok-1', 'polymarket', 50, 30)];

    it('is unchanged: Polymarket cash plus positions at the Gamma price, no Binance lookups', async () => {
      const { service, binancePrice } = makeService({
        paperState: { balance: 70, positions: [], binanceBalances: { USDT: 100 } },
        positions,
      });
      const stats = await service.stats('bot-1');
      expect(stats.cashBalance).toBeCloseTo(70);
      expect(stats.positionsValue).toBeCloseTo(30);
      expect(stats.pnlAllTime).toBeCloseTo(0);
      expect(binancePrice).not.toHaveBeenCalled();
    });

    it('a state saved before Binance balances existed is valued as before', async () => {
      const { service } = makeService({ paperState: { balance: 70, positions: [] }, positions });
      const stats = await service.stats('bot-1');
      expect(stats.cashBalance).toBeCloseTo(70);
      expect(stats.totalValue).toBeCloseTo(100);
    });
  });
});
