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
  let s = cosySessions.get(account.id);
  if (!s) {
    const c = account.credentials;
    const { createSession } = require('../utils/cosy');
    s = createSession({
      uid: c.userId || c.uid || '',
      user_type: c.userType || 'personal_standard',
      securityOauthToken: c.securityOauthToken || c.jobToken || c.pat || '',
      refreshToken: c.refreshToken || '',
    });
    cosySessions.set(account.id, s);
  }
  return s;
}

/** signed data-plane request (chat / model list) — returns headers + encoded body string */
function cosyBearer(account, { path, bodyObj, accept, modelKey } = {}) {
  const { bearerRequest } = require('../utils/cosy');
  return bearerRequest(getCosySession(account), { path, bodyObj, accept, modelKey });
}

/**
 * PAT → jobToken exchange (signature plane). The gateway REQUIRES a PAT (pt-…) here:
 * a dt- OAuth token cannot be exchanged (source: fengyinxia/qoder2api qoder_auth.py —
 * "The gateway always requires personalToken (a PAT) on this endpoint").
 * Response provides jobToken + full identity (uid/userType/org) used for the COSY session.
 */
async function exchangePAT(account) {
  const c = account.credentials;
  const pat = c.pat || '';
  if (!pat) throw Object.assign(new Error('Qoder 聊天通道需要 PAT：客户端 → 设置 → Integrations 创建（pt- 开头）后填入账号'), { status: 401 });
  const { httpJson } = require('../utils/http');
  const { signatureHeaders, qoderEncode } = require('../utils/cosy');
  const inner = JSON.stringify({ userId: c.userId || '', personalToken: pat, securityOauthToken: '', refreshToken: '', needRefresh: false, authInfo: {} });
  const body = JSON.stringify({ payload: inner, encodeVersion: '1' });
  const r = await httpJson(`${gw(account)}/algo/api/v3/user/jobToken?Encode=1`, {
    method: 'POST', headers: { ...signatureHeaders(), Authorization: `Bearer ${pat}` }, body, timeoutMs: 20000,
  });
  if (r.status !== 200) throw Object.assign(new Error(`jobToken 交换失败 ${r.status}: ${String(r.text || '').slice(0, 120)}`), { status: 502 });
  const d = r.json?.data || r.json || {};
  return { jobToken: d.jobToken || d.job_token, identity: d.identity || d, raw: d };
}

/** ensure a COSY session built from a PAT exchange (cached) */
function ensurePATSession(account) {
  const c = account.credentials;
  if (c.pat && !cosySessions.get(account.id)) {
    // session identity fields will be refreshed from jobToken on first exchange
    return null;
  }
  return cosySessions.get(account.id);
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
   * 恢复在线目录：COSY 签名的 /algo/api/v2/model/list?Encode=1（GET，需带 "$kwm" body）。
   * 返回服务器当前真实可用模型（含内部 key 与显示名）。
   */
  async listOnlineModels(account) {
    const { httpJson } = require('../utils/http');
    const { headers, body } = cosyBearer(account, { path: '/api/v2/model/list', bodyObj: {}, accept: 'application/json' });
    const r = await httpJson(`${gw(account)}/algo/api/v2/model/list?Encode=1`, {
      method: 'GET', headers, body, timeoutMs: 20000,
    });
    if (r.status !== 200) throw new Error(`model/list ${r.status}: ${String(r.text || '').slice(0, 150)}`);
    const data = r.json?.data || r.json || {};
    const list = data.models || data.model_list || (Array.isArray(data) ? data : []);
    const models = [];
    const seen = new Set();
    for (const m of list) {
      const key = m.key || m.model_key || m.id || m.name;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      models.push({
        upstream: key,
        publicName: key.toLowerCase(),
        free: m.free === true || m.is_free === true,
        ctx: m.maxInputTokens || m.max_input_tokens || null,
        online: true,
      });
    }
    if (!models.length) throw new Error('在线目录返回为空');
    return { models, replace: true, source: 'model/list (COSY)' };
  },

  async checkAccount(account) {
    // official quota endpoint needs securityOauthToken; PAT fallback -> /user/status
    const c = account.credentials;
    if (c.securityOauthToken || c.pat) {
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
    if (account.credentials.pat) {
      try { await exchangePAT(account); } catch (e) { if (e.status === 401) throw e; /* fall through with cached session */ }
    } else if (!account.credentials.jobToken) {
      throw Object.assign(new Error('Qoder 聊天通道需要 PAT（dt- 登录 token 不被聊天网关接受）：客户端 → 设置 → Integrations 创建 pt- PAT，编辑账号填入'), { status: 401 });
    }
    const rid = crypto.randomUUID();
    const userMsg = [...messages].reverse().find(m => m.role === 'user');
    const lastUserParts = userMsg?.parts;
    const bodyObj = {
      request_id: rid,
      chat_record_id: rid,
      request_set_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      business: { id: crypto.randomUUID(), begin_at: Date.now() },
      stream: true,
      model_config: { key: upstreamModel },
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
        extra: { modelConfig: { key: upstreamModel, ...(params.reasoning_effort ? { reasoningEffort: params.reasoning_effort } : {}) }, originalContent: { text: userMsg?.text || '' } },
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
    const resp = await httpRequest(`${gw(account)}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`, {
      method: 'POST', headers, body, signal, timeoutMs: config.requestTimeoutMs,
    });
    if (resp.statusCode >= 400) {
      const text = await resp.body.text().catch(() => '');
      throw Object.assign(new Error(`qoder ${resp.statusCode}: ${text.slice(0, 300)}`), { status: resp.statusCode === 401 || resp.statusCode === 403 ? 401 : resp.statusCode });
    }
    for await (const { data } of sseParse(resp.body)) {
      if (data === '[DONE]') break;
      let env; try { env = JSON.parse(data); } catch { continue; }
      // envelope: {headers, body:"<json str>", statusCodeValue}
      const code = env.statusCodeValue;
      if (code === 401 || code === 403 || env.code === 105) {
        throw Object.assign(new Error(`qoder session expired (${code})`), { status: 401 });
      }
      if (code === 418 || env.code === 10605) {
        throw Object.assign(new Error('qoder rate limited / concurrency'), { status: 429 });
      }
      let inner = env.body;
      if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { inner = null; } }
      if (!inner) continue;
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
          label: `${dir.replace('.app.stable', '')} 桌面版`,
          suggestName: 'qoder-desktop-' + region,
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
            label: `${d} CLI`, suggestName: 'qoder-' + d.replace('.', ''),
            credentials: { securityOauthToken: token, refreshToken: j?.refresh_token || null, region },
          });
        } else {
          found.push({ label: `${d} CLI（加密，请在面板粘贴 PAT）`, suggestName: null, credentials: null });
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
