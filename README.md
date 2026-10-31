# BotLab

Self-hosted trading lab for **Polymarket** prediction markets (and **Binance** spot). Bots are TypeScript
scripts that run in sandboxed worker threads; every order goes through a server-side **risk engine**
with human-set hard limits. One Node server holds the database, the bots and the risk controls; you use
it from a browser.

Runs natively on **macOS, Windows and Linux** (Node 22), or in **Docker** on a home server.

---

## Quick start

You need **Node.js 22** (LTS, 22.12 or newer) and git. No Docker, Tailscale, Telegram or exchange
credentials are needed to start: a fresh install runs **paper bots only**.

**Use Node 22, not the newest Node.** `better-sqlite3` (the only native module) does not build on Node 25+
yet, so `engines` is `>=22.12 <25` and `npm install` stops with a message on other versions (`.nvmrc` says
22). On macOS the current Homebrew `node` is too new: `brew install node@22` and put it first on your
`PATH` (`brew link --overwrite --force node@22`), or use `nvm install` / `fnm use` in the repo. npm 11
(bundled with newer Node) also skips dependency install scripts unless they are allowed, which leaves
`better-sqlite3` / `esbuild` without their binaries; with Node 22's npm 10 this does not apply. If you
must use npm 11, allow the scripts it lists (`better-sqlite3`, `esbuild`, `fsevents`) as its warning
explains, then run `npm rebuild better-sqlite3 esbuild`.

### macOS / Linux

```bash
git clone <repo-url> botlab && cd botlab
npm install
npm run dev          # server on :3780 (auto-restart) + UI with hot reload on http://localhost:3000
```

### Windows (PowerShell)

```powershell
git clone <repo-url> botlab; cd botlab
npm install
npm run dev          # then open http://localhost:3000
```

Open the UI and choose an **admin password** (first-run setup). From the same machine (server bound to
127.0.0.1) that is all; from anywhere else (another device, Tailscale, Docker) the setup screen also asks
for the **one-time setup code** the server prints in its log at start. In dev, data lives in `./data` and
the config files in `./config` (created with defaults on first start).

**Production mode** (built server serving the built UI, data in the OS app-data dir):

```bash
npm run build
npm run cli -- gen-key --prod   # once: creates the master key (see "Master key" below)
npm start                       # http://127.0.0.1:3780
```

| | data dir (`BOTLAB_DATA_DIR`) | config dir (`BOTLAB_CONFIG_DIR`) |
|---|---|---|
| `npm run dev` | `./data` | `./config` |
| `npm start` on macOS | `~/Library/Application Support/BotLab` | `…/BotLab/config` |
| `npm start` on Windows | `%APPDATA%\BotLab` | `%APPDATA%\BotLab\config` |
| `npm start` on Linux | `~/.local/share/botlab` | `~/.local/share/botlab/config` |
| Docker | `/data` (volume `./data`) | `/config` (volume `./config`) |

With `npm start`, setting only `BOTLAB_DATA_DIR` moves the config dir with it (`<data dir>/config`).

The data dir holds `botlab.db`, `backups/` (nightly, 14 kept), `logs/`, `config-history/` and, unless
you set the variables below, `master.key`.

### Docker (home server)

```bash
git clone <repo-url> botlab && cd botlab
mkdir -p data config secrets
openssl rand -hex 32 > secrets/master.key        # back this file up!
sudo chown -R 1000:1000 data config secrets/master.key && chmod 600 secrets/master.key   # container user `node`
docker compose up -d --build
```

The port is published on `127.0.0.1:3780` only. For remote access use **Tailscale** (never port
forwarding): either install Tailscale on the host and run `tailscale serve --bg 3780`, or use the
commented Tailscale sidecar in `docker-compose.yml`. `*.ts.net` host names are accepted by default;
other names go in `BOTLAB_ALLOWED_HOSTS` or `http.allowed_hosts` in `config/server.yaml`.
The image builds for `linux/amd64` and `linux/arm64` (`docker buildx build --platform linux/amd64,linux/arm64 .`).
`TZ=Europe/Dublin` is set for schedules and the daily digest; stored timestamps are UTC.

---

## First run, paper mode and going live

1. Open the UI, set the admin password (with the setup code from the log when not on the server
   itself: `docker compose logs botlab | grep "Setup code"`).
2. Create a bot from a template — new bots are **paper** bots (simulated balance, real market data).
3. Live trading is **off** until you enable it explicitly: add a wallet (Wallets page), set
   `live_trading.enabled: true` (Risk page → Limits, or `limits.yaml`), and create the bot in **Live** mode. Until then live
   bots are refused at start and any live order is rejected (`live_disabled`).
4. All hard limits (exposure, loss limits, order sizes, ramp) are in `config/limits.yaml` and
   `config/mandate.yaml`; edit them on the Risk page (validated, risk raises flagged, history with
   diff and restore) or by hand — edits are picked up without a restart.
5. Before a bot may **buy** a Polymarket market, the market's rules must be assessed: Markets page →
   open the market → **Set ambiguity** (or a forecast with an ambiguity score).

After an unclean stop (crash, power cut, Windows Update reboot, a second Ctrl+C) the server starts with a
**global halt**; open orders are cancelled. Clear it after checking: **Clear halt** on the Dashboard or the
Risk page (a reason and, if your last password check is older than 15 minutes, your password).

---

## Master key

Wallet private keys and Binance credentials are encrypted (AES-256-GCM) with a 32-byte **master key**,
loaded at boot from, in order:

1. `BOTLAB_MASTER_KEY` — 64 hex characters (`openssl rand -hex 32`);
2. `BOTLAB_MASTER_KEY_FILE` — path to a file containing them;
3. `<data dir>/master.key`.

With none of these, `npm run dev` generates `<data dir>/master.key` (and warns); `npm start` refuses to
start — create one with `npm run cli -- gen-key --prod`. **Back the key up** (password manager): without
it the encrypted secrets are lost. The admin password only protects the UI; it does not encrypt anything.

### Upgrading from the Electron app

The Electron app derived the encryption key from your unlock password. `npm start` uses the same data
dir as the Electron app on macOS and Windows, so it finds your database; the server then stays
**locked** (the login screen says why) until you migrate once:

```bash
# stop the server first
npm run migrate-key -- --prod
#   asks for your old BotLab password (hidden; or set BOTLAB_OLD_PASSWORD). A "skipped password" install
#   needs none. --password <pw> also works but ends up in your shell history. --data-dir for another location.
npm start
```

This re-encrypts every secret with the master key (creating `master.key` if none is configured), in one
transaction (a wrong password changes nothing), and makes your old password the admin login password if it
has 8+ characters; otherwise it asks for a new admin password (or `BOTLAB_NEW_ADMIN_PASSWORD`).
If you edited `config/*.yaml` in the repo while using Electron in dev, copy them into the production config
dir (table above); otherwise defaults are created there.

---

## Windows home server (service)

```powershell
winget install NSSM.NSSM            # service manager (once)
npm run build
npm run service:install             # in an elevated PowerShell (Run as Administrator)
```

This registers the **BotLab** Windows service (delayed auto-start at boot, no login needed; restart on
crash; graceful stop via Ctrl+C so the clean-shutdown marker is written; logs in
`%APPDATA%\BotLab\logs\service.log`). It runs as **your Windows account**, not LocalSystem: the script
asks for your Windows password (hidden; for a Microsoft account the account password, not the PIN) and
NSSM grants the account "Log on as a service". If that fails it removes the service and explains how to
set the account in `services.msc` → Log On. The data/config dirs and the master key file are passed
explicitly (`%APPDATA%\BotLab`). When you change your Windows password, update it in `services.msc` too.
`npm run service:uninstall` removes the service.
After `git pull`: `npm install`, `npm run build`, `nssm restart BotLab`.

Power and updates (spec §15.1): set **Sleep: Never** (Settings → System → Power), keep the PC on a UPS
if you can, and set Windows Update **active hours**. An update reboot is handled like a power cut:
resting orders expire on their own (GTD), BotLab restarts **halted**, and you clear the halt after checking.
Install Tailscale for Windows for remote access. Load is negligible next to gaming.

On macOS and Linux, `npm run service:install` prints a launchd / systemd unit with your paths.

---

## Configuration

| variable | default | |
|---|---|---|
| `BOTLAB_DATA_DIR` | see table above | database, backups, logs, master.key |
| `BOTLAB_CONFIG_DIR` | see table above | limits / mandate / fees / server / categories `.yaml` |
| `BOTLAB_MASTER_KEY` / `BOTLAB_MASTER_KEY_FILE` | — | master key (above) |
| `BOTLAB_HOST` | `127.0.0.1` | bind address (`http.host` in server.yaml). Never a public interface; a warning is logged for `0.0.0.0` |
| `BOTLAB_PORT` | `3780` | `http.port` in server.yaml |
| `BOTLAB_ALLOWED_HOSTS` | — | extra UI host names, comma-separated (IPs, `localhost`, `*.ts.net` always allowed) |
| `BOTLAB_LOG_DIR` | `<data dir>/logs` | daily log files |
| `TELEGRAM_BOT_TOKEN` | — | overrides `notify.telegram.bot_token` in server.yaml |
| `TZ` | system | e.g. `Europe/Dublin` |

A `.env` file in the working directory is read at start.

## Access, API and tokens

- **UI / admin**: password login → session cookie (httpOnly, SameSite=Strict, 7 days idle / 30 days
  max). Human-only actions (clear a halt, config writes/restores, position adoption, market ambiguity,
  forcing category rights, wallets, Binance credentials, settings, creating API tokens) also need the
  password entered within the last 15 minutes; the UI asks for it when needed.
- **Password guessing**: 5 wrong passwords per 15 minutes per client address, then 429. Behind a local
  proxy such as `tailscale serve`, every client arrives from 127.0.0.1, so logins share one bucket
  (someone guessing can lock you out for 15 minutes; re-auth is keyed per session). Use the CLI
  (`set-password`) if you are ever locked out of a fresh setup.
- **HTTP API**: `/api/*`, JSON `{ success, data?, error?, code? }`; mutations need the `X-BotLab: 1`
  header when using the cookie. Events: `GET /api/events` (server-sent events: `bot:event`, `bot:log`,
  `risk:halt`, `risk:halt-cleared`, `config:changed`, `market:rulesChanged`). Health: `GET /healthz`
  (no auth; 503 when the DB fails, the server is locked, the reconciler is stale > 3 min or a bot
  worker crashed).
- **API tokens** (`Authorization: Bearer blt_…`): scope `agent` (for the MCP agent in Phase 4: read,
  scripts, backtests, paper bot create / config update / start / stop, forecasts, kill switch — never
  wallets, credentials, settings, config writes or halt clearing) or `readonly` (GET only, and not
  wallets, settings, config or script export).
  `npm run cli -- token create --scope agent --name mcp` · `token list` · `token revoke <id>`.
- Forgot the admin password: `npm run cli -- set-password` (add `--prod` for the `npm start` data dir).

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

## Security notes

- Bind to `127.0.0.1` (default) or the Tailscale interface; never expose BotLab to the internet.
- Binance API key: trading only, **withdrawals disabled**, IP allowlist. Polymarket: a dedicated wallet
  funded only with risk capital.
- Bot scripts run in sandboxed worker threads (no filesystem, no environment, bounded heap); they reach
  trading APIs only through the RPC layer, and every order passes the risk engine.
- Secrets are decrypted only inside the server process; the UI only ever sees `hasBinanceCredentials`.

---

## Development

```bash
npm run dev            # server (node --watch + tsx) + Vite UI with /api proxy
npm run build          # tsc → dist/ (server + core), vite → apps/web/dist
npm start              # built server serving the built UI (production paths)
npm run typecheck      # core + server + web
npm test               # vitest (SKIP_NETWORK_TESTS=1 skips live-API tests)
npm run lint           # ESLint (0 errors expected)
npm run cli -- <cmd>   # migrate-key | gen-key | set-password | token create/list/revoke
```

```
packages/core/src/      all domain logic, no transport code (createCore, services, db, risk, orders,
                        runtime, ledger, reconcile, recorder, exchange, security, ops/backup)
apps/server/src/        Hono HTTP API, auth, SSE, /healthz, static UI, CLI, entrypoint
apps/web/               React UI (Vite), fetch + EventSource client in src/lib/api.ts
templates/              built-in bot templates
config/*.example.yaml   config defaults (real files are created on first start)
scripts/service.mjs     Windows service (NSSM) / launchd / systemd helper
docs/SPEC.md, docs/PROGRESS.md
```

---

## Disclaimer

Trading involves substantial risk of loss. The authors are not responsible for any financial losses or damages resulting from the use of this software. Use at your own risk.

---

## License

ISC
