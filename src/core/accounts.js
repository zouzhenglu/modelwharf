'use strict';
/**
 * Account pool: picks the best enabled account for a provider,
 * round-robins among healthy accounts ordered by priority,
 * tracks per-account concurrency and cooldown on failures.
 */
const { db } = require('../store');
const logger = require('../logger');
const { isRequestError } = require('./upstream-errors');

const inflight = new Map();   // accountId -> count
const cooldown = new Map();   // accountId -> unlock timestamp

function rowToAccount(row) {
  if (!row) return null;
  return { ...row, credentials: JSON.parse(row.credentials || '{}'), extra: JSON.parse(row.extra || '{}') };
}

function listAccounts(providerId, { includeDisabled = false } = {}) {
  let rows;
  if (providerId) {
    rows = includeDisabled
      ? db.prepare('SELECT * FROM accounts WHERE provider_id=? ORDER BY priority, id').all(providerId)
      : db.prepare('SELECT * FROM accounts WHERE provider_id=? AND enabled=1 ORDER BY priority, id').all(providerId);
  } else {
    rows = includeDisabled
      ? db.prepare('SELECT * FROM accounts ORDER BY provider_id, priority, id').all()
      : db.prepare('SELECT * FROM accounts WHERE enabled=1 ORDER BY provider_id, priority, id').all();
  }
  return rows.map(rowToAccount);
}

function getAccount(id) {
  return rowToAccount(db.prepare('SELECT * FROM accounts WHERE id=?').get(id));
}

/**
 * Find an existing account row for the same upstream identity.
 * Used by OAuth re-login / local import so the same WorkBuddy account refreshing
 * its token updates the existing row instead of creating a duplicate.
 * Matches extra.uid / extra.userId / credentials.userId within one provider.
 */
function findByIdentity(providerId, identity = {}) {
  const wanted = [identity.uid, identity.userId].filter(Boolean).map(String);
  if (!wanted.length) return null;
  const rows = listAccounts(providerId, { includeDisabled: true });
  return rows.find(a => {
    const candidates = [a.extra?.uid, a.extra?.userId, a.credentials?.userId]
      .filter(Boolean).map(String);
    return candidates.some(v => wanted.includes(v));
  }) || null;
}

/** ids of accounts that reported a given model; empty = legacy wildcard (all provider accounts) */
function mappedAccountIds(modelId) {
  if (modelId === undefined || modelId === null) return [];
  return db.prepare('SELECT account_id FROM model_accounts WHERE model_id=?').all(modelId).map(r => r.account_id);
}

/** accounts allowed to serve a model: bound ones, or every account when no binding exists */
function candidatesFor(providerId, modelId) {
  const allowed = mappedAccountIds(modelId);
  const now = Date.now();
  return listAccounts(providerId).filter(a => {
    if (allowed.length && !allowed.includes(a.id)) return false;
    if (a.status === 'banned' || a.status === 'invalid') return false;
    if ((cooldown.get(a.id) || 0) > now) return false;
    const cur = inflight.get(a.id) || 0;
    if (a.max_concurrency > 0 && cur >= a.max_concurrency) return false;
    return true;
  });
}

/** Side-effect-free health probe: is there any account that pickAccount() could return? */
function hasHealthyAccount(providerId, { modelId } = {}) {
  return candidatesFor(providerId, modelId).length > 0;
}

/** Pick an account for provider (optionally restricted to accounts bound to a model). */
function pickAccount(providerId, { modelId } = {}) {
  const candidates = candidatesFor(providerId, modelId);
  if (!candidates.length) return null;
  // round-robin within the top priority tier
  const top = candidates.filter(a => a.priority === candidates[0].priority);
  const rrKey = modelId === undefined || modelId === null ? providerId : `${providerId}#${modelId}`;
  const rr = (rrCounters.get(rrKey) || 0) + 1;
  rrCounters.set(rrKey, rr);
  return top[rr % top.length];
}
const rrCounters = new Map();

/** Guard for forced-account paths: does this account actually provide the model? */
function accountServesModel(modelId, accountId) {
  const allowed = mappedAccountIds(modelId);
  return !allowed.length || allowed.includes(accountId);
}

/** 模型@别名 的别名单段：账号名转 ASCII slug，中文名兜底 acc<id>，同平台冲突加 id 后缀 */
function aliasSlug(name) {
  return String(name || '').normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
}

/** Map<accountId, alias> for one provider (includes disabled accounts so aliases stay stable) */
function aliasMap(providerId) {
  const rows = listAccounts(providerId, { includeDisabled: true });
  const used = new Set();
  const map = new Map();
  for (const a of rows) {
    let base = aliasSlug(a.name);
    // 中文/符号名 slug 后往往只剩前缀（wb-路宇心 -> wb），带上 id 才可读且稳定
    if (!base || /[^\x00-\x7F]/.test(a.name) || base.length <= 2) {
      base = `${base || 'acc'}-${a.id}`;
    }
    let alias = base;
    if (used.has(alias)) alias = `${base}-${a.id}`;
    let n = 2;
    while (used.has(alias)) alias = `${base}-${a.id}-${n++}`;
    used.add(alias);
    map.set(a.id, alias);
  }
  return map;
}

function findByAlias(providerId, alias) {
  const wanted = String(alias || '').toLowerCase();
  if (!wanted) return null;
  const map = aliasMap(providerId);
  for (const a of listAccounts(providerId)) {
    if (map.get(a.id) === wanted) return a;
  }
  return null;
}

function acquire(accountId) {
  inflight.set(accountId, (inflight.get(accountId) || 0) + 1);
  db.prepare('UPDATE accounts SET last_used_at=? WHERE id=?').run(Math.floor(Date.now() / 1000), accountId);
}
function release(accountId) {
  inflight.set(accountId, Math.max(0, (inflight.get(accountId) || 1) - 1));
}

/** mark account failure -> cooldown for a while; 401/403 style errors -> invalid
 *  确定性请求错误（上下文超限、工具历史不匹配等）不冷却账号：同一请求重试也不会
 *  成功，冷却只会把整个账号池熔断，后续正常请求全部 503。 */
function reportFailure(accountId, err) {
  const status = err && err.status;
  const acct = getAccount(accountId);
  if (!acct) return;
  // 客户端主动断开（Codex 重连 / 用户取消）不代表账号有问题
  if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
    logger.warn(`account #${accountId}(${acct.provider_id}/${acct.name}) aborted by client, keeping status`);
    return;
  }
  if (status === 401 || status === 403 || err?.accountStatus === 'invalid') {
    db.prepare('UPDATE accounts SET status=?, status_message=? WHERE id=?').run('invalid', `auth failed (${status})`, accountId);
    logger.warn(`account #${accountId}(${acct.provider_id}/${acct.name}) marked invalid: ${status}`);
  } else if (isRequestError(err)) {
    logger.warn(`account #${accountId}(${acct.provider_id}/${acct.name}) request error, keeping status: ${err.message}`);
  } else {
    const ms = Math.min(10 * 60 * 1000, 30 * 1000 * Math.pow(2, (acct._failStreak = (acct._failStreak || 0) + 1) - 1));
    cooldown.set(accountId, Date.now() + ms);
    db.prepare('UPDATE accounts SET status=?, status_message=? WHERE id=?').run('cooling', err.message || 'upstream error', accountId);
    logger.warn(`account #${accountId}(${acct.provider_id}/${acct.name}) cooling down ${Math.round(ms / 1000)}s: ${err.message}`);
  }
}
function reportSuccess(accountId) {
  cooldown.delete(accountId);
  const acct = getAccount(accountId);
  if (acct && acct.status !== 'active') {
    db.prepare('UPDATE accounts SET status=?, status_message=NULL WHERE id=?').run('active', accountId);
  }
}

function setAccountStatus(id, status, message) {
  db.prepare('UPDATE accounts SET status=?, status_message=? WHERE id=?').run(status, message || null, id);
}

module.exports = { listAccounts, getAccount, findByIdentity, mappedAccountIds, accountServesModel, aliasSlug, aliasMap, findByAlias, hasHealthyAccount, pickAccount, acquire, release, reportFailure, reportSuccess, setAccountStatus };
