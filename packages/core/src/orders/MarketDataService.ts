/**
 * Polymarket market metadata for the risk engine: Gamma API lookup by token id, cached.
 *
 * Category, ambiguity and rules-change come from a `MarketQualityProvider`; in the app that is the
 * market cache (`ledger/MarketCacheService.ts`, chunk 2a).
 */

import type { CategoriesConfig } from '../config/categoriesSchema';
import { categorize } from '../ledger/categorize';
import { parseMarketFeeSchedule, type MarketFeeSchedule } from './feeModel';

export const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
const INFO_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface MarketInfo {
  /** Condition id */
  marketId: string;
  question: string;
  /** Outcome label of the looked-up token */
  outcome: string;
  tokenIds: string[];
  endDate: string | null;
  /** 24h volume in USD */
  volume24hrUsd: number | null;
  /** Gamma category and tag labels (raw) */
  labels: string[];
  closed: boolean;
  /** The market's own fee schedule from Gamma; null ⇒ category fee table */
  feeSchedule: MarketFeeSchedule | null;
}

export interface MarketQuality {
  /** BotLab category (config/categories.yaml); `other` when unmapped */
  category: string | null;
  /** 0–3 after the server raise (spec §7.4); null = not assessed (buys rejected) */
  ambiguityScore: number | null;
  rulesChangedAt: string | null;
}

export interface MarketQualityProvider {
  get(info: MarketInfo): Promise<MarketQuality>;
}

/**
 * Without a market cache: category from the Gamma labels, ambiguity unknown (so every buy is
 * rejected by the ambiguity check). Used when no MarketCacheService is wired.
 */
export function unassessedQualityProvider(getCategories: () => CategoriesConfig): MarketQualityProvider {
  return {
    async get(info: MarketInfo): Promise<MarketQuality> {
      return { category: categorize({ question: info.question, tags: info.labels }, getCategories()).category, ambiguityScore: null, rulesChangedAt: null };
    },
  };
}

function parseNum(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseList(v: unknown): string[] {
  try {
    const arr = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function tagLabels(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (t && typeof t === 'object') {
      const { slug, label } = t as { slug?: unknown; label?: unknown };
      if (typeof slug === 'string') out.push(slug);
      else if (typeof label === 'string') out.push(label);
    }
  }
  return out;
}

/** Parse one Gamma `/markets` entry for `tokenId`; null if it does not describe that token. */
export function parseGammaMarket(m: unknown, tokenId: string): MarketInfo | null {
  if (!m || typeof m !== 'object') return null;
  const mkt = m as Record<string, unknown>;
  const tokenIds = parseList(mkt.clobTokenIds);
  const idx = tokenIds.indexOf(tokenId);
  if (idx < 0 || typeof mkt.conditionId !== 'string' || !mkt.conditionId) return null;

  const outcomes = parseList(mkt.outcomes);
  const labels: string[] = [];
  if (typeof mkt.category === 'string') labels.push(mkt.category);
  labels.push(...tagLabels(mkt.tags));
  if (Array.isArray(mkt.events)) {
    for (const e of mkt.events) {
      if (e && typeof e === 'object') {
        const ev = e as Record<string, unknown>;
        if (typeof ev.category === 'string') labels.push(ev.category);
        labels.push(...tagLabels(ev.tags));
      }
    }
  }

  const endDate = typeof mkt.endDate === 'string' && !Number.isNaN(Date.parse(mkt.endDate)) ? mkt.endDate : null;
  return {
    marketId: mkt.conditionId,
    question: typeof mkt.question === 'string' ? mkt.question : '',
    outcome: outcomes[idx] ?? '',
    tokenIds,
    endDate,
    volume24hrUsd: parseNum(mkt.volume24hr) ?? parseNum(mkt.volume24hrClob),
    labels: [...new Set(labels)],
    closed: mkt.closed === true || mkt.active === false,
    feeSchedule: parseMarketFeeSchedule(mkt),
  };
}

export class MarketDataService {
  private cache = new Map<string, { info: MarketInfo; at: number }>();
  private fetchFn: typeof fetch;
  private baseUrl: string;
  private now: () => number;

  constructor(opts: { fetchFn?: typeof fetch; baseUrl?: string; now?: () => number } = {}) {
    this.fetchFn = opts.fetchFn ?? ((...args) => globalThis.fetch(...args));
    this.baseUrl = opts.baseUrl ?? GAMMA_API_URL;
    this.now = opts.now ?? Date.now;
  }

  /** Market for a token; null when unknown or unreachable (failures are not cached). */
  async getMarketInfo(tokenId: string): Promise<MarketInfo | null> {
    const hit = this.cache.get(tokenId);
    if (hit && this.now() - hit.at < INFO_TTL_MS) return hit.info;

    try {
      const url = `${this.baseUrl}/markets?clob_token_ids=${encodeURIComponent(tokenId)}&include_tag=true`;
      const resp = await this.fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!resp.ok) return null;
      const body = (await resp.json()) as unknown;
      const list = Array.isArray(body) ? body : [];
      for (const m of list) {
        const info = parseGammaMarket(m, tokenId);
        if (info) {
          this.cache.set(tokenId, { info, at: this.now() });
          return info;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Mark price for daily P&L from top of book (spec §4.2: mid). Positions are long-only, so a book
 * without asks is marked at the best bid and one without bids at half the best ask (bid taken as 0).
 * null when the book is empty or unusable.
 */
export function bookMid(bids: Array<{ price: string }> | undefined, asks: Array<{ price: string }> | undefined): number | null {
  const prices = (levels: Array<{ price: string }> | undefined) =>
    (levels ?? []).map((l) => parseFloat(l.price)).filter((p) => Number.isFinite(p) && p > 0);
  const b = prices(bids);
  const a = prices(asks);
  const bid = b.length > 0 ? Math.max(...b) : null;
  const ask = a.length > 0 ? Math.min(...a) : null;
  if (bid !== null && ask !== null) return bid <= ask ? (bid + ask) / 2 : null;
  if (bid !== null) return bid;
  if (ask !== null) return ask / 2;
  return null;
}

/** Polymarket mid for a token from the public CLOB book endpoint; null when unavailable. */
export async function fetchPolymarketMid(clobHttpUrl: string, tokenId: string, fetchFn: typeof fetch = globalThis.fetch): Promise<number | null> {
  const resp = await fetchFn(`${clobHttpUrl.replace(/\/+$/, '')}/book?token_id=${encodeURIComponent(tokenId)}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`CLOB book HTTP ${resp.status}`);
  const book = (await resp.json()) as { bids?: Array<{ price: string }>; asks?: Array<{ price: string }> };
  return bookMid(book.bids, book.asks);
}

/** Best bid / ask of a token from the public CLOB book endpoint (null side when empty). Throws on HTTP/network errors. */
export async function fetchPolymarketTop(clobHttpUrl: string, tokenId: string, fetchFn: typeof fetch = globalThis.fetch): Promise<{ bestBid: number | null; bestAsk: number | null }> {
  const resp = await fetchFn(`${clobHttpUrl.replace(/\/+$/, '')}/book?token_id=${encodeURIComponent(tokenId)}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`CLOB book HTTP ${resp.status}`);
  const book = (await resp.json()) as { bids?: Array<{ price: string }>; asks?: Array<{ price: string }> };
  const prices = (levels: Array<{ price: string }> | undefined) =>
    (levels ?? []).map((l) => parseFloat(l.price)).filter((p) => Number.isFinite(p) && p > 0);
  const b = prices(book.bids);
  const a = prices(book.asks);
  return { bestBid: b.length > 0 ? Math.max(...b) : null, bestAsk: a.length > 0 ? Math.min(...a) : null };
}
