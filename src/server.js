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
  const server = app.listen(config.port, config.host, () => {
    // PID file for stop.bat
    try { fs.writeFileSync(path.join(config.dataDir, 'dsh.pid'), String(process.pid)); } catch {}
    const cleanup = () => { try { fs.unlinkSync(path.join(config.dataDir, 'dsh.pid')); } catch {} };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    logger.info(`dsh-free-api v${config.version} listening on http://${config.host}:${config.port}`);
    logger.info(`admin panel: http://localhost:${config.port}/admin  (password: ${config.adminPassword === 'admin' ? 'admin (default, change it!)' : '(from env/settings)'})`);
  });
  server.on('error', (e) => { logger.error(`listen failed: ${e.message}`); process.exit(1); });
  return server;
}

if (require.main === module) start();
module.exports = { app, start };
