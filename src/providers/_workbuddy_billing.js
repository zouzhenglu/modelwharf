'use strict';
/**
 * WorkBuddy（CodeBuddy 中国区）账号档案与计费查询。
 *
 * 算法对齐 @axiaohungry/dsh-llm-workbuddy@1.3.27 的 workbuddy-credits.js /
 * workbuddy-auth.js（本机已安装版本），修正旧实现的几个硬伤：
 *   1. 不再按 CapacityUnit==='credits' 过滤（字段缺失时会把整包跳过，显示 0）
 *   2. 优先读 *Precise / SlicePeriod* / Cycle* 字段，而不是只看 CapacityRemain
 *   3. 展开 SlicePeriodUsageDetails 子套餐并按 packageCode+到期时间合并
 *   4. 用 12 个到期字段判断过期包
 *   5. 企业账号走 get-enterprise-user-usage（额度 = limitNum - credit）
 *   6. 补今日请求量与积分消耗（get-user-request-usage，分页汇总）
 *
 * 文件名以下划线开头：registry 只加载 src/providers 下非下划线文件作为 provider。
 */
const DEFAULT_BILLING_HOST = 'https://www.codebuddy.cn';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const ENTERPRISE_EDITIONS = new Set(['ultimate', 'exclusive']);
const MAX_USAGE_PAGES = 100;
const PAGE_SIZE = 100;

const REMAINING_FIELDS = [
  'SlicePeriodCapacityRemainPrecise', 'SlicePeriodCapacityRemain',
  'CycleCapacityRemainPrecise', 'CycleCapacityRemain',
  'CapacityRemainPrecise', 'CapacityRemain',
  'RemainPrecise', 'Remain', 'Remaining', 'Balance',
];
const CYCLE_REMAIN_FIELDS = [
  'CycleCapacityRemainPrecise', 'CycleCapacityRemain',
  'CapacityRemainPrecise', 'CapacityRemain',
];
const TOTAL_FIELDS = [
  'SlicePeriodCapacitySizePrecise', 'SlicePeriodCapacitySize',
  'CycleCapacitySizePrecise', 'CycleCapacitySize',
  'CycleCapacityPrecise', 'CycleCapacity',
  'CapacityPrecise', 'Capacity',
  'TotalCapacityPrecise', 'TotalCapacity',
  'PackageCapacity', 'Quota', 'Amount',
];
const CYCLE_TOTAL_FIELDS = [
  'CycleCapacitySizePrecise', 'CycleCapacitySize',
  'CycleCapacityPrecise', 'CycleCapacity',
  'CapacityPrecise', 'Capacity',
];
const EXPIRY_FIELDS = [
  'DeductionEndTime', 'ExpiredTime', 'SlicePeriodEndTime', 'PackageEndTime',
  'EndTime', 'CycleEndTime', 'ExpireTime', 'ExpirationTime',
  'ValidEndTime', 'ValidPeriodEndTime', 'EndAt', 'ExpireAt',
];
const LABEL_FIELDS = ['PackageName', 'PackageTypeName', 'AccountName', 'ProductName', 'Name', 'RuleName', 'Description'];

// ---------- 小工具 ----------

function firstNumber(value, fields) {
  for (const field of fields) {
    const raw = value?.[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const number = Number(raw);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function firstText(value, fields) {
  for (const field of fields) {
    const text = value?.[field];
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

function parseTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return number < 1e12 ? Math.round(number * 1000) : Math.round(number);
  }
  const parsed = Date.parse(String(value).replace(/^(\d{4}-\d\d-\d\d)\s+/, '$1T'));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstTimestamp(value, fields) {
  for (const field of fields) {
    const parsed = parseTimestamp(value?.[field]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function pad2(value) { return String(value).padStart(2, '0'); }

function formatLocalDateTime(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function localDateString(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function normalizeHost(value) {
  const fallback = new URL(DEFAULT_BILLING_HOST);
  if (typeof value !== 'string' || !value.trim()) return fallback.origin;
  try {
    const candidate = new URL(value.includes('://') ? value : `https://${value}`);
    if (candidate.protocol !== 'https:') return fallback.origin;
    const host = candidate.hostname.toLowerCase();
    if (!['codebuddy.cn', 'www.codebuddy.cn', 'workbuddy.cn', 'www.workbuddy.cn'].includes(host)) return fallback.origin;
    return candidate.origin;
  } catch {
    return fallback.origin;
  }
}

// ---------- 身份归一化 ----------
// 参考 workbuddy-auth.js:normalizeAccount()：账号接口在不同版本返回过扁平对象、
// 包一层 account/user/userInfo/profile/data 的对象，统一摊平后取值，JWT claims 兜底。

function decodeTokenClaims(token) {
  if (typeof token !== 'string' || !token.includes('.')) return {};
  try {
    const payload = token.split('.')[1];
    if (!payload) return {};
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function textValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/**
 * @param {object} raw  account/login/account 接口返回（可能多层包裹）
 * @param {string} token access token（取 JWT claims 用）
 */
function normalizeAccountIdentity(raw, token) {
  const sources = [
    raw,
    raw?.account,
    raw?.user,
    raw?.userInfo,
    raw?.profile,
    raw?.data,
    raw?.data?.account,
    raw?.data?.user,
    raw?.data?.userInfo,
  ].filter(source => source && typeof source === 'object');
  const read = (...keys) => textValue(...sources.flatMap(source => keys.map(key => source[key])));
  const claims = decodeTokenClaims(token);
  const userId = read('userId', 'uid', 'user_id', 'id')
    ?? textValue(claims.userId, claims.uid, claims.user_id, claims.sub);
  const enterpriseId = read('enterpriseId', 'tenantId', 'enterprise_id', 'tenant_id')
    ?? textValue(claims.enterpriseId, claims.tenantId, claims.enterprise_id, claims.tenant_id);
  const email = read('email', 'mail', 'emailAddress')
    ?? textValue(claims.email, claims.mail);
  const uin = read('uin', 'phoneNumber', 'phone', 'mobile', 'mobilePhone')
    ?? textValue(claims.uin, claims.phoneNumber, claims.phone_number, claims.mobile);
  const type = read('type', 'accountType', 'account_type')
    ?? textValue(claims.type, claims.accountType);
  const displayName = read('displayName', 'name', 'nickname', 'username', 'accountName')
    ?? uin
    ?? textValue(claims.displayName, claims.name, claims.nickname, claims.username, claims.preferred_username)
    ?? email;
  return {
    ...(userId ? { userId } : {}),
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(email ? { email } : {}),
    ...(uin ? { uin } : {}),
    ...(type ? { type } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

function accountEnterpriseId(account) {
  const extra = account?.extra && typeof account.extra === 'object' ? account.extra : {};
  const credentials = account?.credentials && typeof account.credentials === 'object' ? account.credentials : {};
  return textValue(credentials.enterpriseId, extra.enterpriseId, credentials.tenantId, extra.tenantId);
}

function accountEdition(account) {
  const extra = account?.extra && typeof account.extra === 'object' ? account.extra : {};
  const credentials = account?.credentials && typeof account.credentials === 'object' ? account.credentials : {};
  return (textValue(extra.type, credentials.type, extra.accountType) || '').toLowerCase();
}

// ---------- 请求 ----------

function billingHeaders(account, host, enterpriseId) {
  const credentials = account?.credentials || {};
  const extra = account?.extra || {};
  const token = typeof credentials.token === 'string' ? credentials.token.trim() : '';
  if (!token) throw new Error('WorkBuddy 登录令牌为空');
  const headers = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'x-client-platform': 'web',
    origin: host,
    referer: `${host}/profile/plans-usage`,
    authorization: `Bearer ${token}`,
    'user-agent': BROWSER_USER_AGENT,
  };
  const domain = textValue(credentials.domain, extra.domain) || 'www.codebuddy.cn';
  headers['x-domain'] = domain;
  const userId = textValue(credentials.userId, extra.userId, extra.uid);
  if (userId) headers['x-user-id'] = userId;
  if (enterpriseId) {
    headers['x-enterprise-id'] = String(enterpriseId);
    headers['x-tenant-id'] = String(enterpriseId);
  }
  return headers;
}

function timeoutSignal(timeoutMs, externalSignal) {
  if (externalSignal) return externalSignal;
  if (typeof AbortSignal?.timeout === 'function') return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

async function readJson(response, action) {
  const raw = await response.text();
  if (!raw.trim()) throw new Error(`${action}返回空响应（HTTP ${response.status}）`);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${action}返回了无法解析的数据`, { cause: error });
  }
  if (!response.ok) throw new Error(`${action} HTTP ${response.status}: ${raw.slice(0, 160)}`);
  if (payload?.code !== undefined && payload?.code !== null && payload.code !== 0) {
    throw new Error(`${action}失败（${payload.msg ?? payload.message ?? `code=${payload.code}`}）`);
  }
  return payload;
}

async function postJson(url, account, body, action, options = {}, enterpriseId) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: billingHeaders(account, options.host || DEFAULT_BILLING_HOST, enterpriseId),
    body: JSON.stringify(body),
    signal: timeoutSignal(options.timeoutMs ?? 12_000, options.signal),
  });
  return readJson(response, action);
}

// ---------- 个人积分 ----------

function extractAccounts(payload) {
  const candidates = [
    payload?.data?.Response?.Data?.Accounts,
    payload?.data?.data?.Response?.Data?.Accounts,
    payload?.data?.accounts,
    payload?.data?.data?.accounts,
    payload?.Response?.Data?.Accounts,
  ];
  return candidates.find(Array.isArray) ?? [];
}

function extractCreditSegments(accounts, source = '积分') {
  return (Array.isArray(accounts) ? accounts : [])
    .flatMap(account => {
      const details = Array.isArray(account?.SlicePeriodUsageDetails) && account.SlicePeriodUsageDetails.length
        ? account.SlicePeriodUsageDetails.map(detail => ({ ...account, ...detail }))
        : [account];
      return details.map(item => {
        const remaining = firstNumber(item, REMAINING_FIELDS);
        if (remaining === null || remaining <= 0) return null;
        const total = firstNumber(item, TOTAL_FIELDS);
        return {
          remaining: round2(remaining),
          total: round2(total === null ? remaining : Math.max(total, remaining)),
          expiresAt: firstTimestamp(item, EXPIRY_FIELDS),
          source: firstText(item, LABEL_FIELDS) || source,
          packageCode: item?.PackageCode ? String(item.PackageCode) : '',
        };
      });
    })
    .filter(Boolean);
}

function sortSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .filter(segment => segment && Number(segment.remaining) > 0)
    .map(segment => ({
      remaining: round2(segment.remaining),
      total: round2(segment.total || segment.remaining),
      expiresAt: segment.expiresAt === null || segment.expiresAt === undefined ? null : Number(segment.expiresAt),
      source: String(segment.source || '积分'),
      packageCode: String(segment.packageCode || ''),
    }))
    .sort((left, right) => {
      if (left.expiresAt === null && right.expiresAt !== null) return 1;
      if (left.expiresAt !== null && right.expiresAt === null) return -1;
      return (left.expiresAt || 0) - (right.expiresAt || 0);
    });
}

function mergeSegments(segments) {
  const merged = new Map();
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!segment || Number(segment.remaining) <= 0) continue;
    const key = [segment.packageCode || segment.source || '积分', segment.expiresAt ?? 'unknown'].join('|');
    const previous = merged.get(key);
    if (previous) {
      previous.remaining += Number(segment.remaining) || 0;
      previous.total += Number(segment.total || segment.remaining) || 0;
    } else {
      merged.set(key, {
        remaining: Number(segment.remaining) || 0,
        total: Number(segment.total || segment.remaining) || 0,
        expiresAt: segment.expiresAt === undefined ? null : segment.expiresAt,
        source: String(segment.source || '积分'),
        packageCode: String(segment.packageCode || ''),
      });
    }
  }
  return sortSegments(Array.from(merged.values()));
}

function buildCreditResourceBody(now = new Date()) {
  const end = new Date(now.getTime());
  end.setFullYear(end.getFullYear() + 101);
  const format = date => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  return {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: format(now),
    PackageEndTimeRangeEnd: format(end),
  };
}

async function queryPersonalCredits(account, options = {}) {
  const host = options.host || DEFAULT_BILLING_HOST;
  const payload = await postJson(`${host}/v2/billing/meter/get-user-resource`, account, buildCreditResourceBody(), 'WorkBuddy 积分接口', { ...options, host });
  const accounts = extractAccounts(payload);
  // credits：每个账号取一次 Cycle 级剩余（Slice 子段是同一周期内的切片，重复相加会翻倍）
  let credits = 0;
  let quota = 0;
  for (const item of accounts) {
    const remaining = firstNumber(item, CYCLE_REMAIN_FIELDS);
    if (remaining !== null) credits += remaining;
    const size = firstNumber(item, CYCLE_TOTAL_FIELDS);
    if (size !== null && size > 0) quota += size;
  }
  const segments = mergeSegments(extractCreditSegments(accounts));
  // 接口只返回 Slice 字段、没有 Cycle 字段时，用分段剩余/总额兜底
  if (!accounts.some(item => firstNumber(item, CYCLE_REMAIN_FIELDS) !== null) && segments.length) {
    credits = segments.reduce((sum, segment) => sum + segment.remaining, 0);
  }
  if (quota <= 0 && segments.length) quota = round2(segments.reduce((sum, segment) => sum + segment.total, 0));
  return {
    credits: round2(credits),
    quota: round2(quota),
    count: accounts.length,
    totalDosage: payload?.data?.Response?.Data?.TotalDosage ?? payload?.data?.data?.Response?.Data?.TotalDosage ?? null,
    segments,
    unlimited: false,
    cycleResetTime: null,
    mode: 'personal',
  };
}

// ---------- 企业积分 ----------

function enterpriseUsage(payload) {
  const candidates = [payload?.data, payload?.data?.data, payload?.data?.Response?.Data, payload];
  const data = candidates.find(value => value && typeof value === 'object' && ('limitNum' in value || 'LimitNum' in value));
  if (!data) return null;
  const limitNum = Number(data.limitNum ?? data.LimitNum);
  if (!Number.isFinite(limitNum)) return null;
  const reset = firstTimestamp(data, ['cycleResetTime', 'CycleResetTime', 'CycleResetTimeMs']);
  if (limitNum === -1) {
    return { unlimited: true, credits: null, quota: null, count: 0, segments: [], cycleResetTime: reset, mode: 'enterprise' };
  }
  const used = Number(data.credit ?? data.Credit);
  const credits = Math.max(0, limitNum - (Number.isFinite(used) ? used : 0));
  return {
    unlimited: false,
    credits: round2(credits),
    quota: round2(limitNum),
    count: 1,
    segments: sortSegments([{ remaining: credits, total: limitNum, expiresAt: reset, source: '企业配额' }]),
    cycleResetTime: reset,
    mode: 'enterprise',
  };
}

async function resolveEnterpriseId(account, options = {}) {
  const credentials = account?.credentials || {};
  const extra = account?.extra || {};
  const userId = textValue(credentials.userId, extra.userId, extra.uid);
  if (!userId) return '';
  const host = options.host || DEFAULT_BILLING_HOST;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await fetchImpl(`${host}/console/accounts`, {
    method: 'GET',
    headers: billingHeaders(account, host),
    signal: timeoutSignal(options.timeoutMs ?? 8_000, options.signal),
  });
  const payload = await readJson(response, 'WorkBuddy 企业账号接口');
  const accounts = payload?.data?.accounts;
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  return typeof first?.enterpriseId === 'string' ? first.enterpriseId.trim() : '';
}

async function queryEnterpriseCredits(account, enterpriseId, options = {}) {
  const host = options.host || DEFAULT_BILLING_HOST;
  const payload = await postJson(`${host}/v2/billing/meter/get-enterprise-user-usage`, account, {}, 'WorkBuddy 企业积分接口', { ...options, host }, enterpriseId);
  const parsed = enterpriseUsage(payload);
  if (!parsed) throw new Error('WorkBuddy 企业积分接口返回数据无法解析');
  return parsed;
}

// ---------- 今日用量 ----------

function usageRows(payload) {
  const data = payload?.data;
  const rows = data && Array.isArray(data.data) ? data.data : data && Array.isArray(data.rows) ? data.rows : [];
  const total = Number(data?.total);
  return { rows, total: Number.isSafeInteger(total) && total >= 0 ? total : rows.length };
}

async function queryTodayUsage(account, options = {}) {
  const now = new Date();
  const start = new Date(now.getTime());
  start.setHours(0, 0, 0, 0);
  const host = options.host || DEFAULT_BILLING_HOST;
  const records = [];
  let expectedTotal = null;
  let fetched = 0;
  for (let pageNum = 1; pageNum <= MAX_USAGE_PAGES; pageNum += 1) {
    const payload = await postJson(`${host}/billing/meter/get-user-request-usage`, account, {
      startTime: formatLocalDateTime(start),
      endTime: formatLocalDateTime(now),
      pageNum,
      pageSize: PAGE_SIZE,
    }, 'WorkBuddy 今日请求量接口', { ...options, host, timeoutMs: options.usageTimeoutMs ?? 8_000 });
    const page = usageRows(payload);
    if (expectedTotal === null) expectedTotal = page.total;
    if (!page.rows.length) break;
    for (const row of page.rows) {
      const requestTime = parseTimestamp(row?.requestTime ?? row?.RequestTime ?? row?.createdAt);
      const credit = Number(row?.credit ?? row?.Credit ?? 0);
      if (requestTime === null || !Number.isFinite(credit) || credit < 0) continue;
      records.push({ requestTime, credit });
    }
    fetched += page.rows.length;
    if (fetched >= expectedTotal || page.rows.length < PAGE_SIZE) break;
  }
  const used = records.reduce((sum, record) => sum + record.credit, 0);
  return {
    date: localDateString(now),
    used: round2(used),
    count: records.length,
    synced: true,
  };
}

async function retry(task, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError;
}

/**
 * 汇总一个账号的积分、总额、分段与今日用量。
 * 积分和今日用量各自容错：一项失败不影响另一项，也不影响 token 有效性判断。
 * @param {object} account { credentials, extra, ... }
 * @param {object} options { fetchImpl?, host?, signal?, timeoutMs? }
 */
async function fetchWorkBuddyMetrics(account, options = {}) {
  const host = options.host || normalizeHost(account?.credentials?.billingHost);
  const enterpriseId = accountEnterpriseId(account);
  const edition = accountEdition(account);
  let mode = enterpriseId || ENTERPRISE_EDITIONS.has(edition) ? 'enterprise' : 'personal';

  let creditResult;
  let creditError = null;
  let enterpriseIdUsed = enterpriseId || null;
  try {
    if (mode === 'enterprise') {
      const resolvedId = enterpriseId || await retry(() => resolveEnterpriseId(account, { ...options, host }));
      if (!resolvedId) throw new Error('企业账号缺少 enterpriseId');
      enterpriseIdUsed = resolvedId;
      creditResult = await retry(() => queryEnterpriseCredits(account, resolvedId, { ...options, host }));
    } else {
      creditResult = await retry(() => queryPersonalCredits(account, { ...options, host }));
    }
  } catch (error) {
    creditError = error instanceof Error ? error.message : String(error);
    creditResult = { credits: null, quota: null, count: 0, totalDosage: null, segments: [], unlimited: false, cycleResetTime: null, mode };
  }

  let todayUsage = null;
  let todayError = null;
  if (options.includeToday !== false) {
    try {
      todayUsage = await retry(() => queryTodayUsage(account, { ...options, host }));
    } catch (error) {
      todayError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ...creditResult,
    enterpriseId: enterpriseIdUsed || undefined,
    creditError,
    todayUsage,
    todayUsed: todayUsage?.used ?? null,
    todayCount: todayUsage?.count ?? null,
    todayDate: todayUsage?.date ?? null,
    todaySynced: todayUsage?.synced === true,
    todayError,
    fetchedAt: Date.now(),
  };
}

module.exports = {
  DEFAULT_BILLING_HOST,
  ENTERPRISE_EDITIONS,
  normalizeHost,
  normalizeAccountIdentity,
  decodeTokenClaims,
  accountEnterpriseId,
  accountEdition,
  billingHeaders,
  extractAccounts,
  extractCreditSegments,
  mergeSegments,
  sortSegments,
  buildCreditResourceBody,
  queryPersonalCredits,
  enterpriseUsage,
  resolveEnterpriseId,
  queryEnterpriseCredits,
  queryTodayUsage,
  fetchWorkBuddyMetrics,
  // 测试辅助
  __testing: {
    firstNumber, firstTimestamp, parseTimestamp, formatLocalDateTime, localDateString, round2,
  },
};
