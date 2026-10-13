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
  if (page === 'platforms') return renderPlatforms(m);
  if (page === 'accounts') return renderAccounts(m);
  if (page === 'models') return renderModels(m);
  if (page === 'virtual') return renderVirtual(m);
  if (page === 'apikeys') return renderApikeys(m);
  if (page === 'usage') return renderUsage(m);
  if (page === 'mcp') return renderMcp(m);
  if (page === 'playground') return renderPlayground(m);
  if (page === 'settings') return renderSettings(m);
}

// ---------- platforms page (平台列表：每平台 获取全部模型/恢复在线模型) ----------
async function renderPlatforms(m) {
  const providers = await api('/providers');
  const groups = groupProviders(providers);
  const supportsOnline = p => ['workbuddy', 'trae', 'qwen'].includes(p.id);
  m.innerHTML = `
  <h2>平台 <span class="muted">(${providers.length})</span></h2>
  <p class="muted" style="margin-bottom:12px">
    <b>获取全部模型</b>：把上游报给该账号的模型同步进来（增量补充，最全）。　
    <b>恢复在线模型</b>：只保留上游<b>当前实际可用</b>的目录（与官方客户端一致，会替换现有列表；trae/workbuddy/qwen 支持）。
  </p>
  ${groups.map(g => `
  <div class="card"><h2 style="font-size:14px">${esc(g.name)} <span class="muted">(${g.providers.length})</span></h2>
    <table><tr><th>平台</th><th>状态</th><th>账号</th><th>模型</th><th>操作</th></tr>
    ${g.providers.map(p => `<tr>
      <td><b>${esc(p.label)}</b> <span class="muted mono">${esc(p.id)}</span></td>
      <td>${p.enabled ? badge('启用','green') : badge('停用','gray')}</td>
      <td>${p.account_count}</td>
      <td class="muted">${p.model_count ?? '-'}</td>
      <td>
        <button class="small ghost" onclick="refreshModels('${p.id}')">获取全部模型</button>
        ${supportsOnline(p) ? `<button class="small ghost" onclick="resetOnlineModels('${p.id}')">恢复在线模型</button>` : ''}
      </td>
    </tr>`).join('')}
    </table>
  </div>`).join('')}`;
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
  const [stats, chart] = await Promise.all([api('/stats'), api('/usage/chart?hours=24')]);
  const maxReqs = Math.max(1, ...chart.series.map(s => s.reqs));
  m.innerHTML = `
  <h2>仪表盘</h2>
  <div class="statgrid">
    <div class="stat"><div class="l">今日请求</div><div class="v">${stats.today.reqs}</div><div class="l" style="color:${stats.today.errors ? 'var(--red)' : 'var(--green)'}">失败 ${stats.today.errors}</div></div>
    <div class="stat"><div class="l">今日 Token</div><div class="v">${(stats.today.tin/1000).toFixed(1)}k / ${(stats.today.tout/1000).toFixed(1)}k</div><div class="l">输入 / 输出</div></div>
    <div class="stat"><div class="l">今日积分消耗</div><div class="v">${stats.today.credits.toFixed(2)}</div></div>
    <div class="stat"><div class="l">累计请求</div><div class="v">${stats.total.reqs}</div><div class="l">累计积分 ${stats.total.credits.toFixed(1)}</div></div>
  </div>
  <div class="card">
    <div class="toolbar" style="margin-bottom:8px"><h3 style="font-size:14px">最近 24 小时趋势</h3><span class="spacer"></span>
      <a href="javascript:go('usage')" style="font-size:13px">查看完整用量 →</a></div>
    <div style="display:flex;align-items:flex-end;gap:3px;height:110px;padding:0 4px">
      ${chart.series.map(s => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%" title="${s.label} · ${s.reqs} 请求 · 失败 ${s.errors}">
        <div style="width:70%;background:${s.errors ? 'linear-gradient(180deg,var(--red),var(--accent))' : 'var(--accent)'};border-radius:3px 3px 0 0;height:${Math.round(s.reqs / maxReqs * 92)}%;min-height:${s.reqs ? '3px' : '0'}"></div>
      </div>`).join('')}
    </div>
    <div style="display:flex;gap:3px;padding:4px 4px 0">
      ${chart.series.filter((s, i) => i % Math.ceil(chart.series.length / 12) === 0).map(s => `<span class="muted mono" style="flex:1;font-size:10px;text-align:center">${s.label}</span>`).join('')}
    </div>
  </div>
  <div style="display:flex;gap:16px;flex-wrap:wrap">
    <div class="card" style="flex:1;min-width:300px"><h2 style="font-size:14px">账号健康 <a href="javascript:go('accounts')" style="font-size:12px;font-weight:400">管理 →</a></h2>
      <div id="dashAccounts" class="muted">加载中…</div>
    </div>
    <div class="card" style="flex:1;min-width:300px"><h2 style="font-size:14px">今日模型 Top <a href="javascript:go('usage')" style="font-size:12px;font-weight:400">全部 →</a></h2>
      ${stats.byModel.length ? `<table style="font-size:13px"><tr><th>模型</th><th>请求</th><th>tok</th></tr>
      ${stats.byModel.slice(0, 8).map(r => `<tr><td class="mono">${esc(r.public_model)}</td><td>${r.reqs}</td><td class="muted">${((r.tin+r.tout)/1000).toFixed(1)}k</td></tr>`).join('')}</table>` : '<p class="muted">暂无数据</p>'}
    </div>
  </div>`;
  api('/accounts').then(accounts => {
    const groups = {};
    for (const a of accounts) {
      (groups[a.provider_id] = groups[a.provider_id] || []).push(a);
    }
    $('#dashAccounts').innerHTML = Object.entries(groups).map(([pid, list]) => `
      <div style="margin-bottom:6px"><b class="mono" style="font-size:12.5px">${esc(pid)}</b>
      ${list.map(a => `<span title="${esc(a.status_message || '')}" style="margin-left:6px">${statusBadge(a.status)} <span style="font-size:12.5px">${esc(a.name)}</span></span>`).join('')}
      </div>`).join('') || '暂无账号';
  }).catch(() => {});
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
    <select id="fProvider" style="width:170px"><option value="">全部平台</option>
      ${groupProviders(providers).filter(g => g.name !== '其他').map(g => `<optgroup label="${esc(g.name)}">${g.providers.map(p => `<option value="${p.id}" ${acctFilter.provider_id === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</optgroup>`).join('')}
    </select>
    <input id="fSearch" class="searchbox" placeholder="搜索名称/信息…" value="${esc(acctFilter.search)}">
    <select id="fStatus" style="width:110px"><option value="">全部状态</option>
      ${['active','cooling','invalid','banned'].map(s => `<option ${acctFilter.status === s ? 'selected' : ''} value="${s}">${s}</option>`).join('')}</select>
    <select id="fEnabled" style="width:100px"><option value="">启用+停用</option><option value="1" ${acctFilter.enabled === '1' ? 'selected' : ''}>仅启用</option><option value="0" ${acctFilter.enabled === '0' ? 'selected' : ''}>仅停用</option></select>
    <span class="spacer"></span>
    <button class="ghost" onclick="syncAllInfo()">同步积分</button>
    <button class="ghost" onclick="checkAllAccounts()">一键检测</button>
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
    <td style="white-space:nowrap">
      <button class="small ghost" onclick="checkAccount(${a.id})">检测</button>
      <button class="small ghost" title="上游报给该账号的全部模型，增量补充" onclick="syncAccountModels(${a.id})">获取全部模型</button>
      <button class="small ghost" title="只保留上游当前实际可用的模型（trae/workbuddy/qwen）" onclick="resetOnlineAccount(${a.id})">恢复在线</button>
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
  if (extra.username) bits.push(extra.username);
  if (extra.email) bits.push(extra.email);
  if (extra.uid) bits.push(`uid ${String(extra.uid).slice(0, 10)}`);
  if (extra.credits != null) bits.push(`积分 ${extra.credits}/${extra.quota ?? '?'}`);
  if (extra.baseQuota) bits.push(`基础 ${extra.baseQuota}`);
  if (extra.addOnQuota) bits.push(`附加 ${extra.addOnQuota}`);
  if (extra.plan) bits.push(extra.plan);
  if (extra.checkin?.claimable) bits.push('签到可领');
  if (extra.userType) bits.push(extra.userType);
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
async function checkAllAccounts() {
  toast('正在深度检测全部账号（含真实对话探测，约 10-60 秒）…');
  try {
    const r = await api('/accounts/check-all', { method: 'POST' });
    const ok = r.results.filter(x => x.ok === true && x.probe?.ok !== false).length;
    const lines = r.results.map(x => {
      const probe = x.probe == null ? '' : x.probe.ok ? ` · 探测✓ (${x.probe.model})` : ` · 探测✗ ${x.probe.error || ''}`;
      return `${x.ok === true ? (x.probe?.ok === false ? '△' : '✓') : x.ok === false ? '✗' : '·'} [${x.provider_id}] ${x.name}: ${x.message || 'ok'}${probe}`;
    });
    openModal(`深度检测完成：${ok}/${r.checked} 全链路可用`, `
      <p class="muted" style="margin-bottom:8px;font-size:12px">✓=档案+探测都通过　△=档案有效但对话探测失败（已进入冷却）　✗=档案接口失败</p>
      <div class="field" style="font-size:13px;line-height:2;max-height:320px;overflow:auto">${lines.map(esc).join('<br>')}</div>
      <div class="row"><span class="spacer"></span><button onclick="closeModal();go('accounts')">好的</button></div>`, {});
  } catch (e) { toast(e.message, true); }
}
async function syncAllInfo() {
  toast('正在同步全部账号积分与档案…');
  try {
    const r = await api('/accounts/sync-info', { method: 'POST' });
    const lines = r.results.map(x => `${x.ok === false ? '✗' : '✓'} [${x.provider_id}] ${x.name}: ${x.message || '-'}${x.credits != null ? '（积分 ' + x.credits + '）' : ''}`);
    openModal('积分同步完成', `
      <p class="muted" style="margin-bottom:8px;font-size:12px">只刷新积分/档案信息，不改变账号状态、不做对话探测。</p>
      <div class="field" style="font-size:13px;line-height:2;max-height:320px;overflow:auto">${lines.map(esc).join('<br>')}</div>
      <div class="row"><span class="spacer"></span><button onclick="closeModal();go('accounts')">好的</button></div>`, {});
  } catch (e) { toast(e.message, true); }
}
async function resetOnlineModels(providerId) {
  let pid = providerId;
  if (!pid) {
    // pick a provider that supports it (has accounts): default to workbuddy-style detection server-side
    pid = prompt('输入平台 ID（如 workbuddy；该功能需要平台支持在线目录）：');
    if (!pid) return;
  }
  if (!confirm(`恢复「${pid}」的在线模型目录？\n该平台现有模型列表会被替换为上游实际可用的模型（自定义条目会被移除）。`)) return;
  toast('获取在线目录中…');
  try {
    const r = await api(`/providers/${pid}/reset-online-models`, { method: 'POST' });
    openModal(`✓ 已恢复在线目录 — ${pid}`, `
      <p style="margin-bottom:8px">来源：${esc(r.source || '上游')} · 删除 ${r.deleted} 个旧条目 · 导入 ${r.added} 个在线模型</p>
      ${r.models?.length ? `<div class="field" style="font-size:13px;line-height:2;max-height:280px;overflow:auto">${r.models.map(m => `<span class="mono">${esc(m.name)}</span>${m.vision ? ' <span class="badge blue">vision</span>' : ''}${m.ctx ? ` <span class="muted">${m.ctx >= 1000 ? (m.ctx/1000) + 'k' : m.ctx}</span>` : ''}`).join('<br>')}</div>` : ''}
      <div class="row"><span class="spacer"></span><button onclick="closeModal();go('models')">好的</button></div>`, {});
  } catch (e) { toast(e.message, true); }
}
async function syncAccountModels(id) {
  toast('同步该账号模型中…');
  try {
    const r = await api(`/accounts/${id}/refresh-models`, { method: 'POST' });
    toast(`✓ 新增 ${r.added} 个（上游共 ${r.total} 个）`);
    renderAccounts($('#main'));
  } catch (e) { toast('同步失败: ' + e.message, true); }
}
async function resetOnlineAccount(id) {
  if (!confirm('恢复在线模型？\n该平台现有模型列表会被替换为上游当前实际可用的模型（自定义条目会被移除）。')) return;
  toast('获取在线目录中…');
  try {
    const r = await api(`/accounts/${id}/reset-online-models`, { method: 'POST' });
    toast(`✓ 已恢复：删除 ${r.deleted} 个 → 导入 ${r.added} 个在线模型`);
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
  const supportsOAuth = !acct && ['workbuddy'].includes(p?.id); // platforms with device-flow login
  openModal(acct ? '编辑账号' : '添加账号', `
    <div class="field"><label>平台</label>
      <select id="afProvider" ${acct ? 'disabled' : ''}>${providers.map(x => `<option value="${x.id}" ${p?.id === x.id ? 'selected' : ''}>${esc(x.label)} (${x.id})</option>`).join('')}</select></div>
    ${supportsOAuth ? `
    <div class="card" style="background:var(--panel2);padding:12px 16px;margin-bottom:12px">
      <b style="font-size:13px">推荐：网页授权登录</b>
      <p class="muted" style="font-size:12px;margin:4px 0 8px">点击后自动打开 ${esc(p.label)} 授权页，登录成功后账号自动添加（无需手动填 token）。<b>轮询最长 10 分钟</b>：超时或你点取消即停止，服务器端不留任何后台轮询——登录成功与否都由这次点击驱动。</p>
      <button id="afOAuthBtn" onclick="startOAuthLogin('${p.id}')">🌐 打开授权页面登录</button>
      <span id="afOAuthStatus" class="muted" style="margin-left:10px;font-size:12px"></span>
    </div>` : ''}
    <div class="field"><label>名称（用于区分多账号，留空自动起名）</label><input id="afName" value="${esc(acct?.name || '')}" placeholder="如 main / 小号1"></div>
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
    // re-render the whole form for oauth-capable platforms
    if (!acct && ['workbuddy'].includes(np?.id)) { mFormAccount(null, providers, np); return; }
    $('#afCreds').innerHTML = credFieldsHtml(np, null);
    const d = $('#afDocs'); if (d) d.textContent = np?.docs || '';
  });
}
async function startOAuthLogin(providerId) {
  const btn = $('#afOAuthBtn'), status = $('#afOAuthStatus');
  btn.disabled = true;
  status.textContent = '正在创建授权会话…';
  try {
    const r = await api(`/providers/${providerId}/oauth/start`, { method: 'POST' });
    status.innerHTML = `已打开授权页。若未弹出，<a href="${esc(r.authUrl)}" target="_blank">点此打开</a>。登录后自动完成…`;
    window.open(r.authUrl, '_blank');
    // poll every 2.5s up to 10min
    const deadline = Date.now() + 10 * 60 * 1000;
    const timer = setInterval(async () => {
      if (Date.now() > deadline) { clearInterval(timer); status.textContent = '超时（10 分钟），请重试'; btn.disabled = false; return; }
      try {
        const p = await api(`/providers/${providerId}/oauth/poll`, { method: 'POST', body: { state: r.state } });
        if (!p.pending) {
          clearInterval(timer);
          status.textContent = `✓ 登录成功：${p.identity?.nickname || p.name}（账号「${p.name}」已添加）`;
          setTimeout(() => { closeModal(); toast(`✓ 已添加账号 ${p.name}`); go('accounts'); }, 1200);
        } else {
          status.textContent = '等待你在授权页完成登录…';
        }
      } catch (e) { clearInterval(timer); status.textContent = '轮询失败: ' + e.message; btn.disabled = false; }
    }, 2500);
  } catch (e) { status.textContent = '失败: ' + e.message; btn.disabled = false; }
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
    api('/models?' + new URLSearchParams(Object.fromEntries(Object.entries(modelFilter).filter(([, v]) => v !== '')))),
  ]);
  const providerOpts = providers.map(p => `<option value="${p.id}" ${modelFilter.provider_id === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
  m.innerHTML = `
  <h2>模型管理 <span class="muted">(${models.length})</span></h2>
  <div class="toolbar">
    <select id="mfProvider" style="width:150px"><option value="">全部平台</option>${providerOpts}</select>
    <input id="mfSearch" class="searchbox" placeholder="搜索模型名/标签…" value="${esc(modelFilter.search)}">
    <select id="mfEnabled" style="width:100px"><option value="">全部</option><option value="1" ${modelFilter.enabled === '1' ? 'selected' : ''}>仅启用</option><option value="0" ${modelFilter.enabled === '0' ? 'selected' : ''}>仅停用</option></select>
    <input id="mfTag" style="width:110px" placeholder="标签筛选" value="${esc(modelFilter.tag)}">
    <span class="spacer"></span>
    <select id="mfSyncSel" style="width:170px"><option value="">同步模型：选择平台…</option><option value="__all">全部平台</option>${providerOpts}</select>
    <button class="ghost" id="mfSyncBtn">开始同步</button>
    <button class="ghost" id="mfResetBtn" title="只拉取上游实际可用的模型目录，替换现有列表">恢复在线模型</button>
    <button onclick="openModelForm()">+ 手动添加</button>
  </div>
  <div class="toolbar" style="background:var(--panel2);border-radius:8px;padding:8px 12px">
    <span class="muted">批量：</span>
    <label class="row" style="gap:4px;font-size:13px"><input type="checkbox" id="mfCheckAll" style="width:auto"> 全选本页</label>
    <button class="small" onclick="batchModels('enable')">启用选中</button>
    <button class="small ghost" onclick="batchModels('disable')">禁用选中</button>
    <button class="small danger" onclick="batchModels('delete')">删除选中</button>
    <span class="muted">|</span>
    <button class="small ghost" onclick="batchScope('enable')">启用当前筛选</button>
    <button class="small ghost" onclick="batchScope('disable')">禁用当前筛选</button>
    <button class="small ghost" onclick="batchDevVariants()">隐藏 __dev 变体</button>
  </div>
  <div class="card" style="padding:6px 12px">
  <table><tr><th style="width:26px"></th><th>对外名称</th><th>平台</th><th>上游模型</th><th>倍率</th><th>免费</th><th>可用账号</th><th>标签</th><th>启用</th><th>操作</th></tr>
  ${models.map(md => `<tr>
    <td><input type="checkbox" class="mfCheck" value="${md.id}" style="width:auto"></td>
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
  ${!models.length ? '<tr><td colspan="10" class="muted" style="text-align:center;padding:24px">暂无模型 — 添加账号后在上方选择平台「开始同步」，或手动添加</td></tr>' : ''}
  </table></div>`;
  $('#mfProvider').onchange = e => { modelFilter.provider_id = e.target.value; renderModels(m); };
  $('#mfEnabled').onchange = e => { modelFilter.enabled = e.target.value; renderModels(m); };
  $('#mfSearch').onkeydown = e => { if (e.key === 'Enter') { modelFilter.search = e.target.value; renderModels(m); } };
  $('#mfTag').onkeydown = e => { if (e.key === 'Enter') { modelFilter.tag = e.target.value; renderModels(m); } };
  $('#mfSyncBtn').onclick = () => {
    const v = $('#mfSyncSel').value;
    if (!v) return toast('请先选择要同步的平台', true);
    if (v === '__all') return refreshModelsAll();
    refreshModels(v);
  };
  $('#mfResetBtn').onclick = () => {
    const v = $('#mfSyncSel').value;
    if (!v || v === '__all') return toast('请先在左侧下拉选择一个平台（恢复在线目录按平台执行）', true);
    resetOnlineModels(v);
  };
  $('#mfCheckAll').onchange = e => { document.querySelectorAll('.mfCheck').forEach(c => c.checked = e.target.checked); };
}
function checkedModelIds() { return [...document.querySelectorAll('.mfCheck:checked')].map(c => Number(c.value)); }
async function batchModels(action) {
  const ids = checkedModelIds();
  if (!ids.length) return toast('请先勾选模型', true);
  if (action === 'delete' && !confirm(`删除选中的 ${ids.length} 个模型？`)) return;
  const r = await api('/models/batch', { method: 'POST', body: { action, ids } });
  toast(`已${action === 'enable' ? '启用' : action === 'disable' ? '禁用' : '删除'} ${r.affected} 个`);
  renderModels($('#main'));
}
async function batchScope(action) {
  const body = { action };
  if (modelFilter.provider_id) body.provider_id = modelFilter.provider_id;
  else if (!confirm(`对${modelFilter.enabled === '0' ? '已筛选' : '全部'}模型执行「${action === 'enable' ? '启用' : '禁用'}」？范围较大，请确认。`)) return;
  const r = await api('/models/batch', { method: 'POST', body });
  toast(`已${action === 'enable' ? '启用' : '禁用'} ${r.affected} 个`);
  renderModels($('#main'));
}
async function batchDevVariants() {
  const r = await api('/models/batch', { method: 'POST', body: { action: 'disable-dev-variants' } });
  toast(`已禁用 ${r.affected} 个 __dev 变体`);
  renderModels($('#main'));
}
async function refreshModelsAll() {
  toast('同步全部平台模型中…');
  try {
    const r = await api('/refresh-models-all', { method: 'POST' });
    const total = r.reduce((s, x) => s + (x.added || 0), 0);
    const errs = r.flatMap(x => x.errors || []);
    toast(`同步完成：共新增 ${total} 个${errs.length ? '，错误: ' + errs.slice(0, 2).join('; ') : ''}`, errs.length > 0);
    go('models');
  } catch (e) { toast(e.message, true); }
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

// ---------- virtual models (统一模型) ----------
async function renderVirtual(m) {
  const [virtuals, targets, presets] = await Promise.all([api('/virtual-models'), api('/virtual-models/targets'), api('/virtual-models/presets')]);
  const byProvider = {};
  for (const t of targets) (byProvider[t.provider_id] = byProvider[t.provider_id] || []).push(t.public_name);
  m.innerHTML = `
  <h2>统一模型 <span class="muted">(${virtuals.length})</span></h2>
  <p class="muted" style="margin-bottom:12px">统一模型把多个平台的真实模型聚合成一个对外名称：客户端请求它时，网关按目标顺序依次尝试，<b>失败自动切换下一个</b>。也可以用来改名（如对外叫 <span class="mono">gpt-4o</span>，实际走 DeepSeek/GLM）。与「模型管理」里的直接模型相互独立，都可通过 /v1/models 看到。</p>
  <div class="toolbar">
    <span class="muted">快速创建（同名多平台聚合）：</span>
    <select id="vpSel" style="width:260px"><option value="">选择预设…</option>
      ${presets.filter(p => p.multiProvider).map(p => `<option value="${esc(p.base)}">${esc(p.base)}（${p.targets.length} 平台: ${esc(p.providers.join(','))}）</option>`).join('')}
    </select>
    <button class="ghost" id="vpCreate">一键创建</button>
    <span class="spacer"></span>
    <button onclick="openVirtualForm()">+ 自定义</button>
  </div>
  <div class="card" style="padding:6px 12px">
  <table><tr><th>对外名称</th><th>目标链（按优先级）</th><th>启用</th><th>备注</th><th>操作</th></tr>
  ${virtuals.map(v => {
    const ts = JSON.parse(v.targets || '[]').sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    return `<tr>
    <td class="mono"><b>${esc(v.public_name)}</b></td>
    <td>${ts.map((t, i) => `${i > 0 ? '<span class="muted"> → </span>' : ''}<span class="badge blue">${esc(t.provider_id)}/${esc(t.public_name)}</span>`).join('')}</td>
    <td>${switchHtml(v.enabled, `toggleVirtual('${esc(v.public_name)}', ${v.enabled ? 0 : 1})`)}</td>
    <td class="muted">${esc(v.note || '')}</td>
    <td><button class="small ghost" onclick="openVirtualForm('${esc(v.public_name)}')">编辑</button>
        <button class="small danger" onclick="delVirtual('${esc(v.public_name)}')">删</button></td>
  </tr>`;
  }).join('')}
  ${!virtuals.length ? '<tr><td colspan="5" class="muted" style="text-align:center;padding:24px">暂无统一模型 — 用上方预设一键创建，或「自定义」</td></tr>' : ''}
  </table></div>`;
  window._virtualTargets = byProvider;
  $('#vpCreate').onclick = async () => {
    const base = $('#vpSel').value;
    if (!base) return toast('先选一个预设', true);
    const p = presets.find(x => x.base === base);
    try {
      await api('/virtual-models', { method: 'POST', body: { public_name: base, targets: p.targets.map((t, i) => ({ ...t, priority: (i + 1) * 10 })), note: `聚合 ${p.targets.length} 个平台，失败自动切换` } });
      toast(`✓ 已创建统一模型 ${base}（${p.targets.length} 平台）`); go('virtual');
    } catch (e) { toast(e.message, true); }
  };
}
async function toggleVirtual(name, enabled) { await api('/virtual-models/' + encodeURIComponent(name), { method: 'PUT', body: { enabled } }); renderVirtual($('#main')); }
async function delVirtual(name) { if (!confirm(`删除统一模型「${name}」？`)) return; await api('/virtual-models/' + encodeURIComponent(name), { method: 'DELETE' }); renderVirtual($('#main')); }
async function openVirtualForm(name) {
  const byProvider = window._virtualTargets || {};
  const v = name ? (await api('/virtual-models')).find(x => x.public_name === name) : null;
  const targets = v ? JSON.parse(v.targets || '[]').sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100)) : [{ provider_id: '', public_name: '', priority: 100 }];
  openModal(v ? `编辑统一模型 — ${name}` : '新建统一模型', `
    <div class="field"><label>对外名称（客户端填的 model，可与真实模型重名以"伪装"）</label>
      <input id="vfName" value="${esc(v?.public_name || '')}" placeholder="如 gpt-4o 或 glm-5.3" ${v ? 'readonly style="opacity:.6"' : ''}></div>
    <div class="field"><label>目标链（从上到下依次尝试，失败自动切下一个）</label>
      <div id="vfTargets">
      ${targets.map((t, i) => virtualTargetRow(i, t, byProvider)).join('')}
      </div>
      <button class="small ghost" onclick="addVirtualTargetRow()">+ 添加目标</button></div>
    <div class="field"><label>备注</label><input id="vfNote" value="${esc(v?.note || '')}"></div>
    <div class="row"><span class="spacer"></span><button class="ghost" onclick="closeModal()">取消</button>
    <button onclick="saveVirtual('${esc(name || '')}')">保存</button></div>`, {});
}
function virtualTargetRow(i, t, byProvider) {
  const provs = Object.keys(byProvider);
  return `<div class="row vtRow" style="margin-bottom:6px" data-i="${i}">
    <span class="muted mono vtNum">${i + 1}.</span>
    <select class="vtProvider" style="width:150px" onchange="vtProviderChange(this)">
      <option value="">选平台…</option>${provs.map(p => `<option value="${esc(p)}" ${t.provider_id === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
    <select class="vtModel" style="width:220px">${(byProvider[t.provider_id] || []).map(mm => `<option value="${esc(mm)}" ${t.public_name === mm ? 'selected' : ''}>${esc(mm)}</option>`).join('') || `<option value="${esc(t.public_name || '')}">${esc(t.public_name || '（先选平台）')}</option>`}</select>
    <button class="small ghost" title="上移" onclick="moveVirtualRow(this,-1)">↑</button>
    <button class="small ghost" title="下移" onclick="moveVirtualRow(this,1)">↓</button>
    <button class="small ghost" title="移除" onclick="this.parentElement.remove();renumberVirtualRows()">✕</button>
  </div>`;
}
function moveVirtualRow(btn, dir) {
  const row = btn.closest('.vtRow');
  if (dir < 0 && row.previousElementSibling) row.previousElementSibling.before(row);
  if (dir > 0 && row.nextElementSibling) row.nextElementSibling.after(row);
  renumberVirtualRows();
}
function vtProviderChange(sel) {
  const row = sel.closest('.vtRow');
  const models = (window._virtualTargets || {})[sel.value] || [];
  row.querySelector('.vtModel').innerHTML = models.map(mm => `<option value="${esc(mm)}">${esc(mm)}</option>`).join('');
}
function addVirtualTargetRow() {
  const box = $('#vfTargets');
  const i = box.children.length;
  box.insertAdjacentHTML('beforeend', virtualTargetRow(i, { provider_id: '', public_name: '' }, window._virtualTargets || {}));
}
function renumberVirtualRows() {
  document.querySelectorAll('#vfTargets .vtRow').forEach((r, i) => r.querySelector('.vtNum').textContent = (i + 1) + '.');
}
async function saveVirtual(origName) {
  const targets = [...document.querySelectorAll('#vfTargets .vtRow')].map((row, i) => ({
    provider_id: row.querySelector('.vtProvider').value,
    public_name: row.querySelector('.vtModel').value,
    priority: (i + 1) * 10,
  })).filter(t => t.provider_id && t.public_name);
  const body = { public_name: $('#vfName').value.trim(), targets, note: $('#vfNote').value };
  if (!body.public_name) return toast('请填对外名称', true);
  if (!targets.length) return toast('至少需要一个有效目标', true);
  try {
    if (origName) await api('/virtual-models/' + encodeURIComponent(origName), { method: 'PUT', body });
    else await api('/virtual-models', { method: 'POST', body });
    closeModal(); toast('已保存'); go('virtual');
  } catch (e) { toast(e.message, true); }
}


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
  const [models, virtuals] = await Promise.all([api('/models?size=1000'), api('/virtual-models')]);
  const allNames = [
    ...virtuals.map(v => ({ name: v.public_name, tag: '统一' })),
    ...models.filter(md => md.enabled).map(md => ({ name: md.public_name, tag: md.provider_id })),
  ];
  const selected = new Set((k?.allowed_models || '*') === '*' ? [] : (k?.allowed_models || '').split(',').map(s => s.trim()).filter(Boolean));
  const isAll = (k?.allowed_models || '*') === '*';
  window._keyModels = { allNames, selected };
  openModal(k ? '编辑 Key' : '生成 Key', `
    <div class="field"><label>名称</label><input id="kfName" value="${esc(k?.name || '')}" placeholder="如 my-trae-client"></div>
    <div class="field"><label>允许的模型</label>
      <label class="row" style="gap:6px;font-size:13px;margin-bottom:6px"><input type="checkbox" id="kfAll" style="width:auto" ${isAll ? 'checked' : ''} onchange="kfToggleAll(this)"> 全部模型（不限制）</label>
      <div id="kfPicker" style="${isAll ? 'display:none' : ''}">
        <input id="kfSearch" placeholder="输入筛选（如 glm、kimi、qoder…）" oninput="kfRenderList()" style="margin-bottom:6px">
        <div id="kfList" style="max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px"></div>
        <p class="muted" style="margin-top:4px" id="kfCount"></p>
      </div></div>
    <div class="row">
      <div class="field" style="width:130px"><label>RPM 限制(0=∞)</label><input id="kfRpm" type="number" value="${k?.rpm_limit ?? 0}"></div>
      <div class="field" style="width:150px"><label>日限积分(0=∞)</label><input id="kfDaily" type="number" value="${k?.daily_limit ?? 0}"></div>
    </div>
    <div class="row"><span class="spacer"></span><button class="ghost" onclick="closeModal()">取消</button>
    <button onclick="saveKey(${id || 'null'})">保存</button></div>`, {});
  kfRenderList();
  if (!id) {
    const r = await api('/apikeys', { method: 'POST', body: { name: '(生成中)' } });
    window._pendingKey = r.key; window._pendingKeyId = r.id;
  }
}
function kfToggleAll(cb) { $('#kfPicker').style.display = cb.checked ? 'none' : ''; }
function kfRenderList() {
  const q = ($('#kfSearch')?.value || '').toLowerCase();
  const { allNames, selected } = window._keyModels;
  const filtered = allNames.filter(m => !q || m.name.toLowerCase().includes(q) || m.tag.toLowerCase().includes(q));
  $('#kfList').innerHTML = filtered.map(m => `
    <label class="row" style="gap:6px;font-size:13px;padding:2px 4px;cursor:pointer">
      <input type="checkbox" style="width:auto" ${selected.has(m.name) ? 'checked' : ''} onchange="kfPick('${esc(m.name)}', this.checked)">
      <span class="mono">${esc(m.name)}</span> ${m.tag === '统一' ? '<span class="badge purple">统一</span>' : `<span class="badge gray">${esc(m.tag)}</span>`}
    </label>`).join('') || '<p class="muted" style="padding:6px">无匹配模型</p>';
  $('#kfCount').textContent = `已选 ${selected.size} 个模型`;
}
function kfPick(name, on) {
  const { selected } = window._keyModels;
  if (on) selected.add(name); else selected.delete(name);
  $('#kfCount').textContent = `已选 ${selected.size} 个模型`;
}
async function saveKey(id) {
  const all = $('#kfAll').checked;
  const allowed = all ? '*' : [...window._keyModels.selected].join(',');
  const body = { name: $('#kfName').value, allowed_models: allowed, rpm_limit: Number($('#kfRpm').value), daily_limit: Number($('#kfDaily').value) };
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
let usageChartHours = 24;
async function renderUsage(m) {
  const [providers, usage, chart] = await Promise.all([
    api('/providers'),
    api('/usage?' + new URLSearchParams(Object.fromEntries(Object.entries({ ...usageFilter }).filter(([, v]) => v)))),
    api('/usage/chart?hours=' + usageChartHours),
  ]);
  const maxReqs = Math.max(1, ...chart.series.map(s => s.reqs));
  const maxDim = Math.max(1, chart.byModel[0]?.reqs || 1, chart.byProvider[0]?.reqs || 1);
  const bar = (v, total, color = 'var(--accent)') => `<div style="background:${color};height:8px;border-radius:4px;width:${Math.round(v / Math.max(1, total) * 100)}%"></div>`;
  const dimTable = (title, rows, cols) => !rows.length ? '' : `
    <div style="flex:1;min-width:260px">
      <h4 style="font-size:13px;margin-bottom:8px;color:var(--muted)">${title}</h4>
      <table style="font-size:12.5px">${rows.map(r => `<tr>
        <td class="mono" style="padding:3px 8px 3px 0;white-space:nowrap">${esc(r.key)}${r.key.includes('#') || /^\d+$/.test(r.key) ? badge('账号', 'gray') : ''}</td>
        ${cols.map(c => `<td style="padding:3px 10px 3px 0;color:var(--muted)">${c(r)}</td>`).join('')}
        <td style="width:36%">${bar(r.reqs, maxDim)}</td>
      </tr>`).join('')}</table>
    </div>`;
  m.innerHTML = `
  <h2>用量日志</h2>
  <div class="card">
    <div class="toolbar" style="margin-bottom:10px">
      <h3 style="font-size:14px">趋势</h3>
      <span class="spacer"></span>
      <select id="ucHours" style="width:130px">
        ${[[24, '最近 24 小时'], [48, '最近 48 小时'], [168, '最近 7 天'], [720, '最近 30 天']].map(([v, l]) => `<option value="${v}" ${usageChartHours === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div style="display:flex;align-items:flex-end;gap:3px;height:120px;padding:0 4px">
      ${chart.series.map(s => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%" title="${s.label} · ${s.reqs} 请求 · 失败 ${s.errors} · in ${s.tin}/out ${s.tout} tok · 积分 ${Number(s.credits).toFixed(2)}">
        <span class="mono muted" style="font-size:9px;margin-bottom:2px">${s.reqs || ''}</span>
        <div style="width:70%;background:${s.errors ? 'linear-gradient(180deg,var(--red),var(--accent))' : 'var(--accent)'};border-radius:3px 3px 0 0;height:${Math.round(s.reqs / maxReqs * 92)}%;min-height:${s.reqs ? '3px' : '0'}"></div>
      </div>`).join('')}
    </div>
    <div style="display:flex;gap:3px;padding:4px 4px 0">
      ${chart.series.filter((s, i) => i % Math.ceil(chart.series.length / 12) === 0).map(s => `<span class="muted mono" style="flex:1;font-size:10px;text-align:center">${s.label}</span>`).join('')}
    </div>
  </div>
  <div class="card" style="display:flex;gap:24px;flex-wrap:wrap">
    ${dimTable('模型 Top（请求数）', chart.byModel, [r => `${r.reqs} 次`, r => `${((r.tin||0)/1000).toFixed(1)}k/${((r.tout||0)/1000).toFixed(1)}k`])}
    ${dimTable('平台（请求/积分）', chart.byProvider, [r => `${r.reqs} 次`, r => `积分 ${Number(r.credits).toFixed(1)}`])}
    ${dimTable('账号', chart.byAccount, [r => `${r.reqs} 次`, r => `积分 ${Number(r.credits).toFixed(1)}`])}
    ${dimTable('结果', chart.byStatus, [r => `${r.reqs} 次`])}
  </div>
  <div class="toolbar">
    <select id="uProvider" style="width:150px"><option value="">全部平台</option>${providers.map(p => `<option value="${p.id}" ${usageFilter.provider_id === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
    <input id="uModel" class="searchbox" placeholder="模型名…" value="${esc(usageFilter.model)}">
    <select id="uStatus" style="width:110px"><option value="">全部</option><option value="ok" ${usageFilter.status === 'ok' ? 'selected' : ''}>成功</option><option value="error" ${usageFilter.status === 'error' ? 'selected' : ''}>失败</option></select>
    <span class="spacer"></span><span class="muted">明细（最近在前）</span>
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
  $('#ucHours').onchange = e => { usageChartHours = Number(e.target.value); renderUsage(m); };
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
  const [s, ar] = await Promise.all([api('/settings'), api('/settings/auto-refresh')]);
  m.innerHTML = `
  <h2>设置</h2>
  <div class="card">
    <h3 style="font-size:14px;margin-bottom:10px">模型自动刷新 <span class="muted" style="font-size:12px">— 各公司模型更新很快，定时同步保持模型列表最新</span></h3>
    <div class="row" style="max-width:400px">
      <select id="stAutoRefresh" style="width:200px">
        <option value="0" ${ar.minutes === 0 ? 'selected' : ''}>关闭（手动同步）</option>
        ${[15, 30, 60, 120, 360, 720].map(v => `<option value="${v}" ${ar.minutes === v ? 'selected' : ''}>每 ${v < 60 ? v + ' 分钟' : (v / 60) + ' 小时'}</option>`).join('')}
      </select>
      <button onclick="saveAutoRefresh()">保存</button>
    </div>
  </div>
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
      <span class="muted">Responses 端点</span><span class="mono">http://localhost:8317/v1/responses（Codex 等）</span>
      <span class="muted">Anthropic 端点</span><span class="mono">http://localhost:8317/v1/messages</span>
      <span class="muted">模型列表</span><span class="mono">http://localhost:8317/v1/models</span>
      <span class="muted">MCP 端点</span><span class="mono">http://localhost:8317/mcp</span>
      <span class="muted">思考控制</span><span class="mono">模型名后缀 -think / -think-high / -xhigh / -nothink</span>
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
async function saveAutoRefresh() {
  try {
    const r = await api('/settings/auto-refresh', { method: 'PUT', body: { minutes: Number($('#stAutoRefresh').value) } });
    toast(r.minutes ? `✓ 已开启：每 ${r.minutes < 60 ? r.minutes + ' 分钟' : (r.minutes / 60) + ' 小时'} 自动同步模型` : '已关闭自动同步');
  } catch (e) { toast(e.message, true); }
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
