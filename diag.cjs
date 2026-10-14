'use strict';
const http = require('http');
const { URL } = require('url');
function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL('http://127.0.0.1:8317' + path);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: '127.0.0.1', port: 8317, path, method, headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
(async () => {
  const login = await req('POST', '/admin/api/login', { password: 'admin' });
  const tok = JSON.parse(login.body).token;
  console.log('login status', login.status, 'token?', !!tok);
  const models = await req('GET', '/admin/api/models?provider_id=trae', null, tok);
  const arr = JSON.parse(models.body);
  console.log('admin trae models =', arr.length);
  console.log('enabled:', arr.filter(m => m.enabled).length, 'disabled:', arr.filter(m => !m.enabled).length);
  console.log('account_count values:', [...new Set(arr.map(m => m.account_count))]);
  console.log('sample (first 5):');
  for (const m of arr.slice(0, 5)) console.log(`  pub=${m.public_name} up=${m.upstream_model} en=${m.enabled} free=${m.is_free} mult=${m.multiplier} ctx=${m.ctx_window} maxout=${m.max_output} tags=${m.tags} acct=${m.account_count}`);
  // check account status
  const accts = await req('GET', '/admin/api/accounts?provider_id=trae', null, tok);
  const al = JSON.parse(accts.body);
  console.log('trae accounts:', JSON.stringify(al.map(a => ({ id: a.id, name: a.name, enabled: a.enabled, status: a.status }))));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
