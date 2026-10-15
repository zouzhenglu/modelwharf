'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DSH_DATA_DIR || path.join(ROOT, 'data');
const LOG_DIR = process.env.DSH_LOG_DIR || path.join(ROOT, 'logs');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  logDir: LOG_DIR,
  dbPath: path.join(DATA_DIR, 'dsh.db'),
  port: parseInt(process.env.DSH_PORT || '8317', 10),
  host: process.env.DSH_HOST || '0.0.0.0',
  // Admin panel access password (web login). Default for local dev; change via env or admin UI.
  adminPassword: process.env.DSH_ADMIN_PASSWORD || 'admin',
  // Secret used to sign admin session cookies
  sessionSecret: process.env.DSH_SESSION_SECRET || 'dsh-' + Math.random().toString(36).slice(2),
  // API keys that harness tools use to call this proxy. Comma separated. If empty, gateway is open (LAN use).
  apiKeys: (process.env.DSH_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean),
  requestTimeoutMs: parseInt(process.env.DSH_REQUEST_TIMEOUT_MS || '300000', 10),
  logRetentionDays: parseInt(process.env.DSH_LOG_RETENTION_DAYS || '30', 10),
  version: '0.8.0',
};

module.exports = config;
