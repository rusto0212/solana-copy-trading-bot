// src/logger.js
const fs   = require('fs');
const path = require('path');

const RESET  = '\x1b[0m';
const CYAN   = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const GRAY   = '\x1b[90m';
const BOLD   = '\x1b[1m';

const LOG_DIR = path.join(__dirname, '../logs');

/** Serialize a mix of strings, objects, and Error instances for log output. */
function serialize(...args) {
  return args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object' && a !== null) return JSON.stringify(a);
    return String(a);
  }).join(' ');
}

/** Strip ANSI colour codes so log files stay plain text. */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Append a line to today's dated log file (e.g. logs/2026-06-24.log). */
function writeToFile(level, line) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const date    = new Date().toISOString().slice(0, 10);
    const logPath = path.join(LOG_DIR, `${date}.log`);
    fs.appendFileSync(logPath, stripAnsi(line) + '\n', 'utf-8');
  } catch {
    // never crash the bot over a logging failure
  }
}

function timestamp() {
  return new Date().toISOString();
}

function log(colour, label, ...args) {
  const line = `${colour}[${timestamp()}] [${label}]${RESET} ${serialize(...args)}`;
  console.log(line);
  writeToFile(label, line);
}

function info(...args)    { log(CYAN,         'INFO ', ...args); }
function warn(...args)    { log(YELLOW,        'WARN ', ...args); }
function error(...args)   { log(`${BOLD}${RED}`,'ERROR', ...args); }
function success(...args) { log(GREEN,         'OK   ', ...args); }
function debug(...args)   {
  if (process.env.DEBUG === 'true') log(GRAY, 'DEBUG', ...args);
}

module.exports = { info, warn, error, success, debug };
