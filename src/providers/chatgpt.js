'use strict';
/**
 * ChatGPT (OpenAI 网页版) provider — chatgpt.com backend-api 逆向。
 *
 * Reference projects: ChatGPT-to-API / Pandora 一系、ChatGPT-Next-Web 的网页接入模式。
 * Upstream facts (as of 2026-10):
 *  - 会话续期: GET {base}/api/auth/session，Cookie 带 __Secure-next-auth.session-token
 *      -> {accessToken, user, expires, accountPlan?...}。accessToken 是 JWT，有效期约 2 周。
 *  - 模型清单: GET {base}/backend-api/models，Authorization: Bearer <accessToken>
 *      -> {models: [{slug, title, tags, product_features?...}]}
 *  - 聊天: POST {base}/backend-api/conversation (SSE)
 *      body: {action:'next', model:<slug>, stream:true,
 *             messages:[{id, author:{role}, content:{content_type:'text', parts:[...]}}],
 *             parent_message_id, conversation_id?, history_and_training_disabled}
 *      SSE: event 'message'，data = {message:{id, author, content:{parts}, status}, conversation_id}
 *      parts 元素为字符串（纯文本旧格式）或对象（新格式：{type:'text'|'reasoning'|...}）。
 *  - 设备头: 需要 oai-device-id（uuid，按账号持久化）。
 *
 * 已知限制（与 README「已知限制」同步）：
 *  - 免费/Plus 网页版部分模型有 arkose/PoW 风控，v1 未实现，命中时上游返回 403 原文。
 *  - 上游不返回 token 用量，记账按 0 计。
 *  - 不支持函数调用与图片输入（网页版协议不含）；多模态/语音不在范围。
 *  - 桌面客户端（Electron）的登录态存在加密的 Cookies sqlite 里，v1 不做本地扫描，
 *    凭证从浏览器取（见 docs）。
 */
const crypto = require('crypto');
const { httpJson, httpRequest, config, logger } = require('../utils/http');
const { sseParse } = require('../utils/sse');

const DEFAULT_BASE = 'https://chatgpt.com';

function base(account) {
  return (account.credentials.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
}

/** oai-device-id：网页后端要求；按账号生成一次并持久化，避免每次换设备号触发风控。 */
function ensureDeviceId(account) {
  const c = account.credentials;
  if (c.deviceId) return c.deviceId;
  c.deviceId = crypto.randomUUID();
  persist(account);
  return c.deviceId;
}

function persist(account) {
  const { db } = require('../store');
  db.prepare('UPDATE accounts SET credentials=? WHERE id=?').run(JSON.stringify(account.credentials), account.id);
}

function bearerHeaders(account, extra = {}) {
  const c = account.credentials;
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${c.accessToken}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    'OAI-Device-Id': ensureDeviceId(account),
    'OAI-Language': 'en-US',
    Origin: base(account),
    Referer: `${base(account)}/`,
    ...extra,
  };
}

/**
 * 有 sessionCookie 时调 /api/auth/session 换新 accessToken 并持久化。
 * 没有 cookie 只能用手动粘贴的 accessToken；过期后上游 401，账号会被自动标 invalid。
 */
async function ensureToken(account) {
  const c = account.credentials;
  if (!c.sessionCookie) return c.accessToken;
  const exp = c.expiresAt || 0;
  if (exp && Date.now() < exp - 10 * 60 * 1000) return c.accessToken;
  logger.info(`chatgpt[${account.name}] refreshing accessToken via session cookie`);
  const r = await httpJson(`${base(account)}/api/auth/session`, {
    headers: {
      Cookie: `__Secure-next-auth.session-token=${c.sessionCookie}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    },
    timeoutMs: 20000,
  });
  const token = r.json?.accessToken;
  if (r.status === 200 && token) {
    c.accessToken = token;
    const { decodeJwtClaims } = require('../utils/jwt');
    c.expiresAt = decodeJwtClaims(token)?.expiredAt || (Date.now() + 14 * 24 * 3600 * 1000);
    persist(account);
    logger.info(`chatgpt[${account.name}] accessToken refreshed, expires ${new Date(c.expiresAt).toISOString()}`);
  } else {
    logger.warn(`chatgpt[${account.name}] session refresh failed: HTTP ${r.status} — falling back to stored accessToken`);
  }
  return c.accessToken;
}

function tokenExpiry(c) {
  const { decodeJwtClaims } = require('../utils/jwt');
  return decodeJwtClaims(c.accessToken)?.expiredAt || c.expiresAt || null;
}

/** models 端点条目 -> 统一模型描述。product_features 里 o3/o4 系为推理模型。 */
function modelEntry(m) {
  const slug = m.slug || m.id;
  if (!slug) return null;
  const tags = [];
  const feats = m.product_features || {};
  if (m.tags?.includes('reasoning') || /^(o\d|gpt-.*reasoning)/.test(slug) || feats.reasoning) tags.push('thinking');
  return {
    upstream: slug,
    free: true,
    multiplier: 0,
    tags,
    online: true,
  };
}

module.exports = {
  id: 'chatgpt',
  label: 'ChatGPT (OpenAI 网页版)',
  homepage: 'https://chatgpt.com',
  credFields: [
    { name: 'accessToken', label: 'Access Token (JWT)', required: true, secret: true, placeholder: 'eyJhbGciOiJSUzI1NiI6…' },
    { name: 'sessionCookie', label: 'Session Cookie（可选，自动续期用）', secret: true, placeholder: '__Secure-next-auth.session-token 的值' },
    { name: 'baseUrl', label: 'Base URL（可选，默认 https://chatgpt.com）', placeholder: 'https://chatgpt.com' },
  ],
  docs: '浏览器登录 chatgpt.com 后，F12 控制台执行 (await (await fetch("/api/auth/session")).json()).accessToken 复制 accessToken；要自动续期再到 应用→Cookie→https://chatgpt.com 复制 __Secure-next-auth.session-token 的值填入 Session Cookie。',

  async listModels(account) {
    await ensureToken(account);
    try {
      const r = await httpJson(`${base(account)}/backend-api/models`, {
        headers: bearerHeaders(account),
        timeoutMs: 20000,
      });
      if (r.status !== 200) throw new Error(`models ${r.status}`);
      const list = r.json?.models || [];
      const models = list.map(modelEntry).filter(Boolean);
      if (models.length) return models;
      throw new Error('上游模型清单为空');
    } catch (e) {
      logger.warn(`chatgpt listModels failed: ${e.message} — falling back to static list`);
      return ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-5', 'gpt-5-mini', 'o3', 'o4-mini']
        .map(m => ({ upstream: m, static: true, tags: /^(o\d|gpt-5)/.test(m) ? ['thinking'] : [] }));
    }
  },

  /** 在线目录即 backend-api/models 的 slug 列表，与网页端「模型选择器」一致。 */
  async listOnlineModels(account) {
    const models = (await this.listModels(account)).filter(m => !m.static);
    if (!models.length) throw new Error('上游未返回可用模型（账号可能失效）');
    return {
      models: models.map(m => ({ upstream: m.upstream, publicName: m.upstream.toLowerCase(), free: true, multiplier: 0, tags: m.tags, online: true })),
      replace: true,
      source: 'backend-api/models',
    };
  },

  async checkAccount(account) {
    const c = account.credentials;
    await ensureToken(account);
    const r = await httpJson(`${base(account)}/backend-api/models`, {
      headers: bearerHeaders(account),
      timeoutMs: 20000,
    });
    if (r.status === 401 || r.status === 403) return { ok: false, status: 'invalid', message: `auth ${r.status}${r.json?.detail ? `: ${String(r.json.detail).slice(0, 120)}` : ''}` };
    if (r.status !== 200) return { ok: false, status: 'cooling', message: `upstream ${r.status}` };
    // 有 cookie 时顺带取 plan 信息（免费/Plus/Pro）
    let plan = null, email = null;
    if (c.sessionCookie) {
      try {
        const s = await httpJson(`${base(account)}/api/auth/session`, {
          headers: { Cookie: `__Secure-next-auth.session-token=${c.sessionCookie}`, 'User-Agent': 'Mozilla/5.0' },
          timeoutMs: 15000,
        });
        if (s.status === 200 && s.json) {
          plan = s.json.accountPlan || s.json.user?.accountPlan || s.json.user?.planType || null;
          email = s.json.user?.email || null;
        }
      } catch { /* plan 信息尽力而为 */ }
    }
    const exp = tokenExpiry(c);
    return {
      ok: true,
      message: `${plan ? `${plan} · ` : '有效'}${email ? ` ${email}` : ''}${exp ? ` · token 至 ${new Date(exp).toLocaleDateString('zh-CN')}` : ''}`,
      extra: { plan, email, tokenExpiresAt: exp },
    };
  },

  async *chat({ account, upstreamModel, messages, tools, params }) {
    const c = account.credentials;
    await ensureToken(account);
    if (tools && tools.length) {
      throw Object.assign(new Error('ChatGPT 网页版不支持函数调用，请选用其他平台的模型'), { status: 400 });
    }
    // canonical messages -> backend-api 消息格式
    const conv = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        throw Object.assign(new Error('ChatGPT 网页版不支持 tool 角色消息'), { status: 400 });
      }
      const parts = m.parts || [{ type: 'text', text: m.text || '' }];
      const texts = [];
      for (const p of parts) {
        if (p.type === 'image_url') throw Object.assign(new Error('ChatGPT 网页版暂不支持图片输入'), { status: 400 });
        if (p.type === 'text') texts.push(p.text);
      }
      conv.push({ id: crypto.randomUUID(), author: { role: m.role }, content: { content_type: 'text', parts: texts } });
    }
    const body = {
      action: 'next',
      model: upstreamModel,
      messages: conv,
      parent_message_id: conv.length ? conv[conv.length - 1].id : crypto.randomUUID(),
      stream: true,
      history_and_training_disabled: true,
    };
    const resp = await httpRequest(`${base(account)}/backend-api/conversation`, {
      method: 'POST',
      headers: bearerHeaders(account, { Accept: 'text/event-stream' }),
      body,
      timeoutMs: config.requestTimeoutMs,
    });
    if (resp.statusCode >= 400) {
      const text = await resp.body.text().catch(() => '');
      let detail = text.slice(0, 300);
      try { detail = JSON.parse(text).detail || detail; } catch { /* 保留原文 */ }
      // 403 常见于 arkose/PoW 风控或模型不可用，原文透传便于用户判断
      throw Object.assign(new Error(`chatgpt chat ${resp.statusCode}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`), { status: resp.statusCode });
    }
    // SSE：event 'message' 的 data 携带完整 message（含全部 parts），按累积 diff 出增量
    let sentText = '', sentReasoning = '';
    for await (const { event, data } of sseParse(resp.body)) {
      if (!data || data === '[DONE]') continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      if (event === 'error' || ev.error) {
        throw Object.assign(new Error(`chatgpt error: ${JSON.stringify(ev.error || ev).slice(0, 300)}`), { status: 502 });
      }
      const msg = ev.message || (ev.v && null);
      if (!msg || !msg.content) continue;
      // parts: 字符串（旧）或对象（新：type text/reasoning/...）
      let fullText = '', fullReasoning = '';
      for (const p of msg.content.parts || []) {
        if (typeof p === 'string') { fullText += p; continue; }
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'text') fullText += p.text || '';
        else if (p.type === 'reasoning') fullReasoning += p.text || p.summary || '';
        // 其他 part 类型（code/execution_output/image_asset_pointer 等）跳过
      }
      if (fullReasoning.length > sentReasoning.length) {
        yield JSON.stringify({ choices: [{ delta: { reasoning_content: fullReasoning.slice(sentReasoning.length) } }] });
        sentReasoning = fullReasoning;
      }
      if (fullText.length > sentText.length) {
        yield JSON.stringify({ choices: [{ delta: { content: fullText.slice(sentText.length) } }] });
        sentText = fullText;
      }
      if (msg.status === 'finished_successfully' || msg.end_turn) {
        yield JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        break;
      }
    }
    // 上游不返回 token 用量：如实给 0（engine 记账兼容）
    yield JSON.stringify({ usage: { prompt_tokens: 0, completion_tokens: 0 } });
  },
};
