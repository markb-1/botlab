# BotLab Phase 5 (strategy templates) — macOS test report

Run: 2026-10-31, 18:30–20:05 UTC, branch `claude/keen-allen-b8lq9q` from `26bf5a6`, macOS 26 (Apple silicon), Node
**22.23.4** (Homebrew `node@22`). Paper mode only: `live_trading.enabled` stayed `false`, no wallet key or Binance key
was entered, no real order was placed (every bot below is a paper bot with an auto-generated paper wallet). The agent
budget stayed at `agent.monthly_llm_budget_usd: 3` / `agent.max_run_cost_usd: 0.50`; `agent.enabled` was turned on
for one run and is back to `false`. The database is the one from the Phase 1–4 tests (the seed upgraded Copy Trading
v1 → v2.0.0 in place and created the four new templates on first start).

## Summary

| step | result |
|---|---|
| 1. install / typecheck / lint / test | **Pass.** typecheck clean, lint 0 errors (2,249 warnings), **1175/1175** tests (69 files) with network tests |
| 2. markets + ambiguity | Pass. 42 live markets rated (Markets page and the same route over HTTP); the page asks for the password again after 15 min |
| 3. forecast executor + position manager | **Pass, with findings.** Bids ≤ p − min_edge, never stepped up; paper fills only on a real book cross (3 fills); exits on ambiguity, exit flag, stop; no re-buy after a stop; second executor refused. Convergence: **not exercised live** (no position in profit; no fill in the last 25 min). Findings F1–F4 |
| 4. resolution rule | **Pass.** Bid = target (≤ target), no sells; ambiguity → 2 ⇒ bids cancelled, bot retired itself, cannot be restarted |
| 5. consistency | **Pass.** Constraint + live gap on the bot page; no trade at gap −0.96; invalid configs refused (template at start and agent create) |
| 6. copy trading v2 | **Pass, one bug fixed.** No backlog copied; no duplicates; 2 copy attempts as limits; 400+ skips logged with reasons; Leaders panel. Bug: the 1¢ chase was lost to API price noise (fixed, `b4e53be`). Live API: no `logIndex`, `type=TRADE` works, `end` pages, `before` ignored |
| 7. agent | Pass. One cycle run ($0.064); executor / position-manager creates and a dropped leader refused. The run found nothing to do because category-only market search returns nothing today (F6) |
| 8. regression | **Pass.** Kill switch stopped all 4 running strategy bots and cancelled the 3 resting paper bids; start refused while halted; clear halt; Ctrl+C ⇒ `clean: true`, restart not halted, seed upgraded Copy Trading with `b4e53be` |

**Fixes committed (each its own commit, full suite green before each):**

- `f05da4f` **Bot form: allow any decimal in number config fields.** Bots → New bot → Forecast Executor could not be
  submitted with its defaults: the form rendered schema numbers with `step=0.01`, and the browser refused
  `min_edge_per_day: 0.001` ("Please enter a valid value. The two nearest valid values are 0 and 0.01"). Now
  `step="any"` (as in `ConfigSchemaBuilder`). Verified in the running UI: every field valid, the bot was created.
- `b4e53be` **Copy trading: tolerate data-API price noise when rounding to the tick.** Live leader fills come back as
  `usdcSize / size`, a few 1e-7 off the tick (`0.3699999935`, `0.5400002024`, `0.7699996821`). The 1e-9 tolerance
  floored 0.37 + 0.01 to **0.37** (observed: leader `0xad53…` bought at 0.37, our copy limit was 0.37 instead of
  0.38) and ceil'd sells a tick high. Tolerance now 1e-6; the unit test uses the live values.

## Findings not fixed (design questions, for review)

- **F1 — the executor locks itself out on the per-bot order rate.** Each quoted market's bid is re-placed every
  2 × `requote_minutes` (TTL 2r + 2 min, replaced once ≤ r + 1 min is left), i.e. 60 / (2r) orders per hour per
  market: 3/h at the default r = 10, so more than ~6 quoted markets exceed the default
  `per_bot_defaults.max_orders_per_hour: 20` (`max_markets` defaults to 10). With r = 2 (my config, 3 markets) the
  executor hit it after ~35 min: `Risk check failed: 24 orders in the last hour (max 20)` (`bot_rate`).
  `OrderRepository.countByBotSince` counts **every** order row of the bot, including `rejected_risk` attempts and the
  Position Manager's exits placed for it, so the count kept rising (41 at 19:31) while the bot only tried and failed.
- **F2 — a refused marketable risk exit leaves no exit order.** After `escalate_after_minutes` every attempt is
  marketable (`position-manager.ts:319-362`); the risk engine still requires `min_top_of_book_usd` ($200) for
  marketable orders (R160), and the NZ market's NO bid level held $16–36. Result: the flag exit was refused every
  70 s for the rest of the test (`Top of book $16.5 < $200` …) and nothing rested in the book meanwhile. Each refused
  attempt is an order row of the **owning** bot, which feeds F1 (the executor's count grew by ~50/h). Falling back to
  the resting price when the marketable exit is refused would avoid both.
- **F3 — the executor ignores open exit flags.** With a flag open on its Hipkins NO position it kept planning more of
  that token (19:31: `bid 9.09 @ 0.55 on 112438…` — refused only by F1). Copy trading checks flags before buying; the
  executor does not, so it can buy what the manager is told to sell.
- **F4 — the stop marker is per executor bot.** After the stop the executor skipped Luxon as documented, but the
  marker lives in that bot's order history: the replacement executor (created to get round F1) bid Luxon again at
  once (19:33, same forecast, not renewed).
- **F5 — `min_liquidity_usd` is 24 h volume, and only two in-mandate markets had it.** Ledger submit and the order
  path (`OrderService.ts:413`) compare it with Gamma `volume24hr` (as `limits.yaml` documents). Today only the NZ PM
  Luxon/Hipkins markets ($8.9k / $11.6k) and a few next-day temperature markets (Chongqing 16–18 °C, $9.5k–13.3k)
  cleared $5,000 among economics / politics-non-us / weather-climate markets ending within 90 days; the US CPI market ($1.6k) was refused at forecast time (`Market liquidity 1573.3 (24h volume)
  < 5000`) and a resolution-rule bid on CPI > 4.5 % ($665) was refused by the engine (`Liquidity 664.95 < 5000`).
  Copy trading's market filter reads `MarketDetail.liquidityUsd` (Gamma book liquidity) for the same threshold, so a
  copy can pass its own filter and then be refused by the engine.
- **F6 — category-only market search returns nothing.** `searchGamma` without text fetches the top ≤ 100 markets by
  24 h volume and then filters by category; today those are all US midterms / sports / crypto, so
  `search_markets {category: "economics"}` (MCP), the Markets page category filter with an empty box, and the
  agent's in-mandate scan all return `[]`. The agent run reported "the weather-climate in-mandate search returned
  nothing" and made no bots.

## Step 1 — install / typecheck / lint / test

`npm install` (warnings only), `npm run typecheck` exit 0, `npm run lint` 0 errors / 2,249 warnings,
`npx vitest run` **69 files, 1175 tests passed** in 11 s (network tests included; `SKIP_NETWORK_TESTS` unset). After
each fix: typecheck 0, lint 0 errors, 1175/1175.

## Step 2 — markets and ambiguity

Live search (Markets → Search Polymarket, and `GET /api/markets/search?q=`) found few liquid, open markets in the
allowed categories today (US midterms dominate volume). Rated (rules read first):

| market(s) | category | ends | score |
|---|---|---|---|
| US annual CPI 3.7 % in October (BLS) | economics | 11/11 | 0 (via the UI: dialog, then password re-check, "Assessed 0 by human") |
| CPI > 4.5 % / > 5 % in 2026 (one event) | economics | 01/01 | 0 |
| October 2026 unemployment rate, 9 buckets (one negRisk event) | economics | 06/11 | 0 |
| Bank of Canada December decision, 5 outcomes | economics | 09/12 | 0 |
| Next UK by-election called by Oct 31 / Dec 31 | politics-non-us | 01/11, 01/01 | 0 |
| Serbia presidential election called by Oct 31 / Nov 15 / Nov 30 | politics-non-us | 01/11–01/12 | 1 |
| French election called / Sweden snap election | politics-non-us | 01/01 | 1 |
| Next NZ Prime Minister, 7 candidates (negRisk) | politics-non-us | 08/11 | 1 (G-G appointment, caretaker clause) |
| Chongqing highest temperature Nov 1, 11 buckets | weather-climate | 01/11 | 0 (METAR station reading) |

Ambiguity changes need a password check within 15 minutes (UI dialog; the API answers `reauth_required`).

## Step 3 — Forecast Executor + Position Manager (paper)

Setup (human): forecasts Luxon YES **p = 0.72** (Ledger → Submit forecast; market 0.60/0.61), Hipkins YES **p = 0.27**
(market 0.38/0.40, so the executor quotes the NO token, fair 0.73) and Chongqing 18 °C **p = 0.30** (market
0.15/0.18). Ledger → Category rights → Force state… `politics-non-us · medium` → **trading (forced)** with a reason
(allocation $50), and `weather-climate · short` → trading. Bots → New bot → **P5 Forecast Executor** (paper,
`requote_minutes: 2`; fix `f05da4f` needed to submit the form) and **P5 Position Manager** (paper, defaults; later
`stop_loss_move 0.05`, `escalate_after_minutes 3`, `check_minutes 1`).

| check | observed |
|---|---|
| resting bid ≤ p − min_edge | Luxon YES **0.60** (best bid 0.60 / ask 0.61, p − 0.05 = 0.67); Hipkins NO **0.61** (NO book 0.60/0.62, ≤ 0.68); Chongqing **0.16** (book 0.15/0.18, ≤ 0.25). Size = ¼ Kelly × $50: Luxon (0.72 − 0.60)/0.40 × 0.25 × 50 = $3.75 → 6.25 sh ✔ |
| no self step-up on re-quotes | every 2-min cycle kept the bids ("kept" cycles are not logged); each bid was re-placed at the **same** price and size ~1 min before its 6-min TTL (2r + 2). Bids moved only when a competitor moved the book (Chongqing 0.16 → 0.17 after the real best bid went to 0.16) |
| paper fills only on a cross | Hipkins NO 0.61 filled at 19:09:59 when YES best bid reached 0.39 (NO ask 0.61); Luxon YES 0.60 and Hipkins NO 0.60 filled at 19:15:50 when Luxon fell to 0.53/0.59 and Hipkins rose to 0.41/0.47. Each filled at its **own limit** with fee $0 (maker; this market's Gamma schedule is `zero_fees`). Bids not crossed stayed open for 45+ min |
| exit: ambiguity | Hipkins → 2 at 19:08 ⇒ 19:11:30 `position manager: ambiguity exit of 6.3 … (bot 7ecfe79e…)`: a sell **as the executor**, audit `position.exit` actor `bot:<manager>`, order `placed_by` = manager. Back to 1 ⇒ the exit was cancelled (no trigger) |
| exit: flag | `flag_position_exit` with the agent token (MCP) ⇒ 19:18 `flag exit of 13.07 …` sell 0.59 (reason `flag: exit flag: Phase 5 test…`); escalated to marketable after 3 min ⇒ refused by top of book (F2); flag still `open` (it is handled when the position closes) |
| exit: stop | `stop_loss_move 0.05` ⇒ `stop: bid 0.51 <= entry 0.600 − 0.05, forecast not renewed`; post-only 0.55, then marketable after 3 min at 0.49 ⇒ **filled 6.25 @ 0.51** (book bid) |
| no re-buy after a stop | 19:31:43 cycle planned Chongqing and Hipkins NO only — **not Luxon**, although Luxon still showed 0.16 edge (fair 0.72, ask 0.56). See F4 for the per-bot scope |
| exit: convergence | **not exercised live.** It needs a held position whose bid reaches fair − 0.02 with fair ≥ entry (else the earlier "flipped" trigger fires). Both live positions were 7–9¢ under water when they filled, and the replacement executor's three bids (19:33) did not fill in 25 min (the NZ and Chongqing books did not move). Covered by `tests/templates/position-manager.test.ts:57` / `:136` (take-profit decision and post-only exit as the owning bot). Note: a forecast can only be superseded after 6 h (`MIN_SUPERSEDE_INTERVAL_MS`); withdraw + submit renews it at once |
| executor + ambiguity | at ambiguity 2 the executor still planned Hipkins NO; the engine refused it (`Ambiguity 2 > 1`) |
| second executor | a second Forecast Executor (paper) could be created, but start ⇒ `409 A forecast-executor bot is already running in paper mode (P5 Forecast Executor); it is a single-instance template` |

## Step 4 — Resolution Rule (paper)

First bot on CPI > 4.5 % YES (target 0.13, book 0.14/0.16): planned **0.13 ≤ target**, refused by the engine
(`Liquidity 664.95 < 5000`, F5); deleted. Second bot **P5 Resolution Rule (Hipkins)**: `token_id` Hipkins YES,
`target_entry_price 0.37`, `max_size_usd 5`, `requote_minutes 1`, `marketIds` = the Hipkins market.

- Bid **0.37** × 13.51 (= target; best other bid 0.38 + tick would be 0.39 ⇒ capped at the target). Re-placed at the
  same price every ~2.5 min. No sell orders at any point.
- 19:08:15 Hipkins ambiguity → 2 (Markets) ⇒ same second: `resolution-rule: invalidated (ambiguity): ambiguity 2 ≥ 2
  (Position Manager exit); bids cancelled, no more buying` and `retire — invalidated …`; bot `stopped`, stage
  `retired`, retire reason `self: invalidated (ambiguity) …`, audit `bot.stage` / `bot.stop` by the bot.
- Ambiguity back to 1, then **Start** ⇒ `409 Bot 98772c9d… is disabled`: it stays stopped.

## Step 5 — Consistency (paper)

**P5 Consistency Serbia ladder**: `constraint: date_ladder`, tokens [Serbia called by Nov 15 YES, by Nov 30 YES]
(same event, ends 16/11 and 01/12), `check_minutes 1`. Log: `Consistency bot started: date ladder of 2: P
non-decreasing by deadline, min_gap 0.03, max basket $20, max unhedged $10`. Bot page panel: "Date ladder (earliest
deadline first): prices non-decreasing", both tokens, **Current gap (after fees) −0.959, min 0.03**, best basket
"buy #2 YES + #1 NO", state watching, baskets 0 / 0. Live prices were monotone (Nov 15 ask 0.58, Nov 30 ask 0.969),
so no basket was opened and no order placed (only trades when gap ≥ min_gap ✔; a live violation did not occur).

Invalid configs:

| config | human bot (template, at start) | agent `create_bot` (server) |
|---|---|---|
| `exclusive_sum` of Luxon (NZ event) + Serbia Nov 30 | create ok, **start refused**: `onStart failed: invalid consistency config: exclusive_sum: every token must be a market of the same event (mutually exclusive outcomes)` | refused: `exclusive_sum: every token must be a market of the same event` |
| `date_ladder` [Nov 30, Nov 15] | — | refused: `date_ladder tokens must be ordered by deadline (earliest first)` |
| `date_ladder` with one token | — | refused: `tokens must have at least 2 items` |
| `date_ladder` with a NO token | — | refused: `token … is not the YES token of a binary market` |
| ladder market with no end date | not reproducible live (no active Gamma market without `endDate` in the first 6,000) | covered by `tests/templates/consistency.test.ts:505` (`no known end date`) |

## Step 6 — Copy Trading v2 (paper)

`config/mandate.yaml` `strategies.allow` += `copy` (hot reload logged). **P5 Copy v2** (paper), leaders over the run:
e46m3 `0x4f1d…` and Papeasy `0x111f…` (leaderboard via MCP `get_leaderboard`), then `0x4e72…` (leaderboard #20,
weather, ~60 trades/h), `0x122c…` and `0xad53…` (~100 trades/h each, many categories). To reach the market filters
on such high-frequency wallets the test bot used `min_leader_trade_usd 0` and `max_leader_trades_per_day 5000`.

- **No backlog:** each leader's first poll logged `copy: following 0x4f1d…8de2 from now (100 earlier trades not
  copied)`; restarts kept the cursors (no second "from now" for a kept leader).
- **Leader rows follow the config:** removed leaders → `removed`, new ones `active` (Leaders panel).
- **Copies:** 2 attempts in 45 min, each from a distinct leader trade, none duplicated: 19:09:07 Bulgaria
  (Iotova NO) **limit 0.37 × 5.4 ($2.00 = 10 % of the leader's $20)**, 1 s after the leader's fill at
  `0.3699999935` — the limit should have been 0.38 (bug, fixed in `b4e53be`); 19:16:07 Hipkins YES 0.42 × 11.9 ($5).
  Both non-post-only GTD limits, both refused by the engine (`top_of_book`: $129 < $200). "Copied" in the Leaders
  panel stays 0 (attribution is recorded only for placed orders, R184).
- **Skips, with reasons** (server log `[DEBUG] copy: skip …`, plus a `copy` event per cycle with counts):

  | reason | count |
  |---|---|
  | leader trades both sides of the market (market making) | 102 |
  | category us-elections-headline / sports / science-tech / culture / geopolitics / crypto-price / mentions / fed-headline / other not allowed by the mandate | 80 / 44 / 31 / 25 / 17 / 11 / 8 / 5 / 3 |
  | liquidity n < 5000 | 62 |
  | market not assessed for ambiguity (buys are refused) | 14 |
  | leader trade below min_leader_trade_usd (default 10) | 5 |
  | book moved: best ask 0.47 > leader 0.41 + chase 0.01 (never chases) | 5 |
  | buy refused: top_of_book | 2 |

  "Near end" (`inside the Position Manager's 180-min exit window`) did not occur: the leaders' near-end markets
  (daily temperatures) were all below the liquidity threshold, which is checked first.
- Activity API 429s (several leaders polled every 15 s) are logged as `copy: activity of 0x122c…fbed unavailable:
  activity API HTTP 429` and retried; nothing else is affected.
- **Leaders panel** (bot page): per leader status, added by / at, copied, closed / open, hit rate, realised /
  unrealised P&L and the drop window (`0/20 · $0.00 · —`). A dropped leader shows its reason and **Re-activate**.

**Live API verification (R190), `data-api.polymarket.com/activity`, two wallets, 2026-10-31 18:55 UTC:**

| question | result |
|---|---|
| `logIndex` field | **absent** on every row (0/50 for both wallets). Row keys: `proxyWallet, timestamp, conditionId, type, size, usdcSize, transactionHash, price, asset, side, outcomeIndex, title, slug, icon, eventSlug, outcome, name, pseudonym, bio, profileImage, profileImageOptimized`. Several rows share one `transactionHash` (38–39 distinct hashes in 50 rows), so the template's fallback key (tx + asset + side + size + price, `#n`) is what is used in practice |
| `type=TRADE` | works server-side: 50/50 rows `TRADE` (unfiltered: REDEEM, MERGE, CONVERSION, REWARD, YIELD, MAKER_REBATE, TAKER_REBATE mixed in) |
| `end=<ts>` | **works**: every row `timestamp ≤ end` (inclusive), newest first — usable for time paging as R190 suggests |
| `before=<ts>` | **ignored**: returns the newest rows (max ts > before) |
| `start=<ts>` | works as a lower bound (rows ≥ start) |
| price precision | fills are `usdcSize / size`: `0.3699999935`, `0.5400002024`, `0.7699996821`, `0.0190000003` (→ fix `b4e53be`) |

## Step 7 — Agent (optional; `ANTHROPIC_API_KEY` from the gitignored `.env`)

Refusals with the agent token (MCP `create_bot` / `start_bot`):

| call | answer |
|---|---|
| create on Forecast Executor | `the forecast-executor template is a standing bot only a human can create` |
| create on Position Manager | `the position-manager template is a standing bot only a human can create` |
| start the human executor | `forecast-executor bots are standing bots managed by a human (the agent may only pause them)` |
| copy bot naming a dropped leader | `leader 0x111f… was dropped for losing copies; only a human can re-activate it` |

The dropped leader was **simulated** in the test database (an auto-drop needs 20 losing closed copies): Papeasy's
`copy_leaders` row set to `dropped` and a `copy_leader_blocks` row inserted, reason "TEST: simulated auto-drop
(Phase 5 mac test)". The Leaders panel showed it as dropped with Re-activate.

`agent.enabled: true` (hot reload) → Agent run **cycle** (`POST /api/agent/runs`): ok in 10.6 s, **$0.064**, 9 tool
calls (start_run, get_overview, get_notes, get_positions, get_ledger_stats, search_markets, get_forecasts,
write_note, finish_run). Summary: no halts, "the weather-climate in-mandate search returned nothing", no bot,
forecast or flag changes, "No prompt injection suspected". It created no strategy bots (F6 explains the empty scan).
`agent.enabled: false` afterwards; month spend $0.25 of $3.

## Step 8 — Regression

| check | result |
|---|---|
| kill switch (`POST /api/risk/kill-switch`, human) | `stopped`: Position Manager, Copy v2, Executor B, Consistency; `cancelled: 3` (Executor B's resting paper bids, status `cancelled` at 19:57:03); global halt |
| start while halted | `409 Global halt active (Phase 5 regression test); a human must clear it first` |
| clear halt | `POST /api/risk/clear-halt {scope: global, reason}` ⇒ not halted (the body needs `scope`) |
| Ctrl+C restart | consistency + copy bots running, `kill -INT` to the `npm run dev` process group ⇒ `Shutting down all bots… All bots shut down`, `shutdown-state.json` `{"clean":true}`; restart: not halted, `[Seed] Updated template: Copy Trading v2.0.0 (source changed)`; bots come back stopped (as in Phase 4) |

## Leftovers (local, gitignored)

- Config restored: `mandate.strategies.allow` without `copy`; `server.yaml agent.enabled: false`; rights
  `politics-non-us · medium` and `weather-climate · short` forced back to `shadow` and then `auto` (unforcing with
  "auto" alone keeps the current state, so a forced `trading` bucket stays `trading` with its $50 until the rules next
  run — worth knowing).
- The three test forecasts (Luxon 0.72, Hipkins 0.27, Chongqing 18 °C 0.30) were withdrawn so they are not scored.
- Stopped paper bots: P5 Forecast Executor (holds Hipkins NO 13.07 @ 0.605, with an **open exit flag**), P5 Forecast
  Executor B, P5 Position Manager, P5 Resolution Rule (Hipkins, retired), P5 Consistency Serbia ladder, P5 Copy v2
  (simulated dropped leader `0x111f…` + `copy_leader_blocks` row). Delete them from the Bots page when done.
- 42 market ambiguity assessments (human) stay in the market cache.
- Agent spend this month: $0.25 of $3.
