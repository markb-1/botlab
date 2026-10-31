/**
 * OrderCanceller — cancels a bot's open orders whether or not the bot is running
 * (halts, kill switch, startup orphan cleanup; spec §4.2, §4.3).
 *
 * Open orders come from the `orders` table. A running bot's own OrderService is used when
 * available (so cancels share its lock); otherwise a cancel-only OrderService is built for the
 * bot with an exchange adapter for its wallet. Paper orders are just marked cancelled.
 * Cancellation goes through OrderService.cancelAll, which also records fills that happened
 * before the cancel. Failures are reported, never thrown.
 */

import type Database from 'better-sqlite3';
import type { BotTradeRepository } from '../db/repositories/BotTradeRepository';
import type { OrderRepository } from '../db/repositories/OrderRepository';
import type { PolymarketAdapter } from './ExchangeAdapter';
import { OrderService, type OrderServiceDeps } from './OrderService';
import logger from '../utils/logger';

const ADAPTER_TIMEOUT_MS = 30_000;

export interface BotCancelResult {
  botId: string;
  cancelled: number;
  /** Orders still open after the attempt (exchange did not confirm, or no adapter) */
  failed: number;
  /** Orders without an exchange id (outcome unknown); they expire on their own */
  unknownOutcome: number;
  errors: string[];
}

export interface OrderCancellerDeps {
  db: Database.Database;
  orderRepo: OrderRepository;
  tradeRepo: BotTradeRepository;
  /** The running bot's OrderService for that mode, if any */
  getRunningService?: (botId: string, simulated: boolean) => OrderService | null;
  /** Authenticated Polymarket adapter for the bot's wallet (null/throw ⇒ live orders cannot be cancelled) */
  getPolymarketAdapter: (botId: string) => Promise<PolymarketAdapter | null>;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const cancelOnly = (): never => {
  throw new Error('cancel-only order service cannot place orders');
};

export class OrderCanceller {
  private deps: OrderCancellerDeps;
  /** Cancel-only services, cached per bot and mode so their per-bot lock is shared */
  private services = new Map<string, OrderService>();

  constructor(deps: OrderCancellerDeps) {
    this.deps = deps;
  }

  /**
   * A service that can only sync and cancel: the placement dependencies throw, and it is never
   * handed to a bot.
   */
  private async cancelOnlyService(botId: string, simulated: boolean): Promise<OrderService> {
    const key = `${botId}:${simulated ? 1 : 0}`;
    const cached = this.services.get(key);
    if (cached) return cached;

    let polymarket: PolymarketAdapter | null = null;
    if (!simulated) {
      polymarket = await withTimeout(this.deps.getPolymarketAdapter(botId), ADAPTER_TIMEOUT_MS, 'exchange client');
    }
    const deps = {
      db: this.deps.db,
      orderRepo: this.deps.orderRepo,
      tradeRepo: this.deps.tradeRepo,
      riskEngine: { check: cancelOnly, getConfig: cancelOnly },
      provider: { invalidateCash: () => {} },
      fees: { getRates: cancelOnly, feeCategoryFor: cancelOnly },
      marketData: { getMarketInfo: cancelOnly },
      quality: { get: cancelOnly },
      getBook: cancelOnly,
      getBinanceBook: cancelOnly,
    } as unknown as OrderServiceDeps;
    const svc = new OrderService(deps, {
      botId,
      botName: botId,
      scriptName: '',
      mode: simulated ? 'paper' : 'live',
      polymarket,
      binance: null,
      paperState: null,
    });
    if (simulated || polymarket) this.services.set(key, svc);
    return svc;
  }

  /**
   * Cancel all of a bot's open orders (live and paper). With `sync`, first pull each order's
   * state from the exchange (fills, cancels, expiry).
   */
  async cancelBot(botId: string, opts: { sync?: boolean } = {}): Promise<BotCancelResult> {
    const result: BotCancelResult = { botId, cancelled: 0, failed: 0, unknownOutcome: 0, errors: [] };
    for (const simulated of [false, true]) {
      if (this.deps.orderRepo.findOpen(botId, simulated).length === 0) continue;
      try {
        const svc = this.deps.getRunningService?.(botId, simulated) ?? (await this.cancelOnlyService(botId, simulated));
        if (opts.sync) await svc.syncOpenOrders();
        const r = await svc.cancelAll();
        result.cancelled += r.cancelled;
        result.failed += r.failed;
        result.unknownOutcome += r.unknownOutcome;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${simulated ? 'paper' : 'live'}: ${msg}`);
        const stillOpen = this.deps.orderRepo.findOpen(botId, simulated);
        result.failed += stillOpen.filter((o) => o.exchange_order_id).length;
        result.unknownOutcome += stillOpen.filter((o) => !o.exchange_order_id).length;
        logger.error(`[OrderCanceller] Could not cancel ${simulated ? 'paper' : 'live'} orders of bot ${botId}: ${msg}`);
      }
    }
    return result;
  }

  /** Cancel the open orders of every bot that has any (running or not). */
  async cancelAllBots(opts: { sync?: boolean; skip?: (botId: string) => boolean } = {}): Promise<BotCancelResult[]> {
    const ids = this.deps.orderRepo.findBotIdsWithOpenOrders().filter((id) => !opts.skip?.(id));
    return Promise.all(ids.map((id) => this.cancelBot(id, opts)));
  }
}
