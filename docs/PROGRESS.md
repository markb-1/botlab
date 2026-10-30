# BotLab v3 — Development Progress

Implementation log for `docs/SPEC.md`. Each chunk is implemented, reviewed independently, fixed, then committed.

## Plan

| chunk | scope | status |
|---|---|---|
| 1a | `.gitattributes`, 3-OS CI, config system (limits schema/loader), RiskEngine, `orders` + `risk_state` tables | done |
| 1b | OrderService choke point, GTD limit orders, fee table, route all live orders through RiskEngine | pending |
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

