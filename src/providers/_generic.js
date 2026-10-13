'use strict';
/**
 * Generic OpenAI-compatible provider — the extension point for:
 *  - official APIs (DeepSeek, Moonshot, OpenRouter, SiliconFlow...)
 *  - local models (Ollama http://localhost:11434/v1, LM Studio, vLLM...)
 *  - future platforms that speak OpenAI protocol
 * Account credentials: { baseUrl, apiKey, models? } — models may be fetched from /v1/models.
 */
const { httpRequest, httpJson, config, logger } = require('../utils/http');
const { sseParse } = require('../utils/sse');

function makeGeneric(id, label, docs, defaults = {}) {
  return {
    id, label, homepage: defaults.homepage, importLocal: false,
    credFields: [
      { name: 'baseUrl', label: 'Base URL', required: true, placeholder: defaults.baseUrlPlaceholder || 'https://api.example.com/v1' },
      { name: 'apiKey', label: 'API Key', required: true, secret: true },
      ...(defaults.extraCredFields || []),
    ],
    docs,
    async listModels(account) {
      try {
        const base = account.credentials.baseUrl.replace(/\/+$/, '');
        const r = await httpJson(`${base}/models`, {
          headers: { Authorization: `Bearer ${account.credentials.apiKey}` }, timeoutMs: 15000,
        });
        if (r.status === 200 && Array.isArray(r.json?.data)) {
          return r.json.data.map(m => ({ upstream: m.id }));
        }
      } catch (e) { logger.warn(`${id} listModels: ${e.message}`); }
      return defaults.models?.map(m => ({ upstream: m })) || [];
    },
    async checkAccount(account) {
      try {
        const base = account.credentials.baseUrl.replace(/\/+$/, '');
        const r = await httpJson(`${base}/models`, { headers: { Authorization: `Bearer ${account.credentials.apiKey}` }, timeoutMs: 15000 });
        if (r.status === 200) return { ok: true, message: `连通，${r.json?.data?.length ?? '?'} 个模型` };
        if (r.status === 401 || r.status === 403) return { ok: false, status: 'invalid', message: `key 无效 (${r.status})` };
        return { ok: false, status: 'cooling', message: `upstream ${r.status}` };
      } catch (e) { return { ok: false, status: 'cooling', message: e.message }; }
    },
    async *chat({ account, upstreamModel, messages, tools, params, signal, onUsage }) {
      const base = account.credentials.baseUrl.replace(/\/+$/, '');
      const body = {
        model: upstreamModel,
        messages: messages.map(m => ({ role: m.role, content: m.text ?? '' })),
        stream: true,
        ...(params.max_tokens ? { max_tokens: params.max_tokens } : {}),
        ...(params.temperature != null ? { temperature: params.temperature } : {}),
        ...(params.top_p != null ? { top_p: params.top_p } : {}),
        ...(tools?.length ? { tools, tool_choice: params.tool_choice || 'auto' } : {}),
      };
      const resp = await httpRequest(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${account.credentials.apiKey}` },
        body, signal, timeoutMs: config.requestTimeoutMs,
      });
      if (resp.statusCode >= 400) {
        const text = await resp.body.text().catch(() => '');
        throw Object.assign(new Error(`${id} ${resp.statusCode}: ${text.slice(0, 300)}`), { status: resp.statusCode });
      }
      for await (const { data } of sseParse(resp.body)) {
        if (data === '[DONE]') break;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.usage) onUsage?.({ input_tokens: j.usage.prompt_tokens, output_tokens: j.usage.completion_tokens });
        yield JSON.stringify(j);
      }
    },
  };
}

module.exports = makeGeneric;

// register instances for common local/official endpoints (they only activate once an account is added)
module.exports.ollama = makeGeneric('ollama', 'Ollama (本地)', '本地 Ollama：baseUrl 填 http://localhost:11434/v1，key 随便填如 ollama。', { baseUrlPlaceholder: 'http://localhost:11434/v1' });
module.exports.openaiCompat = makeGeneric('openai-compat', 'OpenAI 兼容 API', '任意 OpenAI 协议服务（DeepSeek/Moonshot/OpenRouter/官方 OpenAI…）：baseUrl 填到 /v1。', { baseUrlPlaceholder: 'https://api.deepseek.com/v1' });
