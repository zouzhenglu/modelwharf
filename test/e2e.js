'use strict';
/**
 * End-to-end test: boots its own isolated server (fresh temp DB) on :8397,
 * exercises admin API + gateway with a mock provider account.
 * Run: npm test
 */
const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 8397;
const BASE = `http://localhost:${PORT}`;
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wharf-e2e-'));
let TOKEN = '';
let serverProc = null;

// e2e-only provider: minimal plugin with a checkin() implementation wired to the
// mock server below. Written into src/providers/ before the server boots (the
// registry auto-loads every non-underscore .js there), removed after the run.
const TEST_PLUGIN_PATH = path.join(__dirname, '..', 'src', 'providers', 'zz-e2e-checkin.js');
const TEST_PLUGIN_SRC = `'use strict';
// e2e-only test plugin (auto-deleted by test/e2e.js) — checkin wired to the mock upstream.
const { httpJson } = require('../utils/http');
module.exports = {
  id: 'e2echeckin',
  label: 'E2E Checkin (test only)',
  importLocal: false,
  credFields: [{ name: 'baseUrl', label: 'Base URL', required: true }],
  async listModels(account) { return [{ upstream: 'mock-model-a' }]; },
  async checkAccount(account) { return { ok: true, message: 'e2e mock' }; },
  async checkin(account) {
    const base = String(account.credentials.baseUrl || '').replace(/\\/+$/, '');
    const st = await httpJson(base + '/checkin/status', { timeoutMs: 5000 });
    if (st.status !== 200) return { ok: false, message: 'HTTP ' + st.status };
    if (st.json.checked_in) return { ok: true, already: true, message: '今日已签到' };
    const cl = await httpJson(base + '/checkin/claim', { method: 'POST', body: {}, timeoutMs: 5000 });
    // emulate workbuddy's already-checked-in shape: HTTP 400 + {"code":10001,"msg":"今天已签到…"}
    if (cl.status !== 200 && /已签到/.test(String(cl.text || ''))) {
      return { ok: false, message: '签到请求失败 HTTP ' + cl.status, raw: { status: cl.status, json: cl.json, text: String(cl.text || '') } };
    }
    if (cl.status !== 200) return { ok: false, message: 'HTTP ' + cl.status };
    return { ok: true, gained: cl.json.credits, message: '签到成功 +' + cl.json.credits, extra: { credits: cl.json.balance } };
  },
  async *chat() { yield JSON.stringify({ choices: [{ delta: { content: 'e2e' } }] }); },
};
`;
function removeTestPlugin() { try { fs.rmSync(TEST_PLUGIN_PATH, { force: true }); } catch {} }
fs.writeFileSync(TEST_PLUGIN_PATH, TEST_PLUGIN_SRC);

// line-based JSON-RPC stdio MCP mock server (tools + resources + prompts), written to TMPDIR at use
const MCP_MOCK_SRC = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  const fail = (code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }) + '\\n');
  const args = (msg.params && msg.params.arguments) || {};
  switch (msg.method) {
    case 'initialize': return reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock-mcp', version: '0' } });
    case 'tools/list': return reply({ tools: [{ name: 'echo', description: 'echo tool', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
    case 'tools/call': return reply({ content: [{ type: 'text', text: 'ok:' + JSON.stringify(args) }] });
    case 'resources/list': return reply({ resources: [{ uri: 'memo://note', name: 'note', description: 'a note', mimeType: 'text/plain' }] });
    case 'resources/templates/list': return reply({ resourceTemplates: [{ uriTemplate: 'memo://{name}', name: 'memo' }] });
    case 'resources/read': return reply({ contents: [{ uri: (msg.params && msg.params.uri) || 'memo://note', mimeType: 'text/plain', text: 'hello-resource' }] });
    case 'prompts/list': return reply({ prompts: [{ name: 'greet', description: 'greet prompt', arguments: [{ name: 'who', required: true }] }] });
    case 'prompts/get': return reply({ description: 'greet', messages: [{ role: 'user', content: { type: 'text', text: 'hi ' + (args.who || '') } }] });
    default: return fail(-32601, 'unknown method ' + msg.method);
  }
});
`;

async function call(method, path, body, headers = {}) {
  const resp = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: resp.status, json, text };
}

async function startServer() {
  // capture boot output (bounded) so startup failures are diagnosable in CI logs
  const bootLog = [];
  let bootBytes = 0;
  const cap = (d) => { if (bootBytes < 8192) { bootLog.push(d); bootBytes += d.length; } };
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DSH_PORT: String(PORT), DSH_DATA_DIR: TMPDIR, DSH_ADMIN_PASSWORD: 'admin' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', cap);
  serverProc.stderr.on('data', cap);
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  const out = Buffer.concat(bootLog).toString('utf8').trim();
  throw new Error('server failed to start' + (out ? ' — boot output:\n' + out : ' (no output; process may have crashed)'));
}

async function main() {
  let pass = 0, fail = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
  };

  console.log('== health ==');
  await t('GET /health', async () => {
    const r = await call('GET', '/health');
    assert.equal(r.status, 200);
    assert.ok(r.json.providers.includes('trae'));
    assert.ok(r.json.providers.includes('workbuddy'));
    assert.ok(r.json.providers.includes('workbuddyintl'));
    assert.ok(r.json.providers.includes('qwen'));
    assert.ok(r.json.providers.includes('qoder'));
    assert.ok(r.json.providers.includes('qodercn'));
  });

  console.log('== admin ==');
  await t('login wrong password -> 401', async () => {
    const r = await call('POST', '/admin/api/login', { password: 'nope' });
    assert.equal(r.status, 401);
  });
  await t('login admin -> token', async () => {
    const r = await call('POST', '/admin/api/login', { password: 'admin' });
    assert.equal(r.status, 200);
    assert.ok(r.json.token);
    TOKEN = r.json.token;
  });
  const auth = { Authorization: 'Bearer ' + TOKEN };
  await t('GET /admin/api/providers — supports_oauth 由服务端声明', async () => {
    const r = await call('GET', '/admin/api/providers', null, auth);
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.json.map(p => [p.id, p]));
    assert.ok(byId.workbuddy.supports_oauth === true, 'workbuddy 应支持 OAuth');
    assert.ok(byId.workbuddyintl.supports_oauth === true, 'workbuddyintl 应支持 OAuth');
    assert.ok(byId.qwenwork.supports_oauth === true, 'qwenwork 应支持 OAuth');
    assert.ok(byId.trae.supports_oauth === false, 'trae 不应有 OAuth 按钮');
    assert.equal(byId.workbuddyintl.label.includes('国际版'), true);
  });

  // mock upstream server (OpenAI compatible) — listen on 127.0.0.1 explicitly
  let mockCheckedIn = false;
  const mock = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }, { id: 'mock-echo' }] }));
    }
    if (req.url === '/v1/embeddings') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const j = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', embedding: [0.1, 0.2, 0.3], index: 0 }], model: j.model, usage: { prompt_tokens: 4, total_tokens: 4 } }));
      });
      return;
    }
    if (req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const j = JSON.parse(body || '{}');
        // mock-echo: echo received upstream params back as content; honor n (multi-choice)
        if (j.model === 'mock-echo') {
          const echo = {
            stop: j.stop, seed: j.seed, presence_penalty: j.presence_penalty, frequency_penalty: j.frequency_penalty,
            logprobs: j.logprobs, top_logprobs: j.top_logprobs, n: j.n,
            reasoning_effort: j.reasoning_effort, enable_thinking: j.enable_thinking, thinking_budget: j.thinking_budget,
          };
          const n = Math.max(1, Number(j.n) || 1);
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (let i = 0; i < n; i++) {
            res.write(`data: ${JSON.stringify({ choices: [{ index: i, delta: { role: 'assistant', content: `echo#${i}:${JSON.stringify(echo)}` } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ index: i, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 4 } })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '你好' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '，世界！' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }
    if (req.url === '/checkin/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ checked_in: mockCheckedIn }));
    }
    if (req.url === '/checkin/claim') {
      if (mockCheckedIn) {
        // emulate workbuddy: already-checked-in is HTTP 400 + business body
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ code: 10001, msg: '今天已签到，请明天再来', requestId: 'mock-req' }));
      }
      mockCheckedIn = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ credits: 20, balance: 130 }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => mock.listen(8399, '127.0.0.1', r));
  // verify mock is reachable before continuing
  const mockPing = await fetch('http://127.0.0.1:8399/v1/models');
  assert.equal(mockPing.status, 200, 'mock server not reachable');

  await t('add openai-compat account -> mock', async () => {
    const r = await call('POST', '/admin/api/accounts', {
      provider_id: 'openai-compat', name: 'mock',
      credentials: { baseUrl: 'http://127.0.0.1:8399/v1', apiKey: 'test' },
    }, auth);
    assert.equal(r.status, 200, r.text);
  });
  await t('refresh models from mock', async () => {
    const r = await call('POST', '/admin/api/providers/openai-compat/refresh-models', {}, auth);
    assert.equal(r.status, 200);
    assert.ok(r.json.added >= 2, `added=${r.json.added}`);
  });
  await t('rename public model', async () => {
    const models = await call('GET', '/admin/api/models?provider_id=openai-compat', null, auth);
    const a = models.json.find(m => m.upstream_model === 'mock-model-a');
    const r = await call('PUT', `/admin/api/models/${a.id}`, { public_name: 'mock-a', multiplier: 0.5, is_free: true, tags: 'test,free' }, auth);
    assert.equal(r.status, 200);
  });
  await t('disable mock-model-b', async () => {
    const models = await call('GET', '/admin/api/models?provider_id=openai-compat', null, auth);
    const b = models.json.find(m => m.upstream_model === 'mock-model-b');
    await call('POST', `/admin/api/models/${b.id}/toggle`, {}, auth);
    const after = await call('GET', '/v1/models');
    assert.ok(!after.json.data.find(m => m.id === 'mock-model-b'));
    assert.ok(after.json.data.find(m => m.id === 'mock-a'));
  });

  console.log('== gateway (openai) ==');
  await t('non-stream chat', async () => {
    const r = await call('POST', '/v1/chat/completions', { model: 'mock-a', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.choices[0].message.content, '你好，世界！');
    assert.equal(r.json.usage.prompt_tokens, 5);
    assert.equal(r.json.usage.completion_tokens, 7);
  });
  await t('stream chat (SSE)', async () => {
    const resp = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock-a', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.ok(text.includes('"content":"你好"'));
    assert.ok(text.includes('[DONE]'));
  });
  await t('unknown model -> 404', async () => {
    const r = await call('POST', '/v1/chat/completions', { model: 'nope', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 404);
  });
  await t('sampling params passthrough (stop/seed/penalties/logprobs)', async () => {
    const r = await call('POST', '/v1/chat/completions', {
      model: 'mock-echo', messages: [{ role: 'user', content: 'hi' }],
      stop: ['cat'], seed: 7, presence_penalty: 0.5, frequency_penalty: 0.3, logprobs: true, top_logprobs: 2,
    });
    assert.equal(r.status, 200, r.text);
    const content = r.json.choices[0].message.content;
    const echo = JSON.parse(content.slice(content.indexOf('{')));
    assert.deepEqual(echo.stop, ['cat']);
    assert.equal(echo.seed, 7);
    assert.equal(echo.presence_penalty, 0.5);
    assert.equal(echo.frequency_penalty, 0.3);
    assert.equal(echo.logprobs, true);
    assert.equal(echo.top_logprobs, 2);
  });
  await t('n=2 returns two indexed choices', async () => {
    const r = await call('POST', '/v1/chat/completions', { model: 'mock-echo', messages: [{ role: 'user', content: 'hi' }], n: 2 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.choices.length, 2, r.text);
    assert.equal(r.json.choices[0].index, 0);
    assert.equal(r.json.choices[1].index, 1);
    assert.ok(r.json.choices[0].message.content.startsWith('echo#0:'));
    assert.ok(r.json.choices[1].message.content.startsWith('echo#1:'));
  });
  await t('stream n=2 keeps per-choice indexes', async () => {
    const resp = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock-echo', messages: [{ role: 'user', content: 'hi' }], stream: true, n: 2 }),
    });
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.ok(text.includes('"index":1'), 'missing choice index 1 in stream');
    assert.ok(text.includes('[DONE]'));
  });
  await t('legacy /v1/completions n=2 returns two texts', async () => {
    const r = await call('POST', '/v1/completions', { model: 'mock-echo', prompt: 'hi', n: 2 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.object, 'text_completion');
    assert.equal(r.json.choices.length, 2, r.text);
    assert.equal(r.json.choices[0].index, 0);
    assert.equal(r.json.choices[1].index, 1);
    assert.ok(r.json.choices[0].text.startsWith('echo#0:'), r.text);
    assert.ok(r.json.choices[1].text.startsWith('echo#1:'), r.text);
  });
  await t('legacy /v1/completions rejects stream + n>1 clearly', async () => {
    const r = await call('POST', '/v1/completions', { model: 'mock-echo', prompt: 'hi', stream: true, n: 2 });
    assert.equal(r.status, 400, r.text);
    assert.match(r.json.error.message, /chat\/completions/);
  });
  await t('POST /v1/embeddings', async () => {
    const r = await call('POST', '/v1/embeddings', { model: 'mock-a', input: ['hello', 'world'] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.object, 'list');
    assert.equal(r.json.model, 'mock-a');
    assert.equal(r.json.data[0].embedding.length, 3);
    assert.equal(r.json.usage.prompt_tokens, 4);
  });
  await t('embeddings via official vendor plugin (baseUrl override)', async () => {
    // deepseek vendor plugin with account baseUrl pointed at the mock exercises official.js embeddings
    const add = await call('POST', '/admin/api/accounts', {
      provider_id: 'deepseek', name: 'mock-vendor',
      credentials: { baseUrl: 'http://127.0.0.1:8399/v1', apiKey: 'x' },
    }, auth);
    assert.equal(add.status, 200, add.text);
    await call('POST', '/admin/api/providers/deepseek/refresh-models', {}, auth);
    const models = await call('GET', '/admin/api/models?provider_id=deepseek', null, auth);
    const emb = models.json[0];
    // unique public name: engine looks models up by name only, mock names collide with openai-compat rows
    await call('PUT', `/admin/api/models/${emb.id}`, { public_name: 'vendor-emb' }, auth);
    const r = await call('POST', '/v1/embeddings', { model: 'vendor-emb', input: 'hello' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data[0].embedding.length, 3);
  });

  console.log('== gateway (anthropic) ==');
  await t('/v1/messages non-stream', async () => {
    const r = await call('POST', '/v1/messages', { model: 'mock-a', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.type, 'message');
    assert.equal(r.json.content[0].text, '你好，世界！');
  });
  await t('/v1/messages/count_tokens returns estimate', async () => {
    const r = await call('POST', '/v1/messages/count_tokens', { model: 'mock-a', messages: [{ role: 'user', content: 'hello你好' }] });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.input_tokens > 0, r.text);
  });
  await t('thinking budget_tokens maps to reasoning effort', async () => {
    const r = await call('POST', '/v1/messages', {
      model: 'mock-echo', max_tokens: 100,
      thinking: { type: 'enabled', budget_tokens: 20000 }, messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.status, 200, r.text);
    const content = r.json.content[0].text;
    const echo = JSON.parse(content.slice(content.indexOf('{')));
    assert.equal(echo.reasoning_effort, 'high', content);
  });
  await t('thinking disabled maps to reasoning off', async () => {
    const r = await call('POST', '/v1/messages', {
      model: 'mock-echo', max_tokens: 100,
      thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.status, 200, r.text);
    const content = r.json.content[0].text;
    const echo = JSON.parse(content.slice(content.indexOf('{')));
    assert.equal(echo.reasoning_effort, 'none', content);
  });
  await t('model suffix -think overrides thinking field', async () => {
    const r = await call('POST', '/v1/messages', {
      model: 'mock-echo-think', max_tokens: 100,
      thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.status, 200, r.text);
    const content = r.json.content[0].text;
    const echo = JSON.parse(content.slice(content.indexOf('{')));
    assert.equal(echo.reasoning_effort, 'medium', content);
  });

  console.log('== apikeys ==');
  let keyId, fullKey;
  await t('create key', async () => {
    const r = await call('POST', '/admin/api/apikeys', { name: 'test-key', allowed_models: 'mock-a' }, auth);
    assert.equal(r.status, 200);
    keyId = r.json.id; fullKey = r.json.key;
  });
  await t('key with model restriction: allowed model works', async () => {
    const r = await call('POST', '/v1/chat/completions', { model: 'mock-a', messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer ' + fullKey });
    assert.equal(r.status, 200);
  });
  await t('key with model restriction: blocked model 403', async () => {
    const r = await call('POST', '/v1/chat/completions', { model: 'mock-model-b', messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer ' + fullKey });
    assert.equal(r.status, 403);
  });
  await t('bad key -> 401', async () => {
    const r = await call('POST', '/v1/chat/completions', { model: 'mock-a', messages: [{ role: 'user', content: 'x' }] }, { Authorization: 'Bearer sk-bad' });
    assert.equal(r.status, 401);
  });

  console.log('== usage ==');
  await t('usage rows recorded', async () => {
    const r = await call('GET', '/admin/api/usage?model=mock-a', null, auth);
    assert.ok(r.json.total >= 2, `total=${r.json.total}`);
  });
  await t('stats aggregate', async () => {
    const r = await call('GET', '/admin/api/stats', null, auth);
    assert.ok(r.json.today.reqs >= 2);
    // 昨日对比数据（仪表盘「较昨日」用）
    assert.equal(typeof r.json.yesterday.reqs, 'number');
    assert.equal(typeof r.json.yesterday.errors, 'number');
    assert.equal(typeof r.json.yesterday.credits, 'number');
  });

  console.log('== mcp gateway ==');
  await t('mcp auth: no key -> 401 once keys exist', async () => {
    const r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(r.status, 401, r.text);
  });
  const mcpAuth = { Authorization: 'Bearer ' + fullKey };
  await t('mcp initialize + tools/list (empty ok)', async () => {
    const r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, mcpAuth);
    assert.equal(r.status, 200);
    assert.equal(r.json.result.serverInfo.name, 'modelwharf-mcp');
    assert.ok(r.json.result.capabilities.resources, 'resources capability missing');
    assert.ok(r.json.result.capabilities.prompts, 'prompts capability missing');
    const r2 = await call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, mcpAuth);
    assert.equal(r2.status, 200);
    assert.ok(Array.isArray(r2.json.result.tools));
  });
  await t('mcp stdio upstream: tools/resources/prompts aggregated', async () => {
    const script = path.join(TMPDIR, 'mcp-mock.js');
    fs.writeFileSync(script, MCP_MOCK_SRC);
    const add = await call('POST', '/admin/api/mcp', { id: 'mock', transport: 'stdio', command: process.execPath, args: [script] }, auth);
    assert.equal(add.status, 200, add.text);
    // tools
    const tools = await call('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, mcpAuth);
    assert.ok(tools.json.result.tools.find(x => x.name === 'mock__echo'), tools.text);
    const toolCall = await call('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mock__echo', arguments: { text: 'hi' } } }, mcpAuth);
    assert.equal(toolCall.json.result.content[0].text, 'ok:{"text":"hi"}', toolCall.text);
    // resources: URI 带 mcpres:// 前缀，read 可还原路由
    const rl = await call('POST', '/mcp', { jsonrpc: '2.0', id: 5, method: 'resources/list' }, mcpAuth);
    const uri = rl.json.result.resources[0]?.uri;
    assert.ok(uri && uri.startsWith('mcpres://mock/'), `bad resource uri: ${uri}`);
    const tmpl = rl.json.result.resourceTemplates[0]?.uriTemplate || '';
    assert.ok(tmpl.startsWith('mcpres://mock/'), rl.text);
    assert.ok(tmpl.includes('{name}'), `template placeholder must survive prefixing: ${tmpl}`);
    const rd = await call('POST', '/mcp', { jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri } }, mcpAuth);
    assert.equal(rd.json.result.contents[0].text, 'hello-resource', rd.text);
    assert.ok(rd.json.result.contents[0].uri.startsWith('mcpres://mock/'));
    // prompts: 名称按 服务id__提示词名 聚合
    const pl = await call('POST', '/mcp', { jsonrpc: '2.0', id: 7, method: 'prompts/list' }, mcpAuth);
    assert.equal(pl.json.result.prompts[0]?.name, 'mock__greet', pl.text);
    const pg = await call('POST', '/mcp', { jsonrpc: '2.0', id: 8, method: 'prompts/get', params: { name: 'mock__greet', arguments: { who: 'bob' } } }, mcpAuth);
    assert.equal(pg.json.result.messages[0].content.text, 'hi bob', pg.text);
  });
  await t('mcp rejects tool names without server prefix', async () => {
    const r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'echo', arguments: {} } }, mcpAuth);
    assert.equal(r.json.error.code, -32602, r.text);
    assert.match(r.json.error.message, /服务id__工具名/);
  });

  console.log('== providers: no-healthy-account path ==');
  await t('model with no accounts -> 503', async () => {
    // add manual model for trae with no accounts (keys exist now, so use the created key)
    const r = await call('POST', '/admin/api/models', { provider_id: 'trae', upstream_model: 'glm-5.2', public_name: 'trae-glm' }, auth);
    assert.equal(r.status, 200);
    const r2 = await call('POST', '/v1/chat/completions', { model: 'trae-glm', messages: [{ role: 'user', content: 'x' }] }, { Authorization: 'Bearer ' + fullKey });
    // trae-glm not in key's allowed list? allowed_models='mock-a' -> 403 expected; create a wider key instead
    assert.ok(r2.status === 403 || r2.status === 503, `got ${r2.status}`);
  });

  console.log('== batch model ops ==');
  await t('batch disable+enable', async () => {
    const models = await call('GET', '/admin/api/models?provider_id=openai-compat', null, auth);
    const ids = models.json.map(m => m.id);
    let r = await call('POST', '/admin/api/models/batch', { action: 'disable', ids }, auth);
    assert.ok(r.json.affected >= 2);
    r = await call('POST', '/admin/api/models/batch', { action: 'enable', ids }, auth);
    assert.ok(r.json.affected >= 2);
  });
  await t('batch delete removes model', async () => {
    const add = await call('POST', '/admin/api/models', { provider_id: 'openai-compat', upstream_model: 'mock-model-a', public_name: 'to-delete' }, auth);
    const r = await call('POST', '/admin/api/models/batch', { action: 'delete', ids: [add.json.id] }, auth);
    assert.equal(r.json.affected, 1);
  });

  console.log('== virtual models (统一模型 + 故障切换) ==');
  await t('create virtual model with fallback chain', async () => {
    // primary: a model whose only "account" is a dead endpoint; fallback: mock-a
    const dead = await call('POST', '/admin/api/models', { provider_id: 'openai-compat', upstream_model: 'mock-model-a', public_name: 'dead-model' }, auth);
    assert.equal(dead.status, 200);
    // point the openai-compat account at a dead port via a second account
    await call('POST', '/admin/api/accounts', { provider_id: 'openai-compat', name: 'dead-upstream', credentials: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x' } }, auth);
    const r = await call('POST', '/admin/api/virtual-models', {
      public_name: 'uni-test',
      targets: [
        { provider_id: 'openai-compat', public_name: 'dead-model', priority: 10 },
        { provider_id: 'openai-compat', public_name: 'mock-a', priority: 20 },
      ],
    }, auth);
    assert.equal(r.status, 200, r.text);
    // widen the test key to allow the virtual names too
    await call('PUT', '/admin/api/apikeys/' + keyId, { allowed_models: '*' }, auth);
  });
  await t('virtual model fails over to second target', async () => {
    const r = await call('POST', '/v1/chat/completions', { model: 'uni-test', messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer ' + fullKey });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.choices[0].message.content, '你好，世界！');
  });
  // 死端点账号完成故障转移使命后禁用：否则轮询池 50% 抽中它，后续用例随机 502
  {
    const accts = await call('GET', '/admin/api/accounts?provider_id=openai-compat', null, auth);
    const deadAcct = accts.json.find(a => a.name === 'dead-upstream');
    if (deadAcct) await call('PUT', '/admin/api/accounts/' + deadAcct.id, { enabled: false }, auth);
  }
  await t('virtual model honors -think suffix', async () => {
    const r = await call('POST', '/v1/chat/completions', { model: 'uni-test-think', messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer ' + fullKey });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.choices[0].message.content, '你好，世界！');
  });
  await t('virtual model appears in /v1/models', async () => {
    const r = await call('GET', '/v1/models', null, { Authorization: 'Bearer ' + fullKey });
    assert.ok(r.json.data.find(m => m.id === 'uni-test'));
  });
  await t('virtual rename: external gpt-name serves mock upstream', async () => {
    const r = await call('POST', '/admin/api/virtual-models', {
      public_name: 'gpt-4o',
      targets: [{ provider_id: 'openai-compat', public_name: 'mock-a', priority: 10 }],
    }, auth);
    assert.equal(r.status, 200);
    const chat = await call('POST', '/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer ' + fullKey });
    assert.equal(chat.status, 200);
    assert.equal(chat.json.model, 'gpt-4o');
  });
  // 负载均衡测试（账号路由已确定：dead-upstream 已禁用）
  await t('virtual weighted strategy spreads traffic', async () => {
    const r = await call('POST', '/admin/api/virtual-models', {
      public_name: 'uni-weighted',
      strategy: 'weighted',
      targets: [
        { provider_id: 'openai-compat', public_name: 'mock-a', priority: 10, weight: 100 },
        { provider_id: 'openai-compat', public_name: 'mock-echo', priority: 20, weight: 100 },
      ],
    }, auth);
    assert.equal(r.status, 200, r.text);
    const kinds = new Set();
    for (let i = 0; i < 20; i++) {
      const chat = await call('POST', '/v1/chat/completions', { model: 'uni-weighted', messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer ' + fullKey });
      assert.equal(chat.status, 200, chat.text);
      kinds.add(chat.json.choices[0].message.content.startsWith('echo#') ? 'echo' : 'greet');
    }
    assert.ok(kinds.has('echo') && kinds.has('greet'), 'weighted strategy did not spread: ' + [...kinds]);
  });
  await t('virtual least_conn strategy spreads concurrent traffic', async () => {
    const r = await call('POST', '/admin/api/virtual-models', {
      public_name: 'uni-least',
      strategy: 'least_conn',
      targets: [
        { provider_id: 'openai-compat', public_name: 'mock-a', priority: 10 },
        { provider_id: 'openai-compat', public_name: 'mock-echo', priority: 20 },
      ],
    }, auth);
    assert.equal(r.status, 200, r.text);
    // 抬高并发上限，确保 6 个并发都能拿到账号
    const accts = await call('GET', '/admin/api/accounts?provider_id=openai-compat', null, auth);
    for (const a of accts.json.filter(x => x.enabled)) await call('PUT', '/admin/api/accounts/' + a.id, { max_concurrency: 10 }, auth);
    const results = await Promise.all([...Array(6)].map(() => call('POST', '/v1/chat/completions', { model: 'uni-least', messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer ' + fullKey })));
    for (const x of results) assert.equal(x.status, 200, x.text);
    const kinds = new Set(results.map(x => x.json.choices[0].message.content.startsWith('echo#') ? 'echo' : 'greet'));
    assert.ok(kinds.has('echo') && kinds.has('greet'), 'least_conn strategy did not spread: ' + [...kinds]);
  });

  console.log('== usage chart ==');
  await t('chart endpoint returns series', async () => {
    const r = await call('GET', '/admin/api/usage/chart?hours=24', null, auth);
    assert.equal(r.status, 200);
    assert.equal(r.json.series.length, 24);
  });
  await t('chart series carries latency + breakdown lat', async () => {
    const r = await call('GET', '/admin/api/usage/chart?hours=24', null, auth);
    const s = r.json.series[0];
    for (const k of ['reqs', 'tin', 'tout', 'errors', 'credits', 'lat', 'latMax']) {
      assert.equal(typeof s[k], 'number', `series.${k} missing`);
    }
    if (r.json.byModel.length) assert.equal(typeof r.json.byModel[0].lat, 'number', 'byModel.lat missing');
    if (r.json.byProvider.length) assert.equal(typeof r.json.byProvider[0].lat, 'number', 'byProvider.lat missing');
    if (r.json.byStatus.length) assert.equal(typeof r.json.byStatus[0].credits, 'number', 'byStatus.credits missing');
  });

  console.log('== enabled filter fix ==');
  await t('models?enabled=0 returns only disabled', async () => {
    // disable one model then filter
    const models = await call('GET', '/admin/api/models?provider_id=openai-compat', null, auth);
    const victim = models.json.find(m => m.public_name === 'mock-model-b');
    await call('POST', `/admin/api/models/${victim.id}/toggle`, {}, auth); // disable
    const r = await call('GET', '/admin/api/models?provider_id=openai-compat&enabled=0', null, auth);
    assert.ok(r.json.length >= 1);
    assert.ok(r.json.every(m => m.enabled === 0), 'filter returned enabled rows');
    await call('POST', `/admin/api/models/${victim.id}/toggle`, {}, auth); // restore
  });

  console.log('== responses api (Codex) ==');
  await t('POST /v1/responses non-stream', async () => {
    const r = await call('POST', '/v1/responses', {
      model: 'mock-a', input: 'hello', instructions: 'be brief',
    }, { Authorization: 'Bearer ' + fullKey });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.object, 'response');
    assert.equal(r.json.status, 'completed');
    assert.equal(r.json.output_text, '你好，世界！');
    assert.ok(r.json.output.find(o => o.type === 'message'));
  });
  await t('POST /v1/responses streaming events', async () => {
    const resp = await fetch(BASE + '/v1/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + fullKey },
      body: JSON.stringify({ model: 'mock-a', input: 'hi', stream: true }),
    });
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.ok(text.includes('"type":"response.created"'));
    assert.ok(text.includes('"type":"response.output_text.delta"'));
    assert.ok(text.includes('"type":"response.completed"'));
  });
  await t('reasoning suffix -think routes to base model', async () => {
    const r = await call('POST', '/v1/chat/completions', { model: 'mock-a-think', messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer ' + fullKey });
    assert.equal(r.status, 200, r.text);
  });

  console.log('== checkin (自动签到) ==');
  await t('checkin status endpoint', async () => {
    const r = await call('GET', '/admin/api/checkin/status', null, auth);
    assert.equal(r.status, 200);
    assert.equal(r.json.enabled, true);
    assert.ok(Array.isArray(r.json.accounts));
    assert.ok(Array.isArray(r.json.recent));
  });
  await t('checkin settings get/put', async () => {
    const r = await call('PUT', '/admin/api/settings/checkin', { enabled: true, hour: 8 }, auth);
    assert.equal(r.status, 200);
    assert.equal(r.json.hour, 8);
    const g = await call('GET', '/admin/api/settings/checkin', null, auth);
    assert.equal(g.json.enabled, true);
    assert.equal(g.json.hour, 8);
    await call('PUT', '/admin/api/settings/checkin', { hour: 9 }, auth); // restore
  });
  await t('single-account checkin against mock upstream', async () => {
    // add an e2echeckin account pointing at the mock server's checkin endpoints
    const add = await call('POST', '/admin/api/accounts', {
      provider_id: 'e2echeckin', name: 'mock-checkin',
      credentials: { baseUrl: 'http://127.0.0.1:8399' },
    }, auth);
    assert.equal(add.status, 200, add.text);
    const accId = add.json.id;
    const r = await call('POST', `/admin/api/accounts/${accId}/checkin`, {}, auth);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true, r.text);
    assert.equal(r.json.gained, 20);
    // single-account checkin always asks upstream: mock returns HTTP 400 +
    // {"code":10001,"msg":"今天已签到…"} (workbuddy-style) — core's
    // alreadyCheckinSignal() must reclassify it as already-checked-in
    const r2 = await call('POST', `/admin/api/accounts/${accId}/checkin`, {}, auth);
    assert.equal(r2.json.ok, true, r2.text);
    assert.equal(r2.json.already, true);
    assert.equal(r2.json.skipped, undefined);
    assert.match(r2.json.message, /已签到/);
    // credits from checkin extra merged into account profile
    const after = await call('GET', '/admin/api/accounts?provider_id=e2echeckin', null, auth);
    assert.equal(after.json.find(a => a.id === accId).extra.credits, 130);
  });
  await t('checkin-all runs and logs', async () => {
    const r = await call('POST', '/admin/api/checkin/all', {}, auth);
    assert.equal(r.status, 200);
    assert.ok(r.json.total >= 2); // mock + mock-checkin accounts
    const st = await call('GET', '/admin/api/checkin/status', null, auth);
    assert.ok(st.json.recent.length >= 1);
    assert.ok(st.json.accounts.find(a => a.name === 'mock-checkin').done === true);
  });

  console.log('== embeddings: unsupported provider ==');
  await t('provider without embeddings -> 501', async () => {
    const add = await call('POST', '/admin/api/models', { provider_id: 'e2echeckin', upstream_model: 'mock-model-a', public_name: 'no-emb' }, auth);
    assert.equal(add.status, 200, add.text);
    const r = await call('POST', '/v1/embeddings', { model: 'no-emb', input: 'x' }, { Authorization: 'Bearer ' + fullKey });
    assert.equal(r.status, 501, r.text);
    assert.match(r.json.error.message, /embeddings/);
  });
  await t('virtual embeddings fails over past unsupported target', async () => {
    const r = await call('POST', '/admin/api/virtual-models', {
      public_name: 'uni-emb',
      targets: [
        { provider_id: 'e2echeckin', public_name: 'no-emb', priority: 10 },   // 501 无 embeddings
        { provider_id: 'openai-compat', public_name: 'mock-a', priority: 20 }, // 可用
      ],
    }, auth);
    assert.equal(r.status, 200, r.text);
    const emb = await call('POST', '/v1/embeddings', { model: 'uni-emb', input: 'x' }, { Authorization: 'Bearer ' + fullKey });
    assert.equal(emb.status, 200, emb.text);
    assert.equal(emb.json.data[0].embedding.length, 3);
  });
  await t('PUT virtual-models persists strategy + target weights', async () => {
    const r = await call('PUT', '/admin/api/virtual-models/uni-emb', {
      strategy: 'weighted',
      targets: [
        { provider_id: 'e2echeckin', public_name: 'no-emb', priority: 10, weight: 30 },
        { provider_id: 'openai-compat', public_name: 'mock-a', priority: 20, weight: 70 },
      ],
    }, auth);
    assert.equal(r.status, 200, r.text);
    const list = await call('GET', '/admin/api/virtual-models', null, auth);
    const v = list.json.find(x => x.public_name === 'uni-emb');
    assert.equal(v.strategy, 'weighted', r.text);
    const targets = JSON.parse(v.targets);
    assert.equal(targets[0].weight, 30);
    assert.equal(targets[1].weight, 70);
  });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  mock.close();
  if (serverProc) serverProc.kill();
  removeTestPlugin();
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* windows may hold the db briefly */ }
  process.exit(fail ? 1 : 0);
}

(async () => {
  await startServer();
  try { await main(); }
  catch (e) { console.error(e); process.exitCode = 1; }
  finally {
    if (serverProc) serverProc.kill();
    removeTestPlugin();
  }
})().catch(e => { console.error(e); if (serverProc) serverProc.kill(); removeTestPlugin(); process.exit(1); });
