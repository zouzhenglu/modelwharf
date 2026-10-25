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
const { REGIONS, normalizeRegion } = require('./_qoder_names');
const { dsmlToolDoc, mapToolMessage, DSMLStreamFilter, newToolCallId } = require('../utils/dsml');

// Qoder 桌面端在本机的存放目录（%APPDATA%），国内版与国际版各自独立安装、独立登录
const DESKTOP_DIRS = [
  { dir: 'com.qodercn.app.stable', region: 'cn' },
  { dir: 'com.qoder.app.stable', region: 'intl' },
];
// Qoder CLI 的认证文件（~/.qoder-cn、~/.qoder）
const CLI_DIRS = [
  { dir: '.qoder-cn', region: 'cn' },
  { dir: '.qoder.cn', region: 'cn' },
  { dir: '.qoder', region: 'intl' },
];

// 目录里的「Qoder 自有档位」：没有对应的公开模型族，名字太泛（auto/performance…），
// 保留 qoder- 前缀，避免与其他平台的同名档位混淆。
const GENERIC_NAMES = new Set(['auto', 'performance', 'efficient', 'ultimate', 'smodel', 'cmodel']);

// qoder.js 是国际版通道；qodercn.js 通过 account.regionOverride 锁定中国区。
// 凭据里没写 region 的历史账号按国际版处理。
const DEFAULT_REGION = 'intl';

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

/**
 * 账号实际使用的区域。
 *
 * regionOverride 是 qodercn 这类「区域锁定通道」用的开关：它挂在 account 对象上而
 * 不在 credentials 里，所以永远不会被 finishExchange 落库——否则中国版通道碰过的
 * 国际版账号，region 会被永久改写成 cn，之后所有请求都打到中国网关而失败。
 */
function regionOf(account) {
  const c = account.credentials || {};
  return normalizeRegion(account.regionOverride || c.region, DEFAULT_REGION);
}

function gw(account) {
  const c = account.credentials || {};
  if (c.gateway) return c.gateway;
  return REGIONS[regionOf(account)].gateway;
}
function openapiHost(account) {
  return REGIONS[regionOf(account)].openapi;
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
    const other = regionOf(account) === 'intl' ? REGIONS.cn : REGIONS.intl;
    const r2 = await httpJson(`${other.gateway}/algo/api/v3/user/jobToken?Encode=1`, {
      method: 'POST', headers: { ...signatureHeaders(), Authorization: `Bearer ${pat}` }, body: qoderEncode(Buffer.from(outer)), timeoutMs: 20000,
    });
    if (r2.status !== 200) throw Object.assign(new Error(`jobToken 交换失败（双网关 ${r.status}/${r2.status}）：${String(r.text || '').slice(0, 120)}`), { status: 502 });
    return finishExchange(account, r2.json);
  }
  return finishExchange(account, r.json);
}

/** consume a successful jobToken response: persist identity + tokens, build COSY session */
function finishExchange(account, json) {
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

/**
 * jt- jobToken 过期后的刷新（hub 行为，按 refresh token 前缀路由）：
 *   drt- → POST openapi /api/v1/deviceToken/refresh
 *   jrt- → POST openapi /api/v1/jobToken/refresh
 * 两者失败且有 PAT → 回落 jobToken 重交换。成功返回新令牌（已落库）。
 */
async function refreshJobToken(account) {
  const c = account.credentials;
  const { db } = require('../store');
  const rt = String(c.refreshToken || '');
  const plainH = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Go-http-client/2.0' };
  const tryRefresh = async (path) => {
    const r = await httpJson(`${openapiHost(account)}${path}`, {
      method: 'POST', headers: plainH, body: { refresh_token: rt }, timeoutMs: 30000,
    });
    const token = r.json?.token || r.json?.securityOauthToken || r.json?.device_token;
    if (r.status !== 200 || !token) return null;
    const expiresAt = r.json.expires_in ? Date.now() + Number(r.json.expires_in)
      : (r.json.expireTime ? Number(r.json.expireTime) : null);
    const fresh = {
      ...c,
      jobToken: token,
      refreshToken: r.json.refresh_token || c.refreshToken,
      ...(expiresAt ? { jobExpiresAt: expiresAt < 1e12 ? expiresAt * 1000 : expiresAt } : {}),
    };
    db.prepare('UPDATE accounts SET credentials=? WHERE id=?').run(JSON.stringify(fresh), account.id);
    account.credentials = fresh;
    return token;
  };
  if (rt.startsWith('drt-')) {
    const t = await tryRefresh('/api/v1/deviceToken/refresh');
    if (t) return t;
  }
  if (rt.startsWith('jrt-')) {
    const t = await tryRefresh('/api/v1/jobToken/refresh');
    if (t) return t;
  }
  if (c.pat) { await exchangePAT(account); return account.credentials.jobToken; }
  return null;
}

/**
 * 扫描本机 Qoder 登录态：桌面端（%APPDATA% 下 DPAPI+GCM 加密的 auth.v1.dat）与 CLI 认证文件。
 * 两个版本都装时按 regionFilter 各取各的，label / 建议账号名统一走 _qoder_names。
 * 聊天通道严格需要 PAT（pt-）；桌面/CLI 的 dt- 令牌只能查积分，因此不作为可导入项返回，
 * 而是给出「去客户端创建 PAT 后手动添加」的提示。
 */
function scanLocal(regionFilter = null) {
  const fs = require('fs'), os = require('os'), path = require('path');
  const found = [];
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const usable = (c) => c.pat || String(c.securityOauthToken || '').startsWith('pt-');
  const noPatHint = (r) => `${REGIONS[r].scanLabel}（本机登录态无 PAT，聊天不可用；在客户端 设置 → 集成 创建 pt- PAT 后到面板手动添加）`;

  // 1) 桌面端（国内版 + 国际版各自独立安装、独立登录）
  for (const { dir, region } of DESKTOP_DIRS) {
    if (regionFilter && region !== regionFilter) continue;
    const appdir = path.join(appData, dir);
    try {
      if (!fs.existsSync(path.join(appdir, 'auth.v1.dat'))) continue;
      const j = decryptDesktopAuth(appdir);
      const token = j.token || j.securityOauthToken || j.security_oauth_token;
      if (!token) {
        found.push({ label: `${REGIONS[region].scanLabel}（解密成功但无 token）`, suggestName: null, credentials: null });
        continue;
      }
      const creds = {
        securityOauthToken: token,
        refreshToken: j.refreshToken || null,
        expiresAt: j.expiresAt ? Date.parse(j.expiresAt) || null : null,
        region,
      };
      if (!usable(creds)) {
        found.push({ label: noPatHint(region), suggestName: null, credentials: null });
        continue;
      }
      found.push({ label: REGIONS[region].scanLabel, suggestName: REGIONS[region].accountName, credentials: creds });
    } catch (e) {
      found.push({ label: `${REGIONS[region].scanLabel}（解密失败：${e.message}；可在面板粘贴 PAT）`, suggestName: null, credentials: null });
    }
  }
  // 2) CLI 认证文件（~/.qoder-cn、~/.qoder 等）
  for (const { dir, region } of CLI_DIRS) {
    if (regionFilter && region !== regionFilter) continue;
    const authFile = path.join(home, dir, '.auth', 'user');
    try {
      if (!fs.existsSync(authFile)) continue;
      const raw = fs.readFileSync(authFile, 'utf8');
      let j = null;
      try { j = JSON.parse(raw); } catch { j = null; }
      const token = j?.accessToken || j?.security_oauth_token || j?.securityOauthToken;
      const pat = j?.personalAccessToken || j?.pat;
      if (pat && String(pat).startsWith('pt-')) {
        found.push({ label: REGIONS[region].scanLabel, suggestName: REGIONS[region].accountName, credentials: { pat, region } });
      } else if (token) {
        found.push({ label: noPatHint(region), suggestName: null, credentials: null });
      } else {
        found.push({ label: `${REGIONS[region].scanLabel}（加密，请在面板粘贴 PAT）`, suggestName: null, credentials: null });
      }
    } catch { /* skip */ }
  }
  return found;
}

module.exports = {
  // 供 qodercn 复用同一份扫描实现（各自只扫自己那一个区域）
  scanLocal,

  // 命名统一由 _qoder_names.js 提供（国内版/国际版共用一套叫法）
  id: 'qoder',
  label: REGIONS.intl.display,
  homepage: REGIONS.intl.homepage,
  importLocal: true,
  region: 'intl',
  credFields: [
    { name: 'pat', label: 'PAT（推荐，客户端 → 设置 → 集成/Integrations 生成）', secret: true, placeholder: 'pt-...' },
    { name: 'securityOauthToken', label: 'securityOauthToken（或 jobToken）', secret: true },
    { name: 'region', label: '区域', placeholder: 'intl（默认）或 cn' },
    { name: 'deviceToken', label: '机器指纹 Cosy-MachineToken（签到需要，可选）', secret: true },
  ],
  docs: '推荐用 PAT：Qoder 客户端 → 设置/账号 → Integrations 创建 Personal Access Token（pt- 开头）。也可「导入本机登录」自动读取本机客户端凭证。',

  // display -> internal mapping (from qoder2api research)
  _modelMap: {
    'Qwen3.8-Max': 'qmodel_38max', 'Qwen3.8-Flash': 'qfmodel', 'Qwen3.7-Max': 'qmodel_latest',
    'Qwen3.7-Plus': 'qmodel', 'Qwen3.7-Flash': 'q37fmodel', 'DeepSeek-V4-Pro': 'dmodel', 'DeepSeek-Flash': 'dfmodel',
    'GLM-5.3': 'gmodel', 'GLM-5.3-Flash': 'gfmodel', 'GLM-5.2': 'gm51model', 'Kimi-K3': 'kmodel_latest',
    'Kimi-K2.8-Preview': 'kmodel', 'MiniMax-M2.7': 'mmodel', Auto: 'auto',
  },

  /**
   * 展示名 → 对外模型名。
   * 不加平台前缀：Qoder 目录里的 Qwen/GLM/Kimi/DeepSeek 与 trae、workbuddy、qwenwork
   * 是同一批模型族，名字对齐后「统一模型」页才能按同名把它们聚合成一个入口。
   * 平台归属由 models.provider_id 区分（重名不冲突，唯一约束是 provider_id+public_name）。
   * 例外：Qoder 自有档位（auto 智能路由等）没有对应模型族，保留 qoder- 前缀以免名字过泛。
   */
  _publicNameFor(display) {
    const flat = display.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
    return GENERIC_NAMES.has(flat) ? `qoder-${flat}` : flat;
  },

  async listModels(account) {
    // Prefer the live COSY-signed catalog; fall back to the known static catalog
    // (marked static so refresh-models never pollutes a live-synced list).
    try {
      return (await this.listOnlineModels(account)).models;
    } catch (e) {
      logger.warn(`qoder listModels: ${e.message} — falling back to static list`);
    }
    return Object.entries(this._modelMap).map(([display, key]) => ({ upstream: key, publicName: this._publicNameFor(display), static: true }));
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
    const displayByKey = Object.fromEntries(Object.entries(this._modelMap).map(([display, key]) => [key, display]));
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
        publicName: displayByKey[key] ? this._publicNameFor(displayByKey[key]) : key.toLowerCase(),
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

  /**
   * 每日签到（活动平台 /sash）：仅国内版（qodercn 通过 asCn 走这里）。
   * 国际版已按用户要求禁用：国际版活动平台强校验真实 UMID 机器身份且领取
   * 语义不稳（同人去重按"人"不按号），实测体验差，不做自动领取——用户在
   * 官方客户端里手动领。
   *
   * 国内版流程：GET campaigns 列活动 → 逐个领取 CLAIMABLE 且 CLAIM_BENEFIT 的
   * （每日 100 Credits 就是这里发的）。官方签到接口 /sash/api/v1/me/daily-check-in/*
   * 国内 DISABLED，campaigns 是正路。
   * 令牌链：PAT 账号先确保 jt- jobToken 新鲜（过期走 jrt- 刷新/重交换）；401 时
   * 刷新 → PAT 重交换 → 另一区域 openapi 域名兜底。
   * 风控：桌面端头 UA=Qoder + cosy-clienttype:10 + cosy-version 必需（缺了不报错
   * 但返回空列表）；有官方客户端时用 runtime-info.exe 的**真实** UMID 发全套六头
   * （本机无客户端则一个机器头都不发，绝不发派生假头——会被判非官方客户端过滤）。
   * claim 幂等：已领返回 CLAIMED+replayed 或 409；同人去重 BLOCKED/SAME_PERSON_ALREADY_CLAIMED。
   */
  async checkin(account) {
    if (regionOf(account) !== 'cn') {
      return { ok: null, skipped: true, message: 'Qoder 国际版签到已禁用：请在官方客户端手动领取（国际版活动平台强校验机器身份，自动领取不可靠）' };
    }
    const c = account.credentials;
    if (c.pat) { try { await exchangePAT(account); } catch { /* 带旧 token 试一次 */ } }
    let token = c.jobToken || c.securityOauthToken || c.pat;
    if (!token) return { ok: false, message: '缺少令牌（PAT / jobToken），无法访问活动平台' };
    if (c.jobExpiresAt && Date.now() > c.jobExpiresAt - 5 * 60 * 1000 && !c.pat) {
      token = (await refreshJobToken(account).catch(() => null)) || token;
    }
    const { nativeMachineIdentity } = require('../utils/umid');
    const machineHeaders = (tok) => {
      const h = {
        Accept: 'application/json', 'User-Agent': 'Qoder',
        'cosy-clienttype': '10', 'cosy-version': c.cosyVersion || '1.1.64',
        Authorization: `Bearer ${tok}`,
      };
      const ident = nativeMachineIdentity(regionOf(account), c.userId || c.uid || '');
      if (ident) {
        h['cosy-machineid'] = ident.machineCode;          // 与派生方案不同：code 即 id（hub 行为）
        h['cosy-machinetoken'] = ident.machineToken;
        h['cosy-machinetype'] = ident.machineType;
        h['cosy-machinecode'] = ident.machineCode;
        h['cosy-machineos'] = ident.machineOs;
        h['cosy-machinehostname'] = ident.hostname;
      }
      return h;
    };
    // 401 自愈：jrt- 刷新 → PAT 重交换 → 另一区域 openapi 域名（jobToken 可能属于另一个区）
    const fetchCampaigns = async (tok, host) => httpJson(`${host}/sash/api/v1/me/campaigns`, { headers: machineHeaders(tok), timeoutMs: 25000 });
    let camp = await fetchCampaigns(token, openapiHost(account));
    if (camp.status === 401 || camp.status === 403) {
      const refreshed = await refreshJobToken(account).catch(() => null);
      if (refreshed) {
        token = refreshed;
        camp = await fetchCampaigns(token, openapiHost(account));
      }
    }
    if ((camp.status === 401 || camp.status === 403) && c.pat) {
      try { await exchangePAT(account); token = account.credentials.jobToken || token; camp = await fetchCampaigns(token, openapiHost(account)); } catch { /* 继续走 fallback host */ }
    }
    if (camp.status === 401 || camp.status === 403) {
      const otherHost = regionOf(account) === 'intl' ? REGIONS.cn.openapi : REGIONS.intl.openapi;
      camp = await fetchCampaigns(token, otherHost);
      if (camp.status === 200 && camp.json && typeof camp.json === 'object') {
        // 令牌属于另一区域：本轮后续请求（claim/quota）都打到那边
        return this._checkinOnHost(account, token, otherHost, camp.json);
      }
      return { ok: false, message: `活动平台鉴权失败（双区 openapi 均 ${camp.status}）：PAT 可能已过期，请在客户端重新生成`, raw: { status: camp.status, json: camp.json, text: String(camp.text || '').slice(0, 300) } };
    }
    if (camp.status !== 200 || !camp.json || typeof camp.json !== 'object') {
      // 404/405/410 = 该区域没有活动平台
      if ([404, 405, 410].includes(camp.status)) return { ok: null, message: `本区域无活动接口（HTTP ${camp.status}）` };
      return { ok: false, message: `活动列表查询失败 HTTP ${camp.status}`, raw: { status: camp.status, json: camp.json, text: String(camp.text || '').slice(0, 300) } };
    }
    return this._checkinOnHost(account, token, openapiHost(account), camp.json);
  },

  /** 活动列表已就绪后的领取流程（host=本轮活动平台实际可用的 openapi 域名） */
  async _checkinOnHost(account, token, host, campJson) {
    const c = account.credentials;
    const { nativeMachineIdentity } = require('../utils/umid');
    const listHeaders = (() => {
      const h = {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Qoder',
        'cosy-clienttype': '10', 'cosy-version': c.cosyVersion || '1.1.64',
        Authorization: `Bearer ${token}`,
      };
      const ident = nativeMachineIdentity(regionOf(account), c.userId || c.uid || '');
      if (ident) {
        h['cosy-machineid'] = ident.machineCode;
        h['cosy-machinetoken'] = ident.machineToken;
        h['cosy-machinetype'] = ident.machineType;
        h['cosy-machinecode'] = ident.machineCode;
        h['cosy-machineos'] = ident.machineOs;
        h['cosy-machinehostname'] = ident.hostname;
      }
      return h;
    })();
    const list = Array.isArray(campJson.campaigns) ? campJson.campaigns : [];
    const claimable = list.filter(x => {
      const status = String(x.claimStatus || x.claim_status || '').toUpperCase();
      const action = String(x.actionType || x.action_type || '');
      const kind = String(x.benefit?.kind || '').toUpperCase();
      const rewardish = Number(x.benefit?.amount || 0) > 0 || kind === 'CREDITS' || !kind;
      return status === 'CLAIMABLE' && (action === '' || action === 'CLAIM_BENEFIT') && rewardish;
    });
    const claimed = list.filter(x => {
      const status = String(x.claimStatus || x.claim_status || '').toUpperCase();
      const action = String(x.actionType || x.action_type || '');
      const amount = Number(x.benefit?.amount || 0);
      return status === 'CLAIMED' && (amount > 0 || action === '' || action === 'CLAIM_BENEFIT');
    });
    if (!claimable.length) {
      // 已领取的活动后面可能被官方降级成 VIEW_DETAILS，所以 claimed 判定放宽到 amount>0
      if (claimed.length) {
        const amount = claimed.reduce((s, x) => s + Number(x.benefit?.amount || 0), 0);
        return { ok: true, already: true, gained: 0, message: `今日已领取（${amount || '?'} Credits）` };
      }
      if (campJson.showCampaign === false) return { ok: null, message: '暂无可领活动（客户端身份未通过风控，列表被隐藏）' };
      return { ok: null, message: '暂无可领取的活动' };
    }
    let earned = 0; const names = []; const failures = [];
    let lastFailureRaw = null;
    for (const x of claimable) {
      const cid = x.campaignId || x.campaign_id;
      const title = (() => {
        for (const pl of x.placements || []) {
          const zh = pl?.content?.zh || pl?.content?.en || {};
          if (zh.title) return zh.title;
        }
        return x.campaignKey || cid;
      })();
      const cr = await httpJson(`${host}/sash/api/v1/me/campaigns/${encodeURIComponent(cid)}/claim`, {
        method: 'POST', headers: { ...listHeaders, 'Content-Type': 'application/json' }, body: {}, timeoutMs: 20000,
      });
      const amount = Number(x.benefit?.amount || 0);
      if (cr.status === 200 && cr.json) {
        const status = String(cr.json.status || '').toUpperCase();
        const failure = String(cr.json.failureCode || '').toUpperCase();
        if (failure === 'SAME_PERSON_ALREADY_CLAIMED' || status === 'BLOCKED') {
          failures.push(`${title}: 同人已领取（同设备其他账号本轮已领）`);
          continue;
        }
        if (['CLAIMED', 'GRANTED', 'SUCCESS'].includes(status) || cr.json.replayed) {
          earned += amount; names.push(`${title}${amount ? ` +${amount}` : ''}`);
          continue;
        }
        failures.push(`${title}: ${status || JSON.stringify(cr.json).slice(0, 80)}`);
      } else if (cr.status === 409) {
        earned += amount; names.push(`${title}${amount ? ` +${amount}` : ''}（幂等确认）`);
      } else {
        failures.push(`${title}: HTTP ${cr.status}`);
        lastFailureRaw = { status: cr.status, json: cr.json, text: String(cr.text || '').slice(0, 300) };
      }
    }
    // 领完回查额度
    const q = await httpJson(`${host}/api/v2/quota/usage`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Qoder', Accept: 'application/json' }, timeoutMs: 15000,
    }).catch(() => ({ status: 0 }));
    let extra;
    if (q.status === 200 && q.json) {
      const qq = q.json.userQuota || {}, addOn = q.json.addOnQuota || null;
      extra = { credits: (qq.remaining ?? 0) + (addOn?.remaining ?? 0), quota: (qq.total ?? 0) + (addOn?.total ?? 0) };
    }
    if (names.length) {
      return {
        ok: true, gained: earned || null,
        message: `领取成功 ${names.join('、')}${failures.length ? `；另有失败：${failures.join('；')}` : ''}`,
        extra,
      };
    }
    return { ok: false, message: `领取失败：${failures.join('；')}`, extra, raw: lastFailureRaw };
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
    // 上游没有原生 tools 字段：带 tools 的请求走文本工具协议——提示词注入工具清单，
    // 历史里的 tool_calls/tool 消息转成文本（DSML 协议），响应侧再把 DSML 解析回 tool_calls
    const useTools = Array.isArray(tools) && tools.length > 0 && params.tool_choice !== 'none';
    const toWire = (m) => {
      const out = { role: m.role, content: m.text ?? '' };
      if (m.parts?.some(p => p.type === 'image_url')) {
        out.content = m.parts.map(p => p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.url } });
      }
      return out;
    };
    const wireMessages = [
      ...(useTools ? [{ role: 'system', content: dsmlToolDoc(tools) }] : []),
      ...messages.map(m => mapToolMessage(m) || toWire(m)),
    ];
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
        history: messages.slice(0, -1).map(m => {
          const w = mapToolMessage(m) || toWire(m);
          return { role: w.role, text: Array.isArray(w.content) ? (m.text || '') : String(w.content ?? '') };
        }),
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
    // 正文里的 DSML 块一律在流式增量里解析成 OpenAI tool_calls（请求不带 tools 时模型也会按
    // 训练格式自发输出，裸透传就是标签汤）；tools 供缺失 invoke 名字时按参数 schema 推断
    const conv = new DSMLStreamFilter(tools);
    let callIndex = 0, finishSent = false;
    const emitCall = function* ({ name, arguments: args }) {
      const id = newToolCallId();
      yield JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: callIndex, id, type: 'function', function: { name, arguments: '' } }] } }] });
      yield JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: callIndex, function: { name: '', arguments: args } }] } }] });
      callIndex++;
    };
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
      if (!conv) { yield JSON.stringify(inner); continue; }
      for (const [ci, ch] of (inner.choices || []).entries()) {
        const idx = ch.index ?? ci;
        const d = ch.delta || {};
        if (d.tool_calls?.length) yield JSON.stringify({ choices: [{ index: idx, delta: { tool_calls: d.tool_calls } }] });
        if (d.reasoning_content) yield JSON.stringify({ choices: [{ index: idx, delta: { reasoning_content: d.reasoning_content } }] });
        if (d.content) {
          const { content, calls } = conv.push(d.content);
          if (content) yield JSON.stringify({ choices: [{ index: idx, delta: { content } }] });
          for (const call of calls) yield* emitCall(call);
        }
        if (ch.finish_reason) {
          finishSent = true;
          yield JSON.stringify({ choices: [{ index: idx, delta: {}, finish_reason: conv.sawCalls ? 'tool_calls' : ch.finish_reason }] });
        }
      }
    }
    if (conv) {
      const tail = conv.flush();
      if (tail.content) yield JSON.stringify({ choices: [{ delta: { content: tail.content } }] });
      for (const call of tail.calls) yield* emitCall(call);
      if (conv.sawCalls && !finishSent) yield JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    }
  },

  // 扫描实现见模块级 scanLocal()：qoder 只扫国际版，qodercn 只扫国内版。

  /**
   * 只扫国际版。国内版由 qodercn 插件扫——两个通道各管各的区域，
   * 否则启动时 qoder 先扫会把两个版本都收进来，qodercn 名下永远空着，
   * 表现就是面板里「Qoder 中国版」拉不到模型（它根本没有账号可拉）。
   */
  discoverLocal(regionFilter = null) { return scanLocal(regionFilter || 'intl'); },

  async importLocal(opts = {}) {
    const found = this.discoverLocal();
    const { importFound } = require('../core/localcred');
    if (opts.import) return { found, ...importFound('qoder', found, opts.names || []) };
    return { found };
  },
};
