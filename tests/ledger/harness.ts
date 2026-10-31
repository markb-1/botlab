/**
 * In-memory DB + fake Gamma/CLOB for market cache and ledger tests.
 */

import { vi } from 'vitest';
import { openTestDb, type TestDb } from '../orders/db';
import { MarketCacheRepository } from '../../electron/database/repositories/MarketCacheRepository';
import { ForecastRepository } from '../../electron/database/repositories/ForecastRepository';
import { CategoryRightsRepository } from '../../electron/database/repositories/CategoryRightsRepository';
import { AuditRepository } from '../../electron/database/repositories/AuditRepository';
import { AuditService } from '../../electron/audit/AuditService';
import { MarketCacheService } from '../../electron/ledger/MarketCacheService';
import { LedgerService } from '../../electron/ledger/LedgerService';
import { defaultCategories, MandateSchema, type MandateConfig } from '../../electron/config';
import { FeeService } from '../../electron/orders/FeeService';

export const DAY = 86_400_000;
export const T0 = Date.parse('2026-10-01T00:00:00Z');

export interface GammaMarket {
  conditionId: string;
  question: string;
  description?: string;
  resolutionSource?: string;
  clobTokenIds: string;
  outcomes: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  outcomePrices?: string;
  liquidityNum?: number;
  volume24hr?: number;
  umaResolutionStatus?: string;
  tags?: Array<{ slug: string; label: string }>;
  events?: Array<{ id: string; title: string; tags?: Array<{ slug: string; label: string }> }>;
  [k: string]: unknown;
}

export function gammaMarket(id: string, o: Partial<GammaMarket> = {}): GammaMarket {
  return {
    conditionId: id,
    question: `Will CPI exceed 3% (${id})?`,
    description: `This market resolves YES if CPI (${id}) exceeds 3%.`,
    resolutionSource: 'https://www.bls.gov',
    clobTokenIds: JSON.stringify([`${id}-yes`, `${id}-no`]),
    outcomes: '["Yes","No"]',
    endDate: new Date(T0 + 5 * DAY).toISOString(),
    active: true,
    closed: false,
    outcomePrices: '["0.5","0.5"]',
    liquidityNum: 20_000,
    volume24hr: 10_000,
    tags: [{ slug: 'economy', label: 'Economy' }],
    events: [{ id: `ev-${id}`, title: `CPI ${id}` }],
    ...o,
  };
}

export interface LedgerHarness extends TestDb {
  clock: { now: number };
  gamma: Map<string, GammaMarket>;
  gammaDown: { value: boolean };
  fetchFn: ReturnType<typeof vi.fn>;
  books: Map<string, { bestBid: number | null; bestAsk: number | null }>;
  mids: Map<string, number>;
  mandate: { value: MandateConfig | null };
  marketRepo: MarketCacheRepository;
  forecastRepo: ForecastRepository;
  rightsRepo: CategoryRightsRepository;
  auditRepo: AuditRepository;
  audit: AuditService;
  cache: MarketCacheService;
  ledger: LedgerService;
  auditActions(action: string): Array<{ target: string | null; payload: Record<string, unknown>; actor: string }>;
}

export function openLedgerHarness(): LedgerHarness {
  const t = openTestDb();
  const clock = { now: T0 };
  const gamma = new Map<string, GammaMarket>();
  const gammaDown = { value: false };
  const fetchFn = vi.fn(async (url: string) => {
    if (gammaDown.value) throw new Error('network down');
    const u = new URL(url);
    const byCondition = u.searchParams.getAll('condition_ids');
    const byToken = u.searchParams.getAll('clob_token_ids');
    const list = [...gamma.values()].filter(
      (m) => byCondition.includes(m.conditionId) || (JSON.parse(m.clobTokenIds) as string[]).some((tok) => byToken.includes(tok))
    );
    return { ok: true, status: 200, json: async () => structuredClone(list) } as unknown as Response;
  });
  const books = new Map<string, { bestBid: number | null; bestAsk: number | null }>();
  const mids = new Map<string, number>();
  const mandate = { value: MandateSchema.parse({}) as MandateConfig | null };
  const marketRepo = new MarketCacheRepository(t.db);
  const forecastRepo = new ForecastRepository(t.db);
  const rightsRepo = new CategoryRightsRepository(t.db);
  const auditRepo = new AuditRepository(t.db);
  const audit = new AuditService(auditRepo);
  const fees = new FeeService();
  const cache = new MarketCacheService({
    repo: marketRepo,
    getCategories: () => defaultCategories(),
    feeCategoryFor: (l) => fees.feeCategoryFor(l),
    audit,
    heldBy: (marketId) => [
      ...new Set(t.tradeRepo.getRiskPositions({ simulated: false }).filter((p) => p.condition_id === marketId && p.net_quantity > 0).map((p) => p.bot_id)),
    ],
    fetchFn: fetchFn as unknown as typeof fetch,
    baseUrl: 'https://gamma.test',
    now: () => clock.now,
  });
  const ledger = new LedgerService({
    forecastRepo,
    rightsRepo,
    marketCache: cache,
    audit,
    getTopOfBook: async (tokenId) => {
      const b = books.get(tokenId);
      if (!b) throw new Error('no book');
      return b;
    },
    getMid: async (tokenId) => mids.get(tokenId) ?? null,
    getMandate: () => mandate.value,
    now: () => clock.now,
  });
  return {
    ...t,
    clock,
    gamma,
    gammaDown,
    fetchFn,
    books,
    mids,
    mandate,
    marketRepo,
    forecastRepo,
    rightsRepo,
    auditRepo,
    audit,
    cache,
    ledger,
    auditActions(action) {
      return (t.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as Array<{ target: string | null; payload: string | null; actor: string }>).map((r) => ({
        target: r.target,
        actor: r.actor,
        payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : {},
      }));
    },
  };
}
