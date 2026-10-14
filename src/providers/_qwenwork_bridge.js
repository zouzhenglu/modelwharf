'use strict';
/**
 * QwenWork (千问办公) wasm bridge — drives the official qoder_auth_wasm_bg.wasm
 * shipped inside the QwenWorkCN desktop app to sign/encode data-plane requests.
 *
 * Why: since client 1.1.0 the gateway requires Encode=1 request bodies produced
 * by the official wasm (self-built encodings get `400 Invalid agent chat JSON body`).
 * The wasm file is a binary asset of the client — never copied into this repo,
 * always resolved from the local install at runtime.
 *
 * Signing modes (helper CLI, see _qwenwork_wasm_helper.mjs):
 *   infer  -> sealed (Encode=1) chat request: {url, body, headers}
 *   req    -> plain signed request for non-chat endpoints (model list): {url, headers, body}
 *   decode -> unseal Encode=1 server payloads (input unchanged when not sealed)
 *
 * The helper is an ESM .mjs — this project is CommonJS, so it is spawned as a
 * child process (stdin for body to dodge Windows command-line length limits).
 * Each spawn instantiates a fresh wasm context (~a few hundred ms) which is
 * acceptable for LLM request latency; a serve mode exists in the helper if needed.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../logger');

const HELPER = path.join(__dirname, '_qwenwork_wasm_helper.mjs');
const GATEWAY = 'https://gateway.qwenwork.cn';

// ---- wasm resolution ---------------------------------------------------------

const WASM_REL = path.join('resources', 'qoder-auth-wasm', 'qoder_auth_wasm_bg.wasm');
const BRAND_DIRS = ['QwenWorkCN', 'qianwenWork', 'qwenwork', 'QwenWork'];

/** version rank for directory names like 1.2.5-26092902 */
function versionRank(name) {
  const m = String(name).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? (+m[1] * 1e6 + +m[2] * 1e3 + +m[3]) : 0;
}

/** all plausible install roots, incl. vendor-nested layouts under Program Files */
function candidateRoots() {
  const roots = [];
  for (const key of ['QWENWORK_INSTALL', 'DUMATE_QWENWORK_INSTALL']) {
    if (process.env[key]) roots.push(process.env[key]);
  }
  const parents = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)']),
  ].filter(Boolean);
  for (const p of parents) for (const b of BRAND_DIRS) roots.push(path.join(p, b));
  for (const drive of ['C:', 'D:', 'E:']) {
    for (const pf of ['Program Files', 'Program Files (x86)']) {
      const base = path.join(drive + path.sep, pf);
      for (const b of BRAND_DIRS) roots.push(path.join(base, b));
      // vendor layout: <pf>/<brand>/<QwenWorkCN> (one or two levels)
      let l1 = [];
      try { l1 = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
      for (const a of l1) {
        if (!a.isDirectory()) continue;
        for (const b of BRAND_DIRS) roots.push(path.join(base, a.name, b));
        let l2 = [];
        try { l2 = fs.readdirSync(path.join(base, a.name), { withFileTypes: true }); } catch { continue; }
        for (const x of l2) {
          if (!x.isDirectory()) continue;
          for (const b of BRAND_DIRS) roots.push(path.join(base, a.name, x.name, b));
        }
      }
    }
    roots.push(path.join(drive + path.sep, 'Programs', 'QwenWorkCN'));
  }
  return roots;
}

let wasmCache = null; // { file, version, at }

/** locate the newest-versioned qoder_auth_wasm_bg.wasm on this machine (cached) */
function resolveWasm({ force = false } = {}) {
  for (const key of ['CB_QWENWORK_WASM', 'QWENWORK_WASM']) {
    if (process.env[key] && fs.existsSync(process.env[key])) {
      return { file: process.env[key], version: 'explicit' };
    }
  }
  if (!force && wasmCache && Date.now() - wasmCache.at < 10 * 60 * 1000) return wasmCache.file ? { ...wasmCache } : null;
  let best = null;
  for (const root of candidateRoots()) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const cand = path.join(root, e.name, WASM_REL);
      if (!fs.existsSync(cand)) continue;
      const rank = versionRank(e.name);
      if (!best || rank > best.rank) best = { rank, file: cand, version: e.name, at: Date.now() };
    }
    const direct = path.join(root, WASM_REL);
    if (!best && fs.existsSync(direct)) best = { rank: 0, file: direct, version: 'unknown', at: Date.now() };
  }
  wasmCache = best;
  return best ? { file: best.file, version: best.version } : null;
}

// ---- helper subprocess -------------------------------------------------------

let helperOk = null; // null = unverified; boolean after first run

/**
 * Run one helper CLI invocation. `argv` is the mode-specific arg list after the mode word.
 * `input` (optional) is written to a temp file whose path is inserted at `inputAt`
 * (default: appended at the end). Returns the helper's parsed stdout JSON.
 */
function runHelper(mode, argv, { input, inputAt, timeoutMs = 60000 } = {}) {
  const wasm = resolveWasm();
  if (!wasm) {
    throw Object.assign(new Error(
      '未找到 qoder_auth_wasm_bg.wasm：千问办公通道需要本机安装千问办公客户端（或设置 QWENWORK_WASM 指向该文件）'
    ), { status: 500 });
  }
  const env = { ...process.env, CB_QWENWORK_WASM: wasm.file };
  // body via temp file — sealed bodies exceed the Windows command-line limit
  let tmp = null;
  try {
    if (input != null) {
      tmp = path.join(os.tmpdir(), `qw-body-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
      fs.writeFileSync(tmp, input, 'utf8');
      const at = Number.isInteger(inputAt) ? inputAt : argv.length;
      argv = [...argv.slice(0, at), tmp, ...argv.slice(at)];
    }
    const out = execFileSync(process.execPath, [HELPER, mode, ...argv], {
      encoding: 'utf8', timeout: timeoutMs, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    });
    helperOk = true;
    return JSON.parse(out.trim());
  } catch (e) {
    helperOk = false;
    // stderr from execFileSync errors carries the helper's message
    const detail = String(e.stderr || e.message || '').slice(0, 300);
    throw Object.assign(new Error(`qwenwork wasm 签名失败: ${detail}`), { status: 500 });
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* cleanup best-effort */ } }
  }
}

/**
 * Build a signed, sealed chat request (Encode=1).
 * @returns {{url:string, body:string, headers:object}}
 */
// helper infer argv order: uid token endpoint bodyFile modelKey machineId —
// the temp body file goes at index 3 (inputAt=3), after the endpoint
function prepareChat({ uid, token, bodyJson, modelKey, machineId }) {
  const built = runHelper('infer', [uid, token, GATEWAY, modelKey, machineId || ''], { input: bodyJson, inputAt: 3 });
  if (!built?.url || !built?.body) throw Object.assign(new Error('wasm 未产出可发送的请求'), { status: 500 });
  return built;
}

/**
 * Build a signed plain request for non-chat endpoints (model list, etc).
 * @returns {{url:string, headers:object, body:string|null}}
 */
function prepareRequest({ uid, token, pathname, method = 'GET', bodyJson = '', machineId = '' }) {
  return runHelper('req', [uid, token, GATEWAY, pathname, method, bodyJson || '', machineId || '']);
}

/**
 * Unseal an Encode=1 payload from the server. Returns input unchanged when not sealed.
 */
function decodeResponse(text) {
  if (!text) return text;
  try {
    return runHelper('decode', [], { input: String(text), timeoutMs: 30000 });
  } catch (e) {
    return text; // not sealed / decode failed — caller handles raw text
  }
}

function status() {
  const w = resolveWasm();
  return { wasm: w ? w.file : null, version: w ? w.version : null };
}

module.exports = { prepareChat, prepareRequest, decodeResponse, resolveWasm, status, helperOk: () => helperOk, GATEWAY };
