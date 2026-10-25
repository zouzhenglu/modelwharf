'use strict';
/**
 * Orchestrates one chat completion request end-to-end:
 *  route model -> acquire account -> call plugin.chat -> map errors -> record usage.
 *
 * Two model kinds:
 *  - regular: models table row, routed to one provider's account pool
 *  - virtual: virtual_models row with ordered targets across providers; on target
 *    failure (upstream error / no healthy account) the next target is tried.
 */
const registry = require('./registry');
const accounts = require('./accounts');
const models = require('./models');
const { parseModelSuffix, reasoningParamsFor } = require('./messages');
const logger = require('../logger');
const config = require('../config');
const { db } = require('../store');

class UpstreamError extends Error {
  constructor(status, message, upstream) { super(message); this.status = status; this.upstream = upstream; }
}

// ---------- virtual target selection (负载均衡策略) ----------
// target key: provider_id/public_name — in-flight counter shared by chat + embeddings
const targetInflight = new Map();
function targetKey(t) { return `${t.provider_id}/${t.public_name}`; }

/**
 * Order a virtual model's enabled targets per its strategy:
 *  - 'priority'   (default): strict ascending priority, failover in that order (旧行为)
 *  - 'weighted'   : weighted-random permutation (target.weight, default 100); failover walks the permutation
 *  - 'least_conn' : fewest in-flight requests first (ties broken by priority, then id)
 */
function orderTargets(virtual) {
  const targets = JSON.parse(virtual.targets || '[]').filter(t => t.enabled !== false);
  const strategy = virtual.strategy || 'priority';
  if (!targets.length) return [];
  if (strategy === 'weighted') {
    const pool = targets.map(t => ({ t, w: Math.max(1, Number(t.weight) || 100) }));
    const out = [];
    while (pool.length) {
      const total = pool.reduce((s, x) => s + x.w, 0);
      let r = Math.random() * total;
      let i = 0;
      for (; i < pool.length - 1; i++) { r -= pool[i].w; if (r <= 0) break; }
      out.push(pool.splice(i, 1)[0].t);
    }
    return out;
  }
  const sorted = [...targets].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || targetKey(a).localeCompare(targetKey(b)));
  if (strategy === 'least_conn') {
    return sorted.sort((a, b) => (targetInflight.get(targetKey(a)) || 0) - (targetInflight.get(targetKey(b)) || 0));
  }
  return sorted;
}

function acquireTarget(t) { const k = targetKey(t); targetInflight.set(k, (targetInflight.get(k) || 0) + 1); }
function releaseTarget(t) { const k = targetKey(t); targetInflight.set(k, Math.max(0, (targetInflight.get(k) || 1) - 1)); }

/**
 * Run a chat request against the routed provider/account (or virtual chain).
 * @param {object} opts { publicModel, messages, tools, params, source, apikeyId, signal }
 * @param {function} onEvent (sseDataString) => boolean  return false to stop consuming (client disconnected)
 * @param {function} onUsage ({input_tokens,output_tokens,credits})
 */
async function runChat(opts, onEvent, onUsage) {
  const started = Date.now();
  // 客户端可能原样回传 /v1/models 里带费率标签的 id（`model ·免费` / `model ·x0.03`）——剥掉再路由
  if (opts.publicModel) {
    const clean = models.stripRateTag(opts.publicModel);
    if (clean !== opts.publicModel) opts = { ...opts, publicModel: clean };
  }
  // normalize once here so every entry point (openai/anthropic/responses/admin-test)
  // gets canonical messages with .text set
  if (opts.messages?.length && opts.messages[0].text === undefined && opts.messages[0].content !== undefined) {
    opts = { ...opts, messages: require('./messages').normalizeMessages(opts.messages) };
  }
  // forceAccountId (playground per-account testing) -> concrete account object
  if (opts.forceAccountId && !opts.forceAccount) {
    opts.forceAccount = accounts.getAccount(opts.forceAccountId) || undefined;
    if (opts.forceAccount && opts.publicModel) {
      // the model row must belong to the forced account's provider for routing to match;
      // resolve by (provider, model name) when the public name exists on other providers too
      const row = db.prepare('SELECT * FROM models WHERE provider_id=? AND public_name=? AND enabled=1').get(opts.forceAccount.provider_id, opts.publicModel);
      if (row) opts.forceModel = row;
    }
  }
  let virtual = models.getVirtualModel(opts.publicModel);
  if (!virtual) {
    // 统一模型同样吃 -think 系列后缀：剥掉后缀再查一次虚拟表
    const { baseModel: vBase } = parseModelSuffix(opts.publicModel);
    if (vBase && vBase !== opts.publicModel) virtual = models.getVirtualModel(vBase);
  }
  if (virtual) {
    if (!virtual.enabled) throw new UpstreamError(404, `virtual model '${opts.publicModel}' is disabled`);
    const targets = orderTargets(virtual);
    if (!targets.length) throw new UpstreamError(503, `virtual model '${opts.publicModel}' has no enabled targets`);
    let lastErr = null;
    for (const t of targets) {
      if (opts.forceAccount && t.provider_id !== opts.forceAccount.provider_id) continue; // per-account test: restrict to that provider
      const row = db.prepare('SELECT * FROM models WHERE provider_id=? AND public_name=? AND enabled=1').get(t.provider_id, t.public_name);
      if (!row) { lastErr = new UpstreamError(404, `target ${t.provider_id}/${t.public_name} missing or disabled`); continue; }
      acquireTarget(t);
      try {
        return await runSingle(opts, row, onEvent, onUsage, started, opts.publicModel);
      } catch (err) {
        lastErr = err;
        logger.warn(`virtual '${opts.publicModel}' target ${t.provider_id}/${t.public_name} failed: ${err.message} — trying next`);
      } finally {
        releaseTarget(t);
      }
    }
    throw lastErr || new UpstreamError(502, 'all virtual targets failed');
  }
  // exact name first; if not found, try the base name after stripping a reasoning suffix
  // (-think / -think-high / -xhigh / -nothink) so suffix conventions work on any model
  let publicName = opts.publicModel;
  let model = opts.forceModel || db.prepare('SELECT * FROM models WHERE public_name=? AND enabled=1').get(publicName);
  if (!model) {
    const { baseModel, reasoning } = parseModelSuffix(publicName);
    if (reasoning !== undefined && baseModel) {
      model = db.prepare('SELECT * FROM models WHERE public_name=? AND enabled=1').get(baseModel);
      if (model) publicName = baseModel;
    }
  }
  if (!model && opts.forceAccount) {
    // forced account but model name unknown on it: fall back to its cheapest enabled model
    model = db.prepare('SELECT * FROM models WHERE provider_id=? AND enabled=1 ORDER BY multiplier ASC LIMIT 1').get(opts.forceAccount.provider_id);
  }
  if (!model) {
    const v = models.getVirtualModel(opts.publicModel); // convenience: tolerate virtual lookup mismatch
    if (!v) throw new UpstreamError(404, `model '${opts.publicModel}' not found`);
  }
  return runSingle(opts, model, onEvent, onUsage, started, opts.publicModel);
}

/** execute against one concrete model row */
async function runSingle(opts, model, onEvent, onUsage, started, usagePublicModel) {
  // forceAccount (probe path) bypasses pool routing; normal path uses the pool
  const account = opts.forceAccount && opts.forceAccount.provider_id === model.provider_id
    ? opts.forceAccount
    : accounts.pickAccount(model.provider_id);
  if (!account) {
    throw new UpstreamError(503, `no healthy account available for provider '${model.provider_id}' (all cooling/invalid/disabled)`);
  }
  const plugin = registry.get(model.provider_id);
  if (!plugin) throw new UpstreamError(500, `provider plugin '${model.provider_id}' missing`);

  // model-name suffix conventions (-think / -think-high / -xhigh / -nothink) + provider mapping.
  // When the requested public name had a suffix, strip it for the upstream call if the
  // stored upstream_model equals the suffixed public name (i.e. suffix was the only diff),
  // or if the upstream model doesn't exist but the base does.
  const { baseModel, reasoning: suffixReasoning } = parseModelSuffix(usagePublicModel || opts.publicModel);
  let upstreamModel = model.upstream_model;
  if (suffixReasoning !== undefined && baseModel && baseModel !== (usagePublicModel || opts.publicModel)) {
    if (upstreamModel === (usagePublicModel || opts.publicModel)) upstreamModel = baseModel;
  }
  // reasoning 来源优先级: 模型名后缀 > 请求体映射（如 Anthropic thinking.budget_tokens）
  const reasoning = suffixReasoning !== undefined ? suffixReasoning : opts.params?.reasoning;
  const extraParams = reasoningParamsFor(model.provider_id, reasoning);
  const { reasoning: _reasoning, ...safeParams } = opts.params || {};

  accounts.acquire(account.id);
  let usage = null;
  try {
    for await (const data of plugin.chat({
      account,
      upstreamModel,
      messages: opts.messages,
      tools: opts.tools,
      params: { ...safeParams, ...extraParams },
      signal: opts.signal,
      onUsage: (u) => { usage = usage || {}; Object.assign(usage, u); },
    })) {
      const keep = onEvent(data);
      if (!keep) break;
    }
    if (usage && onUsage) onUsage(usage);
    accounts.reportSuccess(account.id);
    const latency = Date.now() - started;
    models.recordUsage({
      apikeyId: opts.apikeyId, providerId: model.provider_id, accountId: account.id,
      publicModel: usagePublicModel, upstreamModel,
      inputTokens: usage?.input_tokens || 0, outputTokens: usage?.output_tokens || 0,
      credits: usage?.credits || 0, multiplier: model.multiplier || 1,
      latencyMs: latency, status: 200, source: opts.source,
    });
    return { latencyMs: latency, account, model, usage };
  } catch (err) {
    const latency = Date.now() - started;
    const status = err.status || 502;
    accounts.reportFailure(account.id, err);
    models.recordUsage({
      apikeyId: opts.apikeyId, providerId: model.provider_id, accountId: account.id,
      publicModel: usagePublicModel, upstreamModel,
      inputTokens: usage?.input_tokens || 0, outputTokens: usage?.output_tokens || 0,
      credits: usage?.credits || 0, multiplier: model.multiplier || 1,
      latencyMs: latency, status, error: err.message, source: opts.source,
    });
    logger.error(`chat failed [${model.provider_id}/${upstreamModel}] via account#${account.id}: ${err.message}`);
    throw new UpstreamError(status >= 400 && status < 600 ? status : 502, err.message, err.upstream);
  } finally {
    accounts.release(account.id);
  }
}

// ---------- embeddings ----------
/**
 * Run an embeddings request: route model -> account -> plugin.embeddings.
 * Virtual models fail over across targets like chat (501 "unsupported" also moves on).
 * Plugins without an embeddings() implementation get a clear 501.
 * @param {object} opts { publicModel, input, params, source, apikeyId, signal }
 * @returns {object} OpenAI-style { data, model, usage }
 */
async function runEmbeddings(opts) {
  const started = Date.now();
  // 同 runChat：剥掉客户端回传的费率标签再路由
  if (opts.publicModel) {
    const clean = models.stripRateTag(opts.publicModel);
    if (clean !== opts.publicModel) opts = { ...opts, publicModel: clean };
  }
  let virtual = models.getVirtualModel(opts.publicModel);
  if (!virtual) {
    const { baseModel: vBase } = parseModelSuffix(opts.publicModel);
    if (vBase && vBase !== opts.publicModel) virtual = models.getVirtualModel(vBase);
  }
  if (virtual) {
    if (!virtual.enabled) throw new UpstreamError(404, `virtual model '${opts.publicModel}' is disabled`);
    const targets = orderTargets(virtual);
    if (!targets.length) throw new UpstreamError(503, `virtual model '${opts.publicModel}' has no enabled targets`);
    let lastErr = null;
    for (const t of targets) {
      const row = db.prepare('SELECT * FROM models WHERE provider_id=? AND public_name=? AND enabled=1').get(t.provider_id, t.public_name);
      if (!row) { lastErr = new UpstreamError(404, `target ${t.provider_id}/${t.public_name} missing or disabled`); continue; }
      acquireTarget(t);
      try {
        return await runSingleEmbeddings(opts, row, started);
      } catch (err) {
        lastErr = err;
        logger.warn(`virtual '${opts.publicModel}' embeddings target ${t.provider_id}/${t.public_name} failed: ${err.message} — trying next`);
      } finally {
        releaseTarget(t);
      }
    }
    throw lastErr || new UpstreamError(502, 'all virtual targets failed');
  }
  let publicName = opts.publicModel;
  let model = db.prepare('SELECT * FROM models WHERE public_name=? AND enabled=1').get(publicName);
  if (!model) {
    const { baseModel } = parseModelSuffix(publicName);
    if (baseModel && baseModel !== publicName) {
      model = db.prepare('SELECT * FROM models WHERE public_name=? AND enabled=1').get(baseModel);
      if (model) publicName = baseModel;
    }
  }
  if (!model) throw new UpstreamError(404, `model '${opts.publicModel}' not found`);
  return runSingleEmbeddings(opts, model, started);
}

async function runSingleEmbeddings(opts, model, started) {
  const plugin = registry.get(model.provider_id);
  if (!plugin) throw new UpstreamError(500, `provider plugin '${model.provider_id}' missing`);
  // 不支持 embeddings 的平台直接 501（不占账号、不计失败），错误信息说清楚
  if (typeof plugin.embeddings !== 'function') {
    throw new UpstreamError(501, `provider '${model.provider_id}' does not support embeddings — /v1/embeddings 仅 OpenAI 兼容上游（openai-compat / 官方厂商 / ollama）可用`);
  }
  const account = accounts.pickAccount(model.provider_id);
  if (!account) throw new UpstreamError(503, `no healthy account available for provider '${model.provider_id}' (all cooling/invalid/disabled)`);
  accounts.acquire(account.id);
  try {
    const out = await plugin.embeddings({
      account,
      upstreamModel: model.upstream_model,
      input: opts.input,
      params: opts.params || {},
      signal: opts.signal,
    }) || {};
    accounts.reportSuccess(account.id);
    models.recordUsage({
      apikeyId: opts.apikeyId, providerId: model.provider_id, accountId: account.id,
      publicModel: opts.publicModel, upstreamModel: model.upstream_model,
      inputTokens: out.usage?.prompt_tokens || 0, outputTokens: 0, credits: 0,
      multiplier: model.multiplier || 1, latencyMs: Date.now() - started, status: 200, source: opts.source,
    });
    return out;
  } catch (err) {
    const status = err.status || 502;
    accounts.reportFailure(account.id, err);
    models.recordUsage({
      apikeyId: opts.apikeyId, providerId: model.provider_id, accountId: account.id,
      publicModel: opts.publicModel, upstreamModel: model.upstream_model,
      inputTokens: 0, outputTokens: 0, credits: 0, multiplier: model.multiplier || 1,
      latencyMs: Date.now() - started, status, error: err.message, source: opts.source,
    });
    logger.error(`embeddings failed [${model.provider_id}/${model.upstream_model}] via account#${account.id}: ${err.message}`);
    throw new UpstreamError(status >= 400 && status < 600 ? status : 502, err.message, err.upstream);
  } finally {
    accounts.release(account.id);
  }
}

module.exports = { runChat, runSingle, runEmbeddings, UpstreamError };
