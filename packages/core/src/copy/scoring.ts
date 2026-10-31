/**
 * Copy-trading leader scoring (spec §9.5, 5c) — pure functions, no I/O.
 *
 * A **copied trade** is one round trip in one token (per mode: paper and live are separate books) attributed to one
 * leader: it opens with the first fill of an order that copied that leader's BUY while the bot's lot for
 * (mode, token, leader) is flat, and closes when that lot is back under `DUST_SHARES` — sold by copied sells, by
 * Position Manager exits, or closed by the reconciler at the payout of a resolved market. Its P&L is
 * sell proceeds − buy cost, fees included (dust left at the close counts as a loss of its cost). A win is P&L > 0.
 *
 * Sells are attributed to lots of the same mode and token: a sell that copied leader L takes from L's lot first;
 * whatever is left (and every untagged sell: Position Manager exits, resolution closes) is split pro rata over the
 * lots holding the token. Buys not tagged with a leader go to an unattributed lot that is never reported.
 *
 * Auto-drop (R182): over the leader's last `AUTO_DROP_WINDOW` (20) closed copied trades opened since the leader
 * became active (`activeSince`), net P&L < 0 **and** hit rate < 50 % ⇒ drop. Fewer than 20 closed trades ⇒ never.
 */

export const AUTO_DROP_WINDOW = 20;
/** Lots under this many shares are flat (fills are rounded to 0.01 shares) */
export const DUST_SHARES = 0.01;

export interface ScoringFill {
  tokenId: string;
  side: 'BUY' | 'SELL';
  shares: number;
  /** Buy: cost paid; sell: proceeds (both without fees) */
  usd: number;
  feeUsd: number;
  /** ISO time of the fill */
  at: string;
  simulated: boolean;
  /** Leader the fill's order copied (lower-case address); null = not a copied order */
  leader: string | null;
}

export interface ClosedCopyTrade {
  leader: string;
  tokenId: string;
  simulated: boolean;
  openedAt: string;
  closedAt: string;
  costUsd: number;
  proceedsUsd: number;
  pnlUsd: number;
  win: boolean;
}

export interface OpenCopyTrade {
  leader: string;
  tokenId: string;
  simulated: boolean;
  openedAt: string;
  shares: number;
  /** Remaining cost basis (fees included) */
  costUsd: number;
  /** P&L already realised by partial sells */
  realisedUsd: number;
}

export interface LeaderScore {
  leader: string;
  closedTrades: number;
  openTrades: number;
  wins: number;
  /** wins / closed trades; null without closed trades */
  hitRate: number | null;
  /** Closed round trips plus partial sells of open ones */
  realisedPnlUsd: number;
  /** Open shares at the mark minus their cost; null when some open token has no mark */
  unrealisedPnlUsd: number | null;
  openCostUsd: number;
}

export interface ScoringResult {
  closed: ClosedCopyTrade[];
  open: OpenCopyTrade[];
  leaders: Map<string, LeaderScore>;
}

interface Lot {
  leader: string;
  shares: number;
  cost: number;
  realised: number;
  totalCost: number;
  proceeds: number;
  openedAt: string;
}

const UNATTRIBUTED = '';
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Score a bot's fills (oldest first) per leader. `mark(tokenId)` = current price of the token (null = unknown). */
export function scoreCopyFills(fills: readonly ScoringFill[], mark: (tokenId: string) => number | null = () => null): ScoringResult {
  const books = new Map<string, Map<string, Lot>>(); // `${sim}|${token}` → leader → lot
  const closed: ClosedCopyTrade[] = [];
  const sorted = fills
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.at < b.f.at ? -1 : a.f.at > b.f.at ? 1 : a.i - b.i))
    .map((x) => x.f);

  const close = (key: string, lot: Lot, at: string) => {
    const [sim, tokenId] = [key.slice(0, 1) === '1', key.slice(2)];
    // Dust left over is a loss of its cost
    const pnl = r6(lot.realised - lot.cost);
    if (lot.leader !== UNATTRIBUTED) {
      closed.push({
        leader: lot.leader,
        tokenId,
        simulated: sim,
        openedAt: lot.openedAt,
        closedAt: at,
        costUsd: r6(lot.totalCost),
        proceedsUsd: r6(lot.proceeds),
        pnlUsd: pnl,
        win: pnl > 0,
      });
    }
    lot.shares = 0;
    lot.cost = 0;
  };

  for (const f of sorted) {
    if (!(f.shares > 0) || !Number.isFinite(f.usd)) continue;
    const key = `${f.simulated ? 1 : 0}|${f.tokenId}`;
    let book = books.get(key);
    if (!book) books.set(key, (book = new Map()));
    const fee = Number.isFinite(f.feeUsd) ? Math.max(f.feeUsd, 0) : 0;

    if (f.side === 'BUY') {
      const leader = f.leader ?? UNATTRIBUTED;
      let lot = book.get(leader);
      if (!lot || lot.shares < DUST_SHARES) {
        lot = { leader, shares: 0, cost: 0, realised: 0, totalCost: 0, proceeds: 0, openedAt: f.at };
        book.set(leader, lot);
      }
      lot.shares += f.shares;
      lot.cost += f.usd + fee;
      lot.totalCost += f.usd + fee;
      continue;
    }

    // SELL: the copied leader's lot first, the rest pro rata over the lots holding the token
    const net = f.usd - fee;
    let left = f.shares;
    const take = (lot: Lot, x: number) => {
      if (!(x > 0)) return;
      const basis = lot.cost * (x / lot.shares);
      const proceeds = net * (x / f.shares);
      lot.realised += proceeds - basis;
      lot.proceeds += proceeds;
      lot.cost -= basis;
      lot.shares -= x;
      left -= x;
      if (lot.shares < DUST_SHARES) close(key, lot, f.at);
    };
    const first = f.leader ? book.get(f.leader) : undefined;
    if (first && first.shares >= DUST_SHARES) take(first, Math.min(first.shares, left));
    const holders = [...book.values()].filter((l) => l.shares >= DUST_SHARES);
    const held = holders.reduce((n, l) => n + l.shares, 0);
    if (left > 1e-9 && held > 0) {
      const portion = Math.min(left, held);
      for (const lot of holders) take(lot, Math.min(lot.shares, (portion * lot.shares) / held));
    }
  }

  const open: OpenCopyTrade[] = [];
  for (const [key, book] of books) {
    for (const lot of book.values()) {
      if (lot.leader === UNATTRIBUTED || lot.shares < DUST_SHARES) continue;
      open.push({
        leader: lot.leader,
        tokenId: key.slice(2),
        simulated: key.startsWith('1'),
        openedAt: lot.openedAt,
        shares: r6(lot.shares),
        costUsd: r6(lot.cost),
        realisedUsd: r6(lot.realised),
      });
    }
  }

  const leaders = new Map<string, LeaderScore>();
  const score = (leader: string): LeaderScore => {
    let s = leaders.get(leader);
    if (!s)
      leaders.set(leader, (s = { leader, closedTrades: 0, openTrades: 0, wins: 0, hitRate: null, realisedPnlUsd: 0, unrealisedPnlUsd: 0, openCostUsd: 0 }));
    return s;
  };
  for (const c of closed) {
    const s = score(c.leader);
    s.closedTrades++;
    if (c.win) s.wins++;
    s.realisedPnlUsd += c.pnlUsd;
  }
  for (const o of open) {
    const s = score(o.leader);
    s.openTrades++;
    s.realisedPnlUsd += o.realisedUsd;
    s.openCostUsd += o.costUsd;
    const m = mark(o.tokenId);
    if (s.unrealisedPnlUsd !== null) s.unrealisedPnlUsd = m === null || !Number.isFinite(m) ? null : s.unrealisedPnlUsd + o.shares * m - o.costUsd;
  }
  for (const s of leaders.values()) {
    s.hitRate = s.closedTrades > 0 ? r6(s.wins / s.closedTrades) : null;
    s.realisedPnlUsd = r6(s.realisedPnlUsd);
    s.openCostUsd = r6(s.openCostUsd);
    if (s.unrealisedPnlUsd !== null) s.unrealisedPnlUsd = r6(s.unrealisedPnlUsd);
  }
  return { closed, open, leaders };
}

export interface DropDecision {
  drop: boolean;
  /** Closed trades in the window (≤ AUTO_DROP_WINDOW) */
  trades: number;
  windowPnlUsd: number;
  windowHitRate: number | null;
  reason: string;
}

/**
 * Auto-drop rule (R182): the leader's last `window` closed copied trades opened at or after `activeSince`;
 * drop iff there are `window` of them, their net P&L is < 0 and their hit rate is < 50 %.
 */
export function autoDropDecision(closed: readonly ClosedCopyTrade[], leader: string, activeSince: string | null, window = AUTO_DROP_WINDOW): DropDecision {
  const mine = closed
    .filter((c) => c.leader === leader && (!activeSince || c.openedAt >= activeSince))
    .sort((a, b) => (a.closedAt < b.closedAt ? -1 : a.closedAt > b.closedAt ? 1 : 0))
    .slice(-window);
  const pnl = r6(mine.reduce((n, c) => n + c.pnlUsd, 0));
  const hit = mine.length ? r6(mine.filter((c) => c.win).length / mine.length) : null;
  if (mine.length < window)
    return { drop: false, trades: mine.length, windowPnlUsd: pnl, windowHitRate: hit, reason: `${mine.length}/${window} closed copied trades` };
  const drop = pnl < 0 && (hit ?? 0) < 0.5;
  return {
    drop,
    trades: mine.length,
    windowPnlUsd: pnl,
    windowHitRate: hit,
    reason: `last ${window} closed copied trades: net ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}, hit rate ${Math.round((hit ?? 0) * 100)}%`,
  };
}
