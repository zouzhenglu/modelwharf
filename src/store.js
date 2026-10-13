'use strict';
/**
 * SQLite storage layer. All persistent state lives here:
 *  - providers: platform plugins registered in the engine
 *  - accounts:  upstream platform accounts (one row per login/credential)
 *  - models:    model entries exposed by the gateway (per account allow/deny + alias + multiplier)
 *  - apikeys:   keys that harness clients use to authenticate to this gateway
 *  - usage:     per-request usage log (tokens, credits, latency, status)
 *  - settings:  key-value app settings
 */
const Database = require('better-sqlite3-multiple-ciphers');
const config = require('./config');

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,            -- e.g. 'trae', 'qoder'
  enabled INTEGER DEFAULT 1,
  config TEXT DEFAULT '{}',       -- provider-level config JSON (endpoints override etc.)
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,             -- display name
  credentials TEXT NOT NULL,      -- JSON: token(s)/cookies, opaque to core
  enabled INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',   -- active | invalid | cooling | banned
  status_message TEXT,
  priority INTEGER DEFAULT 100,   -- lower = preferred when routing
  max_concurrency INTEGER DEFAULT 3,
  last_used_at INTEGER,
  last_check_at INTEGER,
  extra TEXT DEFAULT '{}',        -- JSON: cached profile info (plan, credits, email...)
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(provider_id, name)
);
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  upstream_model TEXT NOT NULL,   -- model id on the upstream platform
  public_name TEXT NOT NULL,      -- model id exposed to clients (globally unique)
  enabled INTEGER DEFAULT 1,
  multiplier REAL DEFAULT 1,      -- billing multiplier shown/used for accounting
  is_free INTEGER DEFAULT 0,      -- free flag from platform or manual
  ctx_window INTEGER,
  max_output INTEGER,
  tags TEXT DEFAULT '',           -- free text tags for filtering
  note TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(provider_id, public_name)
);
CREATE TABLE IF NOT EXISTS apikeys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  name TEXT,
  enabled INTEGER DEFAULT 1,
  allowed_models TEXT DEFAULT '*',  -- '*' or comma separated public model names
  rpm_limit INTEGER DEFAULT 0,      -- 0 = unlimited
  daily_limit INTEGER DEFAULT 0,    -- 0 = unlimited (credit units)
  used_today REAL DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER DEFAULT (unixepoch()),
  apikey_id INTEGER,
  provider_id TEXT,
  account_id INTEGER,
  public_model TEXT,
  upstream_model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  credits REAL DEFAULT 0,         -- estimated upstream credit consumption
  multiplier REAL DEFAULT 1,
  latency_ms INTEGER,
  status INTEGER,                 -- HTTP status returned to client
  error TEXT,
  source TEXT                     -- openai | anthropic | mcp | test
);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,            -- mcp server name exposed to clients
  enabled INTEGER DEFAULT 1,
  transport TEXT DEFAULT 'stdio', -- stdio | http
  command TEXT,                   -- for stdio
  args TEXT DEFAULT '[]',
  env TEXT DEFAULT '{}',
  url TEXT,                       -- for http (sse/streamable)
  headers TEXT DEFAULT '{}',
  tool_filter TEXT DEFAULT '*',   -- '*' or comma separated tool names
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS virtual_models (
  public_name TEXT PRIMARY KEY,   -- the name clients see (e.g. gpt-4o or glm-5.3)
  enabled INTEGER DEFAULT 1,
  targets TEXT NOT NULL,          -- JSON [{provider_id, public_name, priority}] priority ascending = tried first
  note TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(public_model);
CREATE INDEX IF NOT EXISTS idx_usage_apikey ON usage(apikey_id);
`);

const stmts = {
  getSetting: db.prepare('SELECT value FROM settings WHERE key=?'),
  setSetting: db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
  allSettings: db.prepare('SELECT key,value FROM settings'),
};

function getSetting(key, fallback = undefined) {
  const row = stmts.getSetting.get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function setSetting(key, value) {
  stmts.setSetting.run(key, JSON.stringify(value));
}

module.exports = { db, getSetting, setSetting };
