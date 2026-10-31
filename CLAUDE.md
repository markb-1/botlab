# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Direction (read first)

The project is being rebuilt per `docs/SPEC.md` (BotLab v3): headless Node server + browser UI + MCP agent,
replacing Electron. Follow the spec's phases and decisions. Hard requirements for all new code:
- **Cross-platform:** must run natively on macOS, Windows and Linux (spec §15.2) — no POSIX-only npm
  scripts, always `path.join`, no `SIGHUP` reliance, `better-sqlite3` as the only native dependency.
- **Safety:** every live order goes through the risk engine (spec §4); the agent can never change limits,
  wallets or credentials.

The sections below describe the current (pre-v3) Electron codebase.

## Project Overview

Electron desktop app for automated trading on Polymarket (prediction markets) and Binance (crypto spot). TypeScript throughout: Electron main process + React renderer. Users write or pick bot scripts that run in sandboxed worker threads with access to trading APIs via an RPC layer.

## Commands

### Development
```bash
npm run electron:dev       # Compile + launch Electron with Vite dev server (hot reload)
npm run electron:compile   # Compile electron/ TypeScript only
npm run electron:preview   # Compile + launch Electron (no Vite dev server)
```

### Build & Package
```bash
npm run electron:build     # Compile + bundle + package with electron-builder
```

### Testing
```bash
npm test                   # Run all tests (vitest)
npm run test:watch         # Watch mode
npm run test:electron      # Electron-layer tests (IPC, RPC, paper trading, Binance)
npm run test:copy          # Copy trading bot tests
npm run test:resilience    # Error handling / network failure tests
vitest run tests/electron/rpc-handler.test.ts  # Single test file
```

### Code Quality
```bash
npm run typecheck          # tsc for packages/core and electron
npm run lint               # ESLint check
npm run lint:fix           # Auto-fix
npm run format             # Prettier format
```

## Architecture

### Layout
All domain logic lives in a transport-free core (`packages/core`, imported by relative path; no npm
workspaces yet). `electron/` is a thin shell over it (window, IPC); chunk 3b replaces it with an
HTTP server + MCP that call the same services.
1. **Core** (`packages/core/src/`) — DB, risk, orders, exchanges, bot runtime, ledger, services, `createCore()`
2. **Electron main** (`electron/`) — single-instance lock, window, IPC handlers (validate → service → `{success, data}`)
3. **Renderer** (`web/client/`) — React SPA loaded via Vite, communicates with main via IPC

### Directory Structure

```
packages/core/src/
  index.ts                 # Public API: createCore, services, schemas, errors, DTO types
  core.ts                  # Composition root: createCore({ dataDir, configDir? }) → start() / unlock(key) / shutdown() / close()
  services/                # BotService, WalletService, ScriptService, SettingsService, BacktestService,
                           # RiskService, ConfigFileService, ReconcileService, MarketService;
                           # schemas.ts (zod inputs shared by IPC/HTTP/MCP), errors.ts (ServiceError), types.ts (DTOs)
  db/                      # SQLite via better-sqlite3, migrations (index.ts), repositories/, seed.ts
  bots/                    # BotManager, BaseBotRunner, WalletManager
  runtime/                 # Bot execution engine
    ScriptRunner.ts        # Manages worker thread lifecycle
    ScriptBotRunner.ts     # BaseBotRunner subclass for script-based bots
    RpcHandler.ts          # Dispatches RPC calls from worker to trading APIs
    BotContextProxy.ts     # Builds the `ctx` object scripts interact with
    PaperTradingState.ts   # Simulated balances for paper trading mode
    worker-bootstrap.ts    # Worker thread entry point (resolved with workerPath.ts)
  orders/                  # OrderService (the order choke point), ExchangeAdapter, fees, risk state
  exchange/polymarket/     # orders.ts (only CLOB order calls), trading.ts (read-only helpers)
  exchange/binance/        # client.ts (Binance REST client, HMAC-SHA256)
  risk/                    # RiskEngine, halts, kill switch, RiskMonitor, ramp, startup recovery
  config/                  # limits/mandate/fees/server/categories YAML: schema, loader, ConfigService (hot reload)
  ledger/                  # Forecast ledger, scoring, market cache
  reconcile/ recorder/ backtest/ audit/ notify/ security/ utils/
  sdk/                     # types.ts (ctx API types), guide.ts (script-writing guide)

templates/                 # Built-in bot script templates (seeded by db/seed.ts)

electron/
  main.ts                  # Single-instance lock, window, createCore, IPC registration, quit handling
  preload.ts               # Context bridge (exposes IPC to renderer)
  ipc/respond.ts           # { success, data } wrapping + sender check type
  ipc/handlers/            # Thin IPC handlers over core services (+ auth, AI assistant until 3b)
  ai/claude.ts             # AI script assistant client (removed in 3b)

web/client/src/            # React renderer
  pages/                   # Route pages (Dashboard, Bots, Scripts, Wallets, Settings, etc.)
  hooks/                   # React Query hooks wrapping IPC calls via electronApi
  lib/electronApi.ts       # IPC call wrappers (settingsApi, botsApi, etc.)
  types/                   # TypeScript types (Settings, electron.d.ts)
```

### Bot Script Execution Flow
1. User creates/starts a bot → IPC handler calls `BotService.start()` → `BotManager.startBot()`
2. `BotManager` creates a `ScriptBotRunner` with compiled script code
3. `ScriptBotRunner` spawns a `ScriptRunner` which creates a worker thread
4. Worker thread runs the script with a `ctx` object (built by `BotContextProxy`)
5. Script calls like `ctx.binance.getPrice('BTCUSDT')` become RPC messages to the main thread
6. `RpcHandler` dispatches RPC calls; every order goes through `packages/core/src/orders/OrderService` → `RiskEngine` → exchange adapter (live) or `PaperTradingState` (paper). Only `packages/core/src/exchange/polymarket/orders.ts` and `packages/core/src/exchange/binance/client.ts` may hit order endpoints (enforced by `tests/orders/choke-point.test.ts`)

### Key Patterns
- **IPC Handlers** (`electron/ipc/handlers/`): Each module registers `ipcMain.handle()` handlers that parse input with `services/schemas.ts`, call a core service (actor `human`) and wrap the result with `respond()`. Human-only writes also check the sender is the main window. Renderer calls via `window.electronAPI.*`
- **RPC Dispatch**: Worker scripts send `{ method, params }` messages. `RpcHandler` pattern-matches on method name (`binance:buy`, `clob:getPrice`, `storage:get`, etc.)
- **Paper Trading**: `PaperTradingState` tracks simulated balances for both Polymarket and Binance. Persisted via `BotStorageRepository`
- **Script Compilation**: User TypeScript scripts are compiled with esbuild at save time, stored in SQLite
- **Credential Security**: Wallet private keys and Binance API credentials are AES-encrypted (CryptoJS) at rest. Decrypted only in main process, never sent to renderer
- **Kelly Criterion**: `ctx.kelly.calculate(winRate, sampleSize, marketPrice, bankroll)` — pure math utility running locally in worker (no RPC). Implemented in `packages/core/src/utils/kellyCalculator.ts`, exposed via `BotContextProxy`

### Database (SQLite via better-sqlite3)
- **bots**: id, name, scriptId, walletId, config (JSON), mode (live/paper), status
- **wallets**: id, name, address, proxyAddress, privateKeyEncrypted, currentBotId
- **settings**: singleton row — rpcUrl, clobHttpUrl, usdcContractAddress, binance credentials (encrypted)
- **scripts**: id, name, sourceCode, compiledCode, configSchema (JSON)
- **bot_trades**: historical trade records per bot
- **bot_storage**: key-value store for bot state persistence
- Migrations run automatically in `packages/core/src/db/index.ts`

### Web Client Patterns (`web/client/src/`)
- React 19 + React Router + TanStack React Query + Tailwind CSS
- Hooks in `hooks/` wrap IPC calls via `electronApi` with React Query (auto-refetch, caching)
- No HTTP API calls — all communication is via Electron IPC (`window.electronAPI.*`)

## Key Gotchas

- **Polymarket API**: Series endpoint (`/series/{id}`) returns events WITHOUT `markets` field. Must use Event endpoint (`/events/{id}`) to get market data
- **Wallet addresses**: Polymarket USDC balance lives in `proxyAddress`, not the main `address`. Balance queries must use proxyAddress when available
- **Binance USDT-only**: Paper trading simulator only supports USDT-quoted pairs (BTCUSDT, ETHUSDT, etc.)
- **Worker thread isolation**: Bot scripts run in worker threads — they can only communicate via the RPC message channel, not access main process directly
- **Binance credentials**: Encrypted in settings table, decrypted only in `BotManager.getSettings()`. Only `hasBinanceCredentials: boolean` is ever sent to renderer
- **Script templates**: Registered in `packages/core/src/db/seed.ts`, source lives in `templates/`
- **Core is transport-free**: nothing under `packages/core` may import `electron` (ESLint + `tests/orders/choke-point.test.ts`). Business logic goes in services, not IPC handlers
- **Data dir**: `createCore({ dataDir })` — Electron passes `app.getPath('userData')`, tests a temp dir; without one the DB defaults to `BOTLAB_DATA_DIR` or `./data`

## Environment Variables

- `ENCRYPTION_KEY` — AES key for wallet/credential encryption (`openssl rand -hex 32`)
- `RPC_URL` — Polygon RPC endpoint
- `CLOB_HTTP_URL` — Polymarket CLOB API (default: https://clob.polymarket.com)
- `VITE_DEV_SERVER_URL` — Set automatically by `electron:dev` to `http://localhost:3000`
