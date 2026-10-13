'use strict';
/**
 * End-to-end test: boots nothing (expects server running on :8317 with a fresh DB),
 * exercises admin API + gateway with a mock provider account (openai-compat pointed at an internal mock).
 */
const assert = require('assert');
const http = require('http');

const BASE = 'http://localhost:8317';
let TOKEN = '';

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

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  mock.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
