'use strict';
/**
 * OpenAI-compatible gateway:
 *   POST /v1/chat/completions   (stream + non-stream)
 *   GET  /v1/models
 *   POST /v1/completions        (legacy, non-stream basic support)
 * Auth: Bearer key checked against apikeys table (or open if no keys configured).
 */
const express = require('express');
const { v4: uuid } = require('crypto');
const crypto = require('crypto');
const engine = require('../core/engine');
const modelsCore = require('../core/models');
const { normalizeMessages } = require('../core/messages');
const { db } = require('../store');
const { sseInit } = require('../utils/sse');

const router = express.Router();

// ---------- auth ----------
function authApiKey(req, res, next) {
  const cfgKeys = (require('../config')).apiKeys;
  const header = req.headers['authorization'] || '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] || req.query.key || '');
  // db keys
  let row = null;
  if (key) row = db.prepare('SELECT * FROM apikeys WHERE key=?').get(key);
  if (!row && cfgKeys.length && cfgKeys.includes(key)) {
    row = { id: null, key, name: 'env-key', enabled: 1, allowed_models: '*', rpm_limit: 0, daily_limit: 0 };
  }
  if (!row && !key && (cfgKeys.length === 0 && db.prepare('SELECT COUNT(*) c FROM apikeys').get().c === 0)) {
    req.apikey = { id: null, name: 'anonymous', allowed_models: '*' };
    return next(); // open gateway mode
  }
  if (!row || !row.enabled) return res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } });
  req.apikey = row;
  next();
}

function checkModelAllowed(req, res, next) {
  const allowed = req.apikey?.allowed_models || '*';
  const model = req.body?.model;
  if (allowed !== '*' && model && !allowed.split(',').map(s => s.trim()).filter(Boolean).includes(model)) {
    return res.status(403).json({ error: { message: `model '${model}' not allowed for this key`, type: 'invalid_request_error' } });
  }
  next();
}

router.use(authApiKey);

// ---------- /v1/models ----------
router.get('/models', (req, res) => {
  const list = modelsCore.listPublicModels();
  const allowed = req.apikey?.allowed_models || '*';
  const data = list
    .filter(m => allowed === '*' || allowed.split(',').map(s => s.trim()).includes(m.public_name))
    .map(m => ({ id: m.public_name, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: m.provider_id }));
  res.json({ object: 'list', data });
});
router.get('/models/:id', (req, res) => {
  const m = modelsCore.listPublicModels().find(x => x.public_name === req.params.id);
  if (!m) return res.status(404).json({ error: { message: 'model not found', type: 'invalid_request_error' } });
  res.json({ id: m.public_name, object: 'model', created: 0, owned_by: m.provider_id });
});

// ---------- /v1/chat/completions ----------
router.post('/chat/completions', checkModelAllowed, async (req, res) => {
  const body = req.body || {};
  const { model, stream = false, messages, tools, tool_choice, temperature, top_p, max_tokens, max_completion_tokens } = body;
  if (!model || !Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: { message: 'model and messages are required', type: 'invalid_request_error' } });
  }
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  const normMessages = normalizeMessages(messages);
  const params = { temperature, top_p, max_tokens: max_tokens || max_completion_tokens, tool_choice };

  const usageAcc = { input_tokens: 0, output_tokens: 0, credits: 0 };

  if (!stream) {
    try {
      let text = ''; let toolCalls = []; let finishReason = 'stop'; let reasoning = '';
      await engine.runChat({
        publicModel: model, messages: normMessages, tools, params,
        source: 'openai', apikeyId: req.apikey.id, signal: req.abortSignal,
      }, (data) => {
        const ev = parseUpstreamEvent(data);
        if (!ev) return true;
        if (ev.usage) Object.assign(usageAcc, ev.usage);
        const d = ev.delta;
        if (d?.content) text += d.content;
        if (d?.reasoning) reasoning += d.reasoning;
        if (d?.tool_calls) toolCalls = mergeToolCalls(toolCalls, d.tool_calls);
        if (ev.finish_reason) finishReason = ev.finish_reason;
        return true;
      }, (u) => Object.assign(usageAcc, u));
      const message = { role: 'assistant', content: text || null };
      if (reasoning) message.reasoning_content = reasoning;
      if (toolCalls.length) { message.tool_calls = toolCalls; message.content = message.content || null; }
      return res.json({
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : finishReason }],
        usage: {
          prompt_tokens: usageAcc.input_tokens, completion_tokens: usageAcc.output_tokens, total_tokens: usageAcc.input_tokens + usageAcc.output_tokens,
          ...(usageAcc.credits ? { credits: usageAcc.credits } : {}),
        },
      });
    } catch (err) {
      return res.status(err.status || 500).json({ error: { message: err.message, type: 'upstream_error' } });
    }
  }

  // streaming
  const sse = sseInit(res);
  let toolCalls = []; let finishReason = null; let sentRole = false;
  const sendChunk = (delta, extra = {}) => {
    if (sse.isClosed) return;
    if (!sentRole) { delta.role = 'assistant'; sentRole = true; }
    sse.chunk({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: extra.finish_reason ?? null }], ...(extra.usage ? { usage: extra.usage } : {}) });
  };
  try {
    await engine.runChat({
      publicModel: model, messages: normMessages, tools, params,
      source: 'openai', apikeyId: req.apikey.id, signal: req.abortSignal,
    }, (data) => {
      if (sse.isClosed) return false;
      const ev = parseUpstreamEvent(data);
      if (!ev) return true;
      if (ev.usage) Object.assign(usageAcc, ev.usage);
      const d = ev.delta || {};
      if (ev.done) { finishReason = ev.finish_reason || finishReason || 'stop'; return true; }
      sendChunk({ ...(d.content != null ? { content: d.content } : {}), ...(d.reasoning != null ? { reasoning_content: d.reasoning } : {}), ...(d.tool_calls ? { tool_calls: d.tool_calls } : {}) });
      return true;
    }, (u) => Object.assign(usageAcc, u));
    if (toolCalls.length) { /* tool calls merged in deltas already */ }
    if (!sse.isClosed) {
      sendChunk({}, { finish_reason: finishReason || 'stop' });
      sse.chunk({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason || 'stop' }],
        usage: { prompt_tokens: usageAcc.input_tokens, completion_tokens: usageAcc.output_tokens, total_tokens: usageAcc.input_tokens + usageAcc.output_tokens },
      });
      sse.end();
    }
  } catch (err) {
    if (!sse.isClosed) {
      sse.chunk({ error: { message: err.message, type: 'upstream_error', code: err.status } });
      sse.end();
    }
  }
});

// ---------- /v1/completions (legacy) ----------
router.post('/completions', checkModelAllowed, async (req, res) => {
  const { model, prompt, stream = false, max_tokens = 256 } = req.body || {};
  if (!model || prompt == null) return res.status(400).json({ error: { message: 'model and prompt required', type: 'invalid_request_error' } });
  const promptText = Array.isArray(prompt) ? prompt.join('\n') : String(prompt);
  const messages = [{ role: 'user', content: promptText }];
  if (!stream) {
    let text = '';
    const usageAcc = { input_tokens: 0, output_tokens: 0 };
    try {
      await engine.runChat({ publicModel: model, messages, params: { max_tokens }, source: 'openai', apikeyId: req.apikey.id },
        (data) => { const ev = parseUpstreamEvent(data); if (ev?.delta?.content) text += ev.delta.content; return true; },
        (u) => Object.assign(usageAcc, u));
      return res.json({ id: 'cmpl-' + crypto.randomBytes(10).toString('hex'), object: 'text_completion', created: Math.floor(Date.now() / 1000), model, choices: [{ text, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: usageAcc.input_tokens, completion_tokens: usageAcc.output_tokens, total_tokens: usageAcc.input_tokens + usageAcc.output_tokens } });
    } catch (err) { return res.status(err.status || 500).json({ error: { message: err.message, type: 'upstream_error' } }); }
  }
  const sse = sseInit(res);
  try {
    await engine.runChat({ publicModel: model, messages, params: { max_tokens }, source: 'openai', apikeyId: req.apikey.id },
      (data) => {
        if (sse.isClosed) return false;
        const ev = parseUpstreamEvent(data);
        if (ev?.delta?.content) sse.chunk({ id: 'cmpl-x', object: 'text_completion.chunk', model, choices: [{ text: ev.delta.content, index: 0, finish_reason: null }] });
        return true;
      }, null);
    sse.chunk({ id: 'cmpl-x', object: 'text_completion.chunk', model, choices: [{ text: '', index: 0, finish_reason: 'stop' }] });
    sse.end();
  } catch (err) { if (!sse.isClosed) { sse.chunk({ error: { message: err.message } }); sse.end(); } }
});

// ---------- upstream event normalization ----------
// Provider plugins yield raw 'data:' strings. Each plugin may provide its own
// event parser via plugin.parseEvent; default assumes OpenAI-like chunks.
function parseUpstreamEvent(data) {
  let j;
  try { j = JSON.parse(data); } catch { return null; }
  if (j === '[DONE]' || data === '[DONE]') return { done: true };
  // OpenAI style
  if (j.choices?.[0]) {
    const c = j.choices[0];
    const d = c.delta || c.message || {};
    return { delta: { content: d.content, reasoning: d.reasoning_content ?? d.reasoning, tool_calls: d.tool_calls }, finish_reason: c.finish_reason, usage: j.usage ? { input_tokens: j.usage.prompt_tokens, output_tokens: j.usage.completion_tokens, credits: j.usage.credits } : undefined, done: false };
  }
  // Anthropic-ish style (for plugins that normalize upstreams to it)
  if (j.type === 'content_block_delta' && j.delta) {
    return { delta: { content: j.delta.text, reasoning: j.delta.thinking }, done: false };
  }
  if (j.type === 'message_start' && j.message?.usage) {
    return { delta: {}, usage: { input_tokens: j.message.usage.input_tokens, output_tokens: 0 }, done: false };
  }
  if (j.type === 'message_delta' && j.usage) {
    return { delta: {}, usage: { output_tokens: j.usage.output_tokens }, done: false };
  }
  if (j.type === 'message_stop') return { done: true };
  return null;
}

function mergeToolCalls(acc, incoming) {
  for (const tc of incoming) {
    const idx = tc.index ?? acc.length;
    if (!acc[idx]) acc[idx] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
    if (tc.id) acc[idx].id = tc.id;
    if (tc.function?.name) acc[idx].function.name += tc.function.name;
    if (tc.function?.arguments) acc[idx].function.arguments += tc.function.arguments;
  }
  return acc;
}

module.exports = router;
