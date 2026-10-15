'use strict';
/**
 * workbuddy provider (Tencent CodeBuddy / workbuddy.cn · workbuddy.ai).
 * Reference: linguo2625469/workbuddy2api-panel (Go), xiaofan6ya/workbuddy2api.
 *
 * Facts:
 *  - Chat: POST https://copilot.tencent.com/v2/chat/completions (CN) — plain OpenAI protocol, SSE, stream:true forced.
 *    Global realm base: https://www.workbuddy.ai same path.
 *  - Auth: Authorization: Bearer <accessToken> + X-User-Id; CN adds X-Enterprise-Id/X-Tenant-Id/X-Domain or X-No-Enterprise-Id: 1
 *  - Models: GET /console/enterprises/personal/models (dynamic)
 *  - Refresh: POST /v2/plugin/auth/token/refresh (X-Refresh-Token header)
 *  - Credits: POST https://www.codebuddy.cn/billing/meter/get-user-resource
 *  - Errors: 402/14001/14012-14018 credits exhausted; 429/6004/6008 model daily limit; 14003 busy; 12153 dead session
 */
const { httpJson, httpRequest, config, logger } = require('../utils/http');
const { sseParse } = require('../utils/sse');
const crypto = require('crypto');

const CN_BASE = 'https://copilot.tencent.com';
const INTL_BASE = 'https://www.workbuddy.ai';
const CN_PORTAL = 'https://www.codebuddy.cn';

function base(account) { return account.credentials.region === 'intl' ? INTL_BASE : CN_BASE; }

function headers(account, extra = {}) {
  const c = account.credentials;
  const uid = c.userId || '';
  const h = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': c.userAgent || 'WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1',
    Authorization: `Bearer ${c.token}`,
    'X-CodeBuddy-Request': '1',
    'X-Product': c.product || 'SaaS',
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': 'WorkBuddy', 'X-IDE-Type': 'desktop', 'X-IDE-Version': c.ideVersion || '5.5.4',
    ...(uid ? { 'X-User-Id': String(uid) } : {}),
    ...extra,
  };
  if (c.region === 'intl') {
    h['X-Domain'] = 'www.workbuddy.ai';
  } else if (c.enterpriseId) {
    h['X-Enterprise-Id'] = c.enterpriseId; h['X-Tenant-Id'] = c.tenantId || c.enterpriseId; h['X-Domain'] = c.domain || 'www.codebuddy.cn';
  } else {
    h['X-No-Enterprise-Id'] = '1';
  }
  // Turing shield token if provided (else upstream may reject on some IPs)
  if (c.deviceToken) h['X-Device-Token'] = c.deviceToken;
  return h;
}

async function ensureToken(account) {
  const c = account.credentials;
  const exp = c.expiresAt || 0;
  if (c.refreshToken && exp && Date.now() > exp - 10 * 60 * 1000) {
    logger.info(`workbuddy[${account.name}] refreshing token`);
    const r = await httpJson(`${base(account)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Refresh-Token': c.refreshToken, 'X-Auth-Refresh-Source': 'plugin', 'User-Agent': 'WorkBuddy/5.5.4' },
      body: {},
    });
    if (r.status === 200 && r.json?.accessToken) {
      c.token = r.json.accessToken;
      c.refreshToken = r.json.refreshToken || c.refreshToken;
      c.expiresAt = Date.now() + (r.json.expiresIn || 3600) * 1000;
      const { db } = require('../store');
      db.prepare('UPDATE accounts SET credentials=? WHERE id=?').run(JSON.stringify(c), account.id);
    } else {
      throw Object.assign(new Error(`workbuddy refresh failed: ${r.status}`), { status: 401 });
    }
  }
  return c.token;
}

function classifyError(status, message) {
  if (status === 401 || status === 403) return 'invalid';
  if (status === 402 || /14001|1401[2-8]/.test(message)) return 'banned'; // credits exhausted -> hard cooldown
  return 'cooling';
}

/** 签到后回查积分余额（get-user-resource 汇总未过期的 capacity 包），失败抛错由调用方兜住 */
async function refreshCredits(account) {
  const r = await httpJson(`${CN_PORTAL}/billing/meter/get-user-resource`, {
    method: 'POST', headers: headers(account, { Accept: 'application/json', Origin: CN_PORTAL, Referer: CN_PORTAL + '/' }), body: {}, timeoutMs: 15000,
  });
  if (r.status !== 200) throw new Error(`get-user-resource ${r.status}`);
  const items = r.json?.data?.Response?.Data?.Accounts || [];
  let remain = 0, size = 0;
  const now = Date.now();
  for (const it of items) {
    if (it.CapacityUnit !== 'credits') continue;
    if (it.DeductionEndTime && Number(it.DeductionEndTime) < now) continue;
    remain += Number(it.CapacityRemain || 0);
    size += Number(it.CapacitySize || 0);
  }
  return { credits: remain, quota: size };
}

module.exports = {
  id: 'workbuddy',
  label: 'WorkBuddy / CodeBuddy (腾讯)',
  homepage: 'https://www.workbuddy.cn',
  importLocal: true,
  credFields: [
    { name: 'token', label: 'Access Token', required: true, secret: true },
    { name: 'refreshToken', label: 'Refresh Token（可选，自动续期）', secret: true },
    { name: 'userId', label: 'User ID（可选）' },
    { name: 'region', label: '区域', placeholder: 'cn（默认）或 intl' },
    { name: 'deviceToken', label: 'X-Device-Token（可选，风控需要时填）', secret: true },
  ],
  docs: '从本机 %LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth\\*.info 读取（新版本若为 $wbEncrypted 加密信封则需手动抓包取 token）；或登录网页版后从请求头复制 Authorization。',

  /** parse /v3/config into the true online catalog: rates, tags, ctx, vision */
  async fetchConfigCatalog(account) {
    await ensureToken(account);
    const r = await httpJson(`${base(account)}/v3/config`, {
      headers: headers(account, {
        Accept: 'application/json',
        'User-Agent': 'CLI/unknown CodeBuddy/2.137.1',
        'x-product': 'SaaS',
      }),
      timeoutMs: 15000,
    });
    if (r.status !== 200) throw new Error(`workbuddy config ${r.status}`);
    const data = r.json?.data;
    const agents = Array.isArray(data?.agents) ? data.agents : data?.agent?.agents;
    const cli = Array.isArray(agents) ? agents.find(x => x?.name === 'cli') : undefined;
    const allowed = Array.isArray(cli?.models) ? cli.models : [];
    const source = Array.isArray(data?.models) ? data.models : [];
    const byId = new Map(source.map(m => [m?.id, m]));
    const models = [];
    for (const id of allowed) {
      const raw = byId.get(id);
      if (!id) continue;
      const rate = raw ? (parseFloat(String(raw.credits || '').replace(/[^0-9.]/g, '')) || null) : null;
      const tags = [];
      if (raw?.supportsImages) tags.push('vision');
      if (raw?.supportsReasoning || raw?.onlyReasoning) tags.push('thinking');
      if (raw?.supportsToolCall) tags.push('tools');
      if (raw?.onlyReasoning) tags.push('reasoning-only');
      const free = rate == null || rate === 0; // hy3 / image models have no rate = free
      if (free) tags.push('free');
      if (raw?.reasoning?.effort) tags.push(`effort:${raw.reasoning.effort}`);
      if (raw?.vendor) tags.push('vendor:' + raw.vendor);
      models.push({
        upstream: id,
        publicName: id.toLowerCase(),
        free,
        multiplier: free ? 0 : rate,
        ctx: raw ? (raw.maxInputTokens || raw.maxAllowedSize || null) : null,
        maxOutput: raw?.maxOutputTokens || null,
        images: raw?.supportsImages === true,
        reasoning: !!(raw?.supportsReasoning || raw?.onlyReasoning),
        tags,
        note: raw?.descriptionZh || raw?.descriptionEn || null,
        online: true,
      });
    }
    return { models, replace: true, source: '/v3/config agents[cli]' };
  },

  /**
   * 恢复在线目录：只取 CLI 账号实际可用的模型（/v3/config → agents[cli].models，
   * 与 WorkBuddy 客户端里看到的一致，含倍率/标签）。返回 replace: true 表示
   * 调用方应删除该平台现有模型行后全量重建。
   */
  async listOnlineModels(account) {
    return this.fetchConfigCatalog(account);
  },

  async listModels(account) {
    // normal sync uses the same true catalog (with rates/tags) when reachable;
    // falls back to the plain id list (static-flagged) otherwise
    try {
      const cat = await this.fetchConfigCatalog(account);
      return cat.models;
    } catch (e) {
      logger.warn(`workbuddy config catalog failed: ${e.message}`);
    }
    try {
      await ensureToken(account);
      const r = await httpJson(`${base(account)}/console/enterprises/personal/models`, {
        headers: headers(account, { Accept: 'application/json' }), timeoutMs: 15000,
      });
      if (r.status !== 200) throw new Error(`models ${r.status}`);
      const arr = r.json?.data?.models || r.json?.data || r.json?.models || [];
      const out = [];
      const seen = new Set();
      const walk = (list) => {
        for (const m of list || []) {
          const name = m.model || m.model_name || m.name || m.key;
          if (!name || seen.has(name)) continue;
          seen.add(name);
          out.push({ upstream: name, free: m.is_free || m.free || m.rate === 0 });
        }
      };
      walk(arr);
      if (!out.length) {
        // fallback /v3/config agents[cli].models
        const r2 = await httpJson(`${base(account)}/v3/config`, { headers: headers(account, { Accept: 'application/json' }) });
        const cliModels = r2.json?.data?.agents?.cli?.models || [];
        for (const m of cliModels) { const n = m.model || m.name || m; if (n && !seen.has(n)) { seen.add(n); out.push({ upstream: n }); } }
      }
      return out.length ? out.map(m => ({ ...m, static: true })) : this._staticModels;
    } catch (e) {
      logger.warn(`workbuddy listModels failed: ${e.message}`);
      return this._staticModels;
    }
  },
  _staticModels: ['glm-5.3', 'glm-5.2', 'kimi-k3', 'kimi-k2.7', 'minimax-m3', 'deepseek-v4-pro', 'deepseek-v4-flash', 'hy3', 'hy4-preview', 'auto']
    .map(m => ({ upstream: m, free: m.startsWith('hy3'), static: true })),

  async checkAccount(account) {
    await ensureToken(account);
    // identity + credits via CN portal (billing/meter/get-user-resource returns capacity packages)
    if (account.credentials.region !== 'intl') {
      const r = await httpJson(`${CN_PORTAL}/billing/meter/get-user-resource`, {
        method: 'POST', headers: headers(account, { Accept: 'application/json', Origin: CN_PORTAL, Referer: CN_PORTAL + '/' }), body: {}, timeoutMs: 15000,
      });
      if (r.status === 200) {
        const items = r.json?.data?.Response?.Data?.Accounts || [];
        // sum active capacity packages (CapacityRemain/CapacitySize are per-package credits)
        let remain = 0, size = 0;
        const now = Date.now();
        for (const it of items) {
          if (it.CapacityUnit !== 'credits') continue;
          if (it.DeductionEndTime && Number(it.DeductionEndTime) < now) continue; // expired package
          remain += Number(it.CapacityRemain || 0);
          size += Number(it.CapacitySize || 0);
        }
        // identity: nickname/email/phone from JWT claims + uid/uin
        const { decodeJwtClaims } = require('../utils/jwt');
        const claims = decodeJwtClaims(account.credentials.token) || {};
        const uid = account.credentials.userId || claims.sub || null;
        return {
          ok: true,
          message: `${claims.nickname || claims.phone || uid?.slice(0, 8) || '有效'} · 积分 ${remain} / ${size}`,
          extra: {
            credits: remain, quota: size, packages: items.length,
            uid, uin: items[0]?.Uin || claims.phone || null,
            username: claims.nickname || null, email: claims.email || null, phone: claims.phone || null,
          },
        };
      }
      if (r.status === 401 || r.status === 403) return { ok: false, status: 'invalid', message: `auth ${r.status}` };
    }
    return { ok: true, message: 'token 已刷新可用' };
  },

  /**
   * 每日签到：POST /v2/billing/meter/daily-checkin（intl 域为 workbuddy.ai 同路径，
   * 上游新旧路径分叉：intl 先试无 /v2 前缀的旧路径再试 /v2；CN 单路径 /v2）。
   * 已签到是 HTTP 400 + 业务体 {"code":10001,"msg":"今天已签到，请明天再来"}（2026-10-15
   * 实测）——非 200 响应也检查业务体，命中"已签到"文案按幂等成功返回；core 的
   * alreadyCheckinSignal() 还会拿 raw 兜底复查。成功后回查积分余额更新档案。
   */
  async checkin(account) {
    await ensureToken(account);
    const realm = account.credentials.region === 'intl' ? INTL_BASE : CN_PORTAL;
    // intl: global 老客户端走无前缀路径；CN 实测只有 /v2 前缀
    const paths = account.credentials.region === 'intl'
      ? ['/billing/meter/daily-checkin', '/v2/billing/meter/daily-checkin']
      : ['/v2/billing/meter/daily-checkin'];
    let lastStatus = 0, lastRaw = null;
    for (const p of paths) {
      const r = await httpJson(`${realm}${p}`, {
        method: 'POST',
        headers: headers(account, { Accept: 'application/json', Origin: realm, Referer: realm + '/' }),
        body: {}, timeoutMs: 20000,
      });
      const j = r.json && typeof r.json === 'object' ? r.json : {};
      const msgText = String(j.message || j.msg || r.text || '');
      // "已签到"幂等：业务码/文案识别不挑 HTTP 状态码（实测 400 + code 10001）
      if (/已签到|已经签到|already/i.test(msgText) || Number(j.code) === 10001) {
        const credits = await refreshCredits(account).catch(() => null);
        return { ok: true, already: true, message: '今日已签到', gained: 0, extra: credits ? { credits } : undefined };
      }
      if (r.status === 200) {
        if (j.code != null && j.code !== 0) return { ok: false, message: msgText || `code ${j.code}` };
        const gained = Number(j?.data?.credits ?? j?.data?.Credits ?? 0) || null;
        const credits = await refreshCredits(account).catch(() => null);
        return { ok: true, gained, message: `签到成功${gained ? ` +${gained}` : ''}`, extra: credits ? { credits } : undefined };
      }
      lastStatus = r.status; lastRaw = { status: r.status, json: r.json, text: String(r.text || '').slice(0, 300) };
      if (r.status !== 404 && r.status !== 405 && r.status !== 410) break; // 路径不存在才 fallback
    }
    if (lastStatus === 401 || lastStatus === 403) return { ok: false, message: `auth ${lastStatus}` };
    return { ok: false, message: `签到请求失败 HTTP ${lastStatus}`, raw: lastRaw };
  },

  async *chat({ account, upstreamModel, messages, tools, params, signal, onUsage }) {
    const token = await ensureToken(account);
    const convId = crypto.randomUUID();
    const body = {
      model: upstreamModel,
      messages: messages.map(m => {
        const out = { role: m.role === 'tool' ? 'tool' : m.role };
        // vision: OpenAI-style image_url parts pass through directly (upstream is OpenAI-shaped)
        if (m.parts?.some(p => p.type === 'image_url')) {
          out.content = m.parts.map(p => p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image_url', image_url: { url: p.url } });
        } else {
          out.content = m.text ?? '';
        }
        if (m.tool_calls) out.tool_calls = m.tool_calls;
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        return out;
      }),
      stream: true,
      stream_options: { include_usage: true },
      ...(params.max_tokens ? { max_tokens: params.max_tokens } : {}),
      ...(params.temperature != null ? { temperature: params.temperature } : {}),
      ...(params.reasoning_effort ? { reasoning_effort: params.reasoning_effort } : {}),
      ...(tools?.length ? { tools, tool_choice: params.tool_choice || 'auto' } : {}),
      metadata: { conversation_id: convId },
    };
    const rid = crypto.randomUUID();
    const resp = await httpRequest(`${base(account)}/v2/chat/completions`, {
      method: 'POST', headers: headers(account, {
        'X-Conversation-ID': convId, 'X-Conversation-Request-ID': rid, 'X-Root-Request-ID': rid,
        'X-Conversation-Message-ID': crypto.randomUUID(), 'X-Request-ID': rid,
      }), body, signal, timeoutMs: config.requestTimeoutMs,
    });
    if (resp.statusCode >= 400) {
      const text = await resp.body.text().catch(() => '');
      const err = new Error(`workbuddy ${resp.statusCode}: ${text.slice(0, 300)}`);
      err.status = resp.statusCode;
      if (resp.statusCode >= 400) err.accountStatus = classifyError(resp.statusCode, text);
      throw err;
    }
    for await (const { data } of sseParse(resp.body)) {
      if (data === '[DONE]') break;
      // upstream is already OpenAI-shaped; pass through (engine normalizes)
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.code && j.code !== 0) {
        // error envelope
        const msg = j.message || JSON.stringify(j);
        throw Object.assign(new Error(`workbuddy code ${j.code}: ${msg.slice(0, 200)}`), { status: j.code === 14003 ? 429 : 502 });
      }
      if (j.usage) onUsage?.({ input_tokens: j.usage.prompt_tokens, output_tokens: j.usage.completion_tokens });
      yield data;
    }
  },

  // scan local CodeBuddy/WorkBuddy desktop auth files (sync, idempotent)
  // Scans every *.info (including timestamped history files) — newer client versions
  // encrypt tokens as {"$wbEncrypted":1,"envelope":...} which we cannot decrypt; those
  // entries are reported so the user knows to re-login in the desktop app or paste a token.
  // Dedupes by account identity (uid from JWT sub / account.uid), NOT by token:
  // the same account refreshes tokens frequently, so token-fingerprint dedup leaks duplicates.
  discoverLocal() {
    const fs = require('fs'), os = require('os'), path = require('path');
    const { decodeJwtClaims } = require('../utils/jwt');
    const dirs = [
      path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      path.join(os.homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      path.join(os.homedir(), '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ];
    const found = [];
    const seenIdentity = new Set();
    for (const dir of dirs) {
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.info') && !f.endsWith('.observation.json')).sort().reverse(); } catch { continue; }
      let encryptedSeen = false;
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(dir, f), 'utf8');
          let j = null;
          try { j = JSON.parse(raw); } catch { continue; }
          const auth = j.auth || j;
          const token = auth.accessToken;
          const uid = j.account?.uid || auth.uid || j.userId || null;
          if (!token || typeof token !== 'string') continue;
          if (token.startsWith('$wbEncrypted') || auth['$wbEncrypted']) { encryptedSeen = true; continue; }
          // identity = uid or JWT sub; skip files from the same account (fresh token wins: files sorted newest first)
          const claims = decodeJwtClaims(token);
          const identity = String(uid || claims?.sub || '') || null;
          if (identity) {
            if (seenIdentity.has(identity)) continue;
            seenIdentity.add(identity);
          } else {
            const fp = token.slice(-32);
            if (seenIdentity.has(fp)) continue;
            seenIdentity.add(fp);
          }
          found.push({
            label: (f === 'workbuddy-desktop.info' ? 'workbuddy-desktop (当前)' : f.replace(/workbuddy-desktop\.|\.info/g, '').slice(0, 16)) + (claims?.nickname ? ` (${claims.nickname})` : uid ? ` (${String(uid).slice(0, 8)})` : ''),
            suggestName: claims?.nickname ? `wb-${claims.nickname}` : ('wb-' + (found.filter(x => x.credentials).length + 1)),
            credentials: {
              token,
              refreshToken: auth.refreshToken || null,
              userId: uid,
              expiresAt: auth.expiresAt ? Number(auth.expiresAt) : (auth.expiresIn ? Date.now() + Number(auth.expiresIn) * 1000 : null),
              region: (auth.domain || '').includes('workbuddy.ai') ? 'intl' : 'cn',
            },
          });
        } catch { /* skip */ }
      }
      if (encryptedSeen && !found.some(x => x.credentials)) {
        found.push({ label: 'workbuddy-desktop（当前登录的 token 是加密信封 $wbEncrypted，无法直接读取。可在 WorkBuddy 客户端退出重登后立即扫描，或抓包后手动添加）', suggestName: null, credentials: null });
      }
    }
    return found;
  },

  // ---------- OAuth device-flow login (添加账号自动跳授权页) ----------
  // Port of @axiaohungry/dsh-llm-workbuddy loginWorkBuddy():
  //   POST /v2/plugin/auth/state?platform=CLI -> {state, authUrl}
  //   open authUrl in browser -> user logs in
  //   poll GET /v2/plugin/auth/token?state=... until tokens arrive (10min)
  //   poll GET /v2/plugin/login/account?state=... for account info (60s)
  async startOAuth() {
    const { httpJson } = require('../utils/http');
    const BASE = 'https://copilot.tencent.com/v2/plugin';
    const H = { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'CLI/unknown CodeBuddy/2.137.1', 'x-product': 'SaaS', 'X-No-Authorization': 'true', 'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true', 'X-No-Department-Info': 'true' };
    const r = await httpJson(`${BASE}/auth/state?platform=CLI`, { method: 'POST', headers: H, body: {}, timeoutMs: 15000 });
    if (r.status !== 200 || !r.json?.data?.state || !r.json?.data?.authUrl) {
      throw new Error(`创建登录会话失败: ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    }
    return { state: r.json.data.state, authUrl: r.json.data.authUrl };
  },

  /** poll once (called repeatedly by admin UI until tokens arrive or timeout) */
  async pollOAuth(state) {
    const { httpJson } = require('../utils/http');
    const BASE = 'https://copilot.tencent.com/v2/plugin';
    const H = { accept: 'application/json', 'user-agent': 'CLI/unknown CodeBuddy/2.137.1', 'x-product': 'SaaS', 'X-No-Authorization': 'true', 'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true', 'X-No-Department-Info': 'true' };
    const t = await httpJson(`${BASE}/auth/token?state=${encodeURIComponent(state)}`, { headers: H, timeoutMs: 15000 });
    if (!(t.status === 200 && t.json?.code === 0 && t.json?.data?.accessToken)) {
      return { pending: true };
    }
    const auth = t.json.data;
    const authHeaders = { ...H, 'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true', 'X-No-Department-Info': 'true', Authorization: `Bearer ${auth.accessToken}` };
    const acct = await httpJson(`${BASE}/login/account?state=${encodeURIComponent(state)}`, { headers: authHeaders, timeoutMs: 15000 }).catch(() => ({ json: null }));
    const account = acct.json?.data || {};
    const { decodeJwtClaims } = require('../utils/jwt');
    const claims = decodeJwtClaims(auth.accessToken) || {};
    return {
      pending: false,
      credentials: {
        token: auth.accessToken,
        refreshToken: auth.refreshToken || null,
        userId: account.userId || account.uid || claims.sub || null,
        expiresAt: auth.expiresAt ? Number(auth.expiresAt) : (auth.expiresIn ? Date.now() + Number(auth.expiresIn) * 1000 : null),
        region: 'cn',
      },
      identity: { nickname: claims.nickname || account.displayName || null, email: claims.email || null, phone: claims.preferred_username || null },
    };
  },

  async importLocal(opts = {}) {
    const found = this.discoverLocal();
    const { importFound } = require('../core/localcred');
    if (opts.import) return { found, ...importFound('workbuddy', found, opts.names || []) };
    return { found };
  },
};
