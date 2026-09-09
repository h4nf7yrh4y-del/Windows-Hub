'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * File logging.
 *
 * A packaged Electron app has nowhere for console output to go, so when
 * something fails on a user's machine there is nothing to look at and every
 * bug report becomes guesswork. Everything worth knowing lands in a rotating
 * file instead, and the diagnostics export bundles it with the environment
 * that produced it.
 *
 * Writes are synchronous and appended. A log that loses its last lines to a
 * crash is a log that misses exactly the part that mattered.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_FILES = 3;

let logDir = null;
let logPath = null;
let minLevel = LEVELS.info;
let ready = false;
let writeFailed = false;
let mirrorToConsole = true;

// Kept in memory as well, so the diagnostics report can include the tail
// without re-reading a file that may be mid-rotation.
const recent = [];
const RECENT_MAX = 400;

function init({ dir, level = 'info', console: mirror = true } = {}) {
  logDir = dir;
  logPath = path.join(dir, 'hub.log');
  minLevel = LEVELS[level] || LEVELS.info;
  mirrorToConsole = mirror !== false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    ready = true;
  } catch (err) {
    ready = false;
    writeFailed = true;
    console.error('[logger] cannot create log directory:', err.message);
  }
  return logPath;
}

function rotate() {
  try {
    const stats = fs.statSync(logPath);
    if (stats.size < MAX_BYTES) return;
  } catch (_) {
    return; // no file yet
  }

  try {
    // hub.log -> hub.1.log -> hub.2.log, oldest dropped.
    const oldest = path.join(logDir, `hub.${KEEP_FILES}.log`);
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let i = KEEP_FILES - 1; i >= 1; i -= 1) {
      const from = path.join(logDir, `hub.${i}.log`);
      const to = path.join(logDir, `hub.${i + 1}.log`);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(logPath, path.join(logDir, 'hub.1.log'));
  } catch (err) {
    console.error('[logger] rotation failed:', err.message);
  }
}

function formatValue(value) {
  if (value instanceof Error) return `${value.message}\n${value.stack || ''}`.trim();
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function write(level, scope, ...parts) {
  const rank = LEVELS[level] || LEVELS.info;
  const message = parts.map(formatValue).join(' ');
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;

  recent.push(line);
  if (recent.length > RECENT_MAX) recent.shift();

  // Still useful during development, where a console exists. Tests turn it
  // off so a rotation check does not bury the results in megabytes of output.
  if (mirrorToConsole) {
    const consoleFn = level === 'error' ? console.error : (level === 'warn' ? console.warn : console.log);
    consoleFn(line);
  }

  if (!ready || rank < minLevel || writeFailed) return;
  try {
    rotate();
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  } catch (err) {
    // Never let logging take the app down; report once and go quiet.
    writeFailed = true;
    console.error('[logger] write failed, file logging disabled:', err.message);
  }
}

function scoped(scope) {
  return {
    debug: (...args) => write('debug', scope, ...args),
    info: (...args) => write('info', scope, ...args),
    warn: (...args) => write('warn', scope, ...args),
    error: (...args) => write('error', scope, ...args)
  };
}

function tail(lines = 200) {
  return recent.slice(-lines);
}

function paths() {
  if (!logDir) return { dir: null, files: [] };
  let files = [];
  try {
    files = fs.readdirSync(logDir)
      .filter((f) => /^hub(\.\d+)?\.log$/.test(f))
      .map((f) => {
        const full = path.join(logDir, f);
        const stats = fs.statSync(full);
        return { name: f, path: full, size: stats.size, modified: stats.mtimeMs };
      })
      .sort((a, b) => b.modified - a.modified);
  } catch (_) { /* directory unreadable */ }
  return { dir: logDir, file: logPath, files, disabled: writeFailed };
}

function setLevel(level) {
  if (LEVELS[level]) minLevel = LEVELS[level];
  return Object.keys(LEVELS).find((k) => LEVELS[k] === minLevel);
}

/** Records the environment once at startup so every log has context. */
function logStartup(extra = {}) {
  write('info', 'boot', '--------------------------------------------------');
  write('info', 'boot', `Windows Hub gestartet · ${new Date().toLocaleString('de-DE')}`);
  write('info', 'boot', `Plattform ${process.platform} ${os.release()} ${process.arch}`);
  write('info', 'boot', `Electron ${process.versions.electron} · Node ${process.versions.node} · Chromium ${process.versions.chrome}`);
  write('info', 'boot', `CPU ${(os.cpus()[0] || {}).model || 'unbekannt'} · ${os.cpus().length} Kerne · ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB RAM`);
  for (const [key, value] of Object.entries(extra)) write('info', 'boot', `${key}: ${formatValue(value)}`);
}

module.exports = { init, scoped, write, tail, paths, setLevel, logStartup, LEVELS };
