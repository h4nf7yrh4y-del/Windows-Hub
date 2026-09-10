'use strict';

const path = require('path');
const { BrowserWindow } = require('electron');
const store = require('./store');
const screens = require('./screens');
const logger = require('./logger');

const log = logger.scoped('dashboard');

/**
 * The second-screen window.
 *
 * A hub that fills the main monitor is of no use while a game is on it. This
 * is the other half: a full-screen board on the second monitor showing what
 * the machine is doing, meant to be looked at out of the corner of an eye
 * rather than operated. It is deliberately not the hub in a second window —
 * no navigation, no dialogs, nothing that could steal focus from the game.
 */

let win = null;
let preloadPath = null;
let onVisibilityChange = () => {};

function init({ preload, onChange }) {
  preloadPath = preload;
  if (typeof onChange === 'function') onVisibilityChange = onChange;
}

function config() {
  const state = store.state;
  if (!state.dashboard || typeof state.dashboard !== 'object') {
    state.dashboard = { enabled: false, display: null, autoOpen: false };
  }
  return state.dashboard;
}

function isOpen() {
  return !!(win && !win.isDestroyed());
}

function targetDisplay() {
  const saved = config().display;
  if (saved) return screens.resolve(saved);

  // With no choice made, anything but the hub's own screen is the useful
  // default — a board on top of the game would be worse than none.
  const hub = screens.resolve(store.getSettings().hubDisplay || null).display;
  const other = screens.otherThan(hub);
  return { display: other || hub, match: other ? 'auto' : 'single' };
}

function open() {
  if (isOpen()) {
    win.show();
    return win;
  }

  const { display, match } = targetDisplay();
  win = new BrowserWindow({
    ...display.bounds,
    show: false,
    frame: false,
    backgroundColor: '#05070a',
    title: 'Windows Hub · Dashboard',
    autoHideMenuBar: true,
    skipTaskbar: true,
    // Never on top: this sits on its own screen, and forcing it above other
    // windows would only get in the way of whatever else is over there.
    alwaysOnTop: false,
    fullscreenable: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // The graphs have to keep drawing while the game has focus.
      backgroundThrottling: false
    }
  });

  win.removeMenu();
  win.loadURL('hub://app/dashboard.html');

  win.once('ready-to-show', () => {
    screens.placeWindow(win, display, { fullscreen: true });
    win.show();
    // Showing it must not take focus away from a running game.
    win.blur();
  });

  win.on('closed', () => {
    win = null;
    config().enabled = false;
    store.save();
    onVisibilityChange(false);
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  config().enabled = true;
  store.save();
  log.info(`Dashboard geöffnet auf „${display.label}" (${match})`);
  onVisibilityChange(true);
  return win;
}

function close() {
  if (!isOpen()) return false;
  const dying = win;
  win = null;
  config().enabled = false;
  store.save();
  dying.destroy();
  onVisibilityChange(false);
  return true;
}

function toggle() {
  if (isOpen()) { close(); return false; }
  open();
  return true;
}

/** Moves the board to another monitor and remembers the choice. */
function setDisplay(displayId) {
  const target = screens.list().find((d) => d.id === displayId);
  if (!target) throw new Error('Dieser Bildschirm ist nicht vorhanden');
  const { display } = screens.resolve({ id: target.id, label: target.label, x: target.bounds.x, y: target.bounds.y });
  config().display = screens.remember(display);
  store.save();
  if (isOpen()) screens.placeWindow(win, display, { fullscreen: true });
  return status();
}

function send(channel, payload) {
  if (isOpen()) win.webContents.send(channel, payload);
}

function status() {
  const { display, match } = targetDisplay();
  const saved = config().display;
  return {
    open: isOpen(),
    autoOpen: !!config().autoOpen,
    displayId: display.id,
    displayLabel: display.label,
    // Says outright when the chosen monitor is gone, rather than silently
    // opening somewhere else and leaving the user to wonder.
    displayMissing: !!saved && match === 'fallback',
    onlyOneDisplay: screens.list().length < 2,
    displays: screens.list()
  };
}

function setAutoOpen(value) {
  config().autoOpen = !!value;
  store.save();
  return status();
}

/** Called once at startup: reopens the board if it was open last time. */
function restore() {
  if (config().autoOpen || config().enabled) open();
}

module.exports = { init, open, close, toggle, setDisplay, setAutoOpen, status, restore, send, isOpen };
