'use strict';
/**
 * MCP (Model Context Protocol) gateway:
 *  - Registers MCP servers (stdio or http) in the admin panel
 *  - Exposes their tools/resources/prompts to LLM clients via its own MCP endpoint:
 *      1) aggregated via this gateway's own MCP endpoint (clients connect to /mcp)
 *      2) tools injected into chat requests when client sends tools (admin toggle per server)
 *  Implementation: JSON-RPC 2.0 over HTTP (streamable, SSE responses not needed for basic calls).
 *  stdio servers are spawned once and kept alive; lazily restarted if dead.
 *  Auth: same as the AI gateways — Bearer/x-api-key checked against apikeys; open only when no keys exist.
 */
const express = require('express');
const { spawn } = require('child_process');
const { db } = require('../store');
const logger = require('../logger');

const router = express.Router();
const procs = new Map(); // serverId -> {proc, pending:Map(id->resolve), nextId, buffer}

// ---------- auth (与 /v1 网关同语义：未配置任何 key 时开放，配置后必须带 key) ----------
function auth(req, res, next) {
  const cfgKeys = (require('../config')).apiKeys;
  const header = req.headers['authorization'] || '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] || req.query.key || '');
  let row = key ? db.prepare('SELECT * FROM apikeys WHERE key=?').get(key) : null;
  if (!row && cfgKeys.includes(key)) row = { id: null, key, name: 'env-key', enabled: 1, allowed_models: '*' };
  if (!row && !key && cfgKeys.length === 0 && db.prepare('SELECT COUNT(*) c FROM apikeys').get().c === 0) {
    return next(); // open gateway mode
  }
  if (!row || !row.enabled) return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'invalid api key' } });
  next();
}
router.use(auth);

function listServers() {
  return db.prepare('SELECT * FROM mcp_servers').all().map(s => ({
    ...s, args: JSON.parse(s.args || '[]'), env: JSON.parse(s.env || '{}'), headers: JSON.parse(s.headers || '{}'),
  }));
}

function getServer(id) {
  const s = db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(id);
  return s ? { ...s, args: JSON.parse(s.args || '[]'), env: JSON.parse(s.env || '{}'), headers: JSON.parse(s.headers || '{}') } : null;
}

// ---- stdio transport ----
function ensureProc(server) {
  if (procs.has(server.id)) {
    const p = procs.get(server.id);
    if (p.proc && !p.proc.killed) return p;
  }
  const proc = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { proc, pending: new Map(), nextId: 1, buffer: '', lines: [] };
  proc.stdout.on('data', (d) => {
    state.buffer += d.toString();
    let idx;
    while ((idx = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, idx).trim();
      state.buffer = state.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && state.pending.has(msg.id)) {
          const { resolve } = state.pending.get(msg.id);
          state.pending.delete(msg.id);
          resolve(msg);
        } else {
          state.lines.push(msg);
        }
      } catch { /* non-JSON line */ }
    }
  });
  proc.stderr.on('data', (d) => logger.debug(`mcp[${server.id}] stderr: ${d.toString().trim()}`));
  proc.on('exit', (code) => { logger.warn(`mcp[${server.id}] exited code=${code}`); procs.delete(server.id); });
  procs.set(server.id, state);
  return state;
}

function rpcCall(server, method, params) {
  if (server.transport === 'stdio') {
    const state = ensureProc(server);
    const id = state.nextId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { state.pending.delete(id); reject(new Error(`mcp ${server.id} timeout on ${method}`)); }, 30000);
      state.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
      state.proc.stdin.write(msg);
    });
  }
  // http transport
  const { request } = require('undici');
  return (async () => {
    const resp = await request(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...server.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params || {} }),
      timeout: 30000,
    });
    const text = await resp.body.text();
    // streamable http may answer SSE; extract data lines
    if ((resp.headers['content-type'] || '').includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        if (line.startsWith('data:')) {
          try { return JSON.parse(line.slice(5).trim()); } catch {}
        }
      }
    }
    try { return JSON.parse(text); } catch { throw new Error(`mcp http ${server.id} bad response: ${text.slice(0, 200)}`); }
  })();
}

async function initialize(server) {
  await rpcCall(server, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'modelwharf', version: '0.1.0' } });
  if (server.transport === 'stdio') rpcCall(server, 'notifications/initialized', {}).catch(() => {});
}

async function listTools(server) {
  const filter = (server.tool_filter || '*').split(',').map(s => s.trim()).filter(Boolean);
  const resp = await rpcCall(server, 'tools/list', {});
  let tools = resp?.result?.tools || [];
  if (filter[0] !== '*') tools = tools.filter(t => filter.includes(t.name));
  return tools;
}

// ---------- resources / prompts aggregation ----------
// 资源 URI 用 mcpres://<serverId>/<encodeURIComponent(uri)> 前缀聚合，
// 保证跨服务不冲突且 resources/read 能确定性还原到原服务。
function prefixUri(serverId, uri) { return `mcpres://${encodeURIComponent(serverId)}/${encodeURIComponent(uri)}`; }
function parsePrefixedUri(uri) {
  const m = /^mcpres:\/\/([^/]+)\/(.+)$/.exec(String(uri || ''));
  if (!m) return null;
  try { return { serverId: decodeURIComponent(m[1]), uri: decodeURIComponent(m[2]) }; } catch { return null; }
}

async function listResources(server) {
  const resources = [];
  const templates = [];
  try {
    const resp = await rpcCall(server, 'resources/list', {});
    for (const r of resp?.result?.resources || []) resources.push({ ...r, uri: prefixUri(server.id, r.uri) });
  } catch (e) {
    if (!/timeout/.test(e.message)) throw e; // 完全不支持 resources 的服务跳过
  }
  try {
    const resp = await rpcCall(server, 'resources/templates/list', {});
    for (const t of resp?.result?.resourceTemplates || []) templates.push({ ...t, uriTemplate: prefixUri(server.id, t.uriTemplate) });
  } catch { /* 无模板也正常 */ }
  return { resources, templates };
}

async function listPrompts(server) {
  const resp = await rpcCall(server, 'prompts/list', {});
  return (resp?.result?.prompts || []).map(p => ({ ...p, name: `${server.id}__${p.name}` }));
}

// kill procs on shutdown
process.on('exit', () => { for (const [, s] of procs) { try { s.proc.kill(); } catch {} } });

// ---------- gateway MCP endpoint (clients connect here) ----------
// Streamable-HTTP-style: POST /mcp with JSON-RPC; GET returns info page (browsers) or SSE stream
router.get('/', (req, res) => {
  // Streamable HTTP clients may send GET with SSE Accept for server->client stream; we have no
  // server-initiated messages, so acknowledge per spec. Browsers get a human-readable page.
  if ((req.headers['accept'] || '').includes('text/event-stream')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': mcp gateway ready\n\n');
    return;
  }
  const servers = listServers().filter(s => s.enabled);
  res.type('html').send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>MCP Gateway</title>
<style>body{background:#0f1115;color:#e6e9ef;font:14px/1.7 -apple-system,"Segoe UI",sans-serif;max-width:720px;margin:48px auto;padding:0 20px}
code{background:#1e222b;border:1px solid #2a2f3a;border-radius:6px;padding:2px 8px;font-family:ui-monospace,Consolas,monospace;font-size:13px}
.card{background:#171a21;border:1px solid #2a2f3a;border-radius:12px;padding:20px 24px;margin:16px 0}</style></head><body>
<h1>🛰 MCP Gateway</h1>
<div class="card"><p>这是 modelwharf 的 MCP 网关端点，使用 <b>JSON-RPC over HTTP</b>（Streamable HTTP 传输）。</p>
<p>客户端配置（如 Claude Desktop / Cursor 的 mcp 配置）：</p>
<pre style="background:#1e222b;border:1px solid #2a2f3a;border-radius:8px;padding:12px;overflow:auto">{
  "mcpServers": {
    "modelwharf": {
      "type": "http",
      "url": "http://localhost:8317/mcp"
    }
  }
}</pre>
<p class="muted" style="color:#8b93a5">网关配置了 API Key 时需带 <code>Authorization: Bearer &lt;key&gt;</code>（未配置任何 key 时开放）。</p></div>
<div class="card"><p>已注册的 MCP 服务（${servers.length} 个）：${servers.length ? servers.map(s => `<code>${String(s.id).replace(/[<>&]/g, '')}</code>`).join('、') : '（无，去管理面板 → MCP 服务 添加）'}</p>
<p class="muted" style="color:#8b93a5">工具/提示词以 <code>服务id__名称</code> 聚合暴露；资源 URI 带 <code>mcpres://</code> 前缀。支持方法：<code>tools/list</code> / <code>tools/call</code> / <code>resources/list</code> / <code>resources/read</code> / <code>prompts/list</code> / <code>prompts/get</code>。</p></div>
</body></html>`);
});

router.post('/', async (req, res) => {
  const { method, params, id } = req.body || {};
  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, resources: { subscribe: false, listChanged: false }, prompts: {} },
          serverInfo: { name: 'modelwharf-mcp', version: '0.1.0' },
        },
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return res.status(202).end();
    if (method === 'tools/list') {
      const servers = listServers().filter(s => s.enabled);
      const tools = [];
      for (const s of servers) {
        try { for (const t of await listTools(s)) tools.push({ name: `${s.id}__${t.name}`, description: `[${s.id}] ${t.description || ''}`, inputSchema: t.inputSchema }); }
        catch (e) { logger.warn(`mcp tools/list failed for ${s.id}: ${e.message}`); }
      }
      return res.json({ jsonrpc: '2.0', id, result: { tools } });
    }
    if (method === 'tools/call') {
      const name = params?.name || '';
      const sep = name.indexOf('__');
      const serverId = name.slice(0, sep); const toolName = name.slice(sep + 2);
      const server = getServer(serverId);
      if (!server || !server.enabled) return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: `mcp server '${serverId}' not found or disabled` } });
      const resp = await rpcCall(server, 'tools/call', { name: toolName, arguments: params?.arguments || {} });
      if (resp.error) return res.json({ jsonrpc: '2.0', id, error: resp.error });
      return res.json({ jsonrpc: '2.0', id, result: resp.result });
    }
    // ---- resources: 聚合各上游服务，URI 加 mcpres:// 前缀 ----
    if (method === 'resources/list' || method === 'resources/templates/list') {
      const servers = listServers().filter(s => s.enabled);
      const resources = []; const templates = [];
      for (const s of servers) {
        try {
          const r = await listResources(s);
          resources.push(...r.resources);
          templates.push(...r.templates);
        } catch (e) { logger.warn(`mcp ${method} failed for ${s.id}: ${e.message}`); }
      }
      return res.json({
        jsonrpc: '2.0', id,
        result: method === 'resources/list' ? { resources, resourceTemplates: templates } : { resourceTemplates: templates },
      });
    }
    if (method === 'resources/read') {
      const target = parsePrefixedUri(params?.uri);
      if (!target) return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown resource uri '${params?.uri}' (expected mcpres://<server>/<uri> from resources/list)` } });
      const server = getServer(target.serverId);
      if (!server || !server.enabled) return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: `mcp server '${target.serverId}' not found or disabled` } });
      const resp = await rpcCall(server, 'resources/read', { uri: target.uri });
      if (resp.error) return res.json({ jsonrpc: '2.0', id, error: resp.error });
      // contents 内的 uri 同步改写为聚合 URI，客户端二次读取仍可路由
      const contents = (resp.result?.contents || []).map(c => ({ ...c, uri: prefixUri(target.serverId, c.uri || target.uri) }));
      return res.json({ jsonrpc: '2.0', id, result: { ...resp.result, contents } });
    }
    if (method === 'resources/subscribe' || method === 'resources/unsubscribe') {
      return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `${method} not supported by gateway (no resource change notifications)` } });
    }
    // ---- prompts: 聚合，名称用 服务id__提示词名（与 tools 同约定） ----
    if (method === 'prompts/list') {
      const servers = listServers().filter(s => s.enabled);
      const prompts = [];
      for (const s of servers) {
        try { prompts.push(...await listPrompts(s)); }
        catch (e) { logger.warn(`mcp prompts/list failed for ${s.id}: ${e.message}`); }
      }
      return res.json({ jsonrpc: '2.0', id, result: { prompts } });
    }
    if (method === 'prompts/get') {
      const name = params?.name || '';
      const sep = name.indexOf('__');
      const serverId = name.slice(0, sep); const promptName = name.slice(sep + 2);
      const server = getServer(serverId);
      if (!server || !server.enabled) return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: `mcp server '${serverId}' not found or disabled` } });
      const resp = await rpcCall(server, 'prompts/get', { name: promptName, arguments: params?.arguments || {} });
      if (resp.error) return res.json({ jsonrpc: '2.0', id, error: resp.error });
      return res.json({ jsonrpc: '2.0', id, result: resp.result });
    }
    if (method === 'ping') return res.json({ jsonrpc: '2.0', id, result: {} });
    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `method ${method} not supported` } });
  } catch (e) {
    res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
  }
});

module.exports = { router, listServers, getServer, listTools, listResources, listPrompts, rpcCall, initialize };
