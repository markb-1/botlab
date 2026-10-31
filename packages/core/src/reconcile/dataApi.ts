/**
 * Polymarket Data API reads used by the Reconciler (spec §13): a wallet's positions and its trades in
 * one market. Public endpoints keyed by the wallet (proxy) address.
 *
 * Field names (`asset`, `conditionId`, `size`, `avgPrice`, `curPrice`, `redeemable`; trades `asset`,
 * `side`, `size`, `price`, `timestamp` in seconds) are from the public docs and UNVERIFIED against live
 * data. A response that is not an array is an error (never read as "no positions").
 */

export const DATA_API_URL = 'https://data-api.polymarket.com';
const TIMEOUT_MS = 15_000;
const PAGE = 500;
const MAX_PAGES = 20;

export interface DataApiPosition {
  tokenId: string;
  conditionId: string | null;
  size: number;
  avgPrice: number | null;
  /** Current price per share (mark); null if absent */
  curPrice: number | null;
  /** Market resolved, shares waiting to be redeemed */
  redeemable: boolean;
  title: string | null;
  outcome: string | null;
}

export interface DataApiTrade {
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  /** ms */
  timestampMs: number;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

async function getJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`Data API ${url.split('?')[0]}: HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/** All positions of a wallet (paged). Throws on any error. */
export async function fetchDataApiPositions(user: string, fetchImpl: FetchLike = fetch as unknown as FetchLike, base = DATA_API_URL): Promise<DataApiPosition[]> {
  const out: DataApiPosition[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${base}/positions?user=${encodeURIComponent(user)}&sizeThreshold=0&limit=${PAGE}&offset=${page * PAGE}`;
    const body = await getJson(fetchImpl, url);
    if (!Array.isArray(body)) throw new Error('Data API positions: unexpected response (not an array)');
    for (const raw of body) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const tokenId = typeof p.asset === 'string' ? p.asset : null;
      const size = num(p.size);
      if (!tokenId || size === null) throw new Error('Data API positions: row without asset/size');
      out.push({
        tokenId,
        conditionId: typeof p.conditionId === 'string' ? p.conditionId : null,
        size,
        avgPrice: num(p.avgPrice),
        curPrice: num(p.curPrice),
        redeemable: p.redeemable === true,
        title: typeof p.title === 'string' ? p.title : null,
        outcome: typeof p.outcome === 'string' ? p.outcome : null,
      });
    }
    if (body.length < PAGE) return out;
  }
  throw new Error(`Data API positions: more than ${MAX_PAGES * PAGE} rows`);
}

/** A wallet's trades in one market (condition id), oldest pages included. Throws on any error. */
export async function fetchDataApiTrades(
  user: string,
  conditionId: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  base = DATA_API_URL
): Promise<DataApiTrade[]> {
  const out: DataApiTrade[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${base}/trades?user=${encodeURIComponent(user)}&market=${encodeURIComponent(conditionId)}&takerOnly=false&limit=${PAGE}&offset=${page * PAGE}`;
    const body = await getJson(fetchImpl, url);
    if (!Array.isArray(body)) throw new Error('Data API trades: unexpected response (not an array)');
    for (const raw of body) {
      if (!raw || typeof raw !== 'object') continue;
      const t = raw as Record<string, unknown>;
      const size = num(t.size);
      const ts = num(t.timestamp);
      if (typeof t.asset !== 'string' || size === null || ts === null) throw new Error('Data API trades: row without asset/size/timestamp');
      out.push({
        tokenId: t.asset,
        side: String(t.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        size,
        price: num(t.price) ?? NaN,
        timestampMs: ts < 1e12 ? ts * 1000 : ts,
      });
    }
    if (body.length < PAGE) return out;
  }
  throw new Error(`Data API trades: more than ${MAX_PAGES * PAGE} rows`);
}
