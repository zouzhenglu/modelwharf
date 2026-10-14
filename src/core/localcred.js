'use strict';
/**
 * Local credential import: shared logic for turning provider-discovered local
 * logins (IDE storage files, CLI auth files) into gateway accounts.
 * Dedupes by credential fingerprint so startup auto-import is idempotent.
 *
 * Exclusion list: labels that the user marked as "don't import" (stored in the
 * settings table) are skipped on every future scan — e.g. Qoder intl tokens
 * without a PAT can't chat, so once excluded they never come back.
 */
const { db, getSetting, setSetting } = require('../store');

const SECRET_KEYS = ['token', 'securityOauthToken', 'pat', 'apiKey', 'jobToken'];

function fingerprint(credentials) {
  for (const k of SECRET_KEYS) if (credentials[k]) return k + ':' + credentials[k];
  return JSON.stringify(credentials);
}

// providers that share the same upstream credential pool — a fingerprint found in
// one is considered existing in the others (qoder/qodercn both read com.qodercn.app.stable)
const SHARED_CREDENTIAL_POOLS = [['qoder', 'qodercn']];

// ---------- exclusion list (永久排除：扫描时不再导入) ----------
function getExclusions() {
  const v = getSetting('localImportExclusions', []);
  return Array.isArray(v) ? v : [];
}
function addExclusion(label) {
  if (!label) return;
  const cur = getExclusions();
  if (!cur.includes(label)) setSetting('localImportExclusions', [...cur, label]);
}
function isExcluded(label) {
  const ex = getExclusions();
  if (!ex.length || !label) return false;
  return ex.some(x => label === x || (x.endsWith('*') && label.startsWith(x.slice(0, -1))));
}

/**
 * @param {string} providerId
 * @param {Array<{label,suggestName?,credentials?,extra?}>} found
 * @param {string[]} names  user-provided names, aligned with found
 * @param {{exclude?:boolean}} opts  exclude=true: permanently exclude entries that cannot be imported
 */
function importFound(providerId, found, names = [], opts = {}) {
  const pool = SHARED_CREDENTIAL_POOLS.find(g => g.includes(providerId)) || [providerId];
  const existing = db.prepare(`SELECT id,name,provider_id,credentials FROM accounts WHERE provider_id IN (${pool.map(() => '?').join(',')})`)
    .all(...pool)
    .map(r => ({ name: r.name, provider_id: r.provider_id, fp: fingerprint(JSON.parse(r.credentials || '{}')) }));
  const results = [];
  const excluded = [];
  let imported = 0;
  for (let i = 0; i < (found || []).length; i++) {
    const f = found[i];
    if (isExcluded(f.label)) {
      results.push({ label: f.label, imported: false, reason: '已在排除名单，跳过' });
      continue;
    }
    if (!f.credentials || !Object.keys(f.credentials).length) {
      if (opts.exclude) { addExclusion(f.label); excluded.push(f.label); }
      results.push({ label: f.label, imported: false, reason: '本机凭证是加密格式，需在面板手动粘贴 token' + (opts.exclude ? '（已永久排除）' : '') });
      continue;
    }
    const fp = fingerprint(f.credentials);
    const dup = existing.find(a => a.fp === fp);
    if (dup) {
      const msg = dup.provider_id === providerId
        ? `已存在（账号「${dup.name}」）`
        : `同一凭证已导入为 ${dup.provider_id} 账号「${dup.name}」`;
      results.push({ label: f.label, imported: false, reason: msg });
      continue;
    }
    const base = names[i] || f.suggestName || `${providerId}-local`;
    let name = base, n = 2;
    while (db.prepare('SELECT 1 FROM accounts WHERE provider_id=? AND name=?').get(providerId, name)) name = `${base}-${n++}`;
    db.prepare('INSERT INTO accounts(provider_id,name,credentials,extra) VALUES(?,?,?,?)')
      .run(providerId, name, JSON.stringify(f.credentials), JSON.stringify(f.extra || {}));
    existing.push({ name, provider_id: provider_id, fp });
    imported++;
    results.push({ label: f.label, imported: true, name });
  }
  return { imported, results, ...(excluded.length ? { excluded } : {}) };
}

module.exports = { importFound, fingerprint, getExclusions, addExclusion, isExcluded };
