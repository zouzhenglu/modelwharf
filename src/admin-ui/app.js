/* dsh-free-api admin panel */
'use strict';
let TOKEN = localStorage.getItem('dsh_token') || '';
let PAGE = 'dashboard';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function api(path, opts = {}) {
  const resp = await fetch('/admin/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (resp.status === 401) { showLogin(); throw new Error('unauthorized'); }
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || resp.statusText);
  return json;
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 2600);
}
function fmtTime(ts) { return ts ? new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }) : '-'; }
function badge(text, cls) { return `<span class="badge ${cls}">${esc(text)}</span>`; }
function statusBadge(s) {
  const map = { active: 'green', cooling: 'yellow', invalid: 'red', banned: 'red' };
  return badge(s || 'active', map[s] || 'gray');
}
function switchHtml(on, onclick) { return `<div class="switch ${on ? 'on' : ''}" onclick="${onclick}"></div>`; }

async function doLogin() {
  try {
    const r = await fetch('/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) });
    if (!r.ok) throw new Error('密码错误');
    const j = await r.json();
    TOKEN = j.token; localStorage.setItem('dsh_token', TOKEN);
    boot();
  } catch (e) { toast(e.message, true); }
}

function showLogin() { $('#login').style.display = 'block'; $('#app').style.display = 'none'; }
function boot() {
  $('#login').style.display = 'none'; $('#app').style.display = 'flex';
  document.querySelectorAll('nav a').forEach(a => a.onclick = () => go(a.dataset.page));
  go(PAGE);
}
function go(page) {
  PAGE = page;
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  render(page).catch(e => { toast(e.message, true); if (String(e.message).includes('unauthorized')) showLogin(); });
}

// ---------------- pages ----------------
async function render(page) {
  const m = $('#main');
  if (page === 'dashboard') return renderDashboard(m);
  if (page === 'accounts') return renderAccounts(m);
  if (page === 'models') return renderModels(m);
  if (page === 'apikeys') return renderApikeys(m);
  if (page === 'usage') return renderUsage(m);
  if (page === 'mcp') return renderMcp(m);
  if (page === 'playground') return renderPlayground(m);
  if (page === 'settings') return renderSettings(m);
}

// ---------- dashboard ----------
const VENDOR_GROUPS = [
  { name: '逆向平台（账号池）', ids: ['trae', 'workbuddy', 'qoder', 'qodercn', 'qwen'] },
  { name: '国际官方 API', ids: ['openai', 'anthropic', 'gemini', 'xai', 'openrouter', 'mistral', 'groq', 'together', 'perplexity', 'cerebras', 'github-copilot'] },
  { name: '国内官方 API', ids: ['dashscope', 'zhipu', 'moonshot', 'minimax', 'doubao', 'hunyuan', 'baichuan', 'stepfun', 'siliconflow', 'internvl', 'modelscope'] },
  { name: '本地 / 自定义', ids: ['ollama', 'openai-compat'] },
];
function groupProviders(providers) {
  const byId = Object.fromEntries(providers.map(p => [p.id, p]));
  const grouped = VENDOR_GROUPS.map(g => ({ ...g, providers: g.ids.map(id => byId[id]).filter(Boolean) }));
  const rest = providers.filter(p => !VENDOR_GROUPS.some(g => g.ids.includes(p.id)));
  if (rest.length) grouped.push({ name: '其他', providers: rest });
  return grouped.filter(g => g.providers.length);
}
async function renderDashboard(m) {
  const [stats, providers] = await Promise.all([api('/stats'), api('/providers')]);
  const groups = groupProviders(providers);
  m.innerHTML = `
  <h2>仪表盘</h2>
  <div class="statgrid">
    <div class="stat"><div class="l">今日请求</div><div class="v">${stats.today.reqs}</div></div>
    <div class="stat"><div class="l">今日 Token</div><div class="v">${(stats.today.tin/1000).toFixed(1)}k / ${(stats.today.tout/1000).toFixed(1)}k</div></div>
    <div class="stat"><div class="l">今日积分消耗</div><div class="v">${stats.today.credits.toFixed(2)}</div></div>
    <div class="stat"><div class="l">今日错误</div><div class="v" style="color:${stats.today.errors ? 'var(--red)' : 'var(--green)'}">${stats.today.errors}</div></div>
    <div class="stat"><div class="l">累计请求</div><div class="v">${stats.total.reqs}</div></div>
  </div>
  ${groups.map(g => `
  <div class="card"><h2 style="font-size:14px">${esc(g.name)} <span class="muted">(${g.providers.length})</span></h2>
    <table><tr><th>平台</th><th>状态</th><th>账号</th><th>操作</th></tr>
    ${g.providers.map(p => `<tr>
      <td><b>${esc(p.label)}</b> <span class="muted mono">${esc(p.id)}</span></td>
      <td>${p.enabled ? badge('启用','green') : badge('停用','gray')}</td>
      <td>${p.account_count}</td>
      <td><button class="small ghost" onclick="refreshModels('${p.id}')">同步模型</button>
          ${p.importLocal ? `<button class="small ghost" onclick="importLocal('${p.id}')">导入本机登录</button>` : ''}</td>
    </tr>`).join('')}
    </table>
  </div>`).join('')}
  <p class="muted" style="margin:8px 0 16px">模型为空时：先添加账号 → 点「同步模型」从上游拉取。官方 API 平台添加 key 后模型列表自动带出。</p>
  <div class="card"><h2 style="font-size:14px">今日模型 Top</h2>
    ${stats.byModel.length ? `<table><tr><th>模型</th><th>请求</th><th>输入 tok</th><th>输出 tok</th></tr>
    ${stats.byModel.map(r => `<tr><td class="mono">${esc(r.public_model)}</td><td>${r.reqs}</td><td>${r.tin}</td><td>${r.tout}</td></tr>`).join('')}</table>` : '<p class="muted">暂无数据</p>'}
  </div>`;
}

async function importLocalAll() {
  toast('扫描本机凭证中…');
  try {
    const r = await api('/import-local-all', { method: 'POST' });
    const total = (r || []).reduce((s, x) => s + (x.imported || 0), 0);
    const lines = (r || []).flatMap(x => (x.results || []).map(y =>
      y.imported ? `✓ ${x.provider}: ${y.label} → 账号「${y.name}」` : `• ${x.provider}: ${y.reason || y.label}`));
    openModal(total ? `✓ 新导入 ${total} 个账号` : '扫描完成', `
      ${lines.length ? `<div class="field" style="font-size:13px;line-height:2">${lines.map(esc).join('<br>')}</div>` : '<p class="muted">本机未发现任何平台凭证（是否安装并登录过 Trae / WorkBuddy / Qoder？）</p>'}
      <div class="row"><span class="spacer"></span><button onclick="closeModal();go('accounts')">好的</button></div>`, {});
  } catch (e) { toast(e.message, true); }
}

async function refreshModels(pid) {
  try { const r = await api(`/providers/${pid}/refresh-models`, { method: 'POST' });
    toast(`同步完成：新增 ${r.added} 个模型${r.errors?.length ? '，错误: ' + r.errors.join('; ') : ''}`);
    go(PAGE === 'accounts' ? 'accounts' : 'dashboard');
  } catch (e) { toast(e.message, true); }
}
async function importLocal(pid) {
  try { const r = await api(`/providers/${pid}/import-local`, { method: 'POST', body: {} });
    const found = (r.found || []).filter(f => f.credentials);
    if (!found.length) {
      const notes = (r.found || []).map(f => f.label).join('；');
      return toast(notes ? '本机有凭证但无法直接导入：' + notes : '未在本机找到该平台的登录凭证（是否安装并登录过？）', true);
    }
    openModal(`发现 ${found.length} 个本机账号`, `
      ${found.map((f, i) => `<div class="field"><label>${esc(f.label || f.name || ('账号' + (i + 1)))}</label><input id="impname${i}" value="${esc(f.suggestName || f.name || '')}"></div>`).join('')}
      <div class="row"><span class="spacer"></span><button class="ghost" onclick="closeModal()">取消</button>
      <button onclick="doImportLocal('${pid}')">全部导入</button></div>`, { found });
  } catch (e) { toast(e.message, true); }
}
async function doImportLocal(pid) {
  const found = window._modalCtx.found;
  const names = found.map((f, i) => $('#impname' + i).value || f.suggestName || ('local-' + (i + 1)));
  try {
    const r = await api(`/providers/${pid}/import-local`, { method: 'POST', body: { import: true, names } });
    closeModal(); toast(`已导入 ${r.imported ?? found.length} 个账号`); go('accounts');
  } catch (e) { toast(e.message, true); }
}

// ---------- accounts ----------
let acctFilter = { provider_id: '', search: '', status: '', enabled: '' };
async function renderAccounts(m) {
  const [providers, accounts] = await Promise.all([
    api('/providers'),
    api('/accounts?' + new URLSearchParams(Object.fromEntries(Object.entries(acctFilter).filter(([, v]) => v)))),
  ]);
  m.innerHTML = `
  <h2>平台账号 <span class="muted">(${accounts.length})</span></h2>
  <div class="toolbar">
    <select id="fProvider" style="width:150px"><option value="">全部平台</option>${providers.map(p => `<option value="${p.id}" ${acctFilter.provider_id === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
    <input id="fSearch" class="searchbox" placeholder="搜索名称/信息…" value="${esc(acctFilter.search)}">
    <select id="fStatus" style="width:110px"><option value="">全部状态</option>
      ${['active','cooling','invalid','banned'].map(s => `<option ${acctFilter.status === s ? 'selected' : ''} value="${s}">${s}</option>`).join('')}</select>
    <select id="fEnabled" style="width:100px"><option value="">启用+停用</option><option value="1" ${acctFilter.enabled === '1' ? 'selected' : ''}>仅启用</option><option value="0" ${acctFilter.enabled === '0' ? 'selected' : ''}>仅停用</option></select>
    <span class="spacer"></span>
    <button class="ghost" onclick="importLocalAll()">扫描本机登录</button>
    <button onclick="openAccountForm()">+ 添加账号</button>
  </div>
  <div class="card" style="padding:6px 12px">
  <table><tr><th>平台</th><th>名称</th><th>状态</th><th>积分/信息</th><th>优先级</th><th>并发</th><th>最近使用</th><th>启用</th><th>操作</th></tr>
  ${accounts.map(a => `<tr>
    <td>${esc(a.provider_id)}</td>
    <td><b>${esc(a.name)}</b></td>
    <td>${statusBadge(a.status)}${a.status_message ? `<div class="muted" style="max-width:200px">${esc(a.status_message)}</div>` : ''}</td>
    <td class="muted">${esc(summarizeExtra(a.extra))}</td>
    <td>${a.priority}</td><td>${a.max_concurrency}</td>
    <td class="muted">${fmtTime(a.last_used_at)}</td>
    <td>${switchHtml(a.enabled, `toggleAccount(${a.id}, ${a.enabled ? 0 : 1})`)}</td>
    <td>
      <button class="small ghost" onclick="checkAccount(${a.id})">检查</button>
      <button class="small ghost" onclick="openAccountForm(${a.id})">编辑</button>
      <button class="small danger" onclick="delAccount(${a.id})">删</button>
    </td></tr>`).join('')}
  ${!accounts.length ? '<tr><td colspan="9" class="muted" style="text-align:center;padding:24px">暂无账号，点右上角添加，或用「导入本机登录」自动发现</td></tr>' : ''}
  </table></div>`;
  $('#fProvider').onchange = e => { acctFilter.provider_id = e.target.value; renderAccounts(m); };
  $('#fStatus').onchange = e => { acctFilter.status = e.target.value; renderAccounts(m); };
  $('#fEnabled').onchange = e => { acctFilter.enabled = e.target.value; renderAccounts(m); };
  $('#fSearch').onkeydown = e => { if (e.key === 'Enter') { acctFilter.search = e.target.value; renderAccounts(m); } };
}
function summarizeExtra(extra) {
  if (!extra || typeof extra !== 'object') return '';
  const bits = [];
  if (extra.credits != null) bits.push(`积分 ${extra.credits}`);
  if (extra.plan) bits.push(extra.plan);
  if (extra.email) bits.push(extra.email);
  if (extra.quota != null) bits.push(`配额 ${extra.quota}`);
  return bits.join(' · ');
}
async function toggleAccount(id, enabled) { await api('/accounts/' + id, { method: 'PUT', body: { enabled } }); renderAccounts($('#main')); }
async function delAccount(id) { if (!confirm('确定删除该账号？')) return; await api('/accounts/' + id, { method: 'DELETE' }); renderAccounts($('#main')); }
async function checkAccount(id) {
  toast('检查中…');
  try { const r = await api('/accounts/' + id + '/check', { method: 'POST' });
    toast(r.ok ? '✓ 账号有效' + (r.message ? '：' + r.message : '') : '✗ ' + (r.message || '无效'), !r.ok);
    renderAccounts($('#main'));
  } catch (e) { toast(e.message, true); }
}

async function openAccountForm(id) {
  const providers = await api('/providers');
  let acct = null;
  if (id) acct = (await api('/accounts')).find(a => a.id === id);
  const selProvider = acct ? acct.provider_id : providers[0]?.id;
  const p = providers.find(x => x.id === selProvider);
  mFormAccount(acct, providers, p);
}
function mFormAccount(acct, providers, p) {
  openModal(acct ? '编辑账号' : '添加账号', `
    <div class="field"><label>平台</label>
      <select id="afProvider" ${acct ? 'disabled' : ''}>${providers.map(x => `<option value="${x.id}" ${p?.id === x.id ? 'selected' : ''}>${esc(x.label)} (${x.id})</option>`).join('')}</select></div>
    <div class="field"><label>名称（用于区分多账号）</label><input id="afName" value="${esc(acct?.name || '')}" placeholder="如 main / 小号1"></div>
    <div id="afCreds">${credFieldsHtml(p, acct)}</div>
    <div class="row" style="margin-top:4px">
      <div class="field" style="width:140px"><label>优先级(小=优先)</label><input id="afPriority" type="number" value="${acct?.priority ?? 100}"></div>
      <div class="field" style="width:140px"><label>最大并发</label><input id="afConcurrency" type="number" value="${acct?.max_concurrency ?? 3}"></div>
    </div>
    <p class="muted" style="margin-bottom:10px">${esc(p?.docs || '')}</p>
    <div class="row"><span class="spacer"></span>
      <button class="ghost" onclick="closeModal()">取消</button>
      <button onclick="saveAccount(${acct?.id || 'null'})">保存</button></div>`, {});
  $('#afProvider')?.addEventListener('change', e => {
    const np = providers.find(x => x.id === e.target.value);
    $('#afCreds').innerHTML = credFieldsHtml(np, null);
    const d = $('#afDocs'); if (d) d.textContent = np?.docs || '';
  });
}
function credFieldsHtml(p, acct) {
  const creds = acct?.credentials || {};
  return (p?.credFields || [{ name: 'token', label: 'Token', required: true, secret: true }]).map(f => `
    <div class="field"><label>${esc(f.label)}${f.required ? ' *' : ''}</label>
      <input id="cf_${f.name}" type="${f.secret ? 'password' : 'text'}" placeholder="${esc(f.placeholder || '')}" value="${esc(creds[f.name] || '')}" autocomplete="off"></div>`).join('');
}
async function saveAccount(id) {
  const provider_id = $('#afProvider').value;
  const providers = await api('/providers');
  const p = providers.find(x => x.id === provider_id);
  const fields = p?.credFields || [{ name: 'token' }];
  const credentials = {};
  for (const f of fields) { const v = $('#cf_' + f.name)?.value?.trim(); if (v) credentials[f.name] = v; }
  const body = {
    provider_id, name: $('#afName').value.trim(), credentials,
    priority: Number($('#afPriority').value || 100), max_concurrency: Number($('#afConcurrency').value || 3),
  };
  try {
    if (id) await api('/accounts/' + id, { method: 'PUT', body });
    else await api('/accounts', { method: 'POST', body });
    closeModal(); toast('已保存'); go('accounts');
  } catch (e) { toast(e.message, true); }
}

// ---------- models ----------
let modelFilter = { provider_id: '', search: '', enabled: '', tag: '' };
async function renderModels(m) {
  const [providers, models] = await Promise.all([
    api('/providers'),
    api('/models?' + new URLSearchParams(Object.fromEntries(Object.entries(modelFilter).filter(([, v]) => v)))),
  ]);
  m.innerHTML = `
  <h2>模型管理 <span class="muted">(${models.length})</span></h2>
  <div class="toolbar">
    <select id="mfProvider" style="width:150px"><option value="">全部平台</option>${providers.map(p => `<option value="${p.id}" ${modelFilter.provider_id === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
    <input id="mfSearch" class="searchbox" placeholder="搜索模型名/标签…" value="${esc(modelFilter.search)}">
    <select id="mfEnabled" style="width:100px"><option value="">全部</option><option value="1" ${modelFilter.enabled === '1' ? 'selected' : ''}>仅启用</option><option value="0" ${modelFilter.enabled === '0' ? 'selected' : ''}>仅停用</option></select>
    <input id="mfTag" style="width:110px" placeholder="标签筛选" value="${esc(modelFilter.tag)}">
    <span class="spacer"></span>
    ${providers.map(p => `<button class="small ghost" onclick="refreshModels('${p.id}')">同步${esc(p.label)}模型</button>`).join('')}
    <button onclick="openModelForm()">+ 手动添加</button>
  </div>
  <div class="card" style="padding:6px 12px">
  <table><tr><th>对外名称</th><th>平台</th><th>上游模型</th><th>倍率</th><th>免费</th><th>可用账号</th><th>标签</th><th>启用</th><th>操作</th></tr>
  ${models.map(md => `<tr>
    <td class="mono"><b>${esc(md.public_name)}</b>${md.note ? `<div class="muted">${esc(md.note)}</div>` : ''}</td>
    <td>${esc(md.provider_id)}</td>
    <td class="mono muted">${esc(md.upstream_model)}</td>
    <td>${md.multiplier}x</td>
    <td>${md.is_free ? badge('免费', 'green') : badge('计费', 'gray')}</td>
    <td>${md.account_count}</td>
    <td class="muted">${esc(md.tags || '')}</td>
    <td>${switchHtml(md.enabled, `toggleModel(${md.id})`)}</td>
    <td><button class="small ghost" onclick="openModelForm(${md.id})">编辑</button>
        <button class="small danger" onclick="delModel(${md.id})">删</button></td>
  </tr>`).join('')}
  ${!models.length ? '<tr><td colspan="9" class="muted" style="text-align:center;padding:24px">暂无模型 — 添加账号后点「同步模型」，或手动添加（可用于本地/官方 API）</td></tr>' : ''}
  </table></div>`;
  $('#mfProvider').onchange = e => { modelFilter.provider_id = e.target.value; renderModels(m); };
  $('#mfEnabled').onchange = e => { modelFilter.enabled = e.target.value; renderModels(m); };
  $('#mfSearch').onkeydown = e => { if (e.key === 'Enter') { modelFilter.search = e.target.value; renderModels(m); } };
  $('#mfTag').onkeydown = e => { if (e.key === 'Enter') { modelFilter.tag = e.target.value; renderModels(m); } };
}
async function toggleModel(id) { await api('/models/' + id + '/toggle', { method: 'POST' }); renderModels($('#main')); }
async function delModel(id) { if (!confirm('删除该模型映射？')) return; await api('/models/' + id, { method: 'DELETE' }); renderModels($('#main')); }
async function openModelForm(id) {
  const [providers, models] = [await api('/providers'), await api('/models?size=1000')];
  const md = id ? models.find(x => x.id === id) : null;
  openModal(md ? '编辑模型' : '添加模型', `
    <div class="field"><label>平台</label><select id="mfProviderSel" ${md ? 'disabled' : ''}>${providers.map(p => `<option value="${p.id}" ${md?.provider_id === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>
    <div class="field"><label>上游模型名（平台真实模型 id）</label><input id="mfUpstream" value="${esc(md?.upstream_model || '')}" placeholder="如 glm-5.2"></div>
    <div class="field"><label>对外名称（客户端填的 model）</label><input id="mfPublic" value="${esc(md?.public_name || '')}" placeholder="如 glm-5.2 或别名 my-model"></div>
    <div class="row">
      <div class="field" style="width:120px"><label>倍率</label><input id="mfMultiplier" type="number" step="0.1" value="${md?.multiplier ?? 1}"></div>
      <div class="field" style="width:120px"><label>上下文窗口</label><input id="mfCtx" type="number" value="${md?.ctx_window || ''}" placeholder="可选"></div>
      <div class="field" style="width:150px"><label>免费</label><select id="mfFree"><option value="0" ${!md?.is_free ? 'selected' : ''}>计费</option><option value="1" ${md?.is_free ? 'selected' : ''}>免费</option></select></div>
    </div>
    <div class="field"><label>标签（逗号分隔，用于筛选）</label><input id="mfTags" value="${esc(md?.tags || '')}" placeholder="如 free,coding"></div>
    <div class="field"><label>备注</label><input id="mfNote" value="${esc(md?.note || '')}"></div>
    <div class="row"><span class="spacer"></span><button class="ghost" onclick="closeModal()">取消</button>
    <button onclick="saveModel(${id || 'null'})">保存</button></div>`, {});
}
async function saveModel(id) {
  const body = {
    provider_id: $('#mfProviderSel').value, upstream_model: $('#mfUpstream').value.trim(), public_name: $('#mfPublic').value.trim(),
    multiplier: Number($('#mfMultiplier').value || 1), ctx_window: Number($('#mfCtx').value) || null,
    is_free: Number($('#mfFree').value), tags: $('#mfTags').value, note: $('#mfNote').value,
  };
  try {
    if (id) await api('/models/' + id, { method: 'PUT', body }); else await api('/models', { method: 'POST', body });
    closeModal(); toast('已保存'); go('models');
  } catch (e) { toast(e.message, true); }
}

// ---------- apikeys ----------
let keySearch = '';
async function renderApikeys(m) {
  const keys = await api('/apikeys?' + (keySearch ? 'search=' + encodeURIComponent(keySearch) : ''));
  m.innerHTML = `
  <h2>API Keys <span class="muted">(${keys.length})</span> <span class="muted" style="font-size:12px">— harness 工具用这些 key 调用本网关</span></h2>
  <div class="toolbar">
    <input id="kSearch" class="searchbox" placeholder="搜索…" value="${esc(keySearch)}">
    <span class="spacer"></span><button onclick="openKeyForm()">+ 生成 Key</button>
  </div>
  <div class="card" style="padding:6px 12px">
  <table><tr><th>名称</th><th>Key</th><th>允许模型</th><th>RPM</th><th>日限(积分)</th><th>最近使用</th><th>启用</th><th>操作</th></tr>
  ${keys.map(k => `<tr>
    <td><b>${esc(k.name || '(未命名)')}</b></td>
    <td class="mono muted">${esc(k.key)}</td>
    <td class="mono" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(k.allowed_models)}</td>
    <td>${k.rpm_limit || '∞'}</td><td>${k.daily_limit || '∞'}</td>
    <td class="muted">${fmtTime(k.last_used_at)}</td>
    <td>${switchHtml(k.enabled, `toggleKey(${k.id}, ${k.enabled ? 0 : 1})`)}</td>
    <td><button class="small ghost" onclick="openKeyForm(${k.id})">编辑</button>
        <button class="small danger" onclick="delKey(${k.id})">删</button></td>
  </tr>`).join('')}
  ${!keys.length ? '<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">暂无 key — 不创建任何 key 时网关为开放模式（仅建议本机使用）</td></tr>' : ''}
  </table></div>`;
  $('#kSearch').onkeydown = e => { if (e.key === 'Enter') { keySearch = e.target.value; renderApikeys(m); } };
}
async function toggleKey(id, enabled) { await api('/apikeys/' + id, { method: 'PUT', body: { enabled } }); renderApikeys($('#main')); }
async function delKey(id) { if (!confirm('删除该 key？使用它的客户端将立即 401。')) return; await api('/apikeys/' + id, { method: 'DELETE' }); renderApikeys($('#main')); }
async function openKeyForm(id) {
  const keys = await api('/apikeys');
  const k = id ? keys.find(x => x.id === id) : null;
  const models = await api('/models');
  openModal(k ? '编辑 Key' : '生成 Key', `
    <div class="field"><label>名称</label><input id="kfName" value="${esc(k?.name || '')}" placeholder="如 my-trae-client"></div>
    <div class="field"><label>允许的模型（* = 全部；逗号分隔模型名）</label>
      <input id="kfModels" list="modelList" value="${esc(k?.allowed_models || '*')}">
      <datalist id="modelList">${models.map(md => `<option value="${esc(md.public_name)}">`).join('')}</datalist></div>
    <div class="row">
      <div class="field" style="width:130px"><label>RPM 限制(0=∞)</label><input id="kfRpm" type="number" value="${k?.rpm_limit ?? 0}"></div>
      <div class="field" style="width:150px"><label>日限积分(0=∞)</label><input id="kfDaily" type="number" value="${k?.daily_limit ?? 0}"></div>
    </div>
    <div class="row"><span class="spacer"></span><button class="ghost" onclick="closeModal()">取消</button>
    <button onclick="saveKey(${id || 'null'})">保存</button></div>`, {});
  if (!id) {
    const r = await api('/apikeys', { method: 'POST', body: { name: '(生成中)' } });
    window._pendingKey = r.key; window._pendingKeyId = r.id;
  }
}
async function saveKey(id) {
  const body = { name: $('#kfName').value, allowed_models: $('#kfModels').value, rpm_limit: Number($('#kfRpm').value), daily_limit: Number($('#kfDaily').value) };
  try {
    if (!id && window._pendingKeyId) { await api('/apikeys/' + window._pendingKeyId, { method: 'PUT', body }); closeModal(); showKeyOnce(window._pendingKey); window._pendingKey = null; }
    else { await api('/apikeys/' + id, { method: 'PUT', body }); closeModal(); toast('已保存'); }
    go('apikeys');
  } catch (e) { toast(e.message, true); }
}
function showKeyOnce(key) {
  openModal('✅ Key 已生成（仅显示一次）', `
    <p style="margin-bottom:8px">请立即复制保存：</p>
    <pre class="mono" id="keyShow">${esc(key)}</pre>
    <div class="row" style="margin-top:12px"><span class="spacer"></span>
    <button onclick="navigator.clipboard.writeText('${key}');toast('已复制')">复制</button>
    <button onclick="closeModal()">完成</button></div>`, {});
}

// ---------- usage ----------
let usageFilter = { provider_id: '', model: '', status: '', page: 1 };
async function renderUsage(m) {
  const [providers, usage] = await Promise.all([
    api('/providers'),
    api('/usage?' + new URLSearchParams(Object.fromEntries(Object.entries({ ...usageFilter }).filter(([, v]) => v)))),
  ]);
  m.innerHTML = `
  <h2>用量日志</h2>
  <div class="toolbar">
    <select id="uProvider" style="width:150px"><option value="">全部平台</option>${providers.map(p => `<option value="${p.id}" ${usageFilter.provider_id === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
    <input id="uModel" class="searchbox" placeholder="模型名…" value="${esc(usageFilter.model)}">
    <select id="uStatus" style="width:110px"><option value="">全部</option><option value="ok" ${usageFilter.status === 'ok' ? 'selected' : ''}>成功</option><option value="error" ${usageFilter.status === 'error' ? 'selected' : ''}>失败</option></select>
  </div>
  <div class="card" style="padding:6px 12px">
  <table><tr><th>时间</th><th>平台</th><th>账号</th><th>模型</th><th>输入</th><th>输出</th><th>积分</th><th>耗时</th><th>状态</th></tr>
  ${usage.rows.map(u => `<tr>
    <td class="muted mono">${fmtTime(u.ts)}</td><td>${esc(u.provider_id || '')}</td><td>#${u.account_id ?? '-'}</td>
    <td class="mono">${esc(u.public_model || '')}</td><td>${u.input_tokens}</td><td>${u.output_tokens}</td>
    <td>${u.credits ? u.credits.toFixed(3) : '-'}</td><td>${u.latency_ms}ms</td>
    <td>${u.status < 400 ? badge(u.status, 'green') : badge(u.status + (u.error ? ' ' + u.error.slice(0, 40) : ''), 'red')}</td>
  </tr>`).join('')}
  ${!usage.rows.length ? '<tr><td colspan="9" class="muted" style="text-align:center;padding:24px">暂无请求</td></tr>' : ''}
  </table>
  <div class="pager">共 ${usage.total} 条
    <button class="small ghost" ${usageFilter.page <= 1 ? 'disabled' : ''} onclick="usageFilter.page--;renderUsage($('#main'))">上一页</button>
    <button class="small ghost" ${usageFilter.page * usage.size >= usage.total ? 'disabled' : ''} onclick="usageFilter.page++;renderUsage($('#main'))">下一页</button>
  </div></div>`;
  $('#uProvider').onchange = e => { usageFilter.provider_id = e.target.value; usageFilter.page = 1; renderUsage(m); };
  $('#uStatus').onchange = e => { usageFilter.status = e.target.value; usageFilter.page = 1; renderUsage(m); };
  $('#uModel').onkeydown = e => { if (e.key === 'Enter') { usageFilter.model = e.target.value; usageFilter.page = 1; renderUsage(m); } };
}

// ---------- mcp ----------
async function renderMcp(m) {
  const servers = await api('/mcp');
  m.innerHTML = `
  <h2>MCP 服务 <span class="muted">(${servers.length})</span></h2>
  <p class="muted" style="margin-bottom:12px">客户端 MCP 配置：JSON-RPC over HTTP，端点 <span class="mono badge blue">http://localhost:8317/mcp</span>。添加的 MCP 服务器的工具会聚合在此端点暴露（工具名 <span class="mono">服务id__工具名</span>）。</p>
  <div class="toolbar"><span class="spacer"></span><button onclick="openMcpForm()">+ 添加 MCP 服务</button></div>
  <div class="card" style="padding:6px 12px">
  <table><tr><th>ID</th><th>传输</th><th>目标</th><th>工具过滤</th><th>启用</th><th>操作</th></tr>
  ${servers.map(s => `<tr>
    <td class="mono"><b>${esc(s.id)}</b></td>
    <td>${badge(s.transport, s.transport === 'stdio' ? 'purple' : 'blue')}</td>
    <td class="mono muted" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(s.transport === 'stdio' ? s.command + ' ' + (s.args || []).join(' ') : s.url)}</td>
    <td class="mono">${esc(s.tool_filter)}</td>
    <td>${switchHtml(s.enabled, `toggleMcp('${esc(s.id)}', ${s.enabled ? 0 : 1})`)}</td>
    <td><button class="small ghost" onclick="listMcpTools('${esc(s.id)}')">列出工具</button>
        <button class="small ghost" onclick="openMcpForm('${esc(s.id)}')">编辑</button>
        <button class="small danger" onclick="delMcp('${esc(s.id)}')">删</button></td>
  </tr>`).join('')}
  ${!servers.length ? '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">暂无 MCP 服务 — 可接入本地 npx 服务器或远程 http MCP</td></tr>' : ''}
  </table></div>`;
}
async function toggleMcp(id, enabled) { await api('/mcp/' + encodeURIComponent(id), { method: 'PUT', body: { enabled } }); renderMcp($('#main')); }
async function delMcp(id) { if (!confirm('删除该 MCP 服务？')) return; await api('/mcp/' + encodeURIComponent(id), { method: 'DELETE' }); renderMcp($('#main')); }
async function listMcpTools(id) {
  toast('连接中…');
  try { const r = await api('/mcp/' + encodeURIComponent(id) + '/tools', { method: 'POST' });
    openModal(`工具列表 — ${id}`, r.tools?.length ? `<table><tr><th>工具</th><th>说明</th></tr>${r.tools.map(t => `<tr><td class="mono">${esc(t.name)}</td><td class="muted">${esc(t.description || '')}</td></tr>`).join('')}</table>` : '<p class="muted">无工具或连接失败</p>', {});
  } catch (e) { toast('连接失败: ' + e.message, true); }
}
async function openMcpForm(id) {
  const servers = await api('/mcp');
  const s = id ? servers.find(x => x.id === id) : null;
  openModal(s ? '编辑 MCP 服务' : '添加 MCP 服务', `
    <div class="field"><label>ID（工具名前缀）</label><input id="mcId" value="${esc(s?.id || '')}" ${s ? 'disabled' : ''} placeholder="如 filesystem"></div>
    <div class="field"><label>传输方式</label><select id="mcTransport"><option value="stdio" ${s?.transport === 'stdio' ? 'selected' : ''}>stdio（本地命令）</option><option value="http" ${s?.transport === 'http' ? 'selected' : ''}>http（远程 URL）</option></select></div>
    <div id="mcStdio">
      <div class="field"><label>命令</label><input id="mcCommand" value="${esc(s?.command || '')}" placeholder="如 npx"></div>
      <div class="field"><label>参数（JSON 数组）</label><input id="mcArgs" value="${esc(JSON.stringify(s?.args || []))}" placeholder='["-y","@modelcontextprotocol/server-filesystem","/tmp"]'></div>
    </div>
    <div id="mcHttp" style="display:none">
      <div class="field"><label>URL</label><input id="mcUrl" value="${esc(s?.url || '')}" placeholder="https://…/mcp"></div>
      <div class="field"><label>Headers（JSON）</label><input id="mcHeaders" value="${esc(JSON.stringify(s?.headers || {}))}"></div>
    </div>
    <div class="field"><label>工具过滤（* 或逗号分隔工具名）</label><input id="mcFilter" value="${esc(s?.tool_filter || '*')}"></div>
    <div class="row"><span class="spacer"></span><button class="ghost" onclick="closeModal()">取消</button>
    <button onclick="saveMcp('${esc(id || '')}')">保存</button></div>`, {});
  $('#mcTransport').onchange = e => { $('#mcStdio').style.display = e.target.value === 'stdio' ? '' : 'none'; $('#mcHttp').style.display = e.target.value === 'http' ? '' : 'none'; };
}
async function saveMcp(id) {
  const body = {
    id: $('#mcId').value.trim(), transport: $('#mcTransport').value,
    command: $('#mcCommand').value, args: JSON.parse($('#mcArgs').value || '[]'),
    url: $('#mcUrl').value, headers: JSON.parse($('#mcHeaders').value || '{}'),
    tool_filter: $('#mcFilter').value || '*',
  };
  try {
    if (id) await api('/mcp/' + encodeURIComponent(id), { method: 'PUT', body });
    else await api('/mcp', { method: 'POST', body });
    closeModal(); toast('已保存'); go('mcp');
  } catch (e) { toast(e.message, true); }
}

// ---------- playground ----------
async function renderPlayground(m) {
  const models = await api('/models');
  m.innerHTML = `
  <h2>测试台</h2>
  <div class="card">
    <div class="row" style="margin-bottom:10px">
      <select id="pgModel" style="width:260px">${models.filter(md => md.enabled).map(md => `<option value="${esc(md.public_name)}">${esc(md.public_name)} (${md.provider_id}${md.is_free ? ' · 免费' : ''})</option>`).join('')}</select>
      <label class="row" style="gap:4px;font-size:13px"><input type="checkbox" id="pgStream" style="width:auto"> 流式</label>
      <span class="spacer"></span><button id="pgSend" onclick="pgSend()">发送</button>
    </div>
    <textarea id="pgPrompt" rows="4" placeholder="输入测试消息…">你好，请用一句话介绍你自己。</textarea>
    <div id="pgOut" style="margin-top:12px"></div>
  </div>`;
}
let pgBusy = false;
async function pgSend() {
  if (pgBusy) return;
  const model = $('#pgModel').value;
  const prompt = $('#pgPrompt').value.trim();
  if (!model || !prompt) return toast('请选择模型并输入内容', true);
  const out = $('#pgOut'); const sendBtn = $('#pgSend');
  pgBusy = true; sendBtn.disabled = true;
  const t0 = performance.now();
  try {
    if ($('#pgStream').checked) {
      out.innerHTML = '<pre class="mono" id="pgPre"></pre>';
      const pre = $('#pgPre');
      const resp = await fetch('/admin/api/test/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true }) });
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const j = JSON.parse(line);
            if (j.raw) { try { const ev = JSON.parse(j.raw); const d = ev.choices?.[0]?.delta; if (d?.content) pre.textContent += d.content; } catch {} }
            if (j.done) pre.textContent += `\n\n[完成 ${(performance.now() - t0).toFixed(0)}ms · in ${j.usage?.input_tokens || 0} / out ${j.usage?.output_tokens || 0} tok · 积分 ${(j.usage?.credits || 0).toFixed(3)}]`;
            if (j.error) pre.textContent += '\n[错误] ' + j.error;
          } catch {}
        }
      }
    } else {
      out.innerHTML = '<p class="muted">请求中…</p>';
      const r = await api('/test/chat', { method: 'POST', body: { model, messages: [{ role: 'user', content: prompt }] } });
      if (r.ok) out.innerHTML = `<pre class="mono">${esc(r.text)}</pre><p class="muted" style="margin-top:6px">${r.latency_ms}ms · in ${r.usage.input_tokens} / out ${r.usage.output_tokens} tok · 积分 ${(r.usage.credits || 0).toFixed(3)}</p>`;
      else out.innerHTML = `<pre style="color:var(--red)">${esc(r.error)}${r.status ? ' (HTTP ' + r.status + ')' : ''}</pre>`;
    }
  } catch (e) { out.innerHTML = `<pre style="color:var(--red)">${esc(e.message)}</pre>`; }
  pgBusy = false; sendBtn.disabled = false;
}

// ---------- settings ----------
async function renderSettings(m) {
  const s = await api('/settings');
  m.innerHTML = `
  <h2>设置</h2>
  <div class="card">
    <h3 style="font-size:14px;margin-bottom:10px">修改管理密码</h3>
    <div class="row" style="max-width:400px">
      <input type="password" id="stPw" placeholder="新密码">
      <button onclick="savePw()">保存</button>
    </div>
  </div>
  <div class="card">
    <h3 style="font-size:14px;margin-bottom:10px">接入信息</h3>
    <div class="kv">
      <span class="muted">OpenAI 端点</span><span class="mono">http://localhost:8317/v1/chat/completions</span>
      <span class="muted">Anthropic 端点</span><span class="mono">http://localhost:8317/v1/messages</span>
      <span class="muted">模型列表</span><span class="mono">http://localhost:8317/v1/models</span>
      <span class="muted">MCP 端点</span><span class="mono">http://localhost:8317/mcp</span>
      <span class="muted">网关状态</span><span>${s.gatewayOpen ? badge('开放模式（未设置任何 key）','yellow') : badge('需要 API Key','green')}</span>
    </div>
    <p class="muted" style="margin-top:8px">环境变量：DSH_PORT / DSH_ADMIN_PASSWORD / DSH_API_KEYS（逗号分隔）/ DSH_DATA_DIR</p>
  </div>
  <div class="card">
    <h3 style="font-size:14px;margin-bottom:10px">最近日志</h3>
    <pre id="logPre" style="max-height:300px">加载中…</pre>
    <button class="small ghost" style="margin-top:8px" onclick="loadLogs()">刷新</button>
  </div>`;
  loadLogs();
}
async function loadLogs() {
  const r = await api('/logs?size=120');
  $('#logPre').textContent = r.lines.join('\n') || '(空)';
  $('#logPre').scrollTop = $('#logPre').scrollHeight;
}
async function savePw() {
  try { await api('/settings', { method: 'PUT', body: { adminPassword: $('#stPw').value } }); toast('已保存，下次登录生效'); }
  catch (e) { toast(e.message, true); }
}

// ---------------- modal ----------------
function openModal(title, html, ctx) {
  closeModal();
  const d = document.createElement('dialog');
  d.id = 'modal';
  d.innerHTML = `<h3>${esc(title)}</h3>${html}`;
  document.body.appendChild(d);
  window._modalCtx = ctx || {};
  d.showModal();
}
function closeModal() { document.getElementById('modal')?.remove(); window._modalCtx = null; }

// ---------------- init ----------------
(async function init() {
  if (!TOKEN) return showLogin();
  try { await api('/me'); boot(); }
  catch { showLogin(); }
})();
