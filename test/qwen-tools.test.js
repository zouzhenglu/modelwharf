'use strict';
/**
 * Unit tests for the Qwen text tool-call protocol in utils/dsml.js.
 * Run: node test/qwen-tools.test.js  (npm test 会先跑 dsml/qwen 再跑 e2e)
 */
const assert = require('assert');
const {
  parseDSMLCalls, parseQwenCalls, renderQwenCalls, qwenToolDoc,
  mapQwenToolMessage, DSMLStreamFilter,
} = require('../src/utils/dsml');

// 2026-11-02 真实事故样本：qwen3.8-max 经 trae 文本通道输出，
// 标签以正文形式漏到客户端（<tool_call><function=…><parameter=…>）。
const leaked = [
  '<tool_call> <function=working_directory> </function> </tool_call>',
  '<tool_call>',
  '<function=grep>',
  '<parameter=pattern> BrowserView|<webview|webviewTag|detach.*webview </parameter>',
  '<parameter=path> D:\\agents\\dsh </parameter>',
  '</function>',
  '</tool_call>',
].join('\n');

const tools = [{
  type: 'function',
  function: {
    name: 'grep',
    description: 'Search files',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern'],
    },
  },
}, {
  type: 'function',
  function: {
    name: 'read_file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' }, raw: { type: 'boolean' } },
    },
  },
}];

function run() {
  // 静态解析：事故样本 -> 两条调用，参数去掉标签两侧空白、保留反斜杠路径
  const r1 = parseQwenCalls(leaked, tools);
  assert.equal(r1.calls.length, 2, 'two calls, got ' + r1.calls.length);
  assert.equal(r1.calls[0].name, 'working_directory');
  assert.deepEqual(JSON.parse(r1.calls[0].arguments), {});
  assert.equal(r1.calls[1].name, 'grep');
  assert.deepEqual(JSON.parse(r1.calls[1].arguments), {
    pattern: 'BrowserView|<webview|webviewTag|detach.*webview',
    path: 'D:\\agents\\dsh',
  });
  assert.equal(r1.content.trim(), '');

  // 流式逐字符：标记被切到最碎也不泄漏、不丢调用
  const f = new DSMLStreamFilter(tools);
  let content = '';
  const calls = [];
  for (const ch of leaked) {
    const r = f.push(ch);
    if (r.content) content += r.content;
    calls.push(...r.calls);
  }
  const tail = f.flush();
  if (tail.content) content += tail.content;
  calls.push(...tail.calls);
  assert.equal(calls.length, 2, 'stream two calls, got ' + calls.length);
  assert.equal(calls[1].name, 'grep');
  assert.equal(content.trim(), '', 'no tag soup in content');

  // 前后正文保留
  const r2 = parseQwenCalls('前文\n' + leaked + '\n后文', tools);
  assert.equal(r2.calls.length, 2);
  assert.ok(r2.content.startsWith('前文') && r2.content.trim().endsWith('后文'), 'surrounding text preserved: ' + JSON.stringify(r2.content));

  // JSON 形态
  const jsonBlock = '<tool_call>{"name":"grep","arguments":{"pattern":"foo","path":"."}}</tool_call>';
  const r3 = parseQwenCalls(jsonBlock, tools);
  assert.equal(r3.calls.length, 1);
  assert.deepEqual(JSON.parse(r3.calls[0].arguments), { pattern: 'foo', path: '.' });

  // 按 schema 转换参数类型（Qwen XML 没有类型标记）
  const typed = '<tool_call><function=read_file><parameter=path>a.txt</parameter><parameter=offset>12</parameter><parameter=limit>3</parameter><parameter=raw>true</parameter></function></tool_call>';
  const r4 = parseQwenCalls(typed, tools);
  assert.deepEqual(JSON.parse(r4.calls[0].arguments), { path: 'a.txt', offset: 12, limit: 3, raw: true });

  // 缺 </parameter> / </function> 的退化输出：按下一个标记收口
  const broken = '<tool_call><function=grep><parameter=pattern>abc<parameter=path>.</function></tool_call>';
  const r5 = parseQwenCalls(broken, tools);
  assert.equal(r5.calls.length, 1);
  assert.deepEqual(JSON.parse(r5.calls[0].arguments), { pattern: 'abc', path: '.' });

  // 流结束块未闭合：能救的调用照救
  const f2 = new DSMLStreamFilter(tools);
  const p2 = f2.push('<tool_call><function=grep><parameter=pattern>x</parameter>');
  const t2 = f2.flush();
  assert.equal(p2.calls.length + t2.calls.length, 1, 'unclosed block salvage');
  assert.equal((p2.calls[0] || t2.calls[0]).name, 'grep');

  // === 2026-11-02 live qwen3.8-max 实抓：V3.1 特殊 token 形态 ===
  const section = [
    '<｜tool_calls_section_begin|>',
    '<｜tool_call_begin|>grep<｜tool_call_argument_begin|>{"pattern":"x","path":"."}<｜tool_call_end|>',
    '<｜tool_calls_section_end|>',
  ].join('\n');
  const s1 = parseDSMLCalls(section, tools);
  assert.equal(s1.calls.length, 1, 'section token call, got ' + s1.calls.length);
  assert.equal(s1.calls[0].name, 'grep');
  assert.deepEqual(JSON.parse(s1.calls[0].arguments), { pattern: 'x', path: '.' });
  assert.equal(s1.content.trim(), '');
  const sf = new DSMLStreamFilter(tools);
  const sc = [];
  let sout = '';
  for (const ch of section) {
    const r = sf.push(ch);
    sout += r.content;
    sc.push(...r.calls);
  }
  const st = sf.flush();
  sout += st.content;
  sc.push(...st.calls);
  assert.equal(sc.length, 1, 'section token stream, got ' + sc.length);
  assert.equal(sout.trim(), '', 'no section tokens in content');

  // 无参调用 + functions./:序号 修饰
  const s2 = parseDSMLCalls('<｜tool_calls_section_begin|><｜tool_call_begin|>functions.working_directory:0<｜tool_call_end|><｜tool_calls_section_end|>', tools);
  assert.equal(s2.calls.length, 1);
  assert.equal(s2.calls[0].name, 'working_directory');
  assert.deepEqual(JSON.parse(s2.calls[0].arguments), {});

  // === 2026-11-02 live 实抓：缺 <… calls> 外壳、直接以 invoke 开头的 DSML ===
  const B2 = '｜';
  const bare = [
    `<${B2}${B2}DSML${B2}${B2}invoke name="grep">`,
    `<${B2}${B2}DSML${B2}${B2}parameter name="pattern" string="true">BrowserView</${B2}${B2}DSML${B2}${B2}parameter>`,
    `<${B2}${B2}DSML${B2}${B2}parameter name="path" string="true">D:/agents/dsh</${B2}${B2}DSML${B2}${B2}parameter>`,
    `</${B2}${B2}DSML${B2}${B2}invoke>`,
    `</${B2}${B2}DSML${B2}${B2}calls>`,
  ].join('\n');
  const b1 = parseDSMLCalls(bare, tools);
  assert.equal(b1.calls.length, 1, 'bare invoke block, got ' + b1.calls.length);
  assert.deepEqual(JSON.parse(b1.calls[0].arguments), { pattern: 'BrowserView', path: 'D:/agents/dsh' });
  assert.equal(b1.content.trim(), '');
  const bf = new DSMLStreamFilter(tools);
  const bc = [];
  let bout = '';
  for (const ch of bare) {
    const r = bf.push(ch);
    bout += r.content;
    bc.push(...r.calls);
  }
  const bt = bf.flush();
  bout += bt.content;
  bc.push(...bt.calls);
  assert.equal(bc.length, 1, 'bare invoke stream, got ' + bc.length);
  assert.equal(bout.trim(), '', 'no DSML tokens in content');

  // === 2026-11-02 live 实抓：外壳关键字写成 tool_calls、前后竖线数不对称 ===
  const wrapToolCalls = [
    `<${B2}${B2}DSML${B2}tool_calls>`,
    `<${B2}${B2}DSML${B2}invoke name="grep">`,
    `<${B2}${B2}DSML${B2}parameter name="pattern" string="true">BrowserView</${B2}${B2}DSML${B2}parameter>`,
    `<${B2}${B2}DSML${B2}parameter name="path" string="true">D:/agents/dsh</${B2}${B2}DSML${B2}parameter>`,
    `</${B2}${B2}DSML${B2}invoke>`,
    `</${B2}DSML${B2}tool_calls>`,
  ].join('\n');
  const w1 = parseDSMLCalls(wrapToolCalls, tools);
  assert.equal(w1.calls.length, 1, 'tool_calls wrapper, got ' + w1.calls.length);
  assert.deepEqual(JSON.parse(w1.calls[0].arguments), { pattern: 'BrowserView', path: 'D:/agents/dsh' });
  assert.equal(w1.content.trim(), '');
  const wf = new DSMLStreamFilter(tools);
  const wc = [];
  let wout = '';
  for (const ch of wrapToolCalls) {
    const r = wf.push(ch);
    wout += r.content;
    wc.push(...r.calls);
  }
  const wt = wf.flush();
  wout += wt.content;
  wc.push(...wt.calls);
  assert.equal(wc.length, 1, 'tool_calls wrapper stream, got ' + wc.length);
  assert.equal(wout.trim(), '', 'no wrapper tokens in content');

  // === 2026-11-02 live 实抓：<｜tool_call> 包裹裸 <invoke>/<parameter> 的混合变体 ===
  const hybrid = [
    '<｜tool_call>',
    '<invoke name="grep">',
    '<parameter name="pattern">BrowserView</parameter>',
    '<parameter name="path">D:/agents/dsh</parameter>',
    '</invoke>',
    '</tool_call>',
  ].join('\n');
  const h1 = parseQwenCalls(hybrid, tools);
  assert.equal(h1.calls.length, 1, 'hybrid invoke form, got ' + h1.calls.length);
  assert.equal(h1.calls[0].name, 'grep');
  assert.deepEqual(JSON.parse(h1.calls[0].arguments), { pattern: 'BrowserView', path: 'D:/agents/dsh' });
  assert.equal(h1.content.trim(), '');
  const hf = new DSMLStreamFilter(tools);
  const hc = [];
  let hout = '';
  for (const ch of hybrid) {
    const r = hf.push(ch);
    hout += r.content;
    hc.push(...r.calls);
  }
  const ht = hf.flush();
  hout += ht.content;
  hc.push(...ht.calls);
  assert.equal(hc.length, 1, 'hybrid stream, got ' + hc.length);
  assert.equal(hout.trim(), '', 'no hybrid tokens in content');

  // === 2026-11-02 live 实抓：模型把标记写成 <｜toolDSML｜invoke> / <｜toolDSMLparameter> ===
  const mangled = [
    '<｜toolDSML｜invoke name="grep">',
    '<｜toolDSMLparameter name="pattern" string="true">BrowserView</｜toolDSMLparameter>',
    '<｜toolDSMLparameter name="path" string="true">D:/agents/dsh</｜toolDSMLparameter>',
    '</｜toolDSMLinvoke>',
    '</｜toolDSMLcalls>',
  ].join('\n');
  const mg = parseDSMLCalls(mangled, tools);
  assert.equal(mg.calls.length, 1, 'mangled DSML tags, got ' + mg.calls.length);
  assert.deepEqual(JSON.parse(mg.calls[0].arguments), { pattern: 'BrowserView', path: 'D:/agents/dsh' });
  assert.equal(mg.content.trim(), '');
  const mf = new DSMLStreamFilter(tools);
  const mc = [];
  let mout = '';
  for (const ch of mangled) {
    const r = mf.push(ch);
    mout += r.content;
    mc.push(...r.calls);
  }
  const mt = mf.flush();
  mout += mt.content;
  mc.push(...mt.calls);
  assert.equal(mc.length, 1, 'mangled DSML stream, got ' + mc.length);
  assert.equal(mout.trim(), '', 'no mangled tokens in content');

  // === 2026-11-02 live 实抓：竖线数写成 3 个，且参数闭标签比开标签多一根 ===
  const triple = [
    '<｜｜｜DSML｜invoke name="grep">',
    '<｜｜｜DSML｜parameter name="pattern" string="true">BrowserView</｜｜｜DSML｜parameter>',
    '<｜｜｜DSML｜parameter name="path" string="true">D:/agents/dsh</｜｜｜DSML｜parameter>',
    '</｜｜｜DSML｜invoke>',
    '</｜｜｜DSML｜calls>',
  ].join('\n');
  const tr = parseDSMLCalls(triple, tools);
  assert.equal(tr.calls.length, 1, 'triple-bar tags, got ' + tr.calls.length);
  assert.deepEqual(JSON.parse(tr.calls[0].arguments), { pattern: 'BrowserView', path: 'D:/agents/dsh' });
  const tf = new DSMLStreamFilter(tools);
  const tc = [];
  let tout = '';
  for (const ch of triple) {
    const r = tf.push(ch);
    tout += r.content;
    tc.push(...r.calls);
  }
  const tt = tf.flush();
  tout += tt.content;
  tc.push(...tt.calls);
  assert.equal(tc.length, 1, 'triple-bar stream, got ' + tc.length);
  assert.deepEqual(JSON.parse(tc[0].arguments), { pattern: 'BrowserView', path: 'D:/agents/dsh' });
  assert.equal(tout.trim(), '');

  // 未知关键字的 DSML 标记不泄漏
  const junk = parseDSMLCalls('a<｜｜DSML｜foo>hi</｜｜DSML｜foo>b', tools);
  assert.equal(junk.calls.length, 0);
  assert.equal(junk.content, 'ahib');
  const jf = new DSMLStreamFilter(tools);
  let jout = '';
  for (const ch of 'a<｜｜DSML｜foo>hi</｜｜DSML｜foo>b') jout += jf.push(ch).content;
  jout += jf.flush().content;
  assert.equal(jout, 'ahib');

  // 普通尖括号文本不受影响
  const f3 = new DSMLStreamFilter(tools);
  const p3 = f3.push('a < b and c < d > e');
  const t3 = f3.flush();
  assert.equal(p3.content + t3.content, 'a < b and c < d > e');
  assert.equal(t3.calls.length, 0);

  // DSML 与 Qwen 块混排：静态解析两种都收
  const B = '｜';
  const dsml = `<${B}${B}DSML${B}${B} calls><${B}${B}DSML${B}${B} invoke name="working_directory"></${B}${B}DSML${B}${B} invoke></${B}${B}DSML${B}${B} calls>`;
  const mixed = parseDSMLCalls(dsml + leaked, tools);
  assert.equal(mixed.calls.length, 3, 'mixed protocols, got ' + mixed.calls.length);
  assert.equal(mixed.calls[0].name, 'working_directory');

  // 历史回填：tool_calls -> Qwen XML；tool 消息 -> user 观察文本
  const mapped = mapQwenToolMessage({ role: 'assistant', text: '', tool_calls: [{ function: { name: 'grep', arguments: JSON.stringify({ pattern: 'x' }) } }] });
  assert.ok(mapped.content.includes('<function=grep>'));
  assert.ok(mapped.content.includes('<parameter=pattern>x</parameter>'));
  assert.equal(mapQwenToolMessage({ role: 'tool', name: 'grep', text: 'hit' }).role, 'user');

  // 渲染再解析应还原参数
  const round = parseQwenCalls(renderQwenCalls([{ function: { name: 'grep', arguments: JSON.stringify({ pattern: 'a|b', path: '.' }) } }]), tools);
  assert.equal(round.calls.length, 1);
  assert.deepEqual(JSON.parse(round.calls[0].arguments), { pattern: 'a|b', path: '.' });

  // 工具文档使用 Qwen 原生格式
  const doc = qwenToolDoc(tools);
  assert.ok(doc.includes('<function=tool_name>'));
  assert.ok(doc.includes('<parameter=param>text value</parameter>'));
  assert.ok(doc.includes('- grep(pattern, path?)'));

  console.log('qwen-tools.test.js: all assertions passed');
}

run();
