'use strict';
/**
 * Admin REST API used by the management panel (session-cookie auth).
 * Sections: auth, providers, accounts, models, apikeys, usage/stats, mcp, settings, test.
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { db, getSetting, setSetting } = require('../store');
const registry = require('../core/registry');
const accountsCore = require('../core/accounts');
const modelsCore = require('../core/models');
const engine = require('../core/engine');
const logger = require('../logger');

const router = express.Router();

// ---------- session auth ----------
const sessions = new Map(); // token -> expiry
function requireAuth(req, res, next) {
  const token = (req.headers['authorization'] || '').replace(/^Bearer /, '') || req.cookies?.dsh_session || req.query.session;
  if (token && sessions.has(token) && sessions.get(token) > Date.now()) return next();
  res.status(401).json({ error: 'unauthorized' });
}
function login(password) {
  const pw = getSetting('adminPassword', config.adminPassword);
  if (password !== pw) return null;
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + 7 * 24 * 3600 * 1000);
  return token;
}

router.post('/login', (req, res) => {
  const token = login(req.body?.password);
  if (!token) return res.status(401).json({ error: 'wrong password' });
  res.json({ token });
});
router.post('/logout', (req, res) => { const t = (req.headers['authorization'] || '').replace(/^Bearer /, ''); sessions.delete(t); res.json({ ok: true }); });
router.get('/me', requireAuth, (req, res) => res.json({ ok: true, version: config.version }));

// everything below requires auth
router.use(requireAuth);

// ---------- providers ----------
router.get('/providers', (req, res) => {
  const rows = db.prepare('SELECT * FROM providers').all();
  res.json(rows.map(r => {
    const p = registry.get(r.id);
    return { ...r, config: JSON.parse(r.config || '{}'), label: p?.label || r.id, homepage: p?.homepage, credFields: p?.credFields || [], docs: p?.docs, account_count: db.prepare('SELECT COUNT(*) c FROM accounts WHERE provider_id=?').get(r.id).c };
  }));
});
router.put('/providers/:id', (req, res) => {
  modelsCore.setProviderConfig(req.params.id, req.body?.config || {});
  res.json({ ok: true });
});

// ---------- accounts ----------
router.get('/accounts', (req, res) => {
  const { provider_id, search, status, enabled } = req.query;
  let sql = 'SELECT * FROM accounts'; const where = []; const args = [];
  if (provider_id) { where.push('provider_id=?'); args.push(provider_id); }
  if (status) { where.push('status=?'); args.push(status); }
  if (enabled !== undefined && enabled !== '') { where.push('enabled=?'); args.push(Number(enabled)); }
  if (search) { where.push('(name LIKE ? OR extra LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY provider_id, priority, id';
  const rows = db.prepare(sql).all(...args).map(r => ({
    ...r, credentials: JSON.parse(r.credentials || '{}'), extra: JSON.parse(r.extra || '{}'),
    // redact secret values
    credentials_summary: Object.fromEntries(Object.entries(JSON.parse(r.credentials || '{}')).map(([k, v]) => [k, typeof v === 'string' && v.length > 12 ? v.slice(0, 6) + '...' + v.slice(-4) : v])),
    credentials: undefined,
  }));
  res.json(rows);
});
router.post('/accounts', (req, res) => {
  const { provider_id, name, credentials, priority = 100, max_concurrency = 3 } = req.body || {};
  if (!provider_id || !name || !credentials) return res.status(400).json({ error: 'provider_id, name, credentials required' });
  if (!registry.get(provider_id)) return res.status(400).json({ error: `unknown provider ${provider_id}` });
  try {
    const r = db.prepare('INSERT INTO accounts(provider_id,name,credentials,priority,max_concurrency) VALUES(?,?,?,?,?)')
      .run(provider_id, name, JSON.stringify(credentials), priority, max_concurrency);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'account name exists for this provider' : e.message });
  }
});
router.put('/accounts/:id', (req, res) => {
  const a = accountsCore.getAccount(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const { name, credentials, enabled, priority, max_concurrency, status } = req.body || {};
  db.prepare('UPDATE accounts SET name=?, credentials=?, enabled=?, priority=?, max_concurrency=?, status=? WHERE id=?')
    .run(name ?? a.name, credentials ? JSON.stringify(credentials) : JSON.stringify(a.credentials),
      enabled === undefined ? a.enabled : (enabled ? 1 : 0), priority ?? a.priority, max_concurrency ?? a.max_concurrency,
      status ?? a.status, a.id);
  res.json({ ok: true });
});
router.delete('/accounts/:id', (req, res) => { db.prepare('DELETE FROM accounts WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// check account: calls plugin.checkAccount
router.post('/accounts/:id/check', async (req, res) => {
  const a = accountsCore.getAccount(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const plugin = registry.get(a.provider_id);
  if (!plugin?.checkAccount) return res.json({ ok: null, message: 'provider has no checker' });
  try {
    const r = await plugin.checkAccount(a);
    if (r.extra) db.prepare('UPDATE accounts SET extra=? WHERE id=?').run(JSON.stringify({ ...a.extra, ...r.extra }), a.id);
    if (r.ok === true) accountsCore.setAccountStatus(a.id, 'active');
    else if (r.ok === false) accountsCore.setAccountStatus(a.id, r.status || 'invalid', r.message);
    res.json(r);
  } catch (e) {
    accountsCore.setAccountStatus(a.id, 'invalid', e.message);
    res.json({ ok: false, message: e.message });
  }
});

// check ALL accounts at once (一键检测)：each account checked concurrently, results per account
router.post('/accounts/check-all', async (req, res) => {
  const all = accountsCore.listAccounts(null, { includeDisabled: false });
  const results = await Promise.allSettled(all.map(async (a) => {
    const plugin = registry.get(a.provider_id);
    if (!plugin?.checkAccount) return { id: a.id, provider_id: a.provider_id, name: a.name, ok: null, message: 'no checker' };
    try {
      const r = await plugin.checkAccount(a);
      if (r.extra) db.prepare('UPDATE accounts SET extra=? WHERE id=?').run(JSON.stringify({ ...a.extra, ...r.extra }), a.id);
      if (r.ok === true) accountsCore.setAccountStatus(a.id, 'active');
      else if (r.ok === false) accountsCore.setAccountStatus(a.id, r.status || 'invalid', r.message);
      return { id: a.id, provider_id: a.provider_id, name: a.name, ok: r.ok, message: r.message || '' };
    } catch (e) {
      accountsCore.setAccountStatus(a.id, 'invalid', e.message);
      return { id: a.id, provider_id: a.provider_id, name: a.name, ok: false, message: e.message };
    }
  }));
  res.json({ checked: results.length, results: results.map(r => r.value) });
});

// sync credits/info for all accounts (一键同步积分)：same as check-all but never flips status
router.post('/accounts/sync-info', async (req, res) => {
  const all = accountsCore.listAccounts(null, { includeDisabled: false });
  const results = await Promise.allSettled(all.map(async (a) => {
    const plugin = registry.get(a.provider_id);
    if (!plugin?.checkAccount) return { id: a.id, provider_id: a.provider_id, name: a.name, ok: null, message: 'no checker' };
    try {
      const r = await plugin.checkAccount(a);
      if (r.extra) db.prepare('UPDATE accounts SET extra=? WHERE id=?').run(JSON.stringify({ ...a.extra, ...r.extra }), a.id);
      return { id: a.id, provider_id: a.provider_id, name: a.name, ok: r.ok, message: r.message || '', credits: r.extra?.credits };
    } catch (e) {
      return { id: a.id, provider_id: a.provider_id, name: a.name, ok: false, message: e.message };
    }
  }));
  res.json({ synced: results.length, results: results.map(r => r.value) });
});

// import credentials from local machine (provider plugin must implement importLocal)
router.post('/providers/:id/import-local', async (req, res) => {
  const plugin = registry.get(req.params.id);
  if (!plugin?.importLocal) return res.status(400).json({ error: 'provider does not support local import' });
  try {
    const r = await plugin.importLocal({ import: true, names: req.body?.names || [] });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// manual re-run of startup auto-import across all providers
router.post('/import-local-all', async (req, res) => {
  try { res.json(registry.autoImportLocal()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// refresh models from upstream for all enabled accounts of a provider
router.post('/providers/:id/refresh-models', async (req, res) => {
  const plugin = registry.get(req.params.id);
  if (!plugin) return res.status(404).json({ error: 'no such provider' });
  const accts = accountsCore.listAccounts(req.params.id).filter(a => a.enabled);
  let added = 0; const errors = [];
  for (const a of accts) {
    if (!plugin.listModels) continue;
    try {
      const models = await plugin.listModels(a);
      added += modelsCore.syncProviderModels(plugin, a, models, { live: !models[0]?.static });
    } catch (e) { errors.push(`${a.name}: ${e.message}`); }
  }
  res.json({ added, errors });
});

// sync models for ONE account (账号行内同步)
router.post('/accounts/:id/refresh-models', async (req, res) => {
  const a = accountsCore.getAccount(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const plugin = registry.get(a.provider_id);
  if (!plugin?.listModels) return res.status(400).json({ error: 'provider has no model lister' });
  try {
    const models = await plugin.listModels(a);
    const added = modelsCore.syncProviderModels(plugin, a, models, { live: !models[0]?.static });
    res.json({ added, total: models.length });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// sync models for ALL providers at once
router.post('/refresh-models-all', async (req, res) => {
  const providers = db.prepare('SELECT id FROM providers').all();
  const summary = [];
  for (const { id } of providers) {
    const plugin = registry.get(id);
    if (!plugin?.listModels) continue;
    const accts = accountsCore.listAccounts(id).filter(a => a.enabled);
    let added = 0; const errors = [];
    for (const a of accts) {
      try {
        const models = await plugin.listModels(a);
        added += modelsCore.syncProviderModels(plugin, a, models, { live: !models[0]?.static });
      } catch (e) { errors.push(`${a.name}: ${e.message}`); }
    }
    summary.push({ provider: id, added, errors });
  }
  res.json(summary);
});

// ---------- models ----------
router.get('/models', (req, res) => {
  const { provider_id, search, enabled, tag } = req.query;
  // enabled arrives as string from query; '0' must map to false (Number('0')=0 is falsy-safe here)
  const enabledFlag = enabled === '' || enabled === undefined ? undefined : Number(enabled) ? 1 : 0;
  res.json(modelsCore.listModels({ providerId: provider_id, search, enabled: enabledFlag, tag }));
});
router.post('/models', (req, res) => {
  const { provider_id, upstream_model, public_name, multiplier = 1, is_free = 0, ctx_window, tags = '', note } = req.body || {};
  if (!provider_id || !upstream_model || !public_name) return res.status(400).json({ error: 'provider_id, upstream_model, public_name required' });
  try {
    const r = db.prepare('INSERT INTO models(provider_id,upstream_model,public_name,multiplier,is_free,ctx_window,tags,note) VALUES(?,?,?,?,?,?,?,?)')
      .run(provider_id, upstream_model, public_name, multiplier, is_free ? 1 : 0, ctx_window || null, tags, note || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message.includes('UNIQUE') ? 'public_name already exists' : e.message }); }
});
router.put('/models/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM models WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const { upstream_model, public_name, enabled, multiplier, is_free, ctx_window, max_output, tags, note } = req.body || {};
  db.prepare('UPDATE models SET upstream_model=?, public_name=?, enabled=?, multiplier=?, is_free=?, ctx_window=?, max_output=?, tags=?, note=? WHERE id=?')
    .run(upstream_model ?? m.upstream_model, public_name ?? m.public_name,
      enabled === undefined ? m.enabled : (enabled ? 1 : 0), multiplier ?? m.multiplier,
      is_free === undefined ? m.is_free : (is_free ? 1 : 0), ctx_window ?? m.ctx_window, max_output ?? m.max_output,
      tags ?? m.tags, note ?? m.note, m.id);
  res.json({ ok: true });
});
router.delete('/models/:id', (req, res) => { db.prepare('DELETE FROM models WHERE id=?').run(req.params.id); res.json({ ok: true }); });
router.post('/models/:id/toggle', (req, res) => {
  db.prepare('UPDATE models SET enabled = 1-enabled WHERE id=?').run(req.params.id);
  res.json({ ok: true, enabled: db.prepare('SELECT enabled FROM models WHERE id=?').get(req.params.id).enabled });
});

// batch operations (批量启用/禁用/删除)
router.post('/models/batch', (req, res) => {
  const { action, ids, provider_id } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action required' });
  let affected = 0;
  if (action === 'enable' || action === 'disable') {
    const v = action === 'enable' ? 1 : 0;
    if (Array.isArray(ids) && ids.length) {
      affected = db.prepare(`UPDATE models SET enabled=? WHERE id IN (${ids.map(() => '?').join(',')})`).run(v, ...ids).changes;
    } else if (provider_id) {
      affected = db.prepare('UPDATE models SET enabled=? WHERE provider_id=?').run(v, provider_id).changes;
    } else {
      affected = db.prepare('UPDATE models SET enabled=?').run(v).changes;
    }
  } else if (action === 'delete') {
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required for delete' });
    affected = db.prepare(`DELETE FROM models WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids).changes;
  } else if (action === 'disable-dev-variants') {
    // hide internal __dev-style duplicates
    affected = db.prepare("UPDATE models SET enabled=0 WHERE public_name LIKE '%\\_\\_dev' ESCAPE '\\'").run().changes;
  } else {
    return res.status(400).json({ error: 'unknown action' });
  }
  res.json({ ok: true, affected });
});

// ---------- apikeys ----------
router.get('/apikeys', (req, res) => {
  const { search, enabled } = req.query;
  let sql = 'SELECT id,key,name,enabled,allowed_models,rpm_limit,daily_limit,used_today,last_used_at,created_at FROM apikeys';
  const where = []; const args = [];
  if (search) { where.push('(name LIKE ? OR key LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }
  if (enabled !== undefined && enabled !== '') { where.push('enabled=?'); args.push(Number(enabled)); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  res.json(db.prepare(sql + ' ORDER BY id').all(...args).map(k => ({ ...k, key: k.key.slice(0, 10) + '...' + k.key.slice(-4) })));
});
router.post('/apikeys', (req, res) => {
  const { name, allowed_models = '*', rpm_limit = 0, daily_limit = 0 } = req.body || {};
  const key = 'sk-dsh-' + crypto.randomBytes(24).toString('hex');
  const r = db.prepare('INSERT INTO apikeys(key,name,allowed_models,rpm_limit,daily_limit) VALUES(?,?,?,?,?)').run(key, name || null, allowed_models, rpm_limit, daily_limit);
  res.json({ ok: true, id: r.lastInsertRowid, key }); // full key shown once
});
router.put('/apikeys/:id', (req, res) => {
  const k = db.prepare('SELECT * FROM apikeys WHERE id=?').get(req.params.id);
  if (!k) return res.status(404).json({ error: 'not found' });
  const { name, enabled, allowed_models, rpm_limit, daily_limit } = req.body || {};
  db.prepare('UPDATE apikeys SET name=?, enabled=?, allowed_models=?, rpm_limit=?, daily_limit=? WHERE id=?')
    .run(name ?? k.name, enabled === undefined ? k.enabled : (enabled ? 1 : 0), allowed_models ?? k.allowed_models, rpm_limit ?? k.rpm_limit, daily_limit ?? k.daily_limit, k.id);
  res.json({ ok: true });
});
router.delete('/apikeys/:id', (req, res) => { db.prepare('DELETE FROM apikeys WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---------- usage & stats ----------
router.get('/usage', (req, res) => {
  const { page = 1, size = 50, provider_id, model, apikey_id, status, since, until } = req.query;
  const where = []; const args = [];
  if (provider_id) { where.push('provider_id=?'); args.push(provider_id); }
  if (model) { where.push('public_model LIKE ?'); args.push(`%${model}%`); }
  if (apikey_id) { where.push('apikey_id=?'); args.push(apikey_id); }
  if (status) { where.push('status>=?'); args.push(status === 'error' ? 400 : 200); if (status === 'ok') { where.pop(); args.pop(); where.push('status<400'); } }
  if (since) { where.push('ts>=?'); args.push(Math.floor(new Date(since).getTime() / 1000)); }
  if (until) { where.push('ts<=?'); args.push(Math.floor(new Date(until).getTime() / 1000)); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) c FROM usage' + whereSql).get(...args).c;
  const rows = db.prepare('SELECT * FROM usage' + whereSql + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...args, Number(size), (Number(page) - 1) * Number(size));
  res.json({ total, page: Number(page), size: Number(size), rows });
});
// ---------- stats ----------
function setHours0() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
router.get('/stats', (req, res) => {
  const dayStart = Math.floor(setHours0() / 1000);
  const today = db.prepare('SELECT COUNT(*) reqs, COALESCE(SUM(input_tokens),0) tin, COALESCE(SUM(output_tokens),0) tout, COALESCE(SUM(credits),0) credits FROM usage WHERE ts>=?').get(dayStart);
  const total = db.prepare('SELECT COUNT(*) reqs, COALESCE(SUM(credits),0) credits FROM usage').get();
  const errToday = db.prepare('SELECT COUNT(*) c FROM usage WHERE ts>=? AND status>=400').get(dayStart).c;
  const byProvider = db.prepare('SELECT provider_id, COUNT(*) reqs, COALESCE(SUM(credits),0) credits FROM usage WHERE ts>=? GROUP BY provider_id').all(dayStart);
  const byModel = db.prepare('SELECT public_model, COUNT(*) reqs, COALESCE(SUM(input_tokens),0) tin, COALESCE(SUM(output_tokens),0) tout FROM usage WHERE ts>=? GROUP BY public_model ORDER BY reqs DESC LIMIT 20').all(dayStart);
  res.json({ today: { ...today, errors: errToday }, total, byProvider, byModel });
});

// chart data for usage page: per-hour requests/tokens/errors for last N hours (default 24)
router.get('/usage/chart', (req, res) => {
  const hours = Math.min(168, Math.max(1, Number(req.query.hours || 24)));
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const rows = db.prepare(`
    SELECT (ts / 3600) * 3600 AS hour_bucket,
           COUNT(*) AS reqs,
           COALESCE(SUM(input_tokens),0) AS tin,
           COALESCE(SUM(output_tokens),0) AS tout,
           SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
           COALESCE(SUM(credits),0) AS credits
    FROM usage WHERE ts >= ? GROUP BY hour_bucket ORDER BY hour_bucket`).all(since);
  // fill empty hours
  const byBucket = Object.fromEntries(rows.map(r => [r.hour_bucket, r]));
  const series = [];
  const nowHour = Math.floor(Date.now() / 1000 / 3600) * 3600;
  for (let h = nowHour - (hours - 1) * 3600; h <= nowHour; h += 3600) {
    const r = byBucket[h] || { reqs: 0, tin: 0, tout: 0, errors: 0, credits: 0 };
    series.push({ hour: h, label: new Date(h * 1000).toTimeString().slice(0, 5), ...r });
  }
  res.json({ hours, series });
});

// ---------- virtual models (统一模型) ----------
router.get('/virtual-models', (req, res) => {
  res.json(modelsCore.listVirtualModels());
});
router.post('/virtual-models', (req, res) => {
  try {
    const v = modelsCore.upsertVirtualModel(req.body || {});
    res.json({ ok: true, virtual: v });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/virtual-models/:name', (req, res) => {
  const existing = modelsCore.getVirtualModel(req.params.name);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const { targets, enabled, note } = req.body || {};
  try {
    const v = modelsCore.upsertVirtualModel({
      public_name: existing.public_name,
      targets: targets ?? JSON.parse(existing.targets),
      enabled: enabled === undefined ? existing.enabled : enabled,
      note: note ?? existing.note,
    });
    res.json({ ok: true, virtual: v });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/virtual-models/:name', (req, res) => {
  modelsCore.deleteVirtualModel(req.params.name);
  res.json({ ok: true });
});
// available regular models for building virtual targets (grouped by provider)
router.get('/virtual-models/targets', (req, res) => {
  res.json(modelsCore.listEnabledModelNames());
});

// ---------- mcp servers ----------
const mcp = require('./mcp');
router.get('/mcp', (req, res) => { res.json(mcp.listServers()); });
router.post('/mcp', (req, res) => {
  const { id, transport = 'stdio', command, args = [], env = {}, url, headers = {}, tool_filter = '*' } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    db.prepare('INSERT INTO mcp_servers(id,transport,command,args,env,url,headers,tool_filter) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, transport, command || null, JSON.stringify(args), JSON.stringify(env), url || null, JSON.stringify(headers), tool_filter);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/mcp/:id', (req, res) => {
  const s = mcp.getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const { enabled, command, args, env, url, headers, tool_filter } = req.body || {};
  db.prepare('UPDATE mcp_servers SET enabled=?, command=?, args=?, env=?, url=?, headers=?, tool_filter=? WHERE id=?')
    .run(enabled === undefined ? s.enabled : (enabled ? 1 : 0), command ?? s.command, JSON.stringify(args ?? s.args), JSON.stringify(env ?? s.env), url ?? s.url, JSON.stringify(headers ?? s.headers), tool_filter ?? s.tool_filter, s.id);
  res.json({ ok: true });
});
router.delete('/mcp/:id', (req, res) => { db.prepare('DELETE FROM mcp_servers WHERE id=?').run(req.params.id); res.json({ ok: true }); });
router.post('/mcp/:id/tools', async (req, res) => {
  const s = mcp.getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  try { await mcp.initialize(s); res.json({ tools: await mcp.listTools(s) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- settings ----------
router.get('/settings', (req, res) => {
  res.json({
    adminPasswordSet: !!getSetting('adminPassword', config.adminPassword),
    gatewayOpen: config.apiKeys.length === 0 && db.prepare('SELECT COUNT(*) c FROM apikeys').get().c === 0,
    logRetentionDays: config.logRetentionDays,
  });
});
router.put('/settings', (req, res) => {
  const { adminPassword } = req.body || {};
  if (adminPassword) setSetting('adminPassword', adminPassword);
  res.json({ ok: true });
});

// ---------- playground (admin test bench) ----------
router.post('/test/chat', async (req, res) => {
  const { model, messages, stream = false, apikey_id = null } = req.body || {};
  if (!model || !messages?.length) return res.status(400).json({ error: 'model and messages required' });
  const started = Date.now();
  const usageAcc = { input_tokens: 0, output_tokens: 0, credits: 0 };
  if (!stream) {
    let text = '';
    try {
      await engine.runChat({ publicModel: model, messages, source: 'test', apikeyId: apikey_id },
        (data) => {
          try {
            const j = JSON.parse(data);
            if (j.choices?.[0]?.delta?.content) text += j.choices[0].delta.content;
            if (j.choices?.[0]?.message?.content) text += j.choices[0].message.content;
            if (j.usage) { usageAcc.input_tokens = j.usage.prompt_tokens || usageAcc.input_tokens; usageAcc.output_tokens = j.usage.completion_tokens || usageAcc.output_tokens; }
          } catch {}
          return true;
        }, (u) => Object.assign(usageAcc, u));
      res.json({ ok: true, text, usage: usageAcc, latency_ms: Date.now() - started });
    } catch (e) { res.json({ ok: false, error: e.message, status: e.status, latency_ms: Date.now() - started }); }
    return;
  }
  // stream mode: NDJSON of raw events
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
  try {
    await engine.runChat({ publicModel: model, messages, source: 'test', apikeyId: apikey_id },
      (data) => { if (!res.writableEnded) { res.write(JSON.stringify({ raw: data }) + '\n'); } return true; },
      (u) => Object.assign(usageAcc, u));
    res.write(JSON.stringify({ done: true, usage: usageAcc, latency_ms: Date.now() - started }) + '\n');
    res.end();
  } catch (e) {
    if (!res.writableEnded) { res.write(JSON.stringify({ error: e.message }) + '\n'); res.end(); }
  }
});

// logs tail
router.get('/logs', (req, res) => {
  const file = path.join(config.logDir, 'dsh.log');
  if (!fs.existsSync(file)) return res.json({ lines: [] });
  const data = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  res.json({ lines: data.slice(-Number(req.query.size || 200)) });
});

module.exports = router;
