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

// 模型经文本通道写标记时会变形：全角/半角、单双竖线、DSML 前后竖线数不对称、
// 甚至把关键字写成工具名（<｜toolDSML｜invoke>）。统一按下面的宽容文法识别。
const BARS_PRE = ['｜', '｜｜', '|', '||'];
const BARS_POST = ['', '｜', '｜｜', '|', '||'];
const TOOL_PREFIXES = ['', 'tool'];
const SPACE = [' ', ''];   // 关键字前空格可省（V4 也有 <｜｜DSML｜｜calls> 无空格形态）
// 外壳关键字实抓见过 calls / tool_calls；统一按 calls、tool_call、tool_calls 识别
const CALL_KWS = ['calls', 'tool_calls', 'tool_call', 'toolcalls'];
const DSML_SRC = '[｜|]+(?:tool)?DSML[｜|]*';
const OPENERS = [];
const CLOSERS = [];
const BARE_OPENERS = [];
const BARE_CLOSERS = [];
for (const a of BARS_PRE) for (const t of TOOL_PREFIXES) for (const b of BARS_POST) {
  for (const s of SPACE) for (const k of CALL_KWS) {
    OPENERS.push(`<${a}${t}DSML${b}${s}${k}>`);
    CLOSERS.push(`</${a}${t}DSML${b}${s}${k}>`);
  }
  BARE_OPENERS.push(`<${a}${t}DSML${b}invoke`, `<${a}${t}DSML${b}parameter`);
  BARE_CLOSERS.push(`</${a}${t}DSML${b}invoke>`);
  for (const k of CALL_KWS) BARE_CLOSERS.push(`</${a}${t}DSML${b}${k}>`);
}
const OPEN_RE = new RegExp(`<${DSML_SRC}\\s*(?:tool_?calls?|calls)\\s*>`, 'i');
const CLOSE_RE = new RegExp(`</${DSML_SRC}\\s*(?:tool_?calls?|calls)\\s*>`, 'i');
// 块内任意位置的 DSML 标记（含退化形态：裸 <…>/</…>、缺 name 属性的 invoke、关键字前无空格）
const ANY_TAG_RE = new RegExp(`<(\\/?)${DSML_SRC}([^>]*)>`, 'gi');
// 缺 <… calls> 外壳、直接从 <… invoke> 开始的退化块（live qwen3.8-max 实抓）
const BARE_START_RE = new RegExp(`^<${DSML_SRC}\\s*(?:invoke|parameter)`, 'i');
const BARE_CLOSE_RE = new RegExp(`</${DSML_SRC}\\s*(?:invoke|tool_?calls?|calls)\\s*>`, 'i');
const STRAY_DSML_CLOSE_RE = new RegExp(`^</${DSML_SRC}\\s*(?:invoke|parameter|tool_?calls?|calls)\\s*>`, 'i');
// 未知关键字的完整 DSML 标记：直接剥掉，避免变体泄漏成正文
const GENERIC_DSML_TAG_RE = new RegExp(`^</?${DSML_SRC}[^>]*>`, 'i');
const WRAP_OPEN_RE = new RegExp(`^<${DSML_SRC}\\s*(?:tool_?calls?|calls)\\s*>`, 'i');
const BARE_OPEN_TAG_RE = new RegExp(`^<${DSML_SRC}\\s*(?:invoke|parameter)(?:\\s[^>]*)?>`, 'i');
const BARS_PREFIX = ['｜', '｜｜', '｜｜｜', '｜｜｜｜', '|', '||', '|||', '||||'];
const DSML_PREFIX_CORE = [];
for (const a of BARS_PREFIX) for (const t of TOOL_PREFIXES) DSML_PREFIX_CORE.push(`${a}${t}DSML`);
const DSML_PREFIX_RE = new RegExp(`^${DSML_SRC}[^>]*$`, 'i');
const WRAP_BLOCK_RE = new RegExp(`<${DSML_SRC}\\s*(?:tool_?calls?|calls)\\s*>([\\s\\S]*?)</${DSML_SRC}\\s*(?:tool_?calls?|calls)\\s*>`, 'gi');
const BARE_INVOKE_BLOCK_RE = new RegExp(`<${DSML_SRC}\\s*invoke\\b[\\s\\S]*?</${DSML_SRC}\\s*invoke\\s*>`, 'gi');
const SECTION_STRAY_GLOBAL_RE = /<[｜|]{1,2}tool_(?:calls_section_begin|calls_section_end|call_begin|call_argument_begin|call_end)\s*[|｜]>/g;
// 未闭合块的兜底上限：超过即放弃解析按原文输出，防止异常输出把流卡死
const MAX_BLOCK = 131072;

// ---------- Qwen 文本工具调用协议 ----------
// Qwen3-Coder / Qwen3.8 经文本通道输出时使用自己的 XML 形态（与 DSML 无关）：
//
//   <tool_call>
//   <function=grep>
//   <parameter=pattern>foo</parameter>
//   <parameter=path>D:\agents\dsh</parameter>
//   </function>
//   </tool_call>
//
// 也兼容 <tool_call>{"name":"grep","arguments":{...}}</tool_call>。
// 参数值没有类型标记，按请求 tools 的 schema 做数字/布尔/对象转换。
// live 输出见过 <tool_call>、<｜tool_call> 两种开头；内层可能是 <function=…> 或裸 <invoke>
const QWEN_OPENERS = ['<tool_call>', '<｜tool_call>', '<｜｜tool_call>', '<|tool_call>', '<||tool_call>'];
const QWEN_OPEN = QWEN_OPENERS[0];
const QWEN_CLOSE_RE = /<\/tool_call\s*>/;
const QWEN_BLOCK_RE = /<[｜|]{0,2}tool_call\s*>([\s\S]*?)<\/tool_call\s*>/g;
const QWEN_TAG_RE = /<\/?(?:function|parameter)(?:[^>]*)>/g;

// ---------- DeepSeek V3.1 风格特殊 token 工具调用 ----------
// qwen3.8-max 经 trae 文本通道也会输出（2026-11-02 实抓）：
//
//   <｜tool_calls_section_begin|>
//   <｜tool_call_begin|>grep<｜tool_call_argument_begin|>{"pattern":"x"}
//   <｜tool_call_end|>
//   <｜tool_calls_section_end|>
//
// 函数名偶尔带 functions. 前缀或 :<序号> 后缀；参数是 JSON。
const SECTION_BEGIN = '<｜tool_calls_section_begin|>';
const SECTION_END = '<｜tool_calls_section_end|>';
const SECTION_CALL_BEGIN = '<｜tool_call_begin|>';
const SECTION_ARG_BEGIN = '<｜tool_call_argument_begin|>';
const SECTION_CALL_END = '<｜tool_call_end|>';
const SECTION_TOKENS = [
  SECTION_BEGIN, SECTION_END, SECTION_CALL_BEGIN, SECTION_ARG_BEGIN, SECTION_CALL_END,
  SECTION_BEGIN.replace(/｜/g, '|'), SECTION_END.replace(/｜/g, '|'),
  SECTION_CALL_BEGIN.replace(/｜/g, '|'), SECTION_ARG_BEGIN.replace(/｜/g, '|'),
  SECTION_CALL_END.replace(/｜/g, '|'),
];
const SECTION_BLOCK_RE = /<[｜|]{1,2}tool_calls_section_begin\s*[|｜]>([\s\S]*?)<[｜|]{1,2}tool_calls_section_end\s*[|｜]>/g;
const SECTION_END_RE = /<[｜|]{1,2}tool_calls_section_end\s*[|｜]>/;
const SECTION_CALL_RE = /<[｜|]{1,2}tool_call_begin\s*[|｜]>([\s\S]*?)(?:<[｜|]{1,2}tool_call_argument_begin\s*[|｜]>([\s\S]*?))?<[｜|]{1,2}tool_call_end\s*[|｜]>/g;
const SECTION_START_RE = /^<[｜|]{1,2}(?:tool_calls_section_begin|tool_call_begin)\s*[|｜]>/;
const SECTION_STRAY_RE = /^<[｜|]{1,2}tool_call_(?:argument_begin|end)\s*[|｜]>|^<[｜|]{1,2}tool_calls_section_end\s*[|｜]>/;

function isPrefixOfAny(cands, s) {
  return s.length > 0 && cands.some(c => c.length > s.length && c.startsWith(s));
}

/** 半截 DSML 标记（含未知关键字/变形）也要扣住，避免被逐字符放行成正文 */
function isDsmlTagPrefix(s) {
  if (!s.startsWith('<')) return false;
  const body = s.replace(/^<\/?/, '');
  return DSML_PREFIX_CORE.some(c => c.startsWith(body)) || DSML_PREFIX_RE.test(body);
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
    // string="true"：去掉标签换行/尾部空白（与 ds2api 的宽容处理保持一致）
    if (paramIsStr === true) val = raw.replace(/^\r?\n/, '').replace(/\s+$/, '');
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

// ---------- Qwen 工具调用解析 ----------

/** <function=foo> / <function name="foo"> 的属性部分 -> 名字 */
function parseQwenTagName(attrs) {
  const s = String(attrs || '');
  let m = s.match(/^\s*=\s*(?:"([^"]*)"|'([^']*)'|([^>\s]+))/);
  if (m) return m[1] ?? m[2] ?? m[3] ?? '';
  m = s.match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^>\s]+))/);
  if (m) return m[1] ?? m[2] ?? m[3] ?? '';
  return '';
}

/** 按 tools schema 把 Qwen 的裸文本参数转成目标类型；无 schema 时保持字符串。 */
function coerceQwenValue(tools, fnName, key, raw) {
  const v = String(raw ?? '').trim();
  const fn = (tools || []).map(t => t.function || t).find(f => f?.name === fnName);
  const type = fn?.parameters?.properties?.[key]?.type;
  if (type === 'number' || type === 'integer') {
    const n = Number(v);
    if (v !== '' && Number.isFinite(n)) return n;
  }
  if (type === 'boolean') {
    if (/^true$/i.test(v)) return true;
    if (/^false$/i.test(v)) return false;
  }
  if (type === 'object' || type === 'array') {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

/** 解析一个 <tool_call> 块内部：XML 形态优先，其次单对象 JSON 形态。
 *  宽容处理：缺 </parameter> / </function> 时按下一个标记或块尾收口。 */
function parseQwenInner(inner, tools) {
  const text = String(inner || '').trim();
  if (!text) return [];

  // JSON 形态：{"name":"grep","arguments":{"pattern":"..."}} 或 {"function":{...}}
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      const fn = j.function || j;
      const name = fn.name || j.tool_name || j.tool;
      let args = fn.arguments ?? j.arguments ?? j.parameters ?? j.params ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep */ } }
      if (name && args != null && typeof args === 'object') {
        return [{ name: String(name), arguments: JSON.stringify(args) }];
      }
    } catch { /* fall through to XML */ }
  }

  const fnCalls = parseQwenFunctionCalls(text, tools);
  return fnCalls.length ? fnCalls : parsePlainInvokes(text, tools);
}

/** <function=foo><parameter=bar>…</parameter></function> 形态 */
function parseQwenFunctionCalls(text, tools) {
  const calls = [];
  let cur = null, paramName = null, paramBuf = '';
  const closeParam = () => {
    if (cur && paramName) cur.params[paramName] = coerceQwenValue(tools, cur.name, paramName, paramBuf);
    paramName = null; paramBuf = '';
  };
  const closeCall = () => {
    if (!cur) return;
    closeParam();
    if (cur.name || Object.keys(cur.params).length) {
      const name = cur.name || matchToolByParams(tools, Object.keys(cur.params));
      if (name) calls.push({ name, arguments: JSON.stringify(cur.params) });
    }
    cur = null;
  };
  QWEN_TAG_RE.lastIndex = 0;
  let last = 0;
  for (let m; (m = QWEN_TAG_RE.exec(text));) {
    if (paramName !== null) paramBuf += text.slice(last, m.index);
    last = m.index + m[0].length;
    const closing = m[0].startsWith('</');
    const kind = m[0].slice(closing ? 2 : 1).match(/^(function|parameter)/)?.[1];
    const attrs = m[0].replace(/^<\/?(function|parameter)/, '').replace(/>$/, '');
    const name = parseQwenTagName(attrs);
    if (kind === 'function') {
      if (closing) closeCall();
      else { closeCall(); cur = { name, params: {} }; }
    } else {
      if (closing) closeParam();
      else {
        if (!cur) cur = { name: '', params: {} };   // 缺 function 开标签：参数直接开无名调用
        closeParam();                              // 上个参数闭标签丢失时就近收口
        paramName = name;
        paramBuf = '';
      }
    }
  }
  if (paramName !== null) paramBuf += text.slice(last);
  closeCall();
  return calls;
}

/** 纯 <invoke name="grep"><parameter name="pattern">…</parameter></invoke> 形态。
 *  live qwen3.8-max 输出过 <｜tool_call> 包裹这种裸标签的混合变体。 */
function parsePlainInvokes(text, tools) {
  const calls = [];
  let cur = null, paramName = null, paramBuf = '', paramString = null;
  const closeParam = () => {
    if (cur && paramName) {
      cur.params[paramName] = paramString === true
        ? paramBuf.trim()
        : coerceQwenValue(tools, cur.name, paramName, paramBuf);
    }
    paramName = null; paramBuf = ''; paramString = null;
  };
  const closeCall = () => {
    if (!cur) return;
    closeParam();
    if (cur.name || Object.keys(cur.params).length) {
      const name = cur.name || matchToolByParams(tools, Object.keys(cur.params));
      if (name) calls.push({ name, arguments: JSON.stringify(cur.params) });
    }
    cur = null;
  };
  const TAG_RE = /<(\/?)(invoke|parameter)([^>]*)>/g;
  let last = 0;
  for (let m; (m = TAG_RE.exec(text));) {
    if (paramName !== null) paramBuf += text.slice(last, m.index);
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const kind = m[2];
    const attrs = m[3] || '';
    const name = parseQwenTagName(attrs);
    if (kind === 'invoke') {
      if (closing) closeCall();
      else { closeCall(); cur = { name, params: {} }; }
    } else {
      if (closing) closeParam();
      else {
        if (!cur) cur = { name: '', params: {} };
        closeParam();
        paramName = name;
        paramBuf = '';
        const sm = attrs.match(/\bstring\s*=\s*"(true|false)"/);
        paramString = sm ? sm[1] === 'true' : null;
      }
    }
  }
  if (paramName !== null) paramBuf += text.slice(last);
  closeCall();
  return calls;
}

/** 块内是否出现过 Qwen 工具标记（决定零调用块是「剥掉」还是「按原文放行」） */
function qwenBlockHadTags(inner) {
  QWEN_TAG_RE.lastIndex = 0;
  return QWEN_TAG_RE.test(inner);
}

/** 解析 DeepSeek V3.1 风格特殊 token 块：每个 call_begin…call_end 一段。
 *  参数缺失（无参工具）按 {} 处理；JSON 解析失败也不丢调用。 */
function parseSectionCalls(inner) {
  const calls = [];
  SECTION_CALL_RE.lastIndex = 0;
  const src = String(inner || '');
  for (let m; (m = SECTION_CALL_RE.exec(src));) {
    const name = String(m[1] || '').trim().replace(/^functions\./, '').replace(/:\d+$/, '');
    let args = {};
    const raw = String(m[2] ?? '').trim();
    if (raw) { try { args = JSON.parse(raw); } catch { args = {}; } }
    if (name) calls.push({ name, arguments: JSON.stringify(args) });
  }
  return calls;
}

/** 整段文本静态解析 Qwen 块：剥掉块，返回 { content, calls } */
function parseQwenCalls(text, tools) {
  const calls = [];
  const content = String(text || '').replace(QWEN_BLOCK_RE, (_, inner) => {
    calls.push(...parseQwenInner(inner, tools));
    return '';
  });
  return { content, calls };
}

/** OpenAI tool_calls 数组 -> Qwen XML 块文本（写进历史用） */
function renderQwenCalls(calls = []) {
  const blocks = [];
  for (const tc of calls) {
    const fn = tc.function || {};
    let args = {};
    try {
      args = typeof fn.arguments === 'string'
        ? (fn.arguments.trim() ? JSON.parse(fn.arguments) : {})
        : (fn.arguments || {});
    } catch { args = null; }
    const lines = ['<tool_call>', `<function=${fn.name || ''}>`];
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      for (const [k, v] of Object.entries(args)) {
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        lines.push(`<parameter=${k}>${s}</parameter>`);
      }
    } else if (fn.arguments) {
      lines.push(`<parameter=arguments>${String(fn.arguments)}</parameter>`);
    }
    lines.push('</function>', '</tool_call>');
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n');
}

/** 单条规范消息 -> Qwen 文本工具协议的上游消息（历史回填用） */
function mapQwenToolMessage(m) {
  if (m.role === 'tool') {
    return { role: 'user', content: `[Tool result${m.name ? ' for ' + m.name : ''}]\n${m.text || ''}` };
  }
  if (m.role === 'assistant' && m.tool_calls?.length) {
    const text = m.text || '';
    return { role: 'assistant', content: (text ? text + '\n' : '') + renderQwenCalls(m.tool_calls) };
  }
  return null;
}

/** OpenAI tools 数组 -> Qwen 原生 XML 形态的提示词工具清单 */
function qwenToolDoc(tools = []) {
  const lines = [
    '# Tool use',
    '',
    'To call a tool, emit one <tool_call> block per call:',
    '',
    '<tool_call>',
    '<function=tool_name>',
    '<parameter=param>text value</parameter>',
    '<parameter=data>{"json":"value"}</parameter>',
    '</function>',
    '</tool_call>',
    '',
    'Parameter values are plain text; the gateway converts them to the declared schema type. Stop after emitting the block; tool results will be returned to you.',
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

/** 整段文本静态解析：剥掉所有 DSML / Qwen 工具块，返回 { content, calls }
 *  （tools 用于缺名推断与 Qwen 参数类型转换） */
function parseDSMLCalls(text, tools) {
  const calls = [];
  let content = String(text || '');
  content = content.replace(QWEN_BLOCK_RE, (_, inner) => {
    calls.push(...parseQwenInner(inner, tools));
    return '';
  });
  content = content.replace(SECTION_BLOCK_RE, (_, inner) => {
    calls.push(...parseSectionCalls(inner));
    return '';
  });
  content = content.replace(WRAP_BLOCK_RE, (_, inner) => {
    calls.push(...parseInvokes(inner, tools));
    return '';
  });
  // 缺 calls 外壳的裸 invoke 块
  content = content.replace(BARE_INVOKE_BLOCK_RE, (block) => {
    calls.push(...parseInvokes(block, tools));
    return '';
  });
  // 无法归入调用的残留标记不再下发
  content = content.replace(ANY_TAG_RE, '').replace(SECTION_STRAY_GLOBAL_RE, '');
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
    this.block = null;   // { kind: 'dsml'|'qwen'|'dsml-bare'|'section', opener, buf }
    this.sawCalls = false;
  }

  push(text) {
    this.pending += text || '';
    return this._drain(false);
  }

  flush() {
    const r = this._drain(true);
    // 全部输出是工具调用时，把残余空白也吞掉，避免客户端渲染出空消息
    if (r.calls.length && !r.content.trim()) r.content = '';
    return r;
  }

  _parseBlock(kind, inner) {
    if (kind === 'qwen') return parseQwenInner(inner, this.tools);
    if (kind === 'section') return parseSectionCalls(inner);
    return parseInvokes(inner, this.tools);
  }

  _hadTags(kind, inner) {
    if (kind === 'qwen') return qwenBlockHadTags(inner);
    if (kind === 'section') return true;
    return blockHadTags(inner);
  }

  _closeRe(kind) {
    if (kind === 'qwen') return QWEN_CLOSE_RE;
    if (kind === 'section') return SECTION_END_RE;
    if (kind === 'dsml-bare') return BARE_CLOSE_RE;
    return CLOSE_RE;
  }

  _closePrefixes(kind) {
    if (kind === 'qwen') return ['</tool_call>'];
    if (kind === 'section') return [SECTION_END, SECTION_END.replace(/｜/g, '|')];
    if (kind === 'dsml-bare') return BARE_CLOSERS;
    return CLOSERS;
  }

  _drain(final) {
    let content = '';
    const calls = [];
    for (;;) {
      if (this.block) {
        if (this.pending) { this.block.buf += this.pending; this.pending = ''; }
        const kind = this.block.kind;
        const m = this._closeRe(kind).exec(this.block.buf);
        if (m) {
          const inner = this.block.buf.slice(0, m.index);
          const rest = this.block.buf.slice(m.index + m[0].length);
          const parsed = this._parseBlock(kind, inner);
          if (parsed.length) { calls.push(...parsed); this.sawCalls = true; }
          else if (this._hadTags(kind, inner)) { /* 退化块（无结构化调用可救）：整体剥掉，不放行标签汤 */ }
          else content += this.block.opener + inner + m[0]; // 块内没有任何工具标记：按原文放行
          this.block = null;
          this.pending = rest;
          continue;
        }
        if (final) {
          // 流结束时块未闭合（输出被截断）：能救几个 invoke 救几个，救不了且有标记就剥掉
          const parsed = this._parseBlock(kind, this.block.buf);
          if (parsed.length) { calls.push(...parsed); this.sawCalls = true; }
          else if (this._hadTags(kind, this.block.buf)) { /* 剥掉 */ }
          else content += this.block.opener + this.block.buf;
          this.block = null;
          this.pending = '';
          continue;
        }
        if (isPrefixOfAny(this._closePrefixes(kind), this.block.buf)) return { content, calls }; // 闭标记可能被切断，再等等
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

      // 块外的残留闭标记：剥掉，不放行成正文
      if (SECTION_STRAY_RE.test(this.pending)) {
        this.pending = this.pending.replace(SECTION_STRAY_RE, '');
        continue;
      }
      if (STRAY_DSML_CLOSE_RE.test(this.pending)) {
        this.pending = this.pending.replace(STRAY_DSML_CLOSE_RE, '');
        continue;
      }
      const qwenOpen = QWEN_OPENERS.find(o => this.pending.startsWith(o));
      if (qwenOpen) {
        this.block = { kind: 'qwen', opener: qwenOpen, buf: this.pending.slice(qwenOpen.length) };
        this.pending = '';
        continue;
      }
      const wrap = WRAP_OPEN_RE.exec(this.pending);
      if (wrap) {
        this.block = { kind: 'dsml', opener: wrap[0], buf: this.pending.slice(wrap[0].length) };
        this.pending = '';
        continue;
      }
      // 特殊 token 块 / 缺 calls 外壳的裸 invoke 块：从标记本身开始缓冲，交解析器处理
      if (SECTION_START_RE.test(this.pending)) {
        this.block = { kind: 'section', opener: '', buf: this.pending };
        this.pending = '';
        continue;
      }
      if (BARE_OPEN_TAG_RE.test(this.pending)) {
        this.block = { kind: 'dsml-bare', opener: '', buf: this.pending };
        this.pending = '';
        continue;
      }
      if (GENERIC_DSML_TAG_RE.test(this.pending)) {
        this.pending = this.pending.replace(GENERIC_DSML_TAG_RE, '');
        continue;
      }
      if (!final && (
        isPrefixOfAny(OPENERS, this.pending) ||
        isPrefixOfAny(QWEN_OPENERS, this.pending) ||
        isPrefixOfAny(BARE_OPENERS, this.pending) ||
        isPrefixOfAny(BARE_CLOSERS, this.pending) ||
        isPrefixOfAny(SECTION_TOKENS, this.pending) ||
        isDsmlTagPrefix(this.pending)
      )) {
        return { content, calls }; // 开/闭标记未收全
      }
      content += '<'; // 不是工具开标记：放行这个 '<' 继续扫
      this.pending = this.pending.slice(1);
    }
  }
}

/** 生成 OpenAI 风格的 tool_call id */
function newToolCallId() {
  return 'call_' + crypto.randomBytes(12).toString('hex');
}

module.exports = {
  parseDSMLCalls, renderDSMLCalls, mapToolMessage, dsmlToolDoc,
  parseQwenCalls, renderQwenCalls, mapQwenToolMessage, qwenToolDoc,
  DSMLStreamFilter, newToolCallId,
};
