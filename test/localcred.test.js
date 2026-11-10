'use strict';
/**
 * Unit tests for src/core/localcred.js — local credential import.
 * Uses an isolated temp DB via WH_DATA_DIR (store.js honors it) so the real
 * data/dsh.db is never touched.
 * Run: node test/localcred.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wharf-localcred-'));
process.env.WH_DATA_DIR = TMPDIR;
process.env.WH_LOG_DIR = TMPDIR;

const { db } = require('../src/store');
const { importFound, fingerprint } = require('../src/core/localcred');

function found(n) {
  return Array.from({ length: n }, (_, i) => ({
    label: `login-${i}`,
    suggestName: `local-${i}`,
    credentials: { token: 'tok-' + i },
  }));
}

(async () => {
  // importing several entries in ONE scan must not throw (was: provider_id is not defined)
  const r = importFound('unit-provider', found(3));
  assert.equal(r.imported, 3, `expected 3 imports, got ${r.imported}: ${JSON.stringify(r.results)}`);
  assert.equal(r.results.filter(x => x.imported).length, 3);

  const rows = db.prepare('SELECT name, provider_id, credentials FROM accounts WHERE provider_id=? ORDER BY name').all('unit-provider');
  assert.equal(rows.length, 3);
  assert.ok(rows.every(x => x.provider_id === 'unit-provider'));

  // a second scan of the same credentials is idempotent (fingerprint dedupe)
  const r2 = importFound('unit-provider', found(3));
  assert.equal(r2.imported, 0, 're-scan should not import duplicates');
  assert.ok(r2.results.every(x => !x.imported));

  // a brand-new credential in a mixed batch still imports (the typo path used to
  // abort the whole scan as soon as the first row was inserted)
  const mixed = [...found(3), { label: 'login-new', suggestName: 'local-new', credentials: { token: 'tok-new' } }];
  const r3 = importFound('unit-provider', mixed);
  assert.equal(r3.imported, 1, `expected only the new one, got ${r3.imported}`);

  // fingerprints are stable and secret-prefixed
  assert.equal(fingerprint({ token: 'a' }), fingerprint({ token: 'a' }));
  assert.notEqual(fingerprint({ token: 'a' }), fingerprint({ token: 'b' }));

  console.log('localcred unit tests passed');
})().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch {}
  });
