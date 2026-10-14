'use strict';
const path = require('path');
const db = require('./src/store').db;
console.log('=== providers ===');
for (const r of db.prepare('SELECT id, enabled, config FROM providers').all()) {
  console.log(`  ${r.id} enabled=${r.enabled} config=${r.config}`);
}
console.log('=== accounts (trae) ===');
for (const r of db.prepare("SELECT id, provider_id, name, enabled, status, substr(credentials,1,60) cred_head, length(credentials) cred_len FROM accounts WHERE provider_id='trae'").all()) {
  console.log(`  id=${r.id} name=${r.name} enabled=${r.enabled} status=${r.status} cred_len=${r.cred_len} head=${r.cred_head}`);
}
const traeAcct = db.prepare("SELECT id, provider_id, name, enabled, status FROM accounts WHERE provider_id='trae' LIMIT 1").get();
console.log('=== trae models in models table ===');
const rows = db.prepare("SELECT id, upstream_model, public_name, enabled, multiplier, is_free, ctx_window, max_output, tags FROM models WHERE provider_id='trae' ORDER BY id").all();
console.log('  count =', rows.length);
for (const m of rows) console.log(`  id=${m.id} up=${m.upstream_model} pub=${m.public_name} en=${m.enabled} mult=${m.multiplier} free=${m.is_free} ctx=${m.ctx_window} out=${m.max_output} tags=${m.tags}`);
console.log('=== total models in table ===', db.prepare('SELECT COUNT(*) c FROM models').get().c);
console.log('=== admin.js trae/model routes ===');
db.close();
