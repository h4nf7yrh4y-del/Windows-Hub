import { api } from './api.js';
import { normalizeProcessName } from './util.js';

/**
 * Central app state with a tiny pub/sub. One module owns settings, profiles
 * and the latest metrics sample; views subscribe to what they care about.
 */

const listeners = new Map();

export const state = {
  settings: null,
  profiles: [],
  lastProfileId: null,
  appInfo: null,
  staticInfo: null,
  metrics: null,
  library: null,
  running: new Set(),
  runningAt: 0,
  activeView: 'hub'
};

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event).delete(handler);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const handler of set) {
    try { handler(payload); } catch (err) { console.error(`[state:${event}]`, err); }
  }
}

/* ------------------------------------------------------------------ theme */

export function applyTheme(settings = state.settings) {
  if (!settings) return;
  const root = document.documentElement;
  root.style.setProperty('--accent', settings.accent || '#00f0ff');
  root.style.setProperty('--accent-2', settings.accent2 || '#ff2e88');
  root.dataset.scanlines = String(settings.scanlines !== false);
  root.dataset.grid = String(settings.grid !== false);
  root.dataset.reduceMotion = String(!!settings.reduceMotion);
}

/** Temporarily tints the whole UI, e.g. while a profile is launching. */
export function pushAccent(color) {
  if (!color) return;
  document.documentElement.style.setProperty('--accent', color);
}

export function resetAccent() {
  applyTheme();
}

/* ------------------------------------------------------------------ loads */

export async function loadSettings() {
  state.settings = await api.settings.get();
  applyTheme();
  emit('settings', state.settings);
  return state.settings;
}

export async function saveSettings(patch) {
  state.settings = await api.settings.set(patch);
  applyTheme();
  emit('settings', state.settings);
  return state.settings;
}

export async function loadProfiles() {
  const data = await api.profiles.list();
  state.profiles = data.profiles || [];
  state.lastProfileId = data.lastProfileId || null;
  emit('profiles', state.profiles);
  return state.profiles;
}

export async function loadAppInfo() {
  state.appInfo = await api.app.info();
  emit('appInfo', state.appInfo);
  return state.appInfo;
}

export async function loadStaticInfo() {
  state.staticInfo = await api.metrics.static();
  emit('staticInfo', state.staticInfo);
  return state.staticInfo;
}

export async function loadLibrary({ force = false } = {}) {
  state.library = await api.library.scan({ force });
  emit('library', state.library);
  return state.library;
}

/* ------------------------------------------------------- running processes */

/**
 * Shared poll of which process names are alive, used for profile status.
 *
 * Reference counted so it only runs while some view is actually showing it,
 * and never overlaps: each poll is a PowerShell round trip, cheap but not
 * free.
 */

let runningTimer = null;
let runningRefs = 0;
let runningBusy = false;

async function pollRunning() {
  if (runningBusy) return;
  runningBusy = true;
  try {
    const data = await api.processes.running();
    state.running = new Set((data.names || []).map(normalizeProcessName));
    state.runningAt = data.ts || Date.now();
    emit('running', state.running);
  } catch (err) {
    // A failed poll keeps the previous picture rather than blanking every
    // status indicator on one hiccup.
    console.warn('[state] running poll failed:', err.message);
  } finally {
    runningBusy = false;
  }
}

export function watchRunning(intervalMs = 4000) {
  runningRefs += 1;
  if (!runningTimer) {
    pollRunning();
    runningTimer = setInterval(pollRunning, Math.max(1500, intervalMs));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    runningRefs = Math.max(0, runningRefs - 1);
    if (runningRefs === 0 && runningTimer) {
      clearInterval(runningTimer);
      runningTimer = null;
    }
  };
}

export function refreshRunning() {
  return pollRunning();
}

/* ---------------------------------------------------------------- metrics */

let metricsBound = false;

export function bindMetrics() {
  if (metricsBound) return;
  metricsBound = true;
  api.metrics.onSample((sample) => {
    state.metrics = sample;
    emit('metrics', sample);
  });
  api.metrics.subscribe().catch(() => {});
}
