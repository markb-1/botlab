/**
 * BotService — bot CRUD, lifecycle and the stats / positions / trades views (moved out of the
 * Electron `botHandlers`, spec §1.1). Transport-free: IPC today, HTTP + MCP in 3b.
 *
 * Starting, stopping and wallet operations need the unlocked BotManager / WalletManager; before
 * unlock those calls throw `ServiceError('locked')`.
 */

import type { BotRepository } from '../db/repositories/BotRepository';
import type { WalletRepository } from '../db/repositories/WalletRepository';
import type { ScriptRepository } from '../db/repositories/ScriptRepository';
import type { OrderRepository } from '../db/repositories/OrderRepository';
import type { BotTradeRepository } from '../db/repositories/BotTradeRepository';
import type { BotStorageRepository } from '../db/repositories/BotStorageRepository';
import type { SettingsRepository } from '../db/repositories/SettingsRepository';
import type { BotManager } from '../bots/BotManager';
import type { WalletManager } from '../bots/WalletManager';
import type { IpcBot, IpcBotTrade } from './types';
import type { AuditService } from '../audit/AuditService';
import { auditActorOf, requireActor, type Actor } from './actors';
import { initialStage, lowerStage } from '../risk/ramp';
import type { BotStage } from '../risk/types';
import logger from '../utils/logger';
import { ServiceError, conflict, notFound } from './errors';
import type { BotCreateInput, BotUpdateInput } from './schemas';

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
    stage: row.stage,
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

/**
 * A bot may not change wallets while it has open live orders or live positions (2b review): its orders and
 * fills stay attributed to the wallet they were made on, and the reconciler compares per wallet.
 */
export function walletChangeBlocker(
  botId: string,
  tradeRepo: Pick<BotTradeRepository, 'getRiskPositions'>,
  orderRepo?: Pick<OrderRepository, 'findOpen'>
): string | null {
  if (!orderRepo) return 'Cannot change the wallet: order store unavailable';
  const open = orderRepo.findOpen(botId, false).length;
  const positions = tradeRepo.getRiskPositions({ simulated: false, botId }).filter((p) => p.net_quantity > 1e-9).length;
  if (open === 0 && positions === 0) return null;
  return `Cannot change the wallet of a bot with ${open} open live order(s) and ${positions} live position(s); cancel the orders and close the positions first`;
}


/** A bot's position as shown in the UI (live: Data API; paper: trade history + Gamma price) */
export interface BotPositionView {
  symbol: string;
  exchange: string;
  market: string | null;
  outcome: string | null;
  netQuantity: number;
  totalCost: number;
  tradeCount: number;
  currentPrice: number | null;
  currentValue: number | null;
}

export interface BotStatsView {
  cashBalance: number;
  positionsValue: number;
  totalValue: number;
  initialBalance: number | null;
  pnlAllTime: number | null;
  pnl24h: number;
  mode: 'live' | 'paper';
}

export interface BotDashboardStat {
  botId: string;
  totalValue: number;
  positionCount: number;
  pnlAllTime: number | null;
  pnl24h: number;
}

export interface BotServiceDeps {
  botRepo: BotRepository;
  walletRepo: WalletRepository;
  scriptRepo: ScriptRepository;
  tradeRepo: BotTradeRepository;
  storageRepo: BotStorageRepository;
  settingsRepo: SettingsRepository;
  audit?: AuditService;
  orderRepo?: Pick<OrderRepository, 'findOpen'>;
  /** The BotManager once the core is unlocked, else null */
  botManager: () => Pick<BotManager, 'startBot' | 'stopBot' | 'restartBot'> | null;
  /** The WalletManager once the core is unlocked, else null */
  walletManager: () => Pick<WalletManager, 'createPaperWallet' | 'deletePaperWallet'> | null;
}

/** 24h P&L: realized trades in the last 24 hours (sells − buys) */
function pnl24hFor(tradeRepo: BotTradeRepository, botId: string): number {
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
  return pnl24h;
}

export class BotService {
  constructor(private deps: BotServiceDeps) {}

  private manager() {
    const m = this.deps.botManager();
    if (!m) throw new ServiceError('locked', 'App is locked: unlock BotLab first');
    return m;
  }

  private wallets() {
    const w = this.deps.walletManager();
    if (!w) throw new ServiceError('locked', 'App is locked: unlock BotLab first');
    return w;
  }

  private toView(row: Parameters<typeof botRowToIpc>[0]): IpcBot {
    return botRowToIpc(row, this.deps.walletRepo, this.deps.scriptRepo);
  }

  list(filter?: { scriptId?: string; status?: string }): IpcBot[] {
    const rows = this.deps.botRepo.findAll({
      scriptId: filter?.scriptId,
      status: filter?.status,
    });
    return rows.map((row) => this.toView(row));
  }

  get(id: string): IpcBot {
    const row = this.deps.botRepo.findById(id);
    if (!row) throw notFound('Bot not found');
    return this.toView(row);
  }

  async create(data: BotCreateInput, by: Actor): Promise<IpcBot> {
    const actor = auditActorOf(requireActor(by, ['human', 'agent'], 'bots.create'));
    const { botRepo, scriptRepo, audit } = this.deps;
    let walletId = data.walletId;
    // Live is never implied (3b, spec §15.2): a bot created without a mode is a paper bot
    const mode = data.mode ?? 'paper';

    // Auto-generate a throwaway wallet for paper bots
    if (mode === 'paper' && !walletId) {
      const paperWallet = await this.wallets().createPaperWallet(data.name);
      walletId = paperWallet.id;
    }

    if (!walletId) {
      throw new ServiceError('invalid_input', 'Wallet is required for live bots');
    }

    // Ramp (spec §4.5): new template ⇒ paper, proven template ⇒ probation
    const script = scriptRepo.findById(data.scriptId);
    const stage = initialStage(script?.trust);
    const row = botRepo.create({
      name: data.name,
      scriptId: data.scriptId,
      walletId,
      config: data.config,
      enabled: data.enabled,
      mode,
      stage,
      templateVersion: script?.revision ?? null,
    });
    audit?.record(actor, 'bot.create', row.id, {
      name: data.name,
      scriptId: data.scriptId,
      templateVersion: script?.revision ?? null,
      trust: script?.trust ?? null,
      mode,
      stage,
    });
    return this.toView(row);
  }

  update(id: string, data: BotUpdateInput, by: Actor): IpcBot {
    const actor = auditActorOf(requireActor(by, ['human', 'agent'], 'bots.update'));
    const { botRepo, scriptRepo, tradeRepo, orderRepo, audit } = this.deps;
    const before = botRepo.findById(id);
    if (!before) throw notFound('Bot not found');
    if (data.walletId !== undefined && data.walletId !== before.wallet_id) {
      const blocked = walletChangeBlocker(id, tradeRepo, orderRepo);
      if (blocked) {
        audit?.record(actor, 'bot.update', id, { walletId: { from: before.wallet_id, to: data.walletId } }, `denied: ${blocked}`);
        throw conflict(blocked);
      }
    }
    const row = botRepo.update(id, data);
    if (!row) throw notFound('Bot not found');
    audit?.record(actor, 'bot.update', id, {
      fields: Object.keys(data),
      ...(data.scriptId !== undefined && data.scriptId !== before.script_id ? { scriptId: { from: before.script_id, to: data.scriptId } } : {}),
      ...(data.walletId !== undefined && data.walletId !== before.wallet_id ? { walletId: { from: before.wallet_id, to: data.walletId } } : {}),
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
    });
    // Switching to another script can only lower the stage (the new code must earn trust)
    if (data.scriptId !== undefined && data.scriptId !== before.script_id) {
      const script = scriptRepo.findById(data.scriptId);
      const from = (row.stage || 'full') as BotStage;
      const to = lowerStage(from, initialStage(script?.trust));
      if (to !== from) {
        botRepo.setStage(id, to);
        audit?.record('system', 'bot.stage', id, { from, to, reason: `script changed to ${data.scriptId} (trust ${script?.trust ?? 'unknown'})` });
      }
      botRepo.setTemplateVersion(id, script?.revision ?? null);
    }
    const fresh = botRepo.findById(id) ?? row;
    return this.toView(fresh);
  }

  async delete(id: string, by: Actor): Promise<void> {
    const actor = auditActorOf(requireActor(by, ['human', 'agent'], 'bots.delete'));
    const { botRepo, walletRepo, audit } = this.deps;
    // Check if the bot has a paper wallet that should be cleaned up
    const botRow = botRepo.findById(id);
    const paperWalletId = botRow?.wallet_id;
    const wallet = paperWalletId ? walletRepo.findById(paperWalletId) : undefined;
    const isPaperWallet = wallet?.is_paper === 1;

    const deleted = botRepo.delete(id);
    if (!deleted) throw conflict('Bot not found or cannot be deleted (must be stopped)');
    audit?.record(actor, 'bot.delete', id, { name: botRow?.name, scriptId: botRow?.script_id, stage: botRow?.stage });

    // Clean up auto-generated paper wallet
    if (isPaperWallet && paperWalletId) {
      await this.wallets().deletePaperWallet(paperWalletId);
    }
  }

  async start(id: string, by: Actor): Promise<void> {
    await this.manager().startBot(id, auditActorOf(requireActor(by, ['human', 'agent', 'system'], 'bots.start')));
  }

  async stop(id: string, by: Actor): Promise<void> {
    await this.manager().stopBot(id, auditActorOf(requireActor(by, ['human', 'agent', 'system'], 'bots.stop')));
  }

  async restart(id: string, by: Actor): Promise<void> {
    await this.manager().restartBot(id, auditActorOf(requireActor(by, ['human', 'agent', 'system'], 'bots.restart')));
  }

  /** A bot's trades; resolves missing market names from the Polymarket API and backfills the database */
  async trades(botId: string, hours?: number | null): Promise<IpcBotTrade[]> {
    const { tradeRepo } = this.deps;
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
      } catch {
        /* ignore */
      }
    }

    // Apply resolved info to trades
    for (const trade of trades) {
      if (!trade.market && trade.symbol && resolved.has(trade.symbol)) {
        const info = resolved.get(trade.symbol)!;
        trade.market = info.market;
        trade.outcome = info.outcome;
      }
    }

    return trades;
  }

  /** Recent trades of all bots (default 24 h) */
  allTrades(hours?: number | null): IpcBotTrade[] {
    const rows = this.deps.tradeRepo.findRecent(hours || 24);
    return rows.map(tradeRowToIpc);
  }

  /**
   * A bot's positions. Live mode: fetched from the Polymarket Data API (source of truth).
   * Paper mode: computed from trade history + Gamma API prices.
   */
  async positions(botId: string): Promise<BotPositionView[]> {
    const { botRepo, walletRepo, tradeRepo } = this.deps;
    const botRow = botRepo.findById(botId);
    if (!botRow) throw notFound('Bot not found');

    const mode = (botRow.mode as 'live' | 'paper') || 'live';

    if (mode === 'live') {
      // Live mode: fetch real positions from Polymarket Data API
      const wallet = walletRepo.findById(botRow.wallet_id);
      if (!wallet) return [];

      const address = wallet.proxy_address || wallet.address;
      const livePositions = await fetchLivePositions(address);

      return livePositions.map((p) => ({
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
    }

    // Paper mode: compute from trade history (existing logic)
    const rawPositions = tradeRepo.getPositions(botId);
    const positions: BotPositionView[] = [];
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

    return positions;
  }

  /** Cash balance, positions value and P&L of one bot */
  async stats(botId: string): Promise<BotStatsView> {
    const { botRepo, walletRepo, tradeRepo, storageRepo, settingsRepo } = this.deps;
    const botRow = botRepo.findById(botId);
    if (!botRow) throw notFound('Bot not found');

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
          } catch {
            /* ignore */
          }
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
          const getMyBalanceMod = await import('../utils/getMyBalance');
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
    const pnl24h = pnl24hFor(tradeRepo, botId);

    return {
      cashBalance,
      positionsValue,
      totalValue,
      initialBalance,
      pnlAllTime,
      pnl24h,
      mode,
    };
  }

  /** Dashboard stats for all bots: totalValue, positionCount and P&L per bot, fetched concurrently */
  async dashboardStats(): Promise<BotDashboardStat[]> {
    const { botRepo, walletRepo, tradeRepo, storageRepo, settingsRepo } = this.deps;
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
                const getMyBalanceMod = await import('../utils/getMyBalance');
                cashBalance = await getMyBalanceMod.default(balanceAddress, settings.rpc_url, settings.usdc_contract_address);
              } catch {
                /* ignore */
              }

              let positionsValue = 0;
              try {
                const livePositions = await fetchLivePositions(balanceAddress);
                positionCount = livePositions.length;
                positionsValue = livePositions.reduce((sum, p) => sum + (p.currentValue || 0), 0);
                pnlAllTime = livePositions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
              } catch {
                /* ignore */
              }

              totalValue = cashBalance + positionsValue;
            }
          }
        } catch (err) {
          logger.error(`Dashboard stats error for bot ${botRow.id}: ${err}`);
        }

        // 24h P&L: realized trades in last 24 hours
        let pnl24h = 0;
        try {
          pnl24h = pnl24hFor(tradeRepo, botRow.id);
        } catch {
          /* ignore */
        }

        return {
          botId: botRow.id,
          totalValue,
          positionCount,
          pnlAllTime,
          pnl24h,
        };
      })
    );

    return results.filter((r): r is PromiseFulfilledResult<BotDashboardStat> => r.status === 'fulfilled').map((r) => r.value);
  }
}
