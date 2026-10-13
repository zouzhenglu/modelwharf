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

  async listModels(account) {
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
      return out.length ? out : this._staticModels;
    } catch (e) {
      logger.warn(`workbuddy listModels failed: ${e.message}`);
      return this._staticModels;
    }
  },
  _staticModels: ['glm-5.3', 'glm-5.2', 'kimi-k3', 'kimi-k2.7', 'minimax-m3', 'deepseek-v4-pro', 'deepseek-v4-flash', 'hy3', 'hy4-preview', 'auto']
    .map(m => ({ upstream: m, free: m.startsWith('hy3'), static: true })),

  async checkAccount(account) {
    await ensureToken(account);
    // credits via CN portal
    if (account.credentials.region !== 'intl') {
      const r = await httpJson(`${CN_PORTAL}/billing/meter/get-user-resource`, {
        method: 'POST', headers: headers(account, { Accept: 'application/json', Origin: CN_PORTAL, Referer: CN_PORTAL + '/' }), body: {}, timeoutMs: 15000,
      });
      if (r.status === 200) {
        const d = r.json?.data || {};
        return { ok: true, message: d.credit != null ? `积分 ${d.credit}/${d.limitNum ?? '?'}` : '有效', extra: { credits: d.credit, quota: d.limitNum } };
      }
      if (r.status === 401 || r.status === 403) return { ok: false, status: 'invalid', message: `auth ${r.status}` };
    }
    return { ok: true, message: 'token 已刷新可用' };
  },

  async *chat({ account, upstreamModel, messages, tools, params, signal, onUsage }) {
    const token = await ensureToken(account);
    const convId = crypto.randomUUID();
    const body = {
      model: upstreamModel,
      messages: messages.map(m => ({ role: m.role === 'tool' ? 'tool' : m.role, content: m.text ?? '' })),
      stream: true,
      stream_options: { include_usage: true },
      ...(params.max_tokens ? { max_tokens: params.max_tokens } : {}),
      ...(params.temperature != null ? { temperature: params.temperature } : {}),
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
  discoverLocal() {
    const fs = require('fs'), os = require('os'), path = require('path');
    const dirs = [
      path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      path.join(os.homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      path.join(os.homedir(), '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ];
    const found = [];
    const seenFp = new Set();
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
          // dedupe identical tokens across history files
          const fp = token.slice(-32);
          if (seenFp.has(fp)) continue;
          seenFp.add(fp);
          found.push({
            label: (f === 'workbuddy-desktop.info' ? 'workbuddy-desktop (当前)' : f.replace(/workbuddy-desktop\.|\.info/g, '').slice(0, 16)) + (uid ? ` (${uid.slice(0, 8)})` : ''),
            suggestName: 'wb-' + (found.filter(x => x.credentials).length + 1),
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

  async importLocal(opts = {}) {
    const found = this.discoverLocal();
    const { importFound } = require('../core/localcred');
    if (opts.import) return { found, ...importFound('workbuddy', found, opts.names || []) };
    return { found };
  },
};
