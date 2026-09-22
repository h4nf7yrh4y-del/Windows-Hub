'use strict';

const { Notification } = require('electron');
const store = require('./store');
const logger = require('./logger');

const log = logger.scoped('notify');

/**
 * Desktop notifications for the things that happen when nobody is looking.
 *
 * The hub has a toast for everything it does, and a toast is enough while
 * someone is looking at it. The tray changed that: the hub now runs minimized
 * for hours, and a trigger firing, an update finishing or a scheduled profile
 * starting all happen with no window on screen to show a toast in.
 *
 * So this is deliberately not "the toasts, again". A notification is shown
 * only when the hub is not the thing on screen -- notifying someone about
 * what they are currently watching is how an application teaches people to
 * dismiss its notifications without reading them.
 */

let getWindow = () => null;
let iconPath = null;

/* ------------------------------------------------------------------- pure */

/**
 * Whether this is worth interrupting someone for.
 *
 * `visible` means the hub window is on screen and focused -- the one case
 * where a notification says nothing the toast has not already said.
 */
function shouldNotify({ supported, enabled, visible }) {
  if (!supported) return false;
  if (!enabled) return false;
  return !visible;
}

/* --------------------------------------------------------------- end pure */

function init({ getWindow: resolveWindow, icon } = {}) {
  if (typeof resolveWindow === 'function') getWindow = resolveWindow;
  iconPath = icon || null;
}

function hubIsVisible() {
  const win = getWindow();
  if (!win || win.isDestroyed()) return false;
  return win.isVisible() && !win.isMinimized() && win.isFocused();
}

/**
 * Shows one, if it is worth showing.
 *
 * Never throws: a notification that fails is not a reason for the thing it
 * was reporting on to look like it failed too.
 */
function show(title, body) {
  const settings = store.getSettings();
  const allowed = shouldNotify({
    supported: Notification.isSupported(),
    enabled: settings.notifications !== false,
    visible: hubIsVisible()
  });
  if (!allowed || !title) return false;

  try {
    const notification = new Notification({
      title: String(title),
      body: String(body || ''),
      icon: iconPath || undefined,
      silent: false
    });
    // Clicking it brings the hub back, which is the only thing anyone wants
    // from a notification about the hub.
    notification.on('click', () => {
      const win = getWindow();
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    notification.show();
    return true;
  } catch (err) {
    log.debug(`Benachrichtigung nicht möglich: ${err.message}`);
    return false;
  }
}

module.exports = { init, show, shouldNotify };
