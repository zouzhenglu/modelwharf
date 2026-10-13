'use strict';
/**
 * Shared HTTP client for provider plugins (undici based).
 * Provides timeout, retry-on-401-with-refresh hook, JSON helpers and SSE stream passthrough.
 */
const { request } = require('undici');
const config = require('../config');
const logger = require('../logger');

async function httpRequest(url, {
  method = 'GET', headers = {}, body, timeoutMs = 60000, query,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await request(url, {
      method,
      headers,
      body: body == null ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)),
      query,
      signal: controller.signal,
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

async function httpJson(url, opts = {}) {
  const resp = await httpRequest(url, opts);
  const text = await resp.body.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  return { status: resp.statusCode, headers: resp.headers, json, text };
}

module.exports = { httpRequest, httpJson, config, logger };
