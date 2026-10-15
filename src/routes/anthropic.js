'use strict';
/**
 * Anthropic-compatible gateway (for Claude Code / Cline / any Anthropic-protocol client):
 *   POST /v1/messages           (stream + non-stream)
 *   GET  /v1/models             (anthropic style)
 * Auth: x-api-key header or Bearer.
 */
const express = require('express');
const crypto = require('crypto');
const engine = require('../core/engine');
const modelsCore = require('../core/models');
const { estimateAnthropicInputTokens, reasoningFromThinking } = require('../core/messages');
const { sseInit } = require('../utils/sse');
const { db } = require('../store');

const router = express.Router();

function auth(req, res, next) {
  const cfgKeys = (require('../config')).apiKeys;
  const key = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace(/^Bearer /, '') || '';
  let row = key ? db.prepare('SELECT * FROM apikeys WHERE key=?').get(key) : null;
  if (!row && cfgKeys.includes(key)) row = { id: null, key, name: 'env-key', enabled: 1, allowed_models: '*' };
  if (!row && !key && cfgKeys.length === 0 && db.prepare('SELECT COUNT(*) c FROM apikeys').get().c === 0) {
    req.apikey = { id: null, name: 'anonymous', allowed_models: '*' };
    return next();
  }
  if (!row || !row.enabled) return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  req.apikey = row;
  next();
}
router.use(auth);

router.get('/models', (req, res) => {
  const list = modelsCore.listPublicModels();
  res.json({ data: list.map(m => ({ id: m.public_name, type: 'model', display_name: m.public_name })), has_more: false });
});

// Anthropic count_tokens: token 数为本地估算（无上游 tokenizer），Claude Code 等
// 客户端用它做上下文预算，估算值即可；形状与官方一致 { input_tokens }。
router.post('/messages/count_tokens', (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.messages)) {
    return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages required' } });
  }
  res.json({ input_tokens: estimateAnthropicInputTokens(body) });
});

// Anthropic messages -> canonical (already OpenAI-ish in our core)
function toCanonical(body) {
  const msgs = [];
  if (body.system) {
    const sysText = typeof body.system === 'string' ? body.system : body.system.map(b => b.text || '').join('\n');
    if (sysText) msgs.push({ role: 'system', text: sysText });
  }
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') { msgs.push({ role: m.role, text: m.content }); continue; }
    // content blocks
    const parts = [];
    let toolResult = null;
    for (const b of m.content || []) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') parts.push({ type: 'image_url', url: b.source?.data ? `data:${b.source.media_type};base64,${b.source.data}` : b.source?.url });
      else if (b.type === 'tool_use') parts.push({ type: 'text', text: `[tool_use ${b.name}] ${JSON.stringify(b.input)}` });
      else if (b.type === 'tool_result') toolResult = b;
    }
    if (toolResult) {
      const inner = typeof toolResult.content === 'string' ? toolResult.content
        : (toolResult.content || []).map(c => c.text || '').join('\n');
      msgs.push({ role: 'tool', text: inner, raw: { tool_use_id: toolResult.tool_use_id } });
    } else {
      msgs.push({ role: m.role, text: parts.filter(p => p.type === 'text').map(p => p.text).join('\n'), parts: parts.length ? parts : undefined });
    }
  }
  return msgs;
}

function anthropicToolsToOpenAI(tools) {
  return (tools || []).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

function openAIToolCallsToAnthropic(tcs) {
  return (tcs || []).map((tc, i) => ({
    type: 'tool_use', id: tc.id || `toolu_${crypto.randomBytes(8).toString('hex')}`,
    name: tc.function?.name || '', input: safeJson(tc.function?.arguments || '{}'),
  }));
}
function safeJson(s) { try { return JSON.parse(s); } catch { return { _raw: s }; } }

router.post('/messages', async (req, res) => {
  const body = req.body || {};
  const model = body.model;
  if (!model || !Array.isArray(body.messages)) {
    return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'model and messages required' } });
  }
  const allowed = req.apikey?.allowed_models || '*';
  if (allowed !== '*' && !allowed.split(',').map(s => s.trim()).includes(model)) {
    return res.status(403).json({ type: 'error', error: { type: 'permission_error', message: `model '${model}' not allowed for this key` } });
  }
  const messages = toCanonical(body);
  const tools = anthropicToolsToOpenAI(body.tools);
  // thinking:{type,budget_tokens} -> 规范 reasoning（模型名后缀优先于该字段）
  const params = { temperature: body.temperature, top_p: body.top_p, max_tokens: body.max_tokens, reasoning: reasoningFromThinking(body.thinking) };
  const usageAcc = { input_tokens: 0, output_tokens: 0, credits: 0 };
  const msgId = 'msg_' + crypto.randomBytes(12).toString('hex');

  const accumulate = () => {
    let text = ''; let thinking = ''; let toolCalls = [];
    return {
      get text() { return text; },
      get thinking() { return thinking; },
      get toolCalls() { return toolCalls; },
      fn(ev) {
        if (ev.usage) Object.assign(usageAcc, ev.usage);
        const d = ev.delta || {};
        if (d.content) text += d.content;
        if (d.reasoning) thinking += d.reasoning;
        if (d.tool_calls) {
          for (const tc of d.tool_calls) {
            const idx = tc.index ?? toolCalls.length;
            if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, name: '', input: '' };
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].name += tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].input += tc.function.arguments;
          }
        }
      },
    };
  };

  if (!body.stream) {
    try {
      const acc = accumulate();
      await engine.runChat({ publicModel: model, messages, tools, params, source: 'anthropic', apikeyId: req.apikey.id },
        (data) => { const ev = parseEvent(data); if (ev) acc.fn(ev); return true; },
        (u) => Object.assign(usageAcc, u));
      const content = [];
      if (acc.thinking) content.push({ type: 'thinking', thinking: acc.thinking });
      if (acc.text) content.push({ type: 'text', text: acc.text });
      for (const tc of acc.toolCalls) if (tc) content.push({ type: 'tool_use', id: tc.id || 'toolu_' + crypto.randomBytes(8).toString('hex'), name: tc.name, input: safeJson(tc.input || '{}') });
      if (!content.length) content.push({ type: 'text', text: '' });
      const stop = acc.toolCalls.some(Boolean) ? 'tool_use' : 'end_turn';
      return res.json({
        id: msgId, type: 'message', role: 'assistant', model,
        content, stop_reason: stop, stop_sequence: null,
        usage: { input_tokens: usageAcc.input_tokens, output_tokens: usageAcc.output_tokens, ...(usageAcc.credits ? { credits: usageAcc.credits } : {}) },
      });
    } catch (err) {
      return res.status(err.status || 500).json({ type: 'error', error: { type: 'api_error', message: err.message } });
    }
  }

  const sse = sseInit(res);
  const acc = accumulate();
  const sendEvent = (event, data) => { if (!sse.isClosed) sse.send(event, data); };
  try {
    let blockStarted = { text: false, thinking: false };
    let blockIdx = 0;
    const startBlock = (type) => {
      sendEvent('content_block_start', { type: 'content_block_start', index: blockIdx, content_block: type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' } });
    };
    const stopBlock = () => { sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIdx }); blockIdx++; blockStarted = { text: false, thinking: false }; };
    sendEvent('message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    await engine.runChat({ publicModel: model, messages, tools, params, source: 'anthropic', apikeyId: req.apikey.id },
      (data) => {
        if (sse.isClosed) return false;
        const ev = parseEvent(data);
        if (!ev) return true;
        acc.fn(ev);
        const d = ev.delta || {};
        if (d.reasoning) {
          if (!blockStarted.thinking) { if (blockStarted.text) stopBlock(); startBlock('thinking'); blockStarted.thinking = true; }
          sendEvent('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'thinking_delta', thinking: d.reasoning } });
        }
        if (d.content) {
          if (!blockStarted.text) { if (blockStarted.thinking) stopBlock(); startBlock('text'); blockStarted.text = true; }
          sendEvent('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: d.content } });
        }
        return true;
      }, (u) => Object.assign(usageAcc, u));
    // flush any pending text block, then tool_use blocks
    if (blockStarted.text || blockStarted.thinking) stopBlock();
    for (const tc of acc.toolCalls) {
      if (!tc) continue;
      sendEvent('content_block_start', { type: 'content_block_start', index: blockIdx, content_block: { type: 'tool_use', id: tc.id || 'toolu_' + crypto.randomBytes(8).toString('hex'), name: tc.name, input: {} } });
      sendEvent('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: tc.input || '{}' } });
      sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIdx });
      blockIdx++;
    }
    const stopReason = acc.toolCalls.some(Boolean) ? 'tool_use' : 'end_turn';
    sendEvent('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usageAcc.output_tokens } });
    sendEvent('message_stop', { type: 'message_stop' });
    sse.end();
  } catch (err) {
    if (!sse.isClosed) { sendEvent('error', { type: 'error', error: { type: 'api_error', message: err.message } }); sse.end(); }
  }
});

function parseEvent(data) {
  if (data === '[DONE]') return { done: true };
  let j; try { j = JSON.parse(data); } catch { return null; }
  if (j.choices?.[0]) {
    const c = j.choices[0];
    const d = c.delta || c.message || {};
    return { delta: { content: d.content, reasoning: d.reasoning_content ?? d.reasoning, tool_calls: d.tool_calls }, finish_reason: c.finish_reason, usage: j.usage ? { input_tokens: j.usage.prompt_tokens, output_tokens: j.usage.completion_tokens, credits: j.usage.credits } : undefined };
  }
  return null;
}

module.exports = router;
