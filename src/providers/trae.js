'use strict';
/**
 * Trae provider (ByteDance AI IDE) — CN & International.
 *
 * Reference projects: JeffHu0912/trae2api (Go), Trae2api-cn (Python), A-23187/trae-api.
 * Upstream facts (as of 2026-10):
 *  - Chat gateway: https://trae-api-cn.mchost.guru (CN) / https://trae-api-sg.mchost.guru (intl)
 *  - Chat endpoint: POST /api/agent/v3/llm_utils_chat  (SSE)
 *  - Models: POST /api/ide/v1/get_detail_param -> config_info_list[].config_name
 *  - Auth: Authorization: Cloud-IDE-JWT <token> (+ X-Cloudide-Token header)
 *  - Token refresh: POST https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken
 *  - Credits: POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status
 *  - Local token: %APPDATA%/Trae CN/User/globalStorage/storage.json key
 *      "iCubeAuthInfo://icube.cloudide"  (base64 AES-128-CBC or plain JSON; decrypt needs salt reverse —
 *      we support plain JSON + raw token fields; encrypted blobs require manual token paste)
 */
const { httpJson, httpRequest, config, logger } = require('../utils/http');
const { sseParse } = require('../utils/sse');
const crypto = require('crypto');
const path = require('path');

// ---- local storage decryption (format reverse-engineered by Trae2api-cn) ----
const SALT_A = Buffer.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const SALT_B = Buffer.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);
const SALT_C = Buffer.from([191,192,216,250,122,246,220,97,31,254,98,27,8,72,71,176,135,99,96,18,127,101,203,104,211,102,191,125,37,72,150,156,51,229,121,35,17,153,141,177,110,131,150,128,172,255,254,6,18,140,55,62,236,249,135,64,135,12,117,4,89,149,168,209]);
const SALT_D = Buffer.from([246,204,26,232,232,70,129,109,223,146,169,242,23,241,105,145,50,196,165,42,254,120,3,54,244,207,209,85,53,6,138,106,175,148,31,204,186,186,165,182,87,142,49,10,39,110,26,154,86,56,173,125,18,64,198,225,99,99,83,82,191,134,76,170]);
const xorBuf = (a, b) => Buffer.from(a.map((v, i) => v ^ b[i]));
const SALT_AB = xorBuf(SALT_A, SALT_B), SALT_CD = xorBuf(SALT_C, SALT_D);

/** decrypt one iCubeAuthInfo value: base64( [6B tc-header][32B random][AES-128-CBC] ) -> JSON */
function decryptStorageValue(b64) {
  const buf = Buffer.from(b64, 'base64');
  const header = buf.subarray(0, 6), random = buf.subarray(6, 38), enc = buf.subarray(38);
  const isPrivate = header.equals(Buffer.from([18, 57, 32, 32, 2, 3]));
  if (!isPrivate && !(header[0] === 0x74 && header[1] === 0x63 && header[2] === 0x05 && header[3] === 0x10 && header[4] === 0x00 && header[5] === 0x00)) {
    throw new Error('unknown header ' + header.toString('hex'));
  }
  const salt = isPrivate ? SALT_CD : SALT_AB;
  const h1 = crypto.createHash('sha512').update(random).digest();
  const h2 = crypto.createHash('sha512').update(Buffer.concat([h1, salt])).digest();
  const d = crypto.createDecipheriv('aes-128-cbc', h2.subarray(0, 16), h2.subarray(16, 32));
  const pt = Buffer.concat([d.update(enc), d.final()]);
  const pad = pt[pt.length - 1];
  const body = pt.subarray(64, pt.length - (pad >= 1 && pad <= 16 ? pad : 0));
  if (!crypto.createHash('sha512').update(body).digest().equals(pt.subarray(0, 64))) {
    throw new Error('checksum mismatch');
  }
  return JSON.parse(body.toString('utf8'));
}

const CN = {
  chat: 'https://trae-api-cn.mchost.guru',
  oauth: 'https://api.trae.com.cn',
  ug: 'https://api.trae.cn',
};
const INTL = {
  chat: 'https://trae-api-sg.mchost.guru',
  oauth: 'https://api.trae.ai',
  ug: 'https://api.trae.ai',
};

function hosts(account) {
  const region = account.credentials.region || 'cn';
  return region === 'intl' ? INTL : CN;
}

function ideHeaders(account, extra = {}) {
  const c = account.credentials;
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': c.userAgent || 'Trae/0.1.52',
    Authorization: `Cloud-IDE-JWT ${c.token}`,
    'X-Cloudide-Token': c.token,
    'X-App-Id': c.appId || '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'X-Ide-Version': c.ideVersion || '0.1.52',
    'X-Ide-Version-Code': c.versionCode || '20260811',
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': c.deviceType || 'windows',
    'X-OS-Version': c.osVersion || 'Windows 10.0.26300',
    'X-Device-Brand': c.deviceBrand || '8P15V',
    'X-App-Version': 'default',
    'Request-Traffic-Type': 'prod',
    ...(c.uid ? { 'X-Uid': String(c.uid) } : {}),
    ...(c.machineId ? { 'X-Machine-Id': c.machineId } : {}),
    ...(c.deviceId ? { 'X-Device-Id': c.deviceId } : {}),
    ...extra,
  };
}

async function ensureToken(account) {
  const c = account.credentials;
  // refresh if expired within 5 min and refreshToken available
  const exp = c.expiresAt || 0;
  if (c.refreshToken && exp && Date.now() > exp - 5 * 60 * 1000) {
    logger.info(`trae[${account.name}] refreshing token`);
    const region = c.region === 'intl' ? INTL : CN;
    const r = await httpJson(`${region.oauth}/cloudide/api/v3/trae/oauth/ExchangeToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Trae/0.1.52' },
      body: { ClientID: c.clientId || 'en1oxy7wnw8j9n', RefreshToken: c.refreshToken, ClientSecret: '-', UserID: String(c.uid || '') },
    });
    if (r.status === 200 && r.json?.Result?.Token) {
      const res = r.json.Result;
      c.token = res.Token;
      c.expiresAt = res.TokenExpireAt || (Date.now() + (res.TokenExpireDuration || 3600) * 1000);
      c.refreshToken = res.RefreshToken || c.refreshToken;
      // persist back into db
      const { db } = require('../store');
      db.prepare('UPDATE accounts SET credentials=? WHERE id=?').run(JSON.stringify(c), account.id);
      logger.info(`trae[${account.name}] token refreshed`);
    } else {
      throw Object.assign(new Error(`token refresh failed: ${r.status}`), { status: 401 });
    }
  }
  return c.token;
}

module.exports = {
  id: 'trae',
  label: 'Trae (字节)',
  homepage: 'https://www.trae.cn',
  importLocal: true,
  credFields: [
    { name: 'token', label: 'Access Token (Cloud-IDE-JWT)', required: true, secret: true, placeholder: 'eyJhbGci…' },
    { name: 'refreshToken', label: 'Refresh Token（可选，用于自动续期）', secret: true },
    { name: 'region', label: '区域', placeholder: 'cn 或 intl（默认 cn）' },
    { name: 'uid', label: 'UID（可选）' },
  ],
  docs: '打开本机 Trae IDE，从 %APPDATA%/Trae CN/User/globalStorage/storage.json 的 "iCubeAuthInfo://icube.cloudide" 取 token；或用「导入本机登录」自动发现。也可用抓包工具从 IDE 请求头取 Authorization token。',

  async listModels(account) {
    try {
      await ensureToken(account);
      const r = await httpJson(`${hosts(account).chat}/api/ide/v1/get_detail_param`, {
        method: 'POST',
        headers: ideHeaders(account),
        body: { function: 'solo_work_lite', config_names: null, need_prompt: false, current_config_info: null, poly_prompt: true, mode_type: null, agent_type: null },
        timeoutMs: 20000,
      });
      if (r.status !== 200) throw new Error(`get models ${r.status}`);
      const list = r.json?.data?.config_info_list || r.json?.config_info_list || [];
      const models = new Map();
      for (const cfg of list) {
        const name = cfg.config_name;
        if (name && !models.has(name)) models.set(name, { upstream: name, free: cfg.is_free || cfg.free });
        for (const md of cfg.model_detail_list || []) {
          if (md.model_name && !models.has(md.model_name)) models.set(md.model_name, { upstream: md.model_name });
        }
      }
      return [...models.values()];
    } catch (e) {
      logger.warn(`trae listModels failed: ${e.message} — falling back to static list`);
      return ['glm-5.2', 'glm-5.3', 'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash', 'Doubao-Seed-2.1-Pro', 'kimi-k2.6', 'qwen-3.7-plus', 'minimax-m3']
        .map(m => ({ upstream: m, static: true }));
    }
  },

  /**
   * 恢复在线目录：get_detail_param 返回的就是 Trae 当前真实可用的模型目录，
   * 与 IDE 里看到的一致。标记 online 供 reset 流程替换现有列表。
   */
  async listOnlineModels(account) {
    const models = (await this.listModels(account)).filter(m => !m.static);
    if (!models.length) throw new Error('上游未返回可用模型（账号可能失效）');
    return {
      models: models.map(m => ({ upstream: m.upstream, publicName: m.upstream.toLowerCase(), free: !!m.free, online: true })),
      replace: true,
      source: 'get_detail_param',
    };
  },

  async checkAccount(account) {
    const c = account.credentials;
    await ensureToken(account);
    const r = await httpJson(`${hosts(account).ug}/trae/api/v2/ug/checkin_credits/status`, {
      method: 'POST', headers: ideHeaders(account, { Accept: 'application/json' }), body: {}, timeoutMs: 15000,
    });
    if (r.status === 401 || r.status === 403) return { ok: false, status: 'invalid', message: `auth ${r.status}` };
    if (r.status !== 200) return { ok: false, status: 'cooling', message: `upstream ${r.status}` };
    const d = r.json?.data || r.json || {};
    // identity: user info endpoint (uid/username) — non-fatal if unavailable
    let uid = c.uid || null, uname = null;
    try {
      const u = await httpJson(`${hosts(account).oauth}/cloudide/api/v3/trae/GetUserInfo`, {
        method: 'POST', headers: ideHeaders(account, { Accept: 'application/json', 'X-Cloudide-Token': c.token }), body: {}, timeoutMs: 12000,
      });
      if (u.status === 200 && u.json) {
        const info = u.json.Result || u.json.data || u.json;
        uid = info.UserID != null ? String(info.UserID) : (uid || info.userID || null);
        uname = info.UserName || info.userName || info.NickName || null;
      }
    } catch { /* identity is best-effort */ }
    // JWT claims fallback for username/email
    if (!uname) {
      const { decodeJwtClaims } = require('../utils/jwt');
      const claims = decodeJwtClaims(c.token);
      if (claims) { uname = claims.nickname || uname; }
    }
    return {
      ok: true,
      message: `${d.credits != null ? `剩余积分 ${d.credits}` : '有效'}${uname ? ` · ${uname}` : ''}${uid ? ` (uid ${uid})` : ''}`,
      extra: { credits: d.credits, checkedIn: d.checked_in, uid, username: uname },
    };
  },

  async *chat({ account, upstreamModel, messages, params, signal }) {
    const token = await ensureToken(account);
    // canonical -> trae payload: content as [{type:text}]
    const conv = messages.map(m => {
      let content;
      if (Array.isArray(m.parts)) {
        // canonical parts -> trae [{type:'text'|'image_url',...}]
        content = m.parts.map(p => p.type === 'text'
          ? { type: 'text', text: p.text }
          : { type: 'image_url', image_url: { url: p.url } });
      } else {
        content = [{ type: 'text', text: m.text || '' }];
      }
      const out = { role: m.role, content };
      if (m.tool_calls) {
        // trae expects function_call naming
        out.function_call = m.tool_calls.map(tc => ({ name: tc.function?.name, arguments: tc.function?.arguments }));
      }
      return out;
    });
    const body = {
      messages: conv,
      function: 'solo_work_lite',
      stream: true,
      config_name: upstreamModel,
      model: upstreamModel,
      request_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      max_tokens: params.max_tokens || undefined,
    };
    const resp = await httpRequest(`${hosts(account).chat}/api/agent/v3/llm_utils_chat`, {
      method: 'POST', headers: ideHeaders(account), body, signal,
      timeoutMs: config.requestTimeoutMs,
    });
    if (resp.statusCode >= 400) {
      const text = await resp.body.text().catch(() => '');
      throw Object.assign(new Error(`trae chat ${resp.statusCode}: ${text.slice(0, 300)}`), { status: resp.statusCode });
    }
    // upstream SSE: event lines (metadata/timing_cost/output/token_usage/done/error) each
    // followed by a data line; output payload = {response, reasoning_content, tool_calls, phase}
    let inputTokens = 0, outputTokens = 0;
    let pendingEvent = '';
    for await (const { event, data } of sseParse(resp.body)) {
      if (event) { pendingEvent = event; continue; }
      if (data === '[DONE]') break;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      const type = pendingEvent || ev.type || '';
      pendingEvent = '';
      if (type === 'error') {
        throw Object.assign(new Error(`trae error: ${JSON.stringify(ev).slice(0, 200)}`), { status: 502 });
      }
      if (type === 'token_usage' || ev.prompt_tokens != null) {
        inputTokens = ev.prompt_tokens || inputTokens;
        outputTokens = ev.completion_tokens || outputTokens;
        continue;
      }
      if (type === 'output') {
        if (ev.response != null) yield JSON.stringify({ choices: [{ delta: { content: ev.response } }] });
        if (ev.reasoning_content) yield JSON.stringify({ choices: [{ delta: { reasoning_content: ev.reasoning_content } }] });
        if (ev.tool_calls) yield JSON.stringify({ choices: [{ delta: { tool_calls: ev.tool_calls } }] });
      }
      if (type === 'plan_item' && ev.reasoning_content) {
        yield JSON.stringify({ choices: [{ delta: { reasoning_content: ev.reasoning_content } }] });
      }
      if (type === 'done' || type === 'responsedone' || type === 'streamdone') {
        yield JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } });
        break;
      }
    }
    yield JSON.stringify({ usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } });
  },

  // scan local IDE storage for existing logins (sync, idempotent — safe from panel button)
  discoverLocal() {
    const os = require('os');
    const paths = [
      path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Trae CN', 'User', 'globalStorage', 'storage.json'),
      path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'TRAE SOLO CN', 'User', 'globalStorage', 'storage.json'),
      path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Trae', 'User', 'globalStorage', 'storage.json'),
      path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'TRAE SOLO', 'User', 'globalStorage', 'storage.json'),
      path.join(os.homedir(), 'Library', 'Application Support', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
      path.join(os.homedir(), 'Library', 'Application Support', 'Trae', 'User', 'globalStorage', 'storage.json'),
    ];
    const found = [];
    for (const p of paths) {
      try {
        if (!require('fs').existsSync(p)) continue;
        const storage = JSON.parse(require('fs').readFileSync(p, 'utf8'));
        // edition label from the path segment above "User", e.g. "Trae CN" / "TRAE SOLO CN"
        const edition = p.split(/[\\/]/).slice(-4)[0] || 'Trae';
        const region = /CN/i.test(edition) ? 'cn' : 'intl';
        for (const [k, v] of Object.entries(storage)) {
          if (!k.includes('iCubeAuthInfo')) continue;          let auth = null;
          if (typeof v === 'string' && v.startsWith('{')) {
            try { auth = JSON.parse(v); } catch { auth = null; }
          } else if (typeof v === 'string' && v.length > 40) {
            try { auth = decryptStorageValue(v); } catch (e) {
              // not decryptable (usertag etc.) — only report for the main cloudide key
              if (k === 'iCubeAuthInfo://icube.cloudide') found.push({ label: `${edition}（解密失败：${e.message}）`, suggestName: null, credentials: null });
              continue;
            }
          } else if (typeof v === 'object' && v) {
            auth = v;
          }
          if (!auth) continue;
          const token = auth.accessToken || auth.token || auth.Token;
          if (!token) {
            if (k === 'iCubeAuthInfo://icube.cloudide') found.push({ label: `${edition}（解密成功但无 token）`, suggestName: null, credentials: null });
            continue;
          }
          found.push({
            label: edition + (auth.userId ? ` (uid ${auth.userId})` : ''),
            suggestName: 'trae-' + edition.toLowerCase().replace(/[^a-z0-9]+/g, '-') + (found.filter(f => f.credentials).length + 1),
            credentials: {
              token,
              refreshToken: auth.refreshToken || null,
              uid: auth.userId || auth.userID || auth.uid || null,
              expiresAt: auth.expiredAt || auth.TokenExpireAt || null,
              region,
            },
          });
        }
      } catch { /* unreadable storage */ }
    }
    return found;
  },

  async importLocal(opts = {}) {
    const found = this.discoverLocal();
    const { importFound } = require('../core/localcred');
    if (opts.import) return { found, ...importFound('trae', found, opts.names || []) };
    return { found };
  },
};
