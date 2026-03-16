# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
npm run lint               # ESLint check
npm run lint:fix           # Auto-fix
npm run format             # Prettier format
```

## Architecture

### Electron App (two processes)
1. **Main Process** (`electron/`) — SQLite database, IPC handlers, bot runtime, trading SDK
2. **Renderer Process** (`web/client/`) — React SPA loaded via Vite, communicates with main via IPC

### Directory Structure

```
electron/
  main.ts                  # App entry point, window creation, IPC registration
  preload.ts               # Context bridge (exposes IPC to renderer)
  database/                # SQLite via better-sqlite3, migrations, repositories
  ipc/handlers/            # IPC handler modules (bots, wallets, settings, scripts, auth)
  runtime/                 # Bot execution engine
    ScriptRunner.ts        # Manages worker thread lifecycle
    ScriptBotRunner.ts     # BaseBotRunner subclass for script-based bots
    RpcHandler.ts          # Dispatches RPC calls from worker to trading APIs
    BotContextProxy.ts     # Builds the `ctx` object scripts interact with
    PaperTradingState.ts   # Simulated balances for paper trading mode
    worker-bootstrap.ts    # Worker thread entry point
  sdk/
    types.ts               # Shared types (RPC methods, BotContext, Binance/Polymarket types)
    trading.ts             # Polymarket CLOB trading helpers
    binance.ts             # Binance REST API client (zero-dependency, HMAC-SHA256 signing)
  security/                # Encryption key management
  scripts/templates/       # Built-in bot script templates

src/core/                  # Bot framework (shared with Electron main)
  BotManager.ts            # Orchestrates bot instances, CLOB client cache
  BaseBotRunner.ts         # Abstract bot lifecycle (stopped→starting→running→stopping→error)
  WalletManager.ts         # AES encryption of private keys, exclusive wallet assignment

src/utils/                 # Shared utilities (logger, fetchData, kellyCalculator, etc.)

web/client/src/            # React renderer
  pages/                   # Route pages (Dashboard, Bots, Scripts, Wallets, Settings, etc.)
  hooks/                   # React Query hooks wrapping IPC calls via electronApi
  lib/electronApi.ts       # IPC call wrappers (settingsApi, botsApi, etc.)
  types/                   # TypeScript types (Settings, electron.d.ts)
```

### Bot Script Execution Flow
1. User creates/starts a bot → IPC handler calls `BotManager.startBot()`
2. `BotManager` creates a `ScriptBotRunner` with compiled script code
3. `ScriptBotRunner` spawns a `ScriptRunner` which creates a worker thread
4. Worker thread runs the script with a `ctx` object (built by `BotContextProxy`)
5. Script calls like `ctx.binance.getPrice('BTCUSDT')` become RPC messages to the main thread
6. `RpcHandler` dispatches RPC calls to the real API (live mode) or `PaperTradingState` (paper mode)

### Key Patterns
- **IPC Handlers** (`electron/ipc/handlers/`): Each module registers `ipcMain.handle()` handlers. Renderer calls via `window.electronAPI.*`
- **RPC Dispatch**: Worker scripts send `{ method, params }` messages. `RpcHandler` pattern-matches on method name (`binance:buy`, `clob:getPrice`, `storage:get`, etc.)
- **Paper Trading**: `PaperTradingState` tracks simulated balances for both Polymarket and Binance. Persisted via `BotStorageRepository`
- **Script Compilation**: User TypeScript scripts are compiled with esbuild at save time, stored in SQLite
- **Credential Security**: Wallet private keys and Binance API credentials are AES-encrypted (CryptoJS) at rest. Decrypted only in main process, never sent to renderer
- **Kelly Criterion**: `ctx.kelly.calculate(winRate, sampleSize, marketPrice, bankroll)` — pure math utility running locally in worker (no RPC). Implemented in `src/utils/kellyCalculator.ts`, exposed via `BotContextProxy`

### Database (SQLite via better-sqlite3)
- **bots**: id, name, scriptId, walletId, config (JSON), mode (live/paper), status
- **wallets**: id, name, address, proxyAddress, privateKeyEncrypted, currentBotId
- **settings**: singleton row — rpcUrl, clobHttpUrl, usdcContractAddress, binance credentials (encrypted)
- **scripts**: id, name, sourceCode, compiledCode, configSchema (JSON)
- **bot_trades**: historical trade records per bot
- **bot_storage**: key-value store for bot state persistence
- Migrations run automatically in `electron/database/index.ts`

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
- **Script templates**: Registered in `electron/database/seed.ts`, source lives in `electron/scripts/templates/`

## Environment Variables

- `ENCRYPTION_KEY` — AES key for wallet/credential encryption (`openssl rand -hex 32`)
- `RPC_URL` — Polygon RPC endpoint
- `CLOB_HTTP_URL` — Polymarket CLOB API (default: https://clob.polymarket.com)
- `VITE_DEV_SERVER_URL` — Set automatically by `electron:dev` to `http://localhost:3000`
