'use strict';
/**
 * 统一 Qoder 命名（国内版 / 国际版）—— 全项目唯一来源。
 *
 * 同一套 Qoder 客户端在中国区与国际区是两套独立账号体系、两套网关，
 * 项目里拆成 qoder / qodercn 两个 provider 分别管理。命名必须处处一致，
 * 否则面板、扫描结果、自动账号名会互相打架。
 */
const REGIONS = {
  cn: {
    key: 'cn',
    // 对外显示用：带「Qoder」品牌，避免面板里孤零零一个「中国版」不知道是谁
    display: 'Qoder 中国版',
    // 短标签：表格/下拉等窄场景
    short: '中国版',
    // 扫描本机登录时的条目标签（provider 前缀由调用方拼）
    scanLabel: 'Qoder 中国版（cn）',
    // 自动导入时的默认账号名
    accountName: 'Qoder 中国版',
    homepage: 'https://qoder.com.cn',
    gateway: 'https://gateway.qoder.com.cn',
    openapi: 'https://openapi.qoder.com.cn',
  },
  intl: {
    key: 'intl',
    display: 'Qoder 国际版',
    short: '国际版',
    scanLabel: 'Qoder 国际版（intl）',
    accountName: 'Qoder 国际版',
    homepage: 'https://qoder.com',
    gateway: 'https://api1.qoder.sh',
    openapi: 'https://openapi.qoder.sh',
  },
};

/** 取某个区域的命名常量；未知 region 回落到 cn（网关默认区） */
function region(pk) {
  return REGIONS[pk] || REGIONS.cn;
}

/** 凭据里的 region 字段 → 标准 region key（兼容历史值 / 空值） */
function normalizeRegion(value, fallback = 'cn') {
  if (value === 'intl' || value === 'international' || value === 'i18n') return 'intl';
  if (value === 'cn') return 'cn';
  return fallback;
}

module.exports = { REGIONS, region, normalizeRegion };
