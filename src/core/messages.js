'use strict';
/**
 * Message normalization: convert OpenAI-style messages to a canonical form
 * that provider plugins consume. Plugins may further transform per platform.
 *
 * Canonical message: { role, text, parts?: [{type:'text'|'image_url',...}],
 *                      tool_calls?: [{id,type,function}], tool_call_id?, name? }
 * - parts carries images through to plugins that support vision.
 * - tool_calls / tool_call_id support function-calling round trips.
 */
function normalizeMessages(openaiMessages = []) {
  return openaiMessages.map(m => {
    const out = { role: m.role };
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (typeof m.content === 'string') { out.text = m.content; return out; }
    if (Array.isArray(m.content)) {
      const parts = m.content.map(p => {
        if (p.type === 'text') return { type: 'text', text: p.text };
        if (p.type === 'image_url') return { type: 'image_url', url: p.image_url?.url };
        return { type: p.type, ...p };
      });
      out.text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
      if (parts.some(p => p.type === 'image_url')) out.parts = parts;
      return out;
    }
    // tool messages etc: keep raw
    out.text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return out;
  });
}

/**
 * Model-name suffix conventions (思考深度控制):
 *   <model>-think        -> reasoning enabled, medium effort
 *   <model>-think-high   -> reasoning enabled, high effort
 *   <model>-xhigh        -> reasoning effort xhigh (qoder tier)
 *   <model>-nothink      -> reasoning disabled
 * Returns { baseModel, reasoning: {effort} | false | undefined }.
 */
function parseModelSuffix(model) {
  if (!model) return { baseModel: model };
  if (model.endsWith('-nothink')) return { baseModel: model.slice(0, -8), reasoning: false };
  if (model.endsWith('-think-high') || model.endsWith('-xhigh')) {
    const cut = model.endsWith('-think-high') ? 11 : 6;
    return { baseModel: model.slice(0, -cut), reasoning: { effort: model.endsWith('-think-high') ? 'high' : 'xhigh' } };
  }
  if (model.endsWith('-think')) return { baseModel: model.slice(0, -6), reasoning: { effort: 'medium' } };
  return { baseModel: model };
}

/** per-provider reasoning parameter mapping */
function reasoningParamsFor(providerId, reasoning) {
  if (reasoning === undefined) return {};
  if (reasoning === false) {
    // explicit off
    if (providerId === 'dashscope' || providerId === 'qwen') return { enable_thinking: false };
    return { reasoning_effort: 'none' };
  }
  const effort = reasoning.effort || 'medium';
  switch (providerId) {
    case 'openai': case 'openai-compat': case 'groq': case 'together': case 'xai':
    case 'github-copilot': case 'cerebras': case 'perplexity': case 'mistral':
      return { reasoning_effort: effort === 'xhigh' ? 'high' : effort };
    case 'dashscope': case 'qwen':
      return { enable_thinking: true, thinking_budget: effort === 'high' || effort === 'xhigh' ? 24576 : 8192 };
    case 'zhipu': return { thinking: { type: 'enabled' } };
    case 'doubao': return { thinking: { type: effort === 'low' ? 'disabled' : 'enabled' } };
    case 'moonshot': return { reasoning_effort: effort };
    case 'minimax': case 'minimaxcn': return { reasoning_enabled: true };
    case 'hunyuan': return { enable_enhancement: true };
    case 'gemini': return { reasoning_effort: effort === 'xhigh' ? 'high' : effort };
    case 'deepseek': return {}; // deepseek-reasoner always thinks; chat never does
    default: return {};
  }
}

/**
 * Anthropic 请求体 `thinking` 字段 -> 规范 reasoning 描述（与模型名后缀同构）:
 *   {type:'disabled'} -> false（关思考）
 *   {type:'enabled', budget_tokens:N} -> {effort}，按预算分档：>=16384 high，>=4096 medium，其余 low
 * 返回 undefined 表示未指定（模型名后缀优先于本字段）。
 */
function reasoningFromThinking(thinking) {
  if (!thinking || typeof thinking !== 'object') return undefined;
  if (thinking.type === 'disabled') return false;
  const budget = Number(thinking.budget_tokens) || 0;
  if (thinking.type === 'enabled' || budget > 0) {
    return { effort: budget >= 16384 ? 'high' : budget >= 4096 ? 'medium' : 'low' };
  }
  return undefined;
}

/**
 * 粗略 token 估算（无本地 tokenizer 时的近似值，误差 ±20% 左右）:
 * CJK 字符 ≈ 1 token/字，拉丁字符 ≈ 0.25 token/字符。
 */
function estimateTokens(text) {
  if (!text) return 0;
  let n = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x2e80) n += 1;              // CJK 及全角符号
    else if (ch === '\n') n += 0.5;
    else if (ch === ' ' || ch === '\t') n += 0.15;
    else n += 0.27;
  }
  return Math.max(1, Math.ceil(n));
}

/** Anthropic 请求体（system/messages/tools）的输入 token 估算，供 count_tokens 用 */
function estimateAnthropicInputTokens(body = {}) {
  let total = 3; // reply priming
  if (typeof body.system === 'string') total += estimateTokens(body.system);
  else if (Array.isArray(body.system)) for (const b of body.system) total += estimateTokens(b.text || '');
  for (const m of body.messages || []) {
    total += 4; // 每条消息固定开销
    if (typeof m.content === 'string') { total += estimateTokens(m.content); continue; }
    for (const b of m.content || []) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') total += estimateTokens(b.text || '');
      else if (b.type === 'thinking') total += estimateTokens(b.thinking || '');
      else if (b.type === 'tool_use') total += estimateTokens(b.name || '') + estimateTokens(JSON.stringify(b.input || {}));
      else if (b.type === 'tool_result') {
        const inner = typeof b.content === 'string' ? b.content : (b.content || []).map(c => c?.text || '').join('\n');
        total += estimateTokens(inner);
      } else if (b.type === 'image') total += 1600; // 图片粗估
    }
  }
  if (Array.isArray(body.tools)) total += estimateTokens(JSON.stringify(body.tools));
  return total;
}

module.exports = { normalizeMessages, parseModelSuffix, reasoningParamsFor, reasoningFromThinking, estimateTokens, estimateAnthropicInputTokens };
