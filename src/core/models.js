'use strict';
/**
 * Model registry: merges per-account upstream models with the `models` table
 * (public alias, enable/disable, multiplier, free flag) and answers:
 *   - what public models exist (for GET /v1/models)
 *   - which account can serve a public model (routing)
 *   - mapping public -> upstream model name
 */
const { db } = require('../store');
const accounts = require('./accounts');

/**
 * Reset a provider's model list to its online catalog (恢复在线模型):
 * delete all existing rows for the provider, then insert exactly what the
 * upstream reports as available. Custom rows are removed by design.
 */
function resetProviderModelsToOnline(plugin, onlineModels) {
  const del = db.prepare('DELETE FROM models WHERE provider_id=?').run(plugin.id);
  const insert = db.prepare(`INSERT INTO models(provider_id, upstream_model, public_name, enabled, is_free, multiplier, ctx_window, max_output, tags, note)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  let added = 0;
  for (const m of onlineModels) {
    const upstream = m.upstream || m;
    const tagList = Array.isArray(m.tags) ? m.tags : (m.tags ? [m.tags] : []);
    if (m.vision || m.images) tagList.push('vision');
    insert.run(plugin.id, upstream, m.publicName || upstream, 1, m.free ? 1 : 0, m.multiplier ?? 1, m.ctx || null, m.maxOutput || null,
      tagList.join(',') || (m.online ? 'online' : ''), m.note || null);
    added++;
  }
  return { deleted: del.changes, added };
}

/**
 * Sync models reported by plugin.listModels(account) into the models table.
 * live=true: models came from the upstream API (insert normally).
 * live=false: fallback/static catalog — only insert when the provider has NO models yet,
 * so dead names never pollute a live-synced list.
 */
function syncProviderModels(plugin, account, upstreamModels, { live = true } = {}) {
  const autoDisable = (getProviderConfig(plugin.id).autoDisableNewModels) || false;
  if (!live) {
    const have = db.prepare('SELECT COUNT(*) c FROM models WHERE provider_id=?').get(plugin.id).c;
    if (have > 0) return 0;
  }
  const insert = db.prepare(`INSERT OR IGNORE INTO models(provider_id, upstream_model, public_name, enabled, is_free, multiplier, ctx_window, max_output, tags, note)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const updateRate = db.prepare('UPDATE models SET multiplier=?, is_free=?, ctx_window=COALESCE(?,ctx_window), max_output=COALESCE(?,max_output), tags=CASE WHEN ? != \'\' THEN ? ELSE tags END WHERE provider_id=? AND upstream_model=?');
  let added = 0;
  for (const m of upstreamModels) {
    const upstream = m.upstream || m;
    const free = m.free ? 1 : 0;
    const r = insert.run(plugin.id, upstream, m.publicName || upstream, autoDisable ? 0 : 1, free, m.multiplier ?? 1, m.ctx || null, m.maxOutput || null,
      (m.tags || []).join(','), m.vision || m.images ? 'vision' : null);
    if (r.changes > 0) added++;
    // enrich existing rows with rate/tags from live catalogs
    if (live && (m.multiplier != null || m.tags?.length || m.ctx || m.maxOutput)) {
      updateRate.run(m.multiplier ?? 1, free, m.ctx || null, m.maxOutput || null,
        (m.tags || []).join(','), (m.tags || []).join(','), plugin.id, upstream);
    }
    if (free) db.prepare('UPDATE models SET is_free=1 WHERE provider_id=? AND upstream_model=?').run(plugin.id, upstream);
  }
  return added;
}

function getProviderConfig(providerId) {
  const row = db.prepare('SELECT config FROM providers WHERE id=?').get(providerId);
  return row ? JSON.parse(row.config || '{}') : {};
}

function setProviderConfig(providerId, cfg) {
  db.prepare('UPDATE providers SET config=? WHERE id=?').run(JSON.stringify(cfg || {}), providerId);
}

/** All model rows (joined with provider) for admin UI */
function listModels({ providerId, search, enabled, tag } = {}) {
  let sql = "SELECT m.*, (SELECT COUNT(*) FROM accounts a WHERE a.provider_id=m.provider_id AND a.enabled=1 AND a.status!='invalid') AS account_count FROM models m";
  const where = []; const args = [];
  if (providerId) { where.push('m.provider_id=?'); args.push(providerId); }
  if (enabled !== undefined && enabled !== null && enabled !== '') { where.push('m.enabled=?'); args.push(enabled ? 1 : 0); }
  if (search) { where.push('(m.public_name LIKE ? OR m.upstream_model LIKE ? OR m.tags LIKE ?)'); args.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (tag) { where.push('m.tags LIKE ?'); args.push(`%${tag}%`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  // 每个平台内免费模型排前面，便于管理界面优先核对免费额度
  sql += ' ORDER BY m.provider_id, m.is_free DESC, m.public_name';
  return db.prepare(sql).all(...args);
}

/**
 * Route a public model name to a concrete (plugin, account, upstreamModel).
 * Strategy: prefer accounts that have used fewer credits today? Keep simple:
 * pick by priority + round robin among accounts of that provider (healthy).
 */
function route(publicModel) {
  const m = db.prepare('SELECT * FROM models WHERE public_name=? AND enabled=1').get(publicModel);
  if (!m) return null;
  const account = accounts.pickAccount(m.provider_id);
  if (!account) return { model: m, account: null };
  return { model: m, account };
}

function findModelByUpstream(providerId, upstreamModel) {
  return db.prepare('SELECT * FROM models WHERE provider_id=? AND upstream_model=? AND enabled=1').get(providerId, upstreamModel);
}

function recordUsage({ apikeyId, providerId, accountId, publicModel, upstreamModel, inputTokens, outputTokens, credits, multiplier, latencyMs, status, error, source }) {
  db.prepare(`INSERT INTO usage(apikey_id, provider_id, account_id, public_model, upstream_model, input_tokens, output_tokens, credits, multiplier, latency_ms, status, error, source)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(apikeyId || null, providerId || null, accountId || null, publicModel || null, upstreamModel || null,
      inputTokens || 0, outputTokens || 0, credits || 0, multiplier || 1, latencyMs || 0, status || 0, error || null, source || null);
}

// ---------- virtual models (统一模型：跨平台聚合 + 故障切换 + 对外改名) ----------
function listVirtualModels() {
  return db.prepare('SELECT * FROM virtual_models ORDER BY public_name').all();
}
function getVirtualModel(publicName) {
  return db.prepare('SELECT * FROM virtual_models WHERE public_name=?').get(publicName);
}
function upsertVirtualModel({ public_name, targets, enabled = 1, note = null, tags = '', strategy = 'priority' }) {
  if (!public_name || !Array.isArray(targets) || !targets.length) throw new Error('public_name and targets required');
  for (const t of targets) {
    if (!t.provider_id || !t.public_name) throw new Error('each target needs provider_id + public_name');
  }
  const strat = ['priority', 'weighted', 'least_conn'].includes(strategy) ? strategy : 'priority';
  db.prepare(`INSERT INTO virtual_models(public_name, targets, enabled, note, tags, strategy) VALUES(?,?,?,?,?,?)
    ON CONFLICT(public_name) DO UPDATE SET targets=excluded.targets, enabled=excluded.enabled, note=excluded.note, tags=excluded.tags, strategy=excluded.strategy`)
    .run(public_name, JSON.stringify(targets), enabled ? 1 : 0, note, tags || '', strat);
  return getVirtualModel(public_name);
}
function deleteVirtualModel(publicName) {
  db.prepare('DELETE FROM virtual_models WHERE public_name=?').run(publicName);
}

// ---------- 费率标签（模型选择时可区分同款模型的免费/计费版本） ----------
// /v1/models 的 id 直接带标签：`deepseek-v4.1-flash-intl ·免费` vs `deepseek-v4.1-flash-sg ·x0.03`。
// 客户端原样回传，engine 在路由前剥掉标签（stripRateTag），allowed_models 校验同样按剥后名比较。
const RATE_TAG_RE = /\s*·(?:免费|x[0-9]+(?:\.[0-9]+)?)$/u;

/** 费率标签：免费模型 `·免费`；倍率≠1 的计费模型 `·x<倍率>`；其余（倍率未知/标准）无标签 */
function rateTag(m) {
  if (!m) return '';
  if (m.is_free || m.free) return '·免费';
  const r = Number(m.multiplier);
  if (Number.isFinite(r) && r > 0 && r !== 1) return `·x${r}`;
  return '';
}

/** 模型对外名 + 费率标签 */
function decoratePublicModel(name, m) {
  const t = rateTag(m);
  return t ? `${name} ${t}` : String(name || '');
}

/** 剥掉尾部费率标签（无标签原样返回） */
function stripRateTag(name) {
  return String(name || '').replace(RATE_TAG_RE, '');
}

/** public model list for clients: regular enabled models + virtual models (免费模型排最前) */
function listPublicModels() {
  const regular = db.prepare(`
    SELECT m.public_name, m.provider_id, m.upstream_model, m.multiplier, m.is_free, m.ctx_window,
           (SELECT COUNT(*) FROM accounts a WHERE a.provider_id=m.provider_id AND a.enabled=1 AND a.status NOT IN ('invalid','banned')) AS accounts
    FROM models m WHERE m.enabled=1
    ORDER BY m.is_free DESC, m.public_name`).all().filter(m => m.accounts > 0);
  const virtual = db.prepare('SELECT * FROM virtual_models WHERE enabled=1').all()
    .map(v => ({ public_name: v.public_name, provider_id: 'virtual', upstream_model: null, multiplier: 1, is_free: 0, ctx_window: null, accounts: 1, virtual: 1 }));
  return [...regular, ...virtual];
}

/** enabled models grouped for admin "sync targets" dropdowns: only what this gateway actually has */
function listEnabledModelNames() {
  return db.prepare('SELECT provider_id, public_name FROM models WHERE enabled=1 ORDER BY provider_id, public_name').all();
}

module.exports = { syncProviderModels, listModels, listPublicModels, route, findModelByUpstream, recordUsage, getProviderConfig, setProviderConfig, listVirtualModels, getVirtualModel, upsertVirtualModel, deleteVirtualModel, listEnabledModelNames, resetProviderModelsToOnline, rateTag, decoratePublicModel, stripRateTag };
