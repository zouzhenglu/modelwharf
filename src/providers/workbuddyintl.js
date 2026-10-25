'use strict';
/**
 * workbuddyintl — WorkBuddy 国际版独立通道（companion to workbuddy provider, region locked to intl).
 * 与国内版同一套协议实现，仅网关域名不同（www.workbuddy.ai，旧域名 codebuddy.ai 同样可用）。
 *
 * 与国内版的实测差异（2026-10-25，插件 token）：
 *  - 聊天 /v2/chat/completions、模型目录 /v3/config、token 续期 ✅ 可用
 *  - 积分 billing/meter/*、签到 daily-checkin ❌ 401（边缘网关对插件 token 不放行）
 *    → checkAccount 用 /v3/config 只读探活；不实现 checkin（避免每天白跑一次 401）
 */
const base = require('./workbuddy');
const { importFound } = require('../core/localcred');

/**
 * 用 intl 区域跑一次 base 的方法，且不污染账号。
 * 只挂 regionOverride（不进 credentials，因此不会被落库），原理同 qodercn.js。
 */
function asIntl(account, fn) {
  return fn({ ...account, regionOverride: 'intl' });
}

module.exports = {
  ...base,
  id: 'workbuddyintl',
  label: 'WorkBuddy International（国际版）',
  homepage: 'https://www.workbuddy.ai',
  region: 'intl',
  oauthPrefix: 'wbi',
  credFields: [
    { name: 'token', label: 'Access Token', required: true, secret: true },
    { name: 'refreshToken', label: 'Refresh Token（可选，自动续期）', secret: true },
    { name: 'userId', label: 'User ID（可选）' },
    { name: 'deviceToken', label: 'X-Device-Token（可选，风控需要时填）', secret: true },
  ],
  docs: '国际版网关 www.workbuddy.ai。从本机 %LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop-ai.info 读取（国际版客户端登录态，domain 为 workbuddy.ai）；或登录网页版后从请求头复制 Authorization。注意：国际版暂无积分/签到（上游账单接口对插件 token 不可用），账号体检为 token 探活。',

  // 只扫国际版（auth.domain 为 workbuddy.ai / codebuddy.ai 的登录态）
  discoverLocal() { return base.scanLocal('intl'); },

  async listModels(account) { return asIntl(account, (a) => base.listModels(a)); },
  async listOnlineModels(account) { return asIntl(account, (a) => base.listOnlineModels(a)); },
  async fetchConfigCatalog(account) { return asIntl(account, (a) => base.fetchConfigCatalog(a)); },
  async checkAccount(account) { return asIntl(account, (a) => base.checkAccount(a)); },
  // 国际版账单接口 401（见文件头）——不暴露 checkin，core 视为「平台不支持签到」直接跳过
  checkin: undefined,
  async *chat(opts) {
    yield* base.chat({ ...opts, account: { ...opts.account, regionOverride: 'intl' } });
  },
  async startOAuth() { return base.startOAuth('intl'); },
  async pollOAuth(state) { return base.pollOAuth(state, 'intl'); },
  async importLocal(opts = {}) {
    const found = this.discoverLocal();
    if (opts.import) return { found, ...importFound('workbuddyintl', found, opts.names || []) };
    return { found };
  },
};
