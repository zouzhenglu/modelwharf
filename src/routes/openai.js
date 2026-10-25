'use strict';
/**
 * OpenAI-compatible gateway:
 *   POST /v1/chat/completions   (stream + non-stream)
 *   GET  /v1/models
 *   POST /v1/completions        (legacy, non-stream basic support)
 *   POST /v1/embeddings         (OpenAI-compatible upstreams only)
 * Auth: Bearer key checked against apikeys table (or open if no keys configured).
 */
const express = require('express');
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
  // key 白名单存的是干净的 public_name —— 客户端回传带费率标签的 id（`·免费`/`·x0.03`）时按剥后名比较
  if (allowed !== '*' && model && !allowed.split(',').map(s => s.trim()).filter(Boolean).includes(modelsCore.stripRateTag(model))) {
    return res.status(403).json({ error: { message: `model '${model}' not allowed for this key`, type: 'invalid_request_error' } });
  }
  next();
}

router.use(authApiKey);

// ---------- /v1/models ----------
// id 带费率标签（`·免费` / `·x0.03`），同一模型在模型选择器里能区分免费/计费版本；
// 标签是展示用的别名，网关在路由与 key 白名单校验时都会剥掉（engine / checkModelAllowed）。
router.get('/models', (req, res) => {
  const list = modelsCore.listPublicModels();
  const allowed = req.apikey?.allowed_models || '*';
  const data = list
    .filter(m => allowed === '*' || allowed.split(',').map(s => s.trim()).includes(m.public_name))
    .map(m => ({ id: modelsCore.decoratePublicModel(m.public_name, m), object: 'model', created: Math.floor(Date.now() / 1000), owned_by: m.provider_id, x_free: !!m.is_free, x_multiplier: m.multiplier ?? null }));
  res.json({ object: 'list', data });
});
router.get('/models/:id', (req, res) => {
  const clean = modelsCore.stripRateTag(req.params.id);
  const m = modelsCore.listPublicModels().find(x => x.public_name === clean || x.public_name === req.params.id);
  if (!m) return res.status(404).json({ error: { message: 'model not found', type: 'invalid_request_error' } });
  res.json({ id: modelsCore.decoratePublicModel(m.public_name, m), object: 'model', created: 0, owned_by: m.provider_id, x_free: !!m.is_free, x_multiplier: m.multiplier ?? null });
});

// 客户端可透传给 OpenAI 兼容上游的采样参数（逆向平台插件各自白名单，多收无害）
function passthroughParams(body) {
  const p = {};
  if (body.stop !== undefined) p.stop = body.stop;
  if (body.seed !== undefined) p.seed = body.seed;
  if (body.presence_penalty !== undefined) p.presence_penalty = body.presence_penalty;
  if (body.frequency_penalty !== undefined) p.frequency_penalty = body.frequency_penalty;
  if (body.logprobs !== undefined) p.logprobs = body.logprobs;
  if (body.top_logprobs !== undefined) p.top_logprobs = body.top_logprobs;
  if (body.n !== undefined) p.n = body.n;
  return p;
}

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
  const params = { temperature, top_p, max_tokens: max_tokens || max_completion_tokens, tool_choice, ...passthroughParams(body) };

  const usageAcc = { input_tokens: 0, output_tokens: 0, credits: 0 };

  if (!stream) {
    try {
      // n>1: accumulate per choice index so multiple choices come back intact
      const choicesMap = new Map();
      const getChoice = (idx) => {
        if (!choicesMap.has(idx)) choicesMap.set(idx, { text: '', reasoning: '', toolCalls: [], finishReason: null, logprobs: null });
        return choicesMap.get(idx);
      };
      await engine.runChat({
        publicModel: model, messages: normMessages, tools, params,
        source: 'openai', apikeyId: req.apikey.id, signal: req.abortSignal,
      }, (data) => {
        const ev = parseUpstreamEvent(data);
        if (!ev) return true;
        if (ev.usage) Object.assign(usageAcc, ev.usage);
        for (const c of ev.choices || []) {
          const ch = getChoice(c.index ?? 0);
          const d = c.delta || {};
          if (d.content) ch.text += d.content;
          if (d.reasoning) ch.reasoning += d.reasoning;
          if (d.tool_calls) ch.toolCalls = mergeToolCalls(ch.toolCalls, d.tool_calls);
          if (c.logprobs) ch.logprobs = c.logprobs;
          if (c.finish_reason) ch.finishReason = c.finish_reason;
        }
        return true;
      }, (u) => Object.assign(usageAcc, u));
      const order = [...choicesMap.entries()].sort((a, b) => a[0] - b[0]);
      const choices = (order.length ? order : [[0, getChoice(0)]]).map(([idx, ch]) => {
        const message = { role: 'assistant', content: ch.text || null };
        if (ch.reasoning) message.reasoning_content = ch.reasoning;
        if (ch.toolCalls.length) { message.tool_calls = ch.toolCalls; message.content = message.content || null; }
        return {
          index: idx, message,
          finish_reason: ch.toolCalls.length ? 'tool_calls' : (ch.finishReason || 'stop'),
          ...(ch.logprobs ? { logprobs: ch.logprobs } : {}),
        };
      });
      return res.json({
        id, object: 'chat.completion', created, model, choices,
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
  const seenIdx = new Set();
  const finished = new Set();
  const sendChunk = (delta, index = 0, finishReason = null, usage = null) => {
    if (sse.isClosed) return;
    if (!seenIdx.has(index) && !finishReason) { delta.role = 'assistant'; }
    seenIdx.add(index);
    if (finishReason) finished.add(index);
    sse.chunk({ id, object: 'chat.completion.chunk', created, model, choices: [{ index, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) });
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
      if (ev.done) return true;
      for (const c of ev.choices || []) {
        const idx = c.index ?? 0;
        const d = c.delta || {};
        sendChunk({
          ...(d.content != null ? { content: d.content } : {}),
          ...(d.reasoning != null ? { reasoning_content: d.reasoning } : {}),
          ...(d.tool_calls ? { tool_calls: d.tool_calls } : {}),
        }, idx, c.finish_reason || null);
      }
      return true;
    }, (u) => Object.assign(usageAcc, u));
    if (!sse.isClosed) {
      // finish any choice the upstream never closed, then a usage-only chunk
      for (const idx of (seenIdx.size ? [...seenIdx].sort((a, b) => a - b) : [0])) {
        if (!finished.has(idx)) sendChunk({}, idx, 'stop');
      }
      sse.chunk({
        id, object: 'chat.completion.chunk', created, model,
        choices: seenIdx.size <= 1 ? [{ index: 0, delta: {}, finish_reason: null }] : [],
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
  const { model, prompt, stream = false, max_tokens = 256, temperature, top_p, n } = req.body || {};
  if (!model || prompt == null) return res.status(400).json({ error: { message: 'model and prompt required', type: 'invalid_request_error' } });
  const promptText = Array.isArray(prompt) ? prompt.join('\n') : String(prompt);
  const messages = [{ role: 'user', content: promptText }];
  const params = { max_tokens, temperature, top_p, ...passthroughParams(req.body || {}) };
  if (!stream) {
    // n>1: per-index accumulate so multiple completions come back intact
    const texts = new Map();
    const usageAcc = { input_tokens: 0, output_tokens: 0 };
    try {
      await engine.runChat({ publicModel: model, messages, params, source: 'openai', apikeyId: req.apikey.id },
        (data) => {
          const ev = parseUpstreamEvent(data);
          if (!ev) return true;
          for (const c of ev.choices || []) {
            const idx = c.index ?? 0;
            if (c.delta?.content) texts.set(idx, (texts.get(idx) || '') + c.delta.content);
          }
          return true;
        },
        (u) => Object.assign(usageAcc, u));
      const order = [...texts.entries()].sort((a, b) => a[0] - b[0]);
      const choices = (order.length ? order : [[0, '']]).map(([idx, text]) => ({ text, index: idx, finish_reason: 'stop' }));
      return res.json({ id: 'cmpl-' + crypto.randomBytes(10).toString('hex'), object: 'text_completion', created: Math.floor(Date.now() / 1000), model, choices, usage: { prompt_tokens: usageAcc.input_tokens, completion_tokens: usageAcc.output_tokens, total_tokens: usageAcc.input_tokens + usageAcc.output_tokens } });
    } catch (err) { return res.status(err.status || 500).json({ error: { message: err.message, type: 'upstream_error' } }); }
  }
  if (Number(n) > 1) {
    return res.status(400).json({ error: { message: 'streaming with n>1 is not supported on legacy /v1/completions — use /v1/chat/completions', type: 'invalid_request_error' } });
  }
  const sse = sseInit(res);
  try {
    await engine.runChat({ publicModel: model, messages, params, source: 'openai', apikeyId: req.apikey.id },
      (data) => {
        if (sse.isClosed) return false;
        const ev = parseUpstreamEvent(data);
        if (ev?.choices?.[0]?.delta?.content) sse.chunk({ id: 'cmpl-x', object: 'text_completion.chunk', model, choices: [{ text: ev.choices[0].delta.content, index: 0, finish_reason: null }] });
        return true;
      }, null);
    sse.chunk({ id: 'cmpl-x', object: 'text_completion.chunk', model, choices: [{ text: '', index: 0, finish_reason: 'stop' }] });
    sse.end();
  } catch (err) { if (!sse.isClosed) { sse.chunk({ error: { message: err.message } }); sse.end(); } }
});

// ---------- /v1/embeddings ----------
// 仅 OpenAI 兼容上游（openai-compat / 官方厂商 / ollama）支持；其余平台返回 501
router.post('/embeddings', checkModelAllowed, async (req, res) => {
  const { model, input, dimensions, encoding_format, user } = req.body || {};
  if (!model || input == null) {
    return res.status(400).json({ error: { message: 'model and input are required', type: 'invalid_request_error' } });
  }
  try {
    const out = await engine.runEmbeddings({
      publicModel: model, input,
      params: { dimensions, encoding_format, user },
      source: 'openai', apikeyId: req.apikey.id, signal: req.abortSignal,
    });
    const promptTokens = out.usage?.prompt_tokens || out.usage?.total_tokens || 0;
    return res.json({
      object: 'list',
      data: (out.data || []).map((d, i) => ({ object: 'embedding', embedding: d.embedding, index: d.index ?? i })),
      model,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: { message: err.message, type: err.status === 501 ? 'invalid_request_error' : 'upstream_error' } });
  }
});

// ---------- upstream event normalization ----------
// Provider plugins yield raw 'data:' strings. Each plugin may provide its own
// event parser via plugin.parseEvent; default assumes OpenAI-like chunks.
// Returns { choices: [{index, delta, finish_reason, logprobs}], usage, done } or null.
function parseUpstreamEvent(data) {
  if (data === '[DONE]') return { done: true };
  let j;
  try { j = JSON.parse(data); } catch { return null; }
  // OpenAI style (multi-choice aware)
  if (Array.isArray(j.choices)) {
    const usage = j.usage ? { input_tokens: j.usage.prompt_tokens, output_tokens: j.usage.completion_tokens, credits: j.usage.credits } : undefined;
    if (!j.choices.length) return { choices: [], usage, done: false };
    return {
      choices: j.choices.map((c, i) => {
        const d = c.delta || c.message || {};
        return {
          index: c.index ?? i,
          delta: { content: d.content, reasoning: d.reasoning_content ?? d.reasoning, tool_calls: d.tool_calls },
          finish_reason: c.finish_reason,
          logprobs: c.logprobs ?? undefined,
        };
      }),
      usage, done: false,
    };
  }
  // Anthropic-ish style (for plugins that normalize upstreams to it)
  if (j.type === 'content_block_delta' && j.delta) {
    return { choices: [{ index: 0, delta: { content: j.delta.text, reasoning: j.delta.thinking } }], done: false };
  }
  if (j.type === 'message_start' && j.message?.usage) {
    return { choices: [], usage: { input_tokens: j.message.usage.input_tokens, output_tokens: 0 }, done: false };
  }
  if (j.type === 'message_delta' && j.usage) {
    return { choices: [], usage: { output_tokens: j.usage.output_tokens }, done: false };
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
