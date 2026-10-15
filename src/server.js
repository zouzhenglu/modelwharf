'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');
const registry = require('./core/registry');
const openaiRoutes = require('./routes/openai');
const anthropicRoutes = require('./routes/anthropic');
const responsesRoutes = require('./routes/responses');
const mcp = require('./routes/mcp');
const adminRoutes = require('./routes/admin');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));

// request log
app.use((req, res, next) => {
  if (!req.path.startsWith('/admin') && req.path !== '/health') {
    logger.debug(`${req.method} ${req.path}`);
  }
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, version: config.version, providers: registry.list().map(p => p.id) }));

// AI-readable integration doc (no auth): ask any AI assistant to fetch this and wire the gateway in
app.get('/docs/api.md', (req, res) => {
  const { db } = require('./store');
  const modelsCore = require('./core/models');
  const base = `http://localhost:${config.port}`;
  const models = modelsCore.listPublicModels();
  const open = config.apiKeys.length === 0 && db.prepare('SELECT COUNT(*) c FROM apikeys').get().c === 0;
  const sample = models[0]?.public_name || 'glm-5.3';
  const md = `# modelwharf 接入说明（AI 可读）

一个把多个 AI 平台聚合成标准 API 的本地网关。本文档供 AI 助手阅读后直接完成接入。

## 端点
- OpenAI 协议: \`POST ${base}/v1/chat/completions\`（兼容 \`/v1/completions\`、\`/v1/responses\`、\`/v1/embeddings\`、\`GET /v1/models\`）
- Anthropic 协议: \`POST ${base}/v1/messages\`（含 \`/v1/messages/count_tokens\`；Claude Code: \`ANTHROPIC_BASE_URL=${base}\`）
- MCP: \`POST ${base}/mcp\`（JSON-RPC over HTTP，tools/resources/prompts 聚合）
- 健康检查: \`GET ${base}/health\`

## 认证
${open ? '当前网关为开放模式（未配置任何 API Key），可不带认证头。' : `请求头 \`Authorization: Bearer <key>\`。key 由网关主人提供（管理面板 ${base}/admin 生成），形如 \`wh-...\`。Anthropic 工具用 \`x-api-key\` 或 \`ANTHROPIC_AUTH_TOKEN\`。`}
当前生效 key 的名字（非完整值）: ${db.prepare('SELECT name FROM apikeys WHERE enabled=1').all().map(k => k.name || '(未命名)').join(', ') || '（无，开放模式）'}

## 模型
先 \`GET ${base}/v1/models\` 获取实时列表（当前 ${models.length} 个）。示例:

${models.slice(0, 40).map(m => `- \`${m.public_name}\`（${m.provider_id}${m.is_free ? ' · 免费' : ` · x${m.multiplier}`}）`).join('\n')}${models.length > 40 ? `\n- … 其余 ${models.length - 40} 个见 /v1/models` : ''}

模型名可加后缀控制思考: \`-think\`（开）/ \`-think-high\`（高）/ \`-xhigh\`（最高）/ \`-nothink\`（关）。

## 请求示例
\`\`\`bash
curl ${base}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  ${open ? '' : '-H "Authorization: Bearer wh-..." \\\n  '}-d '{"model": "${sample}", "messages": [{"role":"user","content":"你好"}], "stream": true}'
\`\`\`

流式响应为标准 SSE（\`data: {JSON}\\n\\n\`，以 \`data: [DONE]\` 结束）；非流式返回标准 OpenAI chat.completion JSON。

## 接入要求
1. base_url 配到 \`${base}/v1\`（OpenAI 协议）或 \`ANTHROPIC_BASE_URL=${base}\`（Anthropic 协议）
2. 密钥从环境变量读取，不要硬编码进代码仓库
3. 接完发一条最小请求验证能返回内容；失败时把响应里的 error 原样报告给用户
4. 管理面板（配额/账号/模型/日志）在 ${base}/admin
`;
  res.type('text/markdown; charset=utf-8').send(md);
});

// API gateways
app.use('/v1', openaiRoutes);
app.use('/v1', responsesRoutes);        // /v1/responses (Codex / Responses API clients)
app.use('/v1', anthropicRoutes);        // /v1/messages, /v1/models handled after openai (no conflicts)
app.use('/mcp', mcp.router);            // MCP gateway (JSON-RPC over HTTP)
app.use('/admin/api', adminRoutes);     // admin REST

// admin UI static
app.use('/admin', express.static(path.join(__dirname, 'admin-ui'), { index: 'index.html' }));
app.get('/', (req, res) => res.redirect('/admin'));

// error handler
app.use((err, req, res, next) => {
  logger.error(`unhandled: ${err.message}`);
  if (res.headersSent) return;
  res.status(500).json({ error: { message: err.message } });
});

function start() {
  registry.loadAll();
  adminRoutes.setupAutoRefresh?.();
  adminRoutes.setupCheckin?.();   // 自动签到调度（默认每日 09:00，启动补签）
  const server = app.listen(config.port, config.host, () => {
    // PID file for stop.bat
    try { fs.writeFileSync(path.join(config.dataDir, 'wharf.pid'), String(process.pid)); } catch {}
    const cleanup = () => { try { fs.unlinkSync(path.join(config.dataDir, 'wharf.pid')); } catch {} };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    logger.info(`modelwharf v${config.version} listening on http://${config.host}:${config.port}`);
    logger.info(`admin panel: http://localhost:${config.port}/admin  (password: ${config.adminPassword === 'admin' ? 'admin (default, change it!)' : '(from env/settings)'})`);
  });
  server.on('error', (e) => { logger.error(`listen failed: ${e.message}`); process.exit(1); });
  return server;
}

if (require.main === module) start();
module.exports = { app, start };
