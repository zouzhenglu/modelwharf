'use strict';
/**
 * MCP (Model Context Protocol) gateway:
 *  - Registers MCP servers (stdio or http) in the admin panel
 *  - Exposes their tools to LLM clients two ways:
 *      1) tools listed via this gateway's own MCP endpoint (clients connect to /mcp)
 *      2) injected into chat requests when client sends tools (admin toggle per server)
 *  Implementation: JSON-RPC 2.0 over HTTP (streamable, SSE responses not needed for basic tool calls).
 *  stdio servers are spawned once and kept alive; lazily restarted if dead.
 */
const express = require('express');
const { spawn } = require('child_process');
const { db } = require('../store');
const logger = require('../logger');

const router = express.Router();
const procs = new Map(); // serverId -> {proc, pending:Map(id->resolve), nextId, buffer}

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
  await rpcCall(server, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-free-api', version: '0.1.0' } });
  if (server.transport === 'stdio') rpcCall(server, 'notifications/initialized', {}).catch(() => {});
}

async function listTools(server) {
  const filter = (server.tool_filter || '*').split(',').map(s => s.trim()).filter(Boolean);
  const resp = await rpcCall(server, 'tools/list', {});
  let tools = resp?.result?.tools || [];
  if (filter[0] !== '*') tools = tools.filter(t => filter.includes(t.name));
  return tools;
}

// kill procs on shutdown
process.on('exit', () => { for (const [, s] of procs) { try { s.proc.kill(); } catch {} } });

// ---------- gateway MCP endpoint (clients connect here) ----------
// Streamable-HTTP-style: POST /mcp with JSON-RPC; GET returns info.
router.post('/', async (req, res) => {
  const { method, params, id } = req.body || {};
  try {
    if (method === 'initialize') {
      return res.json({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dsh-free-api-mcp', version: '0.1.0' } } });
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
    if (method === 'ping') return res.json({ jsonrpc: '2.0', id, result: {} });
    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `method ${method} not supported` } });
  } catch (e) {
    res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
  }
});

module.exports = { router, listServers, getServer, listTools, rpcCall, initialize };
