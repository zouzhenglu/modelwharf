'use strict';
/**
 * 模型名归一化 —— 「统一模型」聚合的判重依据。
 *
 * 各平台给同一个模型起的名子并不一致（trae 的 `qwen3.8-max`、千问办公的
 * `qwen3.8-max-preview`、qoder 的 `Qwen3.8-Max`），只做「全等比较」会把同一个
 * 模型族拆成几个互不认识的条目，用户就看不到「这几个平台其实都有它」。
 * 这里把名字压成一个「模型族 key」，让同一族的模型能聚到一起。
 */
const { db } = require('../store');

/** 基础清洗：小写、分隔符统一成 - */
function flatten(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
}

// 版本号的等价写法：5.3 == 53 == v5-3，统一成点分形式（glm-53 -> glm-5.3）
function unifyVersion(n) {
  return n.replace(/(\d)-(\d)/g, '$1.$2');
}

// 同一族的后缀差异：preview / latest / flash 等在不同平台写法不同，
// 但 preview 是「预览版」、turbo 是「另一个档位」，不能一律抹掉。
// 这里只处理已知会造成「明明是同一个模型却对不上」的写法。
const SUFFIX_ALIASES = [
  [/-max-preview$/, '-preview'],   // qwen3.8-max-preview 与 qwen3.8-max-preview 对齐
  [/-pro$/, '-pro'],
];

/**
 * 归一化成「模型族 key」。
 * 注意：这里只做保守归一（大小写、分隔符、版本号写法），不把 -preview / -flash
 * 之类的档位后缀抹平——否则会把不同档位错误地聚成一个模型。
 */
function familyKey(name) {
  let n = unifyVersion(flatten(name));
  for (const [re, to] of SUFFIX_ALIASES) n = n.replace(re, to);
  return n;
}

/** 展示用名：取组内最短、最"干净"的那个作为对外名称 */
function preferredName(names) {
  return [...names].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

/**
 * 跨平台模型族分组：把 enabled 的真实模型按模型族聚合。
 * @param {string[]} [providerIds] 限制平台范围（默认全部）
 * @returns {Array<{base, family, targets:[{provider_id,public_name}], multiProvider, providers}>}
 */
function modelFamilies(providerIds = null) {
  let sql = 'SELECT provider_id, public_name FROM models WHERE enabled=1';
  const args = [];
  if (providerIds?.length) {
    sql += ` AND provider_id IN (${providerIds.map(() => '?').join(',')})`;
    args.push(...providerIds);
  }
  const rows = db.prepare(sql).all(...args);
  const groups = new Map();
  for (const r of rows) {
    const fam = familyKey(r.public_name);
    if (!groups.has(fam)) groups.set(fam, { family: fam, names: new Set(), targets: [] });
    const g = groups.get(fam);
    g.names.add(r.public_name);
    // 同一平台同一族可能出现多次（如 dev/max 变体）——只取一个代表
    if (!g.targets.some(t => t.provider_id === r.provider_id)) {
      g.targets.push({ provider_id: r.provider_id, public_name: r.public_name });
    }
  }
  return [...groups.values()]
    // 同一族里平台内若有多个候选，选名字最短的那个（通常是正式版而非 __dev/__max 变体）
    .map(g => {
      const byProvider = new Map();
      for (const t of g.targets) {
        const cur = byProvider.get(t.provider_id);
        if (!cur || t.public_name.length < cur.public_name.length) byProvider.set(t.provider_id, t);
      }
      const targets = [...byProvider.values()];
      return {
        base: preferredName([...g.names]),
        family: g.family,
        targets,
        multiProvider: targets.length > 1,
        providers: targets.map(t => t.provider_id),
      };
    })
    .sort((a, b) => (b.multiProvider - a.multiProvider) || a.base.localeCompare(b.base));
}

/** 只保留跨平台（≥2 个平台）的模型族，供「一键创建」使用 */
function crossProviderFamilies(providerIds = null) {
  return modelFamilies(providerIds).filter(f => f.multiProvider);
}

module.exports = { flatten, familyKey, preferredName, modelFamilies, crossProviderFamilies };
