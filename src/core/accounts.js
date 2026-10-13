'use strict';
/**
 * Account pool: picks the best enabled account for a provider,
 * round-robins among healthy accounts ordered by priority,
 * tracks per-account concurrency and cooldown on failures.
 */
const { db } = require('../store');
const logger = require('../logger');

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
 * Pick an account for provider: candidates ordered by priority; among the
 * lowest priority tier, round-robin. Skip disabled/cooldown/at-capacity.
 */
function pickAccount(providerId) {
  const now = Date.now();
  const candidates = listAccounts(providerId).filter(a => {
    if (a.status === 'banned' || a.status === 'invalid') return false;
    const until = cooldown.get(a.id) || 0;
    if (until > now) return false;
    const cur = inflight.get(a.id) || 0;
    if (a.max_concurrency > 0 && cur >= a.max_concurrency) return false;
    return true;
  });
  if (!candidates.length) return null;
  // round-robin within the top priority tier
  const top = candidates.filter(a => a.priority === candidates[0].priority);
  const rr = (rrCounters.get(providerId) || 0) + 1;
  rrCounters.set(providerId, rr);
  return top[rr % top.length];
}
const rrCounters = new Map();

function acquire(accountId) {
  inflight.set(accountId, (inflight.get(accountId) || 0) + 1);
  db.prepare('UPDATE accounts SET last_used_at=? WHERE id=?').run(Math.floor(Date.now() / 1000), accountId);
}
function release(accountId) {
  inflight.set(accountId, Math.max(0, (inflight.get(accountId) || 1) - 1));
}

/** mark account failure -> cooldown for a while; 401/403 style errors -> invalid */
function reportFailure(accountId, err) {
  const status = err && err.status;
  const acct = getAccount(accountId);
  if (!acct) return;
  if (status === 401 || status === 403) {
    db.prepare('UPDATE accounts SET status=?, status_message=? WHERE id=?').run('invalid', `auth failed (${status})`, accountId);
    logger.warn(`account #${accountId}(${acct.provider_id}/${acct.name}) marked invalid: ${status}`);
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

module.exports = { listAccounts, getAccount, pickAccount, acquire, release, reportFailure, reportSuccess, setAccountStatus };
