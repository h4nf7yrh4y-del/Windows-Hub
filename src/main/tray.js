'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const store = require('./store');
const launcher = require('./launcher');
const media = require('./media');
const logger = require('./logger');

const log = logger.scoped('tray');
const IS_WIN = process.platform === 'win32';
const MEDIA_POLL_MS = 8000;

/**
 * A tray icon for the parts of the hub that keep working with the window
 * closed: overlays, profile triggers, the scheduler, playback control.
 * Without one, reaching any of that meant restoring a 1600x950 window over
 * whatever it was supposed to stay out of the way of.
 *
 * The profile section of the menu is rebuilt on every right-click instead of
 * kept in sync with the profile list as it changes. A stale entry pointing
 * at a deleted profile would be a small version of the exact problem a menu
 * is supposed to solve. Playback is different: `media.read()` is a system
 * call that can take a few seconds, so it runs on its own timer and the menu
 * reads whatever it found last, the same trade the overlay and the hub's own
 * media bar already make.
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

/*
 * Playback in the menu, polled on its own timer rather than read fresh on
 * every right-click: `media.read()` can take a few seconds on its first
 * call, and a tray menu that hangs before it opens is worse than one a
 * few seconds stale. `checked` distinguishes "asked, nothing playing" from
 * "has not asked yet" -- otherwise the moment before the first poll resolves
 * would show the same label as a machine with no player running at all.
 */
let nowPlaying = null;
let checked = false;
let pollTimer = null;

function pollMedia() {
  media.read()
    .then((data) => { nowPlaying = data; checked = true; })
    .catch(() => { checked = true; });
}

function startMediaPoll() {
  if (!IS_WIN || pollTimer) return;
  pollMedia();
  pollTimer = setInterval(pollMedia, MEDIA_POLL_MS);
}

function stopMediaPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  nowPlaying = null;
  checked = false;
}

function runMediaCommand(name) {
  media.command(name)
    .then((data) => { nowPlaying = data; })
    .catch((err) => log.error(`Wiedergabe-Befehl aus der Ablage fehlgeschlagen: ${err.message}`));
}

/**
 * What the menu should say about playback, kept separate from the `Menu`
 * items themselves so the three-way state -- not checked yet, checked and
 * idle, checked and playing -- is testable without a poll timer or a click
 * handler that would run a real command.
 */
function mediaStatus(data, hasChecked) {
  if (!hasChecked) return { state: 'checking' };
  if (!data || !data.available || !data.title) return { state: 'idle' };
  return {
    state: 'playing',
    label: data.artist ? `${data.title} — ${data.artist}` : data.title,
    playing: !!data.playing,
    canPrev: !!data.canPrev,
    canNext: !!data.canNext
  };
}

function mediaMenuItems() {
  if (!IS_WIN) return [];
  const info = mediaStatus(nowPlaying, checked);
  if (info.state === 'checking') return [{ label: 'Wiedergabe wird geprüft …', enabled: false }];
  if (info.state === 'idle') return [{ label: 'Keine Wiedergabe', enabled: false }];

  return [
    { label: info.label, enabled: false },
    { label: 'Zurück', enabled: info.canPrev, click: () => runMediaCommand('previous') },
    { label: info.playing ? 'Pause' : 'Abspielen', click: () => runMediaCommand('playpause') },
    { label: 'Weiter', enabled: info.canNext, click: () => runMediaCommand('next') }
  ];
}

function buildMenu({ onOpen, onQuit }) {
  const entries = profileEntries(store.state.profiles);
  const profileItems = entries.length
    ? entries.map((entry) => ({ label: entry.label, click: () => launchFromTray(entry.id) }))
    : [{ label: 'Keine Profile angelegt', enabled: false }];
  const mediaItems = mediaMenuItems();

  return Menu.buildFromTemplate([
    { label: 'Hub anzeigen', click: onOpen },
    { type: 'separator' },
    ...mediaItems,
    ...(mediaItems.length ? [{ type: 'separator' }] : []),
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

  startMediaPoll();
  return tray;
}

function destroy() {
  stopMediaPoll();
  if (tray) { tray.destroy(); tray = null; }
}

module.exports = { init, destroy, profileEntries, mediaStatus };
