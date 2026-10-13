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

module.exports = { normalizeMessages, parseModelSuffix, reasoningParamsFor };
