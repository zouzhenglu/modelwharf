'use strict';
/**
 * qodercn — Qoder 中国区独立通道（companion to qoder provider, region locked to cn).
 * Kept as a separate provider so CN and intl accounts/模型 pools can be managed independently.
 */
const base = require('./qoder');
const { importFound } = require('../core/localcred');

module.exports = {
  ...base,
  id: 'qodercn',
  label: 'Qoder 中国版',
  homepage: 'https://qoder.com.cn',
  credFields: [
    { name: 'pat', label: 'PAT（qoder.com.cn/account/integrations）', secret: true, placeholder: 'pt-...' },
    { name: 'securityOauthToken', label: 'securityOauthToken', secret: true },
    { name: 'deviceToken', label: 'Cosy-MachineToken（可选）', secret: true },
  ],
  docs: '中国区网关 gateway.qoder.com.cn。账号与 qoder(intl) 相互独立管理。',

  // only CN CLI credentials
  discoverLocal() { return base.discoverLocal('cn'); },

  async listModels(account) {
    account.credentials = { ...account.credentials, region: 'cn' };
    return base.listModels(account);
  },
  async listOnlineModels(account) {
    account.credentials = { ...account.credentials, region: 'cn' };
    return base.listOnlineModels(account);
  },
  async checkAccount(account) {
    account.credentials = { ...account.credentials, region: 'cn' };
    return base.checkAccount(account);
  },
  async *chat(opts) {
    opts.account.credentials = { ...opts.account.credentials, region: 'cn' };
    yield* base.chat(opts);
  },
  async importLocal(opts = {}) {
    const found = this.discoverLocal();
    if (opts.import) return { found, ...importFound('qodercn', found, opts.names || []) };
    return { found };
  },
};
