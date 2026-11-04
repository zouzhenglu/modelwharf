'use strict';
/**
 * Qwen (通义千问 chat.qwen.ai) provider.
 * Reference: Rfym21/Qwen2API (837★), YuJunZhiXue/qwen2API (965★) — verified 2026-10.
 *
 * Facts:
 *  - Auth: Cookie token=<JWT> or Authorization: Bearer <token>; optional programmatic login
 *    POST /api/v1/auths/signin {email, password: sha256(password)} -> data.token (auto re-login <6h left)
 *  - Models: GET /api/models -> data[] (info.meta.chat_type)
 *  - Chat (always SSE): POST /api/v2/chat/completions?chat_id=<id>, body {stream:true, version:"2.1",
 *    incremental_output:true, chat_id, chat_mode:"normal", model, messages:[single user msg with
 *    feature_config{thinking_enabled...}]} — history folded into a JSONL envelope text (upstream takes ONE user msg)
 *  - Stream deltas: choices[0].delta {phase: think|answer, content, reasoning_content, extra...},
 *    usage in DashScope naming (input_tokens/output_tokens); multi-candidate frames dedupe by response_index=0
 *  - Web usage is free with rate limits — models marked free
 */
const { httpJson, httpRequest, config, logger } = require('../utils/http');
const { sseParse } = require('../utils/sse');
const { DSMLStreamFilter, newToolCallId, qwenToolDoc, mapQwenToolMessage } = require('../utils/dsml');
const crypto = require('crypto');

const BASE = 'https://chat.qwen.ai';

function headers(account, extra = {}) {
  const c = account.credentials;
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': c.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Authorization: `Bearer ${c.token}`,
    ...(c.token ? { Cookie: `token=${c.token}` } : {}),
    'x-request-id': crypto.randomUUID(),
    'X-FE-Version': 'prod-fe-1.0',
    Origin: BASE,
    Referer: BASE + '/c/' + crypto.randomUUID(),
    ...extra,
  };
}

/** fold multi-turn history into the JSONL envelope upstream requires (single user message).
 *  tool_calls / tool 消息按 Qwen 原生 XML 协议回填，工具清单作为协议说明前置。 */
function foldHistory(messages, model, imageUrls = [], tools = null, useTools = false) {
  const last = messages[messages.length - 1];
  const lastMapped = mapQwenToolMessage(last);
  const content = lastMapped ? lastMapped.content : (last?.text || '');
  const doc = useTools ? qwenToolDoc(tools) : '';
  const withDoc = (text) => (doc ? doc + '\n\n' + text : text);
  if (messages.length <= 1) {
    return { text: withDoc(content), images: imageUrls, feature: { thinking_enabled: true } };
  }
  const history = messages.slice(0, -1).map(m => {
    const mapped = mapQwenToolMessage(m);
    return mapped
      ? { role: mapped.role, content: mapped.content }
      : { role: m.role, content: m.text || '' };
  });
  const lines = [...(doc ? [doc, ''] : []), '# Conversation history (JSONL)'];
  for (const h of history) lines.push(JSON.stringify(h));
  lines.push('# Current message');
  lines.push(JSON.stringify({ role: 'user', content }));
  return { text: lines.join('\n'), images: imageUrls, feature: { thinking_enabled: true } };
}

async function ensureToken(account) {
  const c = account.credentials;
  // email/password accounts: re-login when <6h validity left
  if (c.email && c.password) {
    const exp = c.tokenExp || 0;
    if (!c.token || Date.now() > exp - 6 * 3600 * 1000) {
      const r = await httpJson(`${BASE}/api/v1/auths/signin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: { email: c.email, password: crypto.createHash('sha256').update(c.password).digest('hex') },
      });
      if (r.status === 200 && r.json?.token) {
        c.token = r.json.token;
        try { const payload = JSON.parse(Buffer.from(c.token.split('.')[1], 'base64').toString()); c.tokenExp = (payload.exp || 0) * 1000; } catch {}
        const { db } = require('../store');
        db.prepare('UPDATE accounts SET credentials=? WHERE id=?').run(JSON.stringify(c), account.id);
        logger.info(`qwen[${account.name}] re-logged in`);
      } else {
        throw Object.assign(new Error(`qwen signin failed: ${r.status}`), { status: 401 });
      }
    }
  }
  if (!c.token) throw Object.assign(new Error('qwen account has no token'), { status: 401 });
  return c.token;
}

module.exports = {
  id: 'qwen',
  label: '通义千问 (chat.qwen.ai)',
  homepage: 'https://chat.qwen.ai',
  importLocal: false,
  credFields: [
    { name: 'token', label: 'SSO Token（网页登录后 Cookie 里的 token 字段）', secret: true, placeholder: 'eyJhbGci...' },
    { name: 'email', label: '或账号密码（自动登录续期）' },
    { name: 'password', label: '密码（配 email 使用）', secret: true },
  ],
  docs: '浏览器打开 chat.qwen.ai 登录 → F12 → Application → Cookies → 复制 token 的值；或填账号密码由网关自动登录续期。多账号=多个浏览器/多个邮箱的 token。',

  async listModels(account) {
    try {
      await ensureToken(account);
      const r = await httpJson(`${BASE}/api/models`, { headers: headers(account, { Accept: 'application/json' }), timeoutMs: 15000 });
      if (r.status === 200) {
        const arr = r.json?.data || [];
        const out = [];
        for (const m of arr) {
          const id = m.id || m.name;
          if (id) out.push({ upstream: id, free: true });
        }
        if (out.length) return out;
      }
    } catch (e) { logger.warn(`qwen listModels: ${e.message}`); }
    return ['qwen3.8-max', 'qwen3.6-plus', 'qwen3.5-flash', 'qwen3-coder-plus', 'qwen3-coder-flash', 'qwen-vl-max', 'qwen-vl-plus']
      .map(m => ({ upstream: m, free: true }));
  },

  /**
   * 恢复在线目录：/api/models 就是 chat.qwen.ai 网页当前提供的真实模型清单。
   */
  async listOnlineModels(account) {
    const models = (await this.listModels(account)).filter(m => !m.static);
    if (!models.length) throw new Error('上游未返回可用模型');
    return {
      models: models.map(m => ({ upstream: m.upstream, publicName: m.upstream.toLowerCase(), free: true, online: true })),
      replace: true,
      source: 'chat.qwen.ai /api/models',
    };
  },

  async checkAccount(account) {
    await ensureToken(account);
    try {
      const r = await httpJson(`${BASE}/api/v1/auths/`, { headers: headers(account, { Accept: 'application/json' }), timeoutMs: 12000 });
      if (r.status === 200 && r.json) {
        const d = r.json;
        return { ok: true, message: d.name || d.email || '有效', extra: { email: d.email, plan: d.plan } };
      }
      if (r.status === 401) return { ok: false, status: 'invalid', message: 'token 无效或过期' };
      return { ok: true, message: 'token 未被拒' };
    } catch (e) {
      return { ok: false, status: 'cooling', message: e.message };
    }
  },

  async *chat({ account, upstreamModel, messages, tools, params, signal, onUsage }) {
    const token = await ensureToken(account);
    const chatId = crypto.randomUUID().replace(/-/g, '');
    // collect images from the last user message (vision models only)
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const imageUrls = (lastUser?.parts || []).filter(p => p.type === 'image_url').map(p => p.url);
    // chat.qwen.ai 没有可用的原生 tools 通道：工具清单注入文本，响应侧解析 Qwen XML 调用
    const useTools = Array.isArray(tools) && tools.length > 0 && params.tool_choice !== 'none';
    const folded = foldHistory(messages, upstreamModel, imageUrls, tools, useTools);
    // upstream requires a pre-created chat id via /api/v2/chats/new; many deployments accept a fresh id — create properly:
    try {
      await httpJson(`${BASE}/api/v2/chats/new?chat_id=${chatId}`, {
        method: 'POST', headers: headers(account, { Accept: 'application/json' }),
        body: { chatId: '', models: [upstreamModel], project_id: '', timestamp: Date.now(), chat_type: 't2t', chat_mode: 'normal' },
        timeoutMs: 15000,
      });
    } catch (e) { logger.debug(`qwen chats/new skipped: ${e.message}`); }

    const body = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: upstreamModel,
      parent_id: null,
      timestamp: Date.now(),
      messages: [{
        fid: crypto.randomBytes(16).toString('hex'),
        parentId: null,
        childrenIds: [],
        role: 'user',
        content: folded.text,
        user_action: 'chat',
        files: (imageUrls || []).map(url => ({ type: 'image', url })),
        models: [upstreamModel],
        chat_type: 't2t',
        feature_config: {
          thinking_enabled: true, output_schema: 'phase', research_mode: 'normal',
          auto_thinking: true, thinking_mode: 'Auto', thinking_format: 'summary',
          auto_search: false, code_interpreter: false, plugins_enabled: false,
          function_calling: false, enable_tools: false, tool_choice: 'none',
        },
        extra: { meta: { subChatType: 't2t' } },
        sub_chat_type: 't2t',
        timestamp: Math.floor(Date.now() / 1000),
      }],
      ...(params.max_tokens ? { max_tokens: params.max_tokens } : {}),
    };
    const resp = await httpRequest(`${BASE}/api/v2/chat/completions?chat_id=${chatId}`, {
      method: 'POST', headers: headers(account), body, signal, timeoutMs: config.requestTimeoutMs,
    });
    if (resp.statusCode >= 400) {
      const text = await resp.body.text().catch(() => '');
      throw Object.assign(new Error(`qwen ${resp.statusCode}: ${text.slice(0, 300)}`), { status: resp.statusCode });
    }
    // 正文里的 <tool_call> 块在流式增量里解析成 OpenAI tool_calls（Qwen 训练格式；
    // 请求不带 tools 时模型也会自发输出，裸透传就是标签汤）
    const filter = new DSMLStreamFilter(tools);
    let callIndex = 0, finishSent = false;
    const emitCall = function* ({ name, arguments: args }) {
      const id = newToolCallId();
      yield JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: callIndex, id, type: 'function', function: { name, arguments: '' } }] } }] });
      yield JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: callIndex, function: { name: '', arguments: args } }] } }] });
      callIndex++;
    };
    for await (const { data } of sseParse(resp.body)) {
      if (data === '[DONE]') break;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error || j.code) {
        throw Object.assign(new Error(`qwen: ${(j.error?.message || j.message || JSON.stringify(j)).slice(0, 200)}`), { status: j.status || 502 });
      }
      // multi-candidate: keep only response_index 0; drop function-role injections
      if (j.choices?.[0] && j.choices[0].response_index != null && j.choices[0].response_index !== 0) continue;
      const choice = j.choices?.[0];
      if (choice?.delta?.role === 'function') continue;
      if (j.usage) onUsage?.({ input_tokens: j.usage.input_tokens ?? j.usage.prompt_tokens, output_tokens: j.usage.output_tokens ?? j.usage.completion_tokens });
      if (!choice) { yield JSON.stringify(j); continue; }
      const d = choice.delta || {};
      if (d.reasoning_content) {
        yield JSON.stringify({ ...j, choices: [{ ...choice, delta: { reasoning_content: d.reasoning_content } }] });
      }
      if (d.tool_calls?.length) {
        yield JSON.stringify({ ...j, choices: [{ ...choice, delta: { tool_calls: d.tool_calls } }] });
      }
      if (typeof d.content === 'string' && d.content) {
        const { content, calls } = filter.push(d.content);
        if (content) yield JSON.stringify({ ...j, choices: [{ ...choice, delta: { content } }] });
        for (const call of calls) yield* emitCall(call);
      }
      if (choice.finish_reason) {
        finishSent = true;
        yield JSON.stringify({ ...j, choices: [{ ...choice, delta: {}, finish_reason: filter.sawCalls ? 'tool_calls' : choice.finish_reason }] });
      }
    }
    const tail = filter.flush();
    if (tail.content) yield JSON.stringify({ choices: [{ delta: { content: tail.content } }] });
    for (const call of tail.calls) yield* emitCall(call);
    if (filter.sawCalls && !finishSent) yield JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  },
};
