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
    showGpu: true,
    gamepad: true,
    // Only ever shown while the hub is not the window on screen.
    notifications: true,
    // Which monitor the hub opens on; null means the primary one.
    hubDisplay: null,
    // Set once the first-run wizard has been finished or dismissed.
    welcomeSeen: false
  },
  profiles: [],
  library: { customApps: [] },
  lastProfileId: null,
  // Written while a profile holds system changes, cleared when they are undone.
  // Surviving a crash is the point: a power plan must not stay switched
  // because the hub was killed.
  tweakSnapshot: null,
  // Ids of console sessions, so they can be resumed from the window that
  // started them. The transcripts themselves belong to Claude Code.
  claudeSessions: [],
  // Time-of-day rules that start or stop profiles.
  schedules: [],
  // Second-screen board: whether it is open, and on which monitor.
  dashboard: { enabled: false, display: null, autoOpen: false },
  // How long each profile actually ran. Appended when a session ends.
  playSessions: [],
  // Jump marks into the Discord client. Not chat -- see discord.js for why.
  discord: [],
  // Deleted profiles, kept for two weeks so a misclick is recoverable.
  trash: []
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

const SCHEMA_VERSION = 1;

/**
 * Brings an older configuration up to the current shape.
 *
 * Nothing has needed migrating yet, but the hook has to exist before the
 * format changes rather than after: without it an old file either breaks
 * silently or loses the fields a new version does not recognise. Each step
 * is applied in order and is responsible for one version bump.
 */
const MIGRATIONS = [
  // Example shape for the next change:
  // { to: 2, apply(config) { ...; return config; } }
];

function migrate(config) {
  let current = Number(config.version) || 1;
  if (current === SCHEMA_VERSION) return { config, migrated: false, from: current };

  if (current > SCHEMA_VERSION) {
    // Written by a newer build. Merging defaults keeps it usable rather than
    // discarding fields this version simply does not know about.
    console.warn(`[store] Konfiguration stammt aus Version ${current}, diese Version kennt ${SCHEMA_VERSION}`);
    return { config, migrated: false, from: current, newer: true };
  }

  for (const step of MIGRATIONS) {
    if (step.to > current && step.to <= SCHEMA_VERSION) {
      config = step.apply(config) || config;
      current = step.to;
    }
  }
  config.version = SCHEMA_VERSION;
  return { config, migrated: true, from: Number(config.version) || 1 };
}

function load() {
  if (cache) return cache;
  const file = resolvePath();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      const result = migrate(parsed);
      cache = deepMerge(DEFAULTS, result.config);
      if (result.migrated) {
        // Keep the original around; a migration that turns out wrong should
        // not be the reason a user loses their profiles.
        try { fs.copyFileSync(file, `${file}.v${result.from}-backup`); } catch (_) { /* best effort */ }
        save();
      }
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
  SCHEMA_VERSION,
  migrate,
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
