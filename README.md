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

### Upgrade notes (2026-10-31 fix-up round)

- **Config dir with `BOTLAB_DATA_DIR`:** with `npm start` and only `BOTLAB_DATA_DIR` set, the config dir is now
  `<data dir>/config` (it used to stay in the OS app-data dir). The server prints a warning at startup if your
  old config files are still in the old place; move them, or set `BOTLAB_CONFIG_DIR` to the old dir.
- **`resting_order_ttl_minutes` must be ≥ 3** in `limits.yaml`: Polymarket refuses GTD orders that expire less
  than 3 minutes ahead. A smaller value makes `limits.yaml` invalid: at startup everything that needs the config
  fails closed (no orders, the Risk page shows the error); on a live edit the previous valid config stays. Raise
  it to 3 or more. Scripts calling `placeLimit` with `ttlMinutes` < 3 get an error.
- **`categories.yaml` / `fees.yaml`** you already have are not rewritten: see `docs/PROGRESS.md` (R50, R125) for
  the economics-tag and sports-fee changes to apply by hand.

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

## Hosting on a VPS

Polymarket blocks some IPs: whole countries (**geo-block**, the Terms of Service restrict them) and, separately,
many datacenter ranges (**bot protection**: Cloudflare challenge pages, 403s, 429s, dropped connections — an
Oracle Cloud VM has been blocked this way). Test a candidate server **before** migrating:

1. Rent the smallest **hourly-billed** instance in the provider / region you want and install Node 22 and BotLab
   (`npm install`; no database or key needed).
2. Run the check:

   ```bash
   npm run cli -- check-polymarket              # table + verdict; --json for machine-readable output
   npm run cli -- check-polymarket --binance    # also Binance's public API (451 = restricted location)
   ```

   It calls, read-only, every endpoint BotLab uses: Cloudflare's trace (public IP and country), Polymarket's
   geoblock endpoint, the CLOB (`/time` with clock skew, `/markets/{id}`, `/book`), Gamma (`/markets`, `/events`)
   and the data API (`/positions`, `/activity`), 10 s timeout each. Each row is `ok`, `geo_blocked`,
   `bot_challenge`, `forbidden`, `rate_limited`, `network_error` or `unexpected`, and the last line is the verdict:
   `OK: this IP can use Polymarket` (exit 0), `BLOCKED (geo): …` or `BLOCKED (datacenter/bot protection): …`
   (exit 1), `DEGRADED: …` (exit 2: rate limits, partial failures, clock skew, Binance restricted).
3. **Keep the instance only if the verdict is OK**; otherwise destroy it and try another provider or region.
   After migrating, re-run the check now and then (e.g. weekly, or when orders start failing): ranges get
   re-classified. With a configured wallet, `npm run cli -- check-polymarket --prod --with-credentials` also makes
   authenticated read-only CLOB calls (derive the existing API key — it never creates one —, list API keys,
   close-only status). It opens the database read-only, so it may run next to the server; keys are never printed.

- **Geo vs datacenter**: a geo-block is about the country — another provider in the same country will not help,
  only a server in an allowed country will. A datacenter / bot block is about the IP range — another provider
  or region (or a residential connection) can work.
- **Do not use a VPN or proxy to get around a geo restriction**: it breaks Polymarket's Terms of Service and can
  get the account restricted to close-only or closed. (`HTTPS_PROXY` is honoured by the check, but then it
  tests the proxy's IP and says so.)
- **Expose BotLab over Tailscale only**: bind it to the Tailscale address (`BOTLAB_HOST=100.x.y.z`; or keep
  127.0.0.1 behind `tailscale serve`), never `0.0.0.0`; allow no inbound port in the provider's firewall (SSH over
  Tailscale too, if you can), and open the UI at `http://<machine>.<tailnet>.ts.net:3780` (`*.ts.net` names are
  allowed by default).
- **Back up off the box**: the nightly backups land in `<data dir>/backups` on the same disk. Copy them elsewhere
  (restic / rclone / rsync to another machine or bucket) and keep the **master key** in a separate place
  (password manager): a backup without it cannot decrypt the wallet keys.
- A **home connection** (the Windows service above, a Mac mini, a Raspberry-class Linux box) is the most reliable
  fallback: residential IPs are rarely filtered, and a UPS plus the halted restart after a power cut cover the
  rest.

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
| `ANTHROPIC_API_KEY` | — | the scheduled agent's API key (only from the environment; never stored by BotLab). See "Running the agent" |
| `TZ` | system | e.g. `Europe/Dublin` |

A `.env` file in the working directory is read at start.

**`min_liquidity_usd` is 24 h volume.** Both `limits.yaml per_market.min_liquidity_usd` and `mandate.yaml
markets.min_liquidity_usd` (default 5000; the larger applies) are compared with the market's Gamma **24 h volume**
— by the forecast ledger, the risk engine and copy trading alike — not with order-book liquidity. On the
2026-10-31 Mac test only a handful of in-mandate markets (economics / politics-non-us / weather-climate ending
within 90 days) cleared $5,000 of 24 h volume, so most forecasts and bids in those categories were refused. If you
want BotLab to trade more of them, consider lowering `min_liquidity_usd` (your call; the agent cannot change it).

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
  `risk:halt`, `risk:halt-cleared`, `config:changed`, `market:rulesChanged`, `agent:run`). Health: `GET /healthz`
  (no auth; 503 when the DB fails, the server is locked, the reconciler is stale > 3 min or a bot
  worker crashed).
- **API tokens** (`Authorization: Bearer blt_…`): scope `agent` (the MCP agent, below; on `/api` it keeps
  read routes, scripts, backtests, paper bot create / config update of its own bots / start of its own bots /
  stop, forecasts, kill switch — never wallets, credentials, settings, config writes or halt clearing) or
  `readonly` (GET only, and not wallets, settings, config or script export).
  `npm run cli -- token create --scope agent --name mcp` · `token list` · `token revoke <id>`.
- Forgot the admin password: `npm run cli -- set-password` (add `--prod` for the `npm start` data dir).

## MCP server (AI agent)

BotLab exposes its agent interface as an MCP server (spec §7.3): **Streamable HTTP at `/mcp`**, authenticated
with an **agent-scope token only** (a readonly token or the admin session is refused). Everything the agent can
do goes through the same core services and rules as the UI: its bots are paper bots on their own paper wallet,
it may change / start / retire only bots it created (it may pause any), bot creation is capped by
`limits.yaml` `agent.max_bots_created_per_day` / `max_active_bots`, its ambiguity assessments can only set or
raise a score (never lower it or override yours), new runs are refused once `agent.monthly_llm_budget_usd` is
used, and tool calls are capped per run (`max_tool_calls_per_run`) and per token per hour
(`max_tool_calls_per_hour`, also for its `/api` calls). LLM cost is recorded only by BotLab's agent runner (4b):
**interactive use from Claude Code / Claude Desktop is not cost-tracked by BotLab** (that bill is your client's). It cannot touch limits, the mandate, wallets, credentials, settings or orders, and
cannot clear halts. Every tool call is in the audit log (`mcp.<tool>`, actor `agent`). The Agent page shows
runs, notes, budget and exit flags.

Tools: read — `get_overview`, `search_markets`, `get_market`, `get_orderbook`, `get_price_history`,
`get_positions`, `get_open_orders`, `get_trades`, `list_bots`, `get_bot`, `get_bot_logs`, `list_templates`,
`get_script`, `get_forecasts`, `get_ledger_stats`, `get_notes`, `get_run_history`, `get_leaderboard`;
build — `validate_script` (compile + typecheck against `botlab-sdk.d.ts`), `create_template`,
`update_template`, `run_backtest`, `get_backtest`; operate — `create_bot`, `update_bot_config`, `start_bot`,
`pause_bot`, `retire_bot`, `submit_forecast`, `withdraw_forecast`, `assess_market`, `flag_position_exit`,
`kill_switch`, `watch_market`, `unwatch_market`, `write_note`, `delete_note`, `start_run`, `finish_run`.
Resources: `botlab://sdk/types.d.ts`, `botlab://sdk/guide.md`, `botlab://templates/{id}`,
`botlab://config/mandate`, `botlab://config/limits`, `botlab://fees`.

Create a token first (with the server running or not): `npm run cli -- token create --scope agent --name claude`
(add `--prod` for the `npm start` data dir), or Settings → API tokens.

**Claude Code** (HTTP, any OS):

```bash
claude mcp add --transport http botlab http://127.0.0.1:3780/mcp --header "Authorization: Bearer blt_…"
```

**Claude Desktop** (stdio): Desktop starts a local process, so BotLab ships a stdio proxy
(`dist/apps/server/src/mcp-stdio.js`, built by `npm run build`; `npm run mcp:stdio` runs it). It does not open the
database: it forwards every message to the running server's `/mcp` with the token. Edit
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "botlab": {
      "command": "node",
      "args": ["/Users/you/botlab/dist/apps/server/src/mcp-stdio.js"],
      "env": { "BOTLAB_URL": "http://127.0.0.1:3780", "BOTLAB_AGENT_TOKEN": "blt_…" }
    }
  }
}
```

On Windows use `"args": ["C:\\Users\\you\\botlab\\dist\\apps\\server\\src\\mcp-stdio.js"]`. The same
proxy works for Claude Code (`claude mcp add botlab -e BOTLAB_URL=http://127.0.0.1:3780 -e BOTLAB_AGENT_TOKEN=blt_… -- node /path/to/mcp-stdio.js`).
Revoking the token (`npm run cli -- token revoke <id>` or Settings) cuts the agent off at once. The proxy refuses
to send the token over plain `http://` except to loopback or Tailscale (`*.ts.net`, 100.64.0.0/10); use https
or set `BOTLAB_ALLOW_INSECURE=1` to override.

Tool results that contain third-party text (market questions and rules, names, log lines) are wrapped in
`<untrusted_data>` blocks and the guide tells the agent not to follow instructions in them; the real protection
is structural (what the agent cannot do, above).

## Running the agent

The server can run the agent itself on a schedule (spec §7.1): a separate runner process (`apps/agent`, the
Claude Agent SDK) that talks to BotLab only through `/mcp`, plus web search and web fetch — no shell, no file
access. It is **off by default**. Before you switch it on:

1. Keep live trading off (`limits.yaml` `live_trading.enabled: false`) while you watch the first days: the
   agent only ever creates **paper** bots, and its forecasts go to the ledger ("shadow" mode).
2. Set the agent limits in `limits.yaml` → `agent:` (Risk page): `monthly_llm_budget_usd` (start low, e.g. 30),
   `max_run_cost_usd` (default 1.50), `max_bots_created_per_day`, `max_active_bots`.
3. Get an API key from the Anthropic Console and put it **in the server's environment** as
   `ANTHROPIC_API_KEY` (never in a config file or the database):
   - **macOS / Linux** (`npm start` in a terminal): `export ANTHROPIC_API_KEY=sk-ant-…` before starting, or add
     it to the launchd plist (`EnvironmentVariables`) / systemd unit (`Environment=`) printed by
     `npm run service:install`.
   - **Windows service (NSSM)**, in an elevated PowerShell (the `+` appends to the variables the installer set):

     ```powershell
     nssm set BotLab AppEnvironmentExtra +ANTHROPIC_API_KEY=sk-ant-...
     nssm restart BotLab
     nssm get BotLab AppEnvironmentExtra      # check: BOTLAB_* paths and the key
     ```

     `npm run service:install` rewrites the service settings: add the key again after reinstalling.
   - **Windows, in a terminal**: `$env:ANTHROPIC_API_KEY = "sk-ant-..."` then `npm start`.
   - **Docker**: `ANTHROPIC_API_KEY` in the compose `environment:` (from your shell or an `.env` file next to
     `docker-compose.yml`).
4. In `server.yaml` (Risk → Server), set `agent.enabled: true`. Recommended: `model: claude-sonnet-5-5` (default;
   `claude-opus-5-5` is about twice the cost per token). The change applies without a restart.

Schedule (local times in `server.yaml` `timezone`, default Europe/Dublin): daily review at 07:30 and cycles at
11:30, 15:30, 19:30 and 23:30 (`agent.schedule`); nothing between 00:00 and 07:00 — bots keep running and the
risk engine keeps enforcing. **Event runs** (maintenance only: no new bots, templates or forecasts — the server
refuses them) start when a held market's rules change, a bot is halted or reconciliation finds a mismatch: at
most 4 a day and one per 30 minutes; at night only bot halts start one. Start a run by hand from the Agent page
("Run now") or Telegram `/run [cycle|review]`.

What the server enforces for every run: it opens the run itself (the agent cannot skip run accounting), gives the
runner a fresh agent token that is revoked when the run ends, refuses the run when one is already active or the
monthly budget is used (one Telegram notice a month), records the token usage and cost the runner reports, and
stops the run at `max_run_cost_usd`, `agent.max_turns` or 30 minutes (the runner aborts; the server kills it if
it does not exit). The Telegram run report (cost, duration, summary) follows every run, including failures, and
the 08:00 digest lists the last 24 hours of runs and the month's spend. With the agent enabled but no
`ANTHROPIC_API_KEY`, the server logs a warning and schedules nothing. Budget: with the defaults (5 scheduled plus
up to 4 event runs a day, ≤ $1.50 each) the theoretical maximum is about $400 a month; typical Sonnet runs cost
far less, and `monthly_llm_budget_usd` is the hard stop.

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

**Orders v2, ledger, risk, events** (full types: `botlab://sdk/types.d.ts`)
| Method | Description |
|--------|-------------|
| `ctx.polymarket.placeLimit(tokenId, side, price, size, opts?)` | Post-only GTD limit order (`ttlMinutes` ≥ 3, `forecastId`, `reason`) |
| `ctx.polymarket.cancel / cancelAll / getOpenOrders / getFee` | This bot's orders; fee rates |
| `ctx.ledger.getActiveForecasts(filter?)` / `getForecast(tokenId)` | Read the forecast ledger |
| `ctx.risk.getBudget()` | Remaining allocation, per-market room, halted |
| `ctx.risk.getExitFlags()` | Open exit flags on this bot's positions |
| `ctx.polymarket.getMarket(conditionIdOrTokenId)` | Cached market: tokens, complement (NO) token, end date, closed, ambiguity, rules hash / change, dispute, in this bot's scope |
| `ctx.requestRetire(reason)` | Retire this bot (terminal; the server stops it) when its opportunity is over |
| `ctx.events.on('forecast_changed' \| 'rules_changed' \| 'halt', fn)` | Server push events (hints to re-check) |
| `ctx.portfolio.*` | Position Manager template only |

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
| **Forecast Executor** | Standing bot (one per mode): trades the forecast ledger with post-only, Kelly-sized bids. See Strategies. |
| **Position Manager** | Standing bot (one per mode): exits every bot's positions as risk exits. See Strategies. |
| **Consistency** | Per opportunity: trades violations of a constraint between markets (implies, date ladder, exclusive sum) with hedged baskets. See Strategies. |
| **Resolution Rule** | Per market: bids up to a target on the outcome its thesis favours, holds to resolution. See Strategies. |
| **Copy Trading** | Optional (mandate `strategies.allow: copy`): mirrors selected Polymarket leaders with limits near their fill, in mandate markets only; leaders are scored and dropped when their copies lose. See Strategies. |
| **Binance Spot** | Monitor Binance spot prices and trade based on price thresholds. |

You can **fork** any template to create your own version, or **import/export** scripts as files.

## Strategies

The core strategy is: the agent (or you) writes **forecasts** in the ledger, the **Forecast Executor** buys where
the market is cheaper than the forecast, and the **Position Manager** takes the profit when the price converges
(spec §3.4: edge is usually realised before settlement) or gets out when something changes. Run one bot of each
(Bots → New bot → pick the template; any wallet; a second running copy in the same mode is refused). Both
templates are seeded with trust `new`: their bots start in **paper** and go through the ramp (paper → probation →
full) like any new template. Paper bots fill resting orders when a later book check crosses them (no fees for
makers).

**Forecast Executor** (`templates/forecast-executor.ts`, spec §9.1) — for every *tradeable* active forecast
(bucket `trading`, category allowed) it looks at the forecast's token (fair value p) and the other token of the
binary market (fair value 1 − p). Where the ask leaves `min_edge` after the taker fee it rests a post-only GTD bid
at min(best bid + tick, fair − `min_edge`). Size = `kelly_fraction` × Kelly (p − c)/(1 − c) × the bucket's
allocation, capped by `max_per_market_usd` and `ctx.risk.getBudget()`; when the budget does not cover everything
the best **edge per day** (edge / days to settlement) wins, at most `max_markets` markets. Re-quotes every
`requote_minutes` and immediately on forecast / rules / halt events; cancels its bids when the forecast is
superseded, withdrawn, no longer tradeable or the edge is gone. It never sells.

| config | default | |
|---|---|---|
| `min_edge` | 0.05 | edge after fees, never below 0.03 (the risk engine checks it too) |
| `kelly_fraction` | 0.25 | fraction of full Kelly |
| `requote_minutes` | 10 | how often quotes are recomputed |
| `bid_ttl_minutes` | 60 | resting bids' lifetime (min 3); re-placed only when ≤ min(5 min, ttl / 2) remain or the price / size must change |
| `max_per_market_usd` | 25 | this bot's cost + open bids per market |
| `max_markets` | 10 | |
| `min_edge_per_day` | 0.001 | quotes below this edge / day are skipped; **keep equal to the Position Manager's `min_hold_edge_per_day`** |

It leaves its own resting bids out of the book (it never outbids itself) and keeps a bid while it is still at or
above the best competing bid. It quotes no more markets than `limits.yaml per_bot_defaults.max_orders_per_hour`
can keep quoted (`ctx.risk.getBudget().ordersPerHour`; about 9 markets at 20/h with 60-minute bids) and places at
most the orders left this hour. The hourly rate counts only orders a bot itself submitted (not risk rejections,
not the Position Manager's exits placed for it); 6 risk rejections within 10 minutes pause a bot's own
submissions until the window drains (`rejection_cooldown`). After the Position Manager stops a position out — on
any bot's position in the same mode — the token is skipped until its forecast is renewed, and a token (or its
complement) with an open exit flag on any bot's position is not bid on. Each cycle it records the best edge per day it could not fund (read by the Position Manager).

**Position Manager** (`templates/position-manager.ts`, spec §9.2) — the only bot that can see other bots'
positions (`ctx.portfolio`, granted by the server to this builtin template only; forks do not get it). It exits a
position **as the bot that holds it**: a risk-exit sell through that bot's own order path and the risk engine, so
it can never buy, never sell more than the bot holds net of its open sells, and every exit is in the audit log
(`position.exit`, actor the manager) with the order attributed to the owning bot (`placed_by` the manager).

| trigger | when |
|---|---|
| take-profit (default) | best bid ≥ fair − `take_profit_margin` (0.02); the fair value is per token, so NO positions mirror |
| forecast withdrawn / flipped | no active forecast prices the token, or it values it below the entry price |
| low edge per day | (fair − bid) / days to end < `min_hold_edge_per_day` (0.001; 0 = off) **and** the running executor reported, within the last hour, unfunded demand with a higher edge per day |
| rules changed | the market's rules changed after the position was opened |
| ambiguity | score ≥ 2 (after the server raise) or a UMA dispute |
| exit flag | an open `flag_position_exit` (agent or human); marked handled when the position is closed |
| stop | bid ≤ entry − `stop_loss_move` (0.15) and the forecast was not renewed |
| market end | ambiguity ≥ 1 and less than `exit_before_end_minutes` (180) to the end |

Positions bought without a forecast (copy trading, your own scripts) only get the risk triggers (rules,
ambiguity, flag, end); `ignore_bot_ids` leaves bots alone. Only a human creates, starts or reconfigures these two
bots (the agent may pause them). Scripts cannot flag their own orders as risk exits; the owning bot's own
`cancel` / `cancelAll` leave the manager's exits alone. Exits rest post-only first and become marketable
(best bid − `escalate_slippage`) after `escalate_after_minutes` (30). If the risk engine refuses the marketable
exit (e.g. top of book below `min_top_of_book_usd`), the exit rests post-only one tick above the best bid instead
and marketable is retried after 10 minutes: a triggered position always has an exit order. Risk exits are exempt from hold time, order
size, rate and spread limits and pass from any bot stage (a retired bot's positions can still be exited), but not
from halts: during a halt or kill switch nothing is sold (spec §4.3).

### Per-opportunity strategies: Consistency and Resolution Rule (5b)

These two builtin templates (trust `new`: paper first) are made **one bot per opportunity**, usually by the agent
(it may create, start, reconfigure and retire them; the standing executor / manager stay human-operated). They do
not use forecasts or category rights, but every market they buy must be assessed for ambiguity (R51). A bot's
`market_ids` must cover every token in its config (checked by the server for agent bots; every bot refuses to
start otherwise). When their markets close, or the opportunity is gone, they retire themselves
(`ctx.requestRetire`). Exits on risk triggers (rules change, ambiguity, dispute, exit flags) are left to the
Position Manager. The bot page shows the consistency constraint with its current gap, or the resolution-rule
thesis with its state.

Polymarket has **no shorting**: to "sell" an outcome you do not hold, a bot buys the market's **other (NO) token**
— YES at a plus NO at b pays exactly 1, so the NO token is the short.

**Consistency** (`templates/consistency.ts`, spec §9.3) — a declared logical constraint between binary markets
(their YES tokens, in `tokens`):

| `constraint` | tokens | rule | trade on a violation |
|---|---|---|---|
| `implies` | [A, B] | A implies B: P(A) ≤ P(B) | buy B YES + A NO (pays ≥ 1) |
| `date_ladder` | ordered by deadline, earliest first | "by date 1" implies "by date 2": prices non-decreasing | the most inverted pair: later YES + earlier NO |
| `exclusive_sum` | mutually exclusive outcomes | Σ P ≤ `max_sum` (1) | buy NO on every leg (pays ≥ n − `max_sum`) |
| `exclusive_sum` + `exhaustive: true` | exactly one outcome wins | Σ P = 1 | also: Σ YES < 1 ⇒ buy YES on every leg (pays 1) |

Exhaustiveness is never assumed (an "Other" outcome, a tie or a void breaks it): set `exhaustive` only when the
rules guarantee a single winner. The gap is payoff − Σ (best ask + taker fee at the ask) over the legs, i.e. at
executable prices with the fee on every leg (R125); a basket trades only when the gap ≥ `min_gap` (0.03). One
basket at a time: every leg rests post-only one tick inside its ask, sized by `max_pair_usd` (20), the risk budget
and `max_unhedged_usd` (10: the cost of all legs but the cheapest, i.e. what can fill without its hedge). If some
legs fill and others do not within `hedge_timeout_minutes` (15), the missing legs are bought marketable up to
their ask at opening + `max_slippage` (0.02), and only while the hedged basket still costs no more than it pays.
Otherwise the basket is **unhedged**: no new baskets, and with `flatten_unhedged` (default) the bot sells its own
excess at best bid − `max_slippage` (an ordinary sell: hold time applies, never a risk exit). After
`idle_days` (7) without a gap it retires itself.

**Resolution Rule** (`templates/resolution-rule.ts`, spec §9.4) — one market where the rules favour an outcome.
Config: `token_id`, `target_entry_price`, `max_size_usd`, `thesis` (≤ 2000 chars, shown on the bot page), optional
`forecast_id`, `invalidate_on_rules_change` (true), `max_ambiguity` (1), `invalidate_before_end_minutes` (120),
`requote_minutes` (5). It rests post-only GTD bids one tick over the best other bid, never above the target, until
it holds `max_size_usd` of cost, holds to resolution and **never sells**. It stops buying for good (cancels its
bids) on a rules change since it first started, a UMA dispute, ambiguity above `max_ambiguity`, the linked
forecast withdrawn or below the target, an exit flag on its position, or the end approaching; the Position Manager
handles any exit, and the bot retires itself once flat or when the market closes.

### Copy Trading v2 (5c, optional)

`templates/copy-trading.ts` (spec §9.5) follows a few Polymarket wallets ("leaders", config `leaders`). It is a
builtin strategy template with trust `new` (paper first); the agent may create copy bots only when
`mandate.strategies.allow` contains `copy` (off by default). Upgrading replaced the v1 template in place, so existing
copy bots went back to paper and keep their config (`traders` / `baseMultiplier` / `maxOrderSizeUsd` are still read).
Without `copy` in `strategies.allow` a copy bot (human or agent) buys nothing; it still mirrors leader sells.

| v1 behaviour | v2 |
|---|---|
| sold a USD amount as tokens | sells mirror the leader's sold **fraction** of their position, capped at our holdings net of open sells |
| market (FOK) orders | limit at leader fill + `max_chase` (0.01), GTD `ttl_minutes` (10, ≥ 3); skipped when the best ask is already above it; sells rest at fill − `max_chase` |
| de-dup by timestamp, 20 rows | de-dup by transaction hash + log index (in `ctx.storage`), activity paginated until the last seen trade, `TRADE` rows only, oldest first; the first poll copies no backlog |
| small-trade boost, own daily cap | size = `copy_fraction` (0.1) × leader USD or `fixed_usd`, capped by `max_order_usd` (25) and the risk budget (allocation, market room) |
| no leader filtering | buys skipped below `min_leader_trade_usd` (10), above `max_leader_trades_per_day` (40), or within `mm_window_minutes` (30) of an opposite trade by the leader in the same market (market making) |
| any market | buys only in markets passing the mandate (category, 24h volume ≥ `min_liquidity_usd`, horizon, **assessed** ambiguity; `ctx.risk.getMandateSummary`), no dispute / recent rules change, outside the Position Manager's exit window, no exit flag, not sold by the Position Manager in the last `pm_cooldown_days` (7) |

**Leader scoring** (`copy_leaders`, `copy_trades`): every order a copy bot places carries the leader it copies, so
each fill is attributed. A *copied trade* is a round trip in one token attributed to one leader (opened by a copied
buy, closed when that leader's lot is sold — by copied sells, Position Manager exits or the resolution close); P&L
includes fees. The bot page's **Leaders** panel (and MCP `get_copy_leaders`) shows per leader: status, orders copied,
closed / open trades, hit rate, realised and unrealised P&L (at the market cache's last price) and the auto-drop
window. A leader whose **last 20 closed copied trades** (since it became active) have **net P&L < 0 and a hit rate
under 50 %** is dropped automatically (audited `copy.leader_dropped`, Telegram): the bot no longer copies its buys
(its sells are still mirrored to unwind). Only a human re-activates it (Leaders panel), which starts a new window.
Leader changes in the config apply at the bot's next start. The daily digest lists every leader.

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
npm run cli -- <cmd>   # migrate-key | gen-key | set-password | token create/list/revoke | check-polymarket
npm run gen:sdk        # regenerate botlab-sdk.d.ts (packages/core/src/sdk/sdkDts.generated.ts) after editing sdk/types.ts
npm run mcp:stdio      # MCP stdio proxy (BOTLAB_URL, BOTLAB_AGENT_TOKEN); mcp:stdio:dev runs it from source
```

```
packages/core/src/      all domain logic, no transport code (createCore, services, db, risk, orders,
                        runtime, ledger, reconcile, recorder, exchange, security, ops/backup)
apps/server/src/        Hono HTTP API, auth, SSE, /healthz, static UI, CLI, entrypoint; mcp/ (MCP tools,
                        resources, /mcp transport) and mcp-stdio.ts (stdio proxy)
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
