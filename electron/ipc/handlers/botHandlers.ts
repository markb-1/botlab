import { ipcMain } from 'electron';
import type { BotRepository } from '../../database/repositories/BotRepository';
import type { WalletRepository } from '../../database/repositories/WalletRepository';
import type { ScriptRepository } from '../../database/repositories/ScriptRepository';
import type { BotTradeRepository } from '../../database/repositories/BotTradeRepository';
import type { BotStorageRepository } from '../../database/repositories/BotStorageRepository';
import type { SettingsRepository } from '../../database/repositories/SettingsRepository';
import type { BotManager } from '../../../src/core/BotManager';
import type { WalletManager } from '../../../src/core/WalletManager';
import type { IpcBot, IpcBotTrade } from '../types';
import logger from '../../../src/utils/logger';

// Module-level cache for token → market info resolution (static data)
const tokenInfoCache = new Map<string, { market: string; outcome: string }>();

/**
 * Resolve a Polymarket tokenId to its market title and outcome label.
 * Results are cached in-memory to avoid repeated API calls.
 */
async function resolveTokenInfo(tokenId: string): Promise<{ market: string; outcome: string } | null> {
  const cached = tokenInfoCache.get(tokenId);
  if (cached) return cached;

  try {
    const resp = await fetch(
      `https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`
    );
    if (!resp.ok) return null;
    const markets = await resp.json();
    if (!Array.isArray(markets) || markets.length === 0) return null;

    const mkt = markets[0];
    let outcomeLabel = '';
    try {
      const tokenIds: string[] = typeof mkt.clobTokenIds === 'string'
        ? JSON.parse(mkt.clobTokenIds)
        : (mkt.clobTokenIds || []);
      const outcomes: string[] = typeof mkt.outcomes === 'string'
        ? JSON.parse(mkt.outcomes)
        : (mkt.outcomes || []);
      const tokenIndex = tokenIds.indexOf(tokenId);
      outcomeLabel = tokenIndex >= 0 && outcomes[tokenIndex] ? outcomes[tokenIndex] : outcomes[0] || '';
    } catch {
      outcomeLabel = '';
    }

    const info = { market: mkt.question || mkt.title || '', outcome: outcomeLabel };
    if (info.market) {
      tokenInfoCache.set(tokenId, info);
    }
    return info;
  } catch {
    return null;
  }
}

/**
 * Fetch the current price for a Polymarket tokenId from the Gamma API.
 * Prices are NOT cached since they change frequently.
 */
async function fetchCurrentPrice(tokenId: string): Promise<number | null> {
  try {
    const resp = await fetch(
      `https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`
    );
    if (!resp.ok) return null;
    const markets = await resp.json();
    if (!Array.isArray(markets) || markets.length === 0) return null;

    const mkt = markets[0];
    const tokenIds: string[] = typeof mkt.clobTokenIds === 'string'
      ? JSON.parse(mkt.clobTokenIds)
      : (mkt.clobTokenIds || []);
    const prices: string[] = typeof mkt.outcomePrices === 'string'
      ? JSON.parse(mkt.outcomePrices)
      : (mkt.outcomePrices || []);
    const tokenIndex = tokenIds.indexOf(tokenId);
    if (tokenIndex >= 0 && prices[tokenIndex]) {
      return parseFloat(prices[tokenIndex]);
    }
    return prices[0] ? parseFloat(prices[0]) : null;
  } catch {
    return null;
  }
}

/** Polymarket Data API position response */
interface PolymarketPosition {
  asset: string;
  conditionId: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  curPrice: number;
  cashPnl: number;
  percentPnl: number;
  redeemable?: boolean;
  title?: string;
  outcome?: string;
}

/**
 * Fetch live positions directly from the Polymarket Data API.
 * Public endpoint — no auth required, just the wallet address.
 * Only returns open positions (size > 0).
 */
async function fetchLivePositions(address: string): Promise<PolymarketPosition[]> {
  const allPositions: PolymarketPosition[] = [];
  const limit = 500;
  let offset = 0;

  try {
    while (offset < 5000) {
      const resp = await fetch(
        `https://data-api.polymarket.com/positions?user=${address}&sizeThreshold=0.01&limit=${limit}&offset=${offset}`
      );
      if (!resp.ok) break;
      const positions = await resp.json();
      if (!Array.isArray(positions) || positions.length === 0) break;

      allPositions.push(...positions);
      if (positions.length < limit) break;
      offset += limit;
    }
  } catch (err) {
    logger.error(`Failed to fetch live positions for ${address}: ${err}`);
  }

  return allPositions;
}

function botRowToIpc(
  row: any,
  walletRepo: WalletRepository,
  scriptRepo: ScriptRepository
): IpcBot {
  const wallet = walletRepo.findById(row.wallet_id);
  const script = scriptRepo.findById(row.script_id);

  return {
    id: row.id,
    name: row.name,
    scriptId: row.script_id,
    scriptName: script?.name || 'Unknown',
    walletId: row.wallet_id,
    walletAddress: wallet?.address,
    config: JSON.parse(row.config || '{}'),
    status: row.status,
    enabled: row.enabled === 1,
    mode: (row.mode as 'live' | 'paper') || 'live',
    lastStartedAt: row.last_started_at,
    lastStoppedAt: row.last_stopped_at,
    lastHeartbeat: row.last_heartbeat,
    errorLogs: JSON.parse(row.error_logs || '[]'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function tradeRowToIpc(row: any): IpcBotTrade {
  return {
    id: row.id,
    botId: row.bot_id,
    botName: row.bot_name,
    scriptName: row.script_name,
    traderAddress: row.trader_address,
    market: row.market,
    outcome: row.outcome,
    side: row.side,
    traderBetSize: row.trader_bet_size,
    botBetSize: row.bot_bet_size,
    executedAt: row.executed_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    exchange: row.exchange,
    symbol: row.symbol,
    price: row.price,
    quantity: row.quantity,
    quoteAmount: row.quote_amount,
    simulated: row.simulated,
  };
}

export function registerBotHandlers(
  botRepo: BotRepository,
  walletRepo: WalletRepository,
  scriptRepo: ScriptRepository,
  tradeRepo: BotTradeRepository,
  botManager: BotManager,
  walletManager: WalletManager,
  storageRepo: BotStorageRepository,
  settingsRepo: SettingsRepository
): void {
  // List all bots
  ipcMain.handle('bots:list', async (_event, filter?: { scriptId?: string; status?: string }) => {
    try {
      const rows = botRepo.findAll({
        scriptId: filter?.scriptId,
        status: filter?.status,
      });
      return {
        success: true,
        data: rows.map((row) => botRowToIpc(row, walletRepo, scriptRepo)),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get single bot
  ipcMain.handle('bots:get', async (_event, id: string) => {
    try {
      const row = botRepo.findById(id);
      if (!row) return { success: false, error: 'Bot not found' };
      return {
        success: true,
        data: botRowToIpc(row, walletRepo, scriptRepo),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Create bot
  ipcMain.handle('bots:create', async (_event, data: {
    name: string;
    scriptId: string;
    walletId?: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
    mode?: 'live' | 'paper';
  }) => {
    try {
      let walletId = data.walletId;

      // Auto-generate a throwaway wallet for paper bots
      if (data.mode === 'paper' && !walletId) {
        const paperWallet = await walletManager.createPaperWallet(data.name);
        walletId = paperWallet.id;
      }

      if (!walletId) {
        return { success: false, error: 'Wallet is required for live bots' };
      }

      const row = botRepo.create({
        name: data.name,
        scriptId: data.scriptId,
        walletId,
        config: data.config,
        enabled: data.enabled,
        mode: data.mode,
      });
      return {
        success: true,
        data: botRowToIpc(row, walletRepo, scriptRepo),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Update bot
  ipcMain.handle('bots:update', async (_event, id: string, data: {
    name?: string;
    scriptId?: string;
    walletId?: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  }) => {
    try {
      const row = botRepo.update(id, data);
      if (!row) return { success: false, error: 'Bot not found' };
      return {
        success: true,
        data: botRowToIpc(row, walletRepo, scriptRepo),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Delete bot
  ipcMain.handle('bots:delete', async (_event, id: string) => {
    try {
      // Check if the bot has a paper wallet that should be cleaned up
      const botRow = botRepo.findById(id);
      const paperWalletId = botRow?.wallet_id;
      const wallet = paperWalletId ? walletRepo.findById(paperWalletId) : undefined;
      const isPaperWallet = wallet?.is_paper === 1;

      const deleted = botRepo.delete(id);
      if (!deleted) return { success: false, error: 'Bot not found or cannot be deleted (must be stopped)' };

      // Clean up auto-generated paper wallet
      if (isPaperWallet && paperWalletId) {
        await walletManager.deletePaperWallet(paperWalletId);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Start bot
  ipcMain.handle('bots:start', async (_event, id: string) => {
    try {
      await botManager.startBot(id);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Stop bot
  ipcMain.handle('bots:stop', async (_event, id: string) => {
    try {
      await botManager.stopBot(id);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Restart bot
  ipcMain.handle('bots:restart', async (_event, id: string) => {
    try {
      await botManager.restartBot(id);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get trades for a bot
  // Resolves missing market names from the Polymarket API and backfills the database
  ipcMain.handle('bots:trades', async (_event, botId: string, hours?: number) => {
    try {
      const rows = tradeRepo.findByBotId(botId, hours ? { hoursAgo: hours } : undefined);
      const trades = rows.map(tradeRowToIpc);

      // Resolve missing market names for polymarket trades
      const unresolvedSymbols = new Set<string>();
      for (const trade of trades) {
        if (!trade.market && trade.exchange === 'polymarket' && trade.symbol) {
          unresolvedSymbols.add(trade.symbol);
        }
      }

      // Resolve each unique symbol once, then apply to all trades
      const resolved = new Map<string, { market: string; outcome: string }>();
      for (const symbol of unresolvedSymbols) {
        try {
          const info = await resolveTokenInfo(symbol);
          if (info && info.market) {
            resolved.set(symbol, info);
            // Backfill database
            tradeRepo.updateMarketInfo(symbol, info.market, info.outcome);
          }
        } catch { /* ignore */ }
      }

      // Apply resolved info to trades
      for (const trade of trades) {
        if (!trade.market && trade.symbol && resolved.has(trade.symbol)) {
          const info = resolved.get(trade.symbol)!;
          trade.market = info.market;
          trade.outcome = info.outcome;
        }
      }

      return { success: true, data: trades };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get positions for a bot
  // Live mode: fetches directly from Polymarket Data API (source of truth)
  // Paper mode: computes from trade history + Gamma API prices
  ipcMain.handle('bots:positions', async (_event, botId: string) => {
    try {
      const botRow = botRepo.findById(botId);
      if (!botRow) return { success: false, error: 'Bot not found' };

      const mode = (botRow.mode as 'live' | 'paper') || 'live';

      if (mode === 'live') {
        // Live mode: fetch real positions from Polymarket Data API
        const wallet = walletRepo.findById(botRow.wallet_id);
        if (!wallet) return { success: true, data: [] };

        const address = wallet.proxy_address || wallet.address;
        const livePositions = await fetchLivePositions(address);

        const positions = livePositions.map((p) => ({
          symbol: p.asset,
          exchange: 'polymarket' as const,
          market: p.title || null,
          outcome: p.outcome || null,
          netQuantity: p.size,
          totalCost: p.initialValue,
          tradeCount: 0,
          currentPrice: p.curPrice,
          currentValue: p.currentValue,
        }));

        return { success: true, data: positions };
      }

      // Paper mode: compute from trade history (existing logic)
      const rawPositions = tradeRepo.getPositions(botId);
      const positions = [];
      for (const pos of rawPositions) {
        let currentPrice: number | null = null;

        if (pos.exchange === 'polymarket' && pos.symbol) {
          if (!pos.market) {
            try {
              const info = await resolveTokenInfo(pos.symbol);
              if (info && info.market) {
                pos.market = info.market;
                pos.outcome = info.outcome;
                tradeRepo.updateMarketInfo(pos.symbol, info.market, info.outcome);
              }
            } catch (err) {
              logger.error(`Failed to resolve token ${pos.symbol}: ${err}`);
            }
          }

          try {
            currentPrice = await fetchCurrentPrice(pos.symbol);
          } catch (err) {
            logger.error(`Failed to fetch price for ${pos.symbol}: ${err}`);
          }
        }

        const currentValue = currentPrice != null ? pos.netQuantity * currentPrice : null;
        positions.push({ ...pos, currentPrice, currentValue });
      }

      return { success: true, data: positions };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get bot stats (cash balance, positions value, P&L)
  ipcMain.handle('bots:stats', async (_event, botId: string) => {
    try {
      const botRow = botRepo.findById(botId);
      if (!botRow) return { success: false, error: 'Bot not found' };

      const config = JSON.parse(botRow.config || '{}');
      const mode = (botRow.mode as 'live' | 'paper') || 'live';
      let cashBalance = 0;
      let positionsValue = 0;
      let initialBalance: number | null = null;
      let pnlAllTime: number | null = null;

      if (mode === 'paper') {
        // Paper mode: read state from bot_storage
        const paperState = storageRepo.get(botId, '__paper_state') as {
          balance?: number;
          positions?: Array<{ tokenId: string; size: number; avgPrice: number }>;
          binanceBalances?: Record<string, number>;
        } | null;

        cashBalance = paperState?.balance ?? (config.paperBalance ? Number(config.paperBalance) : 0);
        initialBalance = config.paperBalance ? Number(config.paperBalance) : null;

        // Paper positions value from trade history + Gamma API prices
        const rawPositions = tradeRepo.getPositions(botId);
        for (const pos of rawPositions) {
          if (pos.exchange === 'polymarket' && pos.symbol) {
            try {
              const price = await fetchCurrentPrice(pos.symbol);
              if (price != null) {
                positionsValue += pos.netQuantity * price;
              }
            } catch { /* ignore */ }
          }
        }

        const totalValue = cashBalance + positionsValue;
        pnlAllTime = initialBalance != null ? totalValue - initialBalance : null;
      } else {
        // Live mode: fetch real wallet USDC balance + Polymarket positions
        const wallet = walletRepo.findById(botRow.wallet_id);
        if (wallet) {
          const balanceAddress = wallet.proxy_address || wallet.address;

          // Cash balance from on-chain
          try {
            const settings = settingsRepo.get();
            const getMyBalanceMod = await import('../../../src/utils/getMyBalance');
            cashBalance = await getMyBalanceMod.default(balanceAddress, settings.rpc_url, settings.usdc_contract_address);
          } catch (err) {
            logger.error(`Failed to fetch live balance for bot ${botId}: ${err}`);
          }

          // Positions value from Polymarket Data API
          try {
            const livePositions = await fetchLivePositions(balanceAddress);
            positionsValue = livePositions.reduce((sum, p) => sum + (p.currentValue || 0), 0);
            // All-time P&L from Polymarket Data API
            const totalPnl = livePositions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
            pnlAllTime = totalPnl;
          } catch (err) {
            logger.error(`Failed to fetch live positions for stats: ${err}`);
          }
        }
      }

      const totalValue = cashBalance + positionsValue;

      // 24h P&L: realized trades in last 24 hours
      const recentTrades = tradeRepo.findByBotId(botId, { hoursAgo: 24 });
      let pnl24h = 0;
      for (const trade of recentTrades) {
        const amount = trade.quote_amount ?? 0;
        if (trade.side === 'SELL') {
          pnl24h += amount;
        } else if (trade.side === 'BUY') {
          pnl24h -= amount;
        }
      }

      return {
        success: true,
        data: {
          cashBalance,
          positionsValue,
          totalValue,
          initialBalance,
          pnlAllTime,
          pnl24h,
          mode,
        },
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get dashboard stats for all bots (batch endpoint)
  // Returns totalValue, positionCount, and P&L per bot, fetched concurrently
  ipcMain.handle('bots:dashboard-stats', async () => {
    try {
      const rows = botRepo.findAll({});
      const settings = settingsRepo.get();

      const results = await Promise.allSettled(
        rows.map(async (botRow) => {
          const mode = (botRow.mode as 'live' | 'paper') || 'live';
          let totalValue = 0;
          let positionCount = 0;
          let pnlAllTime: number | null = null;

          try {
            if (mode === 'paper') {
              const config = JSON.parse(botRow.config || '{}');
              const paperState = storageRepo.get(botRow.id, '__paper_state') as {
                balance?: number;
                positions?: Array<{ tokenId: string; size: number; avgPrice: number }>;
              } | null;

              const cashBalance = paperState?.balance ?? (config.paperBalance ? Number(config.paperBalance) : 0);
              const initialBalance = config.paperBalance ? Number(config.paperBalance) : null;
              let positionsValue = 0;

              const rawPositions = tradeRepo.getPositions(botRow.id);
              positionCount = rawPositions.length;

              // Fetch prices concurrently for paper positions
              const priceResults = await Promise.allSettled(
                rawPositions
                  .filter((p) => p.exchange === 'polymarket' && p.symbol)
                  .map(async (pos) => {
                    const price = await fetchCurrentPrice(pos.symbol);
                    return { netQuantity: pos.netQuantity, price };
                  })
              );
              for (const pr of priceResults) {
                if (pr.status === 'fulfilled' && pr.value.price != null) {
                  positionsValue += pr.value.netQuantity * pr.value.price;
                }
              }

              totalValue = cashBalance + positionsValue;
              pnlAllTime = initialBalance != null ? totalValue - initialBalance : null;
            } else {
              // Live mode
              const wallet = walletRepo.findById(botRow.wallet_id);
              if (wallet) {
                const balanceAddress = wallet.proxy_address || wallet.address;
                let cashBalance = 0;

                try {
                  const getMyBalanceMod = await import('../../../src/utils/getMyBalance');
                  cashBalance = await getMyBalanceMod.default(balanceAddress, settings.rpc_url, settings.usdc_contract_address);
                } catch { /* ignore */ }

                let positionsValue = 0;
                try {
                  const livePositions = await fetchLivePositions(balanceAddress);
                  positionCount = livePositions.length;
                  positionsValue = livePositions.reduce((sum, p) => sum + (p.currentValue || 0), 0);
                  pnlAllTime = livePositions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
                } catch { /* ignore */ }

                totalValue = cashBalance + positionsValue;
              }
            }
          } catch (err) {
            logger.error(`Dashboard stats error for bot ${botRow.id}: ${err}`);
          }

          // 24h P&L: realized trades in last 24 hours
          let pnl24h = 0;
          try {
            const recentTrades = tradeRepo.findByBotId(botRow.id, { hoursAgo: 24 });
            for (const trade of recentTrades) {
              const amount = trade.quote_amount ?? 0;
              if (trade.side === 'SELL') {
                pnl24h += amount;
              } else if (trade.side === 'BUY') {
                pnl24h -= amount;
              }
            }
          } catch { /* ignore */ }

          return {
            botId: botRow.id,
            totalValue,
            positionCount,
            pnlAllTime,
            pnl24h,
          };
        })
      );

      const stats = results
        .filter((r): r is PromiseFulfilledResult<{
          botId: string;
          totalValue: number;
          positionCount: number;
          pnlAllTime: number | null;
          pnl24h: number;
        }> => r.status === 'fulfilled')
        .map((r) => r.value);

      return { success: true, data: stats };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get all recent trades
  ipcMain.handle('bots:trades:all', async (_event, hours?: number) => {
    try {
      const rows = tradeRepo.findRecent(hours || 24);
      return {
        success: true,
        data: rows.map(tradeRowToIpc),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
