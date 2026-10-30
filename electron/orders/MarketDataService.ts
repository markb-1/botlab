/**
 * Polymarket market metadata for the risk engine: Gamma API lookup by token id, cached.
 *
 * Ambiguity score and rules-change tracking arrive with the market cache in chunk 2a;
 * until then `PlaceholderMarketQualityProvider` supplies neutral values.
 */

import type { MandateConfig } from '../config';
import { slugify } from './FeeService';

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
}

export interface MarketQuality {
  /** 0–3 (spec §7.4); null = not rated */
  ambiguityScore: number | null;
  rulesChangedAt: string | null;
}

export interface MarketQualityProvider {
  get(marketId: string): Promise<MarketQuality>;
}

/**
 * TODO(chunk 2a): replace with the market cache (agent-assigned ambiguity score,
 * rules_hash change tracking). Until then every market is treated as unambiguous with
 * no rules change, so the mandate's ambiguity and rules-changed checks are not enforced.
 * Recorded in docs/PROGRESS.md "Decisions to review".
 */
export const PlaceholderMarketQualityProvider: MarketQualityProvider = {
  async get(): Promise<MarketQuality> {
    return { ambiguityScore: 0, rulesChangedAt: null };
  },
};

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
  };
}

/**
 * Mandate category for a market from its labels. Placeholder until `config/categories.yaml`
 * (chunk 2a): label slugs are compared with the mandate lists directly; a denied label wins
 * over an allowed one (fail closed). Unmatched ⇒ the first label, which no list contains,
 * so buys are rejected by the category check.
 */
export function mandateCategory(labels: string[], mandate: MandateConfig): string | null {
  const slugs = labels.map(slugify).filter((s) => s.length > 0);
  const { allow, later, deny } = mandate.categories;
  return (
    slugs.find((s) => deny.includes(s)) ??
    slugs.find((s) => later.includes(s)) ??
    slugs.find((s) => allow.includes(s)) ??
    slugs[0] ??
    null
  );
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
