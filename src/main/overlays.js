'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const store = require('./store');

/**
 * Floating always-on-top performance widgets.
 *
 * Each overlay is its own frameless, transparent BrowserWindow driven by the
 * same metrics stream as the dashboard. Position and scale are persisted per
 * type so a widget comes back where the user left it.
 *
 * Known limit: Windows composites exclusive-fullscreen games directly on the
 * GPU, so nothing drawn by another process appears above them. These overlays
 * are visible over borderless-windowed and normal windows only. A real
 * in-game overlay requires hooking the graphics API, which Electron cannot do.
 */

const OVERLAY_TYPES = {
  combo: { label: 'Kompakt',    width: 250, height: 128 },
  cpu:   { label: 'Prozessor',  width: 224, height: 132 },
  ram:   { label: 'Speicher',   width: 224, height: 118 },
  gpu:   { label: 'Grafik',     width: 224, height: 132 },
  net:   { label: 'Netzwerk',   width: 224, height: 118 },
  disk:  { label: 'Datenträger',width: 224, height: 118 }
};

const windows = new Map(); // type -> BrowserWindow
const saveTimers = new Map();

let preloadPath = null;
let onCountChange = () => {};

function init({ preload, onChange }) {
  preloadPath = preload;
  if (typeof onChange === 'function') onCountChange = onChange;
}

function overlayState(type) {
  const state = store.state;
  if (!state.overlays) state.overlays = {};
  if (!state.overlays[type]) {
    state.overlays[type] = { enabled: false, x: null, y: null, scale: 1, opacity: 0.92, locked: false };
  }
  return state.overlays[type];
}

/** Keeps a remembered position usable after a monitor change. */
function clampToDisplay(x, y, width, height) {
  if (x == null || y == null) return null;
  const displays = screen.getAllDisplays();
  const fits = displays.some((d) => {
    const b = d.workArea;
    return x + width > b.x + 24 && x < b.x + b.width - 24
        && y + height > b.y + 24 && y < b.y + b.height - 24;
  });
  return fits ? { x: Math.round(x), y: Math.round(y) } : null;
}

function defaultPosition(index, width) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + area.width - width - 24),
    y: Math.round(area.y + 24 + index * 150)
  };
}

function persistBounds(type, win) {
  if (!win || win.isDestroyed()) return;
  if (saveTimers.has(type)) clearTimeout(saveTimers.get(type));
  saveTimers.set(type, setTimeout(() => {
    saveTimers.delete(type);
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();
    const conf = overlayState(type);
    conf.x = bounds.x;
    conf.y = bounds.y;
    store.save();
  }, 400));
}

function create(type) {
  const spec = OVERLAY_TYPES[type];
  if (!spec) throw new Error(`Unbekannter Overlay-Typ: ${type}`);
  if (windows.has(type)) {
    const existing = windows.get(type);
    existing.showInactive();
    return existing;
  }

  const conf = overlayState(type);
  const scale = Number(conf.scale) || 1;
  const width = Math.round(spec.width * scale);
  const height = Math.round(spec.height * scale);
  const position = clampToDisplay(conf.x, conf.y, width, height) || defaultPosition(windows.size, width);

  const win = new BrowserWindow({
    width,
    height,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  // 'screen-saver' is the highest level that still behaves on Windows.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setOpacity(Math.max(0.25, Math.min(1, Number(conf.opacity) || 0.92)));
  if (conf.locked) win.setIgnoreMouseEvents(true, { forward: true });

  win.loadURL(`hub://app/overlay.html?type=${encodeURIComponent(type)}&scale=${scale}`);

  win.once('ready-to-show', () => win.showInactive());
  win.on('moved', () => persistBounds(type, win));
  win.on('closed', () => {
    windows.delete(type);
    onCountChange(windows.size);
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  windows.set(type, win);
  onCountChange(windows.size);
  return win;
}

function close(type) {
  const win = windows.get(type);
  if (win && !win.isDestroyed()) win.close();
  windows.delete(type);
}

function setEnabled(type, enabled) {
  if (!OVERLAY_TYPES[type]) throw new Error(`Unbekannter Overlay-Typ: ${type}`);
  const conf = overlayState(type);
  conf.enabled = !!enabled;
  store.save();
  if (enabled) create(type);
  else close(type);
  return conf;
}

function update(type, patch) {
  const conf = overlayState(type);
  if ('scale' in patch) conf.scale = Math.max(0.75, Math.min(2, Number(patch.scale) || 1));
  if ('opacity' in patch) conf.opacity = Math.max(0.25, Math.min(1, Number(patch.opacity) || 0.92));
  if ('locked' in patch) conf.locked = !!patch.locked;
  store.save();

  const win = windows.get(type);
  if (win && !win.isDestroyed()) {
    win.setOpacity(conf.opacity);
    win.setIgnoreMouseEvents(conf.locked, { forward: true });
    if ('scale' in patch) {
      const spec = OVERLAY_TYPES[type];
      const bounds = win.getBounds();
      win.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: Math.round(spec.width * conf.scale),
        height: Math.round(spec.height * conf.scale)
      });
      win.webContents.send('overlay:scale', conf.scale);
    }
  }
  return conf;
}

/** Reopens whatever was enabled when the hub last shut down. */
function restore() {
  const overlays = store.state.overlays || {};
  Object.keys(OVERLAY_TYPES).forEach((type) => {
    if (overlays[type] && overlays[type].enabled) {
      try { create(type); } catch (err) { console.error('[overlays]', err.message); }
    }
  });
}

/** Closes the windows but keeps `enabled`, so a restart restores them. */
function closeAll() {
  for (const type of Array.from(windows.keys())) close(type);
}

/**
 * The user-facing "close all": also clears `enabled`, because someone who
 * dismisses every overlay does not expect them back at the next sign-in.
 */
function disableAll() {
  for (const type of Object.keys(OVERLAY_TYPES)) {
    const conf = overlayState(type);
    if (conf.enabled) conf.enabled = false;
    close(type);
  }
  store.save();
  return { ok: true };
}

function broadcast(channel, payload) {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function list() {
  const overlays = store.state.overlays || {};
  return Object.entries(OVERLAY_TYPES).map(([type, spec]) => {
    const conf = overlays[type] || {};
    return {
      type,
      label: spec.label,
      width: spec.width,
      height: spec.height,
      open: windows.has(type),
      enabled: !!conf.enabled,
      scale: Number(conf.scale) || 1,
      opacity: Number(conf.opacity) || 0.92,
      locked: !!conf.locked
    };
  });
}

function count() { return windows.size; }

module.exports = {
  init, create, close, closeAll, disableAll, setEnabled, update,
  restore, broadcast, list, count, OVERLAY_TYPES
};
