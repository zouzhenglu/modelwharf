'use strict';
/**
 * 自动签到调度 — 每日为所有账号领取平台签到积分。
 *
 * 各平台的签到协议由 provider 插件自己实现（checkin(account)），这里只负责：
 *  - 调度：每天固定时刻（默认 09:00）跑一轮；启动时补签（当天没跑过就立即跑，
 *    否则服务白天重启就永远错过当天的签到）
 *  - 去重：同一账号同一天只成功签一次（失败不记，下轮/下次启动重试）
 *  - 记录：checkin_log 表留痕，面板展示结果
 *
 * 插件接口（可选实现，没有该方法视为平台无签到，静默跳过）：
 *   async checkin(account) -> { ok: boolean, already?: boolean, skipped?: boolean,
 *                               message: string, gained?: number }
 * 插件判为 ok=false 时，core 会用 alreadyCheckinSignal() 复查插件挂出的原始上游
 * 响应（r.raw / err.raw，{status,json,text} 形态），命中「已签到」幂等信号则改判
 * 为已签——各平台表达"已签"的形态不一（HTTP 400/409 + 业务码/文案），统一在这兜底。
 */
const { db, getSetting, setSetting } = require('../store');
const registry = require('./registry');
const accountsCore = require('./accounts');
const logger = require('../logger');

let timer = null;
let running = false;

/** 今天（本地时区）的日期串，用作签到去重 key */
function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function logCheckin({ provider_id, account_id, account_name, ok, message, gained }) {
  db.prepare('INSERT INTO checkin_log(provider_id,account_id,account_name,ok,message,gained) VALUES(?,?,?,?,?,?)')
    .run(provider_id, account_id, account_name, ok ? 1 : 0, message || null, gained ?? null);
}

/**
 * 各平台「今日已签到」的幂等信号——形态不一（2026-10-15 实测）：
 *  - workbuddy: HTTP 400 + {"code":10001,"msg":"今天已签到，请明天再来"}
 *  - qoder: HTTP 409 或 {"failureCode":"ALREADY_CLAIMED"} / {"status":"CLAIMED","replayed":true}
 *  - trae: HTTP 200 + {code!=0, message:"已签到"}（部分场景 claim 也可能直接 4xx）
 * r 是 httpJson 的返回 {status, json, text}。
 */
function alreadyCheckinSignal(r) {
  if (!r) return false;
  const j = r.json && typeof r.json === 'object' ? r.json : null;
  const msgs = [j?.message, j?.msg, j?.error, j?.error?.message, j?.errorMessage];
  if (msgs.some(m => typeof m === 'string' && /已签到|已经签到|已领取|already/i.test(m))) return true;
  const codes = [j?.errorCode, j?.failureCode];
  if (codes.some(c => typeof c === 'string' && /ALREADY|REPLAY/i.test(c))) return true;
  if (j?.status === 'CLAIMED' && j?.replayed) return true;
  if (Number(j?.code) === 10001) return true; // workbuddy "今天已签到"
  if (typeof r.text === 'string' && /已签到|已经签到/i.test(r.text)) return true; // 4xx 文案兜底
  return false;
}

/** 该账号今天是否已成功签过（含"上游确认已签"） */
function alreadyDoneToday(accountId) {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  return !!db.prepare('SELECT 1 FROM checkin_log WHERE account_id=? AND ok=1 AND ts>=? LIMIT 1')
    .get(accountId, Math.floor(dayStart.getTime() / 1000));
}

/** 对单个账号签到。skipIfDone=true 时今天已签的直接跳过（定时轮用；手动点强制重试） */
async function checkinAccount(account, { skipIfDone = true } = {}) {
  if (skipIfDone && alreadyDoneToday(account.id)) {
    return { ok: true, already: true, skipped: true, message: '今日已签到（本地记录）' };
  }
  const plugin = registry.get(account.provider_id);
  if (!plugin || typeof plugin.checkin !== 'function') {
    return { ok: null, skipped: true, message: '该平台不支持签到' };
  }
  let r;
  try {
    r = await plugin.checkin(account);
  } catch (e) {
    r = { ok: false, message: e.message, raw: e.raw || e.upstream };
  }
  // 插件报失败时，用统一信号复查上游响应：命中「已签到」幂等信号改判为已签
  // （用户在官方客户端签过、平台回 HTTP 400/409 + 已签到文案的场景）
  if (r.ok === false && alreadyCheckinSignal(r.raw)) {
    r = { ok: true, already: true, gained: 0, message: '今日已签到（上游确认）', extra: r.extra };
  }  // ok=null 表示平台侧没有可签的东西（无活动/接口不存在），不算失败但也别反复重试
  // ok: 1=成功领取/上游确认已签, 0=失败, 2=已核对但无内容（无活动/接口不存在）
  logCheckin({
    provider_id: account.provider_id, account_id: account.id, account_name: account.name,
    ok: r.ok === true ? 1 : r.ok === false ? 0 : 2, message: r.message, gained: r.gained,
  });
  // 签到通常会刷新积分余额 —— 把插件顺带带回的 extra 合并进账号档案
  if (r.extra) {
    db.prepare('UPDATE accounts SET extra=? WHERE id=?').run(JSON.stringify({ ...account.extra, ...r.extra }), account.id);
  }
  return r;
}

/** 全量签到：所有启用账号并发跑一轮。返回逐账号结果。 */
async function checkinAll({ skipIfDone = true } = {}) {
  if (running) return { busy: true, results: [] };
  running = true;
  try {
    const all = accountsCore.listAccounts(null, { includeDisabled: false });
    const settled = await Promise.allSettled(all.map(a => checkinAccount(a, { skipIfDone })));
    const results = settled.map((s, i) => {
      const a = all[i];
      if (s.status === 'fulfilled') return { id: a.id, provider_id: a.provider_id, name: a.name, ...s.value };
      return { id: a.id, provider_id: a.provider_id, name: a.name, ok: false, message: s.reason?.message || String(s.reason) };
    });
    const claimed = results.filter(r => r.ok === true && !r.already && !r.skipped).length;
    const already = results.filter(r => r.already).length;
    const failed = results.filter(r => r.ok === false).length;
    logger.info(`[checkin] done: ${claimed} claimed, ${already} already, ${failed} failed, ${results.length} total`);
    setSetting('checkinLastRun', { at: Date.now(), day: todayKey(), claimed, already, failed, total: results.length });
    return { busy: false, claimed, already, failed, total: results.length, results };
  } finally {
    running = false;
  }
}

/** 查询面板用的状态：今日结果 + 最近日志 + 配置 */
function status() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const accounts = db.prepare('SELECT id, provider_id, name, enabled, status FROM accounts ORDER BY provider_id, priority, id').all();
  const todayRows = db.prepare('SELECT account_id, ok, message, gained FROM checkin_log WHERE ts>=?')
    .all(Math.floor(dayStart.getTime() / 1000));
  const byAccount = new Map();
  for (const r of todayRows) {
    // 同一天可能多次尝试：成功(1) > 已核对无内容(2) > 失败(0)，取最好的一次展示
    const rank = (v) => (v === 1 ? 2 : v === 2 ? 1 : 0);
    const cur = byAccount.get(r.account_id);
    if (!cur || rank(r.ok) > rank(cur.ok)) byAccount.set(r.account_id, r);
  }
  return {
    enabled: !!Number(getSetting('checkinEnabled', 1)),
    hour: Number(getSetting('checkinHour', 9)),
    lastRun: getSetting('checkinLastRun', null),
    running,
    today: { claimed: todayRows.filter(r => r.ok === 1 && r.gained > 0).length, ok: [...byAccount.values()].filter(r => r.ok === 1 || r.ok === 2).length },
    accounts: accounts.map(a => {
      const r = byAccount.get(a.id);
      return {
        id: a.id, provider_id: a.provider_id, name: a.name, enabled: !!a.enabled,
        supported: typeof registry.get(a.provider_id)?.checkin === 'function',
        done: !!(r && (r.ok === 1 || r.ok === 2)),
        claimed: !!(r && r.ok === 1 && !r.message?.includes('已签')),
        message: r?.message || null,
        gained: r?.gained ?? null,
      };
    }),
    recent: db.prepare('SELECT * FROM checkin_log ORDER BY id DESC LIMIT 50').all(),
  };
}

// ---------- scheduler ----------

function setup() {
  if (timer) { clearInterval(timer); timer = null; }
  if (!Number(getSetting('checkinEnabled', 1))) return;
  const hour = Math.min(23, Math.max(0, Number(getSetting('checkinHour', 9))));
  // 每小时整点检查一次：到了签到小时且当天还没跑过就触发（进程不常驻也能靠启动补签兜底）
  timer = setInterval(() => {
    const now = new Date();
    if (now.getHours() !== hour) return;
    const last = getSetting('checkinLastRun', null);
    if (last && last.day === todayKey()) return;
    logger.info(`[checkin] scheduled run starting (${todayKey()} ${hour}:00)`);
    checkinAll({ skipIfDone: true }).catch(e => logger.warn(`[checkin] scheduled run failed: ${e.message}`));
  }, 10 * 60 * 1000);
  // 启动补签：当天没成功跑过就立即补（对常驻进程：整点检查永远赶不上当天时刻时的兜底）
  const last = getSetting('checkinLastRun', null);
  if (!last || last.day !== todayKey()) {
    // 延迟 20s：等网络栈/账号池就绪，也避免和启动扫描抢上游
    setTimeout(() => {
      logger.info('[checkin] startup catch-up run');
      checkinAll({ skipIfDone: true }).catch(e => logger.warn(`[checkin] catch-up failed: ${e.message}`));
    }, 20 * 1000);
  }
  logger.info(`[checkin] scheduler on — daily at ${hour}:00, catch-up on start if not yet run today`);
}

module.exports = { checkinAccount, checkinAll, status, setup, todayKey };
