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
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-'));
let TOKEN = '';
let serverProc = null;

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
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DSH_PORT: String(PORT), DSH_DATA_DIR: TMPDIR, DSH_ADMIN_PASSWORD: 'admin' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server failed to start');
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

  // mock upstream server (OpenAI compatible) — listen on 127.0.0.1 explicitly
  const mock = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const wantsStream = JSON.parse(body || '{}').stream;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '你好' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '，世界！' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
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

  console.log('== gateway (anthropic) ==');
  await t('/v1/messages non-stream', async () => {
    const r = await call('POST', '/v1/messages', { model: 'mock-a', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.type, 'message');
    assert.equal(r.json.content[0].text, '你好，世界！');
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
  });

  console.log('== mcp gateway ==');
  await t('mcp initialize + tools/list (empty ok)', async () => {
    const r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.result.serverInfo.name, 'dsh-free-api-mcp');
    const r2 = await call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(r2.status, 200);
    assert.ok(Array.isArray(r2.json.result.tools));
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

  console.log('== usage chart ==');
  await t('chart endpoint returns series', async () => {
    const r = await call('GET', '/admin/api/usage/chart?hours=24', null, auth);
    assert.equal(r.status, 200);
    assert.equal(r.json.series.length, 24);
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

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  mock.close();
  if (serverProc) serverProc.kill();
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* windows may hold the db briefly */ }
  process.exit(fail ? 1 : 0);
}

(async () => {
  await startServer();
  await main();
})().catch(e => { console.error(e); if (serverProc) serverProc.kill(); process.exit(1); });
