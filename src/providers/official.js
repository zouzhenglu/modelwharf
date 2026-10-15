'use strict';
/**
 * Official LLM API providers (OpenAI-compatible protocol).
 * Every major vendor speaks OpenAI-compatible chat completions, so each one is a
 * preset of the generic client: fixed baseUrl + model catalog + default model ids.
 * Adding a vendor = adding an entry here (no code duplication).
 */
const makeGeneric = require('./_generic');

// [providerId, label, baseUrl, homepage, models, docs]
const VENDORS = [
  // ---- 国际 ----
  ['openai', 'OpenAI 官方', 'https://api.openai.com/v1', 'https://platform.openai.com',
    ['gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'o4-mini', 'text-embedding-3-large'],
    'platform.openai.com 创建 API key。'],
  ['anthropic', 'Anthropic (Claude 官方)', 'https://api.anthropic.com/v1', 'https://console.anthropic.com',
    ['claude-opus-4.6', 'claude-sonnet-4.6', 'claude-haiku-4.5', 'claude-opus-4.5', 'claude-sonnet-4.5'],
    'console.anthropic.com 创建 key。注意：Anthropic 官方协议非 OpenAI 格式，本插件走其兼容层 /v1/chat/completions（已支持）。'],
  ['gemini', 'Google Gemini 官方', 'https://generativelanguage.googleapis.com/v1beta/openai', 'https://aistudio.google.com',
    ['gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    'aistudio.google.com 获取 API key（Gemini 提供官方 OpenAI 兼容端点）。'],
  ['xai', 'xAI (Grok 官方)', 'https://api.x.ai/v1', 'https://console.x.ai',
    ['grok-4.1', 'grok-4', 'grok-4-fast', 'grok-3', 'grok-3-mini'],
    'console.x.ai 创建 key。'],
  ['openrouter', 'OpenRouter (聚合)', 'https://openrouter.ai/api/v1', 'https://openrouter.ai',
    ['openrouter/auto', 'anthropic/claude-opus-4.6', 'openai/gpt-5.2', 'google/gemini-3-pro', 'meta-llama/llama-4-maverick', 'deepseek/deepseek-v4'],
    'openrouter.ai/keys 创建 key，一个 key 调所有主流模型。'],
  ['mistral', 'Mistral AI', 'https://api.mistral.ai/v1', 'https://console.mistral.ai',
    ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest'],
    'console.mistral.ai 创建 key。'],
  ['deepseek', 'DeepSeek 官方', 'https://api.deepseek.com/v1', 'https://platform.deepseek.com',
    ['deepseek-chat', 'deepseek-reasoner'],
    'platform.deepseek.com 创建 key（价格极低）。'],
  ['groq', 'Groq (高速推理)', 'https://api.groq.com/openai/v1', 'https://console.groq.com',
    ['llama-4-maverick', 'llama-3.3-70b-versatile', 'qwen3-32b', 'deepseek-r1-distill-llama-70b', 'gemma2-9b-it'],
    'console.groq.com 创建 key（有免费额度，速度极快）。'],
  ['together', 'Together AI', 'https://api.together.xyz/v1', 'https://api.together.ai',
    ['meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', 'deepseek-ai/DeepSeek-V4', 'Qwen/Qwen3-235B-A22B'],
    'api.together.ai 创建 key。'],
  ['perplexity', 'Perplexity (Sonar)', 'https://api.perplexity.ai', 'https://www.perplexity.ai/settings/api',
    ['sonar', 'sonar-pro', 'sonar-reasoning-pro', 'sonar-deep-research'],
    'perplexity.ai/settings/api 创建 key（联网搜索模型）。'],
  ['cerebras', 'Cerebras', 'https://api.cerebras.ai/v1', 'https://cloud.cerebras.ai',
    ['llama-4-maverick', 'llama-3.3-70b', 'qwen-3-235b', 'gpt-oss-120b'],
    'cloud.cerebras.ai 创建 key（有免费额度）。'],
  ['github-copilot', 'GitHub Models', 'https://models.github.ai/inference', 'https://github.com/marketplace/models',
    ['openai/gpt-5.1', 'anthropic/claude-sonnet-4.5', 'meta/Llama-4-Maverick-17B-128E-Instruct', 'mistral-ai/mistral-large-2411'],
    'github.com/settings/personal-access-tokens 创建 PAT（GitHub Models 免费额度）。'],

  // ---- 国内 ----
  ['dashscope', '阿里云百炼 (Qwen 官方)', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://bailian.console.aliyun.com',
    ['qwen3.8-max', 'qwen3-max', 'qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3-coder-plus', 'qwen-vl-max', 'qwen3-omni-flash'],
    'bailian.console.aliyun.com 创建 API-KEY（新用户有免费额度）。'],
  ['zhipu', '智谱 AI (GLM 官方)', 'https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn',
    ['glm-5.3', 'glm-5.2', 'glm-5-air', 'glm-5-flash', 'glm-4.7', 'glm-4.7-flash', 'glm-4v-plus'],
    'open.bigmodel.cn 创建 key（glm-5-flash 免费）。'],
  ['moonshot', '月之暗面 (Kimi 官方)', 'https://api.moonshot.cn/v1', 'https://platform.moonshot.cn',
    ['kimi-k3', 'kimi-k2.5', 'moonshot-v1-128k', 'kimi-latest', 'moonshot-v1-8k-vision-preview'],
    'platform.moonshot.cn 创建 key。'],
  ['minimax', 'MiniMax 官方', 'https://api.minimax.chat/v1', 'https://platform.minimaxi.com',
    ['MiniMax-M3', 'MiniMax-M2.7', 'abab6.5s-chat'],
    'platform.minimaxi.com 创建 key。'],
  ['doubao', '火山方舟 (豆包官方)', 'https://ark.cn-beijing.volces.com/api/v3', 'https://console.volcengine.com/ark',
    ['doubao-seed-2.1-pro', 'doubao-seed-2.1-flash', 'doubao-1.5-thinking-pro', 'deepseek-v4-pro'],
    'console.volcengine.com/ark 开通方舟、创建推理接入点；模型名也可填接入点 ID（ep-xxx）。'],
  ['hunyuan', '腾讯混元官方', 'https://api.hunyuan.cloud.tencent.com/v1', 'https://console.cloud.tencent.com/hunyuan',
    ['hunyuan-turbos', 'hunyuan-2.0-thinking', 'hunyuan-large', 'hunyuan-t1-latest'],
    'console.cloud.tencent.com/hunyuan 创建 key（部分模型免费）。'],
  ['baichuan', '百川智能', 'https://api.baichuan-ai.com/v1', 'https://platform.baichuan-ai.com',
    ['Baichuan-M2-32B', 'Baichuan4-Air', 'Baichuan4-Turbo'],
    'platform.baichuan-ai.com 创建 key。'],
  ['stepfun', '阶跃星辰', 'https://api.stepfun.com/v1', 'https://platform.stepfun.com',
    ['step-3', 'step-2-16k', 'step-1v-8k-vision'],
    'platform.stepfun.com 创建 key。'],
  ['siliconflow', '硅基流动 (SiliconFlow)', 'https://api.siliconflow.cn/v1', 'https://cloud.siliconflow.cn',
    ['deepseek-ai/DeepSeek-V4', 'Qwen/Qwen3.8-Max', 'Qwen/Qwen3-235B-A22B', 'THUDM/GLM-5.3', 'moonshotai/Kimi-K3'],
    'cloud.siliconflow.cn 创建 key（多个开源模型有免费额度）。'],
  ['minimaxcn', 'MiniMax 开放平台(备用)', 'https://api.minimaxi.com/v1', 'https://platform.minimaxi.com',
    ['MiniMax-M3', 'MiniMax-M2.7'],
    'platform.minimaxi.com（国际站用 minimax 插件）。'],
  ['internvl', '上海AI实验室 (书生)', 'https://chat.intern-ai.org.cn/api/v1', 'https://intern-ai.org.cn',
    ['internlm3-latest', 'internvl3-latest'],
    'intern-ai.org.cn 申请免费 API。'],
  ['modelscope', '魔搭 ModelScope', 'https://api-inference.modelscope.cn/v1', 'https://modelscope.cn',
    ['ZhipuAI/GLM-5.3', 'deepseek-ai/DeepSeek-V4', 'Qwen/Qwen3.8-Max', 'moonshotai/Kimi-K3'],
    'modelscope.cn 申请免费 API-KEY（每日免费额度）。'],
];

const registry = [];
for (const [id, label, baseUrl, homepage, models, docs] of VENDORS) {
  const extraHeaders = {};
  if (id === 'anthropic') extraHeaders['anthropic-version'] = '2023-06-01';
  const plugin = {
    ...makeGeneric(id, label, docs, { baseUrlPlaceholder: baseUrl, homepage, models }),
    // fixed baseUrl per vendor — account only needs apiKey
    credFields: [
      { name: 'apiKey', label: 'API Key', required: true, secret: true, placeholder: docs.slice(0, 60) },
      { name: 'baseUrl', label: `Base URL（默认 ${baseUrl}，可改代理）`, placeholder: baseUrl },
    ],
    _defaultBaseUrl: baseUrl,
    _extraHeaders: extraHeaders,
    _authHeaders(account) {
      const base = (account.credentials.baseUrl || this._defaultBaseUrl).replace(/\/+$/, '');
      const h = { Authorization: `Bearer ${account.credentials.apiKey}`, ...this._extraHeaders };
      // Anthropic officially accepts x-api-key; Bearer works on the compat layer but
      // /v1/models on the native API wants x-api-key — send both.
      if (this.id === 'anthropic') h['x-api-key'] = account.credentials.apiKey;
      return { base, h };
    },
    async listModels(account) {
      // try live /models, fall back to the curated catalog
      const { base, h } = this._authHeaders(account);
      try {
        const r = await require('../utils/http').httpJson(`${base}/models`, { headers: h, timeoutMs: 15000 });
        if (r.status === 200 && Array.isArray(r.json?.data) && r.json.data.length) {
          return r.json.data.map(m => ({ upstream: m.id }));
        }
      } catch { /* offline or incompatible */ }
      return models.map(m => ({ upstream: m }));
    },
    async checkAccount(account) {
      const { base, h } = this._authHeaders(account);
      try {
        const r = await require('../utils/http').httpJson(`${base}/models`, { headers: h, timeoutMs: 15000 });
        if (r.status === 200) return { ok: true, message: `连通，${r.json?.data?.length ?? '?'} 个模型` };
        if (r.status === 401 || r.status === 403) return { ok: false, status: 'invalid', message: `key 无效 (${r.status})` };
        return { ok: false, status: 'cooling', message: `upstream ${r.status}` };
      } catch (e) { return { ok: false, status: 'cooling', message: e.message }; }
    },
    async *chat(opts) {
      const { base, h } = this._authHeaders(opts.account);
      const { httpRequest, config, logger } = require('../utils/http');
      const { sseParse } = require('../utils/sse');
      const body = {
        model: opts.upstreamModel,
        messages: opts.messages.map(m => {
          const out = { role: m.role };
          if (m.parts?.some(p => p.type === 'image_url')) {
            out.content = m.parts.map(p => p.type === 'text'
              ? { type: 'text', text: p.text }
              : { type: 'image_url', image_url: { url: p.url } });
          } else {
            out.content = m.text ?? '';
          }
          if (m.tool_calls) out.tool_calls = m.tool_calls;
          if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
          return out;
        }),
        stream: true,
        ...(opts.params.max_tokens ? { max_tokens: opts.params.max_tokens } : {}),
        ...(opts.params.temperature != null ? { temperature: opts.params.temperature } : {}),
        ...(opts.params.top_p != null ? { top_p: opts.params.top_p } : {}),
        ...(opts.params.stop !== undefined ? { stop: opts.params.stop } : {}),
        ...(opts.params.seed !== undefined ? { seed: opts.params.seed } : {}),
        ...(opts.params.presence_penalty !== undefined ? { presence_penalty: opts.params.presence_penalty } : {}),
        ...(opts.params.frequency_penalty !== undefined ? { frequency_penalty: opts.params.frequency_penalty } : {}),
        ...(opts.params.logprobs !== undefined ? { logprobs: opts.params.logprobs } : {}),
        ...(opts.params.top_logprobs !== undefined ? { top_logprobs: opts.params.top_logprobs } : {}),
        ...(opts.params.n !== undefined ? { n: opts.params.n } : {}),
        ...(opts.params.reasoning_effort ? { reasoning_effort: opts.params.reasoning_effort } : {}),
        ...(opts.params.enable_thinking !== undefined ? { enable_thinking: opts.params.enable_thinking } : {}),
        ...(opts.params.thinking_budget ? { thinking_budget: opts.params.thinking_budget } : {}),
        ...(opts.params.thinking ? { thinking: opts.params.thinking } : {}),
        ...(opts.tools?.length ? { tools: opts.tools, tool_choice: opts.params.tool_choice || 'auto' } : {}),
      };
      const resp = await httpRequest(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...h },
        body, signal: opts.signal, timeoutMs: config.requestTimeoutMs,
      });
      if (resp.statusCode >= 400) {
        const text = await resp.body.text().catch(() => '');
        throw Object.assign(new Error(`${this.id} ${resp.statusCode}: ${text.slice(0, 300)}`), { status: resp.statusCode });
      }
      for await (const { data } of sseParse(resp.body)) {
        if (data === '[DONE]') break;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.usage) opts.onUsage?.({ input_tokens: j.usage.prompt_tokens, output_tokens: j.usage.completion_tokens });
        yield JSON.stringify(j);
      }
    },
    /** /v1/embeddings 透传（官方 OpenAI 兼容端点大多原生支持 embeddings） */
    async embeddings(opts) {
      const { base, h } = this._authHeaders(opts.account);
      const { httpJson, config } = require('../utils/http');
      const body = { model: opts.upstreamModel, input: opts.input };
      if (opts.params?.dimensions) body.dimensions = opts.params.dimensions;
      if (opts.params?.encoding_format) body.encoding_format = opts.params.encoding_format;
      if (opts.params?.user) body.user = opts.params.user;
      const r = await httpJson(`${base}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...h },
        body, timeoutMs: config.requestTimeoutMs,
      });
      if (r.status >= 400) throw Object.assign(new Error(`${this.id} ${r.status}: ${String(r.text || '').slice(0, 300)}`), { status: r.status });
      const j = r.json || {};
      return { data: j.data || [], model: j.model || opts.upstreamModel, usage: j.usage || {} };
    },
  };
  registry.push(plugin);
}

module.exports = registry;
