'use strict';
/**
 * Qoder 官方客户端的 UMID 机器身份桥 — 调用客户端自带的
 * <install>/resources/umid/runtime-info.exe 生成真实机器身份。
 *
 * 背景：Qoder 国际版活动平台（/sash）服务端校验真实 UMID 机器身份（官方组件
 * 生成、约 50 分钟轮换）。派生的假机器头会被判定非官方客户端，CLAIMABLE 活动
 * 整条被过滤（qoder2api-hub issue #10）；正确行为是二选一——真身份（本模块）
 * 或一个机器头都不发。国内版不校验机器头。
 *
 * 调用契约（实测 2026-10-15）：
 *   <exe> prod --account-stdin   stdin: {"account": "<uid>"} + 空格
 *   stdout: {"machineToken":"..","machineType":"..","machineCode":"..",
 *            "vmInfo":{"isVm":bool,"brand":..,"percentage":..,"vmTypeCode":..}}
 * 机器身份是机器级的（不同 account 返回同一份）；组件输出由本机种子文件决定，
 * 同种子重复调用返回同一身份——所以缓存主要是省子进程开销。
 *
 * 找不到组件（未装客户端）返回 null，调用方回退为"不发机器头"。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('../logger');

const CACHE_TTL_MS = 30 * 60 * 1000; // 30min：身份本身 ~50min 轮换，取短一些
const cache = new Map(); // realm -> {at, ident}

/** 桌面客户端安装目录（%LOCALAPPDATA% 下；CN 与 intl 各自独立安装） */
function desktopInstallDir(realm) {
  const base = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
  const names = realm === 'cn' ? ['Qoder CN', 'QoderCN', 'Qoder'] : ['Qoder'];
  const candidates = [];
  for (const name of names) {
    for (const launcher of [`${name} Launcher`, 'Launcher']) {
      candidates.push(path.join(base, name, launcher, 'state.ini')); // launcher 记录的 installDir
    }
  }
  for (const name of names) candidates.push(path.join(base, 'Programs', name));
  for (const cand of candidates) {
    try {
      if (cand.endsWith('.ini')) {
        if (!fs.existsSync(cand)) continue;
        const ini = fs.readFileSync(cand, 'utf8');
        const dir = (ini.match(/^installDir\s*=\s*(.+)$/m) || [])[1]?.trim();
        if (dir && fs.existsSync(dir)) return dir;
      } else if (fs.existsSync(path.join(cand, 'resources', 'umid', 'runtime-info.exe'))) {
        return cand;
      }
    } catch { /* skip */ }
  }
  return '';
}

/** 定位 runtime-info.exe；找不到返回 null */
function runtimeInfoExe(realm) {
  const dir = desktopInstallDir(realm);
  if (!dir) return null;
  const exe = path.join(dir, 'resources', 'umid', 'runtime-info.exe');
  return fs.existsSync(exe) ? exe : null;
}

/**
 * 取真实机器身份 {machineToken, machineType, machineCode, vm}。
 * 失败/组件不存在返回 null（调用方应回退为"不发机器头"，不要发派生值）。
 */
function nativeMachineIdentity(realm, accountId = '', { force = false } = {}) {
  const hit = cache.get(realm);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ident;
  const exe = runtimeInfoExe(realm);
  if (!exe) { cache.set(realm, { at: Date.now(), ident: null }); return null; }
  try {
    const out = require('child_process').execFileSync(exe, ['prod', '--account-stdin'], {
      input: JSON.stringify({ account: accountId || '' }) + ' ',
      timeout: 25000,
      cwd: path.dirname(exe),
      encoding: 'utf8',
      windowsHide: true,
    });
    const line = String(out || '').trim().split('\n', 1)[0];
    const d = line ? JSON.parse(line) : null;
    const token = String(d?.machineToken || '').trim();
    const mtype = String(d?.machineType || '').trim();
    const code = String(d?.machineCode || '').trim();
    if (!(token && mtype && code)) throw new Error('组件输出缺少 machineToken/Type/Code');
    const ident = {
      machineToken: token, machineType: mtype, machineCode: code,
      machineOs: 'x86_64_win32',
      hostname: require('os').hostname() || 'DESKTOP',
      vm: !!(d.vmInfo && d.vmInfo.isVm),
    };
    cache.set(realm, { at: Date.now(), ident });
    return ident;
  } catch (e) {
    logger.warn(`[umid] ${realm} runtime-info 调用失败（活动平台将退化为不发机器头）: ${e.message}`);
    cache.set(realm, { at: Date.now(), ident: null });
    return null;
  }
}

module.exports = { nativeMachineIdentity, runtimeInfoExe, desktopInstallDir };
