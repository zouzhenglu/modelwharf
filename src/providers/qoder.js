'use strict';
/**
 * Qoder provider (Alibaba agentic IDE) — CN & international.
 * References: shuishuipingan/qoder2api-hub, fengyinxia/qoder2api (clean-room COSY crypto), EchoPing07/Qoder-2API-Go.
 *
 * Facts:
 *  - Chat (SSE): POST {gw}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
 *    gw CN: https://gateway.qoder.com.cn ; intl: https://api1.qoder.sh
 *  - Auth: Authorization: Bearer COSY.{payload_b64}.{sig}; payload = custom-b64({cosyVersion,info,requestId,version:v1})
 *    sig = MD5(payload\nkey\ndate\nbody\npath-without-/algo) ; info = AES-CBC(identity JSON, iv=key) -> RSA wrap -> b64
 *  - Simpler: PAT (pt-...) can be passed as Bearer directly for many endpoints (accounts page: qoder.com.cn/account/integrations)
 *  - Credits (official): GET https://openapi.qoder.com.cn|sh/api/v2/quota/usage with Bearer securityOauthToken
 *  - Models: internal keys like qmodel_38max (Qwen3.8-Max), dmodel (DeepSeek-V4-Pro), gmodel (GLM-5.3)...
 *  - SSE envelope: {headers, body: "<json string>", statusCodeValue}; 401/403 in-stream = login expired; 418 = rate limit
 *  - Off-peak (22:00-08:00 UTC+8) multipliers per model — represented via usage.credits frames.
 *
 * COSY signing for chat is complex; this plugin supports:
 *  A) PAT mode (credentials.pat) — Bearer pt-... (simplest, works for chat per Zhengyuuuui/qoder2api)
 *  B) Full COSY mode (credentials.securityOauthToken + identity fields) — TODO integrate fengyinxia crypto;
 *     until then PAT mode is the default path and COSY tokens fall back to raw Bearer attempts.
 */
const { httpJson, httpRequest, config, logger } = require('../utils/http');
const { sseParse } = require('../utils/sse');
const crypto = require('crypto');

// ---- desktop auth.v1.dat decryption (Chromium v10: DPAPI-wrapped AES-256-GCM key) ----
// DPAPI is invoked through the OS built-in PowerShell (ProtectedData), no native deps.
function dpapiDecryptB64(b64) {
  const { execFileSync } = require('child_process');
  const script = `
Add-Type -AssemblyName System.Security
$enc = [Convert]::FromBase64String('${b64}')
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($dec)`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000 }).trim();
  if (!out) throw new Error('dpapi empty output');
  return Buffer.from(out, 'base64');
}

/** decrypt com.qoder*.app.stable/auth.v1.dat -> {token, refreshToken, expiresAt...} */
function decryptDesktopAuth(appDataDir) {
  const fs = require('fs'), path = require('path');
  const datPath = path.join(appDataDir, 'auth.v1.dat');
  const lsPath = path.join(appDataDir, 'Local State');
  if (!fs.existsSync(datPath) || !fs.existsSync(lsPath)) throw new Error('auth files missing');
  const ls = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
  if (!ls?.os_crypt?.encrypted_key) throw new Error('Local State has no os_crypt key');
  const aesKey = dpapiDecryptB64(Buffer.from(ls.os_crypt.encrypted_key, 'base64').subarray(5).toString('base64'));
  const raw = fs.readFileSync(datPath);
  if (raw.subarray(0, 3).toString() !== 'v10') throw new Error('unexpected auth.v1.dat prefix');
  const body = raw.subarray(3);
  const nonce = body.subarray(0, 12);
  const cipherAndTag = body.subarray(12);
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
  d.setAuthTag(cipherAndTag.subarray(cipherAndTag.length - 16));
  const pt = Buffer.concat([d.update(cipherAndTag.subarray(0, cipherAndTag.length - 16)), d.final()]);
  return JSON.parse(pt.toString('utf8'));
}

function gw(account) {
  const c = account.credentials;
  if (c.gateway) return c.gateway;
  return c.region === 'intl' ? 'https://api1.qoder.sh' : 'https://gateway.qoder.com.cn';
}
function openapiHost(account) {
  return account.credentials.region === 'intl' ? 'https://openapi.qoder.sh' : 'https://openapi.qoder.com.cn';
}

function authHeader(account) {
  const c = account.credentials;
  if (c.pat) return `Bearer ${c.pat}`;
  if (c.securityOauthToken) return `Bearer ${c.securityOauthToken}`;
  if (c.jobToken) return `Bearer ${c.jobToken}`;
  return `Bearer ${c.token || ''}`;
}

function cosyHeaders(account, extra = {}) {
  const c = account.credentials;
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': 'Qoder',
    Authorization: authHeader(account),
    'cosy-version': c.cosyVersion || '1.1.64',
    'Cosy-ClientType': c.clientType || '10',
    appcode: 'cosy',
    'cosy-data-policy': 'AGREE',
    'login-version': 'v2',
    ...extra,
  };
}

// COSY session cache per account id (identity encrypted once; payload re-signed per request)
const cosySessions = new Map(); // accountId -> session
function getCosySession(account) {
  const s = cosySessions.get(account.id);
  if (s) return s;
  const c = account.credentials;
  const { createSession } = require('../utils/cosy');
  const created = createSession({
    uid: c.userId || c.uid || '',
    user_type: c.userType || c.plan || 'personal_standard',
    securityOauthToken: c.jobToken || c.securityOauthToken || c.pat || '',
    refreshToken: c.refreshToken || '',
    name: c.email || '',
  });
  cosySessions.set(account.id, created);
  return created;
}

/** signed data-plane request (chat / model list) — returns headers + encoded body string */
function cosyBearer(account, { path, bodyObj, accept, modelKey } = {}) {
  const { bearerRequest } = require('../utils/cosy');
  return bearerRequest(getCosySession(account), { path, bodyObj, accept, modelKey });
}

/**
 * PAT → jobToken exchange (signature plane). Response carries the full identity
 * (uid/name/email/plan) + a 24h jt- jobToken + jrt- refresh token — these feed
 * the COSY session. The outer body MUST be custom-base64-encoded (qoderEncode),
 * not plain JSON — plain JSON gets a 500.
 */
async function exchangePAT(account) {
  const c = account.credentials;
  const pat = c.pat || '';
  if (!pat) throw Object.assign(new Error('Qoder 聊天/在线目录需要 PAT：客户端 → 设置 → 集成/Integrations 创建（pt- 开头）'), { status: 401 });
  const { httpJson } = require('../utils/http');
  const { db } = require('../store');
  const { signatureHeaders, qoderEncode } = require('../utils/cosy');
  const inner = JSON.stringify({ userId: '', personalToken: pat, securityOauthToken: '', refreshToken: '', needRefresh: false, authInfo: {} });
  const outer = JSON.stringify({ payload: inner, encodeVersion: '1' });
  const r = await httpJson(`${gw(account)}/algo/api/v3/user/jobToken?Encode=1`, {
    method: 'POST', headers: { ...signatureHeaders(), Authorization: `Bearer ${pat}` }, body: qoderEncode(Buffer.from(outer)), timeoutMs: 20000,
  });
  if (r.status !== 200) {
    // 区域隔离：intl PAT 在 CN 网关上会 401，反之亦然——自动尝试另一区域的网关
    const alt = c.region === 'intl' ? 'https://gateway.qoder.com.cn' : (c.region === 'cn' ? 'https://api1.qoder.sh' : null);
    if (!alt) throw Object.assign(new Error(`jobToken 交换失败 ${r.status}: ${String(r.text || '').slice(0, 120)}`), { status: 502 });
    const r2 = await httpJson(`${alt}/algo/api/v3/user/jobToken?Encode=1`, {
      method: 'POST', headers: { ...signatureHeaders(), Authorization: `Bearer ${pat}` }, body: qoderEncode(Buffer.from(outer)), timeoutMs: 20000,
    });
    if (r2.status !== 200) throw Object.assign(new Error(`jobToken 交换失败（双网关） ${r.status}/${r2.status}`), { status: 502 });
    return finishExchange(account, r2.json);
  }
  return finishExchange(account, r.json);
}

/** consume a successful jobToken response: persist identity + tokens, build COSY session */
function finishExchange(account, json, gatewayHost) {
  const { db } = require('../store');
  const c = account.credentials;
  const d = json?.data || json || {};
  // persist identity + tokens into credentials so COSY session uses them
  const fresh = {
    ...c,
    jobToken: d.securityOauthToken || d.jobToken || null,
    refreshToken: d.refreshToken || c.refreshToken || null,
    userId: d.id || d.uid || c.userId || null,
    email: d.email || d.name || null,
    username: d.name || null,
    plan: d.plan || null,
    jobExpiresAt: d.expireTime ? Number(d.expireTime) : null,
    ...(gatewayHost ? { jobGateway: gatewayHost } : {}),
  };
  db.prepare('UPDATE accounts SET credentials=?, extra=? WHERE id=?')
    .run(JSON.stringify(fresh), JSON.stringify({ uid: fresh.userId, email: fresh.email, username: fresh.username, plan: fresh.plan, credits: account.extra?.credits, quota: account.extra?.quota }), account.id);
  account.credentials = fresh;
  account.extra = { ...account.extra, username: fresh.username, email: fresh.email, plan: fresh.plan };
  // build COSY session from the exchanged identity
  const { createSession } = require('../utils/cosy');
  const session = createSession({
    uid: fresh.userId || '',
    user_type: fresh.plan || 'personal_standard',
    securityOauthToken: fresh.jobToken || '',
    refreshToken: fresh.refreshToken || '',
    name: fresh.email || '',
  });
  cosySessions.set(account.id, session);
  return session;
}

/** ensure a valid COSY session: PAT exchange on first use or when the 24h jobToken expired */
function ensureSession(account) {
  const cached = cosySessions.get(account.id);
  const c = account.credentials;
  const expired = c.jobExpiresAt && Date.now() > c.jobExpiresAt - 10 * 60 * 1000;
  if (cached && !expired) return cached;
  if (c.pat) return exchangePAT(account);
  const { db } = require('../store');
  db.prepare("UPDATE accounts SET status='invalid', status_message=? WHERE id=?").run('缺少 PAT：聊天通道需要 pt- 令牌（客户端 → 设置 → 集成 创建后填入）', account.id);
  throw Object.assign(new Error('Qoder 聊天/在线目录需要 PAT（pt-）：客户端 → 设置 → 集成/Integrations 创建后填入账号'), { status: 401 });
}

module.exports = {
  id: 'qoder',
  label: 'Qoder (阿里)',
  homepage: 'https://qoder.com.cn',
  importLocal: true,
  credFields: [
    { name: 'pat', label: 'PAT（推荐，qoder.com.cn/account/integrations 生成）', secret: true, placeholder: 'pt-...' },
    { name: 'securityOauthToken', label: 'securityOauthToken（或 jobToken）', secret: true },
    { name: 'region', label: '区域', placeholder: 'cn（默认）或 intl' },
    { name: 'deviceToken', label: '机器指纹 Cosy-MachineToken（签到需要，可选）', secret: true },
  ],
  docs: '推荐用 PAT：Qoder 客户端 → 设置/账号 → Integrations 创建 Personal Access Token（pt- 开头）。也可「导入本机登录」自动读取 CLI 凭证。',

  // display -> internal mapping (from qoder2api research)
  _modelMap: {
    'Qwen3.8-Max': 'qmodel_38max', 'Qwen3.8-Flash': 'qfmodel', 'Qwen3.7-Max': 'qmodel_latest',
    'Qwen3.7-Plus': 'qmodel', 'Qwen3.7-Flash': 'q37fmodel', 'DeepSeek-V4-Pro': 'dmodel', 'DeepSeek-Flash': 'dfmodel',
    'GLM-5.3': 'gmodel', 'GLM-5.3-Flash': 'gfmodel', 'GLM-5.2': 'gm51model', 'Kimi-K3': 'kmodel_latest',
    'Kimi-K2.8-Preview': 'kmodel', 'MiniMax-M2.7': 'mmodel', Auto: 'auto',
  },

  async listModels(account) {
    // COSY-signed /model/list needs full crypto; expose the known static catalog (safe),
    // marking free/offpeak info via tags on the model rows.
    return Object.entries(this._modelMap).map(([display, key]) => ({ upstream: key, publicName: 'qoder-' + display.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '') }));
  },

  /**
   * 恢复在线目录：COSY 签名的 /algo/api/v2/model/list?Encode=1。
   * GET 的 body 必须是 qoderEncode({}) == "$kwm"，且签名 body 字段也用 "$kwm"（hub 行为）。
   * price_factor 即倍率（0 = 免费），带 vision/reasoning 标签与上下文窗口。
   */
  async listOnlineModels(account) {
    await ensureSession(account);
    const c = account.credentials;
    const { headers, body } = cosyBearer(account, { path: '/api/v2/model/list', bodyObj: {}, accept: 'application/json' });
    const r = await httpJson(`${c.jobGateway || gw(account)}/algo/api/v2/model/list?Encode=1`, {
      method: 'GET', headers, body, timeoutMs: 20000,
    });
    if (r.status !== 200) throw new Error(`model/list ${r.status}: ${String(r.text || '').slice(0, 150)}`);
    const j = r.json?.data || r.json || {};
    const list = j.chat || j.models || (Array.isArray(j) ? j : []);
    const models = [];
    const seen = new Set();
    for (const m of list) {
      const key = m.key || m.model_key || m.id;
      if (!key || seen.has(key) || m.enable === false) continue;
      seen.add(key);
      const rate = m.price_factor != null ? Number(m.price_factor) : null;
      const tags = [];
      if (m.is_vl) tags.push('vision');
      if (m.is_reasoning) tags.push('thinking');
      if (rate === 0) tags.push('free');
      if (m.max_input_tokens) tags.push(`${Math.round(m.max_input_tokens / 1000)}k`);
      models.push({
        upstream: key,
        publicName: key.toLowerCase(),
        free: rate === 0,
        multiplier: rate ?? 1,
        ctx: m.max_input_tokens || null,
        tags,
        online: true,
      });
    }
    if (!models.length) throw new Error('在线目录返回为空');
    return { models, replace: true, source: 'model/list (COSY)' };
  },

  async checkAccount(account) {
    // official quota endpoint needs securityOauthToken; PAT fallback -> /user/status
    const c = account.credentials;
    if (c.pat) {
      // PAT 账号：先 jobToken 交换（拿身份+jt- token），再用 jt- 查 quota
      await exchangePAT(account);
      const jtToken = c.jobToken;
      if (jtToken) {
        const q = await httpJson(`${openapiHost(account)}/api/v2/quota/usage`, {
          headers: { Authorization: `Bearer ${jtToken}`, 'User-Agent': 'Qoder', Accept: 'application/json' }, timeoutMs: 15000,
        }).catch(() => ({ status: 0, json: null }));
        if (q.status === 200) {
          const qq = q.json?.userQuota || {};
          const addOn = q.json?.addOnQuota || null;
          const remain = (qq.remaining ?? 0) + (addOn?.remaining ?? 0);
          const total = (qq.total ?? 0) + (addOn?.total ?? 0);
          return {
            ok: true,
            message: `积分 ${remain} / ${total}${addOn ? '（附加 ' + addOn.remaining + '/' + addOn.total + '）' : ''} · ${account.credentials.username || ''}`,
            extra: { credits: remain, quota: total, baseQuota: qq.remaining != null ? `${qq.remaining}/${qq.total}` : null, addOnQuota: addOn ? `${addOn.remaining}/${addOn.total}` : null, username: account.credentials.username, email: account.credentials.email, plan: account.credentials.plan, uid: account.credentials.userId },
          };
        }
      }
      return { ok: true, message: `PAT 有效 · ${account.credentials.username || ''} · plan ${account.credentials.plan || '?'}`, extra: { username: account.credentials.username, email: account.credentials.email, plan: account.credentials.plan, uid: account.credentials.userId } };
    }
    if (c.securityOauthToken) {
      const r = await httpJson(`${openapiHost(account)}/api/v2/quota/usage`, {
        headers: { Authorization: authHeader(account), 'User-Agent': 'Qoder', Accept: 'application/json' }, timeoutMs: 15000,
      });
      if (r.status === 200) {
        const q = r.json?.userQuota || r.json?.data?.userQuota || {};
        const addOn = r.json?.addOnQuota || r.json?.data?.addOnQuota || null;
        // 每日签到活动：顶层 claimable / campaigns（每日通常 +100 进 addOnQuota）
        let checkin = null;
        try {
          const camp = await httpJson(`${openapiHost(account)}/sash/api/v1/me/campaigns`, {
            headers: { Authorization: authHeader(account), 'User-Agent': 'Qoder', Accept: 'application/json' }, timeoutMs: 12000,
          });
          if (camp.status === 200 && camp.json) {
            checkin = {
              claimable: camp.json.claimable ? 1 : 0,
              showCampaign: !!camp.json.showCampaign,
              campaigns: (camp.json.campaigns || []).length,
            };
          }
        } catch { /* 签到接口失败不影响账号检查 */ }
        const remain = (q.remaining ?? 0) + (addOn?.remaining ?? 0);
        const total = (q.total ?? 0) + (addOn?.total ?? 0);
        return {
          ok: true,
          message: `积分 ${remain} / ${total}${q.total ? `（基础 ${q.remaining}/${q.total}` : ''}${addOn ? ` + 附加 ${addOn.remaining}/${addOn.total}）` : ''}${q.isQuotaExceeded ? ' (已超额)' : ''}${checkin?.claimable ? ' · 今日签到可领' : ''}`,
          extra: {
            credits: remain, quota: total,
            baseQuota: q.remaining != null ? `${q.remaining}/${q.total}` : null,
            addOnQuota: addOn ? `${addOn.remaining}/${addOn.total}` : null,
            percentage: q.percentage, checkin,
            uid: r.json?.userId || r.json?.userQuota?.userId || null,
            userType: r.json?.userType || null,
            expiresAt: q.expiresAt != null && q.expiresAt < 32503680000000 ? q.expiresAt : null,
          },
        };
      }
      if (r.status === 401 || r.status === 403) return { ok: false, status: 'invalid', message: `auth ${r.status}` };
      // fallthrough to user/status
    }
    const r2 = await httpJson(`${gw(account)}/algo/api/v3/user/status?Encode=1`, {
      method: 'POST',
      headers: { ...require('../utils/cosy').signatureHeaders(), Authorization: authHeader(account), 'cosy-machinetoken': getCosySession(account).machine.machineToken, 'cosy-machinetype': getCosySession(account).machine.machineType, 'cosy-machineid': getCosySession(account).machine.machineId },
      body: require('../utils/cosy').qoderEncode(JSON.stringify({})), timeoutMs: 15000,
    });
    if (r2.status === 200) return { ok: true, message: 'COSY 链路有效' };
    return { ok: false, status: r2.status === 401 ? 'invalid' : 'cooling', message: `status ${r2.status}` };
  },

  async *chat({ account, upstreamModel, messages, tools, params, signal, onUsage }) {
    // chat requires PAT→jobToken→COSY. dt- tokens cannot use the chat channel.
    try { ensureSession(account); } catch (e) { if (e.status) throw e; }
    const c = account.credentials;
    if (!c.pat && !c.jobToken) {
      // dt- token account without PAT: mark and fail fast with a clear message
      const { db } = require('../store');
      db.prepare("UPDATE accounts SET status='invalid', status_message=? WHERE id=?").run('缺少 PAT：聊天通道需要 pt- 令牌（客户端 → 设置 → 集成 创建后填入）', account.id);
      throw Object.assign(new Error('该账号缺少 PAT（聊天通道必须 pt- 令牌）：Qoder 客户端 → 设置 → 集成/Integrations 创建后，编辑账号填入'), { status: 401 });
    }
    const rid = crypto.randomUUID();
    // hub-style body: OpenAI-shaped messages at the top level (verified against the live gateway)
    const userMsg = [...messages].reverse().find(m => m.role === 'user');
    const lastUserParts = userMsg?.parts;
    const wireMessages = messages.map(m => {
      const out = { role: m.role, content: m.text ?? '' };
      if (m.parts?.some(p => p.type === 'image_url')) {
        out.content = m.parts.map(p => p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.url } });
      }
      return out;
    });
    const bodyObj = {
      model: upstreamModel,
      messages: wireMessages,
      stream: true,
      request_id: rid, chat_record_id: rid,
      request_set_id: crypto.randomUUID(), session_id: crypto.randomUUID(),
      user_id: c.userId || c.uid || '',
      uid: c.userId || c.uid || '',
      agent_id: 'agent_common',
      business: { id: crypto.randomUUID(), begin_at: Date.now() },
      model_config: { key: upstreamModel, source: 'system' },
      chat_context: {
        text: {
          // vision: image parts carried as image_url entries alongside text
          ...(lastUserParts?.some(p => p.type === 'image_url') ? {
            content: [
              { type: 'text', text: userMsg?.text || '' },
              ...lastUserParts.filter(p => p.type === 'image_url').map(p => ({ type: 'image_url', image_url: p.url })),
            ],
          } : {}),
          text: userMsg?.text || '',
        },
        extra: { modelConfig: { key: upstreamModel, source: 'system', ...(params.reasoning_effort && params.reasoning_effort !== 'none' ? { is_reasoning: true, reasoningEffort: params.reasoning_effort === 'xhigh' ? 'xhigh' : params.reasoning_effort === 'high' ? 'high' : 'medium' } : {}) }, originalContent: { text: userMsg?.text || '' } },
        // send short history (upstream expects its own context format; flat messages usually tolerated via text)
        history: messages.slice(0, -1).map(m => ({ role: m.role, text: m.text || '' })),
      },
      ...(params.max_tokens ? { max_tokens: params.max_tokens } : {}),
    };
    // COSY-signed request: body must be the custom-encoded string that was signed
    const { headers, body } = cosyBearer(account, {
      path: '/api/v2/service/pro/sse/agent_chat_generation',
      bodyObj, accept: 'text/event-stream', modelKey: upstreamModel,
    });
    const resp = await httpRequest(`${c.jobGateway || gw(account)}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`, {
      method: 'POST', headers, body, signal, timeoutMs: config.requestTimeoutMs,
    });
    if (resp.statusCode >= 400) {
      const text = await resp.body.text().catch(() => '');
      throw Object.assign(new Error(`qoder ${resp.statusCode}: ${text.slice(0, 300)}`), { status: resp.statusCode === 401 || resp.statusCode === 403 ? 401 : resp.statusCode });
    }
    for await (const { data } of sseParse(resp.body)) {
      if (data === '[DONE]') break;
      let env; try { env = JSON.parse(data); } catch { continue; }
      if (!env || typeof env !== 'object') continue;
      // envelope: {headers, body:"<json str>", statusCodeValue}
      const code = env.statusCodeValue;
      if (code === 401 || code === 403 || env.code === 105) {
        let msg = env.message || '';
        try { const b = typeof env.body === 'string' ? JSON.parse(env.body) : env.body; msg = msg || b?.message || ''; } catch {}
        throw Object.assign(new Error(`qoder session expired (${code})${msg ? ': ' + msg : ''}`), { status: 401 });
      }
      if (code === 418 || env.code === 10605) {
        throw Object.assign(new Error('qoder rate limited / concurrency'), { status: 429 });
      }
      let inner = env.body;
      if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { inner = null; } }
      if (!inner || typeof inner !== 'object' || !inner.choices) {
        // error/finish frames carry a code/message instead of choices — surface them
        if (inner?.code && inner.code !== 'OK' && inner.code !== 0) {
          throw Object.assign(new Error(`qoder: ${inner.message || inner.code}${inner.details ? ' · ' + String(inner.details).slice(0, 120) : ''}`), { status: 502 });
        }
        continue;
      }
      if (inner.usage) onUsage?.({ input_tokens: inner.usage.prompt_tokens, output_tokens: inner.usage.completion_tokens, credits: inner.credits ?? inner.original_credits });
      // inner is OpenAI-shaped choices[].delta
      yield JSON.stringify(inner);
    }
  },

  // scan local Qoder credentials: desktop app (DPAPI+GCM encrypted auth.v1.dat) and CLI auth files
  discoverLocal(regionFilter = null) {
    const fs = require('fs'), os = require('os'), path = require('path');
    const found = [];
    const home = os.homedir();
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    // 1) desktop apps (CN + intl)
    for (const [dir, region] of [['com.qodercn.app.stable', 'cn'], ['com.qoder.app.stable', 'intl']]) {
      if (regionFilter && region !== regionFilter) continue;
      const appdir = path.join(appData, dir);
      try {
        if (!fs.existsSync(path.join(appdir, 'auth.v1.dat'))) continue;
        const j = decryptDesktopAuth(appdir);
        const token = j.token || j.securityOauthToken || j.security_oauth_token;
        if (!token) { found.push({ label: `${dir}（解密成功但无 token）`, suggestName: null, credentials: null }); continue; }
        found.push({
          label: region === 'cn' ? '国内版' : '国际版',
          suggestName: region === 'cn' ? 'qoder-国内版' : 'qoder-国际版',
          credentials: {
            securityOauthToken: token,
            refreshToken: j.refreshToken || null,
            expiresAt: j.expiresAt ? Date.parse(j.expiresAt) || null : null,
            region,
          },
        });
      } catch (e) {
        found.push({ label: `${dir}（解密失败：${e.message}；可在面板粘贴 PAT）`, suggestName: null, credentials: null });
      }
    }
    // 2) CLI auth files
    for (const d of ['.qoder', '.qoder.cn']) {
      const region = d === '.qoder.cn' ? 'cn' : 'intl';
      if (regionFilter && region !== regionFilter) continue;
      const authFile = path.join(home, d, '.auth', 'user');
      try {
        if (!fs.existsSync(authFile)) continue;
        const raw = fs.readFileSync(authFile, 'utf8');
        let j = null;
        try { j = JSON.parse(raw); } catch { j = null; }
        const token = j?.accessToken || j?.security_oauth_token || j?.securityOauthToken;
        if (token) {
          found.push({
            label: region === 'cn' ? '国内版' : '国际版', suggestName: region === 'cn' ? 'qoder-国内版' : 'qoder-国际版',
            credentials: { securityOauthToken: token, refreshToken: j?.refresh_token || null, region },
          });
        } else {
          found.push({ label: (d === '.qoder.cn' ? '国内版' : '国际版') + '（加密，请在面板粘贴 PAT）', suggestName: null, credentials: null });
        }
      } catch { /* skip */ }
    }
    return found;
  },

  async importLocal(opts = {}) {
    const found = this.discoverLocal();
    const { importFound } = require('../core/localcred');
    if (opts.import) return { found, ...importFound('qoder', found, opts.names || []) };
    return { found };
  },
};
