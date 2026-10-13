'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

function ts() { return new Date().toISOString(); }
function line(level, msg, extra) {
  const s = `[${ts()}] [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`;
  try { fs.appendFileSync(path.join(config.logDir, 'dsh.log'), s); } catch {}
  return s;
}
const logger = {
  info: (msg, extra) => console.log(line('INFO', msg, extra).trim()),
  warn: (msg, extra) => console.warn(line('WARN', msg, extra).trim()),
  error: (msg, extra) => console.error(line('ERROR', msg, extra).trim()),
  debug: (msg, extra) => { if (process.env.DSH_DEBUG) console.log(line('DEBUG', msg, extra).trim()); },
};
module.exports = logger;
