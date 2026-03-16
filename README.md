# BotLab

Desktop trading bot platform for **Polymarket** prediction markets and **Binance** spot crypto. Write TypeScript bot scripts, run them in paper or live mode, and manage everything from a single app.

Built with Electron, React, and SQLite.

---

## Features

- **Script-based bots** — Write trading logic in TypeScript with a full SDK (`ctx.buy()`, `ctx.binance.getPrice()`, `ctx.fetch()`, etc.)
- **Paper & live trading** — Test strategies with simulated balances before risking real funds
- **Polymarket integration** — Trade prediction markets via the CLOB API (order books, positions, market data)
- **Binance integration** — Spot trading on Binance (BTCUSDT, ETHUSDT, and any USDT-quoted pair)
- **Built-in templates** — Copy Trading, Odds Threshold, Trader Discovery, Binance Spot, and a blank starter
- **Script editor** — Edit bot scripts in-app with a full API reference
- **Wallet management** — Import Ethereum wallets with encrypted private key storage
- **Persistent state** — Bots can save/load state across restarts via key-value storage
- **Password protection** — App locks behind a password on launch; all secrets encrypted at rest

---

## Getting Started

### Prerequisites

- **Node.js** 18+
- **npm** 9+
- A Polymarket-compatible **Ethereum wallet** (with proxy address for trading)
- *(Optional)* Binance API credentials for spot trading

### Install

```bash
git clone <repo-url>
cd polymarket-bot-app
npm install
npm run electron:rebuild   # Rebuild native modules (better-sqlite3) for Electron
```

### Run in Development

```bash
npm run electron:dev
```

This compiles the Electron main process, starts the Vite dev server with hot reload, and launches the app.

### Build for Distribution

```bash
npm run electron:build
```

Outputs packaged apps to `release/` — DMG/ZIP on macOS, NSIS/portable on Windows, AppImage/deb on Linux.

---

## How It Works

### App Structure

When you launch BotLab, you'll see these pages:

| Page | What it does |
|------|-------------|
| **Dashboard** | Overview of all bots — count, status, last heartbeat |
| **Bots** | Create, start, stop, and monitor bot instances |
| **Scripts** | Browse templates, write custom scripts, import/export |
| **Wallets** | Add Ethereum wallets (private keys are AES-encrypted) |
| **Settings** | Configure RPC endpoint, CLOB URL, and Binance API credentials |

### Creating a Bot

1. Go to **Scripts** and pick a template (or write your own)
2. Go to **Bots** → **Create Bot**
3. Choose the script, fill in the config form, pick a wallet, and select **Paper** or **Live** mode
4. Start the bot — it runs in a background worker thread

### Paper vs Live Mode

- **Paper mode**: Bot uses a virtual USDT balance (default $10,000). Trades execute against real order book data but no real money moves. Great for testing.
- **Live mode**: Bot executes real trades on Polymarket or Binance using your wallet and API credentials.

---

## Writing Bot Scripts

Bot scripts are TypeScript files that export lifecycle functions. The simplest pattern is `onTick` — the framework handles the polling loop for you:

```typescript
export const meta = {
  name: 'My Bot',
  description: 'Does something cool',
  configSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', title: 'Trading Pair', default: 'BTCUSDT' },
      amount: { type: 'number', title: 'Trade Amount', default: 10 },
      pollingIntervalMs: { type: 'number', title: 'Polling Interval (ms)', default: 30000 },
    },
  },
};

// Called once on start (optional — use for one-time setup)
export async function onStart(ctx) {
  ctx.log.info('Bot started!');
}

// Called every pollingIntervalMs — put your strategy here
export async function onTick(ctx) {
  const price = await ctx.binance.getPrice(ctx.config.symbol);
  ctx.log.info(`${ctx.config.symbol}: $${price.price}`);
}

export async function onStop(ctx) {
  ctx.log.info('Bot stopped');
}

export function onHeartbeat(ctx) {
  return { status: 'running' };
}
```

### Simple vs Advanced Pattern

- **Simple (`onTick`):** Export `onTick(ctx)` and the framework polls it automatically at `pollingIntervalMs` (default: 10s). Best for most bots.
- **Advanced (`onStart` only):** Set up your own `ctx.setInterval()` loops in `onStart`. Use this for complex bots that need multiple loops running at different intervals (e.g., copy-trading, odds-threshold).

At least one of `onStart` or `onTick` must be exported. Both can coexist — `onStart` runs first, then `onTick` polling begins.

### Script API Reference (`ctx`)

**Polymarket Trading**
| Method | Description |
|--------|-------------|
| `ctx.buy(tokenId, amountUsd, opts?)` | Buy prediction market tokens |
| `ctx.sell(tokenId, amountTokens, opts?)` | Sell prediction market tokens |
| `ctx.getOrderBook(tokenId)` | Get bids/asks for a token |
| `ctx.getPositions()` | Get all open positions |
| `ctx.getBalance()` | Get USDC wallet balance |

**Market Data**
| Method | Description |
|--------|-------------|
| `ctx.getMarkets(query?)` | Search/filter Polymarket markets |
| `ctx.getMarketPrice(tokenId)` | Get bid/ask/mid/spread |
| `ctx.getEvent(eventSlug)` | Get event with all its markets |

**Binance Spot**
| Method | Description |
|--------|-------------|
| `ctx.binance.buy(symbol, usdtAmount)` | Market buy (e.g., spend 100 USDT on BTC) |
| `ctx.binance.sell(symbol, quantity)` | Market sell (e.g., sell 0.01 BTC) |
| `ctx.binance.getPrice(symbol)` | Current price |
| `ctx.binance.getBalance(asset?)` | Balance for an asset (default: USDT) |
| `ctx.binance.getOrderBook(symbol)` | Order book depth |
| `ctx.binance.getPositions()` | All non-zero balances |

**Kelly Criterion (Position Sizing)**
| Method | Description |
|--------|-------------|
| `ctx.kelly.calculate(winRate, sampleSize, marketPrice, bankroll, config?)` | Calculate optimal position size using the Kelly Criterion. Returns `{ shouldTrade, tradeAmount, positionFraction, edge, confidence, reason }` |
| `ctx.kelly.DEFAULT_CONFIG` | Default config: quarter Kelly, 3% min edge, 5% max position, 20 min sample size |

`config` is optional and defaults to conservative quarter-Kelly sizing. Override with `{ kellyFraction, minEdge, maxPositionFraction, minSampleSize, confidenceDecayRate }`.

**Utilities**
| Method | Description |
|--------|-------------|
| `ctx.fetch(url, init?)` | HTTP requests to external APIs |
| `ctx.setInterval(fn, ms)` | Repeating timer (auto-cleaned on stop) |
| `ctx.setTimeout(fn, ms)` | One-shot timer (auto-cleaned on stop) |
| `ctx.log.info/warn/error/debug(...)` | Logging (visible in bot detail view) |
| `ctx.storage.get/set/delete(key)` | Persistent key-value storage per bot |
| `ctx.emit(type, data?)` | Emit custom events |
| `ctx.config` | User-configured values from the UI form |
| `ctx.botId` / `ctx.botName` | Bot metadata |
| `ctx.wallet.address` / `ctx.wallet.proxyAddress` | Wallet info (read-only) |

### Config Schema

The `meta.configSchema` object is a JSON Schema that generates the configuration form in the UI when creating a bot. Supported types: `string`, `number`, `integer`, `boolean`, `array`. Each property becomes a form field with the `title` as the label and `description` as help text.

---

## Built-in Templates

| Template | Description |
|----------|-------------|
| **Copy Trading** | Monitor Polymarket traders and copy their trades. Configurable multipliers, Kelly criterion sizing, position limits, daily volume caps, and auto-redeem. |
| **Binance Spot** | Monitor Binance spot prices and trade based on price thresholds. |

You can **fork** any template to create your own version, or **import/export** scripts as files.

---

## Settings

### Polymarket

- **RPC URL** — Polygon RPC endpoint (for on-chain transactions)
- **CLOB URL** — Polymarket CLOB API endpoint (default: `https://clob.polymarket.com`)
- **USDC Contract** — Polygon USDC contract address

### Binance

- **API Key** / **API Secret** — Binance API credentials for spot trading
- Credentials are AES-encrypted and stored locally — never sent to any external service
- Use the **Test Connection** button to verify your credentials
- Paper trading works without Binance credentials (uses simulated balances with real market data)

---

## Security

- **Password protection** — The app requires a password on first launch. All wallet private keys and API credentials are encrypted with a key derived from this password.
- **Encrypted storage** — Private keys and Binance secrets are AES-encrypted in the local SQLite database. They are decrypted only in the main process and never exposed to the renderer.
- **Worker isolation** — Bot scripts run in sandboxed worker threads. They communicate with the main process via an RPC message channel — no direct access to the filesystem, database, or private keys.

---

## Development

### Commands

```bash
npm run electron:dev       # Dev mode with hot reload
npm run electron:compile   # Compile TypeScript only
npm run electron:preview   # Run without Vite dev server
npm run electron:build     # Package for distribution
npm test                   # Run all tests
npm run test:electron      # Electron-layer tests only
npm run lint               # ESLint
npm run format             # Prettier
```

### Project Structure

```
electron/                  # Electron main process
  main.ts                  # App entry, window creation, IPC setup
  preload.ts               # Context bridge (IPC → renderer)
  database/                # SQLite database, migrations, repositories
  ipc/handlers/            # IPC handlers (bots, wallets, settings, scripts, auth)
  runtime/                 # Bot execution engine (ScriptRunner, RpcHandler, PaperTradingState)
  sdk/                     # Trading clients (Polymarket, Binance) and shared types
  scripts/templates/       # Built-in bot script templates
  security/                # Encryption key management

web/client/                # React renderer (Vite)
  src/pages/               # UI pages (Dashboard, Bots, Scripts, Wallets, Settings)
  src/hooks/               # React Query hooks wrapping IPC calls
  src/lib/electronApi.ts   # IPC call wrappers

src/core/                  # Bot framework
  BotManager.ts            # Orchestrates bot instances
  BaseBotRunner.ts         # Abstract bot lifecycle
  WalletManager.ts         # Encrypted wallet management
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ENCRYPTION_KEY` | AES key for wallet encryption (`openssl rand -hex 32`) |
| `RPC_URL` | Polygon RPC endpoint |
| `CLOB_HTTP_URL` | Polymarket CLOB API URL |

---

## Disclaimer

Trading involves substantial risk of loss. The authors are not responsible for any financial losses or damages resulting from the use of this software. Use at your own risk.

---

## License

ISC
