'use strict';
/**
 * Orchestrates one chat completion request end-to-end:
 *  route model -> acquire account -> call plugin.chat -> map errors -> record usage.
 * Streaming is delegated to the route handlers; this module yields normalized
 * upstream events so both OpenAI and Anthropic adapters can consume.
 */
const registry = require('./registry');
const accounts = require('./accounts');
const models = require('./models');
const logger = require('../logger');
const config = require('../config');

class UpstreamError extends Error {
  constructor(status, message, upstream) { super(message); this.status = status; this.upstream = upstream; }
}

/**
 * Run a chat request against the routed provider/account.
 * @param {object} opts { publicModel, messages, tools, params, source, apikeyId, signal }
 * @param {function} onEvent (sseDataString) => boolean  return false to stop consuming (client disconnected)
 * @param {function} onUsage ({input_tokens,output_tokens,credits})
 * @returns {number} latencyMs
 */
async function runChat(opts, onEvent, onUsage) {
  const started = Date.now();
  const routed = models.route(opts.publicModel);
  if (!routed || !routed.model) throw new UpstreamError(404, `model '${opts.publicModel}' not found`);
  const { model, account } = routed;
  if (!account) {
    throw new UpstreamError(503, `no healthy account available for provider '${model.provider_id}' (all cooling/invalid/disabled)`);
  }
  const plugin = registry.get(model.provider_id);
  if (!plugin) throw new UpstreamError(500, `provider plugin '${model.provider_id}' missing`);

  accounts.acquire(account.id);
  let usage = null;
  try {
    for await (const data of plugin.chat({
      account,
      upstreamModel: model.upstream_model,
      messages: opts.messages,
      tools: opts.tools,
      params: opts.params || {},
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
      publicModel: opts.publicModel, upstreamModel: model.upstream_model,
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
      publicModel: opts.publicModel, upstreamModel: model.upstream_model,
      inputTokens: usage?.input_tokens || 0, outputTokens: usage?.output_tokens || 0,
      credits: usage?.credits || 0, multiplier: model.multiplier || 1,
      latencyMs: latency, status, error: err.message, source: opts.source,
    });
    logger.error(`chat failed [${model.provider_id}/${model.upstream_model}] via account#${account.id}: ${err.message}`);
    throw new UpstreamError(status >= 400 && status < 600 ? status : 502, err.message, err.upstream);
  } finally {
    accounts.release(account.id);
  }
}

module.exports = { runChat, UpstreamError };
