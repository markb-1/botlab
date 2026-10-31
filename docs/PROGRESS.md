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
| 2b | Order-book recorder, reconciler | pending |
| 3a | Extract `packages/core` + services | pending |
| 3b | HTTP server + SSE + auth, web client on fetch, remove Electron + AI assistant, cross-platform scripts, Docker | pending |
| 3c | UI pages: Risk, Ledger, Audit, config editing | pending |

Testing policy: tests only for safety- and money-critical logic and core domain logic; existing suite must stay green.
Known pre-existing failures: `tests/copytrading/1-polymarket-data-api.test.ts` calls the live Polymarket API (fails without network; skipped when `SKIP_NETWORK_TESTS=1`).

## Decisions to review

Judgement calls made during the overnight run. Each says how to reverse it.

| # | chunk | decision | why | to reverse |
|---|---|---|---|---|
| R1 | 1a | Risk-exit sells are exempt from `max_order_usd`, `max_orders_per_hour`, `max_open_orders` and `max_spread` (still bound by scope, held position, price range, slippage). | Otherwise an exit from an ambiguous/rule-changed market can be impossible on a wide book or after the per-order cap. | Remove the exemptions in `RiskEngine` step 3/4. |
| R2 | 1a | "Long horizon" is fixed at 30 days; mandate `resolves_within_days[1]` must be ≤ 30. | A mandate edit could otherwise switch off the long-horizon cap. | Change `LONG_HORIZON_DAYS` and the schema refinement. |
| R3 | 1a | Market-quality gates (category, ambiguity, rules-changed, liquidity) apply to buys only. | Exits must remain possible from markets that became risky. | `RiskEngine` step 2. |
| R4 | 1b, replaced 2a | ~~Ambiguity and rules-change placeholders~~ **Replaced in 2a**: `PlaceholderMarketQualityProvider` is gone; `MarketCacheService` supplies category, effective ambiguity and `rules_changed_at` from `market_cache` (see R51–R53). | — | — |
| R5 | 1b, replaced 2a | ~~Mandate category = raw Gamma label~~ **Replaced in 2a** by `config/categories.yaml` + `categorize()` (R50); `mandateCategory()` removed. | — | — |
| R6 | 1b | **Binance counts toward global total exposure** (USDT/USDC/FDUSD = 1 USD) and toward the bot's Binance allocation; not toward per-market or long-horizon. Non-USD-quoted Binance symbols are rejected (`unsupported_symbol`). | Spec intent: global limits cover all live exposure. | `DbRiskStateProvider.computeExposure`, `OrderService.placeBinance`. |
| R7 | 1b | **Equity** = cash (the bot's Polymarket wallet USDC + Binance USDT if credentials are set) + cost basis of all open live positions. It is read for **buys only**: sells (incl. risk exits) never fetch the balance and the engine ignores equity for them. The cash cache (30 s) is dropped after every fill so cash already turned into a position is not counted twice; on-chain settlement lag can still briefly double-count until the balance updates. Read failure ⇒ NaN ⇒ buys rejected `state_invalid`. Multi-wallet setups under-count equity (conservative). | Cash alone would shrink the % limit as positions grow; exits must work when the RPC is down. | `BotManager.createOrderService` `getCashUsd`, `DbRiskStateProvider.getSnapshot`, `RiskEngine` step 0. |
| R8 | 1b | **Only OrderService fills count as positions**: exposure and sellable size come from `bot_trades` rows with an `order_id`. Pre-v3 auto-recorded trades and `ctx.recordTrade` rows are ignored (`recordTrade` strips `orderId`), so existing live positions from before 1b are invisible to the risk engine and cannot be sold by bots (sell manually). `BotManager.initialize` logs a warning listing live bots with such unlinked positions. | A script could otherwise fabricate positions or sells. | `BotTradeRepository.getRiskPositions`. |
| R9 | 1b | **Post-only is emulated**: clob-client 4.22.8 has no `postOnly` flag, so a post-only order is rejected (`post_only`) if it would cross the book at check time; the book can still move before it lands. `placeLimit` defaults to `postOnly: true`. | Spec default is resting post-only. | `OrderService.placeLimit`; use the native flag after upgrading clob-client. |
| R10 | 1b | **ctx.buy/sell are now one FOK order** at a risk-checked worst price (best ask/bid ± `maxSlippage`, or `maxPrice`/`minPrice`, on the tick grid) instead of the old loop of up to 3 retries walking the book. `retries` is ignored. Partial fills only happen in paper. | One exchange order per risk-checked order row; the old loop could walk the book unchecked. | `OrderService.placeMarketable`. |
| R11 | 1b | **Order lifecycle without a reconciler**: only a definite exchange answer marks `failed` (Polymarket: HTTP 4xx except 408/425/429, or a 2xx `success:false`; Binance: same 4xx rule). 5xx, 408/425/429, network errors and missing status ⇒ outcome unknown ⇒ row stays `submitted` and keeps counting toward exposure/open orders. To stop rows accumulating, each bot's sync (before each order, on `getOpenOrders`/cancel): GTD orders past `expires_at` + 60 s get a final fill check then `expired`; an order the exchange no longer returns once past `expires_at` ⇒ `expired`; FOK `unmatched` ⇒ `cancelled` (no fill); market orders still `submitted` (delayed or unknown outcome) get a 5-minute lifetime, then `expired` with no fill seen — **a Binance or Polymarket unknown-outcome order that actually filled is then missed** until the 2b reconciler. A failed exchange lookup leaves the order open. `cancelAll` reports unknown-outcome orders separately (`unknownOutcome`) instead of failing. Other bots' orders are only synced by their own bot. | Fail closed while an order may be live, without letting dead orders block trading forever. | `OrderService.syncUnlocked`/`applyOutcome`; `interpretPostResponse`. |
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

| R50 | 2a | **Category mapping** (`config/categories.yaml`, hot-reloaded, any edit classified `raises`): ordered rules, **first match wins**, denied categories listed first (sports, crypto-price, mentions, us-elections-headline, culture-entertainment), then a `fed-headline` category (spec §3.3 excludes the headline Fed meeting from economics; it is in no mandate list, so never allowed), geopolitics, weather-climate, economics, science-tech, politics-non-us. A rule matches on any strong tag, or on a whole-word keyword in the question/event title gated by `when_tags`; `exclude_keywords` veto. Any US political market with a US keyword (Senate, Trump, …) maps to `us-elections-headline` (denied), not only elections. A generic "election" market without a country tag or non-US keyword is `other`. Unmapped ⇒ `other`; mandate may not allow `other` (schema error). **Tag slugs are from knowledge of the Gamma API and unverified — check a sample of live markets per category before live trading.** Cached markets are re-categorized when the file changes. | Fail closed; explicit and human-editable. | Edit `config/categories.yaml`; matching in `electron/ledger/categorize.ts`. |
| R51 | 2a | **Unassessed ambiguity ⇒ buys rejected** (live and paper): a market can only be bought after someone assessed it — a forecast's `ambiguityScore` (agent later, human now via `ledger:submitForecast`) or a human via `markets:setAmbiguity(marketId, score, note)` (main window only; no UI until 3c, use DevTools: `await window.electronAPI.markets.setAmbiguity('<conditionId>', 0, 'note')`). **Consistency / resolution-rule bots therefore need each market assessed first.** The latest assessment wins (human or forecast). The market stores the raw score; the server raise (≥ 2 for 7 days after a rules change, or while a UMA dispute is recorded) is applied at read time, so it lapses on its own; the forecast row stores the raised score. | Spec §7.4; same fail-closed rule as other missing market data (1a). | `effectiveAmbiguity` in `electron/ledger/ambiguity.ts`; `RiskEngine` step 2. |
| R52 | 2a | **UMA dispute detection** uses Gamma `umaResolutionStatus` and the `umaResolutionStatuses` history: any value containing "disput" ⇒ `disputed` (sticky once seen, audited `market.disputed`, Telegram if held). Field names are **unverified** against live data; if Gamma lacks them no dispute is ever detected (TODO: CLOB/UMA source). | Only Gamma fields available without a new integration. | `parseGammaMarketFull` in `electron/ledger/MarketCacheService.ts`. |
| R53 | 2a | **Market cache refresh**: on the order path a row older than 10 min is refreshed with a 5 s cap; on failure the cached row is used (and the 5-min Gamma lookup in `MarketDataService` still gates buys); a market never cached gets its category from the order's Gamma labels and ambiguity unknown. Every 30 min: markets with live or paper positions, open orders, or active forecasts (batches of 20 `condition_ids`). `rules_hash` = sha256 of the NFC, whitespace-collapsed `description` + "Resolution source: …"; whitespace-only edits are not changes; a response without `description` keeps the previous rules; the first sighting is never a change. A change sets `rules_changed_at`, is audited `market.rules_changed` with the bots holding a **live** position, emitted as `market:rulesChanged` (renderer), and sent to Telegram (high) only if held. `ctx.events` for bots is not built yet. | Spec §2.2/§11; never block orders on Gamma. | `MarketCacheService`. |
| R54 | 2a | **Resolution source for scoring** = Gamma market: `closed` and `outcomePrices` exactly 0/1 with one winner ⇒ resolved (payout per token index); all 0.5 ⇒ `void`; a UMA status saying proposed/disputed/challenged ⇒ wait; anything else (e.g. 0.9995) ⇒ wait for the next run. `resolved_at` is the detection time, not Gamma's close time. Not used: CLOB `tokens[].winner` (would need a second API). Only `active` forecasts become `resolved`; superseded/withdrawn keep their status and get `outcome`/Brier/skill (they are scored); `void` applies to every forecast on the market. | One reliable field set; never score a provisional price. | `parseResolution` in `electron/ledger/scoring.ts`. |
| R55 | 2a | **Convergence capture**: the hourly scorer records `price_at_7d` (CLOB mid) for unresolved forecasts once 7 days have passed — up to an hour late, or later if the app was down; the actual capture time is stored (`price_at_7d_at`). A forecast resolved before day 7 gets the resolution price (0/1). One resolved after day 7 without a capture gets no convergence value. Convergence votes are timed by capture. | Spec §6.2 leaves timing open. | `LedgerService.runUnsafe`. |
| R56 | 2a | **Forecast input**: strict (unknown keys such as prices, `createdAt` or `tradeable` are rejected, not ignored); `sources` = up to 50 http(s) URLs (may be empty); markets settling in > 90 days are rejected (no bucket); a two-sided CLOB book is required (mid = (bid + ask) / 2); `liquidity_usd` = Gamma `liquidityNum` (book liquidity, not 24 h volume); `event_id` falls back to the market id. `tradeable` = bucket is `trading` **and** the category is in the mandate allow list at insert; a forecast written while shadow stays untradeable (re-submit after the bucket trades). | Spec §6.1. | `SubmitForecastSchema`, `LedgerService.submitForecast`. |
| R57 | 2a | **Rights rules (interpretations of §6.3)**: only `allow` categories can trade (later, deny and unlisted never; a trading bucket whose category leaves `allow` goes back to `shadow`, allocation 0). Suspension: mean skill of the last min(20, n) event votes (by resolution time) < 0 ⇒ `suspended`, allocation 0. Re-qualification: events scored after the suspension only, same threshold (30, medium 20 if short trades) and lower bound > 0 ⇒ allocation back to 50. Allocation = 50 + 50 per further 20 events since (re)qualifying while lb > 0, never reduced while trading except by a lower budget, capped by `mandate.budget_usd`. Deprioritised only from `shadow` and left only by a human. Bootstrap seeded per bucket (FNV-1a of `category\|bucket`) so bounds are reproducible. **Human force** (`ledger:setRightsState`, main window only, audited, Telegram): sets a `forced` flag that blocks automatic promotion and deprioritisation (suspension and the mandate rule still apply); forcing `trading` is refused outside `allow` and starts at max(current, 50); `auto` clears the flag. With an invalid config the stats update but rights never change. Loss-limit suspension is a hook (`suspendForLoss`), not called until ledger-driven P&L per category exists. | Spec §6.3 leaves these open. | `decideRights` in `electron/ledger/scoring.ts`, `LedgerService.forceRightsState`. |
| R58 | 2a | **Ledger-driven orders**: the forecast's (category, bucket) is the one fixed at forecast time; only an `active` **tradeable** forecast resolves (else `forecast_unavailable`); the complementary token of a binary market uses 1 − p. Bucket exposure = the **whole** cost basis of every in-scope position a ledger-driven buy in that bucket filled into (even if part was bought without a forecast) + unfilled notional of open ledger-driven buys. | Conservative. | `DbRiskStateProvider.getCategoryBucket`, `LedgerService.get`. |
| R59 | 2a | **Ledger services run before unlock** (Phase A, like halts): scorer hourly (first run at start), market refresh every 30 min; IPC `ledger:list`, `ledger:stats`, `markets:get` are unrestricted, the writes main-window only with actor `human`. No UI (3c). | They need no wallet keys. | `electron/main.ts`. |

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
