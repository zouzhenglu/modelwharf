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

  async checkAccount(account) {
    // official quota endpoint needs securityOauthToken; PAT fallback -> /user/status
    const c = account.credentials;
    if (c.securityOauthToken || c.pat) {
      const r = await httpJson(`${openapiHost(account)}/api/v2/quota/usage`, {
        headers: { Authorization: authHeader(account), 'User-Agent': 'Qoder', Accept: 'application/json' }, timeoutMs: 15000,
      });
      if (r.status === 200) {
        const q = r.json?.userQuota || r.json?.data?.userQuota || {};
        return {
          ok: true,
          message: `积分 ${q.remaining ?? '?'} / ${q.total ?? '?'}${q.isQuotaExceeded ? ' (已超额)' : ''}`,
          extra: { credits: q.remaining, quota: q.total, percentage: q.percentage },
        };
      }
      if (r.status === 401 || r.status === 403) return { ok: false, status: 'invalid', message: `auth ${r.status}` };
      // fallthrough to user/status
    }
    const r2 = await httpJson(`${gw(account)}/algo/api/v3/user/status?Encode=1`, {
      method: 'POST', headers: cosyHeaders(account, { Accept: 'application/json' }), body: {}, timeoutMs: 15000,
    });
    if (r2.status === 200) return { ok: true, message: '有效' };
    return { ok: false, status: r2.status === 401 ? 'invalid' : 'cooling', message: `status ${r2.status}` };
  },

  async *chat({ account, upstreamModel, messages, tools, params, signal, onUsage }) {
    const rid = crypto.randomUUID();
    const userMsg = [...messages].reverse().find(m => m.role === 'user');
    const body = {
      request_id: rid,
      chat_record_id: rid,
      request_set_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      business: { id: crypto.randomUUID(), begin_at: Date.now() },
      stream: true,
      model_config: { key: upstreamModel },
      chat_context: {
        text: { text: userMsg?.text || '' },
        extra: { modelConfig: { key: upstreamModel }, originalContent: { text: userMsg?.text || '' } },
        // send short history (upstream expects its own context format; flat messages usually tolerated via text)
        history: messages.slice(0, -1).map(m => ({ role: m.role, text: m.text || '' })),
      },
      ...(params.max_tokens ? { max_tokens: params.max_tokens } : {}),
    };
    const resp = await httpRequest(`${gw(account)}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`, {
      method: 'POST', headers: cosyHeaders(account), body, signal, timeoutMs: config.requestTimeoutMs,
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
