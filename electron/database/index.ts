import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

let db: Database.Database | null = null;

/**
 * Get the database file path.
 * In Electron, this uses app.getPath('userData').
 * Falls back to a local directory for development.
 */
function getDbPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'botlab.db');
  } catch {
    // Fallback for development without Electron
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    return path.join(dataDir, 'botlab.db');
  }
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
export function initializeDatabase(dbPath?: string): Database.Database {
  if (db) return db;

  const resolvedPath = dbPath || getDbPath();
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
    'ALTER TABLE settings ADD COLUMN claude_api_key_encrypted TEXT',
    'ALTER TABLE settings ADD COLUMN ai_custom_system_prompt TEXT',
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
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

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
 * Close the database connection.
 */
export function closeDatabase(): void {
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
