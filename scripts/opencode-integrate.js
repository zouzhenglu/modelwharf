'use strict';
/**
 * Wire modelwharf into opencode (https://opencode.ai) as a custom OpenAI-compatible provider.
 *
 * Merges (never overwrites) the global opencode config:
 *   ~/.config/opencode/opencode.json   provider entry: npm @ai-sdk/openai-compatible + models
 *
 * Usage: node scripts/opencode-integrate.js [--key wh-xxx] [--base http://localhost:8317]
 * Key defaults to the first enabled key in the gateway DB (creates one if none).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3-multiple-ciphers');

const ROOT = path.join(__dirname, '..');
const TAG = '[opencode-integrate]';

// 数据库文件：与 src/config.js 同规则 —— WH_DATA_DIR/DSH_DATA_DIR 优先，默认仓库 data/ 目录；
// 库名优先新名 wharf.db，兼容旧名 dsh.db
function dbFile() {
  const dataDir = process.env.WH_DATA_DIR || process.env.DSH_DATA_DIR || path.join(ROOT, 'data');
  const fresh = path.join(dataDir, 'wharf.db');
  const legacy = path.join(dataDir, 'dsh.db');
  return fs.existsSync(fresh) || !fs.existsSync(legacy) ? fresh : legacy;
}
// opencode 全局配置：XDG_CONFIG_HOME 优先，否则 ~/.config（opencode 跨平台统一用这个路径）
const OPENCODE_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
const OPENCODE_CFG = path.join(OPENCODE_DIR, 'opencode.json');
const PROVIDER_ID = 'modelwharf';
const LEGACY_PROVIDER_IDS = ['dsh-free-api', 'dsh']; // 前身仓库名可能写入的旧条目，重跑时清理

// --- args ---
const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const BASE = argOf('--base', 'http://localhost:8317');

// --- pick API key: --key > first enabled key in DB > create one ---
let apiKey = argOf('--key', null);
if (!apiKey) {
  const db = new Database(dbFile(), { readonly: true });
  const row = db.prepare('SELECT key FROM apikeys WHERE enabled=1 ORDER BY id LIMIT 1').get();
  apiKey = row?.key || null;
  db.close();
}
if (!apiKey) {
  const crypto = require('crypto');
  apiKey = 'wh-' + crypto.randomBytes(24).toString('hex');
  const db = new Database(dbFile());
  db.prepare('INSERT INTO apikeys(key,name,allowed_models) VALUES(?,?,?)').run(apiKey, 'opencode', '*');
  db.close();
  console.log(`${TAG} no key existed — created gateway key "opencode": ${apiKey.slice(0, 12)}...`);
}

// --- which models does the gateway actually serve right now ---
const gdb = new Database(dbFile(), { readonly: true });
const virtuals = gdb.prepare('SELECT public_name FROM virtual_models WHERE enabled=1 ORDER BY public_name').all();
const regulars = gdb.prepare(`
  SELECT m.public_name, MAX(m.ctx_window) ctx FROM models m
  WHERE m.enabled=1 AND EXISTS (SELECT 1 FROM accounts a WHERE a.provider_id=m.provider_id AND a.enabled=1 AND a.status!='invalid')
  GROUP BY m.public_name ORDER BY m.public_name`).all();
gdb.close();

// Prefer virtual (统一模型) models for opencode — they fail over across platforms.
const modelIds = virtuals.length ? virtuals.map(v => v.public_name) : regulars.map(r => r.public_name);
if (!modelIds.length) {
  console.error(`${TAG} gateway has no enabled models — import an account and sync models first.`);
  process.exit(1);
}
console.log(`${TAG} exposing ${modelIds.length} model(s) to opencode: ${modelIds.slice(0, 8).join(', ')}${modelIds.length > 8 ? ' …' : ''}`);

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function backup(file) {
  if (fs.existsSync(file)) {
    const bak = file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(file, bak);
    return bak;
  }
  return null;
}

fs.mkdirSync(OPENCODE_DIR, { recursive: true });

// --- merge (not overwrite) provider entry ---
const cfgBak = backup(OPENCODE_CFG);
const cfg = readJsonSafe(OPENCODE_CFG) || {};
cfg.$schema = cfg.$schema || 'https://opencode.ai/config.json';
cfg.provider = cfg.provider || {};
for (const legacy of LEGACY_PROVIDER_IDS) delete cfg.provider[legacy];
cfg.provider[PROVIDER_ID] = {
  npm: '@ai-sdk/openai-compatible',
  name: 'modelwharf',
  options: { baseURL: `${BASE}/v1`, apiKey },
  models: Object.fromEntries(modelIds.map(id => [id, { name: id }])),
};
// 默认模型只在新装时给，不覆盖用户已有选择
if (!cfg.model) cfg.model = `${PROVIDER_ID}/${modelIds[0]}`;
fs.writeFileSync(OPENCODE_CFG, JSON.stringify(cfg, null, 2));
console.log(`${TAG} ${OPENCODE_CFG} updated${cfgBak ? ` (backup: ${path.basename(cfgBak)})` : ''}`);

console.log(`
${TAG} Done. Run \`opencode\`, then switch model with Shift+Tab (default: ${PROVIDER_ID}/${modelIds[0]}).
Gateway: ${BASE}  ·  Admin: ${BASE}/admin  ·  Key: ${apiKey.slice(0, 12)}…`);
