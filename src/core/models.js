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
 * Sync models reported by plugin.listModels(account) into the models table.
 * New upstream models are inserted (enabled by default unless provider config autoDisable).
 * Rows already in the table keep their settings (multiplier, enabled...).
 */
function syncProviderModels(plugin, account, upstreamModels) {
  const autoDisable = (getProviderConfig(plugin.id).autoDisableNewModels) || false;
  const insert = db.prepare(`INSERT OR IGNORE INTO models(provider_id, upstream_model, public_name, enabled, is_free, multiplier, ctx_window)
    VALUES(?,?,?,?,?,?,?)`);
  let added = 0;
  for (const m of upstreamModels) {
    const upstream = m.upstream || m;
    const free = m.free ? 1 : 0;
    const r = insert.run(plugin.id, upstream, m.publicName || upstream, autoDisable ? 0 : 1, free, m.multiplier || 1, m.ctx || null);
    if (r.changes > 0) added++;
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
  sql += ' ORDER BY m.provider_id, m.public_name';
  return db.prepare(sql).all(...args);
}

/** Public model names visible to clients, grouped, with enabled=1 and at least one enabled account */
function listPublicModels() {
  return db.prepare(`
    SELECT m.public_name, m.provider_id, m.upstream_model, m.multiplier, m.is_free, m.ctx_window,
           (SELECT COUNT(*) FROM accounts a WHERE a.provider_id=m.provider_id AND a.enabled=1 AND a.status NOT IN ('invalid','banned')) AS accounts
    FROM models m WHERE m.enabled=1
    ORDER BY m.public_name`).all().filter(m => m.accounts > 0);
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

module.exports = { syncProviderModels, listModels, listPublicModels, route, findModelByUpstream, recordUsage, getProviderConfig, setProviderConfig };
