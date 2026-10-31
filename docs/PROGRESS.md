# BotLab v3 — Development Progress

Implementation log for `docs/SPEC.md`. Each chunk is implemented, reviewed independently, fixed, then committed.

## Plan

| chunk | scope | status |
|---|---|---|
| 1a | `.gitattributes`, 3-OS CI, config system (limits schema/loader), RiskEngine, `orders` + `risk_state` tables | done |
| 1b | OrderService choke point, GTD limit orders, fee table, route all live orders through RiskEngine | done |
| 1c | Halts, daily loss, kill switch, start-halted-after-crash, ramp stages, audit log | pending |
| 1d | Sandbox hardening, backtests in worker, AES-GCM migration, copy-trading sell fix | pending |
| 1e | Telegram notifications, config hot reload | pending |
| 2a | Forecast ledger, scoring, category rights, market cache | pending |
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
| R4 | 1b | **Ambiguity and rules-change are placeholders**: `PlaceholderMarketQualityProvider` returns ambiguity 0 and no rules change for every market, so those two mandate checks are not enforced until chunk 2a. | No market cache / agent scoring exists yet. | Replace the provider in `BotManager.createOrderService` (TODO chunk 2a). |
| R5 | 1b | **Mandate category = Gamma category/tag slug** compared directly with the mandate lists (no `categories.yaml` yet); if any label is denied (or "later") that wins, else an allowed label, else the first label (rejected). E.g. Polymarket "Weather" ≠ mandate `weather-climate`, so such buys are rejected until the mapping exists or the mandate lists `weather`. | Fail closed until the 2a mapping table. | `mandateCategory()` in `electron/orders/MarketDataService.ts`. |
| R6 | 1b | **Binance counts toward global total exposure** (USDT/USDC/FDUSD = 1 USD) and toward the bot's Binance allocation; not toward per-market or long-horizon. Non-USD-quoted Binance symbols are rejected (`unsupported_symbol`). | Spec intent: global limits cover all live exposure. | `DbRiskStateProvider.computeExposure`, `OrderService.placeBinance`. |
| R7 | 1b | **Equity** = cash (the bot's Polymarket wallet USDC + Binance USDT if credentials are set) + cost basis of all open live positions. It is read for **buys only**: sells (incl. risk exits) never fetch the balance and the engine ignores equity for them. The cash cache (30 s) is dropped after every fill so cash already turned into a position is not counted twice; on-chain settlement lag can still briefly double-count until the balance updates. Read failure ⇒ NaN ⇒ buys rejected `state_invalid`. Multi-wallet setups under-count equity (conservative). | Cash alone would shrink the % limit as positions grow; exits must work when the RPC is down. | `BotManager.createOrderService` `getCashUsd`, `DbRiskStateProvider.getSnapshot`, `RiskEngine` step 0. |
| R8 | 1b | **Only OrderService fills count as positions**: exposure and sellable size come from `bot_trades` rows with an `order_id`. Pre-v3 auto-recorded trades and `ctx.recordTrade` rows are ignored (`recordTrade` strips `orderId`), so existing live positions from before 1b are invisible to the risk engine and cannot be sold by bots (sell manually). `BotManager.initialize` logs a warning listing live bots with such unlinked positions. | A script could otherwise fabricate positions or sells. | `BotTradeRepository.getRiskPositions`. |
| R9 | 1b | **Post-only is emulated**: clob-client 4.22.8 has no `postOnly` flag, so a post-only order is rejected (`post_only`) if it would cross the book at check time; the book can still move before it lands. `placeLimit` defaults to `postOnly: true`. | Spec default is resting post-only. | `OrderService.placeLimit`; use the native flag after upgrading clob-client. |
| R10 | 1b | **ctx.buy/sell are now one FOK order** at a risk-checked worst price (best ask/bid ± `maxSlippage`, or `maxPrice`/`minPrice`, on the tick grid) instead of the old loop of up to 3 retries walking the book. `retries` is ignored. Partial fills only happen in paper. | One exchange order per risk-checked order row; the old loop could walk the book unchecked. | `OrderService.placeMarketable`. |
| R11 | 1b | **Order lifecycle without a reconciler**: only a definite exchange answer marks `failed` (Polymarket: HTTP 4xx except 408/425/429, or a 2xx `success:false`; Binance: same 4xx rule). 5xx, 408/425/429, network errors and missing status ⇒ outcome unknown ⇒ row stays `submitted` and keeps counting toward exposure/open orders. To stop rows accumulating, each bot's sync (before each order, on `getOpenOrders`/cancel): GTD orders past `expires_at` + 60 s get a final fill check then `expired`; an order the exchange no longer returns once past `expires_at` ⇒ `expired`; FOK `unmatched` ⇒ `cancelled` (no fill); market orders still `submitted` (delayed or unknown outcome) get a 5-minute lifetime, then `expired` with no fill seen — **a Binance or Polymarket unknown-outcome order that actually filled is then missed** until the 2b reconciler. A failed exchange lookup leaves the order open. `cancelAll` reports unknown-outcome orders separately (`unknownOutcome`) instead of failing. Other bots' orders are only synced by their own bot. | Fail closed while an order may be live, without letting dead orders block trading forever. | `OrderService.syncUnlocked`/`applyOutcome`; `interpretPostResponse`. |
| R12 | 1b | **Paper mode** uses the same limits with stage `paper` treated as `full`, scoped to the bot's own paper orders/fills (stored with `orders.simulated = 1`, `bot_trades.simulated = 1`); halts apply to paper too. Paper fills need the same market data as live (Gamma + book), so paper buys in non-mandate categories are rejected. Resting paper orders are not simulated: `placeLimit` in paper fills at the limit price if marketable (requires `postOnly: false`), else returns `paper mode: resting orders not simulated yet`. | Paper should behave like live. | `DbRiskStateProvider` `simulated`, `OrderService.placeLimit`. |
| R13 | 1b | **Fees**: expected fee = taker rate × filled notional (= rate × p × size), recorded only for what filled; unknown fee category ⇒ highest configured rate; maker 0. Polymarket's documented taker formula may be `rate × min(p, 1−p) × size`, but neither clob-client 4.22.8 nor anything in node_modules confirms it, so the larger (conservative) formula stays. Default rates are unverified (comment in `FeeService.ts`). Binance fees are not modelled (`fee_usd` 0). | Conservative until verified. | `config/fees.yaml`, `FeeService`, `OrderService.applyOutcome`. |
| R14 | 1b | **Invalid risk config disables bot start**: `BotManager.initialize` loads limits/mandate/fees once; on `ConfigError` no bot (live or paper) can start, rather than falling back to defaults. | Fail closed. | `BotManager.initialize`. |

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

