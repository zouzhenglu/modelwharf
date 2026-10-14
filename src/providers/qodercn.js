'use strict';
/**
 * qodercn — Qoder 中国区独立通道（companion to qoder provider, region locked to cn).
 * Kept as a separate provider so CN and intl accounts/模型 pools can be managed independently.
 */
const base = require('./qoder');
const { importFound } = require('../core/localcred');
const { REGIONS } = require('./_qoder_names');

/**
 * 用 CN 区域跑一次 base 的方法，且不污染账号。
 *
 * 只挂 regionOverride（不进 credentials，因此不会被 finishExchange 落库）：
 * 否则一个 intl 账号被中国版通道的方法碰过一次，region 就永久变成 cn，
 * 之后所有请求都打到中国网关而失败（表现为「拉不到模型 / Login expired」）。
 */
function asCn(account, fn) {
  return fn({ ...account, regionOverride: 'cn' });
}

module.exports = {
  ...base,
  id: 'qodercn',
  label: REGIONS.cn.display,
  homepage: REGIONS.cn.homepage,
  region: 'cn',
  credFields: [
    { name: 'pat', label: 'PAT（客户端 设置 → 集成/Integrations 创建）', secret: true, placeholder: 'pt-...' },
    { name: 'securityOauthToken', label: 'securityOauthToken', secret: true },
    { name: 'deviceToken', label: 'Cosy-MachineToken（可选）', secret: true },
  ],
  docs: `中国区网关 ${REGIONS.cn.gateway}。账号与 ${REGIONS.intl.display}（qoder）相互独立管理。`,

  // 只扫国内版（复用 qoder 的扫描实现，只扫自己那一个区域）
  discoverLocal(regionFilter) { return base.scanLocal(regionFilter || 'cn'); },

  async listModels(account) { return asCn(account, (a) => base.listModels(a)); },
  async listOnlineModels(account) { return asCn(account, (a) => base.listOnlineModels(a)); },
  async checkAccount(account) { return asCn(account, (a) => base.checkAccount(a)); },
  async *chat(opts) {
    yield* base.chat({ ...opts, account: { ...opts.account, regionOverride: 'cn' } });
  },
  async importLocal(opts = {}) {
    const found = this.discoverLocal();
    if (opts.import) return { found, ...importFound('qodercn', found, opts.names || []) };
    return { found };
  },
};
