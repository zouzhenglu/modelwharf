'use strict';
/**
 * The provider plugin protocol.
 *
 * Every platform (trae, qoder, qwen, workbuddy...) implements this interface in
 * src/providers/<id>.js and registers itself here. The core engine only talks
 * to plugins through this protocol, so adding a new platform (or a plain
 * official OpenAI-compatible endpoint, or a local model) = dropping in one file.
 *
 * Plugin interface:
 *   id:        unique string, matches providers.provider_id
 *   label:     display name
 *   homepage:  URL of the platform (for admin UI)
 *   credFields:[{name,label,placeholder,required,secret}] — admin UI renders the account form from this
 *   docs:      short text explaining where to get the credential (shown in admin UI)
 *
 *   async listModels(account) -> [{ upstream, name?, ctx?, free?, multiplier? }]
 *        models supported by this account. May be static or fetched from upstream.
 *   async checkAccount(account) -> { ok, status?, message?, extra? }
 *        validate credentials; extra is merged into account.extra (e.g. credits, plan).
 *   async *chat({ account, model, messages, tools?, params, signal, onUsage })
 *        yields upstream SSE 'data:' payload strings (or plain JSON lines).
 *        onUsage({input_tokens,output_tokens,credits}) called once before stream end (or via return value).
 *        Throw {status, message} for upstream errors.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { db, getSetting, setSetting } = require('../store');

const plugins = new Map();

function register(plugin) {
  if (!plugin || !plugin.id) throw new Error('plugin must have id');
  if (plugins.has(plugin.id)) throw new Error(`plugin ${plugin.id} already registered`);
  plugins.set(plugin.id, plugin);
  // ensure provider row exists
  db.prepare('INSERT OR IGNORE INTO providers(id) VALUES(?)').run(plugin.id);
  logger.info(`provider registered: ${plugin.id} (${plugin.label || ''})`);
}

function loadAll() {
  const dir = path.join(__dirname, '..', 'providers');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.js') || f.startsWith('_')) continue;
    // official.js exports an array of vendor plugins
    if (f === 'official.js') {
      try {
        for (const plugin of require(path.join(dir, f))) register(plugin);
      } catch (e) {
        logger.error(`failed to load official vendors: ${e.message}`);
      }
      continue;
    }
    try {
      const plugin = require(path.join(dir, f));
      register(plugin);
    } catch (e) {
      logger.error(`failed to load provider ${f}: ${e.message}`);
    }
  }
}

function get(id) { return plugins.get(id); }
function list() { return [...plugins.values()]; }

/**
 * Startup auto-import: ask every provider that supports discoverLocal()
 * to scan the machine for existing logins and import them (idempotent).
 */
function autoImportLocal() {
  const { importFound } = require('./localcred');
  const summary = [];
  for (const plugin of plugins.values()) {
    if (typeof plugin.discoverLocal !== 'function') continue;
    try {
      const found = plugin.discoverLocal() || [];
      if (!found.length) continue;
      const r = importFound(plugin.id, found);
      if (r.imported) logger.info(`auto-imported ${r.imported} local account(s) for ${plugin.id}`);
      summary.push({ provider: plugin.id, ...r });
    } catch (e) {
      logger.warn(`auto-import failed for ${plugin.id}: ${e.message}`);
    }
  }
  return summary;
}

module.exports = { register, loadAll, get, list, autoImportLocal };
