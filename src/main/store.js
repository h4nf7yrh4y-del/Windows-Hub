'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Tiny JSON store with atomic writes and a debounced flush.
 * Everything lives in one file so the user can back it up / edit it by hand.
 */

const DEFAULTS = {
  version: 1,
  settings: {
    autostart: false,
    startFullscreen: true,
    kiosk: false,
    accent: '#00f0ff',
    accent2: '#ff2e88',
    scanlines: true,
    grid: true,
    bootAnimation: true,
    reduceMotion: false,
    metricsIntervalMs: 1000,
    slowMetricsIntervalMs: 5000,
    processIntervalMs: 3000,
    minimizeOnLaunch: true,
    confirmExit: true,
    showGpu: true
  },
  profiles: [],
  library: { customApps: [] },
  lastProfileId: null
};

let cache = null;
let filePath = null;
let flushTimer = null;

function resolvePath() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'hub-config.json');
  return filePath;
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  if (typeof base !== 'object' || base === null) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const key of Object.keys(override || {})) {
    const value = override[key];
    if (value === undefined) continue;
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

function load() {
  if (cache) return cache;
  const file = resolvePath();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      cache = deepMerge(DEFAULTS, JSON.parse(raw));
    } else {
      cache = JSON.parse(JSON.stringify(DEFAULTS));
    }
  } catch (err) {
    console.error('[store] config unreadable, falling back to defaults:', err.message);
    // Keep the broken file around so the user does not silently lose profiles.
    try {
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.broken-${Date.now()}`);
    } catch (_) { /* best effort */ }
    cache = JSON.parse(JSON.stringify(DEFAULTS));
  }
  if (!Array.isArray(cache.profiles)) cache.profiles = [];
  return cache;
}

function writeNow() {
  const file = resolvePath();
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[store] write failed:', err.message);
  }
}

/**
 * Writes are synchronous by default. The config is a few kilobytes and only
 * changes on explicit user action, so debouncing would buy nothing and would
 * lose a just-saved profile if the process is killed in the meantime.
 * `defer: true` exists for any future high-frequency writer.
 */
function save({ defer = false } = {}) {
  if (!cache) return;
  if (!defer) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    writeNow();
    return;
  }
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flushTimer = null; writeNow(); }, 250);
}

module.exports = {
  DEFAULTS,
  get state() { return load(); },
  load,
  save,
  getSettings() { return load().settings; },
  setSettings(patch) {
    const state = load();
    state.settings = { ...state.settings, ...patch };
    save();
    return state.settings;
  },
  configPath: resolvePath
};
