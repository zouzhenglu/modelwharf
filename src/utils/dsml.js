'use strict';
/**
 * DSML 文本工具调用协议（DeepSeek 原生 agent 格式）。
 *
 * 背景：DeepSeek V4 系模型在「工具只出现在提示词文本里、请求没带原生 tools 字段」时
 * （qoder/qodercn/trae 等上游没有 tools 透传），会按训练格式把工具调用写成正文里的
 * DSML 标记——直接透传就是用户看到的乱码文本，客户端无法执行：
 *
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="bash">
 *   <｜｜DSML｜｜ parameter name="command" string="true">pwd</｜｜DSML｜｜ parameter>
 *   <｜｜DSML｜｜ parameter name="input" string="false">{}</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 *
 * ｜ 为 U+FF5C 全角竖线；模型经文本通道输出时两侧常渲染成 1~2 个，解析需兼容。
 * string="true" 表示纯文本值，string="false" 表示 JSON 值。
 *
 * 真实输出还经常退化（2026-10-25 DeepSeek harness 端到端实抓，四类样本）：
 *   - <invoke name="…"> 开标签整个缺失，参数直接裸在 <calls> 块里；
 *   - 闭标签退化成裸 </｜｜DSML｜｜> / <｜｜DSML｜｜>；
 *   - 多出成对冗余闭标记（</parameter>、</invoke> 连发两次）；
 *   - 全部标记挤在一行、标记间夹空格。
 * 因此块内按宽容 token 流解析（就近归属、歧义边界先收口），不按严格嵌套配对；
 * 推不出名字的 invoke 用请求 tools 的参数 schema 推断（参数名重合度唯一最优才采用）。
 *
 * 本模块提供双向转换：
 *   - 请求侧 renderDSMLCalls：把历史 assistant.tool_calls 渲染回 DSML 文本（模型看得懂自己的前语），
 *     tool 角色消息转成 user 观察文本（多数上游校验拒绝孤儿 tool 角色）。
 *   - 响应侧 DSMLStreamFilter / parseDSMLCalls：把正文里的 DSML 块解析成 OpenAI tool_calls
 *     （流式安全：标记可能被切在任意 chunk 边界）。
 *   - dsmlToolDoc：把 OpenAI tools 数组渲染成提示词工具清单（上游吃不到原生 tools 时的注入物）。
 */
const crypto = require('crypto');

const BARS = ['｜', '｜｜'];
const SPACE = [' ', ''];   // 关键字前空格可省（V4 也有 <｜｜DSML｜｜calls> 无空格形态）
const OPENERS = BARS.flatMap(a => BARS.flatMap(b => SPACE.map(s => `<${a}DSML${b}${s}calls>`)));
const CLOSERS = BARS.flatMap(a => BARS.flatMap(b => SPACE.map(s => `</${a}DSML${b}${s}calls>`)));
const OPEN_RE = /<｜{1,2}DSML｜{1,2}\s*calls>/;
const CLOSE_RE = /<\/｜{1,2}DSML｜{1,2}\s*calls>/;
// 块内任意位置的 DSML 标记（含退化形态：裸 <…>/</…>、缺 name 属性的 invoke、关键字前无空格）
const ANY_TAG_RE = /<(\/?)｜{1,2}DSML｜{1,2}([^>]*)>/g;
// 未闭合块的兜底上限：超过即放弃解析按原文输出，防止异常输出把流卡死
const MAX_BLOCK = 131072;

function isPrefixOfAny(cands, s) {
  return s.length > 0 && cands.some(c => c.length > s.length && c.startsWith(s));
}

/** 无名 invoke 的工具名推断：按参数名与请求 tools 的 schema 属性重合度取唯一最优。
 *  并列或零重合返回 ''（该调用将被丢弃——宁可不执行也不猜错工具）。 */
function matchToolByParams(tools, paramNames) {
  if (!Array.isArray(tools) || !tools.length || !paramNames.length) return '';
  const have = new Set(paramNames);
  let best = '', bestScore = 0, second = 0;
  for (const t of tools) {
    const fn = t.function || t;
    if (!fn?.name) continue;
    const score = Object.keys(fn.parameters?.properties || {}).filter(p => have.has(p)).length;
    if (score > bestScore) { second = bestScore; bestScore = score; best = fn.name; }
    else if (score > second) second = score;
  }
  return bestScore > 0 && bestScore > second ? best : '';
}

/** 解析 calls 块内文本 → [{name, arguments(JSON 字符串)}]（全部带名字；推不出的丢弃）。
 *  宽容解析：不假设 invoke 开标签存在、不假设闭标签完整，按 token 流就近归属：
 *   - <invoke …> 开标签：先收前一个 invoke 再开新的（含缺 name 属性的形态）；
 *   - <parameter …>：没有 invoke 就地开一个无名 invoke（开标签缺失的兜底）；
 *   - 裸 <…>/</…>/未知关键字/多余闭标记：能收口当前参数就收口，其余丢弃；
 *   - 标记之间的正文：参数开着时算参数值，否则是块内空白，丢弃。 */
function parseInvokes(inner, tools) {
  const calls = [];
  let cur = null;                                  // 当前 invoke { name, params }
  let paramName = null, paramIsStr = null, paramBuf = '';
  const closeParam = () => {
    if (!cur || paramName === null) return;
    const raw = paramBuf;
    let val;
    if (paramIsStr === true) val = raw;
    else if (paramIsStr === false) { try { val = JSON.parse(raw); } catch { val = raw; } }
    else {
      const t = raw.trim();
      if ((t[0] === '{' && t.endsWith('}')) || (t[0] === '[' && t.endsWith(']'))) {
        try { val = JSON.parse(t); } catch { val = raw; }
      } else val = raw;
    }
    if (paramName) cur.params[paramName] = val;
    paramName = null; paramIsStr = null; paramBuf = '';
  };
  const closeInvoke = () => {
    if (!cur) return;
    closeParam();
    if (cur.name || Object.keys(cur.params).length) {
      const name = cur.name || matchToolByParams(tools, Object.keys(cur.params));
      if (name) calls.push({ name, arguments: JSON.stringify(cur.params) });
    }
    cur = null;
  };
  ANY_TAG_RE.lastIndex = 0;
  let last = 0;
  for (let m; (m = ANY_TAG_RE.exec(inner));) {
    if (paramName !== null) paramBuf += inner.slice(last, m.index);
    last = m.index + m[0].length;
    const kw = m[2].trim();
    if (kw.startsWith('invoke')) {
      closeInvoke();                               // </invoke> 收尾；<invoke> 开标签先收前一个
      if (!m[1]) cur = { name: (kw.match(/name="([^"]*)"/) || [])[1] || '', params: {} };
    } else if (kw.startsWith('parameter')) {
      if (m[1]) closeParam();                      // </parameter>
      else {
        if (!cur) cur = { name: '', params: {} };  // invoke 开标签缺失：参数直接开一个无名 invoke
        closeParam();                              // 上个参数闭标签丢失时就近收口
        paramName = (kw.match(/name="([^"]*)"/) || [])[1] || '';
        const sf = kw.match(/string="(true|false)"/);
        paramIsStr = sf ? sf[1] === 'true' : null;
        paramBuf = '';
      }
    } else closeParam();                           // 裸 <…>/</…> 等退化标记：收口当前参数
  }
  if (paramName !== null) paramBuf += inner.slice(last);
  closeInvoke();
  return calls;
}

/** 块内是否出现过 DSML 标记（决定零调用块是「剥掉」还是「按原文放行」） */
function blockHadTags(inner) {
  ANY_TAG_RE.lastIndex = 0;
  return ANY_TAG_RE.test(inner);
}

/** 整段文本静态解析：剥掉所有 DSML 块，返回 { content, calls }（tools 用于缺名推断） */
function parseDSMLCalls(text, tools) {
  const calls = [];
  const content = String(text || '').replace(/<｜{1,2}DSML｜{1,2}\s*calls>([\s\S]*?)<\/｜{1,2}DSML｜{1,2}\s*calls>/g, (_, inner) => {
    calls.push(...parseInvokes(inner, tools));
    return '';
  });
  return { content, calls };
}

/** OpenAI tool_calls 数组 → DSML 块文本（写进 assistant 历史用） */
function renderDSMLCalls(calls = []) {
  if (!calls?.length) return '';
  const lines = ['<｜｜DSML｜｜ calls>'];
  for (const tc of calls) {
    const fn = tc.function || {};
    lines.push(`<｜｜DSML｜｜ invoke name="${fn.name || ''}">`);
    let args = {};
    try {
      args = typeof fn.arguments === 'string' ? (fn.arguments.trim() ? JSON.parse(fn.arguments) : {}) : (fn.arguments || {});
    } catch { args = null; }
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === 'string') lines.push(`<｜｜DSML｜｜ parameter name="${k}" string="true">${v}</｜｜DSML｜｜ parameter>`);
        else lines.push(`<｜｜DSML｜｜ parameter name="${k}" string="false">${JSON.stringify(v)}</｜｜DSML｜｜ parameter>`);
      }
    } else if (fn.arguments) {
      lines.push(`<｜｜DSML｜｜ parameter name="arguments" string="false">${String(fn.arguments)}</｜｜DSML｜｜ parameter>`);
    }
    lines.push('</｜｜DSML｜｜ invoke>');
  }
  lines.push('</｜｜DSML｜｜ calls>');
  return lines.join('\n');
}

/** 单条规范消息 → 上游平面消息（无原生 tools 通道的 provider 共用）。
 *  assistant.tool_calls 渲染成 DSML 文本（模型看得懂自己的前语）；
 *  tool 角色转 user 观察文本（多数上游校验拒绝孤儿 tool 角色）。
 *  非工具相关消息返回 null，由调用方走各自默认转换。 */
function mapToolMessage(m) {
  if (m.role === 'tool') {
    return { role: 'user', content: `[Tool result${m.name ? ' for ' + m.name : ''}]\n${m.text || ''}` };
  }
  if (m.role === 'assistant' && m.tool_calls?.length) {
    const text = m.text || '';
    return { role: 'assistant', content: (text ? text + '\n' : '') + renderDSMLCalls(m.tool_calls) };
  }
  return null;
}

/** OpenAI tools 数组 → 提示词工具清单（教模型用 DSML 格式发起调用） */
function dsmlToolDoc(tools = []) {
  const lines = [
    '# Tool use',
    '',
    'To call a tool, emit a DSML block in your reply (one block, one <...invoke> per call):',
    '',
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="tool_name">',
    '<｜｜DSML｜｜ parameter name="param" string="true">text value</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="data" string="false">{"json":"value"}</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>',
    '',
    'string="true" = plain text value, string="false" = JSON value. Stop after emitting the block; tool results will be returned to you.',
    '',
    'Available tools:',
  ];
  for (const t of tools) {
    const fn = t.function || t;
    if (!fn?.name) continue;
    const props = fn.parameters?.properties || {};
    const req = fn.parameters?.required || [];
    const sig = Object.keys(props).map(p => (req.includes(p) ? p : `${p}?`)).join(', ');
    lines.push(`- ${fn.name}(${sig})${fn.description ? `: ${String(fn.description).slice(0, 200)}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * 流式 DSML 过滤器：push() 逐段喂正文增量，返回该段可安全输出的
 * { content, calls }（calls 为解析完成的完整调用）；flush() 收尾。
 * 标记被切在 chunk 边界时自动扣住待定文本，不会误放行半截标记。
 * tools（请求里的工具清单）用于给缺失开标签的 invoke 推断工具名。
 */
class DSMLStreamFilter {
  constructor(tools = null) {
    this.tools = tools;
    this.pending = '';   // TEXT 态待定文本（已见 '<' 但还判定不了的从这开始）
    this.block = null;   // { opener, buf } DSML 块内缓冲
    this.sawCalls = false;
  }

  push(text) {
    this.pending += text || '';
    return this._drain(false);
  }

  flush() {
    const r = this._drain(true);
    // 全部输出是 DSML 调用时，把残余空白也吞掉，避免客户端渲染出空消息
    if (r.calls.length && !r.content.trim()) r.content = '';
    return r;
  }

  _drain(final) {
    let content = '';
    const calls = [];
    for (;;) {
      if (this.block) {
        if (this.pending) { this.block.buf += this.pending; this.pending = ''; }
        const m = CLOSE_RE.exec(this.block.buf);
        if (m) {
          const inner = this.block.buf.slice(0, m.index);
          const rest = this.block.buf.slice(m.index + m[0].length);
          const parsed = parseInvokes(inner, this.tools);
          if (parsed.length) { calls.push(...parsed); this.sawCalls = true; }
          else if (blockHadTags(inner)) { /* 退化块（无结构化调用可救）：整体剥掉，不放行标签汤 */ }
          else content += this.block.opener + inner + m[0]; // 块内没有任何 DSML 标记：按原文放行
          this.block = null;
          this.pending = rest;
          continue;
        }
        if (final) {
          // 流结束时块未闭合（输出被截断）：能救几个 invoke 救几个，救不了且有标记就剥掉
          const parsed = parseInvokes(this.block.buf, this.tools);
          if (parsed.length) { calls.push(...parsed); this.sawCalls = true; }
          else if (blockHadTags(this.block.buf)) { /* 剥掉 */ }
          else content += this.block.opener + this.block.buf;
          this.block = null;
          this.pending = '';
          continue;
        }
        if (isPrefixOfAny(CLOSERS, this.block.buf)) return { content, calls }; // 闭标记可能被切断，再等等
        if (this.block.buf.length > MAX_BLOCK) {
          content += this.block.opener + this.block.buf;
          this.block = null;
          this.pending = '';
          continue;
        }
        return { content, calls }; // 块内继续缓冲
      }
      // TEXT 态
      const lt = this.pending.indexOf('<');
      if (lt === -1) { content += this.pending; this.pending = ''; return { content, calls }; }
      content += this.pending.slice(0, lt);
      this.pending = this.pending.slice(lt);
      const opener = OPENERS.find(o => this.pending.startsWith(o));
      if (opener) {
        this.block = { opener, buf: this.pending.slice(opener.length) };
        this.pending = '';
        continue;
      }
      if (!final && isPrefixOfAny(OPENERS, this.pending)) return { content, calls }; // 开标记未收全
      content += '<'; // 不是 DSML 开标记：放行这个 '<' 继续扫
      this.pending = this.pending.slice(1);
    }
  }
}

/** 生成 OpenAI 风格的 tool_call id */
function newToolCallId() {
  return 'call_' + crypto.randomBytes(12).toString('hex');
}

module.exports = { parseDSMLCalls, renderDSMLCalls, mapToolMessage, dsmlToolDoc, DSMLStreamFilter, newToolCallId };
