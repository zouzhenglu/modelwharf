/* dsh-free-api admin console */
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
  clearTimeout(t._hide);
  t._hide = setTimeout(() => t.style.display = 'none', 2600);
}
function fmtTime(ts) { return ts ? new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }) : '-'; }
function badge(text, cls) { return `<span class="badge ${cls}">${esc(text)}</span>`; }
function statusBadge(s) {
  const map = { active: 'green', cooling: 'yellow', invalid: 'red', banned: 'red' };
  return badge(s || 'active', map[s] || 'gray');
}
function switchHtml(on, onclick) { return `<div class="switch ${on ? 'on' : ''}" onclick="${onclick}"></div>`; }
/** 行内「⋯」更多操作菜单；点击菜单外区域自动收起 */
function moreMenu(itemsHtml) {
  return `<details class="menu" onclick="menuStay(event)"><summary title="更多操作">⋯</summary><div class="menu-list">${itemsHtml}</div></details>`;
}
function menuStay(e) {
  const d = e.currentTarget;
  // 点 summary 由 details 原生开合；点菜单项执行后收起；点空白处不收起
  if (e.target.closest('summary')) return;
  if (e.target.closest('button')) { d.open = false; return; }
  e.preventDefault();
}
document.addEventListener('click', e => {
  document.querySelectorAll('details.menu[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; });
});
/** 可排序表头；key 对应 virtualSort.key */
function sortTh(label, key, extra) {
  const ind = virtualSort.key === key ? (virtualSort.dir === 1 ? '▲' : '▼') : '↕';
  return `<th class="sortable" title="点击排序" onclick="virtualSortBy('${key}')">${label}<span class="sort-ind">${ind}</span>${extra || ''}</th>`;
}
/** 页头：标题 + 可选副标题 + 右侧动作区 */
function pageHead(title, sub, actionsHtml) {
  return `<div class="page-head"><h2>${title}</h2>${sub ? `<span class="sub">${sub}</span>` : ''}
    <span class="spacer"></span>${actionsHtml || ''}</div>`;
}
/** 统一空状态 */
function emptyRow(cols, ico, text) {
  return `<tr><td colspan="${cols}"><div class="empty"><span class="ico">${ico}</span>${text}</div></td></tr>`;
}

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
  if (page === 'checkin') return renderCheckin(m);
  if (page === 'models') return renderModels(m);
  if (page === 'virtual') return renderVirtual(m);
  if (page === 'apikeys') return renderApikeys(m);
  if (page === 'usage') return renderUsage(m);
  if (page === 'mcp') return renderMcp(m);
  if (page === 'playground') return renderPlayground(m);
  if (page === 'docs') return renderDocs(m);
  if (page === 'settings') return renderSettings(m);
}

// ---------- platforms page (平台列表：每平台 获取全部模型/恢复在线模型) ----------
async function renderPlatforms(m) {
  const providers = await api('/providers');
  const groups = groupProviders(providers);
  const supportsOnline = p => p.supports_online;
  m.innerHTML = `
  ${pageHead(`平台 <span class="muted" style="font-size:13px">(${providers.length})</span>`)}
  <p class="muted" style="margin-bottom:14px;line-height:1.8">
    <b style="color:var(--text-dim)">获取全部模型</b>：把上游报给该账号的模型同步进来（增量补充，最全）。　
    <b style="color:var(--text-dim)">恢复在线模型</b>：只保留上游<b style="color:var(--text-dim)">当前实际可用</b>的目录（与官方客户端一致，会替换现有列表；支持在线目录的平台显示该按钮）。
  </p>
  ${groups.map(g => `
  <div class="card"><h3 style="font-size:14px;margin-bottom:10px">${esc(g.name)} <span class="muted">(${g.providers.length})</span></h3>
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
  // qodercn 紧跟 qoder：同一个客户端的两个版本，放一起才好对照
  { name: '逆向平台（账号池）', ids: ['trae', 'workbuddy', 'qoder', 'qodercn', 'qwen', 'qwenwork'] },
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
/** 平台下拉的分组 <optgroup>；skipOther 时不含未分组平台（与平台账号页筛选一致） */
function providerOptgroups(providers, selectedId, skipOther) {
  return groupProviders(providers).filter(g => !skipOther || g.name !== '其他').map(g =>
    `<optgroup label="${esc(g.name)}">${g.providers.map(p =>
      `<option value="${p.id}" ${selectedId === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</optgroup>`).join('');
}
/** 24h 趋势柱状图（仪表盘/用量页共用） */
function chartHtml(chart, height = 120) {
  const maxReqs = Math.max(1, ...chart.series.map(s => s.reqs));
  const step = Math.ceil(chart.series.length / 12);
  return `
  <div style="display:flex;align-items:flex-end;gap:3px;height:${height}px;padding:0 4px">
    ${chart.series.map(s => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%" title="${s.label} · ${s.reqs} 请求 · 失败 ${s.errors}">
      <div style="width:70%;background:${s.errors ? 'linear-gradient(180deg,var(--red),var(--accent))' : 'linear-gradient(180deg,var(--accent),rgba(91,157,255,.35))'};border-radius:4px 4px 0 0;height:${Math.round(s.reqs / maxReqs * 92)}%;min-height:${s.reqs ? '4px' : '0'};box-shadow:0 0 6px rgba(91,157,255,.25)"></div>
    </div>`).join('')}
  </div>
  <div style="display:flex;gap:3px;padding:6px 4px 0">
    ${chart.series.filter((s, i) => i % step === 0).map(s => `<span class="muted mono" style="flex:1;font-size:10px;text-align:center">${s.label}</span>`).join('')}
  </div>`;
}
async function renderDashboard(m) {
  const [stats, chart] = await Promise.all([api('/stats'), api('/usage/chart?hours=24')]);
  m.innerHTML = `
  ${pageHead('仪表盘', '网关运行总览')}
  <div class="statgrid">
    <div class="stat"><div class="l">今日请求</div><div class="v">${stats.today.reqs}</div><div class="d" style="color:${stats.today.errors ? 'var(--red)' : 'var(--green)'}">失败 ${stats.today.errors}</div></div>
    <div class="stat"><div class="l">今日 Token</div><div class="v">${(stats.today.tin/1000).toFixed(1)}k <span class="muted" style="font-size:14px">/</span> ${(stats.today.tout/1000).toFixed(1)}k</div><div class="d">输入 / 输出</div></div>
    <div class="stat"><div class="l">今日积分消耗</div><div class="v">${stats.today.credits.toFixed(2)}</div></div>
    <div class="stat"><div class="l">累计请求</div><div class="v">${stats.total.reqs}</div><div class="d">累计积分 ${stats.total.credits.toFixed(1)}</div></div>
  </div>
  <div class="card">
    <div class="toolbar" style="margin-bottom:10px"><h3 style="font-size:14px;margin:0">最近 24 小时趋势</h3><span class="spacer"></span>
      <a href="javascript:go('usage')" style="font-size:13px">查看完整用量 →</a></div>
    ${chartHtml(chart, 110)}
  </div>
  <div style="display:flex;gap:16px;flex-wrap:wrap">
    <div class="card" style="flex:1;min-width:300px;margin:0"><h3 style="font-size:14px">账号健康 <a href="javascript:go('accounts')" style="font-size:12px;font-weight:400">管理 →</a></h3>
      <div id="dashAccounts" class="muted">加载中…</div>
    </div>
    <div class="card" style="flex:1;min-width:300px;margin:0"><h3 style="font-size:14px">今日模型 Top <a href="javascript:go('usage')" style="font-size:12px;font-weight:400">全部 →</a></h3>
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
      <div style="margin-bottom:8px"><b class="mono" style="font-size:12.5px">${esc(pid)}</b>
      ${list.map(a => `<span title="${esc(a.status_message || '')}" style="margin-left:6px">${statusBadge(a.status)} <span style="font-size:12.5px">${esc(a.name)}</span></span>`).join('')}
      </div>`).join('') || '<div class="empty"><span class="ico">👥</span>暂无账号</div>';
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
  const onlineIds = new Set(providers.filter(p => p.supports_online).map(p => p.id));
  m.innerHTML = `
  ${pageHead(`平台账号 <span class="muted" style="font-size:13px">(${accounts.length})</span>`)}
  <div class="toolbar">
    <select id="fProvider" style="width:170px"><option value="">全部平台</option>
      ${providerOptgroups(providers, acctFilter.provider_id, true)}
    </select>
    <input id="fSearch" class="searchbox" placeholder="搜索名称/信息…" value="${esc(acctFilter.search)}">
    <select id="fStatus" style="width:110px"><option value="">全部状态</option>
      ${['active','cooling','invalid','banned'].map(s => `<option ${acctFilter.status === s ? 'selected' : ''} value="${s}">${s}</option>`).join('')}</select>
    <select id="fEnabled" style="width:100px"><option value="">启用+停用</option><option value="1" ${acctFilter.enabled === '1' ? 'selected' : ''}>仅启用</option><option value="0" ${acctFilter.enabled === '0' ? 'selected' : ''}>仅停用</option></select>
    <span class="spacer"></span>
    <button class="ghost" onclick="checkinAllAccounts()">一键签到</button>
    <button class="ghost" onclick="syncAllInfo()">同步积分</button>
    <button class="ghost" onclick="checkAllAccounts()">一键检测</button>
    <button class="ghost" onclick="importLocalAll()">扫描本机登录</button>
    <button class="ghost" title="逐个拉取全部平台上账号可用的模型（增量，不删除已有）" onclick="refreshModelsAll()">同步全部模型</button>
    <button onclick="openAccountForm()">＋ 添加账号</button>
  </div>
  <div class="table-wrap">
  <table><tr><th>平台</th><th>名称 / 身份</th><th>状态</th><th>积分与信息</th>
    <th title="数字越小越优先被轮询使用。同平台多账号时，先用优先级小的，失败/冷却自动换下一个">优先级 ⓘ</th>
    <th title="该账号同时处理的最大请求数。达到上限后请求会分流到其他账号，避免单账号被上游限流">并发 ⓘ</th>
    <th>最近使用</th><th>启用</th><th>操作</th></tr>
  ${(() => {
    return accounts.map(a => {
    const online = onlineIds.has(a.provider_id);
    return `<tr>
    <td>${esc(a.provider_id)}</td>
    <td><b>${esc(a.name)}</b>${a.extra?.username ? `<div class="muted" style="font-size:12px">${esc(a.extra.username)}${a.extra.email ? ' · ' + esc(a.extra.email) : ''}</div>` : ''}</td>
    <td>${statusBadge(a.status)}${a.status_message ? `<div class="muted" style="max-width:180px;font-size:12px">${esc(a.status_message)}</div>` : ''}</td>
    <td>${creditCellHtml(a.extra)}</td>
    <td>${a.priority}</td><td>${a.max_concurrency}</td>
    <td class="muted" style="font-size:12px">${fmtTime(a.last_used_at)}</td>
    <td>${switchHtml(a.enabled, `toggleAccount(${a.id}, ${a.enabled ? 0 : 1})`)}</td>
    <td style="white-space:nowrap">
      <button class="small ghost" onclick="checkAccount(${a.id})">检测</button>
      <button class="small ghost" title="为该账号执行每日签到领积分（已签过会提示，不重复领取）" onclick="checkinAccount(${a.id})">签到</button>
      ${moreMenu(`
        <button title="${online ? '只取上游当前实际可用的模型目录（与官方客户端显示一致，会替换现有列表，自定义条目会被移除）' : '从上游 /v1/models 在线目录同步该账号模型（增量补充）'}" onclick="restoreAccountModels(${a.id}, ${online})">${online ? '⇄ 恢复在线目录' : '⇄ 同步模型'}</button>
        <button onclick="openAccountForm(${a.id})">✎ 编辑</button>
        <button class="danger" onclick="delAccount(${a.id})">✕ 删除</button>
      `)}
    </td></tr>`;
    }).join('');
  })()}
  ${!accounts.length ? emptyRow(10, '👥', '暂无账号，点右上角添加，或用「扫描本机登录」自动发现') : ''}
  </table></div>`;
  $('#fProvider').onchange = e => { acctFilter.provider_id = e.target.value; renderAccounts(m); };
  $('#fStatus').onchange = e => { acctFilter.status = e.target.value; renderAccounts(m); };
  $('#fEnabled').onchange = e => { acctFilter.enabled = e.target.value; renderAccounts(m); };
  $('#fSearch').onkeydown = e => { if (e.key === 'Enter') { acctFilter.search = e.target.value; renderAccounts(m); } };
}
// ---------- checkin (每日签到) ----------
const CHECKIN_PROVIDER_LABEL = { trae: 'Trae', workbuddy: 'WorkBuddy', qoder: 'Qoder 国际版', qodercn: 'Qoder 中国版', qwenwork: '千问办公' };
// 打开页面时自动向上游核对未签账号（节流 60s）：你在官方客户端已签过的账号，
// 网关发起一次签到会被上游幂等拒绝并回"已签到"，状态随即对齐为已签。
let checkinAutoVerifiedAt = 0;
async function autoVerifyCheckin(status) {
  const pending = status.accounts.filter(a => a.supported && a.enabled && !a.done);
  if (!pending.length || Date.now() - checkinAutoVerifiedAt < 60 * 1000) return;
  checkinAutoVerifiedAt = Date.now();
  toast(`正在向上游核对 ${pending.length} 个账号的签到状态…`);
  await api('/checkin/all', { method: 'POST', body: {} }).catch(() => {});
  if (PAGE === 'checkin') render('checkin');
}
async function renderCheckin(m) {
  const [st, cfg] = await Promise.all([api('/checkin/status'), api('/settings/checkin')]);
  const supported = st.accounts.filter(a => a.supported);
  const doneCount = supported.filter(a => a.done).length;
  const lastRun = st.lastRun ? new Date(st.lastRun.at).toLocaleString('zh-CN', { hour12: false }) : '尚未运行';
  const pending = supported.filter(a => a.enabled && !a.done).length;
  m.innerHTML = `
  ${pageHead('每日签到', '自动为各平台账号领取签到积分', `<a href="javascript:go('accounts')" style="font-size:13px">管理账号 →</a>`)}
  <div class="hint">
    <b>定时任务</b>：每天到达设定时刻自动为全部启用账号签到；服务白天启动时若当天还没签，会在启动后 20 秒自动补签。
    同一账号同一天只成功领一次（幂等，重复点不会重复拿积分）。
    <b>状态说明</b>：这里显示的是网关与上游核对后的结果——你在官方客户端自己签过的，打开本页会自动核对并同步为「已签」。
    ${st.running ? '<b>签到正在进行中…</b>' : ''}
  </div>
  <div class="statgrid">
    <div class="stat"><div class="l">今日已签</div><div class="v">${doneCount} <span class="muted" style="font-size:15px">/ ${supported.length}</span></div><div class="d">${pending ? `${pending} 个待核对` : '全部核对完毕'}</div></div>
    <div class="stat"><div class="l">上次运行</div><div class="v" style="font-size:16px">${esc(lastRun)}</div>
      <div class="d">${st.lastRun ? `成功领取 ${st.lastRun.claimed} · 已签 ${st.lastRun.already} · 失败 ${st.lastRun.failed}` : '当天未运行过'}</div></div>
    <div class="stat"><div class="l">定时设置</div><div class="v" style="font-size:16px">${cfg.enabled ? `每天 ${cfg.hour}:00` : '已关闭'}</div>
      <div class="d"><a href="javascript:go('settings')">修改 →</a></div></div>
  </div>
  <div class="toolbar">
    <button onclick="checkinAllAccounts()">立即签到全部</button>
    <span class="muted">已确认签到的账号会跳过；要重新核对某个账号，点它行内的「签到」</span>
  </div>
  <div class="table-wrap">
  <table><tr><th>平台</th><th>账号</th><th>今日状态</th><th>说明</th><th>操作</th></tr>
  ${st.accounts.map(a => {
    const plat = CHECKIN_PROVIDER_LABEL[a.provider_id] || a.provider_id;
    let statusHtml, msg = a.message || '';
    if (!a.supported) { statusHtml = badge('不支持', 'gray'); msg = '该平台无签到机制'; }
    else if (!a.enabled) { statusHtml = badge('已停用', 'gray'); }
    else if (a.done && a.gained > 0 && a.claimed) statusHtml = badge(`+${a.gained}`, 'green');
    else if (a.done) statusHtml = badge('已签', 'green');
    else statusHtml = badge('未签', 'yellow');
    return `<tr>
      <td>${esc(plat)} <span class="muted mono" style="font-size:11px">${esc(a.provider_id)}</span></td>
      <td><b>${esc(a.name)}</b></td>
      <td>${statusHtml}</td>
      <td class="muted" style="font-size:12px">${esc(msg)}</td>
      <td>${a.supported ? `<button class="small ghost" onclick="checkinAccount(${a.id})">签到</button>` : ''}</td>
    </tr>`;
  }).join('')}
  ${!st.accounts.length ? emptyRow(5, '📅', '暂无账号，先到「平台账号」页添加') : ''}
  </table></div>
  <div class="card">
    <h3 style="font-size:14px;margin-bottom:10px">最近签到记录</h3>
    ${st.recent.length ? `<table style="font-size:12.5px"><tr><th>时间</th><th>平台</th><th>账号</th><th>结果</th><th>说明</th></tr>
    ${st.recent.slice(0, 20).map(r => `<tr>
      <td class="muted mono">${fmtTime(r.ts)}</td>
      <td>${esc(CHECKIN_PROVIDER_LABEL[r.provider_id] || r.provider_id || '-')}</td>
      <td>${esc(r.account_name || r.account_id || '-')}</td>
      <td>${r.ok === 1 ? badge('成功', 'green') : r.ok === 2 ? badge('无内容', 'gray') : badge('失败', 'red')}</td>
      <td class="muted">${esc(r.message || '')}${r.gained ? ` <b style="color:var(--green)">+${r.gained}</b>` : ''}</td>
    </tr>`).join('')}</table>` : '<p class="muted">暂无记录</p>'}
  </div>`;
  autoVerifyCheckin(st);
}
async function checkinAllAccounts() {
  toast('正在为全部账号签到…');
  try {
    const r = await api('/checkin/all', { method: 'POST', body: {} });
    const lines = r.results.map(x => {
      const icon = x.ok === true ? (x.already ? '○' : '✓') : x.ok === false ? '✗' : '·';
      return `${icon} [${x.provider_id}] ${x.name}: ${x.message || 'ok'}`;
    });
    const okCount = r.results.filter(x => x.ok === true).length;
    const failed = r.results.filter(x => x.ok === false);
    openModal(`签到完成：${okCount}/${r.total} 成功${r.claimed != null ? `（本次领取 ${r.claimed}，已签过 ${r.already}）` : ''}`, `
      <p class="muted" style="margin-bottom:8px;font-size:12px">✓=本次领取成功　○=今日已签过　✗=失败　·=平台无签到/无活动</p>
      <div class="field" style="font-size:13px;line-height:2;max-height:320px;overflow:auto">${lines.map(esc).join('<br>')}</div>
      ${failed.length ? '<p class="muted" style="font-size:12px;color:var(--red)">失败通常是 token 过期（一键检测看看）或活动未开放；Qoder 派生身份可能被风控过滤，需客户端在线。</p>' : ''}
      <div class="row"><span class="spacer"></span><button onclick="closeModal();go('checkin')">好的</button></div>`, {});
  } catch (e) { toast(e.message, true); }
}
async function checkinAccount(id) {
  toast('签到中…');
  try {
    const r = await api(`/accounts/${id}/checkin`, { method: 'POST', body: {} });
    if (r.ok === true) toast(`✓ ${r.already ? r.message || '今日已签到' : (r.message || '签到成功')}`);
    else if (r.ok === null) toast('· ' + (r.message || '该账号当前无可签内容'));
    else toast('✗ ' + (r.message || '签到失败'), true);
    if (PAGE === 'checkin' || PAGE === 'accounts') render(PAGE);
  } catch (e) { toast(e.message, true); }
}

function summarizeExtra(extra) {
  if (!extra || typeof extra !== 'object') return '';
  const bits = [];
  if (extra.username) bits.push(extra.username);
  if (extra.email) bits.push(extra.email);
  if (extra.uid) bits.push(`uid ${String(extra.uid).slice(0, 10)}`);
  if (extra.credits != null) bits.push(`积分 ${extra.credits}/${extra.quota ?? '?'}`);
  if (extra.plan) bits.push(extra.plan);
  return bits.join(' · ');
}
/** 积分/信息列：结构化展示（进度条 + 明细） */
function creditCellHtml(extra) {
  if (!extra || typeof extra !== 'object') return '<span class="muted">同步后显示</span>';
  // 兼容历史嵌套数据（workbuddy 签到曾把 {credits,quota} 对象整体塞进 extra.credits）
  if (extra.credits && typeof extra.credits === 'object') {
    extra = { ...extra, credits: extra.credits.credits, quota: extra.credits.quota ?? extra.quota };
  }
  const parts = [];
  if (extra.credits != null && extra.quota != null && extra.quota > 0) {
    const pct = Math.min(100, Math.round(extra.credits / extra.quota * 100));
    const color = pct > 40 ? 'var(--green)' : pct > 10 ? 'var(--yellow)' : 'var(--red)';
    parts.push(`<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
      <b style="font-size:13px">${extra.credits}</b><span class="muted" style="font-size:11px">/ ${extra.quota}</span>
      <div class="pbar" style="max-width:90px"><i style="width:${pct}%;background:${color}"></i></div>
      <span class="muted" style="font-size:11px">${pct}%</span></div>`);
    if (extra.baseQuota || extra.addOnQuota) {
      parts.push(`<div class="muted" style="font-size:11px">${extra.baseQuota ? '基础 ' + extra.baseQuota : ''}${extra.baseQuota && extra.addOnQuota ? ' · ' : ''}${extra.addOnQuota ? '附加 ' + extra.addOnQuota : ''}</div>`);
    }
  } else if (extra.credits != null) {
    parts.push(`<b style="font-size:13px">积分 ${extra.credits}</b>`);
  }
  if (extra.username) parts.push(`<div class="muted" style="font-size:11px">${esc(extra.username)}${extra.userType ? ' · ' + esc(extra.userType) : ''}</div>`);
  if (extra.checkin?.claimable) parts.push(`<div style="font-size:11px"><span class="badge yellow">签到可领</span></div>`);
  if (!parts.length) return `<span class="muted">${esc(summarizeExtra(extra)) || '同步后显示'}</span>`;
  return parts.join('');
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
// 恢复在线目录（参照 dsh-llm-workbuddy 插件语义）：不追求上游报给账号的全部模型，
// 只取官方客户端实际显示的目录。支持在线目录的平台按账号取目录并替换列表；
// 官方 API / 本地渠道没有客户端目录，退化为 /v1/models 在线目录的增量同步。
async function restoreAccountModels(id, online) {
  if (online && !confirm('恢复在线目录？\n该平台现有模型列表会被替换为官方客户端当前显示的模型（自定义条目会被移除）。')) return;
  if (online) return resetOnlineAccount(id);
  return syncAccountModels(id);
}
async function resetOnlineAccount(id) {
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
  const supportsOAuth = !acct && ['workbuddy', 'qwenwork'].includes(p?.id); // platforms with device-flow login
  openModal(acct ? '编辑账号' : '添加账号', `
    <div class="field"><label>平台</label>
      <select id="afProvider" ${acct ? 'disabled' : ''}>${providers.map(x => `<option value="${x.id}" ${p?.id === x.id ? 'selected' : ''}>${esc(x.label)} (${x.id})</option>`).join('')}</select></div>
    ${supportsOAuth ? `
    <div class="card" style="background:var(--bg-soft);padding:14px 18px;margin-bottom:14px">
      <b style="font-size:13px">推荐：网页授权登录</b>
      <p class="muted" style="font-size:12px;margin:4px 0 10px">点击后自动打开 ${esc(p.label)} 授权页，登录成功后账号自动添加（无需手动填 token）。<b>轮询最长 10 分钟</b>：超时或你点取消即停止，服务器端不留任何后台轮询——登录成功与否都由这次点击驱动。</p>
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
    if (!acct && ['workbuddy', 'qwenwork'].includes(np?.id)) { mFormAccount(null, providers, np); return; }
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
  const providerOpts = providerOptgroups(providers, modelFilter.provider_id, true);
  const providerOptsAll = providerOptgroups(providers, modelFilter.provider_id, false);
  m.innerHTML = `
  ${pageHead(`模型管理 <span class="muted" style="font-size:13px">(${models.length})</span>`)}
  <div class="toolbar">
    <select id="mfProvider" style="width:170px"><option value="">全部平台</option>${providerOpts}</select>
    <input id="mfSearch" class="searchbox" placeholder="搜索模型名/标签…" value="${esc(modelFilter.search)}">
    <select id="mfEnabled" style="width:100px"><option value="">全部</option><option value="1" ${modelFilter.enabled === '1' ? 'selected' : ''}>仅启用</option><option value="0" ${modelFilter.enabled === '0' ? 'selected' : ''}>仅停用</option></select>
    <input id="mfTag" style="width:110px" placeholder="标签筛选" value="${esc(modelFilter.tag)}">
    <span class="spacer"></span>
    <select id="mfSyncSel" style="width:180px" title="把所选平台上该账号可用的模型拉取进网关（增量）"><option value="">同步模型：选择平台…</option><option value="__all">全部平台（逐个拉取）</option>${providerOptsAll}</select>
    <button class="ghost" id="mfSyncBtn" title="把所选平台账号在上游可用的模型同步进网关（增量，不删除已有）">开始同步</button>
    <button onclick="openModelForm()">＋ 手动添加</button>
  </div>
  <div class="toolbar" style="background:var(--bg-soft);border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 14px">
    <span class="muted">批量：</span>
    <label class="row" style="gap:5px;font-size:13px"><input type="checkbox" id="mfCheckAll" style="width:auto"> 全选本页</label>
    <button class="small ghost" onclick="batchModels('enable')">启用选中</button>
    <button class="small ghost" onclick="batchModels('disable')">禁用选中</button>
    <button class="small ghost danger" onclick="batchModels('delete')">删除选中</button>
    <span class="divider"></span>
    <button class="small ghost" onclick="batchScope('enable')">启用当前筛选</button>
    <button class="small ghost" onclick="batchScope('disable')">禁用当前筛选</button>
    <button class="small ghost" onclick="batchDevVariants()">隐藏 __dev 变体</button>
  </div>
  <div class="table-wrap">
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
        <button class="small ghost danger" onclick="delModel(${md.id})">删</button></td>
  </tr>`).join('')}
  ${!models.length ? emptyRow(10, '🧩', '暂无模型 — 添加账号后在上方选择平台「开始同步」，或手动添加') : ''}
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
    <div class="field"><label>平台</label><select id="mfProviderSel" ${md ? 'disabled' : ''}>${providerOptgroups(providers, md?.provider_id, false)}</select></div>
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
// 列表排序状态：key = name(对外名称)/targets(目标数)/ctx(上下文)/enabled/note，dir = 1升序 -1降序
let virtualSort = { key: 'name', dir: 1 };
let virtualSearch = '';
function virtualSortBy(key) {
  if (virtualSort.key === key) virtualSort.dir *= -1;
  else virtualSort = { key, dir: 1 };
  renderVirtual($('#main'));
}
/** 统一模型目标链：垂直列表（上=先尝试），每行带平台账号池健康点 */
function targetChainHtml(ts, health) {
  if (!ts.length) return '<span class="muted">无目标</span>';
  return `<div class="tchain">${ts.map((t, i) => {
    const h = health?.[t.provider_id] || 'none';
    const tip = { ok: '该平台有可用账号', warn: '该平台账号均在冷却中', bad: '该平台账号失效/被禁', none: '该平台暂无账号' }[h];
    return `<span class="tchip" title="${tip} · 优先级 ${t.priority ?? (i + 1) * 10}"><i>${i + 1}</i><span class="tdot ${h}"></span>${esc(t.provider_id)}/${esc(t.public_name)}</span>`;
  }).join('')}</div>`;
}
/** 统一模型标签 chips（自定义补充标签；能力标签由 capabilityHtml 自动推导，不占这里） */
function vtagChips(tags) {
  return String(tags || '').split(',').map(s => s.trim()).filter(t => t && !/^\d+k$/i.test(t))
    .map(t => `<span class="badge gray" style="cursor:pointer" title="点击筛选该标签" onclick="virtualSearch='${esc(t)}';renderVirtual($('#main'))">${esc(t)}</span>`).join(' ');
}
/**
 * 统一模型能力徽章：从目标链各平台真实模型的 tags/ctx_window 自动推导（显示上游真相）。
 * ctx = 各目标里的最大上下文；思考/图片/工具 = 任一目标支持即可（推理时取可用超集）。
 */
function capabilityHtml(ts, modelIndex) {
  if (!ts.length) return '<span class="muted">-</span>';
  let maxCtx = 0, thinking = false, vision = false, tools = false;
  for (const t of ts) {
    const row = modelIndex[`${t.provider_id}/${t.public_name}`];
    if (!row) continue;
    if (row.ctx_window > maxCtx) maxCtx = row.ctx_window;
    const tags = String(row.tags || '');
    if (/thinking/.test(tags)) thinking = true;
    if (/vision/.test(tags)) vision = true;
    if (/tools/.test(tags)) tools = true;
  }
  const ctxBadge = maxCtx
    ? `<span class="badge purple" title="目标链中最长上下文：${(maxCtx/1000).toFixed(0)}k tokens">${maxCtx >= 1000000 ? (maxCtx/1000000) + 'M' : Math.round(maxCtx/1000) + 'k'} 上下文</span>`
    : '';
  return [ctxBadge,
    thinking ? '<span class="badge blue" title="至少一个目标平台支持思考模式（-think / reasoning）">思考</span>' : '',
    vision ? '<span class="badge green" title="至少一个目标平台支持图片输入（vision）">图片</span>' : '',
    tools ? '<span class="badge yellow" title="至少一个目标平台支持工具调用（function calling）">工具</span>' : '',
  ].filter(Boolean).join(' ') || '<span class="muted">-</span>';
}
async function renderVirtual(m) {
  const [virtuals, targets, presets, accounts, models] = await Promise.all([
    api('/virtual-models'), api('/virtual-models/targets'), api('/virtual-models/presets'), api('/accounts'), api('/models?size=5000'),
  ]);
  const byProvider = {};
  for (const t of targets) (byProvider[t.provider_id] = byProvider[t.provider_id] || []).push(t.public_name);
  // provider/public_name → 真实模型行（推导能力用，__dev 变体不参与）
  const modelIndex = {};
  for (const md of models) {
    if (String(md.public_name).endsWith('__dev')) continue;
    modelIndex[`${md.provider_id}/${md.public_name}`] = md;
  }
  // 平台健康：active=ok；只有 cooling=warn；只有 invalid/banned=bad；没账号=none
  const health = {};
  for (const a of accounts) {
    const cur = health[a.provider_id];
    const rank = { ok: 0, warn: 1, bad: 2, none: 3 };
    const st = a.status === 'active' ? 'ok' : a.status === 'cooling' ? 'warn' : 'bad';
    if (cur == null || rank[st] < rank[cur]) health[a.provider_id] = st; // 取最好状态
  }
  // 搜索筛选（名称/目标平台/目标模型/备注/标签）
  const q = (virtualSearch || '').toLowerCase();
  const rows = virtuals
    .map(v => {
      const ts = JSON.parse(v.targets || '[]').sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
      return { ...v, _ts: ts, _n: ts.length };
    })
    .filter(v => !q || v.public_name.toLowerCase().includes(q)
      || v._ts.some(t => t.provider_id.toLowerCase().includes(q) || String(t.public_name).toLowerCase().includes(q))
      || String(v.note || '').toLowerCase().includes(q)
      || String(v.tags || '').toLowerCase().includes(q));
  // 排序：名称用 localeCompare，目标数/数字直接比，备注空值排最后
  const { key, dir } = virtualSort;
  rows.sort((a, b) => {
    let c;
    if (key === 'name') c = a.public_name.localeCompare(b.public_name, 'zh-CN');
    else if (key === 'targets') c = a._n - b._n;
    else if (key === 'enabled') c = (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0);
    else if (key === 'ctx') {
      const ctx = v => Math.max(0, ...v._ts.map(t => modelIndex[`${t.provider_id}/${t.public_name}`]?.ctx_window || 0));
      c = ctx(b) - ctx(a); // 上下文长的在前更符合直觉；dir 仍可反转
    }
    else if (key === 'tags') c = String(a.tags || '').localeCompare(String(b.tags || ''), 'zh-CN');
    else c = String(a.note || '').localeCompare(String(b.note || ''), 'zh-CN');
    return c * dir;
  });
  m.innerHTML = `
  ${pageHead(`统一模型 <span class="muted" style="font-size:13px">(${virtuals.length}${q ? ` · 筛出 ${rows.length}` : ''})</span>`, '点击表头排序')}
  <div class="hint">统一模型把多个平台的真实模型聚合成一个对外名称：客户端请求它时，网关按目标顺序依次尝试，<b>失败自动切换下一个</b>。也可以用来改名（如对外叫 <span class="mono">gpt-4o</span>，实际走 DeepSeek/GLM）。与「模型管理」里的直接模型相互独立，都可通过 /v1/models 看到。<b>能力列</b>由目标链各平台真实模型自动推导（上下文取最长；思考/图片/工具任一目标支持即亮）。目标前的圆点 = 该平台账号池健康（<span class="tdot ok" style="display:inline-block;vertical-align:middle"></span> 可用 · <span class="tdot warn" style="display:inline-block;vertical-align:middle"></span> 冷却 · <span class="tdot bad" style="display:inline-block;vertical-align:middle"></span> 失效 · <span class="tdot none" style="display:inline-block;vertical-align:middle"></span> 无账号）。</div>
  <div class="toolbar">
    <input id="vSearch" class="searchbox" placeholder="搜索名称/平台/标签/备注…" value="${esc(virtualSearch)}">
    <span class="muted">快速创建（同名多平台聚合）：</span>
    <select id="vpSel" style="width:230px"><option value="">选择预设…</option>
      ${presets.filter(p => p.multiProvider).map(p => `<option value="${esc(p.base)}">${esc(p.base)}（${p.targets.length} 平台: ${esc(p.providers.join(','))}）</option>`).join('')}
    </select>
    <button class="ghost" id="vpCreate" title="按预设聚合：每个平台一个目标；具体用哪个账号由该平台的账号池按优先级/轮询决定，无需逐账号配置">一键创建</button>
    <button class="ghost" id="vpCreateAll" title="把下方列表里所有「同名且 ≥2 平台」的预设一次性全部创建为统一模型（已存在的跳过）">⚡ 一键创建全部（${presets.filter(p => p.multiProvider).length}）</button>
    <span class="spacer"></span>
    <button onclick="openVirtualForm()">＋ 自定义</button>
  </div>
  <div class="table-wrap">
  <table><tr>
    ${sortTh('对外名称', 'name')}
    ${sortTh('目标链（上→下 = 尝试顺序）', 'targets')}
    ${sortTh('能力', 'ctx')}
    ${sortTh('启用', 'enabled')}
    ${sortTh('备注', 'note')}
    <th>操作</th></tr>
  ${rows.map(v => `<tr>
    <td class="mono"><b>${esc(v.public_name)}</b><div class="muted" style="font-size:11px">${v._n} 个目标${v.tags ? ' · ' + vtagChips(v.tags) : ''}</div></td>
    <td>${targetChainHtml(v._ts, health)}</td>
    <td>${capabilityHtml(v._ts, modelIndex)}</td>
    <td>${switchHtml(v.enabled, `toggleVirtual('${esc(v.public_name)}', ${v.enabled ? 0 : 1})`)}</td>
    <td class="muted" style="max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(v.note || '')}</td>
    <td style="white-space:nowrap">
      <button class="small ghost" onclick="openVirtualForm('${esc(v.public_name)}')">编辑</button>
      <button class="small ghost danger" onclick="delVirtual('${esc(v.public_name)}')">删</button></td>
  </tr>`).join('')}
  ${!rows.length ? emptyRow(6, '🔀', q ? '没有匹配的统一模型' : '暂无统一模型 — 用上方预设一键创建，或「自定义」') : ''}
  </table></div>`;
  window._virtualTargets = byProvider;
  $('#vSearch').onkeydown = e => { if (e.key === 'Enter') { virtualSearch = e.target.value; renderVirtual(m); } };
  $('#vpCreate').onclick = async () => {
    const base = $('#vpSel').value;
    if (!base) return toast('先选一个预设', true);
    const p = presets.find(x => x.base === base);
    try {
      await api('/virtual-models', { method: 'POST', body: { public_name: base, targets: p.targets.map((t, i) => ({ ...t, priority: (i + 1) * 10 })) } });
      toast(`✓ 已创建统一模型 ${base}（${p.targets.length} 平台）`); go('virtual');
    } catch (e) { toast(e.message, true); }
  };
  $('#vpCreateAll').onclick = async () => {
    if (!confirm('把所有同名多平台预设一次性创建为统一模型？已存在的同名统一模型会跳过。')) return;
    try {
      const r = await api('/virtual-models/create-all', { method: 'POST' });
      toast(`✓ 已创建 ${r.created.length} 个统一模型${r.skipped.length ? `（${r.skipped.length} 个已存在跳过）` : ''}`);
      if (r.created.length) openModal('✓ 一键创建完成', `
        <div class="field" style="font-size:13px;line-height:2">${r.created.map(n => `✓ <span class="mono">${esc(n)}</span>`).join('<br>') || '<span class="muted">没有新的可创建（都已存在）</span>'}</div>
        <div class="row"><span class="spacer"></span><button onclick="closeModal();go('virtual')">好的</button></div>`, {});
      go('virtual');
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
      <button class="small ghost" onclick="addVirtualTargetRow()">＋ 添加目标</button></div>
    <div class="field"><label>标签（逗号分隔，用于筛选）</label><input id="vfTags" value="${esc(v?.tags || '')}" placeholder="如 free,coding"></div>
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
  const body = { public_name: $('#vfName').value.trim(), targets, note: $('#vfNote').value, tags: $('#vfTags').value };
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
  ${pageHead(`API Keys <span class="muted" style="font-size:13px">(${keys.length})</span>`, 'harness 工具用这些 key 调用本网关')}
  <div class="toolbar">
    <input id="kSearch" class="searchbox" placeholder="搜索…" value="${esc(keySearch)}">
    <span class="spacer"></span><button onclick="openKeyForm()">＋ 生成 Key</button>
  </div>
  <div class="table-wrap">
  <table><tr><th>名称</th><th>Key</th><th>允许模型</th><th>RPM</th><th>日限(积分)</th><th>最近使用</th><th>启用</th><th>操作</th></tr>
  ${keys.map(k => `<tr>
    <td><b>${esc(k.name || '(未命名)')}</b></td>
    <td class="mono muted">${esc(k.key)}</td>
    <td class="mono" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(k.allowed_models)}</td>
    <td>${k.rpm_limit || '∞'}</td><td>${k.daily_limit || '∞'}</td>
    <td class="muted">${fmtTime(k.last_used_at)}</td>
    <td>${switchHtml(k.enabled, `toggleKey(${k.id}, ${k.enabled ? 0 : 1})`)}</td>
    <td><button class="small ghost" onclick="openKeyForm(${k.id})">编辑</button>
        <button class="small ghost danger" onclick="delKey(${k.id})">删</button></td>
  </tr>`).join('')}
  ${!keys.length ? emptyRow(8, '🔑', '暂无 key — 不创建任何 key 时网关为开放模式（仅建议本机使用）') : ''}
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
      <label class="row" style="gap:6px;font-size:13px;margin-bottom:8px"><input type="checkbox" id="kfAll" style="width:auto" ${isAll ? 'checked' : ''} onchange="kfToggleAll(this)"> 全部模型（不限制）</label>
      <div id="kfPicker" style="${isAll ? 'display:none' : ''}">
        <input id="kfSearch" placeholder="输入筛选（如 glm、kimi、qoder…）" oninput="kfRenderList()" style="margin-bottom:8px">
        <div id="kfList" style="max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;background:var(--bg-soft)"></div>
        <p class="muted" style="margin-top:6px" id="kfCount"></p>
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
    <label class="row" style="gap:6px;font-size:13px;padding:3px 6px;cursor:pointer;border-radius:4px">
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
    <p style="margin-bottom:10px">请立即复制保存：</p>
    <pre class="mono" id="keyShow">${esc(key)}</pre>
    <div class="row" style="margin-top:14px"><span class="spacer"></span>
    <button onclick="navigator.clipboard.writeText('${key}');toast('已复制')">复制</button>
    <button class="ghost" onclick="closeModal()">完成</button></div>`, {});
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
  const maxDim = Math.max(1, chart.byModel[0]?.reqs || 1, chart.byProvider[0]?.reqs || 1);
  const bar = (v, color = 'var(--accent)') => `<div class="pbar" style="max-width:none;width:100%"><i style="width:${Math.round(v / maxDim * 100)}%;background:${color}"></i></div>`;
  const dimTable = (title, rows, cols) => !rows.length ? '' : `
    <div style="flex:1;min-width:260px">
      <h4 style="font-size:13px;margin-bottom:8px;color:var(--text-dim)">${title}</h4>
      <table style="font-size:12.5px">${rows.map(r => `<tr>
        <td class="mono" style="padding:4px 8px 4px 0;white-space:nowrap">${esc(r.key)}${r.key.includes('#') || /^\d+$/.test(r.key) ? badge('账号', 'gray') : ''}</td>
        ${cols.map(c => `<td style="padding:4px 10px 4px 0;color:var(--muted)">${c(r)}</td>`).join('')}
        <td style="width:34%">${bar(r.reqs)}</td>
      </tr>`).join('')}</table>
    </div>`;
  m.innerHTML = `
  ${pageHead('用量日志')}
  <div class="card">
    <div class="toolbar" style="margin-bottom:10px">
      <h3 style="font-size:14px;margin:0">趋势</h3>
      <span class="spacer"></span>
      <select id="ucHours" style="width:130px">
        ${[[24, '最近 24 小时'], [48, '最近 48 小时'], [168, '最近 7 天'], [720, '最近 30 天']].map(([v, l]) => `<option value="${v}" ${usageChartHours === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    ${chartHtml(chart, 120)}
  </div>
  <div class="card" style="display:flex;gap:26px;flex-wrap:wrap">
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
  <div class="table-wrap">
  <table><tr><th>时间</th><th>平台</th><th>账号</th><th>模型</th><th>输入</th><th>输出</th><th>积分</th><th>耗时</th><th>状态</th></tr>
  ${usage.rows.map(u => `<tr>
    <td class="muted mono">${fmtTime(u.ts)}</td><td>${esc(u.provider_id || '')}</td><td>#${u.account_id ?? '-'}</td>
    <td class="mono">${esc(u.public_model || '')}</td><td>${u.input_tokens}</td><td>${u.output_tokens}</td>
    <td>${u.credits ? u.credits.toFixed(3) : '-'}</td><td>${u.latency_ms}ms</td>
    <td>${u.status < 400 ? badge(u.status, 'green') : badge(u.status + (u.error ? ' ' + u.error.slice(0, 40) : ''), 'red')}</td>
  </tr>`).join('')}
  ${!usage.rows.length ? emptyRow(9, '📈', '暂无请求') : ''}
  </table>
  <div class="pager" style="padding:0 14px 14px">共 ${usage.total} 条
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
  ${pageHead(`MCP 服务 <span class="muted" style="font-size:13px">(${servers.length})</span>`)}
  <div class="hint">客户端 MCP 配置：JSON-RPC over HTTP，端点 <span class="mono badge blue">http://localhost:8317/mcp</span>。添加的 MCP 服务器的工具会聚合在此端点暴露（工具名 <span class="mono">服务id__工具名</span>）。</div>
  <div class="toolbar"><span class="spacer"></span><button onclick="openMcpForm()">＋ 添加 MCP 服务</button></div>
  <div class="table-wrap">
  <table><tr><th>ID</th><th>传输</th><th>目标</th><th>工具过滤</th><th>启用</th><th>操作</th></tr>
  ${servers.map(s => `<tr>
    <td class="mono"><b>${esc(s.id)}</b></td>
    <td>${badge(s.transport, s.transport === 'stdio' ? 'purple' : 'blue')}</td>
    <td class="mono muted" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(s.transport === 'stdio' ? s.command + ' ' + (s.args || []).join(' ') : s.url)}</td>
    <td class="mono">${esc(s.tool_filter)}</td>
    <td>${switchHtml(s.enabled, `toggleMcp('${esc(s.id)}', ${s.enabled ? 0 : 1})`)}</td>
    <td><button class="small ghost" onclick="listMcpTools('${esc(s.id)}')">列出工具</button>
        <button class="small ghost" onclick="openMcpForm('${esc(s.id)}')">编辑</button>
        <button class="small ghost danger" onclick="delMcp('${esc(s.id)}')">删</button></td>
  </tr>`).join('')}
  ${!servers.length ? emptyRow(6, '🔌', '暂无 MCP 服务 — 可接入本地 npx 服务器或远程 http MCP') : ''}
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

// ---------- playground (测试台) ----------
// 后端 /admin/api/test/chat 支持 forceAccountId —— 直接指定账号测试，绕过轮询
async function renderPlayground(m) {
  const [providers, accounts, models, virtuals] = await Promise.all([
    api('/providers'), api('/accounts'), api('/models?size=2000'), api('/virtual-models'),
  ]);
  const enabledModels = models.filter(md => md.enabled);
  const byProvider = {};
  for (const md of enabledModels) (byProvider[md.provider_id] = byProvider[md.provider_id] || []).push(md);
  window._pg = { accounts, models: byProvider, virtuals };
  m.innerHTML = `
  ${pageHead('测试台', '模拟 harness 工具接入；每次请求的完整内容在「请求详情」可见')}
  <div class="card">
    <div class="row" style="margin-bottom:10px;flex-wrap:wrap">
      <select id="pgProvider" style="width:170px" onchange="pgProviderChange()">
        <option value="">选择平台…</option>
        <option value="__virtual">统一模型</option>
        ${groupProviders(providers).map(g => `<optgroup label="${esc(g.name)}">${g.providers.filter(p => (window._pg.models[p.id]?.length || 0) > 0).map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}</optgroup>`).join('')}
      </select>
      <select id="pgAccount" style="width:170px" onchange="pgAccountChange()"><option value="">自动轮询</option></select>
      <select id="pgModel" style="width:230px"><option value="">先选平台…</option></select>
      <select id="pgProtocol" style="width:190px" onchange="pgUpdateEndpoint()" title="三种主流 harness 协议，网关全支持并自动转换到各平台">
        <option value="chat">协议: OpenAI Chat</option>
        <option value="responses">协议: OpenAI Responses</option>
        <option value="anthropic">协议: Anthropic Messages</option>
      </select>
      <span class="spacer"></span>
      <button id="pgSend" onclick="pgSend()" style="flex-shrink:0">发送</button>
    </div>
    <details style="margin-bottom:10px">
      <summary style="cursor:pointer;color:var(--muted);font-size:13px">请求参数（可修改，随请求发送）</summary>
      <div class="row" style="gap:10px;flex-wrap:wrap;margin-top:10px">
        <div class="field" style="width:130px;margin:0"><label>temperature</label><input id="pgTemp" type="number" step="0.1" min="0" max="2" value="0.7"></div>
        <div class="field" style="width:130px;margin:0"><label>top_p</label><input id="pgTopP" type="number" step="0.1" min="0" max="1" value="1"></div>
        <div class="field" style="width:150px;margin:0"><label>max_tokens（空=默认）</label><input id="pgMaxTok" type="number" min="1" placeholder="默认"></div>
        <div class="field" style="width:170px;margin:0"><label>思考深度 reasoning</label>
          <select id="pgReasoning"><option value="">默认（不发）</option><option value="think">开 (-think)</option><option value="think-high">高 (-think-high)</option><option value="xhigh">最高 (-xhigh)</option><option value="nothink">关 (-nothink)</option></select></div>
        <div style="flex:1;min-width:220px"><label style="font-size:12px;color:var(--text-dim)">system 提示词（可选）</label>
        <input id="pgSystem" placeholder="如：你是一个简洁的助手" style="margin-top:2px"></div>
      </div>
    </details>
    <div class="row" style="margin-bottom:10px;gap:14px;flex-wrap:wrap;font-size:13px">
      <label class="row" style="gap:5px" title="流式：服务器边生成边推（SSE/NDJSON），harness 工具大多用这个；非流式：等全部生成完一次性返回 JSON">
        <input type="checkbox" id="pgStream" style="width:auto" checked> 流式</label>
      <label class="row" style="gap:5px"><input type="checkbox" id="pgShowRaw" style="width:auto" onchange="pgRenderOut()"> 显示原始事件</label>
      <label class="row" style="gap:5px"><input type="checkbox" id="pgDetails" style="width:auto" checked onchange="pgRenderOut()"> 请求详情</label>
      <span class="spacer"></span>
      <span id="pgEndpoint" class="muted mono" style="font-size:12px"></span>
    </div>
    <textarea id="pgPrompt" rows="4" style="resize:vertical" placeholder="输入测试消息…">你好，请用一句话介绍你自己。</textarea>
  </div>
  <div class="card" id="pgOut" style="min-height:120px"><div class="empty"><span class="ico">🧪</span>配置上方并点「发送」— 结果与请求详情显示在这里（布局固定，不会跳动）</div></div>`;
  pgProviderChange();
}
function pgProviderChange() {
  const pid = $('#pgProvider').value;
  const acctSel = $('#pgAccount'), modelSel = $('#pgModel');
  // accounts of this provider
  const accts = (window._pg.accounts || []).filter(a => a.provider_id === pid && a.enabled);
  acctSel.innerHTML = `<option value="">自动轮询（该平台 ${accts.length} 个账号）</option>` +
    accts.map(a => `<option value="${a.id}">${esc(a.name)}${a.extra?.username ? ' · ' + esc(a.extra.username) : ''}</option>`).join('');
  // models of this provider + virtual models (platform = virtual)
  const list = pid === '__virtual' ? (window._pg.virtuals || []).map(v => ({ public_name: v.public_name, provider_id: 'virtual' }))
    : (window._pg.models[pid] || []);
  modelSel.innerHTML = `<option value="">选模型…</option>` + list.map(md =>
    `<option value="${esc(md.public_name)}">${esc(md.public_name)}${md.is_free ? ' · 免费' : ''}${md.multiplier && md.multiplier !== 1 ? ' · x' + md.multiplier : ''}</option>`).join('');
  pgUpdateEndpoint();
}
function pgAccountChange() { pgUpdateEndpoint(); }
function pgUpdateEndpoint() {
  const model = $('#pgModel').value;
  const acct = $('#pgAccount').value;
  const proto = $('#pgProtocol')?.value || 'chat';
  if (!model) { $('#pgEndpoint').textContent = ''; return; }
  const ep = { chat: 'POST /v1/chat/completions', responses: 'POST /v1/responses', anthropic: 'POST /v1/messages' }[proto];
  const auth = proto === 'anthropic' ? 'x-api-key' : 'Authorization: Bearer';
  $('#pgEndpoint').textContent = `${ep}  model=${model}${acct ? '  账号#' + acct : '  自动'}  (${auth})`;
}
function pgRenderOut() {
  // rerender from cached state after detail toggles (no layout jump: output card is fixed)
  const st = window._pgState;
  if (!st) return;
  const out = $('#pgOut');
  let html = '';
  if ($('#pgDetails').checked) {
    html += `<details open style="margin-bottom:14px"><summary style="cursor:pointer;color:var(--muted);font-size:13px">请求详情（模拟 harness 发送的完整请求）</summary>
    <pre class="mono" style="margin-top:10px;max-height:260px">${esc(st.requestPreview)}</pre></details>`;
  }
  html += st.statusHtml;
  if ($('#pgShowRaw').checked && st.rawEvents?.length) {
    html += `<details style="margin-top:14px"><summary style="cursor:pointer;color:var(--muted);font-size:13px">原始流事件 (${st.rawEvents.length} 条)</summary>
    <pre class="mono" style="margin-top:10px;max-height:300px">${esc(st.rawEvents.join('\n').slice(0, 20000))}</pre></details>`;
  }
  out.innerHTML = html;
  const pre = out.querySelector('#pgLive');
  if (pre && st.liveText != null) pre.textContent = st.liveText;
}
let pgBusy = false;
function pgBuildParams() {
  const p = {};
  const temp = parseFloat($('#pgTemp')?.value);
  const topP = parseFloat($('#pgTopP')?.value);
  const maxTok = parseInt($('#pgMaxTok')?.value);
  if (!isNaN(temp)) p.temperature = temp;
  if (!isNaN(topP)) p.top_p = topP;
  if (maxTok > 0) p.max_tokens = maxTok;
  const reason = $('#pgReasoning')?.value;
  if (reason === 'think') p.reasoning_effort = 'medium';
  else if (reason === 'think-high') p.reasoning_effort = 'high';
  else if (reason === 'xhigh') p.reasoning_effort = 'xhigh';
  else if (reason === 'nothink') p.reasoning_effort = 'none';
  return p;
}
async function pgSend() {
  if (pgBusy) return;
  const model = $('#pgModel').value;
  const prompt = $('#pgPrompt').value.trim();
  const accountId = $('#pgAccount').value || null;
  const protocol = $('#pgProtocol')?.value || 'chat';
  const system = $('#pgSystem')?.value?.trim() || '';
  if (!model || !prompt) return toast('请选择平台和模型并输入内容', true);
  const sendBtn = $('#pgSend');
  pgBusy = true; sendBtn.disabled = true;
  const t0 = performance.now();
  const stream = $('#pgStream').checked;
  const params = pgBuildParams();
  const messages = [{ role: 'user', content: prompt }];
  const wireBody = protocol === 'responses'
    ? { model, stream, input: messages, instructions: system || undefined, reasoning: params.reasoning_effort ? { effort: params.reasoning_effort === 'none' ? 'low' : params.reasoning_effort } : undefined, max_output_tokens: params.max_tokens || undefined, temperature: params.temperature, top_p: params.top_p }
    : protocol === 'anthropic'
      ? { model, stream, max_tokens: params.max_tokens || 1024, system: system || undefined, messages, temperature: params.temperature, top_p: params.top_p }
      : { model, stream, messages: system ? [{ role: 'system', content: system }, ...messages] : messages, ...params };
  Object.keys(wireBody).forEach(k => wireBody[k] === undefined && delete wireBody[k]);
  const requestPreview = `POST ${protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions'}\nAuthorization: Bearer sk-dsh-****\nContent-Type: application/json\n\n` +
    JSON.stringify(wireBody, null, 2);
  window._pgState = { requestPreview, rawEvents: [], liveText: '', statusHtml: '<p class="muted">请求中…</p>', protocol };
  pgRenderOut();
  try {
    if (stream) {
      const resp = await fetch('/admin/api/test/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
        body: JSON.stringify({ model, messages, stream: true, forceAccountId: accountId ? Number(accountId) : null, params, protocol, system }) });
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '', usageLine = '';
      const st = window._pgState;
      st.statusHtml = `<pre class="mono" id="pgLive" style="white-space:pre-wrap;max-height:420px;overflow:auto;min-height:60px"></pre><p class="muted" id="pgMeta" style="margin-top:10px">接收中…</p>`;
      pgRenderOut();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (!line) continue;
          st.rawEvents.push(line.length > 500 ? line.slice(0, 500) + '…' : line);
          try {
            const j = JSON.parse(line);
            if (j.anthropicEvent) {
              const ev = j.anthropicEvent;
              if (ev.type === 'content_block_delta') {
                if (ev.delta?.type === 'text_delta') st.liveText += ev.delta.text;
                if (ev.delta?.type === 'thinking_delta') st.liveText += ev.delta.thinking;
              }
              if (ev.type === 'message_delta') usageLine = `Anthropic 流完成 · stop=${ev.delta?.stop_reason}`;
            } else if (j.responsesEvent) {
              const ev = j.responsesEvent;
              if (ev.type === 'response.output_text.delta') st.liveText += ev.delta;
              if (ev.type === 'response.reasoning_summary_text.delta') st.liveText += ev.delta;
              if (ev.type === 'response.completed') usageLine = `Responses 流完成 · 输出 ${ev.response?.output_text?.length || 0} 字`;
            } else if (j.raw) {
              try {
                const ev = JSON.parse(j.raw);
                const d = ev.choices?.[0]?.delta || {};
                if (d.content) st.liveText += d.content;
                if (d.reasoning_content) st.liveText += d.reasoning_content;
              } catch {}
            }
            if (j.error) st.liveText += '\n[错误] ' + j.error;
            if (j.done) usageLine = `完成 ${(performance.now() - t0).toFixed(0)}ms · 输入 ${j.usage?.input_tokens || 0} tok / 输出 ${j.usage?.output_tokens || 0} tok · 积分 ${(j.usage?.credits || 0).toFixed(3)}`;
          } catch {}
        }
        const pre = $('#pgLive');
        if (pre) pre.textContent = st.liveText || '(等待响应…)';
      }
      st.statusHtml = `<pre class="mono" style="white-space:pre-wrap;max-height:420px;overflow:auto">${esc(st.liveText) || '<span class="muted">(空响应)</span>'}</pre><p class="muted" style="margin-top:10px">${esc(usageLine || '流结束')} · ${{ chat: 'chat SSE/NDJSON', responses: 'Responses 事件流', anthropic: 'Anthropic content blocks' }[protocol]}</p>`;
      pgRenderOut();
    } else {
      const r = await api('/test/chat', { method: 'POST', body: { model, messages, forceAccountId: accountId ? Number(accountId) : null, params, protocol, system } });
      const st = window._pgState;
      if (protocol === 'responses' && r.ok) {
        st.liveText = r.response?.output_text || '';
        st.statusHtml = `<pre class="mono" style="white-space:pre-wrap;max-height:420px;overflow:auto">${esc(st.liveText)}</pre>
          <p class="muted" style="margin-top:10px">${r.latency_ms}ms · status=${r.response?.status} · 输入 ${r.response?.usage?.input_tokens} tok / 输出 ${r.response?.usage?.output_tokens} tok</p>
          <details style="margin-top:10px"><summary style="cursor:pointer;color:var(--muted);font-size:13px">完整 response 对象（ChatGPT Responses 格式）</summary>
          <pre class="mono" style="margin-top:10px;max-height:300px">${esc(JSON.stringify(r.response, null, 2))}</pre></details>`;
      } else if (protocol === 'anthropic' && r.ok) {
        const msg = r.message || {};
        st.liveText = (msg.content || []).map(b => b.type === 'thinking' ? '[思考] ' + b.thinking : b.text).join('\n\n');
        st.statusHtml = `<pre class="mono" style="white-space:pre-wrap;max-height:420px;overflow:auto">${esc((msg.content || []).map(b => b.type === 'thinking' ? '〔思考〕' + b.thinking : b.text).join('\n\n──\n\n'))}</pre>
          <p class="muted" style="margin-top:10px">${r.latency_ms}ms · stop=${msg.stop_reason} · 输入 ${msg.usage?.input_tokens} tok / 输出 ${msg.usage?.output_tokens} tok · content 块: ${(msg.content || []).map(b => b.type).join(', ') || '-'}</p>
          <details style="margin-top:10px"><summary style="cursor:pointer;color:var(--muted);font-size:13px">完整 message 对象（Anthropic Messages 格式）</summary>
          <pre class="mono" style="margin-top:10px;max-height:300px">${esc(JSON.stringify(msg, null, 2))}</pre></details>`;
      } else if (r.ok) {
        st.liveText = r.text;
        st.statusHtml = `<pre class="mono" style="white-space:pre-wrap;max-height:420px;overflow:auto">${esc(r.text)}</pre><p class="muted" style="margin-top:10px">${r.latency_ms}ms · 输入 ${r.usage.input_tokens} tok / 输出 ${r.usage.output_tokens} tok · 积分 ${(r.usage.credits || 0).toFixed(3)}</p>`;
      } else {
        st.statusHtml = `<pre style="color:var(--red);white-space:pre-wrap">${esc(r.error)}${r.status ? ' (HTTP ' + r.status + ')' : ''}</pre>`;
      }
      pgRenderOut();
    }
  } catch (e) {
    window._pgState.statusHtml = `<pre style="color:var(--red)">${esc(e.message)}</pre>`;
    pgRenderOut();
  }
  pgBusy = false; sendBtn.disabled = false;
}

// ---------- docs (文档教程：教人 + 教 AI 对接) ----------
async function renderDocs(m) {
  const d = await api('/docs');
  const keyHint = d.openGateway ? '（当前未创建任何 Key，网关为开放模式；下面的示例中 Authorization 一行可省略）'
    : `（用你自己的 key 替换，当前可用的 Key：${d.keyNames.map(esc).join('、')} — 完整 key 只在创建时显示过）`;
  const curlEx = `curl ${d.base}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk-dsh-你的key" \\
  -d '{
    "model": "${esc(d.sampleModel)}",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'`;
  const pyEx = `from openai import OpenAI

client = OpenAI(base_url="${d.base}/v1", api_key="sk-dsh-你的key")

resp = client.chat.completions.create(
    model="${esc(d.sampleModel)}",          # 模型列表见 GET /v1/models
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in resp:
    delta = chunk.choices[0].delta
    if delta and delta.content:
        print(delta.content, end="", flush=True)`;
  const ccEx = `# Claude Code（Anthropic 协议，网关自动转换）
set ANTHROPIC_BASE_URL=${d.base}
set ANTHROPIC_AUTH_TOKEN=sk-dsh-你的key
set ANTHROPIC_MODEL=${esc(d.sampleModel)}
claude`;
  const aiPrompt = `请把下面的 AI 网关接入到当前项目的开发工具里，并验证可用：

网关地址：${d.base}（OpenAI 兼容 + Anthropic 兼容）
- OpenAI 协议：\`${d.base}/v1/chat/completions\`（也有 \`/v1/responses\`、\`/v1/models\`）
- Anthropic 协议：\`${d.base}/v1/messages\`（Claude Code 等工具用 \`ANTHROPIC_BASE_URL=${d.base}\`）
- API Key：sk-dsh-***（用户会提供完整值；放入 \`Authorization: Bearer\` 头；Anthropic 工具放 \`ANTHROPIC_AUTH_TOKEN\`）
- 模型：先请求 \`GET ${d.base}/v1/models\` 拿到可用列表（当前共 ${d.modelCount} 个，统一模型 ${d.virtualCount} 个），示例 model 名：\`${esc(d.sampleModel)}\`
- 流式：请求体传 \`"stream": true\`，响应为 SSE（\`data: {...}\\n\\n\`，以 \`data: [DONE]\` 结束）
- 验证：发一条最小对话请求确认能返回内容，失败时把上游错误原样上报给用户

要求：不要硬编码密钥到代码仓库，从环境变量读取（如 \`OPENAI_BASE_URL\`/\`OPENAI_API_KEY\`）。`;

  m.innerHTML = `
  ${pageHead('文档教程', '给人看的接入指南 + 给 AI 看的对接说明')}
  <div class="docgrid">
    <div class="doccard">
      <h4>① 概念：这套网关是什么</h4>
      <ul>
        <li>把多个 AI 平台（Trae / CodeBuddy / Qoder / 千问 / 千问办公 + 各官方 API）的账号<b>聚合成一套标准 API</b></li>
        <li>三种协议都支持：<code>OpenAI Chat</code>、<code>OpenAI Responses</code>（Codex）、<code>Anthropic Messages</code>（Claude Code）</li>
        <li><b>统一模型</b> = 同名模型多平台聚合，一个平台挂了自动切下一个</li>
        <li>模型名后缀控制思考：<code>-think</code> / <code>-think-high</code> / <code>-nothink</code></li>
      </ul>
    </div>
    <div class="doccard">
      <h4>② 人用：三步接入任意工具</h4>
      <ol>
        <li>「平台账号」页 → 添加账号 / 扫描本机登录</li>
        <li>「模型管理」页 → 选平台点「开始同步」拉取模型；「统一模型」页可一键聚合</li>
        <li>「API Keys」页 → 生成一个 key，然后在工具里填：</li>
      </ol>
      <div class="kv" style="margin-top:10px">
        <span class="muted">OpenAI 工具</span><span class="mono">${d.base}/v1</span>
        <span class="muted">Claude Code</span><span class="mono">ANTHROPIC_BASE_URL=${d.base}</span>
        <span class="muted">MCP 客户端</span><span class="mono">${d.base}/mcp</span>
      </div>
      <p class="muted" style="margin-top:8px;font-size:12px">${keyHint}</p>
    </div>
    <div class="doccard">
      <h4>③ 快速验证（curl）</h4>
      <div class="copypre"><pre class="mono" id="docCurl">${esc(curlEx)}</pre>
      <button class="small ghost copybtn" onclick="copyDoc('docCurl')">复制</button></div>
    </div>
  </div>
  <div class="docgrid">
    <div class="doccard">
      <h4>Python（openai SDK）</h4>
      <div class="copypre"><pre class="mono" id="docPy">${esc(pyEx)}</pre>
      <button class="small ghost copybtn" onclick="copyDoc('docPy')">复制</button></div>
    </div>
    <div class="doccard">
      <h4>Claude Code（Windows CMD）</h4>
      <div class="copypre"><pre class="mono" id="docCC">${esc(ccEx)}</pre>
      <button class="small ghost copybtn" onclick="copyDoc('docCC')">复制</button></div>
      <p class="muted" style="margin-top:8px;font-size:12px">其他工具同理：凡支持自定义 OpenAI base_url 的（Cline / Cursor / LobeChat / Dify…），base 填 <span class="mono">${d.base}/v1</span>，key 填网关 key。</p>
    </div>
  </div>
  <div class="card">
    <h4 style="font-size:13.5px;margin-bottom:8px">④ 教 AI 怎么对接（把下面这段发给任何 AI 助手，它就知道怎么接）</h4>
    <div class="copypre"><pre class="mono" id="docAI" style="white-space:pre-wrap;max-height:340px">${esc(aiPrompt)}</pre>
    <button class="small ghost copybtn" onclick="copyDoc('docAI')">复制</button></div>
    <div class="aiex" style="margin-top:14px">
      <b>更省事的用法：</b>本页信息已做成 AI 可读端点 —— 让 AI 自己请求
      <span class="mono">${d.base}/docs/api.md</span>（无需登录），它会拿到完整对接说明和实时模型列表。
      例如对本 AI 说：「打开 ${d.base}/docs/api.md 按里面的说明把网关接入你正在写的工具」。
    </div>
  </div>
  <div class="card">
    <h4 style="font-size:13.5px;margin-bottom:10px">⑤ 常见问题</h4>
    <table>
      <tr><td style="width:220px"><b>401 Invalid API key</b></td><td class="muted">key 没填对或被停用；「API Keys」页检查。一个 key 都没有时网关是开放模式（无需 key）。</td></tr>
      <tr><td><b>403 model not allowed</b></td><td class="muted">该 key 的「允许模型」白名单没包含这个模型；编辑 key 改成「全部模型」或加上它。</td></tr>
      <tr><td><b>503 no healthy account</b></td><td class="muted">该平台所有账号失效/冷却中；「平台账号」页一键检测，或重新扫码。</td></tr>
      <tr><td><b>模型列表里没有想要的</b></td><td class="muted">「模型管理」→ 选平台「开始同步」；或账号行「恢复在线目录」（与官方客户端显示的目录一致；逆向平台会替换现有列表，官方 API 为增量补充）。</td></tr>
      <tr><td><b>Qoder 账号提示缺 PAT</b></td><td class="muted">Qoder 聊天通道必须用 PAT：客户端 → 设置 → 集成/Integrations 创建（pt- 开头），在账号里编辑填入。本机扫描到的登录态只能查积分，不能对话，已不再自动导入。</td></tr>
      <tr><td><b>千问办公账号失效</b></td><td class="muted">access token 约 7 天过期；配置了 Refresh Token 会自动续期。彻底失效时重开千问办公客户端登录一次，再点「扫描本机登录」重新导入；或在添加账号弹窗里用「网页授权登录」（设备码流程，无需客户端）。聊天需本机装有千问办公客户端（签名用官方 wasm）。</td></tr>
    </table>
  </div>`;
}
function copyDoc(id) {
  const text = document.getElementById(id)?.textContent || '';
  navigator.clipboard.writeText(text).then(() => toast('已复制到剪贴板')).catch(() => {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove(); toast('已复制到剪贴板');
  });
}

// ---------- settings ----------
async function renderSettings(m) {
  const [s, ar, ck] = await Promise.all([api('/settings'), api('/settings/auto-refresh'), api('/settings/checkin')]);
  m.innerHTML = `
  ${pageHead('设置')}
  <div class="card">
    <h3 style="font-size:14px;margin-bottom:12px">自动签到 <span class="muted" style="font-size:12px;font-weight:400">— 每天定时为全部启用账号领取平台签到积分（Trae / WorkBuddy / Qoder / 千问办公）</span></h3>
    <div class="row" style="max-width:540px;flex-wrap:wrap">
      <select id="stCheckinEnabled" style="width:160px">
        <option value="1" ${ck.enabled ? 'selected' : ''}>开启</option>
        <option value="0" ${!ck.enabled ? 'selected' : ''}>关闭</option>
      </select>
      <select id="stCheckinHour" style="width:160px">
        ${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${ck.hour === h ? 'selected' : ''}>每天 ${String(h).padStart(2, '0')}:00</option>`).join('')}
      </select>
      <button onclick="saveCheckin()">保存</button>
      <span class="muted" style="font-size:12px">服务当天中途启动会自动补签；进度见「每日签到」页</span>
    </div>
  </div>
  <div class="card">
    <h3 style="font-size:14px;margin-bottom:12px">模型自动刷新 <span class="muted" style="font-size:12px;font-weight:400">— 各公司模型更新很快，定时同步保持模型列表最新</span></h3>
    <div class="row" style="max-width:420px">
      <select id="stAutoRefresh" style="width:200px">
        <option value="0" ${ar.minutes === 0 ? 'selected' : ''}>关闭（手动同步）</option>
        ${[15, 30, 60, 120, 360, 720].map(v => `<option value="${v}" ${ar.minutes === v ? 'selected' : ''}>每 ${v < 60 ? v + ' 分钟' : (v / 60) + ' 小时'}</option>`).join('')}
      </select>
      <button onclick="saveAutoRefresh()">保存</button>
    </div>
  </div>
  <div class="card">
    <h3 style="font-size:14px;margin-bottom:12px">修改管理密码</h3>
    <div class="row" style="max-width:420px">
      <input type="password" id="stPw" placeholder="新密码">
      <button onclick="savePw()">保存</button>
    </div>
  </div>
  <div class="card">
    <h3 style="font-size:14px;margin-bottom:12px">接入信息</h3>
    <div class="kv">
      <span class="muted">OpenAI 端点</span><span class="mono">http://localhost:8317/v1/chat/completions</span>
      <span class="muted">Responses 端点</span><span class="mono">http://localhost:8317/v1/responses（Codex 等）</span>
      <span class="muted">Anthropic 端点</span><span class="mono">http://localhost:8317/v1/messages</span>
      <span class="muted">模型列表</span><span class="mono">http://localhost:8317/v1/models</span>
      <span class="muted">MCP 端点</span><span class="mono">http://localhost:8317/mcp</span>
      <span class="muted">思考控制</span><span class="mono">模型名后缀 -think / -think-high / -xhigh / -nothink</span>
      <span class="muted">网关状态</span><span>${s.gatewayOpen ? badge('开放模式（未设置任何 key）','yellow') : badge('需要 API Key','green')}</span>
    </div>
    <p class="muted" style="margin-top:10px">环境变量：DSH_PORT / DSH_ADMIN_PASSWORD / DSH_API_KEYS（逗号分隔）/ DSH_DATA_DIR</p>
  </div>
  <div class="card">
    <h3 style="font-size:14px;margin-bottom:12px">最近日志</h3>
    <pre id="logPre" style="max-height:300px">加载中…</pre>
    <button class="small ghost" style="margin-top:10px" onclick="loadLogs()">刷新</button>
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
async function saveCheckin() {
  try {
    const r = await api('/settings/checkin', { method: 'PUT', body: { enabled: $('#stCheckinEnabled').value === '1', hour: Number($('#stCheckinHour').value) } });
    toast(r.enabled ? `✓ 自动签到已开启：每天 ${String(r.hour).padStart(2, '0')}:00` : '自动签到已关闭');
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
