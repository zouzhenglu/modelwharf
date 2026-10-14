'use strict';
const http = require('http');
function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
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
  // 1) check trae account validity
  const chk = await req('POST', '/admin/api/accounts/5/check', null, tok);
  console.log('account check:', chk.status, chk.body.slice(0, 300));
  const chkJson = JSON.parse(chk.body);
  if (!chkJson.ok) { console.log('ACCOUNT INVALID — cannot refresh from upstream. Stopping.'); process.exit(0); }
  // 2) refresh catalog from upstream (reset-online-models): sets free/multiplier/ctx/tags correctly
  const reset = await req('POST', '/admin/api/providers/trae/reset-online-models', null, tok);
  console.log('reset-online-models:', reset.status, reset.body.slice(0, 400));
  // 3) summarize params
  const models = await req('GET', '/admin/api/models?provider_id=trae', null, tok);
  const arr = JSON.parse(models.body);
  console.log('trae models after refresh =', arr.length);
  console.log('free count:', arr.filter(m => m.is_free).length, '| multiplier distribution:', JSON.stringify(dist(arr.map(m => m.multiplier))));
  console.log('max_output set:', arr.filter(m => m.max_output).length, '/', arr.length);
  console.log('ctx_window set:', arr.filter(m => m.ctx_window).length, '/', arr.length);
  console.log('sample:', arr.slice(0, 6).map(m => `${m.public_name}(free=${m.is_free},mult=${m.multiplier},ctx=${m.ctx_window},tags=${m.tags})`).join('\n  '));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
function dist(xs){ const m={}; for(const x of xs) m[x]=(m[x]||0)+1; return m; }
