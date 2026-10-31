# BotLab v3 — macOS test report

Run: 2026-10-31, 10:25–10:55 UTC, branch `claude/keen-allen-b8lq9q` (from `bcd152d`), macOS 26 (Darwin 25.6, Apple
silicon), Node **22.23.4** (Homebrew `node@22`), npm 10.9.9. Paper mode only: `live_trading.enabled` stayed `false`, no
wallet key or Binance key was entered, no real order was placed. Live API calls were read-only public GETs.

## Summary

| step | result |
|---|---|
| 1. install / typecheck / lint / test | **Pass on Node 22** after one environment problem (Node 26, below). typecheck clean, lint 0 errors, 957/957 tests (network tests included), 959/959 after the fixes |
| 2. dev server, first-run setup, login | Pass |
| 3. walk every page | Pass with one blocking bug (paper bot creation, **fixed**) and UI issues listed below |
| 4. paper bot end to end + ambiguity gate | Pass after fixing a **stopped bots keep running** bug. Unrated market ⇒ buy rejected; rated 1 ⇒ filled; rated 2 ⇒ rejected |
| 5. safety checks | Kill switch, halt banner, password on clear, "raises risk" review, kill -9 ⇒ halted: pass. **Ctrl+C on `npm run dev` restarted halted (fixed)** |
| 6. VERIFY items vs live APIs | Mostly match. Fee formula and fee currency now known; one **false-allow category tag (fixed)**, one more noted; sports fee rate understated; GTD minimum lifetime not enforced |
| 7. `npm run build` + `npm start` | Pass (scratch data dir). Config dir ignores `BOTLAB_DATA_DIR` (noted) |

## Fixes committed (each with tests, full suite green before committing)

1. `f60bc3a` **Paper bot creation blocked.** The Create Bot form's *Starting Balance* input had `min=1 step=100`, so its
   own default 10000 was invalid ("nearest valid values are 9901 and 10001"). The browser silently refused to submit.
   Now `step="any"` (`apps/web/src/pages/BotCreate.tsx`).
2. `57ddfb5` **Stopped / restarted / kill-switched bots kept running.** `ScriptRunner.stop()` resolved when the
   worker reported `onStop` done but never ended the worker. Its `onTick` interval kept firing and the main thread
   kept serving its RPC calls, so a "stopped" bot still ran its script. A Restart left two tick loops running (seen
   live: ticks at :03/:33 and :28/:58 with a 30 s interval). A live bot could have kept trading after Stop or the
   kill switch. The worker is now terminated after `onStop`, and that exit is not reported as an error.
   Pre-existing since the initial commit. Tests: a real-worker test in `tests/sandbox/sandbox.test.ts` (no
   tick and no RPC after stop) and a `terminate` assertion in `tests/runtime/script-runner.test.ts`. Verified in the
   running app: one 5 s loop after Restart, no ticks after Stop or after the kill switch.
3. `5a2988b` **False allow in the default category map.** `climate-science` is Polymarket's broad "Climate & Science"
   tag (on SpaceX / Anthropic IPO and AI markets). As a strong `weather-climate` tag it put 51 of 1,000 live markets
   into an **allowed** mandate category. Removed it from `categoriesSchema.ts` and `config/categories.example.yaml`;
   weather markets still match on `weather` / `daily-temperature` and keywords. Test added. Note: an existing
   `config/categories.yaml` keeps the old rule until edited by hand.
4. `f5eb1e4` **Ctrl+C on `npm run dev` ⇒ next start halted.** `tsx watch` SIGKILLs its child when a second signal
   arrives during shutdown (`Previous process hasn't exited yet. Force killing...`). A terminal Ctrl+C always delivers
   one: npm forwards SIGINT, and `concurrently -k` sends SIGTERM. So the server never wrote the clean marker.
   `dev:server` is now `node --watch --watch-preserve-output --import tsx apps/server/src/main.ts`. Node's watch relays
   signals without escalating, and the server already merges repeats within 2 s. Verified: Ctrl+C with a bot running ⇒
   graceful stop, `shutdown-state.json` `clean:true`, restart not halted. Hot reload on a core file change still works,
   and bot workers start. `kill -9` ⇒ restart halted. README/CLAUDE.md mention updated.

## Failures and environment problems

- **Node 26 (current Homebrew `node`) cannot install the project.** `better-sqlite3@12.6.2` does not compile against
  Node 26's V8 (`error: no member named 'This' in 'v8::PropertyCallbackInfo<v8::Value>'`, statement.cpp:381,
  database.cpp:411/415). There is no prebuilt binary, so `npm rebuild` falls back to node-gyp and fails. Also,
  npm 11.17 (bundled with Node 26) no longer runs install scripts by default (`npm warn allow-scripts 4 packages have
  install scripts not yet covered by allowScripts: better-sqlite3, esbuild, fsevents`). A fresh clone would have no
  native binary at all. `engines` says `>=22.12`, which admits Node 26. Suggest `"node": ">=22.12 <25"` (or a
  better-sqlite3 upgrade when one supports Node 26) and an `.nvmrc`. All results here use `brew install node@22`.
- The local checkout had a stale untracked `dist-electron/` (Electron build output from `main`). ESLint does not
  ignore it: 5,506 of the 7,364 lint warnings come from it (0 errors either way). Consider adding
  `dist-electron/**` to the ESLint ignores and `.gitignore`.
- `npm install` reports 41 audit findings (15 low, 11 moderate, 10 high, 5 critical). Not investigated.

## Step details

**1.** `npm install`, `npm run typecheck` (core, server, web) clean; `npm run lint` 0 errors; `npm test` without
`SKIP_NETWORK_TESTS`: 54 files, 957 tests passed. The live Data API tests ran (100 activities, 100 positions).

**2.** Dev server started, printed `FIRST RUN ... Setup code: ML9Z-RS48`. From the same machine the setup screen
does not ask for the code (by design, R110); password set, logged in.

**3.** Pages walked: Dashboard, Bots, Bot detail (Overview, Config, Code, Orders, Logs, Trades), Scripts, Ledger (all
four tabs), Markets, Risk (all six tabs), Audit, Approvals, Wallets, Settings. No console errors and no server errors
(the only two 404s came from my own probes of non-existent endpoints).

**4.** Paper bot "Paper BTC test" (Binance Spot, BTCUSDT) created (after fix 1), started, logs and `price` events
streamed over SSE, stopped. Ambiguity gate with a custom paper script calling `ctx.buy()` on "Will Iliana Iotova win the
next Bulgarian presidential election?" (`0x5512bf…f485`, mapped to `politics-non-us`, allowed):

| market state | result |
|---|---|
| not assessed | `rejected_risk`, `failedCheck: ambiguity`, "Ambiguity not rated" |
| set to 1 in the UI (confirmation dialog shown) | `filled`, $2 at 0.67, position shows on the bot |
| set to 2 (> mandate max 1) | `rejected_risk`, "Ambiguity 2 > 1" |

**5.**
- Kill switch (Dashboard): dialog requires a reason; after "Halt everything" the red **Trading is halted (global)**
  banner shows, both running bots stopped, no ticks afterwards, and starting a bot returns 409 "Global halt active".
- Clear halt (more than 15 min after the last password check): reason required, then **Confirm your password**. A
  wrong password shows "Incorrect password"; the right one clears the halt.
- Risk → Limits: per-bot `max_order_usd` 25 → 30 ⇒ review dialog with effect **raises**, "This change raises risk",
  and an "I understand" checkbox before *Save (raises risk)*. Discarded, nothing saved.
- Ctrl+C restart: failed before fix 4 (restart halted "unclean shutdown"), passes after it.
- `kill -9` on the server ⇒ marker `clean:false`, `server.lock` left behind; restart logs "Previous shutdown was
  unclean; starting with a global halt" (correct), and the stale lock does not block the start.

**7.** `npm run build` OK (Vite warns the main chunk is 690 kB > 500 kB). `npm start` without a key refuses with a clear
message. With `BOTLAB_DATA_DIR` set to a scratch dir and `BOTLAB_MASTER_KEY_FILE`, it boots, serves the built UI on
127.0.0.1:3780 (first-run screen, no console errors), `/healthz` ok, and Ctrl+C stops it cleanly (`clean:true`).
**Note:** with only `BOTLAB_DATA_DIR` set, production still wrote the config files to
`~/Library/Application Support/BotLab/config`. `resolveConfigDir` ignores the data dir, while the comment in
`apps/server/src/paths.ts` says production config is `<data dir>/config`. Either set `BOTLAB_CONFIG_DIR` too or
make the config dir follow `BOTLAB_DATA_DIR`. (I moved those test-created files out again; the existing Electron
cache files in that folder were not touched.)

## UI issues (not fixed)

1. **Logs tab is live-only.** No history endpoint, so lines logged before the tab was opened (e.g. `onStart` output)
   never appear. A running bot shows "No logs yet. Start the bot to see output."
2. Custom events (`ctx.emit`, e.g. the template's `price`) are sent over SSE, but I found no place in the UI that
   shows them.
3. Bot detail is very chatty: every SSE bot event refetches `/api/bots` and `/api/bots/:id`. That made about 320
   requests in a few minutes with one 5 s bot.
4. Create Bot: "Starting Balance (USDC)" / "Virtual USDC balance" is shown for Binance bots (USDT). The template
   choice buttons have no accessible name. The name field is prefilled, so typing appends to it.
5. A new paper bot shows stage **probation** with "$0 / $20 (paper)" allocation next to a $10,000 paper balance.
   It's unclear which number limits the bot.
6. Markets: there is no way to browse or search live Polymarket markets. You need a condition id from elsewhere.
   After opening a market by id, the "Cached markets" list still said "The cache is empty" until the next refetch.
7. Dashboard: "Updated in 0 s" (future tense, probably clock skew between browser and server timestamps).
8. Settings: Binance text says credentials are "never sent to the renderer" (Electron leftover); the page subtitle is
   "Configure global settings for your multi-bot system".
9. `/healthz` reports `ok:true` while the global halt is active. That may be intended, but monitoring won't see a halt.

## VERIFY items against live public APIs (read-only, 2026-10-31)

Sample: Gamma `/markets?…&include_tag=true`, 500 active (by 24 h volume) + 500 closed (latest end date). I ran the
repo's own `parseGammaMarketFull`, `categorize` (default categories) and `FeeService` over these 1,000 markets.

| item | live API returns | code expects | match? |
|---|---|---|---|
| Gamma tags (R50) | `tags: [{slug, label, …}]` on market and on `events[]` with `include_tag=true`; no `category` field on any of the 1,000 | slugs + labels from market and events, `category` optional | **Yes** (format) |
| Tag slugs per category (R50) | seen: `sports, nba, nfl, soccer, epl, tennis, esports, crypto, crypto-prices, bitcoin, us-presidential-election, us-election, midterms, trump, politics, elections, pop-culture, fed, fed-rates, fomc, geopolitics, middle-east, israel, iran, weather, daily-temperature, economy, finance, business, world, tech, ai, science, space, world-elections, global-elections` (and others). **Never seen** in the sample, e.g. `us-politics, us-senate, us-house, entertainment, movies, music, inflation, cpi, gdp, interest-rates, central-banks, ecb, uk-politics, european-politics, mentions` | rule lists in `categories.yaml` | **Partly.** Unseen slugs are harmless. False allow `climate-science` ⇒ weather **fixed**. **Still open:** "Will Apple be the largest company in the world by market cap…" (tags `tech, economy, finance, big-tech, business`) ⇒ `economics` (allowed) via the strong tag `economy`. Results: crypto 397, US politics 243 (all US midterm markets denied), sports 133, politics-non-us 87 (e.g. Bulgaria, France), geopolitics 36, mentions 19 (Musk tweet counts), science-tech 16, fed-headline 4 (Fed hikes/cuts), economics 4 (Bank of Canada, Apple), other 9 |
| UMA fields (R52) | `umaResolutionStatus`: absent on most active markets, `"proposed"`, `"resolved"`. `umaResolutionStatuses`: **JSON-encoded string** array, e.g. `"[\"proposed\", \"disputed\", \"proposed\", \"resolved\"]"`; `"disputed"` seen in 2/500 closed markets | `umaResolutionStatus` string; `umaResolutionStatuses` via `parseList` (accepts a JSON string); any value containing "disput" | **Yes.** Both live disputed markets parse as `disputed: true` |
| Data API positions (R66, 2b) | `asset` (string), `conditionId`, `size` (number), `avgPrice`, `curPrice`, `redeemable` (boolean), `title`, `outcome`, plus `totalBought`, `initialValue`, `grossInitialValue`, **`entryFeesUsdc`**, `proxyWallet`, … | `asset, conditionId, size, avgPrice, curPrice, redeemable, title, outcome` | **Yes** |
| positions `market=` filter (R34) | filters to that condition id; a market not held ⇒ `[]` | unfiltered answer treated as unknown | **Yes**, the filter works |
| Data API trades (R64, 2b) | `asset`, `side` `"BUY"`/`"SELL"`, `size` (number), `price`, `timestamp` (integer **seconds**), `conditionId`; `market=` filters correctly | same, timestamp in s ⇒ ×1000 | **Yes** |
| CLOB `/time` (R70) | body is a bare integer in **seconds**, e.g. `1793443411` (~50–70 ms round trip) | `Number(text)`, `<1e12` ⇒ seconds, 1 s resolution | **Yes** |
| CLOB `getTrades` (R64) | `/data/trades` needs L2 auth (HTTP 401), so it can't be checked read-only. clob-client **4.22.8** types: `Trade { id, taker_order_id, market, asset_id, side, size, price, fee_rate_bps, status, match_time, owner, maker_address, maker_orders[], trader_side, … }`; `TradeParams { id?, maker_address?, market?, asset_id?, before?, after? }` (strings) | `taker_order_id`, `maker_orders[].maker_address`, `after` in seconds | Types match; the **units of `after` are still unverified** (needs authenticated access) |
| Fee formula (R13) | Docs (docs.polymarket.com/trading/fees): `fee = C × feeRate × p × (1 − p)`, C = shares, makers never pay. **Live check:** 45.2353 shares at 0.5526 in a 7 % market ⇒ `entryFeesUsdc` 0.78283 = 0.07 × 45.2353 × 0.5526 × 0.4474 exactly (also 15.625 @ 0.32 ⇒ 0.238 ✓) | `rate × p × size` | **No, but conservative.** The code overstates fees by a factor 1/(1−p). Exact formula: multiply by (1 − p). Some old closed crypto markets use `exponent: 2, rate: 0.25` |
| Fee currency (R79) | `size == totalBought` and `grossInitialValue = initialValue + entryFeesUsdc` ⇒ fee charged in **USDC on top**, shares not reduced | R79 tolerates `local_excess` ≤ max(0.01, 1 %) in case fees came out of shares | **Fees are in USDC.** Per R79 the tolerance can be dropped (`LOCAL_EXCESS_FEE_TOLERANCE`) |
| Fee rates (R13) | Docs table: crypto 0.07, **sports 0.05**, finance 0.04, politics 0.04, economics 0.05, culture 0.05, weather 0.05, other 0.05, mentions 0.04, tech 0.04, geopolitics 0 ("geopolitical and world events markets are fee-free"), combos 0.05. Live per-market fields: `feesEnabled`, `feeType` (e.g. `zero_fees`, `crypto_fees_v2`, `sports_fees_v3`, `politics_fees`), `feeSchedule {rate, exponent, takerOnly, rebateRate}`, legacy `takerBaseFee/makerBaseFee` | `fees.yaml` defaults; category from tags | **Sports understated:** code 0.03 vs live 0.05 for 93 of 133 sports markets (`sports_fees_v3`). Harmless while sports is denied, but fix the default. The rest match the docs. **300 politics markets are live `zero_fees`** (e.g. the Bulgarian election), as are some culture/economics/tech, where the code assumes 0.04–0.05 (conservative). Best: read `feeSchedule.rate`/`exponent` per market from Gamma (already fetched) instead of the category table |
| GTD expiry buffer | Docs (docs.polymarket.com/trading/place-orders): "GTD orders expire one minute before their stated expiration… use `now + 60 + N`. In addition, the expiration must be at least **3 minutes** in the future" | `expiration = expiresAt + 60 s` | **Buffer matches.** The minimum isn't enforced: `ttlMinutes` only has to be > 0, so a live limit order with TTL below about 2 min would be rejected by the CLOB. Suggest clamping `ttlMinutes` to ≥ 2.5 |

## Left for you

- Decide the `economy` strong tag (Apple market cap ⇒ economics), the sports fee default (0.05), using per-market
  `feeSchedule`, dropping the R79 fee tolerance, and the GTD minimum lifetime. All are noted above, not changed.
- Pin Node to 22 (`engines` upper bound / `.nvmrc`); Node 26 + npm 11 breaks `npm install`.
- `getTrades` `after` units need one authenticated check before live trading.
- If you already have a `config/categories.yaml`, remove `climate-science` from its `weather-climate` tags by hand.
