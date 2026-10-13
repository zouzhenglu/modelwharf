'use strict';
/**
 * Local credential import: shared logic for turning provider-discovered local
 * logins (IDE storage files, CLI auth files) into gateway accounts.
 * Dedupes by credential fingerprint so startup auto-import is idempotent.
 */
const { db } = require('../store');

const SECRET_KEYS = ['token', 'securityOauthToken', 'pat', 'apiKey', 'jobToken'];

function fingerprint(credentials) {
  for (const k of SECRET_KEYS) if (credentials[k]) return k + ':' + credentials[k];
  return JSON.stringify(credentials);
}

// providers that share the same upstream credential pool — a fingerprint found in
// one is considered existing in the others (qoder/qodercn both read com.qodercn.app.stable)
const SHARED_CREDENTIAL_POOLS = [['qoder', 'qodercn']];

/**
 * @param {string} providerId
 * @param {Array<{label,suggestName?,credentials?,extra?}>} found
 * @param {string[]} names  user-provided names, aligned with found
 */
function importFound(providerId, found, names = []) {
  const pool = SHARED_CREDENTIAL_POOLS.find(g => g.includes(providerId)) || [providerId];
  const existing = db.prepare(`SELECT id,name,provider_id,credentials FROM accounts WHERE provider_id IN (${pool.map(() => '?').join(',')})`)
    .all(...pool)
    .map(r => ({ name: r.name, provider_id: r.provider_id, fp: fingerprint(JSON.parse(r.credentials || '{}')) }));
  const results = [];
  let imported = 0;
  for (let i = 0; i < (found || []).length; i++) {
    const f = found[i];
    if (!f.credentials || !Object.keys(f.credentials).length) {
      results.push({ label: f.label, imported: false, reason: '本机凭证是加密格式，需在面板手动粘贴 token' });
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
    existing.push({ name, provider_id: providerId, fp });
    imported++;
    results.push({ label: f.label, imported: true, name });
  }
  return { imported, results };
}

module.exports = { importFound, fingerprint };
