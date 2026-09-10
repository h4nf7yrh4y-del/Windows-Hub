'use strict';

const { screen } = require('electron');
const logger = require('./logger');

const log = logger.scoped('screens');

/**
 * Choosing which monitor a window belongs on.
 *
 * Electron identifies displays by a numeric id, and that id is not stable: it
 * changes when a monitor is unplugged, when the machine reboots, and sometimes
 * when a driver updates. Storing only the id would mean a hub that quietly
 * moves to the wrong screen after a restart. So a saved choice keeps the id,
 * the label and the position, and matching falls back through them in that
 * order before giving up and using the primary display.
 */

function isInternal(display) {
  // Electron only reports this on some platforms; absence is not a promise.
  return display.internal === true;
}

function describe(display) {
  return {
    id: display.id,
    label: display.label || `Bildschirm ${display.id}`,
    primary: display.id === screen.getPrimaryDisplay().id,
    internal: isInternal(display),
    bounds: display.bounds,
    workArea: display.workArea,
    size: display.size,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation
  };
}

/** Everything the user could pick, in left-to-right order. */
function list() {
  return screen.getAllDisplays()
    .slice()
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map(describe);
}

/** The form a choice is stored in. Not just the id, for the reason above. */
function remember(display) {
  if (!display) return null;
  return {
    id: display.id,
    label: display.label || '',
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height
  };
}

/**
 * The display a saved choice refers to, or the primary one.
 * Returns the display plus how it was found, so the interface can say when a
 * monitor the user picked is no longer there.
 */
function resolve(saved) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  if (!saved || typeof saved !== 'object') return { display: primary, match: 'primary' };

  const byId = displays.find((d) => d.id === saved.id);
  if (byId) return { display: byId, match: 'id' };

  // A monitor that came back on a different id usually keeps its name and its
  // place in the desktop layout.
  const byLabelAndPlace = displays.find((d) =>
    saved.label && d.label === saved.label && d.bounds.x === saved.x && d.bounds.y === saved.y);
  if (byLabelAndPlace) return { display: byLabelAndPlace, match: 'label' };

  const byPlace = displays.find((d) => d.bounds.x === saved.x && d.bounds.y === saved.y);
  if (byPlace) return { display: byPlace, match: 'position' };

  const byLabel = displays.find((d) => saved.label && d.label === saved.label);
  if (byLabel) return { display: byLabel, match: 'label-only' };

  log.warn(`Bildschirm „${saved.label || saved.id}" nicht gefunden, es wird der Hauptbildschirm benutzt`);
  return { display: primary, match: 'fallback' };
}

/**
 * Moves a window onto a display and, optionally, fills it.
 *
 * Leaving fullscreen first is not optional: a window that is already fullscreen
 * ignores setBounds on Windows, so moving it would silently do nothing.
 */
function placeWindow(win, display, { fullscreen = true } = {}) {
  if (!win || win.isDestroyed() || !display) return false;

  const wasFullScreen = win.isFullScreen();
  if (wasFullScreen) win.setFullScreen(false);

  const area = fullscreen ? display.bounds : display.workArea;
  if (fullscreen) {
    win.setBounds(area);
    // The change of bounds has to land before the window is filled again,
    // otherwise it goes fullscreen on the screen it came from.
    setTimeout(() => {
      if (!win.isDestroyed()) win.setFullScreen(true);
    }, 60);
  } else {
    const width = Math.min(win.getBounds().width, area.width);
    const height = Math.min(win.getBounds().height, area.height);
    win.setBounds({
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height
    });
  }
  return true;
}

/** A display that is not the one given, for a sensible default second screen. */
function otherThan(display) {
  const displays = screen.getAllDisplays();
  if (displays.length < 2) return null;
  return displays.find((d) => d.id !== display.id) || null;
}

module.exports = { list, describe, remember, resolve, placeWindow, otherThan };
