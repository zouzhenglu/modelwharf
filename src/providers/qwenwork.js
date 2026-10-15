'use strict';
/**
 * QwenWork (千问办公) provider — Alibaba's AI-office desktop app, same COSY
 * protocol family as Qoder but a separate gateway: gateway.qwenwork.cn.
 *
 * References: wearetheone777/dumate2api (src/qwenwork/*), Buddy2api wasm_helper
 * (MIT, vendored as _qwenwork_wasm_helper.mjs), wpy030414/xrl-router-plugin-qwenwork.
 * Protocol facts (verified live 2026-10-14 against gateway.qwenwork.cn):
 *  - Auth: OAuth access token (JWT) issued by the client's device flow; refresh
 *    via POST /api/v1/deviceToken/refresh {refresh_token, target:'c'} (RT rotates).
 *  - Chat: POST /algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
 *      body sealed by the official wasm (see _qwenwork_bridge.js); SSE is double-layered:
 *      outer `data:{"headers":..,"body":"<inner OpenAI chunk str>","statusCodeValue":200}`
 *      — outer HTTP is always 200, real status lives in statusCodeValue / inner code.
 *  - Models: GET /api/v2/model/list (wasm 'req' signature) -> qwork[] keys
 *      flash/pro/qwen3.8-max-preview; price_factor is the credit multiplier (flash 0.1).
 *  - Credits: GET https://qwenwork.cn/user/wallets with plain Bearer -> three pools:
 *      daily_credits (free tier, resets 00:00 +08:00), monthly_credits (subscription),
 *      longterm_credits (top-up/gift). chat.qwen-style: free users consume daily first.
 *  - Local credentials: %APPDATA%/QwenWorkCN/auth-v2.dat (Chromium v10 + DPAPI-wrapped
 *    AES-256-GCM key in Local State) — same scheme as Qoder desktop; machineId for
 *    signing = doc.loginDeviceId.
 *  - OAuth device flow (client's own startDeviceFlow/pollDeviceToken) works fully
 *    headless: authorize at gateway /device/selectAccounts?...&client_id=e883ade2-...,
 *    poll /api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256 (no auth header).
 */
const { httpJson, httpRequest, config, logger } = require('../utils/http');
const { sseParse } = require('../utils/sse');
const crypto = require('crypto');
const bridge = require('./_qwenwork_bridge');

const GATEWAY = 'https://gateway.qwenwork.cn';
const SITE = 'https://qwenwork.cn';
const USER_AGENT = 'qoderwork/1.2.5';
const CLIENT_TYPE = '6';
const COSY_VERSION = '1.1.52';
const OAUTH_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'; // QWENWORK_CN_CLIENT_ID
const OAUTH_REDIRECT_URI = 'qwenwork-cn://';
const DEVICE_FLOW_TIMEOUT_MS = 300000;

// 千问办公的目录只有 flash / pro / qwen3.8-max-preview 三个「档位名」，不像别的平台
// 带模型族前缀。直接暴露成 flash / pro 会占住两个过于通用的名字（别的平台也可能有），
// 统一模型页按名字聚合时就分不清是谁的。这里统一加 qwenwork- 前缀。
const MODEL_PREFIX = 'qwenwork-';
const FALLBACK_MODELS = ['pro', 'flash'];
const MODEL_ALIASES = { auto: 'pro', 'qwork-advanced': 'pro', 'qwork-auto': 'pro' };

/**
 * 档位名 → 对外模型名。
 * qwen3.8-max-preview 已经是明确的模型族名（能和别的平台的 qwen3.8-max 对上），
 * 保持原名；flash / pro 太泛，加 qwenwork- 前缀。
 */
function publicNameFor(key) {
  const flat = String(key).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
  if (flat.startsWith('qwen')) return flat;
  return MODEL_PREFIX + flat;
}

// ---- credentials: refresh + identity ------------------------------------------

function jwtPayload(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

/** refresh device token (RT rotates on every use); returns patch for credentials */
async function exchangeToken(account) {
  const c = account.credentials;
  const r = await httpJson(`${GATEWAY}/api/v1/deviceToken/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json',
      'User-Agent': USER_AGENT, 'X-Request-Id': crypto.randomUUID(), 'Login-Version': 'v2',
    },
    body: { refresh_token: c.refreshToken, target: 'c' },
    timeoutMs: 30000,
  });
  const token = r.json?.device_token || r.json?.token;
  if (r.status !== 200 || !token) {
    const code = r.json?.errorCode || r.json?.error || `HTTP ${r.status}`;
    const detail = r.json?.errorMessage || r.json?.message || String(r.text || '').slice(0, 120);
    return { ok: false, error: `${code}${detail ? ': ' + detail : ''}` };
  }
  const patch = { token };
  if (r.json.refresh_token) patch.refreshToken = r.json.refresh_token;
  const exp = jwtExp(token) ?? (r.json.expires_at ? Date.parse(r.json.expires_at) : null);
  if (exp) patch.expiresAt = exp;
  if (r.json.refresh_token_expires_at) {
    const t = Date.parse(r.json.refresh_token_expires_at);
    if (Number.isFinite(t)) patch.refreshExpiresAt = t;
  }
  return { ok: true, patch };
}

function jwtExp(token) {
  const p = jwtPayload(token);
  return p.exp ? p.exp * 1000 : null;
}

/** ensure a valid access token; persists rotated RT back into the account row */
async function ensureToken(account) {
  const c = account.credentials;
  const exp = c.expiresAt || jwtExp(c.token) || 0;
  const needsRefresh = !c.token || (exp && Date.now() > exp - 5 * 60 * 1000);
  if (needsRefresh && c.refreshToken) {
    const r = await exchangeToken(account);
    if (!r.ok) throw Object.assign(new Error(`千问办公 token 换票失败（${r.error}）；请重新授权登录该账号`), { status: 401 });
    const { db } = require('../store');
    const fresh = { ...c, ...r.patch };
    db.prepare('UPDATE accounts SET credentials=? WHERE id=?').run(JSON.stringify(fresh), account.id);
    account.credentials = fresh;
    logger.info(`qwenwork[${account.name}] token refreshed`);
  }
  if (!c.token) throw Object.assign(new Error('千问办公账号缺少 token，请重新授权或粘贴凭证'), { status: 401 });
  return account.credentials.token;
}

/** fetch user identity (uid is a REQUIRED input of the wasm signature) */
async function fetchUserInfo(account) {
  const c = account.credentials;
  if (c.uid) return c;
  const token = await ensureToken(account);
  const r = await httpJson(`${GATEWAY}/api/v1/adapter/user/account-context?include=user,plan,quota`, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, Authorization: `Bearer ${token}` }, timeoutMs: 15000,
  });
  if (r.status !== 200 || !r.json) {
    throw Object.assign(new Error(`account-context ${r.status}: 无法读取 uid（签名必需）。请用「扫描本机登录」导入或重新授权。`), { status: 401 });
  }
  const d = r.json.data || r.json;
  const u = d.user || d;
  const { db } = require('../store');
  const fresh = {
    ...c,
    uid: String(u.id || u.user_id || u.uid || ''),
    nickname: u.name || u.username || '',
    username: u.username || '',
    email: u.email || '',
    tier: u.tier || d.plan?.name || '',
    planId: d.plan?.pid || '',
    planName: d.plan?.name || '',
  };
  db.prepare('UPDATE accounts SET credentials=? WHERE id=?').run(JSON.stringify(fresh), account.id);
  account.credentials = fresh;
  return fresh;
}

// ---- body building (OpenAI canonical -> qwenwork agent_chat body) --------------

/** tool definitions must be plain OpenAI shape; anything else 400s the whole request */
function cleanTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.filter(t => t?.type === 'function' && t.function?.name);
}

function buildBody(modelKey, { messages, tools, params }) {
  const requestId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const turns = (messages || []).map(m => {
    const out = { role: m.role, content: m.text ?? '' };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  });
  const lastUser = [...turns].reverse().find(m => m.role === 'user');
  const text = lastUser?.content || '';
  const system = turns.find(m => m.role === 'system')?.content || '';
  const cleaned = cleanTools(tools);

  const parameters = {};
  for (const k of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty']) {
    if (params?.[k] != null) parameters[k] = params[k];
  }
  parameters.max_tokens = params?.max_tokens ?? 32000;

  return JSON.stringify({
    request_id: requestId, request_set_id: requestId, chat_record_id: requestId,
    session_id: sessionId, stream: true, chat_task: 'FREE_INPUT',
    chat_context: {
      text, features: [],
      extra: { context: [], modelConfig: { key: modelKey, is_reasoning: false }, originalContent: text, chatPrompt: '' },
      chatPrompt: '', imageUrls: null,
    },
    is_reply: true, is_retry: false, source: 1, version: '3',
    agent_id: 'agent_common', task_id: 'common', session_type: 'qoder_work', aliyun_user_type: '',
    model_config: {
      key: modelKey, display_name: modelKey, model: '', format: 'openai', is_vl: true,
      is_reasoning: false, api_key: '', url: '', source: 'system', max_input_tokens: 1000000,
    },
    // without `business` the gateway 503s "Model catalog unavailable" regardless of signature
    business: { product: 'qoder_work', version: COSY_VERSION, type: 'agent', id: crypto.randomUUID(), name: '', begin_at: Date.now(), stage: 'processing' },
    system, messages: turns,
    ...(cleaned.length ? { tools: cleaned, ...(params?.tool_choice != null ? { tool_choice: params.tool_choice } : {}) } : {}),
    parameters,
  });
}

// ---- SSE double-envelope --------------------------------------------------------

/** strip outer envelope {"body":"<inner>","statusCodeValue":N}; returns inner payload strings */
function unwrapEnvelope(raw) {
  const t = String(raw || '').trim();
  if (!t || t === '[DONE]' || t === '{}') return [];
  let outer;
  try { outer = JSON.parse(t); } catch { return [t]; }
  if (!outer || typeof outer !== 'object') return [];
  // already an inner OpenAI chunk
  if (outer.choices || outer.object === 'chat.completion.chunk') return [t];
  const inner = outer.body;
  if (inner == null) return [];
  if (typeof inner === 'object') {
    const s = JSON.stringify(inner);
    return s === '{}' || s === '[]' ? [] : [s];
  }
  const s = String(inner).trim();
  if (!s || s === '[DONE]' || s === '{}' || s === 'null') return [];
  return [s];
}

/** find an error in envelope/inner layers (outer HTTP is always 200) */
function envelopeError(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  const candidates = [];
  for (const line of t.split('\n')) {
    const s = line.trim();
    const json = s.startsWith('data:') ? s.slice(5).trim() : s;
    if (!json || json === '[DONE]') continue;
    try { candidates.push(JSON.parse(json)); } catch { /* not JSON */ }
  }
  for (const o of candidates) {
    if (!o || typeof o !== 'object') continue;
    const code = o.statusCodeValue != null ? Number(o.statusCodeValue) : null;
    if (code && code >= 400) {
      let message = '';
      try { const b = typeof o.body === 'string' ? JSON.parse(o.body) : o.body; message = b?.message || b?.error || ''; } catch { message = String(o.body || '').slice(0, 200); }
      return { code, message };
    }
    const inner = (() => { try { return typeof o.body === 'string' ? JSON.parse(o.body) : o.body; } catch { return null; } })();
    if (inner && typeof inner === 'object') {
      const ic = inner.code != null ? Number(inner.code) : null;
      if (ic && ic >= 400) return { code: ic, message: String(inner.message || inner.error || '') };
    }
  }
  return null;
}

function innerPayloadError(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const code = obj.code != null ? Number(obj.code) : null;
  if (code && code >= 400) return { code, message: String(obj.message || obj.error || '') };
  if (typeof obj.code === 'string' && /^[A-Z]/.test(obj.code) && obj.message) return { code: 500, message: `${obj.code}: ${obj.message}` };
  return null;
}

// ---- provider ----------------------------------------------------------------

module.exports = {
  id: 'qwenwork',
  label: '千问办公 (QwenWork)',
  homepage: 'https://qwenwork.cn',
  importLocal: true,
  credFields: [
    { name: 'token', label: 'Access Token（JWT，客户端登录态或授权获取）', required: true, secret: true, placeholder: 'eyJhbGci...' },
    { name: 'refreshToken', label: 'Refresh Token（用于自动续期，强烈建议）', secret: true },
    { name: 'uid', label: 'UID（wasm 签名必需；扫描导入会自动带上）', placeholder: '7a7ba74f-...' },
    { name: 'machineId', label: 'MachineId（登录设备 ID，可选）' },
  ],
  docs: '推荐「扫描本机登录」自动导入千问办公客户端的登录态；或在面板点「打开授权页面登录」（设备码流程，无需客户端）。uid 是 wasm 签名的必需字段，手动粘贴 token 时请一并填入 UID（本机 ~/.qoderworkcn 或客户端数据目录可查）。',

  async listModels(account) {
    try {
      const models = (await this.listOnlineModels(account)).models;
      if (models.length) return models;
    } catch (e) { logger.warn(`qwenwork listModels: ${e.message} — falling back to static`); }
    return FALLBACK_MODELS.map(m => ({ upstream: m, publicName: publicNameFor(m), static: true }));
  },

  /** live catalog: wasm-signed GET /api/v2/model/list -> qwork[] */
  async listOnlineModels(account) {
    const c = await fetchUserInfo(account);
    const token = await ensureToken(account);
    const built = bridge.prepareRequest({ uid: c.uid, token, pathname: '/api/v2/model/list', method: 'GET', machineId: c.machineId || '' });
    const r = await httpJson(built.url, { method: 'GET', headers: { ...built.headers, Accept: 'application/json' }, body: built.body || undefined, timeoutMs: 20000 });
    if (r.status !== 200) throw new Error(`model/list ${r.status}: ${String(r.text || '').slice(0, 150)}`);
    const j = r.json?.data || r.json || {};
    const list = j.qwork || [];
    const models = [];
    for (const m of list) {
      if (!m.key || m.enable === false) continue;
      const rate = m.price_factor != null ? Number(m.price_factor) : null;
      const tags = [];
      if (m.is_vl) tags.push('vision');
      if (m.is_reasoning) tags.push('thinking');
      if (m.is_default) tags.push('default');
      if (m.max_input_tokens) tags.push(`${Math.round(m.max_input_tokens / 1000)}k`);
      models.push({
        upstream: m.key,
        publicName: publicNameFor(m.key),
        // price_factor 0.1 = 千问办公的最低档；积分消耗按官方倍率折算
        free: rate != null && rate <= 0.1,
        multiplier: rate ?? 1,
        ctx: m.max_input_tokens || null,
        tags, online: true,
      });
    }
    if (!models.length) throw new Error('在线目录返回为空');
    return { models, replace: true, source: 'model/list (wasm)' };
  },

  async checkAccount(account) {
    const c = await fetchUserInfo(account);
    const token = await ensureToken(account);
    const r = await httpJson(`${SITE}/user/wallets`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, Authorization: `Bearer ${token}` }, timeoutMs: 15000,
    });
    if (r.status === 401 || r.status === 403) return { ok: false, status: 'invalid', message: `auth ${r.status}` };
    if (r.status !== 200 || !r.json?.data) return { ok: false, status: 'cooling', message: `wallets ${r.status}` };
    const d = r.json.data;
    const daily = d.daily_credits?.total_balance ?? 0;
    const monthly = d.monthly_credits?.total_balance ?? 0;
    const longterm = d.longterm_credits?.total_balance ?? 0;
    const total = daily + monthly + longterm;
    return {
      ok: true,
      message: `积分 ${total}（每日 ${daily} · 订阅 ${monthly} · 长期 ${longterm}）· ${c.nickname || c.username || c.planName || '有效'}`,
      extra: {
        credits: total, dailyCredits: daily, monthlyCredits: monthly, longtermCredits: longterm,
        uid: c.uid, nickname: c.nickname, username: c.username, email: c.email,
        plan: c.planName || c.tier, planId: c.planId, tokenExpiresAt: c.expiresAt || null,
      },
    };
  },

  /**
   * 每日签到：千问办公与 Qoder 同属 COSY 协议族，活动平台端点探测同款
   * /sash 路径（官方每日积分是 00:00 UTC+8 自动重置进 daily_credits 池，
   * 活动平台可能发额外 Credits）。Cosy-ClientType 用 QoderWork 的 6。
   * 探测不到（404 等）按「无活动接口」跳过，不报错——每日额度本来就自动到账。
   */
  async checkin(account) {
    const c = await fetchUserInfo(account);
    const token = await ensureToken(account);
    const H = {
      Accept: 'application/json', 'Content-Type': 'application/json',
      'User-Agent': USER_AGENT, 'cosy-clienttype': CLIENT_TYPE,
      'cosy-version': COSY_VERSION, Authorization: `Bearer ${token}`,
    };
    const camp = await httpJson(`${GATEWAY}/sash/api/v1/me/campaigns`, { headers: H, timeoutMs: 20000 }).catch(e => ({ status: 0, json: null, error: e.message }));
    if (camp.status === 200 && camp.json && typeof camp.json === 'object') {
      const list = Array.isArray(camp.json.campaigns) ? camp.json.campaigns : [];
      const claimable = list.filter(x =>
        String(x.claimStatus || x.claim_status || '').toUpperCase() === 'CLAIMABLE'
        && ['', 'CLAIM_BENEFIT'].includes(String(x.actionType || x.action_type || ''))
        && (Number(x.benefit?.amount || 0) > 0 || String(x.benefit?.kind || '').toUpperCase() === 'CREDITS'));
      const claimed = list.filter(x =>
        String(x.claimStatus || x.claim_status || '').toUpperCase() === 'CLAIMED'
        && Number(x.benefit?.amount || 0) > 0);
      if (!claimable.length) {
        if (claimed.length) {
          const amount = claimed.reduce((s, x) => s + Number(x.benefit?.amount || 0), 0);
          return { ok: true, already: true, gained: 0, message: `今日已领取（${amount || '?'} Credits）` };
        }
        return { ok: null, message: '活动平台暂无可领取活动' };
      }
      let earned = 0; const names = []; const failures = [];
      let lastFailureRaw = null;
      for (const x of claimable) {
        const cid = x.campaignId || x.campaign_id;
        const title = x.campaignKey || cid;
        const cr = await httpJson(`${GATEWAY}/sash/api/v1/me/campaigns/${encodeURIComponent(cid)}/claim`, {
          method: 'POST', headers: H, body: {}, timeoutMs: 20000,
        }).catch(e => ({ status: 0, json: null, error: e.message }));
        const amount = Number(x.benefit?.amount || 0);
        if (cr.status === 200 && cr.json) {
          const status = String(cr.json.status || '').toUpperCase();
          const failure = String(cr.json.failureCode || '').toUpperCase();
          if (failure === 'SAME_PERSON_ALREADY_CLAIMED' || status === 'BLOCKED') {
            failures.push(`${title}: 同人已领取`); continue;
          }
          if (['CLAIMED', 'GRANTED', 'SUCCESS'].includes(status) || cr.json.replayed) {
            earned += amount; names.push(`${title}${amount ? ` +${amount}` : ''}`); continue;
          }
          failures.push(`${title}: ${status || 'unknown'}`);
        } else if (cr.status === 409) {
          earned += amount; names.push(`${title}（幂等确认）`);
        } else {
          failures.push(`${title}: HTTP ${cr.status}${cr.error ? ' ' + cr.error : ''}`);
          lastFailureRaw = { status: cr.status, json: cr.json, text: String(cr.text || '').slice(0, 300) };
        }
      }
      // 余额回查（三池汇总）
      const w = await httpJson(`${SITE}/user/wallets`, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, Authorization: `Bearer ${token}` }, timeoutMs: 15000,
      }).catch(() => ({ status: 0 }));
      let extra;
      if (w.status === 200 && w.json?.data) {
        const d = w.json.data;
        extra = {
          dailyCredits: d.daily_credits?.total_balance ?? 0,
          monthlyCredits: d.monthly_credits?.total_balance ?? 0,
          longtermCredits: d.longterm_credits?.total_balance ?? 0,
          credits: (d.daily_credits?.total_balance ?? 0) + (d.monthly_credits?.total_balance ?? 0) + (d.longterm_credits?.total_balance ?? 0),
        };
      }
      if (names.length) return { ok: true, gained: earned || null, message: `领取成功 ${names.join('、')}${failures.length ? `；另有失败：${failures.join('；')}` : ''}`, extra };
      return { ok: false, message: `领取失败：${failures.join('；')}`, extra, raw: lastFailureRaw };
    }
    // 探测旧的每日签到接口（部分部署在 openapi 侧或 gateway 侧，能力未知，运行时探测）
    for (const base of [GATEWAY]) {
      const st = await httpJson(`${base}/sash/api/v1/me/daily-check-in/status`, { headers: H, timeoutMs: 15000 }).catch(() => ({ status: 0 }));
      if (st.status === 200 && st.json) {
        const status = String(st.json.status || '').toUpperCase();
        if (status === 'CLAIMED') return { ok: true, already: true, gained: 0, message: '今日已签到' };
        if (status === 'CLAIMABLE') {
          const cl = await httpJson(`${base}/sash/api/v1/me/daily-check-in/claim`, { method: 'POST', headers: H, body: {}, timeoutMs: 15000 }).catch(() => ({ status: 0 }));
          const cj = cl.json || {};
          const clMsg = String(cj.message || cj.msg || cl.text || '');
          if (/已签到|已经签到/i.test(clMsg) || Number(cj.code) === 10001) return { ok: true, already: true, gained: 0, message: '今日已签到' };
          if (cl.status === 200) return { ok: true, gained: Number(cj.rewardCredits || 0) || null, message: `签到成功${cj.rewardCredits ? ` +${cj.rewardCredits}` : ''}` };
          return { ok: false, message: `签到请求失败 HTTP ${cl.status}`, raw: { status: cl.status, json: cl.json, text: String(cl.text || '').slice(0, 300) } };
        }
        return { ok: null, message: `官方签到活动未开放 (status=${status || '?'})` };
      }
    }
    if ([404, 405, 410].includes(camp.status) || camp.status === 0) {
      return { ok: null, message: '本区域暂无签到/活动接口（每日积分 00:00 自动重置，无需签到）' };
    }
    if (camp.status === 401 || camp.status === 403) return { ok: false, message: `auth ${camp.status}` };
    return { ok: false, message: `活动平台查询失败 HTTP ${camp.status}` };
  },

  async *chat({ account, upstreamModel, messages, tools, params, signal, onUsage }) {
    const c = await fetchUserInfo(account);
    const token = await ensureToken(account);
    const modelKey = MODEL_ALIASES[upstreamModel] || upstreamModel;
    const bodyJson = buildBody(modelKey, { messages, tools, params });
    const built = bridge.prepareChat({ uid: c.uid, token, bodyJson, modelKey, machineId: c.machineId || '' });
    const resp = await httpRequest(built.url, {
      method: 'POST', headers: built.headers, body: built.body, signal, timeoutMs: config.requestTimeoutMs,
    });
    if (resp.statusCode >= 400) {
      const text = await resp.body.text().catch(() => '');
      throw Object.assign(new Error(`qwenwork ${resp.statusCode}: ${text.slice(0, 300)}`), { status: resp.statusCode });
    }
    // double envelope: outer data:{"body":"<inner>","statusCodeValue"} wraps OpenAI chunks.
    // Upstream does NOT send data:[DONE] — it ends the stream after a stats frame.
    let innerDone = false;
    for await (const { data } of sseParse(resp.body)) {
      if (data === '[DONE]') break;
      const err = envelopeError(data);
      if (err) {
        throw Object.assign(new Error(`qwenwork ${err.code}: ${err.message || 'upstream error'}`), { status: err.code === 401 || err.code === 403 ? 401 : err.code === 429 || err.code === 418 ? 429 : err.code });
      }
      for (const inner of unwrapEnvelope(data)) {
        let j; try { j = JSON.parse(inner); } catch { continue; }
        const perr = innerPayloadError(j);
        if (perr) {
          throw Object.assign(new Error(`qwenwork ${perr.code}: ${perr.message}`), { status: perr.code === 401 || perr.code === 403 ? 401 : perr.code });
        }
        if (j.usage) onUsage?.({
          input_tokens: j.usage.prompt_tokens ?? j.usage.input_tokens,
          output_tokens: j.usage.completion_tokens ?? j.usage.output_tokens,
        });
        if (!j.choices?.length && !j.usage && !j.id) continue;
        if (j.choices?.[0]?.finish_reason) innerDone = true;
        yield JSON.stringify(j);
      }
    }
    if (!innerDone) {
      // ensure downstream sees a terminated stream even when upstream skipped finish frames
      yield JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    }
  },

  // ---------- local credential discovery ----------
  // Desktop client stores the login in %APPDATA%/QwenWorkCN/auth-v2.dat
  // (Chromium v10 envelope; AES key DPAPI-wrapped in Local State) — the exact
  // scheme qoder.js already decrypts. machineId for wasm signing = loginDeviceId.

  discoverLocal() {
    const fs = require('fs');
    const path = require('path');
    const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
    const dir = path.join(appData, 'QwenWorkCN');
    const found = [];
    try {
      if (!fs.existsSync(path.join(dir, 'auth-v2.dat'))) return found;
      const doc = decryptDesktopAuth(dir);
      const token = doc.token || doc.accessToken;
      if (!token) {
        found.push({ label: '千问办公（解密成功但无 token，请重新登录客户端）', suggestName: null, credentials: null });
        return found;
      }
      const u = doc.user || {};
      const claims = jwtPayload(token);
      const exp = doc.expiresAt ? Date.parse(doc.expiresAt) : (claims.exp ? claims.exp * 1000 : null);
      found.push({
        label: `千问办公${u.name ? ` (${u.name})` : ''}`,
        suggestName: 'qwenwork-' + (u.name || '本地登录'),
        credentials: {
          token,
          refreshToken: doc.refreshToken || null,
          uid: String(u.id || u.uid || claims.sub || claims.uid || ''),
          machineId: doc.loginDeviceId || '',
          expiresAt: Number.isFinite(exp) ? exp : null,
          refreshExpiresAt: doc.refreshTokenExpiresAt ? Date.parse(doc.refreshTokenExpiresAt) || null : null,
          nickname: u.name || '', username: u.username || '', email: u.email || '',
          planId: u.planId || '', planName: u.planName || '', tier: u.tier || '',
        },
        extra: { uid: String(u.id || ''), nickname: u.name || '', plan: u.planName || '' },
      });
    } catch (e) {
      found.push({ label: `千问办公（解密失败：${e.message}）`, suggestName: null, credentials: null });
    }
    return found;
  },

  async importLocal(opts = {}) {
    const found = this.discoverLocal();
    const { importFound } = require('../core/localcred');
    if (opts.import) return { found, ...importFound('qwenwork', found, opts.names || []) };
    return { found };
  },

  // ---------- OAuth device flow (面板「打开授权页面登录」) ----------
  // The client's own flow, fully headless: authorize URL carries PKCE challenge +
  // nonce + machine_id; the gateway remembers the grant server-side, so polling
  // /api/v1/deviceToken/poll needs no auth header. Browser ends at qwenwork-cn://
  // (dead deep link — expected); the panel picks the tokens up via poll.

  async startOAuth() {
    const { verifier, challenge } = generatePKCE();
    const nonce = crypto.randomUUID();
    const machineId = crypto.randomUUID();
    const q = new URLSearchParams({
      challenge, challenge_method: 'S256', nonce, machine_id: machineId,
      client_id: OAUTH_CLIENT_ID, redirect_uri: OAUTH_REDIRECT_URI,
    });
    oauthSessions.set(nonce, { verifier, challenge, machineId, at: Date.now() });
    for (const [k, v] of oauthSessions) if (Date.now() - v.at > DEVICE_FLOW_TIMEOUT_MS) oauthSessions.delete(k);
    return {
      state: nonce,
      authUrl: `${GATEWAY}/device/selectAccounts?${q.toString()}`,
      hint: '在浏览器完成登录授权（页面会跳到打不开的 qwenwork-cn:// 属正常现象），本页会自动检测登录结果。',
    };
  },

  async pollOAuth(state) {
    const st = oauthSessions.get(String(state || ''));
    if (!st) return { pending: true };
    if (Date.now() - st.at > DEVICE_FLOW_TIMEOUT_MS) { oauthSessions.delete(state); return { pending: true }; }
    const q = new URLSearchParams({ nonce: state, verifier: st.verifier, challenge_method: 'S256' });
    const r = await httpJson(`${GATEWAY}/api/v1/deviceToken/poll?${q.toString()}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, 'X-Request-Id': crypto.randomUUID() }, timeoutMs: 15000,
    });
    if (r.status === 404) return { pending: true };
    if (r.status !== 200) return { pending: true }; // transient gateway hiccups shouldn't kill the flow
    const d = r.json || {};
    const token = d.token || d.device_token;
    if (!token) return { pending: true };
    if (d.nonce !== undefined && d.nonce !== state) throw new Error('device flow 校验失败（nonce 不一致）');
    if (!d.refresh_token) throw new Error('取票响应缺少 refresh_token，该账号无法续期');
    oauthSessions.delete(state);
    const claims = jwtPayload(token) || {};
    return {
      pending: false,
      credentials: {
        token,
        refreshToken: d.refresh_token,
        uid: String(claims.sub || claims.uid || claims.user_id || d.uid || ''),
        machineId: st.machineId,
        expiresAt: jwtExp(token) ?? (d.expires_at ? Date.parse(d.expires_at) : null),
        refreshExpiresAt: d.refresh_token_expires_at ? Date.parse(d.refresh_token_expires_at) : null,
      },
      identity: { uid: String(claims.sub || claims.uid || ''), nickname: claims.nickname || claims.name || null, email: claims.email || null },
    };
  },
};

// in-flight device flows (nonce -> {verifier, challenge, machineId, at}); process-local
const oauthSessions = new Map();

/** client-style PKCE: 43~128 unreserved chars, S256, base64url unpadded */
function generatePKCE() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const len = 43 + Math.floor(Math.random() * 86);
  const bytes = crypto.randomBytes(len);
  let verifier = '';
  for (let i = 0; i < len; i++) verifier += alphabet[bytes[i] % alphabet.length];
  const challenge = crypto.createHash('sha256').update(verifier).digest()
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

/** decrypt %APPDATA%/QwenWorkCN/auth-v2.dat (Chromium v10 + DPAPI) — same scheme as qoder.js */
function decryptDesktopAuth(appDataDir) {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const datPath = path.join(appDataDir, 'auth-v2.dat');
  const lsPath = path.join(appDataDir, 'Local State');
  if (!fs.existsSync(datPath) || !fs.existsSync(lsPath)) throw new Error('auth 文件缺失');
  const ls = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
  if (!ls?.os_crypt?.encrypted_key) throw new Error('Local State 无 os_crypt key');
  const b64 = Buffer.from(ls.os_crypt.encrypted_key, 'base64').subarray(5).toString('base64');
  const script = `
Add-Type -AssemblyName System.Security
$enc = [Convert]::FromBase64String('${b64}')
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($dec)`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000 }).trim();
  if (!out) throw new Error('DPAPI 解密空输出');
  const aesKey = Buffer.from(out, 'base64');
  const raw = fs.readFileSync(datPath);
  if (raw.subarray(0, 3).toString() !== 'v10') throw new Error('auth-v2.dat 非 v10 格式');
  const body = raw.subarray(3);
  const nonce = body.subarray(0, 12);
  const ct = body.subarray(12);
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  return JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8'));
}
