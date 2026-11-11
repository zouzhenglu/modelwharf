'use strict';
/**
 * Unit tests for src/providers/_workbuddy_billing.js
 * 纯 fixture，不访问网络；算法对齐 @axiaohungry/dsh-llm-workbuddy@1.3.27。
 * Run: node test/workbuddy-billing.test.js  (npm test 会先跑单元测试再跑 e2e)
 */
const assert = require('assert');
const billing = require('../src/providers/_workbuddy_billing');

const NOW = Date.now();
const future = (days) => NOW + days * 24 * 3600 * 1000;
const past = (days) => NOW - days * 24 * 3600 * 1000;

function makeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const body = handler(url, options, calls.length);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  impl.calls = calls;
  return impl;
}

function jwt(payload) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`;
}

function run() {
  // ---------- 1. 个人积分：Precise 字段 + SlicePeriodUsageDetails + 无 CapacityUnit ----------
  const personal = {
    code: 0,
    data: {
      Response: {
        Data: {
          TotalDosage: 88.5,
          Accounts: [
            {
              PackageCode: 'pkg-base',
              PackageName: '基础包',
              // 关键：没有 CapacityUnit 字段；旧实现会整包跳过
              CycleCapacityRemainPrecise: '100.55',
              CycleCapacitySize: '200',
              DeductionEndTime: future(30),
              SlicePeriodUsageDetails: [
                { SlicePeriodCapacityRemainPrecise: '40.25', SlicePeriodCapacitySize: '50', SlicePeriodEndTime: future(1), PackageCode: 'pkg-base' },
                { SlicePeriodCapacityRemainPrecise: '10.5', SlicePeriodCapacitySize: '20', SlicePeriodEndTime: future(2), PackageCode: 'pkg-base' },
              ],
            },
            {
              PackageCode: 'pkg-addon',
              CycleCapacityRemain: 12,
              CycleCapacitySize: 100,
              DeductionEndTime: future(60),
            },
          ],
        },
      },
    },
  };
  const personalFetch = makeFetch(() => personal);
  return billing.queryPersonalCredits(
    { credentials: { token: 't', userId: 'u1' }, extra: {} },
    { fetchImpl: personalFetch }
  ).then(result => {
    assert.equal(result.credits, 112.55, `credits=${result.credits}`);
    assert.equal(result.quota, 300, `quota=${result.quota}`);
    assert.equal(result.count, 2);
    assert.equal(result.totalDosage, 88.5);
    assert.equal(result.mode, 'personal');
    // 第一包两个切片同 packageCode+到期时间 → 合并成 1 段；第二包单独 1 段
    assert.equal(result.segments.length, 2, `segments=${result.segments.length}`);
    assert.equal(result.segments[0].remaining, 50.75);
    assert.equal(result.segments[1].remaining, 12);
    assert.equal(personalFetch.calls[0].url.endsWith('/v2/billing/meter/get-user-resource'), true);

    // ---------- 2. 五种响应包裹形态 ----------
    const account = { CycleCapacityRemain: 5, CycleCapacitySize: 10 };
    const shapes = [
      { data: { Response: { Data: { Accounts: [account] } } } },
      { data: { data: { Response: { Data: { Accounts: [account] } } } } },
      { data: { accounts: [account] } },
      { data: { data: { accounts: [account] } } },
      { Response: { Data: { Accounts: [account] } } },
    ];
    for (const shape of shapes) {
      assert.equal(billing.extractAccounts(shape).length, 1, 'wrapper shape failed: ' + JSON.stringify(Object.keys(shape)));
    }

    // ---------- 3. 企业账号 ----------
    const enterprise = billing.enterpriseUsage({ code: 0, data: { limitNum: 1000, credit: 250, cycleResetTime: future(10) } });
    assert.equal(enterprise.credits, 750);
    assert.equal(enterprise.quota, 1000);
    assert.equal(enterprise.unlimited, false);
    assert.equal(enterprise.mode, 'enterprise');
    const unlimited = billing.enterpriseUsage({ data: { limitNum: -1, credit: 0 } });
    assert.equal(unlimited.unlimited, true);
    assert.equal(unlimited.credits, null);

    // ---------- 4. 今日用量分页 ----------
    const rows = (n, credit) => Array.from({ length: n }, (_, i) => ({ requestTime: NOW - i * 1000, credit }));
    const usageFetch = makeFetch((url, options, call) => {
      if (call === 1) return { code: 0, data: { total: 105, data: rows(100, 1) } };
      return { code: 0, data: { total: 105, data: rows(5, 2) } };
    });
    return billing.queryTodayUsage(
      { credentials: { token: 't' }, extra: {} },
      { fetchImpl: usageFetch }
    ).then(usage => {
      assert.equal(usage.count, 105, `count=${usage.count}`);
      assert.equal(usage.used, 110, `used=${usage.used}`); // 100*1 + 5*2
      assert.equal(usage.synced, true);
      assert.equal(usageFetch.calls.length, 2, `pages=${usageFetch.calls.length}`);
      assert.ok(usage.date.match(/^\d{4}-\d{2}-\d{2}$/));

      // ---------- 5. 计费请求头 ----------
      const headers = billing.billingHeaders({
        credentials: { token: 'tok', userId: 'u-9', enterpriseId: 'ent-1', domain: 'www.codebuddy.cn' },
        extra: {},
      }, 'https://www.codebuddy.cn', 'ent-1');
      assert.equal(headers.authorization, 'Bearer tok');
      assert.equal(headers['x-client-platform'], 'web');
      assert.equal(headers['x-user-id'], 'u-9');
      assert.equal(headers['x-domain'], 'www.codebuddy.cn');
      assert.equal(headers['x-enterprise-id'], 'ent-1');
      assert.equal(headers['x-tenant-id'], 'ent-1');
      assert.ok(headers.referer.endsWith('/profile/plans-usage'));
      assert.ok(headers['user-agent'].includes('Chrome/'));

      // ---------- 6. 身份归一化 ----------
      const flat = billing.normalizeAccountIdentity({ userId: 'u1', email: 'a@b.com', type: 'ultimate' }, '');
      assert.equal(flat.userId, 'u1');
      assert.equal(flat.email, 'a@b.com');
      assert.equal(flat.type, 'ultimate');
      const wrapped = billing.normalizeAccountIdentity({
        data: { account: { uid: 12345, enterpriseId: 'e-1', nickname: '张三', phone: '13800000000' } },
      }, '');
      assert.equal(wrapped.userId, '12345');
      assert.equal(wrapped.enterpriseId, 'e-1');
      assert.equal(wrapped.displayName, '张三');
      assert.equal(wrapped.uin, '13800000000');
      const fromClaims = billing.normalizeAccountIdentity({}, jwt({ sub: 's-1', email: 'c@d.com', uid: 'claim-uid' }));
      assert.equal(fromClaims.userId, 'claim-uid'); // uid 优先于 sub
      assert.equal(fromClaims.email, 'c@d.com');
      // 显式字段优先于 claims
      const mixed = billing.normalizeAccountIdentity({ userId: 'explicit' }, jwt({ sub: 'token-sub' }));
      assert.equal(mixed.userId, 'explicit');

      // ---------- 7. 业务错误码要抛错 ----------
      const badFetch = makeFetch(() => ({ code: 10001, msg: 'token 失效' }));
      return billing.queryPersonalCredits(
        { credentials: { token: 't' }, extra: {} },
        { fetchImpl: badFetch }
      ).then(
        () => { throw new Error('expected business error'); },
        error => assert.ok(/token 失效/.test(error.message), `unexpected: ${error.message}`)
      );
    });
  }).then(() => {
    console.log('workbuddy billing unit tests passed');
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

run();
