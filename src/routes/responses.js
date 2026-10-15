'use strict';
/**
 * OpenAI Responses API adapter (/v1/responses) for Codex & modern OpenAI clients.
 * Translates to the internal chat/completions pipeline:
 *   - requests: input (string | message array | function_call outputs) -> canonical messages
 *   - tools:    {type:'function', name, parameters, description} -> OpenAI tools format
 *   - streaming: chat.completion.chunk deltas -> response.output_text.delta events + response.completed
 *   - reasoning: reasoning_effort accepted and forwarded as reasoning_content; non-stream
 *                responses emit reasoning summary in output[0] (type "reasoning") when present.
 */
const express = require('express');
const crypto = require('crypto');
const engine = require('../core/engine');
const modelsCore = require('../core/models');
const { normalizeMessages } = require('../core/messages');
const { db } = require('../store');
const { sseInit } = require('../utils/sse');

const router = express.Router();

// reuse the openai router's auth logic by inlining the same middleware
function auth(req, res, next) {
  const cfgKeys = (require('../config')).apiKeys;
  const header = req.headers['authorization'] || '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] || req.query.key || '');
  let row = key ? db.prepare('SELECT * FROM apikeys WHERE key=?').get(key) : null;
  if (!row && cfgKeys.length && cfgKeys.includes(key)) row = { id: null, key, name: 'env-key', enabled: 1, allowed_models: '*' };
  if (!row && !key && cfgKeys.length === 0 && db.prepare('SELECT COUNT(*) c FROM apikeys').get().c === 0) {
    req.apikey = { id: null, name: 'anonymous', allowed_models: '*' };
    return next();
  }
  if (!row || !row.enabled) return res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } });
  req.apikey = row;
  next();
}
router.use(auth);

function checkModelAllowed(req, res, next) {
  const allowed = req.apikey?.allowed_models || '*';
  const model = req.body?.model;
  if (allowed !== '*' && model && !allowed.split(',').map(s => s.trim()).filter(Boolean).includes(model)) {
    return res.status(403).json({ error: { message: `model '${model}' not allowed for this key`, code: 'model_not_allowed' } });
  }
  next();
}

// ---------- request translation ----------
function responsesInputToMessages(input, instructions) {
  const msgs = [];
  if (instructions) msgs.push({ role: 'system', text: String(instructions) });
  if (typeof input === 'string') {
    msgs.push({ role: 'user', text: input });
    return msgs;
  }
  for (const item of Array.isArray(input) ? input : []) {
    if (item.type === 'message' || (!item.type && item.role)) {
      let text = '';
      let parts = undefined;
      if (typeof item.content === 'string') text = item.content;
      else if (Array.isArray(item.content)) {
        const pp = [];
        for (const c of item.content) {
          if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') pp.push({ type: 'text', text: c.text });
          else if (c.type === 'input_image') pp.push({ type: 'image_url', url: c.image_url || (c.image_url?.url) });
        }
        text = pp.filter(p => p.type === 'text').map(p => p.text).join('\n');
        if (pp.some(p => p.type === 'image_url')) parts = pp;
      }
      msgs.push({ role: item.role, text, parts });
    } else if (item.type === 'function_call') {
      // prior assistant tool call in history
      msgs.push({ role: 'assistant', text: '', raw: { tool_calls: [{ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) } }] } });
    } else if (item.type === 'function_call_output') {
      msgs.push({ role: 'tool', text: typeof item.output === 'string' ? item.output : JSON.stringify(item.output), raw: { tool_call_id: item.call_id } });
    } else if (item.type === 'reasoning') {
      // internal reasoning echo — ignore content, it's not replayable
    }
  }
  return msgs;
}

function responsesToolsToOpenAI(tools) {
  return (tools || [])
    .filter(t => t.type === 'function' || t.name) // built-in tools (web_search etc.) dropped with notice
    .map(t => t.type === 'function'
      ? { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } }
      : null)
    .filter(Boolean);
}

// ---------- response building ----------
function buildResponseObject(id, model, { text, reasoning, toolCalls, status = 'completed', usage, incomplete }) {
  const output = [];
  if (reasoning) {
    output.push({ type: 'reasoning', id: 'rs_' + crypto.randomBytes(8).toString('hex'), summary: [{ type: 'summary_text', text: reasoning }] });
  }
  if (toolCalls && toolCalls.length) {
    for (const tc of toolCalls) {
      output.push({ type: 'function_call', id: 'fc_' + crypto.randomBytes(8).toString('hex'), call_id: tc.id || 'call_' + crypto.randomBytes(8).toString('hex'), name: tc.function?.name || '', arguments: tc.function?.arguments || '{}' });
    }
  }
  output.push({ type: 'message', id: 'msg_' + crypto.randomBytes(8).toString('hex'), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: text || '', annotations: [] }] });
  return {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: incomplete ? 'incomplete' : status,
    model, output, output_text: text || '',
    usage: usage ? {
      input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
    } : null,
    error: null, incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
  };
}

function parseUpstreamEvent(data) {
  if (data === '[DONE]') return { done: true };
  let j; try { j = JSON.parse(data); } catch { return null; }
  if (j.choices?.[0]) {
    const c = j.choices[0];
    const d = c.delta || c.message || {};
    return {
      delta: { content: d.content, reasoning: d.reasoning_content ?? d.reasoning, tool_calls: d.tool_calls },
      finish_reason: c.finish_reason,
      usage: j.usage ? { input_tokens: j.usage.prompt_tokens, output_tokens: j.usage.completion_tokens } : undefined,
    };
  }
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
  return acc.filter(Boolean);
}

// ---------- routes ----------
router.get('/models', async (req, res) => {
  const list = modelsCore.listPublicModels();
  const allowed = req.apikey?.allowed_models || '*';
  res.json({
    object: 'list',
    data: list.filter(m => allowed === '*' || allowed.split(',').map(s => s.trim()).includes(m.public_name))
      .map(m => ({ id: m.public_name, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: m.provider_id })),
  });
});

router.post('/responses', checkModelAllowed, async (req, res) => {
  const body = req.body || {};
  const { model, stream = false, input, instructions, tools, tool_choice, temperature, top_p, max_output_tokens, reasoning } = body;
  if (!model || input == null) {
    return res.status(400).json({ error: { message: 'model and input are required', type: 'invalid_request_error' } });
  }
  const messages = responsesInputToMessages(input, instructions);
  const openaiTools = responsesToolsToOpenAI(tools);
  const droppedBuiltins = (tools || []).filter(t => t.type && t.type !== 'function').map(t => t.type);
  if (droppedBuiltins.length) {
    res.setHeader('X-Dropped-Builtins', droppedBuiltins.join(','));
  }
  const params = {
    temperature, top_p,
    max_tokens: max_output_tokens,
    reasoning_effort: reasoning?.effort || (typeof reasoning === 'string' ? reasoning : undefined),
  };
  const id = 'resp_' + crypto.randomBytes(12).toString('hex');
  const usageAcc = { input_tokens: 0, output_tokens: 0 };

  const accumulate = () => {
    let text = '', reasoningText = '', toolCalls = [];
    return {
      get state() { return { text, reasoning: reasoningText, toolCalls }; },
      fn(ev) {
        if (ev.usage) Object.assign(usageAcc, ev.usage);
        const d = ev.delta || {};
        if (d.content) text += d.content;
        if (d.reasoning) reasoningText += d.reasoning;
        if (d.tool_calls) toolCalls = mergeToolCalls(toolCalls, d.tool_calls);
      },
    };
  };

  if (!stream) {
    try {
      const acc = accumulate();
      await engine.runChat({ publicModel: model, messages, tools: openaiTools, params, source: 'responses', apikeyId: req.apikey.id },
        (data) => { const ev = parseUpstreamEvent(data); if (ev) acc.fn(ev); return true; },
        (u) => Object.assign(usageAcc, u));
      const s = acc.state;
      const finalCalls = s.toolCalls.map(tc => ({ ...tc, function: { ...tc.function } }));
      return res.json(buildResponseObject(id, model, { text: s.text, reasoning: s.reasoning, toolCalls: finalCalls, usage: usageAcc }));
    } catch (err) {
      return res.status(err.status || 500).json({ error: { message: err.message, type: 'upstream_error', code: String(err.status || 500) } });
    }
  }

  // streaming: Responses SSE event sequence
  const sse = sseInit(res);
  const acc = accumulate();
  let seq = 0;
  const send = (event, data) => { if (!sse.isClosed) { sse.send(null, JSON.stringify({ type: event, sequence_number: seq++, ...data })); } };
  try {
    send('response.created', { response: buildResponseObject(id, model, { text: '', status: 'in_progress' }) });
    let textOpened = false, reasoningOpened = false, outIdx = 0;
    const openBlock = (type) => {
      if (type === 'reasoning') { send('response.reasoning_summary_text.delta', { item_id: 'rs_' + id, output_index: outIdx, delta: '' }); reasoningOpened = true; }
      else { send('response.output_text.delta', { item_id: 'msg_' + id, output_index: outIdx, content_index: 0, delta: '' }); textOpened = true; }
    };
    await engine.runChat({ publicModel: model, messages, tools: openaiTools, params, source: 'responses', apikeyId: req.apikey.id },
      (data) => {
        if (sse.isClosed) return false;
        const ev = parseUpstreamEvent(data);
        if (!ev) return true;
        acc.fn(ev);
        const d = ev.delta || {};
        if (d.reasoning) {
          if (!reasoningOpened) { openBlock('reasoning'); }
          send('response.reasoning_summary_text.delta', { item_id: 'rs_' + id, output_index: outIdx, delta: d.reasoning });
        }
        if (d.content) {
          if (reasoningOpened) { send('response.reasoning_summary_text.done', { item_id: 'rs_' + id, output_index: outIdx }); outIdx++; reasoningOpened = false; }
          if (!textOpened) openBlock('text');
          send('response.output_text.delta', { item_id: 'msg_' + id, output_index: outIdx, content_index: 0, delta: d.content });
        }
        if (d.tool_calls) {
          for (const tc of d.tool_calls) {
            send('response.output_item.added', { output_index: outIdx, item: { type: 'function_call', call_id: tc.id || 'call_x', name: tc.function?.name || '', arguments: tc.function?.arguments || '' } });
          }
        }
        return true;
      }, (u) => Object.assign(usageAcc, u));
    const s = acc.state;
    const final = buildResponseObject(id, model, { text: s.text, reasoning: s.reasoning, toolCalls: s.toolCalls, usage: usageAcc });
    if (textOpened) send('response.output_text.done', { item_id: 'msg_' + id, output_index: outIdx, text: s.text });
    send('response.completed', { response: final });
    sse.end();
  } catch (err) {
    if (!sse.isClosed) {
      send('response.failed', { response: { id, error: { code: String(err.status || 500), message: err.message } } });
      sse.end();
    }
  }
});

module.exports = router;
