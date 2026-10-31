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
| 3b | HTTP server + SSE + auth, web client on fetch, remove Electron + AI assistant, cross-platform scripts, Docker | done |
| 3c | UI pages: Risk, Ledger, Audit, config editing | done |

Testing policy: tests only for safety- and money-critical logic and core domain logic; existing suite must stay green.
Known pre-existing failures: `tests/copytrading/1-polymarket-data-api.test.ts` calls the live Polymarket API (fails without network; skipped when `SKIP_NETWORK_TESTS=1`).

## Decisions to review

Judgement calls made during the overnight run. Each says how to reverse it.

Paths in R1–R80 predate chunk 3a: `electron/<dir>/` is now `packages/core/src/<dir>/` (`database` → `db`),
`src/core` → `packages/core/src/bots`, `src/utils` → `packages/core/src/utils`, `electron/sdk/binance.ts` →
`exchange/binance/client.ts`, `electron/scripts/templates` → `templates/`; Phase A/B in `electron/main.ts` → `core.ts`
`start()`/`unlock()` (R82, R85). Since 3b: `web/client` → `apps/web`, `tests/electron` → `tests/runtime`, `electron/` is gone (its
IPC handlers became `apps/server/src/routes/`).

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
| R19 | 1c | **Startup**: shutdown marker `shutdown-state.json` next to the DB. Missing marker (first start of a 1c build) = clean; unreadable marker = unclean; unreadable limits config ⇒ `start_halted_after_crash` treated as true. The setting lives in `limits.yaml` under `server:` (spec says `server.yaml`, which does not exist yet). Bots never auto-start, so **every** open order found at startup is synced with the exchange and then cancelled; bot starts are refused until that finishes; stale `running` statuses are reset to `stopped`. **Amended 3b:** clear a halt with `POST /api/risk/clear-halt` `{ scope, reason }` (admin session, password checked within 15 min). **Amended 3c:** **Clear halt** buttons on the Dashboard halt banner, the Risk page (Halts tab) and Bot detail (reason required; the re-auth dialog appears when the password check is older than 15 min). | Spec §4.3. | `electron/risk/StartupRecovery.ts`, `electron/main.ts`. |
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
| R51 | 2a, amended 2a review | **Unassessed ambiguity ⇒ buys rejected** (live and paper): a market can only be bought after someone assessed it — a forecast's `ambiguityScore` (agent later, human now via `ledger:submitForecast`) or a human via `markets:setAmbiguity(marketId, score, note)` (**3c:** Markets page → open the market (search the cache or paste a condition id) → **Set ambiguity**; `POST /api/markets/:id/ambiguity`, admin + recent password). **Consistency / resolution-rule bots therefore need each market assessed first.** The latest assessment wins (human or forecast). The market stores the raw score; the server raise (≥ 2 for 7 days after a rules change, or while a UMA dispute is recorded) is applied at read time, so it lapses on its own; the forecast row stores the raised score. **Amended in review:** the stored score has a source (`human` or `forecast`). **A human assessment always wins** until a human changes it (forecasts are ignored on that market); a forecast may only **raise** a forecast-sourced score, never lower it; `markets:setAmbiguity` refuses non-human actors. Every attempt is audited (`market.ambiguity`, result `kept: …` when ignored). | Spec §7.4; same fail-closed rule as other missing market data (1a). | `effectiveAmbiguity` in `electron/ledger/ambiguity.ts`; `RiskEngine` step 2. |
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
| R81 | 3a, amended 3b | **One npm package, no workspaces, no `@botlab/core` alias** (kept in 3b: the server imports core by relative path, `tsc -p apps/server/tsconfig.build.json` compiles both into `dist/{apps/server,packages/core}/src`, tsx runs the sources in dev; the web deps moved into the root package.json, see R101): `packages/core/src` is imported by relative path (`electron/` → `../packages/core/src/...`). `packages/core/tsconfig.json` typechecks core alone (`npm run typecheck` = core + electron, also in CI); the Electron build still compiles both with `electron/tsconfig.json` into `dist-electron/{electron,packages/core/src}`. | `tsc` does not rewrite path aliases in CommonJS output and the Electron app runs the compiled JS; workspaces would need core built to JS first. Nothing to gain before 3b. | In 3b: npm workspaces (`packages/core` as `@botlab/core`) plus a bundler/tsx for `apps/server`, then replace the relative imports. |
| R82 | 3a | **Layout choices**: templates at repo root `templates/` (spec §1.1; seed looks in `templatesDir`, then 4 and 5 levels above `db/` for source and compiled output, then `<cwd>/templates`; packaged via `electron-builder` `files`). `sdk/binance.ts` → `exchange/binance/client.ts`, `sdk/trading.ts` → `exchange/polymarket/trading.ts`, `claudeSystemPrompt.ts` → `sdk/guide.ts` (the script-writing guide, still used by the AI assistant; the agent can be given it later), `sdk/claude.ts` stays in Electron (`electron/ai/`). `src/core` → `bots/`, `src/utils` → `utils/`, `electron/ipc/types.ts` → `services/types.ts` (DTOs). | Spec §1.1 subfolders; choke-point ESLint rules and the static test now name the new adapter paths. | `git mv` back; update `eslint.config.mjs` and `tests/orders/choke-point.test.ts`. |
| R83 | 3a, amended 3b | **Worker entries** (3b: tsx tested — a `.ts` worker entry does NOT load under tsx even though the worker inherits `--import tsx`; `startWorker()` now wraps `.ts` entries in an eval'd CommonJS shim that registers `tsx/cjs/api` first; verified by the server smoke test and `npm run dev` with a running paper bot, compiled `.js` path verified with `npm start` and Docker): `resolveWorkerEntry(__dirname, name)` returns `<name>.js` next to the module, else `<name>.ts` (a worker inherits the parent's `execArgv`, so a tsx loader carries over). Verified for compiled output only (a compiled core started a paper bot's worker and found the templates); running from `.ts` under tsx is untested (tsx is not installed). | Spec §15.2; 3b's dev server will run from sources. | `packages/core/src/runtime/workerPath.ts`. |
| R84 | 3a, amended 3a review | **Service errors and input checks**: services throw `ServiceError(code, message)` (`invalid_input`, `not_found`, `locked`, `unavailable`, `conflict`); IPC returns the same `{ success: false, error: message }` with the messages it had before. `services/schemas.ts` checks shape and types only, strips unknown keys and leaves value rules (and their messages) to the services; a wrongly typed IPC argument now fails with `Invalid input: <path>: <issue>` instead of reaching a repository. Inputs whose services already validate (config files, adoption, watchlist, ledger writes, backtest required fields) are passed through as before; their typed schemas are for HTTP/MCP. **Amended (3a review):** services take a branded actor (R88), not a string; a transport must derive the actor from the **authenticated principal** (Electron: the IPC peer, after the main-window check for human-only actions; HTTP/MCP: session or token scope), never from request data. | Spec §8.1: one set of zod schemas for IPC, HTTP and MCP. | Drop `parseInput` calls in `electron/ipc/handlers/*`. |
| R85 | 3a, amended 3a review | **Lifecycle in core**: `createCore` (DB + construction, no timers), `start()` (old Phase A), `unlock(key)` (old Phase B; returns false if already unlocked), `shutdown({ timeoutMs })` (old graceful path, `{ clean }`), `close()`. Services exist from `createCore`; those needing keys throw `locked` before unlock. Electron still registers bot/wallet IPC only after unlock, as before. One change: the clean-shutdown marker is also skipped when the timeout fires during the notifications/Telegram/config-watcher stop (before, only when it had fired before that phase). DB handle and `keyManager` stay module singletons ⇒ one core per process. **Amended (3a review):** `start()` is marked done only after it succeeds; a failed start is rolled back (jobs stopped, listeners removed) and can be retried, and the startup halt / shutdown marker step runs once per core. `unlock()` throws unless `start()` succeeded; a failed unlock is rolled back (monitor/reconciler stopped, BotManager shut down, managers reset to null, key cleared) and rethrown, so `isUnlocked()` is false and unlock can be retried; recovery-in-progress is set before `BotManager.initialize()`. Opening a second, different database in one process throws (R90). | Spec §1.2; 3b's server calls `createCore` + `start` + `unlock(env key)`. | `packages/core/src/core.ts`; for several cores per process make the DB handle and key instance-scoped. |
| R86 | 3a | **`.botlab` export/import on contents**: `ScriptService.exportScript(id)` returns `{ fileName, file }`, `importScripts([{ name, content }], actor)` imports; the Electron handler keeps the save/open dialogs and file I/O. Unreadable files are listed in `errors` before parse/compile errors (before, in file order). | Transport-free core; HTTP will upload/download. | `electron/ipc/handlers/scriptHandlers.ts`. |
| R87 | 3a | **DB default path** without `createCore`: `BOTLAB_DATA_DIR` else `<cwd>/data` (the `require('electron')` probe is gone; Electron passes `app.getPath('userData')` as before, so the DB location does not change). | Core must not import electron. | `getDbPath` in `packages/core/src/db/index.ts`. |
| R88 | 3a review | **Branded actors** (`packages/core/src/services/actors.ts`): `HumanActor` / `AgentActor` / `SystemActor` are frozen objects created only by `asHuman(principal)` / `asAgent(principal)` / `asSystem()` and recorded in a module-private `WeakSet`; `isActor` / `isHumanActor` check membership, so the string `'human'` or a hand-built `{ kind: 'human' }` is not an actor. The human-only domain methods (`HaltService.clearHalt`, `ConfigService.write/restore`, `Reconciler.adoptPositions`, `MarketCacheService.setAmbiguity`, `LedgerService.forceRightsState`) take `HumanActor` and re-check at runtime; a denial is audited as `denied: human only`, or `denied: human only (unauthenticated actor)` for non-actors (recorded under the string if it looks like an audit actor, else `system`). Audit rows still store the kind (`human`/`agent`/`system`), not the principal. `ledger.submitForecast/withdrawForecast` accept an actor or (as before) an audit string; the domain `KillSwitch.activate` and BotManager keep audit strings (Telegram `/halt` and `/pause` stay `human`, R45). | Review: human-only actions trusted a caller-supplied string. | Make the parameters `AuditActor` again and compare to `'human'`. |
| R89 | 3a review | **Service-level actor rules**: `ConfigFileService.get/history` — human or agent (config is masked for both; history has no file text); `write/restore` human only. `ReconcileService.watchlistAdd/Remove` — human or agent, actor audited; `adoptPositions` human only. `RiskService.killSwitch` — human, agent or system, recorded in the audit row; `clearHalt` human only. `MarketService.setAmbiguity` human only. Bot/script create/update/delete/fork/import — human or agent; bot start/stop/restart — any actor. An unminted actor is refused everywhere (`<action>: unauthenticated actor`). Electron creates the HumanActor per IPC call (`ipcHuman(event)`, principal `electron:webContents:<id>`), after the sender check where there is one; bot/script IPC had no sender check before and still has none. | Spec §4.6, §8.2 (agent scope for MCP in 3b/4). | `requireActor` calls in `packages/core/src/services/*`. |
| R90 | 3a review | **One database per process, explicitly**: `initializeDatabase(path)` returns the open handle for the same path (`:memory:` equals only itself, as before) and throws if a different database is open; `closeDatabase(handle)` closes only that handle, and `core.close()` passes its own, so it never closes a database another caller opened after it. | A second `createCore` with another data dir silently shared the first DB. | `initializeDatabase` / `closeDatabase` in `packages/core/src/db/index.ts`. |
| R91 | 3b | **Master key** (spec §8.3): `BOTLAB_MASTER_KEY` (64 hex) → `BOTLAB_MASTER_KEY_FILE` → `<data dir>/master.key`. None set: dev (`npm run dev`) generates `<data dir>/master.key` (`wx`, mode 0600; on Windows the per-user profile ACL applies) with a warning; production (`npm start`, Docker, service) exits with instructions (`npm run cli -- gen-key --prod`). A malformed key is fatal. `core.unlock()` checks `settings.key_check` (a constant encrypted with the key); the first unlock of a DB requires every stored secret to decrypt with the key, then writes the check. A wrong key or old password-derived secrets ⇒ `ServiceError('locked')`: the **server still runs, locked** (login screen shows the reason, `/healthz` 503) instead of exiting. | Spec §8.3; a wrong key must never re-encrypt or write anything; a locked server explains itself in the UI. | `apps/server/src/masterKey.ts`, `packages/core/src/security/masterKey.ts`, `startServer`. |
| R92 | 3b | **migrate-key** (`npm run migrate-key -- [--prod] [--password <pw>]`, prompts if omitted): old key = PBKDF2(password, or the legacy "skipped" constant when the user skipped the password, salt); every secret (wallets incl. paper, Binance key/secret) is decrypted with it (v2 or CryptoJS format) and re-encrypted with the master key in one transaction — **all or nothing** (one unreadable secret ⇒ nothing changes); then `key_check` is written and `password_hash/salt/skipped` cleared. If no admin password exists and the old password has ≥ 8 chars it becomes the admin login password. Refuses while a server holds the data dir lock. `FALLBACK_PASSWORD` is now `LEGACY_SKIPPED_PASSWORD`, used only here. Uses the same master key resolution as the server and creates `<data dir>/master.key` if none is configured. | Task brief; reuse of the re-encryption code (`rekeySecrets` next to `migrateSecretsToV2`). | `apps/server/src/migrateKey.ts`, `cli.ts`. |
| R93 | 3b, amended 3b review | **Admin auth**: **(Review: the recent-auth list now also covers wallet create/update/delete, Binance credentials save/clear and `PATCH /api/settings`; the failed-password limit reserves a slot before the scrypt check — R108; first-run setup needs a one-time code — R110.)** password hashed with scrypt (N=2^14, r=8, p=1) in `settings.admin_password_hash`; first-run `POST /api/auth/setup` only while none is set (atomic), min 8 chars. Sessions in a new `auth_sessions` table (SHA-256 of the cookie token only), so they **survive restarts**; cookie `botlab_session` httpOnly, SameSite=Strict, Secure when the request is https (or `X-Forwarded-Proto: https` from loopback, e.g. `tailscale serve`); idle 7 days, absolute 30 days. `auth_at` = last password check; **recent-auth (< 15 min)** required for clear halt, config write/restore, adopt positions, set ambiguity, force category rights and creating API tokens, else `403 reauth_required` (the UI shows a password dialog, `POST /api/auth/reauth`, and retries). Failed password checks: 5 per 15 min per client address (in memory) then 429; audited (`auth.login` denied). Password change logs out all other sessions; CLI `set-password` resets it. | Spec §8.2. | `packages/core/src/security/adminAuth.ts`, `apps/server/src/routes/auth.ts`. |
| R94 | 3b, amended 3b review | **API tokens in the DB, not server.yaml**: **(Review: wallet, settings and script-export routes are `allow: [admin]` even for GET, so readonly tokens cannot read the Alchemy key or wallets; the agent may only update a bot's `config` and only create paper bots without a wallet choice — R109.)** `api_tokens` (scope `agent` or `readonly`, SHA-256 only, revocable), created with `npm run cli -- token create --scope agent` or `POST /api/auth/tokens` (admin + recent auth), shown once. Scope per route: GET ⇒ admin + readonly by default; mutations admin only; **agent** opt-in only where §7.3 has a tool: bots list/get/create/update/start/stop/restart/trades/positions/stats, scripts list/get/schema/compile/create/update/fork, backtests run/list/get, risk state + kill switch, config get/history (masked), forecasts submit/withdraw/list, ledger stats, markets get, reconcile status, recorder watchlist. Never for the agent: wallets, settings/credentials, config write/restore, clear halt, adopt, ambiguity, rights, bot/script/backtest delete, export/import, dashboard stats, tokens. Readonly: GETs except wallets/settings/config. | Spec says "static token in config/server.yaml (hashed)"; a DB table + CLI needs no hand-hashing and supports revocation. | Move to server.yaml if wanted: hash check in `principalMiddleware`. |
| R95 | 3b | **Actors from the principal only**: admin session ⇒ `asHuman('session:<id prefix>')`, agent token ⇒ `asAgent('token:<id>')`, readonly ⇒ no actor (403 on anything needing one); request bodies are never read for an actor (tested with `actor: 'human'` in an agent request). `requireActor` failures are now `ServiceError('forbidden')` (403) instead of plain errors. | R84/R88/R89. | `apps/server/src/http/principal.ts`. |
| R96 | 3b | **CSRF and DNS rebinding**: cookie-authenticated mutations (and login/setup) need `X-BotLab: 1` and, if the browser sends Origin, Origin host = Host; bearer requests are exempt (not sent automatically by browsers). Every request's Host must be an IP literal, `localhost`/`*.localhost`, `*.ts.net`, the bind host, or listed in `http.allowed_hosts` / `BOTLAB_ALLOWED_HOSTS` (leading dot = domain + subdomains); otherwise 403 `host_not_allowed`. | Spec §8.2; the first-run setup endpoint would otherwise be reachable from a malicious page via DNS rebinding. A MagicDNS-less custom name must be configured. | `apps/server/src/http/hosts.ts`, `csrfMiddleware`. |
| R97 | 3b | **HTTP mapping**: every IPC channel has a route (`apps/server/src/routes/api.ts`; `bots:dashboard-stats` → `GET /api/dashboard/stats`, `bots:trades:all` → `GET /api/trades`, updates are `PATCH`, Binance save `PUT /api/settings/binance`). Envelope `{ success, data?, message?, error?, code? }`; `ServiceError` codes → 400/403/404/409/423/503; any other thrown error → **500 with its message** (many services still throw plain `Error` for validation, e.g. "Wallet is required for live bots"; the UI shows the message either way). Script export returns the `.botlab` JSON for the browser to download; import takes `{ files: [{ name, content }] }` from a file picker (R86). `app:path` dropped; `GET /api/app/info` gives the version. | Spec §8.1 (same function signatures in the client). | Convert value errors to `invalidInput` in services for proper 400s. |
| R98 | 3b | **Live trading is opt-in**: new `limits.yaml` key `live_trading.enabled` (default **false**; `false → true` is a risk raise). While false, `BotManager.startBot` refuses bots that would run live and `OrderService` rejects every live order before the risk engine (`live_disabled`, step 0, persisted like other pre-checks); paper is unaffected. A bot created without `mode` is now **paper** (was live), the UI defaults to Paper. **Existing installs: live bots stop trading until `live_trading.enabled: true` is added.** | Spec §15.2 "Live trading requires explicitly enabling it in config"; fresh install must not be able to trade live by accident. | Default `true` in `config/schema.ts` (and remove the checks). |
| R99 | 3b | **Data/config/log dirs**: `BOTLAB_DATA_DIR`, else production (`npm start` passes `--production`, Docker/service set `NODE_ENV`) ⇒ `~/Library/Application Support/BotLab`, `%APPDATA%\BotLab`, `~/.local/share/botlab` (same as Electron's userData on macOS/Windows, case-insensitive FS ⇒ an Electron DB is found), else `./data`. Config: `resolveConfigDir` as before (`<data dir>/config` in production). Core logger files: `BOTLAB_LOG_DIR`, set by the server to `<data dir>/logs` (was `<cwd>/logs`, unwritable in Docker). Logs are still plain text, not JSON, and only daily-split (no pruning). One server per data dir via `<data dir>/server.lock` (pid + host + boot time; a lock from another boot/host or a dead pid is stale, so a reboot that reuses the pid does not block the service). | Spec §15.2; Electron's single-instance lock is gone. | `apps/server/src/paths.ts`, `instanceLock.ts`. |
| R100 | 3b | **Shutdown**: SIGINT, SIGTERM, SIGBREAK and SIGHUP all shut down gracefully (SIGHUP = Windows console window closed; Windows kills the process ~10 s later, so the core shutdown timeout is 7 s there, else 20 s). Repeated signals within 2 s count as one (Ctrl+C reaches the process group and npm forwards it); a later second signal exits at once (unclean ⇒ next start halted). `npm start` runs `node … --production` without cross-env (one process less). HTTP and SSE are closed before `core.shutdown()`. | Spec §15.2. | `apps/server/src/main.ts`. |
| R101 | 3b | **Web app**: `git mv web/client apps/web`; its own package.json/lockfile removed and its dependencies merged into the root package.json (devDependencies — only the built `apps/web/dist` ships), so a single `npm install` sets up everything (one lockfile, no workspaces, R81). `vite.config.mts` (ESM under the CommonJS root), PostCSS config `.mjs`, unused tailwind.config.js dropped. Root ESLint now lints `apps/web` (React hooks rules; the React Compiler advisories `set-state-in-effect` and `refs` are warnings because the pre-3b pages trip them). Hash routes kept; the server also has an SPA fallback. | Spec §15.2 "npm install then npm run dev". | — |
| R102 | 3b | **Windows service via NSSM, not node-windows**: node-windows' wrapper stops the child with TerminateProcess (no SIGINT), so every service stop would look like a crash and start halted. `npm run service:install` (elevated PowerShell) needs `nssm` on PATH (`winget install NSSM.NSSM`, or `$env:NSSM`), registers `node dist/apps/server/src/main.js --production` as service `BotLab`: delayed auto-start, Ctrl+C stop with 25 s grace, restart on exit after 10 s, stdout/stderr to `<data dir>\logs\service.log` rotated at 10 MB. It runs as LocalSystem, so the data dir, config dir and master key file are pinned to the installing user's `%APPDATA%\BotLab` via `AppEnvironmentExtra`; the key file is generated if missing. macOS/Linux print a launchd plist / systemd user unit. **Untested on Windows** (no Windows host here). | Spec §15.1. | `scripts/service.mjs`. |
| R103 | 3b | **Nightly backup** (core `ops/BackupJob`, started by `core.start()`): better-sqlite3 `.backup()` to `<data dir>/backups/botlab-<UTC stamp>.db` via a `.partial` file + rename, **03:30 local time** (TZ), keep **14**; if the newest backup is > 24 h old at start, one runs 5 min after start. Failures are logged and audited (`backup.run`), never affect trading. No rclone/remote copy yet. `createCore({ backups: false })` for tests; never for `:memory:`. | Spec §15. | `packages/core/src/ops/BackupJob.ts`. |
| R104 | 3b | **`/healthz`** (no auth): `{ ok, db, unlocked, reconciler, workers: { running, failed } }`, 200/503. `reconciler` is `ok` when `risk_state.reconciled_at` < 3 min old — it is only set when a reconciler run fully succeeded, so **an internet/exchange outage turns health red after 3 min** (intended: data is stale); `starting` (healthy) for 3 min after unlock; `locked` when the master key is missing/wrong. `workers.failed` = bots in `error` state. Docker's HEALTHCHECK only marks the container unhealthy (no restart). | Spec §15. | `apps/server/src/http/health.ts`. |
| R105 | 3b | **SSE**: `GET /api/events` for any authenticated principal (admin, agent, readonly), every `CORE_EVENTS` event as an SSE event of the same name with JSON data, a `ready` event on connect, `: keepalive` every 25 s, the session/token re-checked at each keepalive (logout/revocation ends the stream within 25 s). The browser keeps one EventSource for all subscribers. | Spec §8.1. | `apps/server/src/http/sse.ts`. |
| R106 | 3b | **Docker**: `node:22-slim` multi-stage, **no apt packages** (better-sqlite3 prebuilt binaries for linux x64/arm64; TZ works through Node's bundled ICU — verified `Europe/Dublin` in the container), runs as `node` (uid 1000; bind-mounted `data/`, `config/` and the key file must be readable/writable by uid 1000), `BOTLAB_HOST=0.0.0.0` inside the container (the bind warning is logged) with the port published on `127.0.0.1:3780` only, master key as a compose secret file, `init: true`, `stop_grace_period: 30s`, HEALTHCHECK on `/healthz`, Tailscale sidecar commented out. CI builds amd64+arm64 (no push). Built and run locally (amd64) here: healthz, UI, CLI in the container, clean SIGTERM shutdown. | Spec §15. | `Dockerfile`, `docker-compose.yml`. |
| R107 | 3b | **AI assistant removed** (spec §12): `ScriptAssistant`, `useAI`, Claude settings UI and hooks, `electron/ai/claude.ts`, `ai:*` and `settings:*Claude*`/`*AiSystemPrompt` channels; migration **drops** `settings.claude_api_key_encrypted` and `ai_custom_system_prompt` (`ALTER TABLE … DROP COLUMN`; a stored Claude key is deleted). `packages/core/src/sdk/guide.ts` kept for the MCP resource. | Spec §12, D14. | — |
| R108 | 3b review | **Password-guessing limit without races**: each password check (login, re-auth, password change, setup-code check) **reserves** a slot before the scrypt hash and releases it only on success; 5 slots per 15 min per key, then 429 (40 parallel wrong logins ⇒ 5 × 401, 35 × 429). Key = client address; for a loopback peer (a local proxy such as `tailscale serve` or Vite) re-auth and password change add the session id. Logins through such a proxy share one bucket, so a guesser can lock the admin out for 15 min (README; `npm run cli -- set-password` works regardless). | Review finding 1. | `LoginLimiter`, `limiterKey` in `apps/server/src/routes/auth.ts`. |
| R109 | 3b review | **Agent limits on bots, in the service**: `BotService.update` with an agent actor accepts only `config` (any other defined field ⇒ `forbidden`, audited `denied: agent may change config only`); `BotService.create` with an agent actor refuses a `walletId` or a mode other than paper (`forbidden`) — agent bots are always **paper bots on their own throwaway paper wallet**; a human creates live bots. Enforced in core, so MCP (Phase 4) inherits it. | Review finding 4; the simplest safe rule until the Phase 4 ramp lets the agent's bots graduate. | `BotService.create/update`. |
| R110 | 3b review | **First-run setup code**: while no admin password exists the server prints a one-time code (`ABCD-EFGH`, 40 bits; SHA-256 in `settings.setup_code_hash`, new each boot, cleared when the password is set) in a banner at boot; `/api/auth/setup` requires it unless the request is a **direct local request to a loopback-bound server** (loopback peer, no `X-Forwarded-For`/`Forwarded`/`X-Real-IP`, loopback Host). Wrong codes are rate-limited (R108) and audited. `GET /api/auth/session` reports `setupCodeRequired`; the setup screen shows a code field. If setup is pending and the DB already holds secrets, a warning is logged at boot. `migrate-key` refuses to finish without an admin password: the old password (≥ 8 chars) becomes it, otherwise it asks for a new one (or `BOTLAB_NEW_ADMIN_PASSWORD`). | Review finding 5: whoever reached the UI first could claim it (Docker / Tailscale / LAN binds). | `AdminAuthStore.createSetupCode`, `isLocalDirectRequest`, `startServer`. |
| R111 | 3b review | **Generic 500s**: an error that is neither a `ServiceError` nor an HTTP error is answered `Internal error (id <8 hex>); details are in the server log` with `errorId`, and logged in full with that id. Routes whose domain errors are user-facing (bot start/stop/create/update/delete, wallets, settings tests, scripts, backtests, halts/kill switch, config writes, ledger, markets, adopt, watchlist) declare `domainErrors: <code>` and turn plain domain errors into that `ServiceError` with the message (e.g. "Live trading is disabled …" as 409). `lockReason` in `/api/auth/session` only for authenticated callers (others see `unlocked: false`). | Review nits. | `http/respond.ts`, `RouteDef.domainErrors`. |
| R112 | 3b review | **Windows service runs as the installing user**, not LocalSystem: `service:install` asks for the Windows password (hidden) and runs `nssm set BotLab ObjectName .\<user> <password>` (NSSM grants "Log on as a service"); without a password nothing is installed, and if NSSM refuses the account the service is removed and the `services.msc` → Log On steps are printed. The `%APPDATA%\BotLab` data/config/key paths are still passed explicitly. A Windows password change must be repeated in `services.msc`. **Untested on Windows.** | Review finding 6: LocalSystem would give bot code and the server full control of the PC. | `scripts/service.mjs`. |
| R113 | 3b review | **Smaller review fixes**: `migrate-key` writes secrets, admin password, key check and legacy-field reset in **one transaction** and takes the old password from a hidden prompt or `BOTLAB_OLD_PASSWORD` (`--password` still works, with a warning); the instance lock is created with `wx`, a stale lock is removed and creation retried once; static serving rejects any backslash in the decoded path (`..%5c`) besides the `path.relative` containment check; `.prettierrc` (single quotes, semicolons, width 160, 2 spaces, trailing commas es5 — the dominant existing style) cuts Prettier warnings from ~11.9k to ~1.4k without reformatting anything. | Review nits. | — |
| R114 | 3c | **Config editing = form generated from the zod schemas, plus a YAML tab.** `GET /api/config/schema` serves `z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })` per file; the UI renders objects as sections, numbers/booleans/enums/string lists/number pairs as inputs, and anything else (category rules, `chat_id` union) as JSON / text. The YAML tab parses in the browser and sends the same **value** (not text): the server merges it into the file with the comment-preserving writer (R40), so both paths share one validation. `categories.yaml` opens in YAML mode. | A form alone cannot express the rule list; YAML alone gives no guidance. One server-side validation either way. | Drop `SchemaForm` and keep the YAML tab (or vice versa) in `components/ConfigEditor.tsx`. |
| R115 | 3c, amended 3c review | **Review before save** (**review:** restore goes through the same review — `POST /api/config/:file/restore/preview` classifies the stored version against the current file, raises need the tick, and `restore` now takes `expectedSha256` with the same server-side check as `write`; the UI never sends a write or restore without a hash and blocks saving after a failed post-save reload until the page is reloaded; switching to YAML clears form field errors (the YAML shows the last valid values)): `POST /api/config/:file/preview` (admin session; no recent password since nothing is written) runs the write path's schema + cross-file validation and `classifyChange`, returning issues or the changed keys with `raises/lowers/neutral`. **Review changes** opens a dialog with the changed keys (or the server's issues); Save is only in that dialog, and a change that raises risk needs an explicit "I understand" tick. Saving sends the file's SHA-256 **as it was when editing started** (`expectedSha256`); a concurrent hand edit shows "changed on the server — reload" and the save is refused. The server still applies raises immediately (spec §3); the tick is UI-only. | Spec §3 risk-raise confirmation and lost-update protection. | Remove the tick check in `ConfigEditor` `save` button. |
| R116 | 3c, amended 3c review | **Dashboard overview** (**review:** `equity.error` is a short generic message such as `polygon balance lookup failed (SERVER_ERROR)` — the ethers error held the Alchemy URL with its API key and the request body with the wallet address, visible to agent/readonly tokens; the full error is logged server-side only. Reconciler errors and clock detail in the overview and `GET /api/reconcile/status` keep only the host of any URL and shorten 20-byte addresses, R123) (`GET /api/risk/overview`, all scopes = §7.3 `get_overview`): equity = cash of the non-paper wallets used by live, non-retired bots (+ Binance USDT if credentials) + live positions at cost, **cached 30 s, 10 s timeout**, null with the error when unreadable (then the total cap is shown as the USD cap only). Exposure = order-linked live positions at cost + unfilled open buys (as `DbRiskStateProvider`); long-horizon uses **cached** market end dates only (no network; unknown ⇒ counted long and shown separately). Daily P&L = `risk_state` global `day_live_pnl`; the loss bar counts from the halt-clear baseline of the day (R23). Per-bot allocation used/available: `RiskEngine.effectiveAllocation` for the stage (paper bots on their paper orders/fills, stage paper as full, R12). Clock "not checked yet" before the first successful check (R70). | Spec §12 Dashboard; never block the page on exchange calls. | `packages/core/src/services/OverviewService.ts`. |
| R117 | 3c | **New read endpoints and scopes**: audit log `GET /api/audit` (+ `/actions`) admin + readonly (not agent; id-cursor paging, filters actor/action/action prefix/target/time range; the prefix `LIKE` now escapes `_`/`%`); config schema admin + readonly; config version text `GET /api/config/:file/history/:versionId` admin session only, secrets redacted; script versions + one version's source, bot orders (incl. `rejected_risk` with failed check + reason parsed from `risk_decision`), forecast by id, market search — all scopes (§7.3 `get_script`, `get_open_orders`, `get_forecasts`, `search_markets`); adoption preview `POST /api/reconcile/adopt/preview` admin session only. Halt history = audit rows `risk.*`. | Smallest set the pages need; each has a scope test (`tests/server/ui-routes.test.ts`). | `apps/server/src/routes/api.ts`. |
| R118 | 3c, amended 3c review | **Adoption preview** = `Reconciler.adoptPositions(..., { dryRun: true })`: same refusals, same per-token caps; **not read-only** — it first syncs the wallet's live orders with the exchange like a reconciler run (may record real fills, expire or link orders; the comments and the UI say so). A dry run holds the reconcile lock only for that sync and releases it before the Data API position / per-token history lookups (a real adoption keeps it to the end); returns the plan in `adopted`, writes no fill and no audit row (denials of a dry run are not audited either). The UI only enables **Adopt** after a preview and warns in red when `includePostFirstOrder` is ticked. | Spec asks for a preview of what will be adopted. | `Reconciler.adoptPositions` `dryRun`. |
| R119 | 3c | **Markets page searches the market cache only** (held / ordered / forecast / previously opened markets; substring of question, event, slug, or exact market/token id). Pasting a condition id opens any market through `GET /api/markets/:id` (fetches Gamma when not cached). No Gamma text search. | No new outbound integration in a UI chunk. | Add a Gamma `/markets?search=` proxy to `MarketService.search`. |
| R120 | 3c | **Script editor typings are generated** from `packages/core/src/sdk/types.ts` (Vite `?raw` import; `lib/sdkTypings.ts` turns `export interface/type` into ambient declarations, drops the internal RPC protocol, declares `ctx`), so autocomplete follows the real ctx API (placeLimit, cancel, cancelAll, getOpenOrders, getFee, risk.getBudget, ledger.*, fetch). The API reference modal was rewritten by hand. Monaco itself still loads from the jsDelivr CDN (pre-existing; offline the editor shows "Loading"). | Hand-kept typings were stale since 1b. | `components/ScriptEditor.tsx`. |
| R121 | 3c | **Bot code view** shows `script_versions` (the script's current revision by default — what a started bot runs, R20 — with "created on" marking `template_version`) and a line diff vs the previous version; diff = own LCS over lines with common prefix/suffix trimming (falls back to remove-all/add-all past 4 M cells), no `diff` dependency. The bot DTO gained `createdBy`, `allocationUsd`, `retireReason`, `pausedBy`, `strategy`, `marketIds`, `templateVersion`, `scriptRevision`, `scriptTrust`, `stageChangedAt`. Bot create: **Live** is disabled when `live_trading.enabled` is false or the config is invalid (UI only; the server already refuses, R98). | Spec §12 code view; avoid a dependency for a 60-line helper. | `lib/lineDiff.ts`, `BotService.botRowToIpc`. |
| R122 | 3c | **UI conventions**: one SSE subscription (`useLiveUpdates`) invalidates the overview / risk / bots / config / audit queries on `risk:halt`, `risk:halt-cleared`, `config:changed`, `bot:event`, `market:rulesChanged`; pages also poll (15–60 s). Below the `md` breakpoint the sidebar becomes a drawer behind a top bar; tables scroll horizontally inside their card. **Approvals** page is a placeholder (no approvals table; explains `approvals.new_template_live`). Kill switch: confirm dialog with optional reason, any page header (Dashboard, Risk). | Spec §12; phone use over Tailscale. | `components/Layout.tsx`, `hooks/useLiveUpdates.ts`. |
| R123 | 3c review | **Error text on read endpoints is redacted at the service boundary** (`services/redact.ts`): `PublicError` for messages written for users; `publicLookupError(err, what)` turns a library error into `<what> failed (<CODE>)`; `scrubPublicText` reduces URLs to `scheme://host/…` (Alchemy keys sit in the path, signed Binance queries in the query string), shortens 20-byte hex addresses and drops `requestBody=` / `body=` / `params=`. Applied to overview equity / reconciler / clock text and reconcile status errors. Other DTO error strings checked: bot stats/dashboard/positions only log lookup errors; order `reason` holds bot text or exchange answers (no credentials). | Reviewer finding 1: an agent token could read the RPC API key. | Return raw messages in `OverviewService` / `ReconcileService.status`. |
| R124 | 3c review | **Ambiguity form**: no default score (an explicit choice is required, the button stays disabled until then), and a confirmation dialog when the new score is ≤ the mandate's `max_ambiguity_score` (it unblocks buys, mentioning a still-active server raise) or lower than the current assessment, or when the mandate cannot be read. | Reviewer finding 3: defaulting to 0 made unblocking a market one click. | `AmbiguityForm` in `pages/Markets.tsx`. |

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

### 2026-10-31 — chunk 3a review fixes
- **Actors** (R88, R89; R84 amended): `services/actors.ts` with `asHuman/asAgent/asSystem`, `isActor`, `isHumanActor`,
  `requireActor`, `auditActorOf`; human-only domain methods take `HumanActor`; services take `Actor`; `ConfigFileService.get`
  and `history`, `ReconcileService.watchlistAdd/Remove`, `RiskService.killSwitch` gained actor parameters and checks.
  Electron handlers use `ipcHuman(event)` (`electron/ipc/respond.ts`). Tests that passed `'human'` to human-only methods
  now pass `asHuman('test')`; the denial test passes `asSystem()`.
- **Lifecycle** (R85 amended): `start()` retryable with rollback, startup halt applied once; `unlock()` requires a
  successful `start()`, rolls back on failure and can be retried; recovery flag set before `initialize()`.
- **DB** (R90): a second, different database in one process throws; `core.close()` closes only its own handle.
- Tests (`tests/core/create-core.test.ts`): unlock before start refused; failed start (seeding throws after the marker step)
  rolled back, retried without a false crash halt, then unlocks; `BotManager.initialize` throwing leaves the core locked
  (managers null, key cleared, bot start `locked`) and a retry succeeds; second DB refused and `close()` leaves another
  caller's DB open; strings, forged objects, agent and system actors refused by every human-only method (audited), a minted
  human clears the halt; config read by agent, not by system or a string; watchlist and kill switch record the agent.


### 2026-10-31 — chunk 3b
Done: HTTP server, SSE and auth over the 3a core; web client on fetch; Electron, the unlock screen,
`FALLBACK_PASSWORD` and the AI assistant removed; master key at boot with a `migrate-key` path for old
databases; cross-platform npm scripts; Windows service helper; Docker; nightly backups; CI builds on all
three OSes (Decisions R91–R107; R19, R81, R83 amended).

Server (`apps/server/src/`):
- `main.ts` (signals → graceful shutdown), `server.ts` (`startServer`: lock → master key → `createCore` →
  `start` → `unlock` → listen; `close()`), `app.ts` (Hono: host check, `/healthz`, `/api` principal + CSRF,
  auth routes, API routes, `/api/events`, static UI with SPA fallback), `routes/api.ts` (one declarative
  route per former IPC channel with its scopes and `recentAuth`), `routes/auth.ts`, `http/*` (principal and
  actor derivation, route helper, envelope + status mapping, SSE hub, hosts, static, health),
  `masterKey.ts`, `migrateKey.ts`, `cli.ts` (`migrate-key`, `gen-key`, `set-password`, `token …`),
  `paths.ts`, `instanceLock.ts`.
- Bind `127.0.0.1:3780` by default (`BOTLAB_HOST`/`BOTLAB_PORT`, or `http:` in server.yaml — new section);
  warning when bound to `0.0.0.0`/`::`.

Core changes: `security/masterKey.ts` (key check in `unlock`), `security/adminAuth.ts` (scrypt password,
sessions, API tokens; tables `auth_sessions`, `api_tokens`; columns `settings.admin_password_hash`,
`settings.key_check`), `security/migrateSecrets.ts` (`listSecrets`, `rekeySecrets`), `ops/BackupJob.ts`
(started/stopped by the core), `runtime/workerPath.ts` (`startWorker` with the tsx shim), `ServiceError`
code `forbidden`, `limits.yaml` `live_trading.enabled` (+ `live_disabled` pre-check, BotManager start
check), `BotService.create` defaults to paper, logger dir `BOTLAB_LOG_DIR`, Claude columns dropped,
`SettingsRepository` auth helpers instead of `updateAuth`/Claude methods.

Web (`apps/web`, moved from `web/client`): `src/lib/api.ts` (fetch client, same exports as `electronApi.ts`
plus `riskApi`/`configApi`/`ledgerApi`/`marketApi`/`reconcileApi`; `authApi` = session/setup/login/logout/
reauth/changePassword; one shared EventSource), `LoginScreen` (first-run setup / login, lock reason),
`ReauthDialog` (answers `reauth_required` and retries), logout button and lock banner in the layout,
Electron drag regions removed, Vite proxy for `/api` and `/healthz`, Bot create defaults to Paper.

Scripts: `npm run dev` (concurrently: `tsx watch` server + Vite), `build` (rimraf, `tsc -p
apps/server/tsconfig.build.json`, `vite build`), `start`, `typecheck` (core + server + web), `cli`,
`migrate-key`, `service:install`/`service:uninstall` (`scripts/service.mjs`), `test:server`. Removed:
`electron`, `electron-builder`, `@electron/rebuild`, `wait-on`, `ts-node`; `electron:*` scripts; `dist-electron`;
`ELECTRON_SKIP_BINARY_DOWNLOAD` in CI. `.gitignore`: `/data/`, `master.key`, `/secrets/`, `apps/web/dist/`;
`/scripts/` no longer ignored.

Docker: `Dockerfile` (multi-stage node:22-slim, non-root, HEALTHCHECK), `docker-compose.yml` (127.0.0.1 port,
key as secret file, volumes, `TZ=Europe/Dublin`, Tailscale sidecar example), `.dockerignore`. CI: lint,
typecheck, tests and `npm run build` on ubuntu/macos/windows; Docker buildx amd64+arm64 (no push).

Docs: README rewritten (quick start for macOS/Linux, Windows PowerShell, Docker; master key; upgrading from
Electron with `migrate-key`; Windows service + power/update notes; configuration; access/API/tokens);
CLAUDE.md updated for the server layout.

Tests (new): `tests/server/smoke.test.ts` (real HTTP server on a free port, temp data dir: health, first-run
setup, cookie flags, list bots/scripts, paper bot from a custom script whose worker runs from the `.ts`
sources through the tsx shim, SSE `ready` + bot status events, SPA fallback, JSON 404, clean shutdown
marker + lock released), `tests/server/auth.test.ts` (setup once, login rate limit + audit, idle expiry,
logout, CSRF header + Origin, 15-minute re-auth window for clear-halt/config write, agent token refused on
admin/human-only routes and recorded as `agent` even with `actor: 'human'` in the body, readonly GET-only,
revocation, Host allow-list), `tests/server/master-key.test.ts` (env/file/data-dir order, CRLF key file,
production without key, dev generation with 0600, key check refuses another key, `migrate-key` round trip
for a password and a skipped-password Electron DB), `tests/core/backup.test.ts`, `live_disabled` in
`order-service.test.ts`. `tests/electron` → `tests/runtime`; the bot IPC handler tests run against the HTTP
routes (`tests/server/bot-routes.test.ts`); the Electron auth handler test was removed.

Verified here (Linux): `npm run dev` server under tsx with a paper bot worker; `npm start` from `dist/` with
a paper bot and clean SIGINT shutdown; `docker build` + run (amd64) with healthz, UI, CLI, TZ and clean
SIGTERM shutdown.

Not done / not verified:
- **Windows and macOS not run here**: the NSSM service install, Ctrl+C / console-close (SIGHUP/SIGBREAK)
  behaviour, `%APPDATA%` paths and file modes on Windows, and the launchd/systemd instructions are
  untested. CI runs lint/typecheck/tests/build on all three OSes.
- arm64 Docker image not built here (CI does it under QEMU).
- Logs are not JSON and not pruned; no rclone backup copy; no UI to manage API tokens or change the
  password (API + CLI only); the Risk/Ledger/Audit/config pages are 3c.
- Many services still throw plain `Error` for validation, which the HTTP layer reports as 500 (R97).

### 2026-10-31 — chunk 3b review fixes
Independent security review of 081549d / c3b3603 (no criticals). Fixed (Decisions R108–R113; R93, R94 amended):
1. **Rate limit race**: password checks reserve a limiter slot before scrypt (login, re-auth, password change,
   setup code) — R108.
2. **Readonly tokens could read secrets** (`GET /api/settings` returned the Alchemy key; wallets were readable):
   wallets, settings and script export are admin-only for reads too; every GET route reviewed against R94.
3. **Recent password check** added to wallet create/update/delete, Binance save/clear and `PATCH /api/settings`.
4. **Agent bot limits in BotService**: config-only updates, paper-only creation without a wallet — R109.
5. **First-run claim**: one-time setup code from the server log unless the request is local to a loopback-bound
   server; boot warning when setup is pending and secrets exist; `migrate-key` always leaves an admin password — R110.
6. **Windows service as the user account** via NSSM `ObjectName` — R112.
Nits: one-transaction `migrate-key` with hidden-prompt / env passwords, `wx` instance lock with one stale retry,
session-keyed limiter behind a local proxy, `lockReason` only for authenticated callers, generic 500s with an
error id (`domainErrors` per route for user-facing domain errors), `.prettierrc` — R111, R113.

Tests: parallel wrong passwords (login 40 ⇒ 5 × 401 + 35 × 429; re-auth likewise; password change then 429);
readonly 403 on wallets/settings/config/tokens/script export; `reauth_required` on wallet/credential/settings
changes; agent create (wallet / live refused, paper allowed) and update (name/wallet/script/enabled refused,
config allowed) over HTTP and directly on `BotService`; setup code (required remotely, through a proxy header or
with a non-local Host; wrong code refused and audited; one-time); `migrate-key` refuses without an admin password
and changes nothing; `BotManager.startBot` refuses a live bot with live trading disabled (`tests/core/live-gate.test.ts`);
encoded static traversal (`..%2f`, `..%5c`, `%2e%2e%5c`) never serves a file outside the web dir; instance lock
(stale replaced, live holder refused); internal errors no longer echoed (bot route test).

Still unverified: the Windows service account flow and NSSM's grant of "Log on as a service" (no Windows host).

### 2026-10-31 — chunk 3c
Done: the remaining spec §12 pages on the 3b server — Dashboard risk picture, Risk (config editors + halts), Ledger,
Markets, Audit, Approvals (placeholder), Bot list/detail additions (stage, allocation, halt, code view, orders,
linked forecasts), Bot create live gate, Settings (Telegram, password, API tokens, reconciliation + adopt), script
editor typings and API reference, mobile layout, live updates over SSE (Decisions R114–R122; R19, R51 amended).

Core / server (small read additions only):
- `services/OverviewService.ts` (`GET /api/risk/overview`), `services/AuditLogService.ts` (`GET /api/audit`,
  `/api/audit/actions`; `AuditRepository.list` gained actor / until / before-id filters and an `actions()` list).
- `ConfigService.preview()` / `versionText()` / `configJsonSchemas()` → `POST /api/config/:file/preview`,
  `GET /api/config/:file/history/:versionId`, `GET /api/config/schema`.
- `ScriptService.versions()/version()` → `GET /api/scripts/:id/versions[/:version]`; `BotService.orders()` →
  `GET /api/bots/:id/orders`; `GET /api/ledger/forecasts/:id`; `MarketService.search()` → `GET /api/markets?q=`;
  `Reconciler.adoptPositions({ dryRun })` → `POST /api/reconcile/adopt/preview`; bot DTO fields (R121).

Web (`apps/web/src`):
- Pages: `Dashboard` (equity, exposure / long-horizon / open-order bars, daily P&L vs loss limit, halt banner with
  clear buttons, kill switch, live-trading-disabled banner, reconciler freshness + clock, category rights, allocation
  per bot), `Risk` (Limits / Mandate / Categories / Fees / Server editors with history, diff and restore; Halts tab
  with per-bot clear and the `risk.*` audit history), `Ledger` (forecasts with status / category / horizon filters and
  a detail dialog with rationale, sources, scores and withdraw; category rights per bucket with n_scored, skill mean /
  lower bound, convergence, allocation, expected threshold date and **Force state**; calibration table + SVG chart;
  manual forecast form), `Markets` (cache search, market detail with rules, category, flags, tokens, set ambiguity,
  recorder watchlist), `Audit` (filters + paging, payload on click), `Approvals`, `BotDetail` tabs **Code** and
  **Orders**, `Bots` (stage, created by, allocation, halted), `BotCreate` (live gate + warning), `Settings` sections.
- Components: `ui.tsx`, `ConfigEditor.tsx`, `SchemaForm.tsx`, `DiffView.tsx`, `HaltControls.tsx`,
  `SettingsSections.tsx`; hooks `useRisk.ts`, `useLiveUpdates.ts`; pure helpers `lib/lineDiff.ts`, `lib/schemaForm.ts`,
  `lib/sdkTypings.ts`, `lib/calibration.ts`, `lib/format.ts`; types `types/risk.ts`. Modals close on Escape.

Tests (new): `tests/server/ui-routes.test.ts` (scope matrix admin / readonly / agent for every new endpoint; overview
shape; audit paging + filters; preview classifies a raise and an invalid value without writing; version text 404;
script versions without source in the list; bot orders 404; adoption preview refused without an audit row),
`tests/web/ui-helpers.test.ts` (line diff incl. a randomized rebuild check, context collapsing, schema-form kinds /
`setAt` / input parsing, SDK typings contain the current ctx API, calibration buckets).

Verified in the browser (Playwright, Chromium, server under tsx with a temp data dir, no outbound network):
first-run setup, Dashboard, Bots, Bot detail (Overview, Code, Orders), Bot create, Scripts, Risk (limits form edit →
review shows the raise → tick → save; YAML tab with an invalid value → server issues shown; history diff; Mandate,
Categories, Fees, Server, Halts tabs), kill switch → halt banner → clear halt, Ledger (all four tabs), Markets, Audit,
Approvals, Wallets, Settings (token created and shown once), and the Dashboard / Risk / Ledger / Bots / Settings at
390 px width with the drawer menu. Only console errors: Monaco cannot reach its CDN
offline (pre-existing).

Not done / not verified:
- No agent page (spec §12 "Agent" is Phase 4). No Gamma text search on Markets (R119). The script list still has no
  version history / origin badge (the code view on Bot detail covers versions).
- With live data: equity from real wallets, reconciler mismatches, adoption preview against a real wallet, and
  forecasts / rights / calibration with real rows were not exercised (no network here); they render from the same
  DTOs the tests cover.
- The config form shows `bot_token` as a password field holding `***`; typing a new token replaces it, clearing it
  to empty removes it.

### 2026-10-31 — chunk 3c review fixes
Independent review of d7577ca / fb2f8fb (no criticals; the form round-trip was found clean). Fixed (R115, R116, R118
amended; R123, R124 new):
1. **Secret leak in `/api/risk/overview`**: `equity.error` carried the raw ethers error (Alchemy RPC URL with its
   API key, request body with the wallet address) to agent and readonly tokens. Now a short generic message; the full
   error is logged server-side. Reconciler / clock text in the overview and `GET /api/reconcile/status` errors are
   scrubbed the same way (`services/redact.ts`, R123).
2. **Restore skipped the review**: new `POST /api/config/:file/restore/preview` (admin session) classifies the version
   against the current file; the UI shows the same review panel with the raise tick before restoring, and
   `POST /api/config/:file/restore` takes `expectedSha256`, checked like `write` (R115).
3. **Ambiguity defaulted to 0**: explicit choice required; confirmation when the score unblocks buys or lowers the
   current assessment (R124).
Nits: adoption-preview comments and UI now say it syncs orders (real fills may be recorded) and the dry run releases
the reconcile lock after that sync (R118); after a save whose reload fails the editor keeps no stale hash and refuses
to save until the page is reloaded, and no write or restore is sent without a hash; switching to YAML clears form field
errors.

Tests (in `tests/server/ui-routes.test.ts`): saving every config file unchanged through preview and `PUT` gives zero
changes (and keeps the masked Telegram token); with the Polygon balance read failing like ethers (URL with key, body
with the address), the overview for admin, agent and readonly contains neither the key, the RPC host nor the
address and says `polygon balance lookup failed (SERVER_ERROR)`; redaction helpers; restoring the initial limits
after lowering two limits is classified `raises` for both keys, a restore with a stale hash is refused and changes
nothing, with the current hash it applies. Browser re-check (Playwright): limits review/save, YAML errors, history
diff, restore review dialog (classified `lowers` after the earlier raise) and restore, plus every page as before.

