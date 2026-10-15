'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.WH_DATA_DIR || process.env.DSH_DATA_DIR || path.join(ROOT, 'data');
const LOG_DIR = process.env.WH_LOG_DIR || process.env.DSH_LOG_DIR || path.join(ROOT, 'logs');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

// 环境变量读取：新前缀 WH_*，旧前缀 DSH_* 仍兼容（原名 dsh-free-api 时期）
const env = (...names) => {
  for (const n of names) { const v = process.env[n]; if (v !== undefined && v !== '') return v; }
  return undefined;
};

// 数据库：优先 wharf.db；已有旧版 dsh.db 且尚无新库时沿用旧库，避免升级丢数据
const dbPath = (() => {
  const fresh = path.join(DATA_DIR, 'wharf.db');
  const legacy = path.join(DATA_DIR, 'dsh.db');
  if (fs.existsSync(fresh) || !fs.existsSync(legacy)) return fresh;
  console.log('[modelwharf] 沿用旧版数据库 data/dsh.db（如需全新开始，删除该文件即可）');
  return legacy;
})();

const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  logDir: LOG_DIR,
  dbPath,
  port: parseInt(env('WH_PORT', 'DSH_PORT') || '8317', 10),
  host: env('WH_HOST', 'DSH_HOST') || '0.0.0.0',
  // Admin panel access password (web login). Default for local dev; change via env or admin UI.
  adminPassword: env('WH_ADMIN_PASSWORD', 'DSH_ADMIN_PASSWORD') || 'admin',
  // Secret used to sign admin session cookies
  sessionSecret: env('WH_SESSION_SECRET', 'DSH_SESSION_SECRET') || 'wharf-' + Math.random().toString(36).slice(2),
  // API keys that harness tools use to call this proxy. Comma separated. If empty, gateway is open (LAN use).
  apiKeys: (env('WH_API_KEYS', 'DSH_API_KEYS') || '').split(',').map(s => s.trim()).filter(Boolean),
  requestTimeoutMs: parseInt(env('WH_REQUEST_TIMEOUT_MS', 'DSH_REQUEST_TIMEOUT_MS') || '300000', 10),
  logRetentionDays: parseInt(env('WH_LOG_RETENTION_DAYS', 'DSH_LOG_RETENTION_DAYS') || '30', 10),
  version: '0.11.0',
};

module.exports = config;
