'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const store = require('./store');
const launcher = require('./launcher');
const logger = require('./logger');

const log = logger.scoped('tray');

/**
 * A tray icon for the parts of the hub that keep working with the window
 * closed: overlays, profile triggers, the scheduler. Without one, reaching
 * any of that meant restoring a 1600x950 window over whatever it was
 * supposed to stay out of the way of.
 *
 * The menu is rebuilt on every right-click instead of kept in sync with the
 * profile list as it changes. A stale entry pointing at a deleted profile
 * would be a small version of the exact problem a menu is supposed to solve.
 */

let tray = null;

/** What to show, kept separate from what happens on a click, so it can be tested without one. */
function profileEntries(profiles) {
  return (profiles || [])
    .filter((profile) => profile && profile.id && profile.name)
    .map((profile) => ({ id: profile.id, label: profile.name }));
}

function launchFromTray(profileId) {
  const profile = (store.state.profiles || []).find((p) => p.id === profileId);
  if (!profile) return;
  log.info(`Profil „${profile.name}" aus der Ablage gestartet`);
  launcher.launchProfile(profile, () => {})
    .catch((err) => log.error(`Ablage-Start fehlgeschlagen: ${err.message}`));
}

function buildMenu({ onOpen, onQuit }) {
  const entries = profileEntries(store.state.profiles);
  const profileItems = entries.length
    ? entries.map((entry) => ({ label: entry.label, click: () => launchFromTray(entry.id) }))
    : [{ label: 'Keine Profile angelegt', enabled: false }];

  return Menu.buildFromTemplate([
    { label: 'Hub anzeigen', click: onOpen },
    { type: 'separator' },
    { label: 'Profil starten', enabled: false },
    ...profileItems,
    { type: 'separator' },
    { label: 'Windows Hub beenden', click: onQuit }
  ]);
}

function init({ iconPath, onOpen, onToggle, onQuit }) {
  if (tray) return tray;

  const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16, quality: 'best' });
  tray = new Tray(image);
  tray.setToolTip('Windows Hub');
  tray.on('click', onToggle);
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu({ onOpen, onQuit })));

  return tray;
}

function destroy() {
  if (tray) { tray.destroy(); tray = null; }
}

module.exports = { init, destroy, profileEntries };
