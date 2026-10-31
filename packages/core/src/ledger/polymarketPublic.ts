/**
 * Read-only public Polymarket endpoints for the agent's research tools (spec §7.3): order book, price
 * history, event markets, trader leaderboard and a wallet's activity. No credentials; every call has a
 * timeout and the responses are parsed defensively (unknown fields dropped, bad rows skipped).
 *
 * VERIFY (not checked against live responses in this chunk):
 * - CLOB `GET /prices-history?market=<tokenId>&interval=<1h|6h|1d|1w|1m|max>&fidelity=<minutes>` →
 *   `{ history: [{ t: <unix seconds>, p: <price> }] }`.
 * - Data API `GET /v1/leaderboard?category=OVERALL&timePeriod=<DAY|WEEK|MONTH|ALL>&orderBy=<PNL|VOL>&limit&offset`
 *   → `[{ rank, proxyWallet, userName, xUsername, verifiedBadge, vol, pnl }]`.
 * - Data API `GET /activity?user=<address>&limit&sortBy=TIMESTAMP&sortDirection=DESC` →
 *   `[{ timestamp, type, conditionId, asset, side, size, usdcSize, price, outcome, title, slug, transactionHash }]`.
 * - Gamma `GET /events/<id>` → `{ id, title, markets: [...] }` (the series endpoint has no markets; CLAUDE.md).
 */

import { DATA_API_URL } from '../reconcile/dataApi';

const TIMEOUT_MS = 10_000;

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : null);

async function getJson(fetchFn: typeof fetch, url: string, what: string): Promise<unknown> {
  const resp = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`${what} HTTP ${resp.status}`);
  return resp.json();
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBookView {
  tokenId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  lastTradePrice: number | null;
}

function levels(raw: unknown, desc: boolean, depth: number): BookLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: BookLevel[] = [];
  for (const l of raw) {
    if (!l || typeof l !== 'object') continue;
    const price = num((l as { price?: unknown }).price);
    const size = num((l as { size?: unknown }).size);
    if (price === null || size === null || price <= 0 || size <= 0) continue;
    out.push({ price, size });
  }
  out.sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
  return out.slice(0, depth);
}

/** CLOB order book, top `depth` levels each side (best first) */
export async function fetchOrderBook(clobUrl: string, tokenId: string, depth: number, fetchFn: typeof fetch = fetch): Promise<OrderBookView> {
  const body = (await getJson(fetchFn, `${clobUrl.replace(/\/+$/, '')}/book?token_id=${encodeURIComponent(tokenId)}`, 'CLOB book')) as Record<string, unknown>;
  const bids = levels(body?.bids, true, depth);
  const asks = levels(body?.asks, false, depth);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  return {
    tokenId,
    bids,
    asks,
    bestBid,
    bestAsk,
    mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
    spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
    lastTradePrice: num(body?.last_trade_price),
  };
}

export type PriceHistoryInterval = '1h' | '6h' | '1d' | '1w' | '1m' | 'max';

/** CLOB price history: points `{ t: ms, p }` oldest first */
export async function fetchPriceHistory(
  clobUrl: string,
  tokenId: string,
  opts: { interval: PriceHistoryInterval; fidelityMinutes: number },
  fetchFn: typeof fetch = fetch
): Promise<Array<{ t: number; p: number }>> {
  const params = new URLSearchParams({ market: tokenId, interval: opts.interval, fidelity: String(opts.fidelityMinutes) });
  const body = (await getJson(fetchFn, `${clobUrl.replace(/\/+$/, '')}/prices-history?${params.toString()}`, 'CLOB prices-history')) as { history?: unknown };
  const hist = Array.isArray(body?.history) ? body.history : [];
  const out: Array<{ t: number; p: number }> = [];
  for (const h of hist) {
    if (!h || typeof h !== 'object') continue;
    const t = num((h as { t?: unknown }).t);
    const p = num((h as { p?: unknown }).p);
    if (t === null || p === null) continue;
    out.push({ t: t < 1e12 ? t * 1000 : t, p });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Gamma event with its markets (raw market objects for parseGammaMarketFull) */
export async function fetchGammaEvent(
  gammaUrl: string,
  eventId: string,
  fetchFn: typeof fetch = fetch
): Promise<{ id: string; title: string | null; markets: unknown[] } | null> {
  const body = (await getJson(fetchFn, `${gammaUrl.replace(/\/+$/, '')}/events/${encodeURIComponent(eventId)}`, 'Gamma event')) as Record<
    string,
    unknown
  > | null;
  if (!body || typeof body !== 'object') return null;
  const { markets, ...event } = body;
  return {
    id: str(body.id) ?? eventId,
    title: str(body.title),
    markets: Array.isArray(markets) ? markets.map((m) => (m && typeof m === 'object' ? { ...(m as object), events: [event] } : m)) : [],
  };
}

export type LeaderboardPeriod = 'DAY' | 'WEEK' | 'MONTH' | 'ALL';
export type LeaderboardOrder = 'PNL' | 'VOL';

export interface LeaderboardEntry {
  rank: number | null;
  wallet: string;
  userName: string | null;
  pnlUsd: number | null;
  volumeUsd: number | null;
}

/** Polymarket trader leaderboard (Data API; VERIFY) */
export async function fetchLeaderboard(
  opts: { period: LeaderboardPeriod; orderBy: LeaderboardOrder; limit: number; category?: string },
  fetchFn: typeof fetch = fetch,
  base = DATA_API_URL
): Promise<LeaderboardEntry[]> {
  const params = new URLSearchParams({
    category: opts.category ?? 'OVERALL',
    timePeriod: opts.period,
    orderBy: opts.orderBy,
    limit: String(opts.limit),
    offset: '0',
  });
  const body = await getJson(fetchFn, `${base}/v1/leaderboard?${params.toString()}`, 'Polymarket leaderboard');
  const rows = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown })?.data) ? ((body as { data: unknown[] }).data as unknown[]) : [];
  const out: LeaderboardEntry[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const wallet = str(o.proxyWallet) ?? str(o.wallet) ?? str(o.address);
    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) continue;
    out.push({ rank: num(o.rank), wallet, userName: str(o.userName) ?? str(o.name), pnlUsd: num(o.pnl), volumeUsd: num(o.vol) ?? num(o.volume) });
  }
  return out.slice(0, opts.limit);
}

export interface WalletActivity {
  at: string | null;
  type: string | null;
  side: string | null;
  marketId: string | null;
  tokenId: string | null;
  title: string | null;
  outcome: string | null;
  price: number | null;
  size: number | null;
  usdcSize: number | null;
}

/** A wallet's recent public activity, newest first (Data API; VERIFY) */
export async function fetchWalletActivity(address: string, limit: number, fetchFn: typeof fetch = fetch, base = DATA_API_URL): Promise<WalletActivity[]> {
  const params = new URLSearchParams({ user: address, limit: String(limit), sortBy: 'TIMESTAMP', sortDirection: 'DESC' });
  const body = await getJson(fetchFn, `${base}/activity?${params.toString()}`, 'Polymarket activity');
  const rows = Array.isArray(body) ? body : [];
  const out: WalletActivity[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const ts = num(o.timestamp);
    out.push({
      at: ts !== null ? new Date(ts < 1e12 ? ts * 1000 : ts).toISOString() : null,
      type: str(o.type),
      side: str(o.side),
      marketId: str(o.conditionId),
      tokenId: str(o.asset),
      title: str(o.title),
      outcome: str(o.outcome),
      price: num(o.price),
      size: num(o.size),
      usdcSize: num(o.usdcSize),
    });
  }
  return out.slice(0, limit);
}
