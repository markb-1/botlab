-- Polymarket Bot Desktop App - SQLite Schema
-- Version 1.0.0

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- Wallets: Stores encrypted private keys and wallet metadata
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

-- Scripts: Bot script source code and metadata
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

-- Bots: Running bot instances linked to a script and wallet
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

-- Bot trades: Historical trade records
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

-- Settings: Global application settings (singleton)
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

-- Insert default settings if not exists
INSERT OR IGNORE INTO settings (id) VALUES ('global');

-- Bot storage: Per-bot key-value store for script state persistence
CREATE TABLE IF NOT EXISTS bot_storage (
  bot_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bot_id, key)
);

CREATE INDEX IF NOT EXISTS idx_storage_bot ON bot_storage(bot_id);
