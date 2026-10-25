'use strict';
/**
 * Unit tests for utils/dsml.js — DeepSeek DSML text tool-call protocol.
 * Run: node test/dsml.test.js  (npm test 会先跑这个再跑 e2e)
 */
const assert = require('assert');
const { parseDSMLCalls, renderDSMLCalls, DSMLStreamFilter, mapToolMessage, dsmlToolDoc } = require('../src/utils/dsml');

const B = '｜';
// 2026-10-25 真实抓到的上游输出（workbuddy 被风控后落到 qodercn 的 deepseek-v4.1-flash），
// 特征：双竖线、一次块内多个 invoke、string="true"/"false" 两种参数形态
const sample = [
  `<${B}${B}DSML${B}${B} calls>`,
  `<${B}${B}DSML${B}${B} invoke name="list_agents">`,
  `<${B}${B}DSML${B}${B} parameter name="name" string="true">list_agents</${B}${B}DSML${B}${B} parameter>`,
  `<${B}${B}DSML${B}${B} parameter name="input" string="false">{}</${B}${B}DSML${B}${B} parameter>`,
  `</${B}${B}DSML${B}${B} invoke>`,
  `<${B}${B}DSML${B}${B} invoke name="bash">`,
  `<${B}${B}DSML${B}${B} parameter name="command" string="true">pwd; echo '---'; ls -la</${B}${B}DSML${B}${B} parameter>`,
  `<${B}${B}DSML${B}${B} parameter name="description" string="true">Inspect workspace and toolchain</${B}${B}DSML${B}${B} parameter>`,
  `</${B}${B}DSML${B}${B} invoke>`,
  `</${B}${B}DSML${B}${B} calls>`,
].join('\n');

function run() {
  // 静态解析：多 invoke、双竖线、string 两种形态
  const r1 = parseDSMLCalls(sample);
  assert.equal(r1.calls.length, 2, 'two calls, got ' + r1.calls.length);
  assert.equal(r1.content.trim(), '');
  assert.equal(r1.calls[0].name, 'list_agents');
  assert.deepEqual(JSON.parse(r1.calls[0].arguments), { name: 'list_agents', input: {} });
  assert.equal(r1.calls[1].name, 'bash');
  assert.deepEqual(JSON.parse(r1.calls[1].arguments), { command: "pwd; echo '---'; ls -la", description: 'Inspect workspace and toolchain' });

  // 单竖线变体 + 前后正文保留
  const single = `前文<${B}DSML${B} calls><${B}DSML${B} invoke name="t"><${B}DSML${B} parameter name="a" string="true">x</${B}DSML${B} parameter></${B}DSML${B} invoke></${B}DSML${B} calls>后文`;
  const r2 = parseDSMLCalls(single);
  assert.equal(r2.calls.length, 1, 'single-bar variant');
  assert.deepEqual(JSON.parse(r2.calls[0].arguments), { a: 'x' });
  assert.equal(r2.content, '前文后文');

  // 流式逐字符喂（标记被切到最碎）
  const f = new DSMLStreamFilter();
  let content = '';
  const calls = [];
  for (const ch of sample) {
    const r = f.push(ch);
    if (r.content) content += r.content;
    calls.push(...r.calls);
  }
  const tail = f.flush();
  if (tail.content) content += tail.content;
  calls.push(...tail.calls);
  assert.equal(calls.length, 2, 'stream char-by-char two calls, got ' + calls.length);
  assert.equal(content.trim(), '');

  // 流式按 3 字符一组喂
  const f2 = new DSMLStreamFilter();
  const k2 = [];
  for (let i = 0; i < sample.length; i += 3) k2.push(...f2.push(sample.slice(i, i + 3)).calls);
  k2.push(...f2.flush().calls);
  assert.equal(k2.length, 2, 'chunked two calls, got ' + k2.length);

  // 普通 HTML 尖括号不受影响
  const f3 = new DSMLStreamFilter();
  const p3 = f3.push('a < b and c < d > e');
  const t3 = f3.flush();
  assert.equal(p3.content + t3.content, 'a < b and c < d > e');
  assert.equal(t3.calls.length, 0);

  // 流结束时块未闭合：完整的 invoke 能救，救不了的原样放行
  const f4 = new DSMLStreamFilter();
  const p4 = f4.push(`hi <${B}${B}DSML${B}${B} calls><${B}${B}DSML${B}${B} invoke name="x"></${B}${B}DSML${B}${B} invoke>`);
  const t4 = f4.flush();
  assert.equal(t4.calls.length, 1, 'unclosed block salvage');
  assert.equal(p4.content + t4.content, 'hi ');
  const f5 = new DSMLStreamFilter();
  const p5 = f5.push(`ok <${B}${B}DSML${B}${B} calls>half block never closed`);
  const t5 = f5.flush();
  assert.equal(t5.calls.length, 0);
  assert.ok((p5.content + t5.content).includes('half block never closed'));

  // 历史：assistant.tool_calls → DSML 文本；tool → user 观察文本；其余消息不动
  const m1 = mapToolMessage({ role: 'assistant', text: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'ls' }) } }] });
  assert.ok(m1.content.includes(`<${B}${B}DSML${B}${B} invoke name="bash">`));
  assert.ok(m1.content.includes(`string="true">ls<`));
  const m2 = mapToolMessage({ role: 'tool', name: 'bash', text: 'file1\nfile2' });
  assert.equal(m2.role, 'user');
  assert.ok(m2.content.includes('[Tool result for bash]'));
  assert.equal(mapToolMessage({ role: 'user', text: 'hi' }), null);

  // 渲染再解析应还原参数（往返一致性）
  const round = parseDSMLCalls('x' + renderDSMLCalls([{ function: { name: 'bash', arguments: JSON.stringify({ command: 'ls -la', opts: { deep: [1, 2] } }) } }]));
  assert.equal(round.calls.length, 1);
  assert.deepEqual(JSON.parse(round.calls[0].arguments), { command: 'ls -la', opts: { deep: [1, 2] } });

  // 工具文档注入
  const doc = dsmlToolDoc([{ type: 'function', function: { name: 'bash', description: 'Run shell', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] } } }]);
  assert.ok(doc.includes('- bash(command, cwd?): Run shell'));
  assert.ok(doc.includes(`<${B}${B}DSML${B}${B} invoke name="tool_name">`));

  // === 2026-10-25 DeepSeek harness 端到端实抓的退化输出（此前整块漏成标签汤）===
  // harness 的 shell 工具 schema：缺 invoke 开标签时按参数名重合度唯一匹配回工具名
  const shellTool = [{ type: 'function', function: { name: 'shell', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' }, run_in_background: { type: 'boolean' }, timeoutMs: { type: 'number' } }, required: ['command'] } } }];

  // 样本1：invoke 开标签整个缺失 + timeoutMs 闭标签裸化成 </｜｜DSML｜｜> + 多余 </parameter>
  const bad1 = [
    `<${B}${B}DSML${B}${B} calls>`,
    `<${B}${B}DSML${B}${B} parameter name="description" string="true">Verify all requirements installed</${B}${B}DSML${B}${B} parameter>`,
    `<${B}${B}DSML${B}${B} parameter name="command" string="true">cd D:\\x\npython -c "print(1)"</${B}${B}DSML${B}${B} parameter>`,
    `<${B}${B}DSML${B}${B} parameter name="timeoutMs" string="false">60000</${B}${B}DSML${B}${B}>`,
    `</${B}${B}DSML${B}${B} parameter>`,
    `</${B}${B}DSML${B}${B} invoke>`,
    `</${B}${B}DSML${B}${B} calls>`,
  ].join('\n');
  const b1 = parseDSMLCalls(bad1, shellTool);
  assert.equal(b1.calls.length, 1, 'malformed block salvaged, got ' + b1.calls.length);
  assert.equal(b1.calls[0].name, 'shell', 'name inferred from param schema');
  assert.deepEqual(JSON.parse(b1.calls[0].arguments), { description: 'Verify all requirements installed', command: 'cd D:\\x\npython -c "print(1)"', timeoutMs: 60000 });
  assert.equal(b1.content, '');
  // 同样本但请求没带 tools：块照样剥掉（不外泄标签汤），推不出名字的调用丢弃
  const b1b = parseDSMLCalls(bad1);
  assert.equal(b1b.calls.length, 0);
  assert.equal(b1b.content, '');

  // 样本2：裸 <…></…> 残标签对，参数照常归属
  const bad2 = [
    `<${B}${B}DSML${B}${B} calls>`,
    `<${B}${B}DSML${B}${B} parameter name="command" string="true">ls</${B}${B}DSML${B}${B} parameter>`,
    `<${B}${B}DSML${B}${B}>`,
    `</${B}${B}DSML${B}${B}>`,
    `</${B}${B}DSML${B}${B} invoke>`,
    `</${B}${B}DSML${B}${B} calls>`,
  ].join('\n');
  const b2 = parseDSMLCalls(bad2, shellTool);
  assert.equal(b2.calls.length, 1);
  assert.deepEqual(JSON.parse(b2.calls[0].arguments), { command: 'ls' });

  // 样本3：冗余闭标记连发（</parameter>、</invoke>、裸闭、</invoke>）只产生一个调用
  const bad3 = [
    `<${B}${B}DSML${B}${B} calls>`,
    `<${B}${B}DSML${B}${B} parameter name="command" string="true">npm install</${B}${B}DSML${B}${B} parameter>`,
    `<${B}${B}DSML${B}${B} parameter name="run_in_background" string="false">true</${B}${B}DSML${B}${B} parameter>`,
    `</${B}${B}DSML${B}${B} parameter>`,
    `</${B}${B}DSML${B}${B} invoke>`,
    `</${B}${B}DSML${B}${B}>`,
    `</${B}${B}DSML${B}${B} invoke>`,
    `</${B}${B}DSML${B}${B} calls>`,
  ].join('\n');
  const b3 = parseDSMLCalls(bad3, shellTool);
  assert.equal(b3.calls.length, 1, 'redundant closers deduped, got ' + b3.calls.length);
  assert.deepEqual(JSON.parse(b3.calls[0].arguments), { command: 'npm install', run_in_background: true });

  // 样本4：全部标记挤一行、标记间夹空格
  const bad4 = `<${B}${B}DSML${B}${B} calls> <${B}${B}DSML${B}${B} parameter name="command" string="true">dir</${B}${B}DSML${B}${B} parameter> <${B}${B}DSML${B}${B} parameter name="description" string="true">Check</${B}${B}DSML${B}${B} parameter> <${B}${B}DSML${B}${B}> </${B}${B}DSML${B}${B}> </${B}${B}DSML${B}${B} invoke> </${B}${B}DSML${B}${B} calls>`;
  const b4 = parseDSMLCalls(bad4, shellTool);
  assert.equal(b4.calls.length, 1);
  assert.deepEqual(JSON.parse(b4.calls[0].arguments), { command: 'dir', description: 'Check' });

  // 流式：退化样本逐字符喂，同样能救出调用且正文干净
  const f6 = new DSMLStreamFilter(shellTool);
  let c6 = ''; const k6 = [];
  for (const ch of bad1) { const r = f6.push(ch); c6 += r.content; k6.push(...r.calls); }
  const t6 = f6.flush(); c6 += t6.content; k6.push(...t6.calls);
  assert.equal(k6.length, 1, 'stream malformed salvage, got ' + k6.length);
  assert.equal(k6[0].name, 'shell');
  assert.equal(c6, '');

  // 名字推断的边界：参数与任何工具 schema 零重合 → 丢弃；两个工具并列最优 → 丢弃（不猜）
  const badNamed = `<${B}${B}DSML${B}${B} calls><${B}${B}DSML${B}${B} invoke name=""><${B}${B}DSML${B}${B} parameter name="path" string="true">/tmp</${B}${B}DSML${B}${B} parameter></${B}${B}DSML${B}${B} invoke></${B}${B}DSML${B}${B} calls>`;
  assert.equal(parseDSMLCalls(badNamed, shellTool).calls.length, 0);
  const tieTools = [
    { type: 'function', function: { name: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } } } } },
    { type: 'function', function: { name: 'shell2', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } } } } },
  ];
  const tie = parseDSMLCalls(`<${B}${B}DSML${B}${B} calls><${B}${B}DSML${B}${B} parameter name="command" string="true">ls</${B}${B}DSML${B}${B} parameter></${B}${B}DSML${B}${B} calls>`, tieTools);
  assert.equal(tie.calls.length, 0, 'ambiguous params must not guess');

  // 无空格变体：<｜｜DSML｜｜calls>（V4 退化形态，关键字前空格可省）
  const nospace = `<｜｜DSML｜｜calls><｜｜DSML｜｜invoke name="shell"><｜｜DSML｜｜parameter name="command" string="true">pwd</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜calls>`;
  const ns = parseDSMLCalls(nospace, shellTool);
  assert.equal(ns.calls.length, 1, 'no-space variant, got ' + ns.calls.length);
  assert.equal(ns.calls[0].name, 'shell');
  assert.deepEqual(JSON.parse(ns.calls[0].arguments), { command: 'pwd' });
  const f7 = new DSMLStreamFilter(shellTool);
  let c7 = ''; const k7 = [];
  for (const ch of nospace) { const r = f7.push(ch); c7 += r.content; k7.push(...r.calls); }
  const t7 = f7.flush(); c7 += t7.content; k7.push(...t7.calls);
  assert.equal(k7.length, 1, 'stream no-space variant, got ' + k7.length);
  assert.equal(c7, '');

  console.log('dsml unit tests passed');
}

run();
