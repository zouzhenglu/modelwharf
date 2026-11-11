'use strict';
/**
 * OpenAI Responses API adapter (/v1/responses) for Codex & modern OpenAI clients.
 * Translates to the internal chat/completions pipeline:
 *   - requests: input (string | message array | function_call outputs) -> canonical messages
 *   - tools:    {type:'function', name, parameters, description} -> OpenAI tools format
 *   - streaming: chat.completion.chunk deltas -> full Responses SSE event sequence
 *                (event: lines + output_item/content_part lifecycle + aggregated
 *                function_call arguments.delta/done), ends at response.completed
 *   - reasoning: reasoning_effort accepted and forwarded as reasoning_content; non-stream
 *                responses emit reasoning summary in output[0] (type "reasoning") when present.
 */
const express = require('express');
const crypto = require('crypto');
const engine = require('../core/engine');
const modelsCore = require('../core/models');
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
  // key 白名单存的是干净的 public_name —— 客户端回传带费率标签/账号别名时也按基础名匹配
  if (model && !modelsCore.modelAllowedByList(model, allowed)) {
    return res.status(403).json({ error: { message: `model '${model}' not allowed for this key`, code: 'model_not_allowed' } });
  }
  next();
}

// ---------- request translation ----------
/**
 * Codex CLI 的原生 Responses 请求用 `role: developer` 下发指令（还有顶层
 * `instructions`）。但逆向平台（workbuddy / workbuddyintl 的 /v2/chat/completions）
 * 的渠道校验会拒掉大体积的 system/developer 消息：实测 17KB 的 developer 消息
 * （无论叫 developer 还是 system、无论内容是什么）一律 400 code:11-128
 * "Illegal API invocation from an unapproved channel"，而同样内容作为 user 消息
 * 完全放行。这正是「ccswitch 路由模式（转成 chat/completions 时把开发者指令当
 * user 处理）能用、Codex 直连 responses 失败」的根因。
 * 因此这里把 developer/system 统一降为 user（前置指令消息），语义不丢、上游能收。
 */
function normalizeResponsesRole(role) {
  return role === 'developer' || role === 'system' ? 'user' : role;
}
function responsesInputToMessages(input, instructions) {
  const msgs = [];
  if (instructions) msgs.push({ role: 'user', text: String(instructions) });
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
      msgs.push({ role: normalizeResponsesRole(item.role), text, parts });
    } else if (item.type === 'function_call') {
      // prior assistant tool call in history — tool_calls / tool_call_id 必须放在
      // 规范消息的顶层（provider 只读顶层字段，塞进 raw 会被静默丢弃，导致多轮工具会话断链）。
      // Codex 的并行调用是连续的 function_call item：必须合并进同一条 assistant 消息，
      // 否则会生成「assistant(call1) → assistant(call2) → tool(out1)」，workbuddy 校验
      // 直接报 400 code:11148 "tool calls and tool results do not match"。
      const call = {
        id: item.call_id || item.id, type: 'function',
        function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) },
      };
      const prev = msgs[msgs.length - 1];
      if (prev?.role === 'assistant') {
        (prev.tool_calls ||= []).push(call);
      } else {
        msgs.push({ role: 'assistant', text: '', tool_calls: [call] });
      }
    } else if (item.type === 'function_call_output') {
      // output 可能是字符串，也可能是 input_text/input_image 内容数组
      const output = typeof item.output === 'string'
        ? item.output
        : Array.isArray(item.output)
          ? item.output.map(o => typeof o === 'string' ? o : (o?.text ?? JSON.stringify(o))).join('\n')
          : JSON.stringify(item.output ?? '');
      msgs.push({ role: 'tool', text: output, tool_call_id: item.call_id });
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
// fcIds: 流式阶段为每个 function_call 预分配的 [{id, call_id}]（与 toolCalls 对齐）；
// 非流式不传，随机生成。复用可让 response.completed 里的 output 与流式事件的 item_id 对得上。
function buildResponseObject(id, model, { text, reasoning, toolCalls, status = 'completed', usage, incomplete, fcIds }) {
  const output = [];
  if (reasoning) {
    output.push({ type: 'reasoning', id: 'rs_' + crypto.randomBytes(8).toString('hex'), summary: [{ type: 'summary_text', text: reasoning }] });
  }
  if (toolCalls && toolCalls.length) {
    toolCalls.forEach((tc, i) => {
      const callId = tc.id || 'call_' + crypto.randomBytes(8).toString('hex');
      // 流式阶段按 call_id 对齐预分配的 item id；找不到时退回数组下标（连续 index 的常规情形）
      const ids = fcIds?.find(x => x.call_id === callId) || fcIds?.[i] || {};
      output.push({ type: 'function_call', id: ids.id || 'fc_' + crypto.randomBytes(8).toString('hex'), call_id: ids.call_id || callId, name: tc.function?.name || '', arguments: tc.function?.arguments || '{}' });
    });
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
      .map(m => ({ id: m.public_name, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: m.provider_id, context_window: m.ctx_window ?? null, max_output_tokens: m.max_output ?? null })),
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
  // 官方 Responses 流每个事件都带 `event:` 行（严格按 SSE event 分发的客户端
  // 只认 event:，不认 data 里的 type）；同时补 item 生命周期事件，让 Codex 能
  // 正确累加输出。
  const send = (event, data) => {
    if (sse.isClosed) return;
    sse.send(event, JSON.stringify({ type: event, sequence_number: seq++, ...data }));
  };
  let outIdx = 0;
  const allocOutIdx = () => outIdx++;
  try {
    const inProgress = () => buildResponseObject(id, model, { text: '', status: 'in_progress' });
    send('response.created', { response: inProgress() });
    send('response.in_progress', { response: inProgress() });

    let textItem = null;
    let reasoningItem = null;
    // function_call 分片按 index 聚合：上游（含 DSML 文本协议）把一次工具调用拆成
    // 多个 delta（id/name 一段、arguments 若干段），逐个发 output_item.added 会让
    // Codex 看到多个损坏的调用。这里每个 index 只发一次 added + 多次 arguments.delta。
    const toolItems = new Map(); // index -> { itemId, callId, name, args, outputIndex }
    // 所有 item 的收尾闭包按 output_index 排序后统一执行，保证 done 事件顺序与
    // output_index 一致（Codex 等严格客户端按 index 累加状态，乱序会解析失败）。
    const closers = [];

    const openTextItem = () => {
      if (textItem) return textItem;
      const itemId = 'msg_' + crypto.randomBytes(8).toString('hex');
      const outputIndex = allocOutIdx();
      send('response.output_item.added', { output_index: outputIndex, item: { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [] } });
      send('response.content_part.added', { item_id: itemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      textItem = { itemId, outputIndex };
      closers.push({
        outputIndex, kind: 'text',
        run: (text) => {
          send('response.output_text.done', { item_id: itemId, output_index: outputIndex, content_index: 0, text });
          send('response.content_part.done', { item_id: itemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
          send('response.output_item.done', { output_index: outputIndex, item: { type: 'message', id: itemId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] } });
        },
      });
      return textItem;
    };
    const openReasoningItem = () => {
      if (reasoningItem) return reasoningItem;
      const itemId = 'rs_' + crypto.randomBytes(8).toString('hex');
      const outputIndex = allocOutIdx();
      send('response.output_item.added', { output_index: outputIndex, item: { type: 'reasoning', id: itemId, summary: [] } });
      send('response.reasoning_summary_part.added', { item_id: itemId, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
      reasoningItem = { itemId, outputIndex };
      closers.push({
        outputIndex, kind: 'reasoning',
        run: (text) => {
          send('response.reasoning_summary_text.done', { item_id: itemId, output_index: outputIndex, summary_index: 0, text });
          send('response.reasoning_summary_part.done', { item_id: itemId, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text } });
          send('response.output_item.done', { output_index: outputIndex, item: { type: 'reasoning', id: itemId, summary: [{ type: 'summary_text', text }] } });
        },
      });
      return reasoningItem;
    };

    await engine.runChat({ publicModel: model, messages, tools: openaiTools, params, source: 'responses', apikeyId: req.apikey.id },
      (data) => {
        if (sse.isClosed) return false;
        const ev = parseUpstreamEvent(data);
        if (!ev || ev.done) return true;
        acc.fn(ev);
        const d = ev.delta || {};
        if (d.reasoning) {
          const r = openReasoningItem();
          send('response.reasoning_summary_text.delta', { item_id: r.itemId, output_index: r.outputIndex, summary_index: 0, delta: d.reasoning });
        }
        if (d.content) {
          const t = openTextItem();
          send('response.output_text.delta', { item_id: t.itemId, output_index: t.outputIndex, content_index: 0, delta: d.content });
        }
        if (d.tool_calls) {
          for (const tc of d.tool_calls) {
            const idx = tc.index ?? 0;
            let ti = toolItems.get(idx);
            if (!ti) {
              const itemId = 'fc_' + crypto.randomBytes(8).toString('hex');
              ti = {
                itemId, callId: tc.id || 'call_' + crypto.randomBytes(8).toString('hex'),
                name: '', args: '', outputIndex: allocOutIdx(),
              };
              toolItems.set(idx, ti);
              // added 事件里带上首个分片的名字（展示用）；ti.name 仍从空开始累加，避免重复
              send('response.output_item.added', { output_index: ti.outputIndex, item: { type: 'function_call', id: itemId, call_id: ti.callId, name: tc.function?.name || '', arguments: '', status: 'in_progress' } });
              closers.push({
                outputIndex: ti.outputIndex, kind: 'function_call',
                run: () => {
                  const args = ti.args || '{}';
                  send('response.function_call_arguments.done', { item_id: ti.itemId, output_index: ti.outputIndex, arguments: args, name: ti.name });
                  send('response.output_item.done', { output_index: ti.outputIndex, item: { type: 'function_call', id: ti.itemId, call_id: ti.callId, name: ti.name, arguments: args, status: 'completed' } });
                },
              });
            }
            if (tc.id) ti.callId = tc.id;
            // 与 mergeToolCalls 一致：name 分片无条件累加（同一 index 的 delta 才带 name）
            if (tc.function?.name) ti.name += tc.function.name;
            const argDelta = tc.function?.arguments;
            if (argDelta) {
              ti.args += argDelta;
              send('response.function_call_arguments.delta', { item_id: ti.itemId, output_index: ti.outputIndex, delta: argDelta });
            }
          }
        }
        return true;
      }, (u) => Object.assign(usageAcc, u));

    const s = acc.state;
    // 按 output_index 顺序统一收尾：reasoning(0) → message/tool(…)，
    // 保证 done 事件序列与 index 一致，严格客户端状态机不会错乱。
    closers.sort((a, b) => a.outputIndex - b.outputIndex);
    for (const c of closers) c.run(c.kind === 'reasoning' ? s.reasoning : s.text);
    const fcIds = [...toolItems.entries()].sort((a, b) => a[0] - b[0]).map(([, ti]) => ({ id: ti.itemId, call_id: ti.callId }));
    const final = buildResponseObject(id, model, { text: s.text, reasoning: s.reasoning, toolCalls: s.toolCalls, usage: usageAcc, fcIds });
    send('response.completed', { response: final });
    sse.end({ done: false });
  } catch (err) {
    if (!sse.isClosed) {
      send('response.failed', { response: { id, error: { code: String(err.status || 500), message: err.message } } });
      sse.end({ done: false });
    }
  }
});

module.exports = router;
