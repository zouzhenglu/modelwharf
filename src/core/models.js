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
 * Insert one catalog row (or reuse the existing row by upstream/public name) and
 * bind it to the account that reported it. Returns { row, created }.
 */
function upsertCatalogRow(plugin, account, m, { disableNew = false } = {}) {
  const upstream = m.upstream || m;
  const publicName = m.publicName || upstream;
  let row = db.prepare('SELECT * FROM models WHERE provider_id=? AND upstream_model=?').get(plugin.id, upstream);
  if (!row) row = db.prepare('SELECT * FROM models WHERE provider_id=? AND public_name=?').get(plugin.id, publicName);
  let created = false;
  if (!row) {
    const tagList = Array.isArray(m.tags) ? m.tags : (m.tags ? [m.tags] : []);
    if (m.vision || m.images) tagList.push('vision');
    const r = db.prepare(`INSERT INTO models(provider_id, upstream_model, public_name, enabled, is_free, multiplier, ctx_window, max_output, tags, note)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(plugin.id, upstream, publicName, disableNew ? 0 : 1, m.free ? 1 : 0,
      m.multiplier ?? 1, m.ctx || null, m.maxOutput || null,
      tagList.join(',') || (m.online ? 'online' : ''), m.note || null);
    row = db.prepare('SELECT * FROM models WHERE id=?').get(r.lastInsertRowid);
    created = true;
  }
  let linked = 0;
  if (account) {
    linked = db.prepare('INSERT OR IGNORE INTO model_accounts(model_id, account_id) VALUES(?,?)').run(row.id, account.id).changes;
  }
  return { row, created, linked };
}

/**
 * Reset a provider's model list to its online catalog (恢复在线模型).
 * With account: only that account's bindings/rows are replaced (other accounts untouched).
 * Without account: legacy whole-provider reset.
 */
function resetProviderModelsToOnline(plugin, onlineModels, { account } = {}) {
  const tx = db.transaction(() => {
    let deleted = 0;
    if (account) {
      const affected = db.prepare(`SELECT ma.model_id FROM model_accounts ma
        JOIN models m ON m.id=ma.model_id WHERE ma.account_id=? AND m.provider_id=?`)
        .all(account.id, plugin.id).map(r => r.model_id);
      db.prepare(`DELETE FROM model_accounts WHERE account_id=?
        AND model_id IN (SELECT id FROM models WHERE provider_id=?)`).run(account.id, plugin.id);
      for (const modelId of affected) {
        if (!db.prepare('SELECT 1 FROM model_accounts WHERE model_id=? LIMIT 1').get(modelId)) {
          db.prepare('DELETE FROM models WHERE id=?').run(modelId);
          deleted++;
        }
      }
    } else {
      db.prepare('DELETE FROM model_accounts WHERE model_id IN (SELECT id FROM models WHERE provider_id=?)').run(plugin.id);
      deleted = db.prepare('DELETE FROM models WHERE provider_id=?').run(plugin.id).changes;
    }
    let added = 0;
    for (const m of onlineModels) {
      if (upsertCatalogRow(plugin, account, m).created) added++;
    }
    return { deleted, added };
  });
  return tx();
}

/**
 * Sync models reported by plugin.listModels(account) into the models table and
 * bind them to this account. live=true: catalog from the upstream API; stale
 * bindings of THIS account are removed. live=false: static fallback, only when
 * the provider has no models yet.
 */
function syncProviderModels(plugin, account, upstreamModels, { live = true } = {}) {
  const autoDisable = (getProviderConfig(plugin.id).autoDisableNewModels) || false;
  if (!live) {
    const have = db.prepare('SELECT COUNT(*) c FROM models WHERE provider_id=?').get(plugin.id).c;
    if (have > 0) return { added: 0, linked: 0, unlinked: 0 };
  }
  const updateRate = db.prepare('UPDATE models SET multiplier=?, is_free=?, ctx_window=COALESCE(?,ctx_window), max_output=COALESCE(?,max_output), tags=CASE WHEN ? != \'\' THEN ? ELSE tags END WHERE provider_id=? AND upstream_model=?');
  const tx = db.transaction(() => {
    let added = 0, linked = 0, unlinked = 0;
    const seen = new Set();
    for (const m of upstreamModels) {
      const upstream = m.upstream || m;
      const { row, created, linked: linkChanges } = upsertCatalogRow(plugin, account, m, { disableNew: autoDisable });
      if (created) added++;
      if (linkChanges) linked++;
      seen.add(row.id);
      // enrich existing rows with rate/tags from live catalogs
      if (live && (m.multiplier != null || m.tags?.length || m.ctx || m.maxOutput)) {
        updateRate.run(m.multiplier ?? 1, m.free ? 1 : 0, m.ctx || null, m.maxOutput || null,
          (m.tags || []).join(','), (m.tags || []).join(','), plugin.id, upstream);
      }
      if (m.free) db.prepare('UPDATE models SET is_free=1 WHERE provider_id=? AND upstream_model=?').run(plugin.id, upstream);
    }
    // live sync: this account no longer reports some models -> drop its bindings
    if (live && upstreamModels.length) {
      const bound = db.prepare(`SELECT ma.model_id FROM model_accounts ma
        JOIN models m ON m.id=ma.model_id WHERE ma.account_id=? AND m.provider_id=?`)
        .all(account.id, plugin.id);
      for (const { model_id } of bound) {
        if (seen.has(model_id)) continue;
        db.prepare('DELETE FROM model_accounts WHERE model_id=? AND account_id=?').run(model_id, account.id);
        unlinked++;
        if (!db.prepare('SELECT 1 FROM model_accounts WHERE model_id=? LIMIT 1').get(model_id)) {
          db.prepare('DELETE FROM models WHERE id=?').run(model_id);
        }
      }
    }
    return { added, linked, unlinked };
  });
  return tx();
}

function getProviderConfig(providerId) {
  const row = db.prepare('SELECT config FROM providers WHERE id=?').get(providerId);
  return row ? JSON.parse(row.config || '{}') : {};
}

function setProviderConfig(providerId, cfg) {
  db.prepare('UPDATE providers SET config=? WHERE id=?').run(JSON.stringify(cfg || {}), providerId);
}

/** Bound accounts for one model row (empty = legacy wildcard: every provider account). */
function modelAccounts(modelId) {
  return db.prepare(`SELECT ma.model_id, a.id, a.name, a.status, a.enabled
    FROM model_accounts ma JOIN accounts a ON a.id=ma.account_id
    WHERE ma.model_id=? ORDER BY a.priority, a.id`).all(modelId);
}

/** Attach `accounts` + `account_count` + `wildcard` to model rows for the admin UI. */
function decorateModelAccounts(rows) {
  const aliasCache = new Map();
  const providerCache = new Map();
  const aliasesFor = (providerId) => {
    if (!aliasCache.has(providerId)) aliasCache.set(providerId, accounts.aliasMap(providerId));
    return aliasCache.get(providerId);
  };
  for (const row of rows) {
    const links = modelAccounts(row.id);
    const aliases = aliasesFor(row.provider_id);
    if (links.length) {
      row.accounts = links.map(a => ({ id: a.id, name: a.name, status: a.status, enabled: a.enabled, alias: aliases.get(a.id) }));
      row.account_count = links.filter(a => a.enabled && a.status !== 'invalid' && a.status !== 'banned').length;
      row.wildcard = false;
    } else {
      if (!providerCache.has(row.provider_id)) providerCache.set(row.provider_id, accounts.listAccounts(row.provider_id));
      const list = providerCache.get(row.provider_id);
      row.accounts = list.map(a => ({ id: a.id, name: a.name, status: a.status, enabled: a.enabled, alias: aliases.get(a.id) }));
      row.account_count = list.filter(a => a.status !== 'invalid' && a.status !== 'banned').length;
      row.wildcard = true;
    }
  }
  return rows;
}

/** All model rows (joined with provider) for admin UI */
function listModels({ providerId, search, enabled, tag, accountId } = {}) {
  let sql = 'SELECT m.* FROM models m';
  const where = []; const args = [];
  if (providerId) { where.push('m.provider_id=?'); args.push(providerId); }
  if (accountId !== undefined && accountId !== null && accountId !== '') {
    where.push('EXISTS (SELECT 1 FROM model_accounts ma WHERE ma.model_id=m.id AND ma.account_id=?)');
    args.push(accountId);
  }
  if (enabled !== undefined && enabled !== null && enabled !== '') { where.push('m.enabled=?'); args.push(enabled ? 1 : 0); }
  if (search) { where.push('(m.public_name LIKE ? OR m.upstream_model LIKE ? OR m.tags LIKE ?)'); args.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (tag) { where.push('m.tags LIKE ?'); args.push(`%${tag}%`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  // 每个平台内免费模型排前面，便于管理界面优先核对免费额度
  sql += ' ORDER BY m.provider_id, m.is_free DESC, m.public_name';
  return decorateModelAccounts(db.prepare(sql).all(...args));
}

/**
 * Route a public model name to a concrete (plugin, account, upstreamModel).
 * Strategy: pick by priority + round robin among accounts bound to that model.
 */
function route(publicModel) {
  const m = db.prepare('SELECT * FROM models WHERE public_name=? AND enabled=1').get(publicModel);
  if (!m) return null;
  const account = accounts.pickAccount(m.provider_id, { modelId: m.id });
  if (!account) return { model: m, account: null };
  return { model: m, account };
}

/** Split `model@alias` (alias may be `provider:alias`); null when the name has no alias suffix. */
function splitAlias(name) {
  const text = String(name || '');
  const at = text.lastIndexOf('@');
  if (at <= 0 || at === text.length - 1) return null;
  const base = text.slice(0, at);
  const raw = text.slice(at + 1);
  const colon = raw.indexOf(':');
  return colon > 0
    ? { base, providerId: raw.slice(0, colon), alias: raw.slice(colon + 1).toLowerCase() }
    : { base, providerId: null, alias: raw.toLowerCase() };
}

/** All (model, account) hits for a `model@alias` pair; empty when the alias doesn't serve it. */
function findModelByAlias(baseName, alias, providerHint) {
  const wanted = String(alias || '').toLowerCase();
  if (!wanted) return [];
  const rows = db.prepare('SELECT * FROM models WHERE public_name=? AND enabled=1').all(baseName);
  const hits = [];
  for (const row of rows) {
    if (providerHint && row.provider_id !== providerHint) continue;
    const aliases = accounts.aliasMap(row.provider_id);
    for (const a of accounts.listAccounts(row.provider_id)) {
      if (aliases.get(a.id) !== wanted) continue;
      if (!accounts.accountServesModel(row.id, a.id)) continue;
      hits.push({ model: row, account: a });
    }
  }
  return hits;
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

/** public model list for clients: regular enabled models (+ account aliases) + virtual models */
function listPublicModels() {
  const rows = db.prepare(`
    SELECT m.id, m.public_name, m.provider_id, m.upstream_model, m.multiplier, m.is_free, m.ctx_window, m.max_output
    FROM models m WHERE m.enabled=1
    ORDER BY m.is_free DESC, m.public_name`).all();
  const aliasCache = new Map();
  const providerCache = new Map();
  const accountsOf = (providerId) => {
    if (!providerCache.has(providerId)) providerCache.set(providerId, accounts.listAccounts(providerId));
    return providerCache.get(providerId);
  };
  const aliasesOf = (providerId) => {
    if (!aliasCache.has(providerId)) aliasCache.set(providerId, accounts.aliasMap(providerId));
    return aliasCache.get(providerId);
  };
  const out = [];
  for (const m of rows) {
    const links = db.prepare(`SELECT ma.account_id, a.status, a.enabled FROM model_accounts ma
      JOIN accounts a ON a.id=ma.account_id WHERE ma.model_id=?`).all(m.id);
    const serving = links.length
      ? links.filter(a => a.enabled && a.status !== 'invalid' && a.status !== 'banned')
      : accountsOf(m.provider_id)
        .filter(a => a.status !== 'invalid' && a.status !== 'banned')
        .map(a => ({ account_id: a.id, status: a.status, enabled: a.enabled }));
    if (!serving.length) continue;
    out.push({
      public_name: m.public_name, provider_id: m.provider_id, upstream_model: m.upstream_model,
      multiplier: m.multiplier, is_free: m.is_free, ctx_window: m.ctx_window, max_output: m.max_output,
      accounts: serving.length,
    });
    // 账号别名只在多账号平台生成，单账号平台列表保持原样
    if (accountsOf(m.provider_id).length > 1) {
      const aliases = aliasesOf(m.provider_id);
      for (const a of serving) {
        const alias = aliases.get(a.account_id);
        if (!alias) continue;
        out.push({
          public_name: `${m.public_name}@${alias}`, provider_id: m.provider_id,
          upstream_model: m.upstream_model, multiplier: m.multiplier, is_free: m.is_free,
          ctx_window: m.ctx_window, max_output: m.max_output, accounts: 1,
          alias_of: m.public_name, account_id: a.account_id,
        });
      }
    }
  }
  const virtual = db.prepare('SELECT * FROM virtual_models WHERE enabled=1').all()
    .map(v => ({ public_name: v.public_name, provider_id: 'virtual', upstream_model: null, multiplier: 1, is_free: 0, ctx_window: null, max_output: null, accounts: 1, virtual: 1 }));
  return [...out, ...virtual];
}

/** enabled models grouped for admin "sync targets" dropdowns: only what this gateway actually has */
function listEnabledModelNames() {
  return db.prepare('SELECT provider_id, public_name FROM models WHERE enabled=1 ORDER BY provider_id, public_name').all();
}

module.exports = {
  syncProviderModels, listModels, listPublicModels, route, findModelByUpstream, recordUsage,
  getProviderConfig, setProviderConfig, listVirtualModels, getVirtualModel, upsertVirtualModel, deleteVirtualModel,
  listEnabledModelNames, resetProviderModelsToOnline, rateTag, decoratePublicModel, stripRateTag,
  modelAccounts, decorateModelAccounts, splitAlias, findModelByAlias,
};
