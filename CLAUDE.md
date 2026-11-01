# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Direction (read first)

The project is being rebuilt per `docs/SPEC.md` (BotLab v3): headless Node server + browser UI + MCP agent,
replacing Electron. Follow the spec's phases and decisions. Hard requirements for all new code:
- **Cross-platform:** must run natively on macOS, Windows and Linux (spec §15.2) — no POSIX-only npm
  scripts, always `path.join`, no `SIGHUP` reliance, `better-sqlite3` as the only native dependency.
- **Safety:** every live order goes through the risk engine (spec §4); the agent can never change limits,
  wallets or credentials.

Electron is gone (chunk 3b): a Node server (`apps/server`) serves the HTTP API and the React UI (`apps/web`).

## Project Overview

Self-hosted trading lab for Polymarket (prediction markets) and Binance (crypto spot). TypeScript throughout: one Node 22 server process (Hono HTTP API + SSE, bot workers, schedulers, SQLite) and a React SPA in the browser. Users write or pick bot scripts that run in sandboxed worker threads with access to trading APIs via an RPC layer; every order passes the risk engine.

## Commands

### Development
```bash
npm run dev                # server (node --watch + tsx, :3780) + Vite UI with /api proxy (http://localhost:3000)
npm run dev:server         # server only
npm run cli -- <command>   # migrate-key | gen-key | set-password | token create/list/revoke | check-polymarket (add --prod for npm start paths)
npm run mcp:stdio:dev      # MCP stdio proxy from source (BOTLAB_URL, BOTLAB_AGENT_TOKEN); mcp:stdio = built
npm run gen:sdk            # regenerate packages/core/src/sdk/sdkDts.generated.ts after editing sdk/types.ts
```

### Build & Run
```bash
npm run build              # gen:sdk, tsc (apps/server/tsconfig.build.json) → dist/, vite build → apps/web/dist
npm start                  # node dist/apps/server/src/main.js --production (OS app-data dir, master key required)
npm run service:install    # Windows service via NSSM (prints launchd/systemd instructions elsewhere)
docker compose up -d --build
```

### Testing
```bash
npm test                   # Run all tests (vitest); SKIP_NETWORK_TESTS=1 skips live-API tests
npm run test:watch         # Watch mode
npm run test:server        # HTTP server: smoke test, auth/scopes, master key, bot routes
npm run test:copy          # Copy trading bot tests
npm run test:resilience    # Error handling / network failure tests
npx vitest run tests/runtime/rpc-handler.test.ts  # Single test file
```

### Code Quality
```bash
npm run typecheck          # tsc for packages/core, apps/server and apps/web
npm run lint               # ESLint check (0 errors required; many pre-existing prettier warnings)
npm run lint:fix           # Auto-fix
npm run format             # Prettier format
```

All npm scripts must stay cross-platform (no `VAR=x cmd`, `rm -rf`, `cp`; use Node scripts in `scripts/*.mjs`).

## Architecture

### Layout
All domain logic lives in a transport-free core (`packages/core`, imported by relative path; one npm
package, no workspaces). Transports are thin.
1. **Core** (`packages/core/src/`) — DB, risk, orders, exchanges, bot runtime, ledger, services, backups, `createCore()`
2. **Server** (`apps/server/src/`) — Hono HTTP API mirroring the old IPC channels, auth, SSE, `/healthz`, static UI, CLI,
   MCP server at `/mcp` for the agent (+ stdio proxy), AgentScheduler (starts the agent runner)
3. **Web** (`apps/web/`) — React SPA (Vite); `src/lib/api.ts` is the fetch + EventSource client
4. **Agent runner** (`apps/agent/`) — Claude Agent SDK child process for one run, started by the server; talks to
   BotLab only through `/mcp` (plus web search / fetch)

### Directory Structure

```
packages/core/src/
  index.ts                 # Public API: createCore, services, schemas, errors, DTO types
  core.ts                  # Composition root: createCore({ dataDir, configDir? }) → start() / unlock(key) / shutdown() / close()
  services/                # BotService, WalletService, ScriptService, SettingsService, BacktestService,
                           # RiskService, ConfigFileService, ReconcileService, MarketService, AgentService
                           # (agent runs / notes / budget / exit flags), OverviewService, AuditLogService;
                           # schemas.ts (zod inputs shared by HTTP/MCP), errors.ts (ServiceError), types.ts (DTOs)
  db/                      # SQLite via better-sqlite3, migrations (index.ts), repositories/, seed.ts
  bots/                    # BotManager, BaseBotRunner, WalletManager
  runtime/                 # Bot execution engine
    ScriptRunner.ts        # Manages worker thread lifecycle
    ScriptBotRunner.ts     # BaseBotRunner subclass for script-based bots
    RpcHandler.ts          # Dispatches RPC calls from worker to trading APIs
    BotContextProxy.ts     # Builds the `ctx` object scripts interact with
    PaperTradingState.ts   # Simulated balances for paper trading mode
    worker-bootstrap.ts    # Worker thread entry point (resolved with workerPath.ts)
  orders/                  # OrderService (the order choke point), ExchangeAdapter, fees, risk state,
                           # PortfolioService (ctx.portfolio: position-manager exits placed as the owning bot)
  exchange/polymarket/     # orders.ts (only CLOB order calls), trading.ts (read-only helpers)
  exchange/binance/        # client.ts (Binance REST client, HMAC-SHA256)
  risk/                    # RiskEngine, halts, kill switch, RiskMonitor, ramp, startup recovery
  config/                  # limits/mandate/fees/server/categories YAML: schema, loader, ConfigService (hot reload)
  ledger/                  # Forecast ledger, scoring, market cache
  agent/schedule.ts        # agent schedule rules (pure): Europe/Dublin slots across DST, quiet hours, event cap/debounce
  reconcile/ recorder/ backtest/ audit/ notify/ utils/
  security/                # crypto (AES-256-GCM), masterKey (key check), adminAuth (password, sessions, tokens), migrateSecrets
  ops/                     # BackupJob (nightly SQLite .backup, 14 kept); connectivityCheck (check-polymarket: geo vs bot blocking, injectable fetch)
  sdk/                     # types.ts (ctx API types), guide.ts (agent guide, MCP resource), dts.ts + sdkDts.generated.ts
                           # (botlab-sdk.d.ts, generated by scripts/gen-sdk-dts.ts; a test fails when stale)
  runtime/typecheckScript.ts  # TypeScript compiler API typecheck of a script against botlab-sdk.d.ts (validate_script);
                           # always run through TypecheckRunner (worker thread, 256 MB, 10 s, one at a time)

templates/                 # Built-in bot script templates (seeded by db/seed.ts)

apps/server/src/
  main.ts                  # Entrypoint: signals (SIGINT/SIGTERM/SIGBREAK/SIGHUP) → graceful shutdown
  server.ts                # startServer(): data dir lock → master key → createCore → start → unlock → listen
  app.ts                   # Hono app: host check, /healthz, /api (principal, CSRF, routes, SSE), static UI
  routes/api.ts            # One route per former IPC channel; scopes + recentAuth per route
  routes/auth.ts           # setup / login / logout / reauth / password / API tokens
  http/                    # principal + actor derivation, route helper, envelope, SSE hub, hosts, static, health
  mcp/                     # MCP (spec §7.3): tools.ts (tool defs: zod schema → core service, risk text),
                           # resources.ts, server.ts (low-level SDK Server: list/call, audit, untrusted wrapping,
                           # tool-call cap), http.ts (stateless Streamable HTTP at /mcp, agent token only)
  mcp-stdio.ts             # stdio ⇄ /mcp proxy for Claude Desktop / Claude Code (never opens the DB)
  agent/AgentScheduler.ts  # scheduled / event / manual agent runs: per-run agent token, opens the run (system),
                           # forks apps/agent (tsx in dev), records reported usage, 30-min stop + kill, /run hook

apps/agent/
  prompts/system.md        # versioned system prompt (cycle §7.2, untrusted-data rules, run kinds); bump the version
  src/main.ts              # child entry: env → runAgent → IPC messages (protocol.ts) → exit
  src/runner.ts            # query() options (only mcp__botlab + WebSearch/WebFetch, dontAsk, deny hook), cost /
                           # turn / wall-clock limits; the SDK query is injected (tests use a fake, never the API)
  masterKey.ts migrateKey.ts cli.ts paths.ts instanceLock.ts

apps/web/src/              # React UI
  pages/                   # Dashboard, Bots, BotDetail (code view, orders), Scripts, Ledger, Markets, Risk,
                           # Agent (schedule, Run now, runs + transcript, notes, budget, exit flags), Audit, Approvals, Wallets,
                           # Settings (Telegram, password, tokens, reconcile/adopt)
  hooks/                   # React Query hooks over lib/api.ts; useLiveUpdates = SSE → query invalidation
  lib/api.ts               # fetch client (same exports as the old electronApi) + EventSource events
  lib/                     # pure helpers (unit-tested in tests/web): lineDiff, schemaForm, sdkTypings, calibration
  components/ConfigEditor.tsx  # config file editor: zod→JSON-Schema form / YAML, preview (risk raises), save with hash, history
  components/ReauthDialog.tsx  # password prompt for human-only actions (reauth_required)

scripts/service.mjs        # Windows service (NSSM) / launchd / systemd helper
```

### Bot Script Execution Flow
1. User creates/starts a bot → `POST /api/bots/:id/start` → `BotService.start()` → `BotManager.startBot()`
2. `BotManager` creates a `ScriptBotRunner` with compiled script code
3. `ScriptBotRunner` spawns a `ScriptRunner` which creates a worker thread
4. Worker thread runs the script with a `ctx` object (built by `BotContextProxy`)
5. Script calls like `ctx.binance.getPrice('BTCUSDT')` become RPC messages to the main thread
6. `RpcHandler` dispatches RPC calls; every order goes through `packages/core/src/orders/OrderService` → `RiskEngine` → exchange adapter (live) or `PaperTradingState` (paper). Only `packages/core/src/exchange/polymarket/orders.ts` and `packages/core/src/exchange/binance/client.ts` may hit order endpoints (enforced by `tests/orders/choke-point.test.ts`)

### Key Patterns
- **HTTP routes** (`apps/server/src/routes/`): declarative `RouteDef`s (method, path, allowed scopes, `recentAuth`) → parse input with `services/schemas.ts` → call a core service with the actor derived from the principal → `{ success, data }`. Admin = session cookie (human), agent / readonly = bearer token. Mutations with the cookie need the `X-BotLab: 1` header. `ServiceError` codes map to HTTP statuses (`http/respond.ts`)
- **MCP tools** (`apps/server/src/mcp/tools.ts`): one `def({ name, group, description (ends with "Risk: …"), input: <zod schema from services/schemas.ts>, untrusted?, run })` per tool calling a core service with the agent actor. Agent rules belong in the services (BotService / ScriptService / MarketService / AgentService), never only in the tool. `server.ts` audits every call as `mcp.<tool>` (redacted args), counts it on the open agent run, and wraps outputs with third-party text in `<untrusted_data>`. The tool list is snapshot-tested (`tests/mcp/mcp-server.test.ts`): adding a tool is a deliberate change; nothing from spec §4.6 may be exposed
- **RPC Dispatch**: Worker scripts send `{ method, params }` messages. `RpcHandler` pattern-matches on method name (`binance:buy`, `clob:getPrice`, `storage:get`, etc.)
- **Paper Trading**: `PaperTradingState` tracks simulated balances for both Polymarket and Binance. Persisted via `BotStorageRepository`
- **Script Compilation**: User TypeScript scripts are compiled with esbuild at save time, stored in SQLite
- **Credential Security**: Wallet private keys and Binance API credentials are AES-256-GCM encrypted with the master key (`BOTLAB_MASTER_KEY` / `_FILE` / `<data dir>/master.key`; key check in `security/masterKey.ts`). Decrypted only in the server, never sent to the UI
- **Live trading is opt-in**: `limits.yaml` `live_trading.enabled` (default false) gates live bot starts and live orders (`live_disabled`); bots created without a mode are paper bots
- **Kelly Criterion**: `ctx.kelly.calculate(winRate, sampleSize, marketPrice, bankroll)` — pure math utility running locally in worker (no RPC). Implemented in `packages/core/src/utils/kellyCalculator.ts`, exposed via `BotContextProxy`

### Database (SQLite via better-sqlite3)
- **bots**: id, name, scriptId, walletId, config (JSON), mode (live/paper), status
- **wallets**: id, name, address, proxyAddress, privateKeyEncrypted, currentBotId
- **settings**: singleton row — rpcUrl, clobHttpUrl, usdcContractAddress, binance credentials (encrypted), admin_password_hash, key_check
- **auth_sessions** / **api_tokens**: UI sessions and agent/readonly tokens (SHA-256 of the secret only)
- **scripts**: id, name, sourceCode, compiledCode, configSchema (JSON)
- **bot_trades**: historical trade records per bot
- **bot_storage**: key-value store for bot state persistence
- **agent_runs** / **agent_notes** / **position_exit_flags**: agent run history (cost, tool calls, actions, summary), agent memory, exit requests for the position manager
- Migrations run automatically in `packages/core/src/db/index.ts`

### Web Client Patterns (`apps/web/src/`)
- React 19 + React Router (hash routes) + TanStack React Query + Tailwind CSS
- Hooks in `hooks/` wrap `lib/api.ts` calls with React Query; real-time events via `events.onBotEvent/onBotLog/...` (one shared EventSource on `/api/events`)
- Vite dev server proxies `/api` and `/healthz` to the server (`BOTLAB_PORT`, default 3780)
- Shared UI pieces in `components/ui.tsx` (Card, Badge, Modal, ConfirmDialog, LimitBar, Tabs); pages must stay usable at phone width (sidebar becomes a drawer below `md`)
- Script editor typings come from `packages/core/src/sdk/types.ts` (imported `?raw`, converted by `lib/sdkTypings.ts`): change the SDK types, not the editor

## Key Gotchas

- **Node 22 only**: `engines` is `>=22.12 <25` (better-sqlite3 does not build on Node 25+); `preinstall` runs `scripts/check-node.mjs`
- **Polymarket fees**: `orders/feeModel.ts` — taker fee = shares × rate × p × (1 − p) in USDC, the market's own Gamma `feeSchedule` first, `fees.yaml` category table only as fallback (PROGRESS R125)
- **Polymarket API**: Series endpoint (`/series/{id}`) returns events WITHOUT `markets` field. Must use Event endpoint (`/events/{id}`) to get market data
- **Wallet addresses**: Polymarket USDC balance lives in `proxyAddress`, not the main `address`. Balance queries must use proxyAddress when available
- **Binance USDT-only**: Paper trading simulator only supports USDT-quoted pairs (BTCUSDT, ETHUSDT, etc.)
- **Worker thread isolation**: Bot scripts run in worker threads — they can only communicate via the RPC message channel, not access main process directly
- **Binance credentials**: Encrypted in settings table, decrypted only in `BotManager.getSettings()`. Only `hasBinanceCredentials: boolean` is ever sent to renderer
- **Script templates**: Registered in `packages/core/src/db/seed.ts`, source lives in `templates/`
- **Agent runs**: runs the server starts are `managed` (opened by `AgentService.openManagedRun`, system actor); the
  agent's `start_run` attaches to them, usage is only recorded by the system (`completeManagedRun`), and while an
  `event` run is open the services refuse agent bot creates, script writes and forecasts (`guardMaintenanceRun`).
  New agent write paths must call `guardAgentRun` too. The runner never gets BotLab secrets (env allow-list)
- **Actors**: services take branded actors from `packages/core/src/services/actors.ts` (`asHuman`/`asAgent`/`asSystem`). Only a transport creates them, from the authenticated principal, never from request data; human-only actions (clear halt, config write/restore, adopt positions, market ambiguity, forced category rights) refuse anything but a minted `HumanActor`
- **Core is transport-free**: nothing under `packages/core` may import `hono`, `electron` or `apps/*` (ESLint + `tests/orders/choke-point.test.ts`). Business logic goes in services, not HTTP handlers
- **Data dir**: `BOTLAB_DATA_DIR`, else `./data` in dev and the OS app-data dir with `--production` / `NODE_ENV=production` (`apps/server/src/paths.ts`); config dir likewise (`resolveConfigDir`). One server per data dir (`server.lock`)
- **Worker threads under tsx**: a `.ts` worker entry cannot load through tsx directly; `startWorker()` (`runtime/workerPath.ts`) wraps it in an eval'd shim that registers `tsx/cjs/api` first. Compiled `.js` entries start directly
- **Route scopes**: new routes must declare `allow` (readonly gets GETs by default — anything returning secrets is `['admin']`), `recentAuth` for §4.6 / credential actions, and `domainErrors` if their plain domain errors are user-facing (otherwise a generic 500 with an error id). Agent restrictions that matter for safety go in the service (e.g. `BotService` agent rules), not only the route
- **First run**: until an admin password exists the server logs a one-time setup code; `/api/auth/setup` needs it unless the request is local to a loopback-bound server
- **Agent (MCP)**: `/mcp` accepts only agent-scope bearer tokens; actor `asAgent('token:<id>')`. Agent bots are paper only, from templates (`scripts.kind = 'template'`; `is_template` marks builtin ones only), capped by `limits.yaml agent.*`; the agent may start / restart / reconfigure / retire / delete only bots it created, edit or delete only scripts it wrote (origin agent, and they must typecheck), withdraw only its own forecasts. Tool calls (MCP and agent `/api` requests) are reserved synchronously against per-run and per-hour caps; cost is recorded only by a system actor (`AgentService.recordRunUsage`). Tool output is wrapped as untrusted by default (`trustedOutput` opts out). Its ambiguity (forecast or `assess_market`) can only set or raise a non-human score
- **Standing templates (5a)**: `templates/forecast-executor.ts` and `templates/position-manager.ts` carry
  `meta.role` / `meta.trust: 'new'`; the seed stores the role in `scripts.builtin_role` (origin builtin only,
  `builtinRoleOf`). Only a bot on the builtin position-manager script gets `ctx.portfolio` (server-side, never from
  the script) and it cannot buy; its exits are risk-exit sells through the owner's OrderService (`orders.placed_by`).
  One running bot per standing role and mode. Paper resting orders fill on a later sync when the book crosses them
- **Strategy templates (5b)**: `templates/consistency.ts` and `templates/resolution-rule.ts` have strategy roles
  (`STRATEGY_ROLES`; per opportunity, any number, the agent creates them). `isStandingRole` gates the one-per-mode
  rule and the agent refusal — never test `role` alone for those. Agent strategy bots: mandate `strategies.allow`,
  config vs `meta.configSchema` (`utils/configSchema.ts`) and `market_ids` covering every config token
  (`BotService.checkAgentStrategyBot`). Scripts may `ctx.requestRetire(reason)` (retires only themselves, audited
  `bot:<id>`); "short" = buy the complement token (`ctx.polymarket.getMarket(...).complementTokenId`)
- **SDK types**: after changing `packages/core/src/sdk/types.ts`, run `npm run gen:sdk` (the d.ts for MCP and the typecheck is a committed generated file)
- **Shutdown**: an unclean stop (crash, kill, second Ctrl+C after 2 s) ⇒ next start is globally halted (spec §4.3); clear via `POST /api/risk/clear-halt` (human, recent password check)

## Environment Variables

- `BOTLAB_DATA_DIR`, `BOTLAB_CONFIG_DIR`, `BOTLAB_LOG_DIR` — directories (see above)
- `BOTLAB_MASTER_KEY` (64 hex) or `BOTLAB_MASTER_KEY_FILE` — master key for secrets at rest
- `BOTLAB_HOST` (default 127.0.0.1), `BOTLAB_PORT` (3780), `BOTLAB_ALLOWED_HOSTS` — HTTP server (also `http:` in server.yaml)
- `TELEGRAM_BOT_TOKEN` — overrides server.yaml
- `ANTHROPIC_API_KEY` — the scheduled agent runner's key (env only; with `server.yaml agent.enabled: true`)
- `SKIP_NETWORK_TESTS=1` — skip tests that call live APIs
