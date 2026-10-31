import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

let db: Database.Database | null = null;
let dbFilePath: string | null = null;

/**
 * Default database file path when the caller passes none: `<BOTLAB_DATA_DIR>/botlab.db`, else
 * `<cwd>/data/botlab.db`. The app passes an explicit path (`createCore({ dataDir })`).
 */
function getDbPath(): string {
  const dataDir = process.env.BOTLAB_DATA_DIR || path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, 'botlab.db');
}

/** Directory holding the database (and the shutdown marker). */
export function getDataDir(): string {
  return path.dirname(dbFilePath && dbFilePath !== ':memory:' ? dbFilePath : getDbPath());
}

/** SHA-256 of a script's source (scripts.source_hash). */
export function sourceHash(source: string): string {
  return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
}

/** Give pre-1c scripts a source hash and a version-1 row in script_versions. */
function backfillScriptVersions(database: Database.Database): void {
  const rows = database
    .prepare('SELECT id, source, compiled, revision, origin, created_at FROM scripts WHERE source_hash IS NULL')
    .all() as Array<{ id: string; source: string; compiled: string | null; revision: number; origin: string; created_at: string }>;
  if (rows.length === 0) return;
  const setHash = database.prepare('UPDATE scripts SET source_hash = ? WHERE id = ?');
  const addVersion = database.prepare(
    `INSERT OR IGNORE INTO script_versions (id, script_id, version, source, compiled, source_hash, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  database.transaction(() => {
    for (const r of rows) {
      const hash = sourceHash(r.source);
      setHash.run(hash, r.id);
      addVersion.run(uuidv4(), r.id, r.revision, r.source, r.compiled, hash, r.created_at, r.origin === 'builtin' ? 'system' : 'human');
    }
  })();
}

/**
 * One order row per exchange order (2b review): partial unique index on (exchange, exchange_order_id).
 * Existing duplicates are never rewritten; if any exist the index is not created and the conflict is
 * logged (the application-level check still refuses to link an id another row holds).
 */
function ensureUniqueExchangeOrderIds(database: Database.Database): void {
  const dups = database
    .prepare(
      `SELECT exchange, exchange_order_id, COUNT(*) AS n FROM orders WHERE exchange_order_id IS NOT NULL
       GROUP BY exchange, exchange_order_id HAVING COUNT(*) > 1`
    )
    .all() as Array<{ exchange: string; exchange_order_id: string; n: number }>;
  if (dups.length > 0) {
    console.error(
      `[Database] ${dups.length} exchange order id(s) are shared by several order rows (${dups
        .slice(0, 5)
        .map((d) => `${d.exchange}:${d.exchange_order_id}×${d.n}`)
        .join(', ')}); unique index not created — fix these rows by hand`
    );
    return;
  }
  database.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_exchange_order_unique ON orders(exchange, exchange_order_id) WHERE exchange_order_id IS NOT NULL'
  );
}

/**
 * Schema SQL - inlined to avoid file path issues with compiled output.
 */
const SCHEMA_SQL = `
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  proxy_address TEXT COLLATE NOCASE,
  private_key_encrypted TEXT NOT NULL,
  current_bot_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address);
CREATE INDEX IF NOT EXISTS idx_wallets_current_bot ON wallets(current_bot_id);

CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0.0',
  author TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  compiled TEXT,
  config_schema TEXT NOT NULL DEFAULT '{}',
  is_template INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, version)
);

CREATE INDEX IF NOT EXISTS idx_scripts_template ON scripts(is_template);

CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  script_id TEXT NOT NULL REFERENCES scripts(id),
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'stopped' CHECK(status IN ('stopped','starting','running','stopping','error')),
  enabled INTEGER NOT NULL DEFAULT 1,
  last_started_at TEXT,
  last_stopped_at TEXT,
  last_heartbeat TEXT,
  error_logs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bots_script ON bots(script_id);
CREATE INDEX IF NOT EXISTS idx_bots_wallet ON bots(wallet_id);
CREATE INDEX IF NOT EXISTS idx_bots_status ON bots(status);

CREATE TABLE IF NOT EXISTS bot_trades (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  bot_name TEXT,
  script_name TEXT,
  trader_address TEXT,
  trader_name TEXT,
  market TEXT,
  market_slug TEXT,
  condition_id TEXT,
  outcome TEXT,
  side TEXT CHECK(side IN ('BUY','SELL')),
  trader_bet_size REAL,
  bot_bet_size REAL,
  trader_win_rate REAL,
  trader_sample_size INTEGER,
  kelly_fraction REAL,
  kelly_edge REAL,
  kelly_percentage REAL,
  sizing_reason TEXT,
  current_position_value REAL,
  max_position_size REAL,
  executed_at TEXT NOT NULL DEFAULT (datetime('now')),
  trader_trade_timestamp INTEGER,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trades_bot ON bot_trades(bot_id, executed_at);
CREATE INDEX IF NOT EXISTS idx_trades_executed ON bot_trades(executed_at);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY DEFAULT 'global',
  rpc_url TEXT NOT NULL DEFAULT 'https://polygon-rpc.com',
  clob_http_url TEXT NOT NULL DEFAULT 'https://clob.polymarket.com',
  clob_ws_url TEXT NOT NULL DEFAULT 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  usdc_contract_address TEXT NOT NULL DEFAULT '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  alchemy_api_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (id) VALUES ('global');

CREATE TABLE IF NOT EXISTS bot_storage (
  bot_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bot_id, key)
);

CREATE INDEX IF NOT EXISTS idx_storage_bot ON bot_storage(bot_id);
`;

/**
 * Initialize the SQLite database.
 * Creates tables if they don't exist and enables WAL mode.
 */
/** Same database file? (':memory:' compares equal to itself, as before) */
function samePath(a: string, b: string): boolean {
  if (a === ':memory:' || b === ':memory:') return a === b;
  return path.resolve(a) === path.resolve(b);
}

/**
 * Open the process's database (one per process). Calling it again with the same path (or none)
 * returns the open handle; a different path while one is open throws instead of silently handing
 * back the other database.
 */
export function initializeDatabase(dbPath?: string): Database.Database {
  if (db) {
    if (dbPath && dbFilePath && !samePath(dbPath, dbFilePath)) {
      throw new Error(`Another database is already open in this process (${dbFilePath}); close it before opening ${dbPath}`);
    }
    return db;
  }

  const resolvedPath = dbPath || getDbPath();
  dbFilePath = resolvedPath;
  console.log(`[Database] Initializing SQLite at: ${resolvedPath}`);

  db = new Database(resolvedPath);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run schema
  db.exec(SCHEMA_SQL);

  // Migrations — add columns safely for existing databases
  const migrations = [
    'ALTER TABLE settings ADD COLUMN password_hash TEXT',
    'ALTER TABLE settings ADD COLUMN password_salt TEXT',
    'ALTER TABLE settings ADD COLUMN password_skipped INTEGER DEFAULT 0',
    "ALTER TABLE bots ADD COLUMN mode TEXT DEFAULT 'live'",
    'ALTER TABLE bot_trades ADD COLUMN simulated INTEGER DEFAULT 0',
    'ALTER TABLE wallets ADD COLUMN is_paper INTEGER DEFAULT 0',
    'ALTER TABLE settings ADD COLUMN binance_api_key_encrypted TEXT',
    'ALTER TABLE settings ADD COLUMN binance_api_secret_encrypted TEXT',
    // Trade recording columns for auto-recorded trades
    'ALTER TABLE bot_trades ADD COLUMN exchange TEXT',
    'ALTER TABLE bot_trades ADD COLUMN symbol TEXT',
    'ALTER TABLE bot_trades ADD COLUMN price REAL',
    'ALTER TABLE bot_trades ADD COLUMN quantity REAL',
    'ALTER TABLE bot_trades ADD COLUMN quote_amount REAL',
    // Backtesting tables
    `CREATE TABLE IF NOT EXISTS backtest_runs (
      id TEXT PRIMARY KEY,
      script_id TEXT NOT NULL,
      script_name TEXT,
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL DEFAULT '1m',
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      initial_balance REAL NOT NULL,
      final_balance REAL,
      total_trades INTEGER DEFAULT 0,
      win_trades INTEGER DEFAULT 0,
      lose_trades INTEGER DEFAULT 0,
      total_pnl REAL,
      max_drawdown REAL,
      sharpe_ratio REAL,
      config TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS backtest_trades (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
      side TEXT NOT NULL,
      symbol TEXT NOT NULL,
      price REAL NOT NULL,
      quantity REAL NOT NULL,
      quote_amount REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      balance_after REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_backtest_trades_run ON backtest_trades(run_id, timestamp)',
    `CREATE TABLE IF NOT EXISTS kline_cache (
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      open_time INTEGER NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume REAL,
      close_time INTEGER,
      PRIMARY KEY (symbol, interval, open_time)
    )`,
    // v3 bot ramp + scoping (spec §2.1). Existing bots are treated as stage=full, created by a human.
    "ALTER TABLE bots ADD COLUMN stage TEXT NOT NULL DEFAULT 'full' CHECK(stage IN ('paper','probation','full','retired'))",
    'ALTER TABLE bots ADD COLUMN allocation_usd REAL',
    "ALTER TABLE bots ADD COLUMN created_by TEXT NOT NULL DEFAULT 'human' CHECK(created_by IN ('human','agent'))",
    'ALTER TABLE bots ADD COLUMN market_ids TEXT',
    'ALTER TABLE bots ADD COLUMN strategy TEXT',
    'ALTER TABLE bots ADD COLUMN paused_by TEXT',
    'ALTER TABLE bots ADD COLUMN retire_reason TEXT',
    // Every order attempt, including risk rejections (spec §2.2)
    `CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      exchange TEXT NOT NULL CHECK(exchange IN ('polymarket','binance')),
      market_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('buy','sell')),
      order_type TEXT NOT NULL CHECK(order_type IN ('limit','market')),
      price REAL NOT NULL,
      size REAL NOT NULL,
      notional_usd REAL NOT NULL,
      expires_at TEXT,
      status TEXT NOT NULL CHECK(status IN ('rejected_risk','submitted','open','partially_filled','filled','cancelled','expired','failed')),
      risk_decision TEXT,
      exchange_order_id TEXT,
      filled_size REAL NOT NULL DEFAULT 0,
      avg_fill_price REAL,
      fee_usd REAL NOT NULL DEFAULT 0,
      reason TEXT,
      forecast_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_orders_bot_created ON orders(bot_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)',
    'CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market_id)',
    'CREATE INDEX IF NOT EXISTS idx_orders_exchange_order ON orders(exchange_order_id)',
    // Halts and daily P&L: one 'global' row plus one row per bot (spec §2.2)
    `CREATE TABLE IF NOT EXISTS risk_state (
      scope TEXT PRIMARY KEY,
      halted INTEGER NOT NULL DEFAULT 0,
      halted_reason TEXT,
      halted_at TEXT,
      day_start_equity REAL,
      day_realized_pnl REAL NOT NULL DEFAULT 0,
      day_unrealized_pnl REAL NOT NULL DEFAULT 0,
      orders_last_hour INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`,
    "INSERT OR IGNORE INTO risk_state (scope) VALUES ('global')",
    // Chunk 1b: paper orders go through the risk engine too and are stored with simulated = 1
    'ALTER TABLE orders ADD COLUMN simulated INTEGER NOT NULL DEFAULT 0',
    // Link fills to the order that produced them (spec §2.1). Only trades with an order_id
    // (written by OrderService) count toward risk exposure and positions.
    'ALTER TABLE bot_trades ADD COLUMN order_id TEXT',
    'ALTER TABLE bot_trades ADD COLUMN fee_usd REAL',
    'ALTER TABLE bot_trades ADD COLUMN category TEXT',
    'CREATE INDEX IF NOT EXISTS idx_trades_order ON bot_trades(order_id)',
    // Chunk 1c: append-only audit log (spec §2.2). Triggers make UPDATE/DELETE fail for any caller.
    `CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      payload TEXT,
      result TEXT
    )`,
    'CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)',
    'CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target, ts)',
    `CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
     BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`,
    `CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
     BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`,
    // Chunk 1c: daily P&L state. Marks are JSON maps "exchange:symbol" → price (global row only).
    'ALTER TABLE risk_state ADD COLUMN day_start TEXT',
    'ALTER TABLE risk_state ADD COLUMN day_start_marks TEXT',
    'ALTER TABLE risk_state ADD COLUMN last_marks TEXT',
    'ALTER TABLE risk_state ADD COLUMN last_halted_at TEXT',
    // Probation drawdown tracking (per bot): peak cumulative live P&L and worst drop from it since ramp_since
    'ALTER TABLE risk_state ADD COLUMN ramp_since TEXT',
    'ALTER TABLE risk_state ADD COLUMN ramp_pnl_peak REAL',
    'ALTER TABLE risk_state ADD COLUMN ramp_max_drawdown_usd REAL',
    // Chunk 1c: ramp (spec §2.1, §4.5). scripts.version is the legacy semver text, so the
    // integer source version is `revision`.
    "ALTER TABLE scripts ADD COLUMN kind TEXT NOT NULL DEFAULT 'custom' CHECK(kind IN ('template','custom'))",
    "ALTER TABLE scripts ADD COLUMN origin TEXT NOT NULL DEFAULT 'human' CHECK(origin IN ('builtin','human','agent'))",
    'ALTER TABLE scripts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
    "ALTER TABLE scripts ADD COLUMN trust TEXT NOT NULL DEFAULT 'new' CHECK(trust IN ('new','proven'))",
    'ALTER TABLE scripts ADD COLUMN source_hash TEXT',
    `CREATE TABLE IF NOT EXISTS script_versions (
      id TEXT PRIMARY KEY,
      script_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      source TEXT NOT NULL,
      compiled TEXT,
      source_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      UNIQUE(script_id, version)
    )`,
    'ALTER TABLE bots ADD COLUMN template_version INTEGER',
    'ALTER TABLE bots ADD COLUMN stage_changed_at TEXT',
    'ALTER TABLE bots ADD COLUMN last_error_at TEXT',
    'ALTER TABLE bots ADD COLUMN reached_full_at TEXT',
    // 1c review: per-mode daily P&L, loss baseline set when a human clears a halt, run days for the ramp
    'ALTER TABLE risk_state ADD COLUMN day_live_pnl REAL',
    'ALTER TABLE risk_state ADD COLUMN day_paper_pnl REAL',
    'ALTER TABLE risk_state ADD COLUMN loss_baseline TEXT',
    `CREATE TABLE IF NOT EXISTS bot_run_days (
      bot_id TEXT NOT NULL,
      day TEXT NOT NULL,
      PRIMARY KEY (bot_id, day)
    )`,
    // Chunk 2a: market metadata cache (spec §2.2). rules_hash change ⇒ rules_changed_at.
    // market_ambiguity is the assessed score (agent forecast or human); the server raises it at read time (§7.4).
    `CREATE TABLE IF NOT EXISTS market_cache (
      market_id TEXT PRIMARY KEY,
      event_id TEXT,
      event_title TEXT,
      slug TEXT,
      question TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'other',
      tags TEXT NOT NULL DEFAULT '[]',
      rules_text TEXT,
      rules_hash TEXT,
      rules_changed_at TEXT,
      end_date TEXT,
      resolution_source TEXT,
      neg_risk INTEGER NOT NULL DEFAULT 0,
      tokens TEXT NOT NULL DEFAULT '[]',
      fee_category TEXT,
      liquidity_usd REAL,
      volume_24h_usd REAL,
      active INTEGER NOT NULL DEFAULT 1,
      closed INTEGER NOT NULL DEFAULT 0,
      outcome_prices TEXT,
      uma_resolution_status TEXT,
      disputed INTEGER NOT NULL DEFAULT 0,
      market_ambiguity INTEGER CHECK(market_ambiguity IS NULL OR market_ambiguity BETWEEN 0 AND 3),
      ambiguity_source TEXT,
      ambiguity_note TEXT,
      ambiguity_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_market_cache_event ON market_cache(event_id)',
    // Forecast ledger (spec §2.2, §6). At most one active forecast per token.
    `CREATE TABLE IF NOT EXISTS forecasts (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      category TEXT NOT NULL,
      probability REAL NOT NULL CHECK(probability >= 0.01 AND probability <= 0.99),
      market_price_at_forecast REAL NOT NULL,
      best_bid REAL,
      best_ask REAL,
      liquidity_usd REAL,
      rationale TEXT NOT NULL,
      sources TEXT NOT NULL DEFAULT '[]',
      ambiguity_score INTEGER NOT NULL CHECK(ambiguity_score BETWEEN 0 AND 3),
      status TEXT NOT NULL CHECK(status IN ('active','superseded','withdrawn','resolved','void')),
      superseded_by TEXT,
      tradeable INTEGER NOT NULL DEFAULT 0,
      days_to_resolution_at_forecast REAL NOT NULL,
      horizon_bucket TEXT NOT NULL CHECK(horizon_bucket IN ('short','medium','long')),
      price_at_7d REAL,
      price_at_7d_at TEXT,
      convergence REAL,
      created_by TEXT NOT NULL,
      withdrawn_at TEXT,
      withdrawn_reason TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      outcome INTEGER CHECK(outcome IS NULL OR outcome IN (0,1)),
      brier_agent REAL,
      brier_market REAL,
      skill REAL
    )`,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_forecasts_active_token ON forecasts(token_id) WHERE status = 'active'",
    'CREATE INDEX IF NOT EXISTS idx_forecasts_market ON forecasts(market_id)',
    'CREATE INDEX IF NOT EXISTS idx_forecasts_bucket ON forecasts(category, horizon_bucket)',
    // Category rights per (category, horizon bucket) (spec §6.3)
    `CREATE TABLE IF NOT EXISTS category_rights (
      category TEXT NOT NULL,
      horizon_bucket TEXT NOT NULL CHECK(horizon_bucket IN ('short','medium','long')),
      state TEXT NOT NULL DEFAULT 'shadow' CHECK(state IN ('shadow','trading','suspended','deprioritised')),
      n_scored INTEGER NOT NULL DEFAULT 0,
      skill_mean REAL,
      skill_lower_bound REAL,
      n_convergence INTEGER NOT NULL DEFAULT 0,
      convergence_mean REAL,
      convergence_lower_bound REAL,
      max_allocation_usd REAL NOT NULL DEFAULT 0,
      qualified_n INTEGER,
      forced INTEGER NOT NULL DEFAULT 0,
      last_evaluated_at TEXT,
      changed_at TEXT NOT NULL,
      changed_reason TEXT,
      PRIMARY KEY (category, horizon_bucket)
    )`,
    // 2a review: when a forecast version stopped being active (superseded / withdrawn / resolved) — weights
    // versions in the stats; first time the scorer saw a final resolution (scored only once confirmed)
    'ALTER TABLE forecasts ADD COLUMN active_until TEXT',
    'ALTER TABLE market_cache ADD COLUMN resolution_seen_at TEXT',
    'ALTER TABLE market_cache ADD COLUMN resolution_seen TEXT',
    // Chunk 2b: reconciler freshness (/healthz later) and non-order fills. fill_source: NULL = an OrderService
    // fill; 'adopted' = pre-existing exchange position adopted by a human (reconcile:adoptPositions);
    // 'resolution' = position closed at the payout of a resolved market. Both carry a synthetic order_id
    // ('adopt:…' / 'resolve:…') so they count as order-linked positions (R8).
    'ALTER TABLE risk_state ADD COLUMN reconciled_at TEXT',
    'ALTER TABLE bot_trades ADD COLUMN fill_source TEXT',
    // Order-book recorder (spec §2.2, §10). ts = ms since epoch; bids/asks = zlib-deflated JSON [[price, size], …] (top 10)
    `CREATE TABLE IF NOT EXISTS orderbook_snapshots (
      token_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      best_bid REAL,
      best_ask REAL,
      mid REAL,
      bids BLOB NOT NULL,
      asks BLOB NOT NULL,
      last_trade_price REAL,
      PRIMARY KEY (token_id, ts)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_orderbook_snapshots_ts ON orderbook_snapshots(ts)',
    `CREATE TABLE IF NOT EXISTS recorder_watchlist (
      token_id TEXT PRIMARY KEY,
      market_id TEXT,
      note TEXT,
      added_by TEXT NOT NULL,
      added_at TEXT NOT NULL
    )`,
    // 2b review: the wallet an order / fill belongs to, fixed at creation (a bot can change wallets later).
    // Pre-2b rows are backfilled below with their bot's current wallet.
    'ALTER TABLE orders ADD COLUMN wallet_id TEXT',
    'ALTER TABLE bot_trades ADD COLUMN wallet_id TEXT',
    'CREATE INDEX IF NOT EXISTS idx_orders_wallet ON orders(wallet_id)',
    // Recorder bookkeeping (last downsample cutoff)
    `CREATE TABLE IF NOT EXISTS recorder_state (
      key TEXT PRIMARY KEY,
      value TEXT
    )`,
    // 3b: the in-app AI assistant is removed (spec §12) with its settings
    'ALTER TABLE settings DROP COLUMN claude_api_key_encrypted',
    'ALTER TABLE settings DROP COLUMN ai_custom_system_prompt',
    // 3b: server auth (spec §8.2) and master-key check (§8.3)
    'ALTER TABLE settings ADD COLUMN admin_password_hash TEXT',
    'ALTER TABLE settings ADD COLUMN key_check TEXT',
    // 3b review: one-time first-run setup code (SHA-256), printed to the server log
    'ALTER TABLE settings ADD COLUMN setup_code_hash TEXT',
    `CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      auth_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      user_agent TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('agent','readonly')),
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    )`,
    // Mac test round: each market's own Gamma fee schedule (JSON; PROGRESS R125)
    'ALTER TABLE market_cache ADD COLUMN fee_schedule TEXT',
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // 2b review: wallet of pre-existing orders / fills = their bot's wallet (idempotent)
  db.exec(`UPDATE orders SET wallet_id = (SELECT wallet_id FROM bots WHERE bots.id = orders.bot_id) WHERE wallet_id IS NULL`);
  db.exec(`UPDATE bot_trades SET wallet_id = (SELECT wallet_id FROM bots WHERE bots.id = bot_trades.bot_id) WHERE wallet_id IS NULL`);
  ensureUniqueExchangeOrderIds(db);

  // Built-in templates (pre-1c rows) are proven builtin templates; idempotent.
  db.exec("UPDATE scripts SET kind = 'template', origin = 'builtin', trust = 'proven' WHERE is_template = 1 AND origin <> 'builtin'");
  backfillScriptVersions(db);

  console.log('[Database] Schema initialized successfully');

  return db;
}

/**
 * Get the current database instance.
 * Throws if not initialized.
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

/**
 * Close the database connection (the process's open one, or only `handle` if given).
 */
export function closeDatabase(handle?: Database.Database): void {
  // With a handle: close only that one (a core never closes a database it did not open)
  if (handle && handle !== db) {
    if (handle.open) handle.close();
    return;
  }
  if (db) {
    db.close();
    db = null;
    console.log('[Database] Connection closed');
  }
}

/**
 * Generate a new unique ID for database records.
 */
export function generateId(): string {
  return uuidv4();
}

export { Database };
