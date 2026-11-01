[← BotLab README](../../README.md)

# Install and run

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
