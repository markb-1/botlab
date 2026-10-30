# BotLab v3 — Specification

Status: **Draft for review** · Owner: Mark · Last updated: 2026-10-30

---

## 0. Summary

BotLab becomes a **personal, always-on trading lab for Polymarket** (Binance secondary). An AI agent
researches markets, writes and configures bots, deploys them live, and manages them. **Bots place
orders; the agent never does.** Every order passes a server-side **risk engine** the agent cannot
modify. The agent earns autonomy through a measured track record (**forecast ledger** + **bot ramp**),
not through human approval of each action.

### Goals
1. Run headless 24/7 on a VPS/home server; browser UI over a private network.
2. Expose the platform to an AI agent via MCP so it can research, build, deploy and operate bots.
3. Make it impossible for any bot or agent action to exceed human-set hard limits.
4. Measure whether the agent has a real forecasting edge before letting it trade on its forecasts.
5. Keep every trade explainable: readable bot code + ledger entry + audit log.

### Non-goals
- Multi-user / SaaS, custody of anyone else's funds, public access.
- High-frequency / latency arbitrage (we will not win speed races).
- The agent placing discretionary orders directly.
- Leverage, derivatives, or Binance margin/futures.

### Decisions already made
| # | Decision |
|---|---|
| D1 | Personal tool, single user, self-hosted. |
| D2 | Polymarket primary, Binance secondary (existing functionality kept, not extended). |
| D3 | Live trading without per-bot approval, under hard limits. |
| D4 | Approval mode: **fully autonomous within limits**; notifications only. A config flag allows requiring approval for new templates later. |
| D5 | Agent creates and manages bots; only bots place orders. Agent may directly *reduce* risk (pause/stop/kill). |
| D6 | AI forecasts trade only in categories where the ledger shows skill vs market. |
| D7 | Electron is retired; replaced by a Node server + browser UI. |
| D8 | Bot code remains viewable in the UI (lower priority than safety features). |

---

## 1. Architecture

```
                         Tailscale (private network only)
        ┌──────────────────────────────────────────────────────────────────┐
Browser │  apps/server  (single Node process)                              │
  ─────►│   HTTP API + SSE ──┐                                             │
        │                    ├──► core services ──► Risk Engine ──► Exchanges
Agent   │   MCP endpoint ────┘     (bots, scripts,     ▲  (Polymarket CLOB,
(Claude │                          ledger, markets,    │   Binance)        │
 Agent  │                          backtest, audit)    │                   │
 SDK) ─►│                              │               │                   │
        │                              ▼               │                   │
        │   Bot workers (worker_threads) ──RPC──► RpcHandler ──────────────┘
        │   Schedulers: agent cycle, ledger scorer, reconciler, recorder   │
        │   SQLite (better-sqlite3) + nightly backup                       │
        └──────────────────────────────────────────────────────────────────┘
```

### 1.1 Repository layout (target)

```
packages/core/            # all domain logic, no transport code
  db/                     # schema, migrations, repositories
  risk/                   # RiskEngine, limits config, kill switch, ramp
  exchange/polymarket/    # CLOB client wrapper, orders, fees, data API
  exchange/binance/
  runtime/                # ScriptRunner, worker-bootstrap, RpcHandler, BotContextProxy, PaperTradingState
  ledger/                 # forecasts, scoring, category rights
  services/               # BotService, ScriptService, MarketService, LedgerService, AuditService, ...
  agent/                  # mandate loader, cycle orchestration helpers
  notify/                 # Telegram / ntfy
  recorder/               # order-book snapshot recorder
  security/               # key handling, AES-GCM
apps/server/              # Hono HTTP API, SSE, MCP server, schedulers, entrypoint
apps/web/                 # React SPA (current web/client, IPC → fetch)
apps/agent/               # scheduled agent runner (Claude Agent SDK) — talks to server via MCP only
templates/                # built-in bot templates (TypeScript)
config/                   # limits.yaml, mandate.yaml, server.yaml (human-owned)
docs/
```

Rules:
- `apps/*` depend on `packages/core`; `packages/core` never imports from `apps/*`.
- HTTP handlers and MCP tools are **thin**: validate input → call a service → shape output.
  No business logic in transport code (today's `botHandlers.ts` stats/positions logic moves into services).
- Every service function is callable from tests without a server.

### 1.2 Process model
- One server process owns the DB, risk engine, bot workers and schedulers.
- The agent runs as a **separate process** (`apps/agent`) and can reach the platform **only via MCP**.
  It has no shell, no filesystem access to the server, and no DB access.
- Schedulers run inside the server: ledger scorer (hourly), reconciler (1 min), order-book recorder
  (configurable), daily-loss reset (00:00 UTC), backup (nightly), agent cycle trigger.

---

## 2. Data model

Existing tables kept: `wallets`, `scripts`, `bots`, `bot_trades`, `bot_storage`, `settings`,
`backtest_runs`, `backtest_trades`, `kline_cache`. Changes and additions below.

### 2.1 Changes to existing tables
- `scripts`: add `kind` (`template` | `custom`), `origin` (`builtin` | `human` | `agent`),
  `version` (int, increments on every source change), `trust` (`new` | `proven`),
  `source_hash`. Keep previous versions in a new `script_versions` table (id, script_id, version,
  source, compiled, created_at, created_by).
- `bots`: add `template_version`, `stage` (`paper` | `probation` | `full` | `retired`),
  `allocation_usd`, `created_by` (`human` | `agent`), `retire_reason`, `market_ids` (JSON array of
  condition IDs the bot is scoped to), `strategy` (template key), `paused_by`.
- `bot_trades`: add `order_id` (FK to `orders`), `fee_usd`, `category`.

### 2.2 New tables

**orders** — every order attempt, including rejected ones.
| column | notes |
|---|---|
| id | internal UUID; also used as client order id / idempotency key |
| bot_id, exchange, market_id, token_id, side, order_type (`limit`/`market`) | |
| price, size, notional_usd | requested |
| expires_at | GTD expiry (required for resting orders, see §4.3) |
| status | `rejected_risk`, `submitted`, `open`, `partially_filled`, `filled`, `cancelled`, `expired`, `failed` |
| risk_decision | JSON: which checks ran, values, which failed |
| exchange_order_id, filled_size, avg_fill_price, fee_usd | |
| reason | free text from the bot (e.g. "ledger edge 0.07 on forecast f_123") |
| forecast_id | nullable FK when the order is ledger-driven |
| created_at, updated_at | |

**forecasts**
| column | notes |
|---|---|
| id, market_id (condition id), token_id (the YES token being forecast), event_id, category | |
| probability | agent's estimate, 0.01–0.99 |
| market_price_at_forecast | mid price captured server-side at insert time (agent cannot supply it) |
| best_bid, best_ask, liquidity_usd | snapshot at insert time |
| rationale | markdown, required, ≤ 4k chars |
| sources | JSON array of URLs |
| ambiguity_score | 0–3 (see §7.4) |
| status | `active`, `superseded`, `withdrawn`, `resolved`, `void` |
| superseded_by | FK |
| tradeable | bool, computed at insert from category rights |
| created_at, resolved_at, outcome (0/1/null), brier_agent, brier_market |

Constraint: at most one `active` forecast per token. A new forecast supersedes the old one.

**category_rights**
| column | notes |
|---|---|
| category | PK |
| state | `shadow` (record only) / `trading` / `suspended` |
| n_scored, skill_mean, skill_lower_bound, last_evaluated_at, changed_at, changed_reason | |
| max_allocation_usd | grows with track record (§6.3) |

**risk_state** — singleton + per-bot rows: `halted` (bool), `halted_reason`, `halted_at`,
`day_start_equity`, `day_realized_pnl`, `day_unrealized_pnl`, `orders_last_hour`.

**audit_log** — append-only. `id, ts, actor (human|agent|bot:<id>|system), action, target,
payload JSON, result`. Every MCP tool call, every human config change, every bot lifecycle change,
every risk rejection, every kill-switch event. Never updated or deleted by the app.

**agent_runs** — `id, started_at, finished_at, trigger (schedule|manual), status, tokens_in,
tokens_out, cost_usd, summary_md, actions JSON`.

**agent_notes** — the agent's persistent memory. `id, scope (market:<id> | category:<c> |
strategy:<key> | general), title, body_md, created_at, updated_at`. Read/write via MCP.

**approvals** — `id, kind (template_live | limit_raise | ...), target, status, requested_at,
decided_at, decided_by, note`. Empty in default mode; exists so D4 can be flipped.

**orderbook_snapshots** — `token_id, ts, best_bid, best_ask, mid, bids JSON (top N), asks JSON (top N), last_trade_price`.
Used for future backtests (§10).

**market_cache** — `market_id, event_id, slug, question, category, rules_text, end_date,
resolution_source, neg_risk, tokens JSON, fee_category, updated_at, rules_hash`. `rules_hash`
change ⇒ "rules changed" event.

---

## 3. Configuration (human-owned)

Config files live in `config/`, are loaded at startup and on `SIGHUP` / UI "reload", and are
**never writable via MCP**. Changes made through the UI are written to the file and recorded in
`audit_log`.

### 3.1 `config/limits.yaml`
```yaml
global:
  max_total_exposure_usd: 300        # open position cost + open buy order notional
  max_total_exposure_pct: 0.60       # of wallet equity; the lower of the two applies
  daily_loss_limit_usd: 100          # trips global halt
  max_open_orders: 50
per_bot_defaults:
  max_order_usd: 25
  allocation_usd: 100                # max exposure for a bot at stage=full
  daily_loss_limit_usd: 50           # trips bot halt
  max_orders_per_hour: 20
  min_hold_minutes: 30               # cannot sell a position opened < N min ago (exits by position manager exempt when flagged risk_exit)
per_market:
  max_exposure_usd: 50               # across all bots
  min_liquidity_usd: 5000            # 24h volume
  min_top_of_book_usd: 200           # size at best price on the side we take
  no_trade_before_end_minutes: 60
  max_slippage: 0.02                 # absolute price units from best price for marketable orders
  max_spread: 0.06                   # don't trade if spread wider
orders:
  default_type: limit                # resting post-only by default
  allow_marketable: true             # crossing orders allowed but subject to slippage + fees
  resting_order_ttl_minutes: 240     # GTD expiry, see §4.3
ramp:
  probation_allocation_usd: 20
  probation_min_fills: 20
  probation_min_days: 7
  probation_max_drawdown_pct: 0.25
  new_template_paper_days: 7
  new_template_probation_allocation_usd: 10
agent:
  monthly_llm_budget_usd: 50
  max_bots_created_per_day: 10
  max_active_bots: 25
approvals:
  new_template_live: false           # D4; set true to require approval
binance:
  enabled: true
  max_order_usd: 25
  allocation_usd: 100
```

### 3.2 `config/mandate.yaml`
```yaml
budget_usd: 300                       # must be ≤ limits.global.max_total_exposure_usd
categories:
  allow: [economics, politics-non-us, geopolitics, science, tech, culture]
  deny:  [sports, crypto-short-term]
markets:
  resolves_within_days: [1, 60]
  min_liquidity_usd: 5000
  max_ambiguity_score: 1              # skip markets rated 2–3
strategies:
  allow: [forecast, consistency, resolution_rule]   # template keys
  allow_custom_templates: true
notes: |
  Free-text guidance for the agent (themes of interest, things to avoid).
```

The agent reads both files via MCP resources. It cannot write them.

---

## 4. Risk engine

`packages/core/risk/RiskEngine.ts`. **Single choke point**: every order from any bot (live mode)
goes `RpcHandler → OrderService.place() → RiskEngine.check() → exchange`. There is no other code
path to an exchange order endpoint; enforced by a lint rule / test that only `OrderService` imports
the CLOB `postOrder`/`createOrder` functions.

### 4.1 Check order (fail fast, all results recorded in `orders.risk_decision`)
1. Global halt? Bot halt? Bot stage allows live (`probation`/`full`)?
2. Market allowed: in bot's `market_ids`; category allowed by mandate; not within
   `no_trade_before_end_minutes`; ambiguity ≤ mandate max; market not flagged `rules_changed`
   in the last 24h (buys only).
3. Order shape: `notional ≤ max_order_usd`; price within [0.01, 0.99]; spread ≤ `max_spread`;
   marketable orders: price within `max_slippage` of best; top-of-book depth ≥ `min_top_of_book_usd`.
4. Rate: bot `orders_last_hour < max_orders_per_hour`; global open orders < `max_open_orders`.
5. Exposure (buys only; sells that reduce exposure always pass this step):
   bot exposure + notional ≤ effective allocation (stage-dependent);
   market exposure + notional ≤ `per_market.max_exposure_usd`;
   total exposure + notional ≤ min(global usd, pct × equity);
   ledger-driven orders: category exposure + notional ≤ `category_rights.max_allocation_usd`.
6. Hold time: sells blocked if position age < `min_hold_minutes` unless order flagged `risk_exit`
   by the position manager or a human.
7. Edge (ledger-driven orders only): `|p − price| − expected_fee ≥ min_edge` (template config,
   floor 0.03) using the live fee table (§4.4).

Rejected orders are stored with `status=rejected_risk` and returned to the bot as a typed error.
Repeated rejections (> 10/hour/bot) trigger a notification.

### 4.2 Loss limits and halts
- **Daily P&L** = realized P&L today + change in mark-to-market (mid) of open positions since
  00:00 UTC. Computed by the reconciler every minute.
- Bot daily loss ≥ limit ⇒ bot halted: open orders cancelled, bot paused, notification.
- Global daily loss ≥ limit ⇒ **global halt** (same as kill switch).
- Halts are cleared **only by a human** (UI action with admin token). Daily reset does not clear a halt.

### 4.3 Kill switch and dead-man protection
- Kill switch (UI button, phone command, MCP `kill_switch` tool, global loss limit):
  set global halt → cancel all open orders on all exchanges → stop all bot workers → notify.
  Positions are **not** auto-liquidated (thin books make forced selling costly); the human decides.
- Every resting order is placed **GTD** with `expires_at = now + resting_order_ttl_minutes`.
  Bots that want to keep an order alive must re-place it. If the server dies, orders expire on their own.
- On server start: reconcile open orders against the exchange; cancel any open order not owned by
  a running bot; start in `halted` state if the previous shutdown was unclean and
  `server.yaml: start_halted_after_crash: true` (default true).

### 4.4 Fees
- `FeeService` maintains a fee table per Polymarket fee category (taker rate; maker = 0) loaded from
  config with an override in `config/fees.yaml`, refreshed from Polymarket docs/API if an endpoint
  exists. Each market's fee category is stored in `market_cache.fee_category`.
- Expected fee is included in edge calculations, P&L, and `orders.fee_usd`.
- Default order type is **post-only limit** (maker, no fee). Marketable orders must clear edge after fees.

### 4.5 Ramp (per bot)
| stage | how entered | effective allocation | exits |
|---|---|---|---|
| `paper` | new bot on a template with `trust=new` | n/a (PaperTradingState) | after `new_template_paper_days` with no runtime errors ⇒ `probation` |
| `probation` | new bot on a `proven` template, or after paper | `probation_allocation_usd` (or the smaller new-template value) | ≥ `probation_min_fills`, ≥ `probation_min_days`, no halts, drawdown ≤ `probation_max_drawdown_pct` ⇒ `full` |
| `full` | promotion | `allocation_usd` | halt with loss ⇒ back to `probation`; retire |
| `retired` | agent/human | 0 | terminal |

A template becomes `proven` when ≥ 2 of its bots have reached `full` without a halt.
Promotion is automatic and logged. When `approvals.new_template_live: true`, `paper → probation`
for a `new` template requires an approval record.

### 4.6 What only a human can do (enforced by auth scope, §8.2)
Edit limits/mandate/fees; add/edit wallets or exchange credentials; move funds (not implemented at
all); clear halts; un-retire bots; change category rights manually; approve approvals; delete audit
or ledger data; change agent budget.

---

## 5. Bot runtime

### 5.1 Sandbox hardening
- Remove `require` from the script factory (`worker-bootstrap.ts`); scripts get only `ctx`.
  Compile with esbuild `bundle: true, platform: 'neutral'`; reject imports at compile time.
- Replace raw `ctx.fetch` (`globalThis.fetch` today) with an RPC-proxied fetch restricted to an
  allowlist (`config/server.yaml: script_fetch_allowlist`, default: Polymarket gamma/data/clob
  hosts, Binance public API). Prevents exfiltration and limits prompt-injection surface.
- Worker `resourceLimits`: `maxOldGenerationSizeMb: 128`, `maxYoungGenerationSizeMb: 32`.
- Tick watchdog: if `onTick` doesn't resolve in 30s, log + count; 3 consecutive ⇒ terminate and
  mark bot `error`.
- Backtests run in a worker with the same limits (today they run via `new Function` on the main thread).
- Run workers with an empty `env` (`env: {}`) so scripts cannot read secrets via `process.env`.

### 5.2 `ctx` API changes (v2)
Additions to `BotContext.polymarket` (all go through RiskEngine):
```ts
placeLimit(tokenId, side: 'buy'|'sell', price: number, size: number,
           opts?: { postOnly?: boolean; ttlMinutes?: number; reason?: string;
                    forecastId?: string; riskExit?: boolean }): Promise<OrderResult>
cancel(orderId: string): Promise<void>
cancelAll(): Promise<void>                 // this bot's orders only
getOpenOrders(): Promise<OpenOrder[]>      // this bot's orders only
getMarket(marketId): Promise<MarketDetail> // includes rules_text, end_date, fee category, ambiguity
getFee(tokenId): Promise<{ takerRate: number; makerRate: number }>
```
Existing `buy`/`sell` (FOK market orders) remain but are routed through the same risk checks and
labelled marketable.

New namespaces:
```ts
ctx.ledger.getActiveForecasts(filter?: { category?: string; tradeableOnly?: boolean }): Promise<Forecast[]>
ctx.ledger.getForecast(tokenId): Promise<Forecast | null>
ctx.risk.getBudget(): Promise<{ remainingAllocation: number; remainingMarket: Record<string, number>; halted: boolean }>
ctx.events.on('forecast_changed' | 'rules_changed' | 'halt', handler)   // pushed from main thread
```
Bots may **read** ledger data but not write it.

### 5.3 Type definitions
Generate `botlab-sdk.d.ts` from `sdk/types.ts`; serve it as an MCP resource and use it in the
compile step (`tsc --noEmit` on script + d.ts) so the agent gets real type errors, not just esbuild
syntax errors.

---

## 6. Forecast ledger

### 6.1 Writing forecasts
- MCP `submit_forecast({ tokenId, probability, rationale, sources[], ambiguityScore })`.
- Server captures market snapshot (mid, bid, ask, liquidity) at write time — the agent cannot
  supply or backdate it.
- Validation: market open; ≥ 6h before end date; probability in [0.01, 0.99]; rationale non-empty;
  category resolved from market cache.
- Superseding: new forecast on same token ⇒ old marked `superseded`. Each version is scored
  separately, so updating a forecast never erases the earlier call (see §6.2).
- Withdraw: `withdraw_forecast(id, reason)` ⇒ forecast executor stops trading it; position manager
  treats associated positions as exit candidates.

### 6.2 Scoring
- Scorer job (hourly) fetches resolutions for markets with forecasts.
- Per forecast: `brier_agent = (p − o)²`, `brier_market = (m − o)²`, `skill = brier_market − brier_agent`.
- Superseded and withdrawn forecasts are **still scored** (otherwise the agent could hide bad calls).
- Correlation control: forecasts are grouped by `event_id`; for category statistics each event
  contributes the **mean** skill of its forecasts (one vote per event).
- Voided/50-50 resolved markets: status `void`, excluded.
- Category stats: `n_scored` (events), `skill_mean`, `skill_lower_bound` = 10th percentile of
  1,000 bootstrap resamples over events.
- Also tracked (reporting only): calibration buckets (0–10%, …, 90–100%), log score, and realized
  P&L of ledger-driven trades per category.

### 6.3 Category rights
- New categories start in `shadow`.
- `shadow → trading` when `n_scored ≥ 30` **and** `skill_lower_bound > 0`.
  Initial `max_allocation_usd = 50`; +50 per additional 20 scored events while
  `skill_lower_bound > 0`, capped by mandate budget.
- `trading → suspended` when skill over the last 20 scored events < 0, or the category's
  ledger-driven trades breach a loss limit. `suspended → trading` requires re-qualifying on events
  scored after suspension.
- Forecasts made while a category is `shadow` are still scored; `tradeable` is false.
- Human can force any state (logged).

### 6.4 No backtesting of forecasts
LLM forecasts are evaluated **forward only**. The platform will not offer "backtest the agent's
forecasting on past markets" because models may have memorized outcomes.

---

## 7. Agent

### 7.1 Runtime
- `apps/agent`: a Claude Agent SDK program, triggered by the server scheduler (default every 4h,
  plus a daily review at 07:00 local) or manually from the UI.
- Tools available to the agent: **BotLab MCP** + web search + web fetch. No shell, no file tools.
- Model configurable in `config/server.yaml` (`agent.model`); default the latest Claude Opus/Sonnet.
- Each run gets a token budget (`max_run_cost_usd`, default 1.50) and the server refuses to start
  a run if the month's `agent_runs.cost_usd` ≥ `monthly_llm_budget_usd`.
- One run at a time; runs that exceed 30 min are cancelled.

### 7.2 Cycle (system prompt describes this; the server does not hard-code the order)
1. **Orient:** read mandate, limits summary, risk state, category rights, open positions, active
   bots + health, last run summary, relevant `agent_notes`.
2. **Maintain:** handle alerts first — halted/erroring bots, `rules_changed` markets, positions
   near resolution, expired forecasts. Pause/retire/fix as needed.
3. **Scan:** query markets via `search_markets` within mandate filters; shortlist.
4. **Research:** read rules (`get_market`), order books, price history, web sources.
5. **Forecast:** submit/update/withdraw forecasts with rationale and ambiguity score.
6. **Build/Act:** create bots from templates for consistency/resolution-rule opportunities;
   occasionally write a new template (goes through compile → typecheck → backtest if data → paper).
7. **Record:** write `agent_notes`, then `finish_run(summary_md)`, which triggers the phone report.

Daily review run additionally: performance by strategy and category, calibration, retire
under-performers, prune notes.

### 7.3 MCP server
Transport: Streamable HTTP at `/mcp` with bearer token (agent scope), plus stdio entry for local
use with Claude Code. Tools are grouped; each tool's description states its risk impact.

**Read**
| tool | purpose |
|---|---|
| `get_overview` | equity, exposure, daily P&L, halt state, active bots, category rights |
| `search_markets` | filters: text, category, liquidity, end-date window, price range; returns compact rows |
| `get_market` | full detail incl. rules text, rules_hash history, fee category, related markets in the event |
| `get_orderbook` | top N levels |
| `get_price_history` | from Polymarket price history API + our snapshots |
| `get_positions` / `get_open_orders` / `get_trades` | filterable by bot/market |
| `list_bots` / `get_bot` / `get_bot_logs` | logs paginated, newest first |
| `list_templates` / `get_script` | source + version history |
| `get_forecasts` / `get_ledger_stats` | incl. calibration and per-category skill |
| `get_notes` | agent memory |
| `get_run_history` | past agent run summaries |

**Build**
| tool | purpose |
|---|---|
| `validate_script(source)` | compile + typecheck; returns diagnostics |
| `create_template(source, meta)` / `update_template(id, source)` | new version; `trust=new` |
| `run_backtest(scriptId, params)` | Binance klines or Polymarket snapshots (§10) |
| `get_backtest(id)` | |

**Operate**
| tool | purpose |
|---|---|
| `create_bot({ templateId, name, marketIds, config })` | starts in `paper` or `probation` per §4.5; respects `max_bots_created_per_day`, `max_active_bots` |
| `update_bot_config(id, config)` | config only; cannot change stage/allocation |
| `start_bot` / `pause_bot` / `retire_bot(id, reason)` | start only allowed if not halted |
| `submit_forecast` / `withdraw_forecast` | §6 |
| `flag_position_exit(positionId, reason)` | instructs position manager to exit (risk_exit) |
| `kill_switch(reason)` | global halt |
| `write_note` / `delete_note` | memory |
| `finish_run(summary_md)` | ends run, sends report |

**Resources:** `botlab://sdk/types.d.ts`, `botlab://sdk/guide.md` (from `claudeSystemPrompt.ts`),
`botlab://templates/*`, `botlab://config/mandate`, `botlab://config/limits`, `botlab://fees`.

Not exposed, by design: anything in §4.6, raw order placement, wallet/credential tools, SQL.

### 7.4 Ambiguity score (agent-assigned, server-checked)
| score | meaning |
|---|---|
| 0 | objective source, clear criteria, fixed date |
| 1 | clear but depends on a single reporting source or interpretation of a term |
| 2 | multiple reasonable readings, or "consensus of credible reporting" |
| 3 | clarifications already issued, active dispute, or criteria likely to be contested |

Server raises the score to ≥ 2 automatically if `rules_hash` changed in the last 7 days or a UMA
dispute is detected.

### 7.5 Prompt-injection posture
- Market text, comments, and fetched web pages are untrusted. The agent's system prompt says so;
  the real protection is structural: the agent cannot place orders, change limits, or touch funds.
- Worst-case agent behaviour is bounded by: bots-per-day cap, ramp allocations, risk engine,
  category rights, monthly budget.
- `audit_log` records every MCP call with arguments for after-the-fact review.

---

## 8. Server, API, auth

### 8.1 HTTP API
- Hono on Node 22. JSON over HTTP, SSE at `/api/events` for bot events, logs, risk events, approvals.
- Endpoints mirror the existing IPC channels 1:1 initially (`bots:list` → `GET /api/bots`, etc.),
  so `web/client/src/lib/electronApi.ts` becomes a fetch client with the same function signatures.
- Input validation with zod; shared schemas between API and MCP.

### 8.2 Auth scopes
| scope | how obtained | can |
|---|---|---|
| `admin` | UI login (password → session cookie) | everything |
| `agent` | static token in `config/server.yaml` (hashed) | MCP tools in §7.3 only |
| `readonly` | optional token | GET endpoints |

Network exposure: bind to the Tailscale interface (or 127.0.0.1 behind Tailscale serve). Never
public. Admin actions in §4.6 additionally require re-entering the password if the session is
older than 15 min.

### 8.3 Secrets
- Master key from `BOTLAB_MASTER_KEY` env var or a file path (`BOTLAB_MASTER_KEY_FILE`), loaded at
  boot; the unlock screen and `FALLBACK_PASSWORD` are removed.
- Replace CryptoJS (passphrase mode, MD5 KDF) with Node `crypto` **AES-256-GCM**; one-time migration
  re-encrypts wallet keys and Binance/Claude credentials.
- Binance API key: trading only, **withdrawals disabled**, IP allowlist — documented in setup guide.
- Polymarket: dedicated wallet funded only with risk capital.

---

## 9. Strategy templates (core set)

All templates are TypeScript in `templates/`, `origin=builtin`, `trust=proven` once they pass §4.5.

### 9.1 Forecast executor (standing, 1 instance)
- Input: `ctx.ledger.getActiveForecasts({ tradeableOnly: true })`.
- For each forecast: fair = p; if `p − ask ≥ min_edge + fee` place post-only bid at
  `min(best_bid + tick, p − min_edge)`; symmetric for NO token when `price − p` is large.
- Size: `kelly_fraction (0.25) × kelly(p, price) × category allocation`, capped by `ctx.risk.getBudget()`.
- Re-quote every N minutes; cancel when forecast superseded/withdrawn or edge disappears.
- Config: `min_edge` (≥ 0.03), `kelly_fraction`, `requote_minutes`, `max_per_market_usd`.

### 9.2 Position manager (standing, 1 instance)
- Watches all positions across bots.
- Exit triggers: forecast withdrawn or flipped; `rules_changed`; ambiguity ≥ 2; `flag_position_exit`;
  take-profit (price ≥ p − small margin); stop (price moved > X against with no new forecast);
  `exit_before_end_minutes` for ambiguous markets.
- Exits are post-only first, escalate to marketable after `escalate_after_minutes`, flagged `risk_exit`.

### 9.3 Consistency (per opportunity)
- Config: a set of markets + a declared constraint, e.g.
  `{ type: 'implies', a: tokenA, b: tokenB }` (P(A) ≤ P(B)),
  `{ type: 'date_ladder', tokens: [...] }` (monotone non-decreasing),
  `{ type: 'exclusive_sum', tokens: [...], max: 1.0 }`.
- Trades when violation > `min_gap + fees`, buying the underpriced and selling/buying-NO the overpriced leg.
  Legs placed as post-only; unhedged-leg exposure capped and time-limited (cancel/flatten after N min).
- Auto-retires when markets resolve or the gap stays closed for `idle_days`.

### 9.4 Resolution-rule (per market)
- Config: token, target entry price, max size, `thesis` (text, shown in UI), invalidation conditions.
- Places resting bids up to target price; holds to resolution unless invalidated
  (rules change, dispute, ambiguity ≥ 2, agent withdraws).

### 9.5 Existing templates
- `copy-trading` and `binance-spot` kept; routed through the risk engine; copy-trading treated as
  `trust=new` until it qualifies.

### 9.6 Scheduled-event template — deferred (post-v3).

---

## 10. Data recorder & backtesting

- Polymarket does not serve historical order-book depth. The **recorder** snapshots top-10 levels
  for every token that is: in an active bot's scope, in an active forecast, or on the agent's
  watchlist (`watch_market` tool), every 60s (configurable). Retention: 180 days, then downsample to 15 min.
- `run_backtest` for Polymarket replays snapshots with timestamp discipline (bot only sees data with
  `ts ≤ sim_time`), fills post-only orders only when the opposite side trades through the price,
  and charges fees per §4.4.
- Binance backtests continue to use klines.
- Disk estimate: 100 tokens × 1440/day × ~2 KB ≈ 290 MB/day before downsampling — make tokens and
  interval configurable; store JSON compressed.

---

## 11. Notifications

Channels: Telegram bot (primary, supports commands) and/or ntfy. `config/server.yaml: notify`.

| event | default |
|---|---|
| order filled (live) | on, batched per 5 min |
| risk rejection storm, bot halt, global halt, kill switch | immediate, high priority |
| bot created / retired / promoted, new template written (with link to code view) | on |
| category rights change | on |
| rules_changed on a held market | immediate |
| agent run summary | on |
| daily digest (P&L, exposure, ledger stats) | 08:00 local |
| reconciliation mismatch | immediate |

Telegram commands (admin chat id only): `/status`, `/pnl`, `/halt`, `/bots`, `/pause <bot>`.
Clearing a halt is **not** possible from Telegram — UI only.

---

## 12. Web UI

Keep the existing React app; switch transport to HTTP/SSE. Page changes:

| page | changes |
|---|---|
| Dashboard | equity, exposure gauges vs limits, daily P&L vs loss limit, halt banner + kill switch, agent last run, category rights |
| Bots | stage badge (paper/probation/full), created_by, allocation used/available, retire reason |
| Bot detail | **code view** (read-only source of the exact template version, diff vs previous version), config, orders incl. risk rejections with reasons, linked forecasts |
| Ledger (new) | forecasts table, rationale, scoring, calibration chart, per-category skill + rights |
| Agent (new) | run history with summaries/cost, notes browser, trigger run, budget used |
| Risk (new) | limits (edit → writes `limits.yaml`), mandate editor, halt history, clear halt |
| Audit (new) | filterable audit log |
| Approvals (new) | empty unless approvals enabled |
| Scripts | version history + diff; origin badge (builtin/human/agent) |
| Unlock screen | removed |

Code view is required but lower priority than the Risk and Dashboard pages.

---

## 13. Reconciliation

Every 60s:
- Pull open orders, fills and positions from Polymarket (CLOB + Data API, using `proxyAddress`) and Binance.
- Update `orders` status/fills, `bot_trades`, P&L, `risk_state`.
- Mismatch (exchange position with no matching local record, or local open order missing on
  exchange beyond expiry) ⇒ notify; if unexplained exposure > $10 ⇒ global halt.
- Exchange is the source of truth for positions; local DB is the source of truth for attribution.

---

## 14. Testing

- Unit: RiskEngine (table-driven: every check, boundaries, sells-reduce-exposure, halt precedence),
  ramp transitions, fee math, Kelly sizing, ledger scoring + bootstrap, category-rights transitions,
  consistency constraint math.
- Property tests (fast-check): random order sequences never exceed any configured limit.
- Integration: fake CLOB server (records orders, simulates fills/expiry) — full path bot → RPC →
  OrderService → RiskEngine → fake exchange; kill switch cancels everything; crash-restart starts halted
  and cancels orphans.
- MCP: contract tests per tool; scope test proving agent token cannot call admin endpoints.
- Static check: only `OrderService` imports CLOB order-posting functions.
- Existing suites (`tests/electron`, `tests/resilience`, `tests/copytrading`) ported to `packages/core`.

---

## 15. Deployment & operations

- `Dockerfile` (node:22-slim, better-sqlite3 prebuilt), `docker-compose.yml` with server + agent
  + Tailscale sidecar; volume for `data/` and `config/`.
- Nightly SQLite backup (`.backup` API) to `data/backups/`, keep 14; optional rclone to remote.
- Health endpoint `/healthz` (DB ok, reconciler fresh < 3 min, workers alive).
- Logs: JSON to stdout + `data/logs/` rotated.
- Clock: require NTP; refuse to place orders if exchange server time skew > 5s.
- **Eligibility:** confirm Polymarket terms permit trading from the user's jurisdiction and the
  server's location before enabling live mode.

---

## 16. Delivery phases

Each phase ends with tests green and a short demo checklist.

### Phase 1 — Safety layer (in current codebase, before restructuring)
- RiskEngine + `limits.yaml` + `orders` table + `risk_state`; route all live orders through it.
- `placeLimit` / `cancel` / `getOpenOrders` with GTD expiry; fee table.
- Kill switch, loss limits, halts; startup orphan-order cancel.
- Ramp stages on bots.
- Sandbox hardening (§5.1) incl. backtests in worker.
- AES-GCM migration.
- Notifications (Telegram/ntfy) for halts and fills.
- `audit_log`.

**Done when:** property tests show no limit can be exceeded; kill switch integration test passes;
no code path to postOrder outside OrderService.

### Phase 2 — Ledger, recorder, reconciliation
- `forecasts`, `category_rights`, scorer job, bootstrap stats.
- `market_cache` with `rules_hash` change detection.
- Recorder + snapshot tables.
- Reconciler.

**Done when:** forecasts can be submitted (temporarily via admin API), get scored on resolution,
and rights transition automatically in tests.

### Phase 3 — Server & web
- Extract `packages/core`, services; Hono API + SSE; web client on fetch; auth scopes; env-based key.
- Remove Electron, unlock screen, `FALLBACK_PASSWORD`.
- Docker + Tailscale + backups + healthz.
- New UI pages: Risk, Ledger, Audit; Dashboard updates.

**Done when:** running in Docker on a server, UI reachable over Tailscale, bots survive restart.

### Phase 4 — MCP & agent
- MCP server (tools/resources §7.3), agent scope.
- Mandate loader; ambiguity scoring.
- `apps/agent` with scheduled cycle, budget enforcement, run history, notes.
- Agent page + Telegram run summaries.

**Done when:** agent completes scheduled cycles unattended for 7 days in shadow mode
(forecasts only, consistency/resolution bots in paper) with sensible summaries.

### Phase 5 — Strategies
- Forecast executor, position manager, consistency, resolution-rule templates.
- Polymarket snapshot backtester.
- Code view + version diff in UI.
- Go live: fund wallet, set limits, enable probation for proven templates.

**Done when:** live with real (small) capital; all four templates have run through probation.

---

## 17. Additional recommendations (beyond the original discussion)

Included in the spec above, called out here because they weren't previously agreed:

1. **GTD expiry on every resting order** (§4.3) — otherwise a crashed server leaves live orders in
   the book indefinitely. Cheapest possible dead-man switch.
2. **Start halted after a crash** (§4.3) — a human looks before trading resumes.
3. **Reconciliation with auto-halt on unexplained exposure** (§13).
4. **Order-book recorder** (§10) — the only way to ever backtest Polymarket strategies honestly; start
   recording early because the data can't be obtained retroactively.
5. **Restrict `ctx.fetch` and strip `process.env` from workers** (§5.1) — today scripts can call any
   URL and `require` Node modules.
6. **AES-256-GCM instead of CryptoJS passphrase mode** (§8.3).
7. **Score superseded/withdrawn forecasts and count one vote per event** (§6.2) — stops the ledger
   being gamed by updates or flattered by correlated markets.
8. **Server captures the market price for each forecast** (§6.1) — the agent can't pick a flattering baseline.
9. **Agent memory (`agent_notes`) and run history** — continuity between runs without a long context.
10. **Monthly LLM budget as a hard limit** (§7.1).
11. **Audit log of every agent call** (§2.2) — the main tool for understanding what the agent did and why.
12. **Exchange time-skew guard** (§15).

Cleanups worth doing during Phase 3 (low priority): remove `moment` (use `Date`/`Intl`), unify
on `fetch` instead of `axios`, make the Claude model id configurable (hard-coded in `electron/sdk/claude.ts`).

---

## 18. Open questions

1. Starting wallet size and the concrete numbers in `limits.yaml` (defaults above are placeholders).
2. Initial mandate categories — which Polymarket categories interest you most?
3. Notification channel: Telegram, ntfy, or both?
4. Hosting: VPS (which region — eligibility) or home server?
5. Agent cadence: every 4h + daily review OK, and preferred local time for the daily digest?
6. Keep copy-trading and the in-app AI script assistant, or drop them to reduce surface area?
