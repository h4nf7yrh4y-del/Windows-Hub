'use strict';

const fsp = require('fs').promises;
const path = require('path');

const files = require('./files');
const scanner = require('./scanner');
const sessions = require('./sessions');
const logger = require('./logger');

const log = logger.scoped('storage');

/**
 * What is eating the disk, and whether it earns the space.
 *
 * Size alone answers nothing: a 120 GB game played every evening is not the
 * problem, a 90 GB one untouched since last year is. So every row carries both
 * numbers, and the ranking the interface offers by default is "large and not
 * played", not "large".
 *
 * Almost all of this is already known. Steam records the install size and the
 * last launch in the same manifests the update centre reads. Epic records
 * neither, so its games are measured on request rather than guessed at -- see
 * `measure` below for what that costs.
 */

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Days since a timestamp, or null when there is none. */
function daysSince(ms) {
  if (!ms) return null;
  const diff = Date.now() - ms;
  if (diff < 0) return 0;
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

/**
 * How stale a game is, as something the interface can colour by.
 *
 * Deliberately three buckets rather than a number: the decision being
 * supported is "keep, look at, or remove", and a precise day count invites
 * precision the data does not have. Steam only records the last launch, so a
 * game played through another launcher looks untouched.
 */
function staleness(days) {
  if (days === null) return 'unknown';
  if (days <= 30) return 'recent';
  if (days <= 180) return 'idle';
  return 'cold';
}

/**
 * The drive each path sits on.
 *
 * Used to group games by disk, because "free up space" is always about one
 * particular disk being full.
 */
function driveOf(target) {
  const match = /^([A-Za-z]:)/.exec(String(target || ''));
  return match ? match[1].toUpperCase() : null;
}

/* ------------------------------------------------------------------- games */

async function steamGames() {
  const games = await scanner.scanSteam();
  return games.map((game) => {
    const last = game.lastPlayed ? game.lastPlayed * 1000 : 0;
    const days = daysSince(last);
    return {
      id: game.id,
      source: 'steam',
      name: game.name,
      appId: game.appId,
      bytes: game.sizeOnDisk || 0,
      // Steam stores the last launch as unix seconds; zero means never.
      lastPlayed: last || null,
      days,
      staleness: staleness(days),
      installDir: game.installDir,
      drive: driveOf(game.installDir),
      // Known without measuring, which is what makes this list instant.
      measured: true
    };
  });
}

async function epicGames() {
  const games = await scanner.scanEpic();
  return games.map((game) => ({
    id: game.id,
    source: 'epic',
    name: game.name,
    appId: null,
    bytes: 0,
    lastPlayed: null,
    days: null,
    staleness: 'unknown',
    installDir: game.installDir,
    drive: driveOf(game.installDir),
    // Epic's manifests carry neither a size nor a last launch. Showing zero
    // as if it were a measurement would be worse than admitting it.
    measured: false
  }));
}

/**
 * Adds up a directory tree.
 *
 * Only ever called for one game at a time and only when asked. A game
 * directory is tens of thousands of files, and walking every Epic install at
 * once would freeze the view for minutes -- the interface offers a button per
 * game instead of doing it behind the user's back.
 */
async function measure(target) {
  const root = String(target || '');
  if (!root || !path.isAbsolute(root)) throw new Error('Kein gültiger Ordner');

  let total = 0;
  let files_ = 0;
  const stack = [root];

  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      // An unreadable subdirectory is skipped rather than failing the whole
      // measurement: a partial number with a known cause beats no number.
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      try {
        const stats = await fsp.stat(full);
        total += stats.size;
        files_ += 1;
      } catch (_) { /* vanished between listing and stat */ }
    }
  }

  return { bytes: total, files: files_ };
}

/* ------------------------------------------------------------------ report */

/**
 * Everything at once, because none of it is slow.
 *
 * The drives come from the same query the file manager uses; the games come
 * from manifests already on disk. Epic sizes are the exception and are left at
 * zero until someone asks for them.
 */
async function overview() {
  const [disks, steam, epic] = await Promise.all([
    files.drives().catch((err) => { log.warn(`Laufwerke nicht lesbar: ${err.message}`); return []; }),
    steamGames().catch((err) => { log.warn(`Steam-Bibliothek nicht lesbar: ${err.message}`); return []; }),
    epicGames().catch(() => [])
  ]);

  const games = [...steam, ...epic].sort((a, b) => b.bytes - a.bytes);

  const known = games.filter((g) => g.measured);
  const totalBytes = known.reduce((sum, g) => sum + g.bytes, 0);
  const coldBytes = known
    .filter((g) => g.staleness === 'cold')
    .reduce((sum, g) => sum + g.bytes, 0);

  return {
    ts: Date.now(),
    drives: disks.filter((d) => d.type === 'fixed' || d.type === 'removable'),
    games,
    totals: {
      games: games.length,
      measured: known.length,
      bytes: totalBytes,
      coldBytes,
      // Games nobody has launched in a year: the shortlist this view exists
      // to produce.
      coldCount: known.filter((g) => g.lastPlayed && Date.now() - g.lastPlayed > YEAR_MS).length
    },
    // What the hub itself knows about how long profiles ran. Not the same as
    // per-game time -- said so in the interface rather than implied.
    playtime: sessions.stats()
  };
}

/* ----------------------------------------------------------- freeing space */

/**
 * The address that asks Steam to remove a game.
 *
 * Its own function, and checked here rather than at the call site: the value
 * comes from the renderer and ends up in a URI the shell executes. Written as
 * an argument it would be evaluated after the method lookup, which puts the
 * check second.
 */
function uninstallUri(appId) {
  if (!/^\d+$/.test(String(appId || ''))) throw new Error('Ungültige Spiel-Kennung');
  return `steam://uninstall/${appId}`;
}

/**
 * Hands the removal to Steam.
 *
 * The hub deliberately does not delete anything itself. Steam knows which
 * files belong to a game, which are shared with another, and what to write
 * back into its manifests; a directory this module deleted would leave a
 * library Steam believes is still installed.
 */
async function uninstallSteamGame(appId) {
  const uri = uninstallUri(appId);
  if (process.platform !== 'win32') throw new Error('Nur unter Windows verfügbar');
  // eslint-disable-next-line global-require
  const { shell } = require('electron');
  await shell.openExternal(uri);
  return { ok: true, note: 'Steam fragt nach und entfernt das Spiel.' };
}

module.exports = {
  overview,
  measure,
  uninstallSteamGame,
  uninstallUri,
  // Exported for the tests: these are the judgements, and they are the part
  // that is wrong in a way nobody notices.
  daysSince,
  staleness,
  driveOf,
  YEAR_MS
};
