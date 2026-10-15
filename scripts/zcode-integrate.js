'use strict';
/**
 * Wire modelwharf into ZCode as a custom OpenAI-compatible provider.
 *
 * Writes two ZCode config files (with .bak backups, merge-not-overwrite):
 *   ~/.zcode/v2/config.json            provider entry: name/kind/options/models
 *   ~/.zcode/v2/provider_config.json   providerOrder + personalModelIds/modelOrder
 *
 * Usage: node scripts/zcode-integrate.js [--key wh-xxx] [--base http://localhost:8317]
 * Key defaults to the first enabled key in the gateway DB (creates one if none).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3-multiple-ciphers');

const ROOT = path.join(__dirname, '..');

// 数据库文件：优先新名 wharf.db，兼容旧名 dsh.db（与 src/config.js 同规则）
function dbFile() {
  const fresh = path.join(ROOT, 'data', 'wharf.db');
  const legacy = path.join(ROOT, 'data', 'dsh.db');
  return fs.existsSync(fresh) || !fs.existsSync(legacy) ? fresh : legacy;
}
const ZCODE_DIR = path.join(os.homedir(), '.zcode', 'v2');
const PROVIDER_ID = 'modelwharf';
const LEGACY_PROVIDER_ID = 'new-provider-dsh'; // 前身 dsh-free-api 写入的旧条目，重跑时清理

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
  db.prepare('INSERT INTO apikeys(key,name,allowed_models) VALUES(?,?,?)').run(apiKey, 'zcode', '*');
  db.close();
  console.log(`[zcode-integrate] no key existed — created gateway key "zcode": ${apiKey.slice(0, 12)}...`);
}

// --- which models does the gateway actually serve right now ---
const gdb = new Database(dbFile(), { readonly: true });
const virtuals = gdb.prepare('SELECT public_name FROM virtual_models WHERE enabled=1 ORDER BY public_name').all();
const regulars = gdb.prepare(`
  SELECT m.public_name, MAX(m.ctx_window) ctx, MAX(m.multiplier) mult FROM models m
  WHERE m.enabled=1 AND EXISTS (SELECT 1 FROM accounts a WHERE a.provider_id=m.provider_id AND a.enabled=1 AND a.status!='invalid')
  GROUP BY m.public_name ORDER BY m.public_name`).all();
gdb.close();

// Prefer virtual (统一模型) models for ZCode — they fail over across platforms.
const modelIds = virtuals.length ? virtuals.map(v => v.public_name) : regulars.map(r => r.public_name);
const ctxOf = {};
for (const r of regulars) ctxOf[r.public_name] = r.ctx || 200000;
console.log(`[zcode-integrate] exposing ${modelIds.length} model(s) to ZCode: ${modelIds.slice(0, 8).join(', ')}${modelIds.length > 8 ? ' …' : ''}`);

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

if (!fs.existsSync(ZCODE_DIR)) {
  console.error(`[zcode-integrate] ZCode config dir not found: ${ZCODE_DIR} — is ZCode installed?`);
  process.exit(1);
}

// --- 1) config.json: provider entry ---
const cfgPath = path.join(ZCODE_DIR, 'config.json');
const cfgBak = backup(cfgPath);
const cfg = readJsonSafe(cfgPath) || { provider: {} };
cfg.provider = cfg.provider || {};
delete cfg.provider[LEGACY_PROVIDER_ID]; // 清掉旧名条目，避免重复
cfg.provider[PROVIDER_ID] = {
  name: 'modelwharf',
  kind: 'openai-compatible',
  options: { apiKey, baseURL: BASE + '/v1', apiKeyRequired: true },
  source: 'custom',
  enabled: true,
  models: Object.fromEntries(modelIds.map(id => [id, {
    limit: { context: ctxOf[id] || 200000, output: 32000 },
    modalities: { input: ['text'], output: ['text'] },
  }])),
};
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log(`[zcode-integrate] ${cfgPath} updated${cfgBak ? ` (backup: ${path.basename(cfgBak)})` : ''}`);

// --- 2) provider_config.json: ordering + personal model list ---
const pcPath = path.join(ZCODE_DIR, 'provider_config.json');
const pcBak = backup(pcPath);
const pc = readJsonSafe(pcPath) || { schemaVersion: 1, config: {} };
pc.config = pc.config || {};
pc.config.providerOrder = [...(pc.config.providerOrder || []).filter(id => id !== PROVIDER_ID && id !== LEGACY_PROVIDER_ID), PROVIDER_ID];
pc.config.providerConfigRules = pc.config.providerConfigRules || {};
pc.config.providerConfigRules.providerRules = (pc.config.providerConfigRules.providerRules || []).filter(r => r.providerId !== PROVIDER_ID && r.providerId !== LEGACY_PROVIDER_ID);
pc.config.providerConfigRules.providerRules.push({
  providerId: PROVIDER_ID,
  providerName: 'modelwharf',
  enabled: true,
  config: {
    group: 'standard-personal',
    access: { type: 'api-key', apiKey },
    api: { type: 'openai-chat-completions', baseUrl: BASE + '/v1' },
    personalModelIds: modelIds,
    modelOrder: modelIds,
  },
});
// per-model rules (context window) so ZCode sizes prompts correctly
pc.config.modelConfigRules = pc.config.modelConfigRules || {};
pc.config.modelConfigRules.providerModelRules = (pc.config.modelConfigRules.providerModelRules || []).filter(r => r.providerId !== PROVIDER_ID && r.providerId !== LEGACY_PROVIDER_ID);
for (const id of modelIds) {
  pc.config.modelConfigRules.providerModelRules.push({
    modelId: id,
    providerId: PROVIDER_ID,
    config: { enabled: true, properties: { contextWindow: ctxOf[id] || 200000 } },
  });
}
fs.writeFileSync(pcPath, JSON.stringify(pc, null, 2));
console.log(`[zcode-integrate] ${pcPath} updated${pcBak ? ` (backup: ${path.basename(pcBak)})` : ''}`);

console.log(`
[zcode-integrate] Done. Restart ZCode, then pick provider "modelwharf" (统一模型: ${virtuals.length} 个).
Gateway: ${BASE}  ·  Admin: ${BASE}/admin  ·  Key: ${apiKey.slice(0, 12)}…`);
