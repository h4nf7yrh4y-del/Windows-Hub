'use strict';

const { app } = require('electron');
const logger = require('./logger');

const log = logger.scoped('selfupdate');

/**
 * Updating the hub itself.
 *
 * The one program the update centre could not update was the update centre.
 * electron-builder already writes `latest.yml` next to the executables, which
 * is the file electron-updater reads, so the missing part was asking for it.
 *
 * Three things about this are not obvious and are the reason the module states
 * its own limits instead of just offering a button:
 *
 *   1. An unpackaged run has no installer to replace, so there is nothing to
 *      update. `npm run dev` therefore reports "not applicable", not "current".
 *   2. The portable build cannot update itself. electron-updater replaces an
 *      installed application; a single exe the user put somewhere has nothing
 *      to hand over to. That build can find out that a newer version exists
 *      and open the download page, and says so rather than pretending.
 *   3. Builds from a branch are published as pre-releases, which the updater
 *      skips by default. Left at the default it would answer "up to date"
 *      forever -- a wrong answer that looks like good news, which is the kind
 *      nobody checks.
 */

const RELEASES_URL = 'https://github.com/h4nf7yrh4y-del/Windows-Hub/releases/latest';

// electron-builder sets this for portable builds, and only for those. It is
// the only reliable way to tell a portable run from an installed one.
const IS_PORTABLE = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);

let emit = () => {};
let updater = null;
let wired = false;

// 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'current' | 'error'
let status = 'idle';
let available = null;
let progress = 0;
let lastError = null;
let checkedAt = 0;

function setEmitter(fn) {
  emit = typeof fn === 'function' ? fn : () => {};
}

function version() {
  try {
    return require('../../package.json').version || app.getVersion();
  } catch (_) {
    return app.getVersion();
  }
}

/**
 * Why this build cannot update itself, or null if it can.
 *
 * Returned as a sentence the interface can show, because "no update button"
 * without a reason reads as a bug.
 */
function blockedReason() {
  if (process.platform !== 'win32') return 'Automatische Updates gibt es nur unter Windows.';
  if (!app.isPackaged) {
    return 'Diese Fassung läuft aus dem Quellcode. Es gibt keine Installation, die ersetzt werden könnte.';
  }
  if (IS_PORTABLE) {
    return 'Die portable Fassung kann sich nicht selbst ersetzen. Der Hub sagt Bescheid, '
      + 'wenn es etwas Neueres gibt, herunterladen musst du es selbst.';
  }
  return null;
}

/** True when this build can download and install an update on its own. */
function canInstall() {
  return blockedReason() === null;
}

/**
 * The updater, created on first use.
 *
 * Deliberately lazy: requiring electron-updater pulls in its whole dependency
 * tree, and a build that can never install an update has no use for it.
 */
function getUpdater() {
  if (updater) return updater;
  // eslint-disable-next-line global-require
  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  // Branch builds are published as pre-releases; without this the updater
  // would never see them and would report that everything is current.
  updater.allowPrerelease = true;
  updater.logger = {
    info: (m) => log.debug(String(m)),
    warn: (m) => log.warn(String(m)),
    error: (m) => log.warn(String(m)),
    debug: () => {}
  };

  if (!wired) {
    wired = true;
    updater.on('update-available', (info) => {
      available = { version: info && info.version, notes: info && info.releaseName };
      status = 'available';
      emit({ kind: 'available', version: available.version });
    });
    updater.on('update-not-available', () => {
      available = null;
      status = 'current';
      emit({ kind: 'current' });
    });
    updater.on('download-progress', (p) => {
      progress = Math.max(0, Math.min(100, Math.round((p && p.percent) || 0)));
      status = 'downloading';
      emit({ kind: 'progress', percent: progress });
    });
    updater.on('update-downloaded', (info) => {
      progress = 100;
      status = 'ready';
      emit({ kind: 'ready', version: info && info.version });
    });
    updater.on('error', (err) => {
      lastError = usefulError(err);
      status = 'error';
      log.warn(`Updateprüfung fehlgeschlagen: ${lastError}`);
      emit({ kind: 'error', error: lastError });
    });
  }

  return updater;
}

/**
 * A message worth showing.
 *
 * electron-updater reports a missing `latest.yml` as a bare 404, which tells
 * the user nothing. That case has a real cause -- the release carries the
 * executables but not the metadata file -- and naming it saves the guessing.
 */
function usefulError(err) {
  const text = (err && err.message ? err.message : String(err || '')).trim();
  if (/404/.test(text) && /latest\.yml/i.test(text)) {
    return 'Die Veröffentlichung enthält keine Update-Datei (latest.yml). '
      + 'Der nächste Build legt sie mit dazu.';
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(text)) {
    return 'Keine Verbindung zu GitHub.';
  }
  return text || 'Unbekannter Fehler';
}

function state() {
  return {
    supported: canInstall(),
    reason: blockedReason(),
    portable: IS_PORTABLE,
    packaged: app.isPackaged,
    status,
    currentVersion: version(),
    availableVersion: available ? available.version : null,
    percent: progress,
    error: lastError,
    checkedAt,
    releasesUrl: RELEASES_URL
  };
}

/**
 * Asks GitHub whether something newer exists.
 *
 * Runs for the portable build too: knowing about a new version is useful even
 * when the download has to be done by hand. Only installing is blocked there.
 */
async function check() {
  if (process.platform !== 'win32' || !app.isPackaged) {
    status = 'idle';
    return state();
  }

  status = 'checking';
  lastError = null;
  emit({ kind: 'checking' });

  try {
    await getUpdater().checkForUpdates();
  } catch (err) {
    lastError = usefulError(err);
    status = 'error';
    emit({ kind: 'error', error: lastError });
  }

  checkedAt = Date.now();
  return state();
}

async function download() {
  if (!canInstall()) throw new Error(blockedReason());
  if (status !== 'available') throw new Error('Es steht kein Update bereit');

  status = 'downloading';
  progress = 0;
  emit({ kind: 'progress', percent: 0 });
  await getUpdater().downloadUpdate();
  return state();
}

/**
 * Restarts into the new version.
 *
 * Nothing is saved here on purpose: the store writes through on every change,
 * so there is no pending state to flush, and a save on the way out would be a
 * second place that has to be right.
 */
function install() {
  if (!canInstall()) throw new Error(blockedReason());
  if (status !== 'ready') throw new Error('Das Update ist noch nicht heruntergeladen');
  log.info('Update wird installiert, der Hub startet neu');
  setImmediate(() => getUpdater().quitAndInstall(false, true));
  return { ok: true };
}

module.exports = {
  setEmitter,
  state,
  check,
  download,
  install,
  // Exported for the tests: these decide what the interface may offer, and
  // they are the part that can be checked without a packaged build.
  blockedReason,
  canInstall,
  usefulError,
  RELEASES_URL
};
