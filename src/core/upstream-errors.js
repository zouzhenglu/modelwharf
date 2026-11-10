'use strict';
/**
 * 上游错误分类：区分「账号/链路故障」与「这次请求本身不合法」。
 *
 * Codex / Claude Code 会把超长上下文、并行工具历史原样转发给上游：
 *  - workbuddy 返回 HTTP 400 + code 11115/11148（prompt too long / tool calls mismatch）
 *  - qoder 在 SSE 里返回 code 1261 "Prompt exceeds max length"（旧代码映射成 502）
 * 这些都和账号健康无关。若按普通失败冷却账号，一次坏请求会让整个平台的账号池
 * 冷却 30s，随后所有平台依次被熔断，客户端只看到
 * "no healthy account available for provider ..."。
 */
const REQUEST_ERROR_RE = /prompt is too long|prompt exceeds max length|maximum context length|context length|max(?:imum)? (?:prompt )?length|too many (?:input )?tokens|tool calls and tool results do not match|please clear context|session blocked/i;

/** 确定性请求错误：重试同一账号也不会成功，不应冷却账号。
 *  4xx 里 401/403/402/429 仍按账号错误处理（鉴权/额度/限流）。 */
function isRequestError(err) {
  if (!err) return false;
  const status = Number(err.status) || 0;
  if (status === 401 || status === 403 || status === 402 || status === 429) return false;
  // 上游有时把上下文超限/工具历史不匹配包成 5xx（qoder 的 502 即如此）
  if (isContextOrToolRequestError(err)) return true;
  if (status >= 500) return false;
  if (status === 400 || status === 404 || status === 405 || status === 409 || status === 413 || status === 415 || status === 422) return true;
  return false;
}

/** 上游把「上下文超限 / 工具历史不匹配」包在 5xx 里时，用于映射回 400 */
function isContextOrToolRequestError(err) {
  return REQUEST_ERROR_RE.test(String(err?.message || ''));
}

module.exports = { isRequestError, isContextOrToolRequestError };
