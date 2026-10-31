# BotLab v3 — Development Progress

Implementation log for `docs/SPEC.md`. Each chunk is implemented, reviewed independently, fixed, then committed.

## Plan

| chunk | scope | status |
|---|---|---|
| 1a | `.gitattributes`, 3-OS CI, config system (limits schema/loader), RiskEngine, `orders` + `risk_state` tables | done |
| 1b | OrderService choke point, GTD limit orders, fee table, route all live orders through RiskEngine | done |
| 1c | Halts, daily loss, kill switch, start-halted-after-crash, ramp stages, audit log | done |
| 1d | Sandbox hardening, backtests in worker, AES-GCM migration, copy-trading sell fix | done |
| 1e | Telegram notifications, config hot reload | done |
| 2a | Forecast ledger, scoring, category rights, market cache | done |
| 2b | Order-book recorder, reconciler | done |
| 3a | Extract `packages/core` + services | done |
| 3b | HTTP server + SSE + auth, web client on fetch, remove Electron + AI assistant, cross-platform scripts, Docker | pending |
| 3c | UI pages: Risk, Ledger, Audit, config editing | pending |

Testing policy: tests only for safety- and money-critical logic and core domain logic; existing suite must stay green.
Known pre-existing failures: `tests/copytrading/1-polymarket-data-api.test.ts` calls the live Polymarket API (fails without network; skipped when `SKIP_NETWORK_TESTS=1`).

## Decisions to review

Judgement calls made during the overnight run. Each says how to reverse it.

Paths in R1–R80 predate chunk 3a: `electron/<dir>/` is now `packages/core/src/<dir>/` (`database` → `db`),
`src/core` → `packages/core/src/bots`, `src/utils` → `packages/core/src/utils`, `electron/sdk/binance.ts` →
`exchange/binance/client.ts`, `electron/scripts/templates` → `templates/`; Phase A/B in `electron/main.ts` → `core.ts`
`start()`/`unlock()` (R82, R85).

| # | chunk | decision | why | to reverse |
|---|---|---|---|---|
| R1 | 1a | Risk-exit sells are exempt from `max_order_usd`, `max_orders_per_hour`, `max_open_orders` and `max_spread` (still bound by scope, held position, price range, slippage). | Otherwise an exit from an ambiguous/rule-changed market can be impossible on a wide book or after the per-order cap. | Remove the exemptions in `RiskEngine` step 3/4. |
| R2 | 1a | "Long horizon" is fixed at 30 days; mandate `resolves_within_days[1]` must be ≤ 30. | A mandate edit could otherwise switch off the long-horizon cap. | Change `LONG_HORIZON_DAYS` and the schema refinement. |
| R3 | 1a | Market-quality gates (category, ambiguity, rules-changed, liquidity) apply to buys only. | Exits must remain possible from markets that became risky. | `RiskEngine` step 2. |
| R4 | 1b, replaced 2a | ~~Ambiguity and rules-change placeholders~~ **Replaced in 2a**: `PlaceholderMarketQualityProvider` is gone; `MarketCacheService` supplies category, effective ambiguity and `rules_changed_at` from `market_cache` (see R51–R53). | — | — |
| R5 | 1b, replaced 2a | ~~Mandate category = raw Gamma label~~ **Replaced in 2a** by `config/categories.yaml` + `categorize()` (R50); `mandateCategory()` removed. | — | — |
| R6 | 1b | **Binance counts toward global total exposure** (USDT/USDC/FDUSD = 1 USD) and toward the bot's Binance allocation; not toward per-market or long-horizon. Non-USD-quoted Binance symbols are rejected (`unsupported_symbol`). | Spec intent: global limits cover all live exposure. | `DbRiskStateProvider.computeExposure`, `OrderService.placeBinance`. |
| R7 | 1b | **Equity** = cash (the bot's Polymarket wallet USDC + Binance USDT if credentials are set) + cost basis of all open live positions. It is read for **buys only**: sells (incl. risk exits) never fetch the balance and the engine ignores equity for them. The cash cache (30 s) is dropped after every fill so cash already turned into a position is not counted twice; on-chain settlement lag can still briefly double-count until the balance updates. Read failure ⇒ NaN ⇒ buys rejected `state_invalid`. Multi-wallet setups under-count equity (conservative). | Cash alone would shrink the % limit as positions grow; exits must work when the RPC is down. | `BotManager.createOrderService` `getCashUsd`, `DbRiskStateProvider.getSnapshot`, `RiskEngine` step 0. |
| R8 | 1b | **Only OrderService fills count as positions**: exposure and sellable size come from `bot_trades` rows with an `order_id`. Pre-v3 auto-recorded trades and `ctx.recordTrade` rows are ignored (`recordTrade` strips `orderId`), so existing live positions from before 1b are invisible to the risk engine and cannot be sold by bots (sell manually). `BotManager.initialize` logs a warning listing live bots with such unlinked positions. **Amended in 2b:** the Reconciler sees such positions on the exchange; positions bought before the wallet's first order only **warn** (no halt) until a human adopts them with `reconcile:adoptPositions(walletId, botId)` (R67), which records them as `adopted` order-linked fills (counted as exposure, sellable by that bot). Resolution payouts are `resolution` fills (R69). | A script could otherwise fabricate positions or sells. | `BotTradeRepository.getRiskPositions`. |
| R9 | 1b | **Post-only is emulated**: clob-client 4.22.8 has no `postOnly` flag, so a post-only order is rejected (`post_only`) if it would cross the book at check time; the book can still move before it lands. `placeLimit` defaults to `postOnly: true`. | Spec default is resting post-only. | `OrderService.placeLimit`; use the native flag after upgrading clob-client. |
| R10 | 1b | **ctx.buy/sell are now one FOK order** at a risk-checked worst price (best ask/bid ± `maxSlippage`, or `maxPrice`/`minPrice`, on the tick grid) instead of the old loop of up to 3 retries walking the book. `retries` is ignored. Partial fills only happen in paper. | One exchange order per risk-checked order row; the old loop could walk the book unchecked. | `OrderService.placeMarketable`. |
| R11 | 1b | **Order lifecycle without a reconciler**: only a definite exchange answer marks `failed` (Polymarket: HTTP 4xx except 408/425/429, or a 2xx `success:false`; Binance: same 4xx rule). 5xx, 408/425/429, network errors and missing status ⇒ outcome unknown ⇒ row stays `submitted` and keeps counting toward exposure/open orders. To stop rows accumulating, each bot's sync (before each order, on `getOpenOrders`/cancel): GTD orders past `expires_at` + 60 s get a final fill check then `expired`; an order the exchange no longer returns once past `expires_at` ⇒ `expired`; FOK `unmatched` ⇒ `cancelled` (no fill); market orders still `submitted` (delayed or unknown outcome) get a 5-minute lifetime, then `expired` with no fill seen — **a Binance or Polymarket unknown-outcome order that actually filled is then missed** until the 2b reconciler. A failed exchange lookup leaves the order open. `cancelAll` reports unknown-outcome orders separately (`unknownOutcome`) instead of failing. Other bots' orders are only synced by their own bot. **Amended in 2b:** a live order with no exchange id is **never** expired by OrderService any more; it keeps counting as exposure / an open order until the Reconciler (every 60 s, all bots) has searched the exchange: found ⇒ linked and its fills recorded; nothing found by both lookups and past `expires_at` + 60 s ⇒ `expired`; failed lookup or several matches ⇒ left open (R64). Orders of other bots and of stopped bots are synced by the Reconciler too. | Fail closed while an order may be live, without letting dead orders block trading forever. | `OrderService.syncUnlocked`/`applyOutcome`; `interpretPostResponse`. |
| R12 | 1b | **Paper mode** uses the same limits with stage `paper` treated as `full`, scoped to the bot's own paper orders/fills (stored with `orders.simulated = 1`, `bot_trades.simulated = 1`); halts apply to paper too. Paper fills need the same market data as live (Gamma + book), so paper buys in non-mandate categories are rejected. Resting paper orders are not simulated: `placeLimit` in paper fills at the limit price if marketable (requires `postOnly: false`), else returns `paper mode: resting orders not simulated yet`. | Paper should behave like live. | `DbRiskStateProvider` `simulated`, `OrderService.placeLimit`. |
| R13 | 1b | **Fees**: expected fee = taker rate × filled notional (= rate × p × size), recorded only for what filled; unknown fee category ⇒ highest configured rate; maker 0. Polymarket's documented taker formula may be `rate × min(p, 1−p) × size`, but neither clob-client 4.22.8 nor anything in node_modules confirms it, so the larger (conservative) formula stays. Default rates are unverified (comment in `FeeService.ts`). Binance fees are not modelled (`fee_usd` 0). | Conservative until verified. | `config/fees.yaml`, `FeeService`, `OrderService.applyOutcome`. |
| R14 | 1b | **Invalid risk config disables bot start**: `BotManager.initialize` loads limits/mandate/fees once; on `ConfigError` no bot (live or paper) can start, rather than falling back to defaults. | Fail closed. | `BotManager.initialize`. |

| R15 | 1c | **audit_log is append-only at the DB level**: SQLite triggers abort every UPDATE/DELETE on it (no app code path, and no future admin path without dropping the triggers). | Spec: never updated or deleted by the app. | Drop `audit_log_no_update`/`audit_log_no_delete` in `electron/database/index.ts`. |
| R16 | 1c | **Daily P&L** = Σ(qty_now × mark_now − qty_dayStart × mark_dayStart) + today's sell proceeds − buy cost − fees (= realized today + ΔMTM). Quantities at 00:00 UTC are rebuilt from fills; the day-start marks are captured **once**, at the **first monitor run of the UTC day** (if the app was down at midnight, that is the first run after start), from the fresh mid or else the last mark known at that moment, and are never overwritten that day. A position with no day-start mark is valued at its **average cost at the day start** for the whole day — never at the moving last-known mark, and a mark obtained later in the day is not backfilled (it would re-baseline the loss away: 1000 shares bought at 0.60 and marked 0.30 show −300, not 0). Mark = CLOB/Binance top-of-book mid; one-sided book ⇒ best bid, or half the best ask. Current marks: fresh mid ⇒ last known ⇒ day-start mark ⇒ average cost; every fallback is flagged stale (logged every run, audited when the stale set changes). Sold quantity beyond the recorded (order-linked) holding contributes zero P&L. Only order-linked fills count (R8). Live and paper P&L are separate; a bot halts if either loss ≥ its limit; global = all live fills (incl. deleted bots). `risk_state.day_start_equity` holds the MTM value of the positions held at the day start (cash excluded — nothing needs it yet). | Spec §4.2; never treat a missing price as zero loss. | `electron/risk/dailyPnl.ts`, `RiskMonitor.runOnce`. |
| R17 | 1c | **Halt sequence** = set flag → cancel open orders → stop worker → cancel again (catches orders in flight during the first pass); spec lists cancel then stop. Halted bots — and every bot under a global halt, paper included — **cannot be started** until a human clears the halt. Loss halt of a `full` bot ⇒ `probation`. Binance rows still `submitted` (unknown outcome, no exchange id) cannot be cancelled and are reported as `unknownOutcome`. Positions are never liquidated. | Fail closed. | `HaltService.haltBot`, `KillSwitch.run`, `BotManager.startBotUnaudited`. |
| R18 | 1c | **Monitor failure ⇒ kill switch**: 5 consecutive failed RiskMonitor runs (≈5 min) activate the kill switch. Price-fetch failures are not run failures (R16). | Losses can no longer be watched. | `MAX_CONSECUTIVE_FAILURES` in `RiskMonitor.ts`. |
| R19 | 1c | **Startup**: shutdown marker `shutdown-state.json` next to the DB. Missing marker (first start of a 1c build) = clean; unreadable marker = unclean; unreadable limits config ⇒ `start_halted_after_crash` treated as true. The setting lives in `limits.yaml` under `server:` (spec says `server.yaml`, which does not exist yet). Bots never auto-start, so **every** open order found at startup is synced with the exchange and then cancelled; bot starts are refused until that finishes; stale `running` statuses are reset to `stopped`. **No UI to clear a halt yet**: after an unclean shutdown, clear it from the DevTools console with `await window.electronAPI.risk.clearHalt('global', 'reason')` (UI in 3c). | Spec §4.3. | `electron/risk/StartupRecovery.ts`, `electron/main.ts`. |
| R20 | 1c | **Script versioning**: the integer version is `scripts.revision` (the existing `version` column is semver text in a UNIQUE(name, version) constraint). Any source change bumps `revision`, stores a `script_versions` row, **demotes every bot on the script to `paper`** (`lowerStage`; retired stays retired; one `bot.stage` audit row per bot, same transaction) and, for non-builtin scripts, **resets trust to `new`**. Builtin templates change only through seeding, which follows the same demotion rule (their trust stays `proven`). A running bot that is demoted keeps its live OrderService, so its live orders are rejected (`bot_stage`) until it is restarted (then it runs paper). Forks, imports and human-written scripts start `new`, so new bots on them start in `paper` for `new_template_paper_days`, even if a human wrote them. Changing a bot's script can only lower its stage. A restarted bot loads the script's latest compiled code (template_version pinning is not enforced yet). | Changed code must re-earn trust (spec §4.5). | `ScriptRepository.update`, `botHandlers` `bots:update`. |
| R21 | 1c | **Ramp interpretations**: paper→probation also requires the bot to have been **running on ≥ ceil(`new_template_paper_days` / 2) distinct UTC days** (at least 1) since entering paper, recorded in `bot_run_days` on start and on every heartbeat (60 s) while running; "runtime errors" = worker `error` events (`bots.last_error_at`); "no halts" = no bot halt since entering the stage (`risk_state.last_halted_at`, global halts ignored); no promotions while globally halted; fills = live order-linked fill rows since entering probation; drawdown = largest drop of cumulative live P&L (realized + MTM − fees) from its peak since entering probation, sampled each minute, ÷ the probation allocation (unknown ⇒ wait). Template `proven` = ≥ 2 bots on its current revision promoted to `full` by the ramp (pre-1c `full` bots do not count). With `approvals.new_template_live: true` paper→probation of a `new` template is just blocked and audited (`bot.stage_blocked`, once per process) — no approvals table yet. A running paper-stage bot that is promoted keeps trading paper until restarted (no automatic restart into live). | Spec §4.5 leaves these open. | `electron/risk/ramp.ts`, `RiskMonitor.runRamp`. |
| R22 | 1c | **Halts and the kill switch before unlock**: the risk IPC is registered before the password unlock; the halt flag applies immediately but live orders cannot be cancelled while wallet keys are locked (reported as failed/partial in the result and audit). | Kill switch must always be reachable. | `electron/main.ts` Phase A. |
| R23 | 1c review | **Loss limit after a human clears a halt**: clearing (bot or global) records the scope's live and paper P&L of the day as a baseline (`risk_state.loss_baseline`); for the rest of that UTC day the limit applies to the loss since that baseline, so losing another full limit halts again. Applies to any cleared halt, not only loss halts; ignored from the next day. The baseline uses the P&L of the last monitor run (≤ 60 s old). | Otherwise a cleared bot is re-halted on the next run by the loss already accepted. | `HaltService.clearHalt`, `RiskMonitor.runOnce`. |
| R24 | 1c review | **Orders answered after a halt**: after the exchange answers, OrderService re-reads the bot and global halt; if either is set and the order may still rest, it is cancelled at once (paper: marked cancelled) and audited `order.cancel_after_halt`. Orders without an exchange id (unknown outcome) cannot be cancelled; that is audited (`failed`) and they expire on their own. The returned result is `cancelled`. | The halt's cancel pass cannot see an order whose exchange id is not known yet. | `OrderService.cancelIfHaltedAfterSubmit`. |
| R25 | 1c review | **Bot start vs halt**: halts are checked when the start begins, again just before the worker starts, and again right after; a halt seen after the worker started stops it at once (audited `bot.stop`, start fails). | A halt's stop pass may run before the new instance is registered. | `BotManager.startBotUnaudited`. |
| R26 | 1c review | **Single instance and OS shutdown**: a second app instance quits before touching the DB or the shutdown marker. OS shutdown/log-off runs the graceful path (Windows: window `session-end`; Linux/macOS: `powerMonitor` `shutdown`, delayed with `preventDefault`), so a reboot that lets it finish writes the clean marker; if the OS kills the app first, the next start is halted. | Two instances would share state; reboots should not halt. | `electron/main.ts`. |
| R27 | 1c review | **Risk IPC sender check**: `risk:clearHalt` and `risk:killSwitch` are only accepted from the main window's webContents (by id); `risk:getState` is not restricted. | Human-only actions must come from the app UI. | `registerRiskHandlers` `isTrustedSender`. |
| R28 | 1d, amended 1d review | **The script sandbox is not a hard security boundary**, but the known escapes are closed. Scripts run in a worker thread, in their own `vm` context created with `codeGeneration: { strings: false, wasm: false }` and no `importModuleDynamically` (so `eval`, `Function`, async/generator constructors, `Reflect.construct(Function, …)`, `globalThis.constructor.constructor` throw EvalError and `import()` is rejected); the context global has a null-prototype backing object with only timers, `console`, `URL`, `TextEncoder/Decoder`, `structuredClone`, `atob/btoa`. Because ctx, RPC results, errors and timers are worker-realm objects, the worker realm is hardened before the script runs: `constructor` on `Function.prototype` and the async/generator/async-generator function prototypes, the globals `Function`, `eval`, `process`, `fetch`, `WebSocket`, `EventSource`, `BroadcastChannel`, and `Error.prepareStackTrace` are non-configurable `undefined`. Imports are rejected at compile time; `env: {}`; heap limits 128/32 MB. The 1d version (factory via `new Function` in the worker realm) was escapable through `Function("return import('node:child_process')")()` and `(0,eval)(…)`; a regression probe (`tests/sandbox/escapeProbe.ts`) covers those and ~25 other routes in bot and backtest workers, with a control run proving it detects escapes. Still one isolate and one process: unknown cross-realm paths or V8/Node bugs may remain; untrusted code needs a process/OS sandbox. Side effect: ctx results come from another realm, so `x instanceof Array`/`Error` is false for them (use `Array.isArray`). | Spec §5.1 asks for hardening; a separate process sandbox is out of scope. | `electron/runtime/sandbox.ts`. |
| R29 | 1d | **Compile step rejects every import**, relative ones included (`bundle: true`, `platform: 'neutral'`, resolver plugin that errors on any path). Type-only imports are erased and allowed. Dynamic `import()` is lowered to `require()`, which is undefined at runtime. Already-compiled code in existing DBs is **not** recompiled: a user script compiled before 1d that used `require` now fails at load ("require is not a function"); re-saving shows the compile error. | Scripts get only `ctx`. | `electron/runtime/compileScript.ts`. |
| R30 | 1d | **ctx.fetch** runs in the main process: https only, port 443, exact host match against `limits.yaml server.script_fetch_allowlist` (default gamma-api/data-api/clob.polymarket.com, api.binance.com), GET/POST only, string body ≤ 256 KB, `Cookie`/`Authorization`/`Host` headers dropped, redirects followed by hand (max 3, each hop allowlisted), 10 s timeout, 2 MB response cap. Returns `{ ok, status, statusText, url, headers.get(), text(), json() }` — no streams/`arrayBuffer`/`blob`. The allowlist is read when BotManager loads config (restart to change; hot reload in 1e). It lives in `limits.yaml` until `server.yaml` exists (like R19). | Prevents exfiltration; spec §5.1. | `electron/runtime/scriptFetch.ts`, `RpcHandler` `fetch`. |
| R31 | 1d, amended 1d review | **Tick watchdog semantics**: on the main thread (catches a worker stuck in a synchronous loop). Each full 30 s period a tick stays unsettled is one strike; a tick that settles without a strike resets the count; 3 consecutive strikes ⇒ worker terminated, bot status `error`, `bot.error` audit row (`reason: tick_watchdog`). Only `onTick` is watched by the tick watchdog. **Liveness** covers everything else (e.g. a synchronous loop in a `ctx.setInterval` callback such as the Copy Trading polling loop): the main thread pings the worker every 30 s; the ping is answered by the bootstrap, not by script code (so a slow `onHeartbeat` does not count); no message at all for 120 s (2 heartbeat periods) ⇒ terminated, status `error`, `bot.error` audit with `reason: worker_unresponsive`. An `async` wait never trips it. **`onTick` no longer overlaps**: an interval that fires while a tick is in flight is skipped. Also: **any unexpected worker exit while running** (crash, out-of-memory from the heap limit) now marks the bot `error` (`reason: worker_exit`) instead of leaving it "running"; module load + `onStart` must finish within 60 s or the start fails. Open orders are left as on a normal stop. | Spec §5.1 leaves "3 consecutive" open for a tick that never ends. | `ScriptRunner` watchdog, `BaseBotRunner.markFailed`, `BotManager.onBotFatal`. |
| R32 | 1d | **Backtests**: script load + simulation run in a worker (same sandbox, no fetch/timers as before) with a 120 s overall timeout; klines are fetched on the main thread and copied to the worker; trades are written after the simulation in one transaction (a timed-out run stores no trades, status `error`). IPC contract unchanged. | An infinite loop froze the app. | `BACKTEST_TIMEOUT_MS` in `electron/backtest/BacktestEngine.ts`. |
| R33 | 1d | **Secrets**: AES-256-GCM `v2:<iv>:<tag>:<ct>` (base64) with the existing 64-hex PBKDF2 key used directly; the key **must** be 64 hex chars (`WalletManager` now rejects anything else). Legacy CryptoJS payloads are decrypted by a Node re-implementation (EVP_BytesToKey-MD5 + AES-256-CBC), so `crypto-js` is removed from the root package (`web/client/package.json` still lists it, unused). Migration runs at every unlock before WalletManager starts, is idempotent, migrates wallet keys (incl. paper wallets), Binance key/secret and the Claude key in one transaction, and audits `secrets.migrate_v2` when something changed; a row that cannot be decrypted is left as is (`partial`). | Spec §8.3. | `electron/security/crypto.ts`, `migrateSecrets.ts`, `electron/main.ts` Phase B. |
| R34 | 1d | **Copy-trading sell hotfix**: a leader SELL is copied as the leader's sold fraction of their position — leader position after the sell = data-api `positions?user=&market=<conditionId>` minus the leader's later net trades in the same asset within the batch; absent from a market-filtered answer ⇒ full exit ⇒ sell all we hold; unknown (no conditionId, API error, unfiltered answer) ⇒ USD copy size ÷ current bid (mid if no bid). Always capped at the bot's held tokens, rounded down to 0.01. Sells skip the daily volume cap and min order size; batches are processed oldest first; only `type === 'TRADE'` rows. **Live `ctx.getPositions()` now returns the bot's order-linked positions** (R8: what it may sell), valued at cost; before 1d it always returned `[]`. The `market` filter of the data API is unverified (hence the unfiltered-answer check). The template source changed (version still 1.0.0), so seeding **demotes every bot on Copy Trading to `paper`** (R20). | Spec §9.5 row 1; the rest of copy trading v2 is a later chunk. | `electron/scripts/templates/copy-trading.ts`, `RpcHandler` `polymarket:getPositions`. |
| R35 | 1d review | **ctx.fetch concurrency**: at most 6 requests in flight per bot (per RpcHandler, i.e. per running bot instance); a 7th is rejected at once with `fetch: too many concurrent requests` (not queued). | Bounds main-process sockets/memory a script can tie up. | `MAX_CONCURRENT_FETCHES` in `electron/runtime/RpcHandler.ts`. |
| R36 | 1d review | **Copy Trading batch order**: rows are reversed (API is newest first) then stably sorted by time, so same-second rows are oldest first; the leader's later net trades for a sell are the rows after it by index. Only buys count toward `dailyVolume`. | Same-second rows were ambiguous with a timestamp filter; the cap limits buying. | `electron/scripts/templates/copy-trading.ts`. |
| R37 | 1e | **`server.yaml` holds only `timezone`, `digest_time` and `notify.telegram`.** `start_halted_after_crash` and `script_fetch_allowlist` stay in `limits.yaml` under `server:` (spec §4.3/§5.1 put them in `server.yaml`). | Moving them would break existing `limits.yaml` files and the strict schema; both are still hot-reloaded. | Move the two keys into `ServerSchema`, drop them from `LimitsSchema.server`, update `classifyKey` and `main.ts`. |
| R38 | 1e | **Config reload is all-or-nothing and fails closed.** All four files (limits, mandate, fees, server) are loaded and cross-validated together; any problem keeps the previous config. A deleted file is an error; so is an empty, whitespace/comment-only or truncated file (reload requires every top-level section of limits, mandate and fees to be present, amended in review: `.prefault` used to turn an empty file into the defaults) (it never resets to defaults); defaults are only written by the initial `load()`. An invalid config at startup leaves `BotManager` with no risk engine (bots cannot start) until a valid edit arrives, which then becomes the config. | A deleted/garbled limits file must not loosen anything. | `ConfigService.readAll(create)`, `parseConfigYaml` strict mode. |
| R39 | 1e | **Risk classification is conservative.** Unknown keys in limits/mandate and non-comparable values count as `raises`; lowering an assumed fee rate counts as `raises`; `server.yaml` changes are neutral. Only `raises` notify (Telegram "Risk limits raised"); they take effect immediately either way (spec §3). Allow-list growth (categories, strategies, `script_fetch_allowlist`), shrinking the deny list, widening a horizon range, disabling `start_halted_after_crash` / `approvals.new_template_live`, enabling binance / marketable orders / custom templates all raise. | Over-notifying is cheap; missing a loosening is not. | `electron/config/changes.ts` rule tables. |
| R40 | 1e | **Config writes are human-only and go through the same reload path.** `ConfigService.write/restore` require actor `human` (IPC is sender-checked to the main window, like risk IPC); validated against the schema and cross-file rules, rendered with the `yaml` Document API (comments, quoting and untouched arrays kept; missing keys are added with their defaults), written with `write-file-atomic`, then reloaded inside the same lock so the watcher event for our own write finds no diff and no duplicate event/audit. Comment-only edits produce no `config.changed`. YAML library normalises spacing before trailing comments and may move a comment that sits directly after a key with a sequence value. | One validation path; no duplicate events. | `ConfigService.write`. |
| R41 | 1e | **Config history is files in the data dir** (`config-history/<file>/<versionId>.yaml` + `.json` sidecar, newest 100 per file), recorded for every accepted text change including hand edits and the initial load. Snapshots contain the Telegram token like the file itself; audit rows and Telegram messages redact it (`***`), `config:get` masks it, and sending the mask back keeps the stored token. `restore` re-validates the old text against today's schema and the other files. | No DB/ABI dependency, testable under plain Node. | `electron/config/history.ts`. |
| R42 | 1e | **chokidar 4.x, not 5/6** (those are ESM-only; the Electron build is CommonJS). Watches the config dir (depth 0), filters to the four file names, 500 ms debounce. | `require()` of an ESM-only package fails under the current build. | Bump after moving to ESM (chunk 3a/3b). |
| R43 | 1e | **Notifications hang off existing seams.** Halt/kill-switch/halt-cleared from `HaltService` events; bot created/deleted/stage (incl. retired), new script versions (`script.create`, `script.update` with `sourceChanged`) and `bot.error` from a new `AuditService.onRecord` listener; fills/rejections from an optional `OrderEventSink` on `OrderService` (fills are emitted after the DB transaction commits, live only); config events from `ConfigService`. Startup halt after a crash is the global-halt event with reason `unclean shutdown`, so the notifier is created before `applyStartupHalt`. Reconciliation mismatch is `NotificationService.reconciliationMismatch()` (hook for chunk 2b). Category-rights, rules_changed and agent-run messages arrive with their chunks. | No second event bus; no trading path waits on Telegram. | `electron/notify/`. |
| R44 | 1e | **Telegram transport**: `send()` only enqueues (never throws, no-op when disabled); one sender, >=1.1 s apart, plain consecutive messages coalesced (<=3900 chars), replies/button messages kept separate, high priority jumps the queue and is retried up to 3 times, queue capped at 200 (oldest normal dropped), 429 `retry_after` honoured; errors logged with the token redacted. Long-polling `getUpdates` (25 s); only the admin is obeyed: `message.from.id` (or `callback_query.from.id`) AND the chat id must equal `chat_id`, which only holds in a private chat with the owner, and forwarded messages are ignored (amended in review; group chats are unsupported); messages older than 5 min at startup are dropped. Settings are re-read live from `ConfigService`, so enabling Telegram in `server.yaml` needs no restart; `TELEGRAM_BOT_TOKEN` overrides the token. | Spec §11; the app must work with Telegram off. | `electron/notify/TelegramNotifier.ts`. |
| R45 | 1e | **Commands**: `/halt [reason]` activates the kill switch with actor `human` (reason prefixed `Telegram:`); `/pause` stops a running bot (id, exact name, or unique name fragment; `human` actor, so it is audited as `bot.stop`) and the fill/storm "Pause" button does the same; anything that looks like clearing a halt (`/clearhalt`, `/unhalt`, `/resume`, ...) is refused with a pointer to the UI; `/run`, `/code` omitted. A command that is running the kill switch blocks the polling loop until it finishes. Rejection storm = more than 10 rejections (live or paper) per bot in the last hour, alerted once per bot per hour. Fill batches flush every 5 min from the first buffered fill (a fill buffered at shutdown is flushed in `stop()`). Digest: once per local day between `digest_time` and +2 h (a late app start skips it), last date kept in `notify-state.json`; P&L shown is the UTC-day figure the RiskMonitor keeps. | Spec §11. | `electron/notify/NotificationService.ts`. |

| R46 | 1e review | **Secrets in errors**: YAML is parsed with `prettyErrors: false` and every config error (log, audit, `getLastError`, IPC, Telegram, subscribers) goes through `redactSecrets`: the current token, `TELEGRAM_BOT_TOKEN`, anything shaped like a bot token, and `bot_token:` values. | A YAML code frame printed the `bot_token` line. | `redactSecrets` in `changes.ts`, `ConfigService.scrub`. |
| R47 | 1e review | **server.yaml risk classification**: disabling Telegram and changing `chat_id` or the token are `raises` (enabling and timezone/digest stay neutral). The alert for a change is sent with the Telegram settings from before the edit (`OutgoingMessage.via`), so the old chat still hears that notifications were turned off or moved. | Otherwise one edit could silence its own alert. | `classifyKey`, `NotificationService.onConfigChanged`. |
| R48 | 1e review | **`/pause` name matching**: exact id first; exact name among non-retired bots (several ⇒ reply listing ids, no action); else a name fragment among non-retired bots (several ⇒ the single running one, otherwise ask for the id). | Duplicate names must not pause the wrong bot. | `NotificationService.findBot`. |
| R49 | 1e review | **Config write safety**: `write(file, value, actor, expectedSha256?)` refuses if the file on disk no longer hashes to what the UI loaded (`config:get` returns `hashes`); `write`/`restore` validate the whole on-disk set plus the new text before writing and throw (not succeed) if the reload is rejected. The first valid config after an invalid start is audited as `config.changed` (diff against the built-in defaults) and announced on Telegram. Watcher-detected edits are audited with actor `system`. The update offset resets when the token changes. chokidar uses `awaitWriteFinish` (300 ms). | Review findings. | `ConfigService`, `TelegramNotifier.pollOnce`. |

| R50 | 2a, amended 2a review | **Category mapping** (`config/categories.yaml`, hot-reloaded, any edit classified `raises`): ordered rules, **first match wins**, denied categories listed first (sports, crypto-price, mentions, us-elections-headline, culture-entertainment), then a `fed-headline` category (spec §3.3 excludes the headline Fed meeting from economics; it is in no mandate list, so never allowed), geopolitics, weather-climate, economics, science-tech, politics-non-us. A rule matches on any strong tag, or on a whole-word keyword in the question/event title gated by `when_tags`; `exclude_keywords` veto. Any US political market with a US keyword (Senate, Trump, …) maps to `us-elections-headline` (denied), not only elections. A generic "election" market without a country tag or non-US keyword is `other`. Unmapped ⇒ `other`; mandate may not allow `other` (schema error). **Tag slugs are from knowledge of the Gamma API and unverified — check a sample of live markets per category before live trading.** Cached markets are re-categorized when the file changes. **Amended in review:** deny / never-allowed rules (sports, crypto-price, mentions, us-elections-headline, fed-headline) now match on a keyword **alone** (no `when_tags`), so e.g. "Fed decision in December?" tagged only `interest-rates`/`central-banks` is `fed-headline`, not economics; `fed` is also a strong tag. Unambiguously US-political words (Senate, Congress, Trump, GOP, …) deny on their own — an economics market mentioning Trump is denied; generic US words (`us`, `united states`, `governor`) still need a political tag so US CPI/jobs markets stay economics. Sports and mentions got keywords (`super bowl`, `say`, …). False denies are accepted. | Fail closed; explicit and human-editable. | Edit `config/categories.yaml`; matching in `electron/ledger/categorize.ts`. |
| R51 | 2a, amended 2a review | **Unassessed ambiguity ⇒ buys rejected** (live and paper): a market can only be bought after someone assessed it — a forecast's `ambiguityScore` (agent later, human now via `ledger:submitForecast`) or a human via `markets:setAmbiguity(marketId, score, note)` (main window only; no UI until 3c, use DevTools: `await window.electronAPI.markets.setAmbiguity('<conditionId>', 0, 'note')`). **Consistency / resolution-rule bots therefore need each market assessed first.** The latest assessment wins (human or forecast). The market stores the raw score; the server raise (≥ 2 for 7 days after a rules change, or while a UMA dispute is recorded) is applied at read time, so it lapses on its own; the forecast row stores the raised score. **Amended in review:** the stored score has a source (`human` or `forecast`). **A human assessment always wins** until a human changes it (forecasts are ignored on that market); a forecast may only **raise** a forecast-sourced score, never lower it; `markets:setAmbiguity` refuses non-human actors. Every attempt is audited (`market.ambiguity`, result `kept: …` when ignored). | Spec §7.4; same fail-closed rule as other missing market data (1a). | `effectiveAmbiguity` in `electron/ledger/ambiguity.ts`; `RiskEngine` step 2. |
| R52 | 2a | **UMA dispute detection** uses Gamma `umaResolutionStatus` and the `umaResolutionStatuses` history: any value containing "disput" ⇒ `disputed` (sticky once seen, audited `market.disputed`, Telegram if held). Field names are **unverified** against live data; if Gamma lacks them no dispute is ever detected (TODO: CLOB/UMA source). | Only Gamma fields available without a new integration. | `parseGammaMarketFull` in `electron/ledger/MarketCacheService.ts`. |
| R53 | 2a, amended 2a review | **Market cache refresh**: on the order path a row older than 10 min is refreshed with a 5 s cap; on failure the cached row is used (and the 5-min Gamma lookup in `MarketDataService` still gates buys); a market never cached gets its category from the order's Gamma labels and ambiguity unknown. Every 30 min: markets with live or paper positions, open orders, or active forecasts (batches of 20 `condition_ids`). `rules_hash` = sha256 of the NFC, whitespace-collapsed `description` + "Resolution source: …"; whitespace-only edits are not changes; a response without `description` keeps the previous rules; the first sighting is never a change. A change sets `rules_changed_at`, is audited `market.rules_changed` with the bots holding a **live** position, emitted as `market:rulesChanged` (renderer), and sent to Telegram (high) only if held. `ctx.events` for bots is not built yet. **Amended in review:** on the order path a row not refreshed for **2 h** (Gamma failing or no longer returning the market) gives ambiguity unknown ⇒ **buys rejected**; sells unaffected. | Spec §2.2/§11; never block orders on Gamma. | `MarketCacheService`. |
| R54 | 2a, amended 2a review | **Resolution source for scoring** = Gamma market: `closed` and `outcomePrices` exactly 0/1 with one winner ⇒ resolved (payout per token index); all 0.5 ⇒ `void`; a UMA status saying proposed/disputed/challenged ⇒ wait; anything else (e.g. 0.9995) ⇒ wait for the next run. `resolved_at` is the detection time, not Gamma's close time. Not used: CLOB `tokens[].winner` (would need a second API). Only `active` forecasts become `resolved`; superseded/withdrawn keep their status and get `outcome`/Brier/skill (they are scored); `void` applies to every forecast on the market. **Amended in review:** **confirmation before scoring**: until the UMA field names are verified, a final result (0/1 or 50-50) is scored at once only when `umaResolutionStatus` says resolved/settled; otherwise the same result must be seen on scorer runs **≥ 24 h apart** (stored in `market_cache.resolution_seen[_at]`; a different result or a reopened market restarts the wait). `resolved_at` is the first sighting, which also decides "resolved before day 7" for convergence; no 7-day mid is captured on a closed market. | One reliable field set; never score a provisional price. | `parseResolution` in `electron/ledger/scoring.ts`. |
| R55 | 2a | **Convergence capture**: the hourly scorer records `price_at_7d` (CLOB mid) for unresolved forecasts once 7 days have passed — up to an hour late, or later if the app was down; the actual capture time is stored (`price_at_7d_at`). A forecast resolved before day 7 gets the resolution price (0/1). One resolved after day 7 without a capture gets no convergence value. Convergence votes are timed by capture. | Spec §6.2 leaves timing open. | `LedgerService.runUnsafe`. |
| R56 | 2a, amended 2a review | **Forecast input**: strict (unknown keys such as prices, `createdAt` or `tradeable` are rejected, not ignored); `sources` = up to 50 http(s) URLs (may be empty); markets settling in > 90 days are rejected (no bucket); a two-sided CLOB book is required (mid = (bid + ask) / 2); `liquidity_usd` = Gamma `liquidityNum` (book liquidity, not 24 h volume); `event_id` falls back to the market id. `tradeable` = bucket is `trading` **and** the category is in the mandate allow list at insert; a forecast written while shadow stays untradeable (re-submit after the bucket trades). **Amended in review:** **baseline gates**: a forecast is rejected when the spread is > min(0.10, `limits.per_market.max_spread`), when 24 h volume is below max(`mandate.markets.min_liquidity_usd`, `limits.per_market.min_liquidity_usd`) (same measure as the engine's liquidity check), when the market has **any** UMA status (proposed/disputed/resolved) or a recorded dispute, or when the mandate is unavailable. A token's active forecast can be **superseded only after 6 h** (clear error with the earliest time; withdrawing is always allowed, and after a withdrawal a new forecast may be written at once). The stored `tradeable` is the insert-time value only (see R62). | Spec §6.1. | `SubmitForecastSchema`, `LedgerService.submitForecast`. |
| R57 | 2a | **Rights rules (interpretations of §6.3)**: only `allow` categories can trade (later, deny and unlisted never; a trading bucket whose category leaves `allow` goes back to `shadow`, allocation 0). Suspension: mean skill of the last min(20, n) event votes (by resolution time) < 0 ⇒ `suspended`, allocation 0. Re-qualification: events scored after the suspension only, same threshold (30, medium 20 if short trades) and lower bound > 0 ⇒ allocation back to 50. Allocation = 50 + 50 per further 20 events since (re)qualifying while lb > 0, never reduced while trading except by a lower budget, capped by `mandate.budget_usd`. Deprioritised only from `shadow` and left only by a human. Bootstrap seeded per bucket (FNV-1a of `category\|bucket`) so bounds are reproducible. **Human force** (`ledger:setRightsState`, main window only, audited, Telegram): sets a `forced` flag that blocks automatic promotion and deprioritisation (suspension and the mandate rule still apply); forcing `trading` is refused outside `allow` and starts at max(current, 50); `auto` clears the flag. With an invalid config the stats update but rights never change. Loss-limit suspension is a hook (`suspendForLoss`), not called until ledger-driven P&L per category exists. | Spec §6.3 leaves these open. | `decideRights` in `electron/ledger/scoring.ts`, `LedgerService.forceRightsState`. |
| R58 | 2a | **Ledger-driven orders**: the forecast's (category, bucket) is the one fixed at forecast time; only an `active` **tradeable** forecast resolves (else `forecast_unavailable`); the complementary token of a binary market uses 1 − p. Bucket exposure = the **whole** cost basis of every in-scope position a ledger-driven buy in that bucket filled into (even if part was bought without a forecast) + unfilled notional of open ledger-driven buys. | Conservative. | `DbRiskStateProvider.getCategoryBucket`, `LedgerService.get`. |
| R59 | 2a | **Ledger services run before unlock** (Phase A, like halts): scorer hourly (first run at start), market refresh every 30 min; IPC `ledger:list`, `ledger:stats`, `markets:get` are unrestricted, the writes main-window only with actor `human`. No UI (3c). | They need no wallet keys. | `electron/main.ts`. |
| R60 | 2a review | **Stats weighting (anti-dilution)**: within an event, each token's forecast versions are weighted by how long each was active (creation → superseded / withdrawn / resolved, capped at the market end, stored as `forecasts.active_until`); the event vote is the mean over its tokens. Withdrawn versions keep their full active time. Versions with |p − m| < 0.02 are excluded from skill and convergence stats (still scored and shown). Combined with the 6 h supersede interval (R56), quick re-forecasts at the mid cannot dilute a bad call (test: one −0.56 call stays −0.56). | Reviewer C1: the plain mean let 9 supersedes dilute a call tenfold. | `eventVotes`, `activeWeight` in `scoring.ts`; `bucketVotes` in `LedgerService.ts`. |
| R61 | 2a review | **Entering trading** (shadow → trading, and suspended → trading) also requires mean skill of the last 20 counted events ≥ 0. Re-qualification after a suspension counts only events whose forecasts **all** resolved after the suspension (`EventVote.firstAt`). Amends R57. | Reviewer S3/N4. | `decideRights`. |
| R62 | 2a review | **Live `tradeable`**: `ctx.ledger` returns each forecast with its bucket's current `bucketState` and `tradeable` computed now (active, bucket `trading`, category in the mandate allow list); `tradeableAtForecast` keeps the insert-time flag. The order path uses the same live rule (a forecast written while the bucket was shadow can back orders once it trades; the engine still checks the bucket state and allocation). Amends R56/R58. | Reviewer N3; one rule for bots and orders. | `LedgerService.liveRights`, `RpcHandler` `ledger:*`. |

| R63 | 2b | **Reconciler runs after unlock only** (it needs wallet keys for the CLOB), every 60 s, whether or not bots run; a cycle is skipped while the previous one runs. A run is "ok" only if every lookup answered; only then is `risk_state.reconciled_at` (global row) set. **Reconciler outage never halts**: 5 consecutive incomplete runs ⇒ one Telegram alert (high) + audit, and a "recovered" alert when a run succeeds again. Recovered fills are emitted to the fill notifier like OrderService fills. | Spec §13; a Data API outage must not stop trading by itself, but must be visible. | `electron/reconcile/Reconciler.ts` `afterRun`, `RECONCILER_FAILURE_ALERT`. |
| R64 | 2b, amended 2b review | **Unknown-outcome search.** Polymarket (no client order id): the wallet's CLOB open orders and trades in the token (`after` = submit − 60 s) are grouped per exchange order (taker trades by `taker_order_id`; maker fills via `maker_orders` whose `maker_address` is the wallet's proxy/EOA). A market order matches a taker order of the same side whose first match is within [submit − 60 s, submit + 10 min] and that spent the same USD (±2 %, buys) or sold the same size (sells) at the risk-checked worst price or better; a limit order matches an open order with the same side/price/original size created in that window, or trades at its price (maker) / price or better (taker) not exceeding its size. Exchange ids already linked to another row are excluded. **Exactly one** candidate ⇒ linked (`exchange_order_id`), state from `getOrder` (else from the trades), fills recorded (taker fee for marketable orders). **Several** ⇒ left open, audited `reconcile.order_ambiguous` and notified once (resolve by hand). **None** with both lookups answered and past `expires_at` + 60 s (market orders: submit + 5 min + 60 s) ⇒ `expired`. Binance: `GET /api/v3/order?origClientOrderId=<orders.id>`; only error code −2013 ("order does not exist") counts as absent. CLOB `getTrades` `after` (seconds) and `maker_orders` semantics are **unverified**. **Amended in review:** rows `submitted` with no exchange id younger than **2 minutes** are skipped (OrderService may still be waiting for the answer); an exchange id (or wallet order/trade) already held by another row is never linked, and `orders(exchange, exchange_order_id)` is unique where not null (R75). The row's own `wallet_id` decides which wallet is searched (R77). | R11 left filled unknown-outcome orders lost after 5 min. | `Reconciler.findPolymarketOrder`, `aggregateMatchesRow`, `queryBinanceOrder`. |
| R65 | 2b | **Orphan orders are cancelled every run**: open live orders (with an exchange id) of a bot that is halted (bot or global) or not running with a live OrderService are cancelled through `OrderCanceller` (as at startup, R19). This changes R31's "open orders are left as on a normal stop": a stopped bot's resting orders now live at most ~60 s. | Spec task: consistent with startup recovery; nobody watches a stopped bot's orders. | `Reconciler.cancelOrphans`; pass `isBotRunning: () => true` to disable. |
| R66 | 2b, amended 2b review | **Position comparison.** Per wallet: Data API `positions?user=<proxy or EOA>` vs the sum of order-linked live positions of the bots **currently assigned to that wallet** (`bots.wallet_id`). Skipped: tokens in markets the cache shows `closed`, and positions the Data API marks `redeemable` (handled by R69). A difference is a mismatch only if it is > 0.01 tokens **and** > $0.50; value = difference × Data API `curPrice`, else local average cost, else $1/share. Both directions count (exchange larger, or local larger). Debounce per (wallet, token, direction): only mismatches seen on **2 consecutive runs** count toward the halt; a wallet whose orders or positions could not be read this run keeps its counts. Sum of such unexplained values **> `limits.reconcile.max_unexplained_usd`** (default 10, strictly greater) ⇒ **kill switch** (global halt + cancel + stop; R17), reason `reconciliation: unexplained exposure …`. New mismatch keys ⇒ audit `reconcile.mismatch` + Telegram (not repeated every run); all gone ⇒ `reconcile.mismatch_cleared`. Positions of **deleted bots** have no wallet any more and show up as exchange excess (adopt them into another bot). Manual trading on a bot wallet after its first order halts (dedicated wallets assumed). Data API field names unverified. **Amended in review:** local positions are grouped by the wallet stored on each fill (`bot_trades.wallet_id`, else the bot's current wallet), so deleted bots' and moved bots' holdings stay on the wallet they were bought with (R77). A Polymarket `local_excess` is tolerated up to max(0.01 tokens, 1 % of the local position) (R79). | Spec §13: exchange is the source of truth for positions. | `Reconciler.checkPositions`, `polymarketDiffs`, `DUST_*`, `MISMATCH_RUNS_TO_HALT`. |
| R67 | 2b, amended 2b review | **Pre-existing positions (R8).** For exchange excess, the wallet's Data API trade history in that market (`trades?user=&market=`) gives the quantity held before the wallet's first non-rejected live order; that part only **warns** (audit result `warning: pre-existing…`, Telegram), the rest can halt. A wallet with no live order at all: everything is pre-existing. History lookup failure ⇒ treated as new (fail closed). **Adoption** (`reconcile:adoptPositions(walletId, botId)`, main window only, actor human, audited `reconcile.adopt`): every current exchange-excess position of the wallet becomes an `adopted` BUY fill of that bot (order id `adopt:<uuid>`), priced at the Data API `curPrice` (else `avgPrice`; neither ⇒ skipped), so daily P&L starts from the current price (gains/losses before adoption are not today's P&L). Min hold time counts from adoption; the bot's market scope still applies to selling. Adopted and resolution fills do not count as ramp fills. **Amended in review:** "first order" excludes `failed` as well as `rejected_risk` orders. Adoption now (1) syncs the wallet's orders first and refuses if that sync fails, (2) refuses while the wallet has an open live order with no exchange id (unknown outcome, incl. ambiguous), (3) refuses retired or halted bots, (4) adopts per token at most the quantity held before the wallet's first order minus what was already adopted (history unreadable ⇒ refused); the rest only with `includePostFirstOrder: true`, which is audited (R78). | Pre-v3 positions must not halt the app forever, but must become visible and sellable. | `Reconciler.adoptPositions`, `heldBefore`; `RiskMonitor.runRamp`. |
| R68 | 2b | **Binance balances**: only "local larger than the account" is a mismatch (valued at the Binance price, else average cost; $0.50 dust). Exchange holdings above the bots' positions are **not** flagged: the account may hold the human's own coins. Without credentials but with bot holdings, the run is incomplete (R63). Fees paid in the base asset (R13) can accumulate into a mismatch. | Avoid halting on the human's own coins. | `Reconciler.binanceDiffs`. |
| R69 | 2b | **Resolved markets**: confirmation as in R54 (shared `checkResolution` in `scoring.ts`; the reconciler also advances `resolution_seen[_at]` for held markets, so held markets need the 24 h double sighting unless UMA says settled). Then every order-linked position (live **and** paper) in the market is closed by a `resolution` SELL at the payout (1/0; void = 0.5) with order id `resolve:<marketId>`, in a transaction that re-reads the position (closed once). Realized P&L (payout × qty − cost) is audited `reconcile.position_resolved`; daily P&L sees the payout as sale proceeds. **Redemption on-chain is not done** (redeem by hand); paper bots' `PaperTradingState` balances are not credited. | Spec task: resolved positions must stop counting as exposure. | `Reconciler.resolveMarkets`. |
| R70 | 2b, amended 2b review | **Clock skew guard**: every run, CLOB `GET /time` (else Binance `/api/v3/time`); skew = server − round-trip midpoint, reduced by half the round trip. > 5 s ⇒ OrderService rejects new **live** orders with step-0 check `clock_skew` (paper unaffected) until a later run sees ≤ 5 s; audited `reconcile.clock_skew` / `reconcile.clock_ok` and notified once per episode. A failed time lookup keeps the previous state. Before the first successful check (the reconciler's first run starts at unlock) orders are allowed. **Amended in review:** no successful clock check for **3 minutes** (counted from the reconciler's creation) ⇒ live orders refused with `clock_unverified` (audited + notified once); CLOB `/time` is whole seconds, so it gets 1 s extra tolerance; no round-trip slack when the round trip exceeds 2 s. | Spec §15. | `Reconciler.checkClock`, `MAX_CLOCK_SKEW_MS`; `OrderServiceDeps.clock`. |
| R71 | 2b | **Recorder settings live in `server.yaml`** (`recorder.enabled`, `interval_seconds` 60 (10–3600), `max_tokens` 200; operational, so `neutral` like other server keys, re-read every cycle). Watch set, in priority order under the cap: tokens held (live or paper order-linked), active forecasts, `market_ids` of non-retired enabled bots (unscoped bots contribute nothing; markets resolved through the market cache), `recorder_watchlist` (IPC `recorder:watchlistAdd/Remove/List`, main window, audited). Runs before unlock (public endpoints). ≤ 4 `/book` requests in flight (10 s timeout), cycle skipped if the previous one runs, failures logged (rate-limited). Rows: `ts` = ms INTEGER, levels = deflated JSON `[[price, size], …]` top 10, `last_trade_price` from the `/book` response if present. Retention hourly: rows older than 180 days keep the last snapshot per token per 15-minute bucket. | Spec §10 says "configurable" without a file; it is not a risk limit. | `electron/recorder/`, `ServerSchema.recorder`. |
| R72 | 2b | **Snapshot backtests** (`backtest:run` with `source: 'polymarket-snapshots'`, `tokenIds`, time range; default `binance-klines` unchanged). Steps = recorder cycles (a token re-appearing starts a step); the bot sees per token only the latest snapshot ≤ sim time. Marketable `ctx.buy/sell` are fill-or-kill against recorded depth up to the worst price (taken depth is gone until the token's next snapshot); taker fee = FeeService rate (market cache fee category, unknown ⇒ highest) × notional. `placeLimit` is post-only by default (crossing ⇒ `post_only`); a resting buy fills **in full at its price** when a **later** snapshot's best ask ≤ its price, a sell when best bid ≥ its price (the task's "bid ≤ our ask for sells" read as the bid reaching our ask); maker fee; TTL capped by `orders.resting_order_ttl_minutes`; cash/shares reserved. No queue position, partial resting fills, risk engine, ledger, Binance or fetch in this mode. Max 300 000 snapshots / 50 tokens per run. | Simple and deterministic, as asked. | `electron/backtest/snapshotSimulate.ts`. |
| R73 | 2b | **`limits.reconcile` is optional on hot reload** (unlike the other sections): limits files written before 2b reload with the default `max_unexplained_usd: 10`; raising it is classified `raises`. | Otherwise every existing `limits.yaml` would be rejected as truncated. | `REQUIRED_SECTIONS` in `ConfigService.ts`. |
| R74 | 2b | **Shared fill path**: `applyExchangeOrderState` (`electron/orders/orderFills.ts`) is used by OrderService and the Reconciler (fresh-row transaction, delta over `filled_size`). A marketable **buy** is no longer capped at `orders.size` (USD-sized: shares = amount ÷ fill price ≥ amount ÷ worst price); everything else still is. A reported total notional (Binance `cummulativeQuoteQty`, summed trades) prices the delta; otherwise the order price. | One code path for exactly-once fills. | `orderFills.ts`. |
| R75 | 2b review | **Placement answers go through the shared fresh-row path** (`applyPlacementResult`): OrderService re-reads the row in the transaction, leaves a terminal row (e.g. settled by the Reconciler while the request was in flight) untouched, records only the fill beyond what is stored, never moves the status backwards and never copies an exchange id another row holds. Migration adds a **partial unique index** on `orders(exchange, exchange_order_id)`; if existing rows already share an id the index is not created and the conflict is logged (rows are never rewritten; fix by hand). | Reviewer C1: the Reconciler and an in-flight placement could both record the same fill. | `electron/orders/orderFills.ts`, `ensureUniqueExchangeOrderIds` in `database/index.ts`. |
| R76 | 2b review | **Downsampling is bounded and batched**: the "later row in the same bucket" check is limited to that bucket (one primary-key probe per row); only rows newer than the previous cutoff minus one bucket are examined (cutoff kept in `recorder_state`); 5 000 rows per DELETE with the event loop yielding between batches. A year of 1-minute rows for 3 tokens takes a few seconds in the test. | Reviewer S1: quadratic scan blocking the main thread. | `OrderbookSnapshotRepository.downsampleBatch`, `Recorder.runRetentionIfDue`. |
| R77 | 2b review | **Wallet attribution**: `orders.wallet_id` and `bot_trades.wallet_id` are set at creation (default: the order's wallet, else the bot's current wallet); pre-existing rows are backfilled with their bot's **current** wallet (wrong for a bot that already changed wallets — none should have). `bots:update` refuses a wallet change while the bot has open live orders or live positions. | Reviewer S3: a wallet change moved positions between wallets in the comparison. | `OrderRepository.create`, `BotTradeRepository.getLiveWalletPositions`, `walletChangeBlocker` in `botHandlers.ts`. |
| R78 | 2b review | **Adoption safeguards** (see R67): sync first, refuse with unknown-outcome orders, retired/halted bots refused, per-token cap = held before the first order − already adopted; `includePostFirstOrder` adopts the rest and is audited with the post-first-order quantity. | Reviewer S2: adoption could turn an unexplained fill into a sellable position. | `Reconciler.adoptPositions`. |
| R79 | 2b review | **Polymarket fee in shares — VERIFY against live data.** Until it is known whether the CLOB takes the taker fee in shares (local fills would then exceed the wallet), a `local_excess` up to max(0.01 tokens, 1 % of the local position) is not a mismatch. If fees are in USDC, drop the tolerance; if in shares, record fills net of the fee instead. | Avoid halting on our own fee model. | `LOCAL_EXCESS_FEE_TOLERANCE` in `Reconciler.ts`. |
| R80 | 2b review | **Snapshot backtests: resting fills consume depth** — a resting order that fills against a snapshot removes the recorded liquidity at or through its price for that step (up to its size), so a marketable order in the same step cannot take it again. | Reviewer N3. | `SnapshotMarket.settleResting`. |
| R81 | 3a | **One npm package, no workspaces, no `@botlab/core` alias**: `packages/core/src` is imported by relative path (`electron/` → `../packages/core/src/...`). `packages/core/tsconfig.json` typechecks core alone (`npm run typecheck` = core + electron, also in CI); the Electron build still compiles both with `electron/tsconfig.json` into `dist-electron/{electron,packages/core/src}`. | `tsc` does not rewrite path aliases in CommonJS output and the Electron app runs the compiled JS; workspaces would need core built to JS first. Nothing to gain before 3b. | In 3b: npm workspaces (`packages/core` as `@botlab/core`) plus a bundler/tsx for `apps/server`, then replace the relative imports. |
| R82 | 3a | **Layout choices**: templates at repo root `templates/` (spec §1.1; seed looks in `templatesDir`, then 4 and 5 levels above `db/` for source and compiled output, then `<cwd>/templates`; packaged via `electron-builder` `files`). `sdk/binance.ts` → `exchange/binance/client.ts`, `sdk/trading.ts` → `exchange/polymarket/trading.ts`, `claudeSystemPrompt.ts` → `sdk/guide.ts` (the script-writing guide, still used by the AI assistant; the agent can be given it later), `sdk/claude.ts` stays in Electron (`electron/ai/`). `src/core` → `bots/`, `src/utils` → `utils/`, `electron/ipc/types.ts` → `services/types.ts` (DTOs). | Spec §1.1 subfolders; choke-point ESLint rules and the static test now name the new adapter paths. | `git mv` back; update `eslint.config.mjs` and `tests/orders/choke-point.test.ts`. |
| R83 | 3a | **Worker entries**: `resolveWorkerEntry(__dirname, name)` returns `<name>.js` next to the module, else `<name>.ts` (a worker inherits the parent's `execArgv`, so a tsx loader carries over). Verified for compiled output only (a compiled core started a paper bot's worker and found the templates); running from `.ts` under tsx is untested (tsx is not installed). | Spec §15.2; 3b's dev server will run from sources. | `packages/core/src/runtime/workerPath.ts`. |
| R84 | 3a | **Service errors and input checks**: services throw `ServiceError(code, message)` (`invalid_input`, `not_found`, `locked`, `unavailable`, `conflict`); IPC returns the same `{ success: false, error: message }` with the messages it had before. `services/schemas.ts` checks shape and types only, strips unknown keys and leaves value rules (and their messages) to the services; a wrongly typed IPC argument now fails with `Invalid input: <path>: <issue>` instead of reaching a repository. Inputs whose services already validate (config files, adoption, watchlist, ledger writes, backtest required fields) are passed through as before; their typed schemas are for HTTP/MCP. | Spec §8.1: one set of zod schemas for IPC, HTTP and MCP. | Drop `parseInput` calls in `electron/ipc/handlers/*`. |
| R85 | 3a | **Lifecycle in core**: `createCore` (DB + construction, no timers), `start()` (old Phase A), `unlock(key)` (old Phase B; returns false if already unlocked), `shutdown({ timeoutMs })` (old graceful path, `{ clean }`), `close()`. Services exist from `createCore`; those needing keys throw `locked` before unlock. Electron still registers bot/wallet IPC only after unlock, as before. One change: the clean-shutdown marker is also skipped when the timeout fires during the notifications/Telegram/config-watcher stop (before, only when it had fired before that phase). DB handle and `keyManager` stay module singletons ⇒ one core per process. | Spec §1.2; 3b's server calls `createCore` + `start` + `unlock(env key)`. | `packages/core/src/core.ts`; for several cores per process make the DB handle and key instance-scoped. |
| R86 | 3a | **`.botlab` export/import on contents**: `ScriptService.exportScript(id)` returns `{ fileName, file }`, `importScripts([{ name, content }], actor)` imports; the Electron handler keeps the save/open dialogs and file I/O. Unreadable files are listed in `errors` before parse/compile errors (before, in file order). | Transport-free core; HTTP will upload/download. | `electron/ipc/handlers/scriptHandlers.ts`. |
| R87 | 3a | **DB default path** without `createCore`: `BOTLAB_DATA_DIR` else `<cwd>/data` (the `require('electron')` probe is gone; Electron passes `app.getPath('userData')` as before, so the DB location does not change). | Core must not import electron. | `getDbPath` in `packages/core/src/db/index.ts`. |

## Log

### 2026-10-30 — chunk 1a
Done: `.gitattributes` (LF), GitHub Actions CI (ubuntu/macos/windows × Node 22: `npm ci`, lint, typecheck, tests with
`SKIP_NETWORK_TESTS=1`, `ELECTRON_SKIP_BINARY_DOWNLOAD=1`), config system, RiskEngine, `orders`/`risk_state` tables, bot ramp columns.

Files:
- `electron/config/` — `schema.ts` (zod schemas for limits/mandate, spec defaults, cross-file validation), `loader.ts`
  (`loadConfig()`; `BOTLAB_CONFIG_DIR` or `<cwd>/config`; writes defaults when missing; throws `ConfigError`), `defaults.ts`.
- `config/limits.example.yaml`, `config/mandate.example.yaml` (real `config/*.yaml` gitignored).
- `electron/risk/` — `RiskEngine.ts` (pure §4.1 steps 1–7, fail-fast, `RiskDecision` for `orders.risk_decision`), `types.ts`
  (`OrderRequest`, `RiskStateSnapshot`, `RiskStateProvider`).
- `electron/database/index.ts` migrations: `orders`, `risk_state` (scope `'global'` or bot id), bots `stage` (default `full`),
  `allocation_usd`, `created_by` (default `human`), `market_ids`, `strategy`, `paused_by`, `retire_reason`.
- `electron/database/repositories/OrderRepository.ts`, `RiskStateRepository.ts`.
- Tests: `tests/config/config.test.ts`, `tests/risk/risk-engine.test.ts` (table-driven), `tests/risk/risk-engine.property.test.ts` (fast-check).
- Lint now exits 0: fixed the 7 errors; root eslint ignores `dist-electron/`, `release/` and `web/client/` (which has its own
  eslint config with the React rules). `tests/copytrading/1-polymarket-data-api.test.ts` skips under `SKIP_NETWORK_TESTS`.
  The fixed no-op assertion in `script-runner.test.ts` was wrong; replaced with a not-throw check.

Interpretations / deviations from spec:
- Step 2 market checks: category, ambiguity, rules-changed and liquidity apply to **buys only**, so exits stay possible
  (the position manager must be able to exit on ambiguity ≥ 2 / rules change, §9.2). Market scope applies to all orders;
  the end-of-market buffer applies to sells too except `riskExit` sells. (Risk-exit exemptions: see review fixes below.)
- `bots.market_ids = null` means unscoped (existing human bots); `[]` allows nothing.
- `bots.allocation_usd` can only lower the configured allocation, never raise it.
- Liquidity check (`max(per_market.min_liquidity_usd, mandate.markets.min_liquidity_usd)`) added to step 2; the spec lists
  the limit but not the check.
- Step 5 sells: a sell passes only if size ≤ the bot's held position minus its resting sells (that is what "reduces exposure" means).
- Ledger-driven buys also require the (category, horizon) bucket to be in `trading` state.
- Step 7 edge is directional (buy: p − price, sell: price − p) rather than `|p − price|`, so buying above the forecast fails.
  Expected fee = taker rate × price for marketable orders, 0 for resting (maker) orders; chunk 1b's FeeService supplies the rate.
- Long horizon = days > 30, a fixed constant (`LONG_HORIZON_DAYS`, same boundary as `horizonBucket()`), not taken from the
  mandate. The schema requires `resolves_within_days[1] ≤ 30` and `long_horizon_days` within 30–90; the 90-day hard cap is
  a constant. Unknown end date ⇒ buys rejected.
- Binance: step 2 is `binance.enabled` + market scope; step 3 is `binance.max_order_usd` only (no price-range/spread/slippage);
  bot allocation capped at `binance.allocation_usd`; total-exposure check uses whatever totals the provider supplies.
- Spread, slippage and depth checks apply to all Polymarket orders (incl. risk exits), per spec step 3; depth only for marketable orders.

### 2026-10-30 — chunk 1a review fixes
- Notional consistency (`notionalUsd ≥ price × size`) now enforced for **all** order types; previously a market order
  could understate its notional and slip past every USD limit.
- Long horizon fixed at 30 days (see deviation note above); a mandate of `[0, 90]` is now a config error instead of
  silently disabling the long-horizon cap.
- New step 0 `state_invalid`: exposures, counts, equity, position (size, open sells, open time), category-bucket values,
  market fee rate and book fields must be finite and ≥ 0, and `market.tokenId` must equal the order's token.
- Sells are netted against resting sells: `position.openSellSize` added to the snapshot.
- Crossed book (bid > ask) fails the spread check.
- **Risk exits** (sells flagged `riskExit`): exempt from `max_order_usd`, `max_orders_per_hour`, `max_open_orders`,
  `max_spread`, the end-of-market buffer and hold time. Still required: market scope, held position net of open sells,
  price range [0.01, 0.99], and `max_slippage` / top-of-book when marketable. `riskExit` on a buy grants nothing.
- Config loader: all fs errors are wrapped in `ConfigError`; `resolveConfigDir()` replaces `getConfigDir()`:
  `BOTLAB_CONFIG_DIR`, else in production the OS app-data dir (§15.2) + `/config`, else `<cwd>/config`.
- `risk_state` timestamps are ISO everywhere (including `updated_at`).
- Deferred to 1b: requiring a forecast for forecast-strategy bots.

### 2026-10-30 — chunk 1b
Done: OrderService choke point for every bot order (live and paper, both exchanges), repository-backed risk state,
Polymarket GTD limit orders + cancels, fee table, ctx API v2 additions, forecast-required rule, static choke-point test.

Files:
- `electron/orders/OrderService.ts` — per-bot service. Flow: validate → market context (Gamma metadata + CLOB book +
  fee category + placeholder quality) → pre-checks (`post_only`, `forecast_unavailable`, `market_data_unavailable`,
  `unsupported_symbol`, recorded as step-0 decisions) → **process-wide lock**: `DbRiskStateProvider.getSnapshot` →
  `RiskEngine.check` → insert `orders` row (`rejected_risk` + decision, or `submitted`) → unlock → exchange adapter (live)
  or `PaperTradingState` (paper) → in one transaction update the row (exchange id, status, fill size, avg price, fee) and
  insert the `bot_trades` fill (`order_id`, `condition_id`, `fee_usd`, `category`). Rejections come back as
  `{ ok: false, status: 'rejected_risk', failedCheck, error }`. Also `cancel`/`cancelAll`/`getOpenOrders` (own bot only;
  another bot's order id reads as "not found"), `getFee`, `getBudget`, and a best-effort `syncOpenOrders` that pulls
  resting-order fills/cancels from the CLOB before each placement and on `getOpenOrders`/cancel.
- `electron/orders/DbRiskStateProvider.ts` — snapshot from SQLite: halts (`risk_state`), bot stage/allocation/market_ids/
  strategy (`bots`; unparseable `market_ids` ⇒ `[]`), exposures (positions' average-cost basis + unfilled open buy
  notional; long-horizon uses market end dates, unknown ⇒ long), orders in the last hour (incl. rejections), open orders,
  position (net size, open sells, opened = first buy since last flat), equity (see R7). External lookups time out at 10 s.
- `electron/orders/MarketDataService.ts` — Gamma `/markets?clob_token_ids=` lookup (5 min cache), mandate-category
  placeholder (R5), `PlaceholderMarketQualityProvider` (R4).
- `electron/orders/FeeService.ts` + `config/fees.example.yaml` — zod schema, defaults, `loadFees`, label → fee category.
- `electron/orders/ExchangeAdapter.ts` — `PolymarketAdapter`/`BinanceAdapter` interfaces and the live implementations.
- `electron/exchange/polymarket/orders.ts` — the only module calling `createOrder`/`createMarketOrder`/`postOrder`:
  FOK market orders, GTD limit orders (`expiration = expiresAt + 60 s` security buffer per CLOB docs — verify),
  `cancelOrders`, `getOrder`; distinguishes definite rejection from unknown outcome. Polymarket has no client order id,
  so idempotency there rests on the row being written before the call.
- `electron/sdk/binance.ts` — `newClientOrderId` = `orders.id`; HTTP 5xx / network errors flagged `outcomeUnknown`.
- `electron/sdk/trading.ts` — `executeBuy`/`executeSell` removed (read-only helpers remain).
- `electron/runtime/RpcHandler.ts` — all order methods go through OrderService (missing ⇒ error); new RPCs
  `polymarket:placeLimit|cancel|cancelAll|getOpenOrders|getFee`, `risk:getBudget`; `recordTrade` strips order linkage.
- `electron/runtime/BotContextProxy.ts`, `electron/sdk/types.ts` — `ctx.polymarket.{placeLimit,cancel,cancelAll,
  getOpenOrders,getFee}`, `ctx.risk.getBudget()`, `OrderOpts.{minPrice,reason,forecastId,riskExit}`, `TradeResult`
  gains `orderId`/`status`/`failedCheck`.
- `src/core/BotManager.ts` — loads config + fees once in `initialize()`, builds each bot's OrderService
  (`createOrderService` factory passed via `ScriptBotRunner`); `electron/main.ts` passes db + order/risk repos.
- `electron/risk/` — `BotRiskInfo.strategy`; new step-1 check `forecast_required` (forecast-strategy bots cannot buy
  without a forecast); new step-0 check names for OrderService pre-checks.
- DB migrations: `orders.simulated`; `bot_trades.order_id`, `fee_usd`, `category` (+ index).
- Tests: `tests/orders/order-service.test.ts` (fake adapters + in-memory SQLite), `db-risk-state-provider.test.ts`,
  `choke-point.test.ts`, `fee-service.test.ts`, `market-data.test.ts`; RpcHandler tests rewritten for the new routing;
  risk-engine table rows for `forecast_required`. DB tests skip with a warning if better-sqlite3 is built for Electron.

Not done / stubbed (see Decisions R4–R14):
- Ledger (`ForecastSource` = `NoForecastSource`), category rights (`categoryBucket: null`), ambiguity/rules-change,
  `categories.yaml` mapping — chunk 2a. Ledger-driven orders are therefore always rejected.
- Reconciler (fills of other bots' resting orders, unknown outcomes, resolved positions that still count as exposure,
  orders the exchange no longer returns) — chunk 2b. `ctx.polymarket.getMarket` (§5.2) not added.
- Rejection notifications (> 10/hour/bot) — chunk 1e. Halts/kill switch cancelling orders — chunk 1c.

### 2026-10-31 — chunk 1b review fixes
- **CLOB HTTP errors**: `interpretPostResponse` treats only 4xx (except 408/425/429) as rejected; 5xx, 408/425/429 and
  responses without a status are unknown outcomes (row stays `submitted`). Binance uses the same rule.
- **Double-recorded fills**: `applyExchangeState` re-reads the order inside its transaction and computes the fill delta
  from the fresh `filled_size`; syncs and cancels are serialised per bot (`botLock`). Test runs sync, placement, a
  second runner's sync and a cancel concurrently and checks the 5-share fill is recorded once.
- **Cash cache**: dropped after every fill (`DbRiskStateProvider.invalidateCash`), so three buys keep equity at 1000
  instead of drifting up (amended R7).
- **Equity for buys only**: sells skip the cash read and `RiskEngine` validates `equityUsd` for buys only, so exits work
  when the balance cannot be read (amended R7).
- **Order lifecycle** (amended R11): GTD expiry with final fill check, expiry when the exchange no longer returns an
  expired order, FOK `unmatched` ⇒ `cancelled`, 5-minute lifetime for market orders with unknown/delayed outcome,
  `cancelAll` returns `{ cancelled, failed, unknownOutcome }` and only throws on real failures.
- **Choke point in ESLint** (`eslint.config.mjs`): `@typescript-eslint/no-restricted-imports` forbids value imports of
  `@polymarket/clob-client` / `@polymarket/order-utils` outside the adapters, OrderService and BotManager, and imports of
  `exchange/polymarket/orders` or `executeBinanceBuy/Sell` outside `ExchangeAdapter.ts`; `no-restricted-syntax` forbids
  `.postOrder` / `.postOrders` / `.createOrder` / `.createMarketOrder` / `.createAndPost*` (also `['…']` access) and
  Binance order endpoint strings (`/api/v3/order`, `/api/v3/orderList`, `/api/v3/sor/order`, `/sapi/v1/margin/order`)
  outside the adapter modules. The vitest scan keeps running (it also covers `web/client`) and now lints a probe file
  through ESLint to prove the rules fire. `sdk/trading.ts` now uses a type-only clob-client import.
- **Paper fills**: the risk-checked price is passed to `simulateBuy` (`maxPrice`) and `simulateSell` (new `minPrice`
  option); a partial paper fill is `partially_filled` and its remainder expires on the next sync.
- Nits: no fee recorded for unfilled orders (fee = rate × filled notional, amended R13); startup warning for unlinked
  live positions (R8).

### 2026-10-31 — chunk 1c
Done: audit log, daily P&L + loss limits (RiskMonitor), halts, kill switch, startup recovery (start halted after an
unclean shutdown, orphan-order cleanup), ramp stages with script versioning and promotion job.

Files:
- `electron/database/index.ts` — migrations: `audit_log` (+ append-only triggers), `risk_state` day marks / `last_halted_at` /
  probation drawdown tracking, `scripts.kind|origin|revision|trust|source_hash`, `script_versions`, `bots.template_version|
  stage_changed_at|last_error_at|reached_full_at`; builtin templates marked proven; version-1 rows backfilled; `getDataDir()`.
- `electron/database/repositories/AuditRepository.ts` (append + list only), `electron/audit/AuditService.ts` (never throws).
  Recorded: bot create/update/start/stop/delete/stage, script create/update/delete/trust, risk rejections (`order.rejected`,
  actor `bot:<id>`), halts set/cleared/denied, kill switch, config load (startup + BotManager), app start/shutdown, day reset,
  stale marks, monitor errors, startup orphan cleanup and status resets. Actors: `human` (IPC), `system`, `bot:<id>`, `agent` (later).
- `electron/risk/dailyPnl.ts` — pure daily P&L (R16). `electron/risk/RiskMonitor.ts` — 60 s job: marks, day reset, P&L into
  `risk_state`, per-bot and global loss limits, probation drawdown, ramp promotions, kill switch after 5 failed runs (R18).
- `electron/risk/HaltService.ts` — bot halt (flag, cancel, stop, cancel, audit, `risk:halt` event, full ⇒ probation on loss),
  human-only `clearHalt(scope, reason)`, flag-only global halt for startup, `getState()`.
  `electron/risk/KillSwitch.ts` — global halt + cancel every bot's open orders (running or not) + stop workers.
- `electron/orders/OrderCanceller.ts` — cancels a bot's open orders from the `orders` table using the running bot's
  OrderService or a cancel-only one (adapter for the bot's wallet); paper orders are marked cancelled; never throws.
- `electron/risk/StartupRecovery.ts` — shutdown marker, start-halted rule, orphan order sync + cancel (R19).
- `electron/risk/ramp.ts` — pure transition rules, initial stage, demotion, template proven (R20, R21).
- `electron/config` — `limits.server.start_halted_after_crash` (default true; example + defaults updated).
- `src/core/BotManager.ts` — refuses starts when halted / retired / during recovery; paper stage ⇒ paper mode; records
  runtime errors; keeps running bots' OrderServices; `getPolymarketAdapterForBot`; CLOB client cache keyed by mode (a paper
  bot's unauthenticated client was previously reused for live bots on the same wallet); audits start/stop.
- `electron/orders/OrderService.ts` audits rejections; `DbRiskStateProvider` sets `newTemplate` from the script's trust
  (smaller probation allocation); `MarketDataService` `bookMid` / `fetchPolymarketMid`.
- IPC: `electron/ipc/handlers/riskHandlers.ts` (`risk:getState`, `risk:clearHalt(scope, reason)`, `risk:killSwitch(reason)`;
  actor `human`), preload `risk.*` + `onRiskHalt`, `web/client/src/types/electron.d.ts`. `bots:create` sets the stage from the
  script's trust and records `template_version`; IPC bot/script payloads include `stage` / `origin|revision|trust`.
- `electron/main.ts` — audit/halts/kill switch/canceller in Phase A (before unlock), start-halted check, RiskMonitor and
  background startup recovery in Phase B; `before-quit` defers the quit until the monitor and bots are stopped, then writes
  the clean marker (20 s timeout ⇒ exit without it); SIGINT/SIGTERM/SIGBREAK quit gracefully.
- Tests: `tests/risk/daily-pnl.test.ts`, `ramp.test.ts` (table), `halts.test.ts` (loss halt end to end with a fake adapter,
  rejection of new orders, daily reset keeps halts, human-only clear, stale marks, global loss ⇒ kill switch, kill switch
  cancels non-running and paper bots' orders, append-only audit), `startup-ramp.test.ts` (marker, start halted, orphan
  cleanup, ramp promotions in the monitor, template proven, script versions); shared `riskHarness.ts`.

Not done / for later:
- UI for halts, kill switch, audit, stages (3c) — see R19 for clearing a halt meanwhile. `risk:halt` notifications (1e).
- Approvals table/UI (`approvals.new_template_live` only blocks). Retiring bots, un-retire (human only) — no API yet.
- Bots do not pin `template_version` when a script changes (R20).
- Reconciler (2b): fills of unknown-outcome orders and resolved markets still affect P&L only via recorded fills and marks.

### 2026-10-31 — chunk 1c review fixes
- **In-flight orders vs halts** (R24): an order the exchange accepts after a halt/kill switch is cancelled immediately and
  audited. Tests: the kill switch finishes while `postLimitOrder` is pending, and the same for a bot halt.
- **Script edits demote bots** (amended R20): every source change (IPC edit or seeding a changed builtin) sends the script's
  bots back to `paper`, audited per bot, in the revision-bump transaction. Test in `startup-ramp.test.ts`.
- **Day-start marks** (amended R16): no fallback to the moving last-known mark; missing ⇒ cost basis at the day start;
  day-start marks written once per day. Tests: the reviewer's 1000 @ 0.60 → 0.30 ⇒ −300 case (pure and in the monitor).
- **Start races** (R25): halt re-checked before and after the worker starts. Test: `tests/electron/bot-manager-halt.test.ts`.
- **Single instance** and graceful OS shutdown/log-off (R26); risk IPC sender check (R27).
- Nits: excess sells contribute zero P&L; loss baseline after a human clear (R23, test); paper days must actually be run
  (`bot_run_days`, amended R21, test).
- Migrations: `risk_state.day_live_pnl|day_paper_pnl|loss_baseline`, `bot_run_days`.

### 2026-10-31 — chunk 1d
Done: script sandbox hardening, allowlisted RPC fetch, tick watchdog, backtests in a worker, AES-256-GCM secrets with
migration, copy-trading sell hotfix (see Decisions R28–R34).

Files:
- `electron/runtime/compileScript.ts` — shared esbuild compiler (imports rejected); used by `scriptHandlers` (create, update,
  fork, import) and `seed.ts`.
- `electron/runtime/sandbox.ts` — worker heap limits, global hardening, `evaluateScript` (module/exports/ctx only).
- `electron/runtime/worker-bootstrap.ts` — hardens globals before evaluating; non-overlapping `onTick` with
  `tick-start`/`tick-end` messages.
- `electron/runtime/ScriptRunner.ts` — `env: {}`, `resourceLimits`, start timeout, tick watchdog, `fatal` event on
  unexpected exit; `bootstrapPath` option (tests). `ScriptBotRunner` → `BaseBotRunner.markFailed` → `BotManager.onBotFatal`
  (status `error`, error log, `bot.error` audit).
- `electron/runtime/scriptFetch.ts` + `RpcHandler` `fetch` + `BotContextProxy` Response-like wrapper; `limits.server.
  script_fetch_allowlist` (schema, defaults, example). `sdk/types.ts`: `ScriptFetchInit`, `ScriptResponse`, `fetch` RPC,
  tick messages. Script editor typings / API reference / AI prompt text updated.
- `electron/backtest/simulate.ts` (simulation loop + backtest ctx, moved from BacktestEngine), `backtest-worker.ts`,
  `BacktestEngine.ts` (worker + timeout, stores trades and stats).
- `electron/security/crypto.ts`, `migrateSecrets.ts`; CryptoJS replaced in `WalletManager`, `BotManager.getSettings`,
  `settingsHandlers`, `aiHandlers`; migration in `main.ts` Phase B; `crypto-js` + `@types/crypto-js` removed.
- `electron/scripts/templates/copy-trading.ts` — `copySellSize` (exported, pure), TRADE-only filter, sell path.
- Tests: `tests/sandbox/sandbox.test.ts` (compile rejection, templates compile, real worker: no require/process/fetch
  globals, empty env + heap limit, allowlisted fetch via mocked main-side fetch, redirect/size/timeout/method checks,
  watchdog for sync and async hangs, strike reset, clean stop), `backtest-worker.test.ts` (`while(true)` times out while the
  main loop keeps running), `crypto.test.ts` (round trip, tamper/wrong key, CryptoJS fixtures, idempotent migration,
  undecryptable row), `tests/copytrading/sell-sizing.test.ts`; `script-bot-runner` fatal test; worker tests bundle the
  entry with esbuild (`tests/sandbox/buildWorker.ts`).

Not done / for later:
- `botlab-sdk.d.ts` + `tsc --noEmit` type checking of scripts (§5.3).
- `server.yaml` (allowlist and `start_halted_after_crash` still in `limits.yaml`); `BOTLAB_MASTER_KEY` boot key and removal
  of the unlock screen / Claude key (§8.3, chunk 3b).
- Rest of copy trading v2 (limit orders, hash de-dup, pagination, leader filters, `copy_leaders`).

### 2026-10-31 — chunk 1d review fixes
- **Sandbox escape (critical)**: the reviewer ran `child_process` from a script via `Function("return import(...)")()`
  and `(0,eval)(...)`. Scripts now run in a `vm` context without string/wasm code generation or dynamic import, and the
  worker realm's code-generation routes are removed (amended R28). Same for the backtest worker. Tests:
  `tests/sandbox/escapeProbe.ts` (≈30 routes incl. `ctx.<method>.constructor`, promise/error/timer constructors,
  `Reflect.construct`, `globalThis.constructor.constructor`, `prepareStackTrace`, wasm) run in a real bot worker and a
  backtest worker; a control worker without the sandbox shows the probe does detect escapes.
- **Liveness** (amended R31): ping/pong every 30 s, 120 s silence ⇒ `worker_unresponsive`, bot `error`, audited. Tests:
  synchronous loop in a `ctx.setInterval` callback is terminated; an async-waiting worker is not; BotManager marks the bot
  `error` and audits.
- **ctx.fetch concurrency** (R35): max 6 in flight per bot, excess rejected immediately. Test.
- Nits: Copy Trading later-trade netting by index with same-second ordering fixed and dailyVolume counts buys only (R36,
  test); `crypto-js`/`@types/crypto-js` removed from `web/client` (package.json + lockfile).

### 2026-10-31 — chunk 1e
Done: ConfigService with hot reload, config history/restore and risk-raising detection; Telegram notifier, event wiring,
commands and daily digest; `server.yaml`; config IPC.

Files:
- `electron/config/ConfigService.ts` — owns `{limits, mandate, fees, server}`; chokidar watcher (500 ms debounce); `load()`,
  `reload()`, `write(file, value, actor)`, `restore(file, versionId, actor)`, `history(file)`, `onChange`/`onInvalid`,
  `getRedacted()`. Audit actions `config.changed` (per-file key diff with old/new/effect, redacted), `config.invalid`,
  `config.load`. `renderYaml` keeps comments.
- `electron/config/changes.ts` — `AppConfig`, `diffConfig`, `classifyChange(before, after)` (per changed key `raises | lowers | neutral`),
  `overallEffect`, redaction. `history.ts` — snapshot store. `serverSchema.ts` + `config/server.example.yaml` (real file gitignored by the existing `config/*.yaml` rule).
- Live consumers: `BotManager` (shared `RiskEngine.setConfig` + new `FeeService.setConfig`, so running bots' OrderServices see changes
  at once; recovers from an invalid start), ctx.fetch allowlist (`fetchAllowlist` may now be a function read on every call),
  `RiskMonitor` (already read limits through `BotManager.getLimits()` each run), startup halt decision (`main.ts`). Without a
  ConfigService `BotManager` keeps the old read-once behaviour (existing tests).
- `electron/ipc/handlers/configHandlers.ts` — `config:get|write|history|restore` (main window only); `preload.ts`, `electron.d.ts`,
  `electronApi.ts` (`configApi`), `config:changed` event to the renderer. No UI.
- `electron/notify/` — `TelegramNotifier.ts` (transport), `NotificationService.ts` (events, commands, digest), `events.ts` (`OrderEventSink`).
  `OrderService` calls the sink for live fills (after commit) and rejections; `AuditService.onRecord` added.
- Deps: `chokidar@4`, `write-file-atomic`, `@types/write-file-atomic`.
- Tests: `tests/config/config-changes.test.ts` (classification table), `config-service.test.ts` (invalid edit keeps config + audits once, cross-file,
  deleted file, valid edit reaches a RiskEngine subscriber, real watcher, write/history/restore round trip, token masking,
  comment-preserving render), `tests/notify/telegram.test.ts` (other chats ignored, `/halt` → kill switch, clear-halt refused, `/pause`,
  fill batching + buttons, rejection storm, halts, disabled = no requests, failing API never throws and token not logged, coalescing, digest time zone).

Not done / for later:
- Config UI (chunk 3c); category-rights / `rules_changed` / agent-run notifications (2a, 4); reconciler calling `reconciliationMismatch` (2b).
- `ConfigService` still lives in `electron/`; it moves to `packages/core` in 3a (it already has no Electron imports).
- Telegram has not been exercised against the real Bot API (fake fetch only).

### 2026-10-31 — chunk 1e review fixes
- **Critical**: an empty/truncated config file on hot reload no longer resets to defaults (strict parse on reload, required
  sections; chokidar `awaitWriteFinish`). Tests: empty, whitespace, comment-only, partial limits, partial mandate, empty fees.
- Token leaks through YAML errors closed (R46); test with syntax/validation errors in `server.yaml` checks log/audit/last error/subscribers/write errors.
- server.yaml Telegram changes classified as raises, alert sent via the old settings (R47); test: disabling Telegram + raising `max_order_usd` alerts the old chat.
- `/pause` duplicates and retired bots (R48); admin sender check via `from.id`, forwarded messages ignored (R44); tests.
- Nits (R49): expected-hash write, strict write/restore results, first-valid-config notice, offset reset on token change, `system` actor for watcher reloads.

### 2026-10-31 — chunk 2a
Done: `config/categories.yaml` + `categorize()`, `market_cache` with rules-hash change detection and ambiguity (server
raise), forecast ledger (submit/withdraw/supersede, hourly scorer, convergence, one-vote-per-event bootstrap stats),
category rights per (category, horizon bucket) with transitions, ledger-driven orders wired into the risk engine,
`ctx.ledger`, IPC, Telegram. Replaces the R4/R5 placeholders (Decisions R50–R59).

Files:
- `electron/config/categoriesSchema.ts` (zod schema, `DEFAULT_CATEGORIES_YAML`, `defaultCategories()`), `config/categories.example.yaml`;
  `ConfigService`/`changes.ts`/`loader.ts` treat it as the fifth config file (hot reload, history, `raises` on any edit);
  mandate schema rejects allowing `other`.
- `electron/ledger/categorize.ts` (pure), `ambiguity.ts` (rules normalisation/hash, server raise), `scoring.ts` (pure:
  resolution parsing, Brier/skill, convergence, event votes, seeded bootstrap, `decideRights`, `expectedThresholdDate`),
  `MarketCacheService.ts` (Gamma refresh, rules change ⇒ audit/event, ambiguity, `MarketQualityProvider` for orders,
  periodic refresh, re-categorisation), `LedgerService.ts` (submit/withdraw, `ForecastSource`, `CategoryBucketSource`,
  scorer job, rights evaluation, human force, `stats()` with expected date to threshold).
- DB: `market_cache`, `forecasts` (unique active forecast per token), `category_rights`; repositories
  `MarketCacheRepository`, `ForecastRepository`, `CategoryRightsRepository`.
- Orders: `MarketQualityProvider.get(info)` now returns the category too; `PlaceholderMarketQualityProvider` and
  `mandateCategory` removed (`unassessedQualityProvider` when no cache is wired: every buy rejected);
  `DbRiskStateProvider.categoryRights` fills `categoryBucket` for ledger-driven buys; `BotManager` passes the cache and
  ledger; `fetchPolymarketTop` helper.
- Bots: `ctx.ledger.getActiveForecasts(filter)` / `getForecast(tokenId)` (RPC `ledger:*`, read-only), `BotForecast` type.
- IPC `electron/ipc/handlers/ledgerHandlers.ts`: `ledger:submitForecast|withdrawForecast|list|stats|setRightsState`,
  `markets:get|setAmbiguity`; preload + `electron.d.ts`; `market:rulesChanged` event to the renderer.
- Notifications: `category_rights.change` (suspension high priority) and rules change / UMA dispute on a held market (high).
- Tests: `tests/ledger/categorize.test.ts` (table incl. fail-closed `other`, schema, example = default),
  `scoring.test.ts` (resolution, Brier/skill, convergence sign, event votes, bootstrap determinism, rights table incl.
  later/deny/unlisted, medium relaxation, allocation growth/cap, suspension and re-qualification on post-suspension events,
  deprioritisation, forced states, expected date, rules hash, auto-raise), `market-cache.test.ts` (hash change detection
  with holders + event, whitespace/missing description, auto-raise and expiry, dispute, Gamma failure fallbacks, batching,
  re-categorisation, Telegram), `ledger.test.ts` (snapshot captured server-side, injected prices rejected, validations,
  supersede/withdraw, scorer incl. superseded/withdrawn/void/convergence, shadow → trading + audit, mandate demotion,
  human force, RiskEngine path: shadow rejected, trading allowed within the bucket allocation, exposure counted).
  Existing order/risk tests use a static assessed quality provider.

Not done / for later:
- Live verification of Gamma tag slugs, `umaResolutionStatus(es)` and `condition_ids` batching (R50, R52, R53).
- UI for the ledger, rights and ambiguity (3c); agent/MCP submission (Phase 4); `ctx.events` (`forecast_changed`,
  `rules_changed`); `ctx.polymarket.getMarket` (§5.2) — `MarketCacheService.getMarket` is ready for it.
- Calibration buckets, log score, realized P&L of ledger-driven trades per category (reporting, §6.2) and the
  loss-limit suspension trigger (`suspendForLoss` hook).
- Daily digest does not include ledger stats yet.

### 2026-10-31 — chunk 2a review fixes
- **C1 dilution** (R60): versions weighted by active time per token, mean over tokens per event, near-mid versions
  (|p − m| < 0.02) excluded from stats; 6 h minimum between supersedes (R56). Migration `forecasts.active_until`.
  Tests: dilution scenario (pure, incl. two-token event) and quick re-forecasts refused end to end.
- **C2 baseline** (R56): forecasts rejected on spread > min(0.10, max_spread), low 24 h volume, any UMA status / dispute,
  or no mandate. Tests for each.
- **S1** (R50): deny-rule keywords no longer need tags; Fed/crypto/US-politics/sports/mentions keyword rows added to the
  categorize table (e.g. "Fed decision in December?" with `[interest-rates, central-banks]` ⇒ `fed-headline`).
- **S2** (R51): `ambiguity_source` human/forecast; human wins; forecasts only raise. Test.
- **S3/N4** (R61): recent-mean gate for entering trading; re-qualification on events fully resolved after suspension. Tests.
- **N1** (R53): stale cache row (> 2 h) ⇒ buys rejected. Test. **N2** (R54): resolution confirmed by a settled UMA status
  or two sightings ≥ 24 h apart; migration `market_cache.resolution_seen[_at]`. Tests (incl. a result that changes).
- **N3** (R62): `ctx.ledger` returns `bucketState` and live `tradeable`; orders use the same rule. Test.

### 2026-10-31 — chunk 2b
Done: Reconciler (orders, unknown outcomes, missed fills, orphan cancels, positions vs exchange with debounced halt,
pre-existing positions + adoption, resolved markets, clock skew guard, `reconciled_at`), order-book recorder with
watchlist and retention, Polymarket snapshot backtests (Decisions R63–R74; R8 and R11 amended).

Files:
- `electron/reconcile/Reconciler.ts` (60 s job, implements `ClockSkewGuard`), `electron/reconcile/dataApi.ts` (Data API
  positions / trades, paged, non-arrays are errors).
- `electron/orders/orderFills.ts` — `applyExchangeOrderState` / `recordOrderFill`, shared by OrderService and the Reconciler.
  `OrderService`: unknown-outcome live orders are no longer expired by the bot's sync; step-0 `clock_skew` for live orders
  (`OrderServiceDeps.clock`). `ExchangeAdapter`: optional `getOpenOrders`/`getTrades` (Polymarket) and `getOrder`/`getBalances`
  (Binance); `exchange/polymarket/orders.ts` `fetchOpenOrders`/`fetchTrades`; `sdk/binance.ts` `queryBinanceOrder`,
  `getBinanceServerTime`. `BotManager.getPolymarketAdapterForWallet`, `getBinanceAdapter`, `clock` order dep.
- `electron/ledger/scoring.ts` `checkResolution` (R54 confirmation, now shared with `LedgerService`).
- `electron/recorder/Recorder.ts` (watch set, bounded concurrency, retention), `snapshotCodec.ts`;
  `OrderbookSnapshotRepository` (snapshots + watchlist).
- `electron/backtest/snapshotSimulate.ts` (`SnapshotMarket`, `runSnapshotSimulation`); `BacktestEngine` / `backtest-worker`
  branch on `source`; `backtestHandlers` `source` + `tokenIds`.
- IPC `electron/ipc/handlers/reconcileHandlers.ts`: `reconcile:status`, `reconcile:adoptPositions` (human, main window),
  `recorder:watchlistList|Add|Remove`; preload + `web/client/src/types/electron.d.ts`. No UI (3c).
- Config: `limits.reconcile.max_unexplained_usd` (default 10, `up`), `server.recorder.{enabled, interval_seconds, max_tokens}`;
  defaults and example files updated.
- DB: `orderbook_snapshots`, `recorder_watchlist`, `risk_state.reconciled_at`, `bot_trades.fill_source`;
  `OrderRepository.firstLiveOrderAtForWallet`, `ForecastRepository.activeTokenIds`, `RiskStateRepository.setReconciledAt`.
- `NotificationService.reconcilerAlert` (clock skew, outage, recovery); `main.ts` wiring (recorder in Phase A, reconciler
  in Phase B, both stopped on shutdown).
- Tests: `tests/reconcile/reconciler.test.ts` (missed fill once across two runs + a bot sync; unknown-outcome FOK that
  filled recovered with fee; unknown order expired only after a confirmed miss, not on a failed lookup; ambiguous match left
  open; orphan cancel; mismatch warn → halt on the 2nd run; below threshold / dust / lag not halting; local excess;
  pre-existing warn-only + adoption (human only) clears it; partly pre-existing position halts on the new part only;
  resolved market closes live and paper positions once; 24 h confirmation; clock skew blocks live orders and clears;
  outage alerts after 5 runs without halting), `tests/recorder/recorder.test.ts` (watch set and cap, top-10 encoding,
  BLOB round trip, 15-minute downsampling, concurrency ≤ 4 with a failing token), `tests/backtest/snapshot-backtest.test.ts`
  (no look-ahead, post-only trade-through rule, TTL, depth + FOK, determinism, engine path in the worker);
  OrderService test for R11 updated + `clock_skew` test.

Not done / for later:
- Live verification of CLOB `getTrades`/`getOpenOrders` field semantics, Data API field names and CLOB `/time` (R64, R66, R70).
- On-chain redemption of resolved positions; crediting paper balances on resolution (R69).
- UI for reconcile status, adoption, watchlist and snapshot backtests (3c); agent `watch_market` tool (Phase 4);
  `/healthz` reading `reconciled_at` (3b).
- No way to close an `ambiguous` unknown-outcome order except by hand in the DB (it keeps counting as exposure).

### 2026-10-31 — chunk 2b review fixes
- **C1 (critical)**: `OrderService.applyOutcome` now uses the shared fresh-row/delta path (`applyPlacementResult`); the
  Reconciler skips unknown-outcome rows younger than 2 minutes and never links an id another row holds; partial unique
  index on `orders(exchange, exchange_order_id)` (R75). Tests: a reconciler run while a Binance order and while a
  Polymarket limit order is in flight records the fill once; a claimed id is not copied and the DB refuses duplicates.
- **S1**: bounded, batched downsampling with a persisted cutoff (R76). Test: a year of 1-minute rows for 3 tokens
  (≈1.6 M rows) under a generous time bound, batched, and the next hourly run only examines the new hour.
- **S2**: adoption syncs orders first, refuses unknown-outcome orders and retired/halted bots, caps at the pre-first-order
  quantity minus what was already adopted, `includePostFirstOrder` audited (R67, R78). Tests for each.
- **S3**: `wallet_id` on orders and fills, reconciler groups by it, wallet changes refused while the bot holds anything
  (R77). Test: attribution survives a bot moved to another wallet; blocker messages.
- **N1** `clock_unverified` after 3 min without a successful check, 1 s tolerance for whole-second sources, no slack for
  round trips > 2 s (R70); **N2** first order excludes `failed` (R67); **N3** resting fills consume depth (R80); fee-in-shares
  tolerance on Polymarket local excess (R79). Tests for N1, N2, N3 and the tolerance.
- Migrations: `orders.wallet_id`, `bot_trades.wallet_id` (+ backfill), `recorder_state`, unique exchange-order index.

### 2026-10-31 — chunk 3a
Done: domain code moved to a transport-free `packages/core` (`git mv`, imports rewritten), business logic extracted from
the IPC handlers into services with shared zod input schemas, `createCore` composition root with the pre/post-unlock
lifecycle; Electron is a thin shell over it (Decisions R81–R87). No behaviour change intended beyond R84–R86.

Layout (`packages/core/src/`): `core.ts`, `index.ts`, `services/`, `db/` (index, schema.sql, seed, repositories),
`bots/`, `runtime/`, `orders/`, `exchange/{polymarket,binance}/`, `risk/`, `config/`, `ledger/`, `reconcile/`,
`recorder/`, `backtest/`, `audit/`, `notify/`, `security/`, `sdk/`, `utils/`; `templates/` at repo root.
`electron/` keeps `main.ts`, `preload.ts`, `ipc/respond.ts`, `ipc/handlers/*`, `ai/claude.ts`.

Services (`core.services`): `bots` (BotService: list/get/create/update/delete/start/stop/restart/trades/allTrades/
positions/stats/dashboardStats; `walletChangeBlocker`), `wallets` (WalletService incl. balance), `scripts`
(ScriptService: CRUD/compile/getSchema/fork/exportScript/importScripts), `settings` (SettingsService incl. Binance
credentials and RPC/CLOB/Binance tests), `backtests` (BacktestService: run/list/get/delete), `risk` (RiskService:
getState/clearHalt/killSwitch), `config` (ConfigFileService: get/write/history/restore), `ledger` (LedgerService as-is),
`markets` (MarketService: get/setAmbiguity), `reconcile` (ReconcileService: status/adoptPositions/watchlist*),
`audit` (AuditService). Audited or human-only methods take an explicit `actor`. `services/schemas.ts` (`parseInput`),
`services/errors.ts` (`ServiceError`), `services/types.ts` (DTOs, formerly `electron/ipc/types.ts`).

Composition root API (for 3b): `createCore({ dataDir, configDir?, templatesDir?, dbPath? })` →
`{ dataDir, db, repos, services, events, configService, halts, killSwitch, notifications, botManager, walletManager,
reconciler, isUnlocked(), start(), unlock(key), shutdown({ timeoutMs }), close() }`. `core.events` emits `CORE_EVENTS`
(`risk:halt`, `risk:halt-cleared`, `config:changed`, `market:rulesChanged`, `bot:event`, `bot:log`) with the payloads the
renderer already receives; Electron forwards each to `webContents.send(channel)`.

Other:
- `electron/main.ts`: single-instance lock, window, `createCore({ dataDir: app.getPath('userData') })`, IPC registration
  (bot/wallet after unlock), quit handling via `core.shutdown` + `core.close`.
- IPC handlers: validate → service → `respond()` (`{ success, data, message? }`); main-window sender checks unchanged.
  Auth and the AI assistant stay in Electron (removed in 3b); `settingsHandlers` keeps the Claude settings.
- ESLint: `packages/core/**` may not import `electron`, `electron/` or `apps/*`; choke-point rules moved to the new adapter
  paths. `tests/orders/choke-point.test.ts` scans `packages/` and `templates/` and checks core never imports electron.
- `npm run typecheck` (core + electron) in CI; `packages/core/tsconfig.json`; root `tsconfig.json` is now only the vitest
  transform settings for `tests/`. Former `src/core` / `src/utils` files now get core's ES2022 settings under vitest
  too (as they already did in the Electron build).
- Tests: imports updated; `bot-handlers.test.ts` builds a `BotService`; new `tests/core/create-core.test.ts` (temp data and
  config dir, network stubbed: start → templates seeded, locked calls refused → clean shutdown marker; unlock → paper bot
  created → clean shutdown).

Not done / for later:
- No npm workspaces or `@botlab/core` package name yet (R81); no `apps/` dir. HTTP server, SSE, MCP, auth (3b).
- The forecast ledger has no wrapper service (LedgerService is exposed directly); `botHandlers`' Gamma/Data API helpers
  moved unchanged into `BotService` (still uncached prices, own fetches) — candidates for MarketService/MarketDataService
  reuse later.
