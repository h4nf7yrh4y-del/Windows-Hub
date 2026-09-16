'use strict';

const path = require('path');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const { shell } = require('electron');

const processes = require('./processes');
const scanner = require('./scanner');
const logger = require('./logger');

const log = logger.scoped('updates');
const IS_WIN = process.platform === 'win32';

/**
 * What on this machine has an update waiting.
 *
 * Three sources, and they are not equal, which is the point of this module
 * being honest about itself:
 *
 *   winget  the Windows package manager. It knows several thousand desktop
 *           programs and installs their updates unattended. This is the part
 *           that deserves the word "updater", and it covers the Steam and Epic
 *           launchers like any other program.
 *   Steam   a game's appmanifest records whether Steam considers it out of
 *           date, so the state is readable. Downloading it is not: only the
 *           client can do that, and it offers no supported way to say "update
 *           this one now". The hub reports and hands over.
 *   Epic    the manifests say what is installed, not what is current. There is
 *           nothing to read and nothing to trigger; the entry exists so the
 *           list is not silently incomplete.
 *
 * Claiming to update everything and then quietly skipping games would be the
 * worse outcome, so each source states what it can and cannot do.
 */

/* ------------------------------------------------------------------ winget */

// Progress spinners, box drawing and carriage-return overwrites arrive mixed
// into the output. None of it is data, and the overwrites are why a naive
// split produces a hundred empty rows.
const SPINNER = /[─-╿·∙|/\\-]*\r/g;
const ANSI = /\[[0-9;?]*[a-zA-Z]/g;
const BACKSPACE = //g;

function cleanOutput(text) {
  return String(text || '')
    .replace(SPINNER, '\n')
    .replace(ANSI, '')
    .replace(BACKSPACE, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n');
}

/**
 * Slices winget's column-aligned output using the header's own positions.
 *
 * The headers are localised, so matching on their text would work in exactly
 * one language. The column offsets are the same everywhere, and the dashed
 * rule marks where the header is. That makes this parser language-independent
 * by construction rather than by a table of translations.
 */
function parseWingetTable(text) {
  const lines = cleanOutput(text).split('\n');
  const ruleIndex = lines.findIndex((line) => /^-{10,}$/.test(line.trim()));
  if (ruleIndex < 1) return { columns: [], rows: [] };

  const header = lines[ruleIndex - 1];
  const columns = [];
  const re = /\S+(?: \S+)*?(?=\s{2,}|$)/g;
  let match;
  while ((match = re.exec(header))) columns.push({ label: match[0], start: match.index });
  if (columns.length < 3) return { columns: [], rows: [] };

  const rows = [];
  for (let i = ruleIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = columns.map((column, index) => {
      const end = index + 1 < columns.length ? columns[index + 1].start : line.length;
      return line.slice(column.start, end).trim();
    });
    // The summary line and the "requires explicit targeting" heading are prose
    // rather than rows: they have nothing at the id offset.
    if (!cells[0] || !cells[1]) continue;
    rows.push(cells);
  }

  return { columns: columns.map((c) => c.label), rows };
}

/**
 * The upgradable packages in a `winget upgrade` listing.
 *
 * Five columns mean Name, Id, Version, Available, Source; four mean there is
 * no Available column and so nothing to upgrade. Counting the columns rather
 * than reading their names keeps this working in every language.
 */
function parseUpgrades(text) {
  const { columns, rows } = parseWingetTable(text);
  if (columns.length < 5) return [];

  return rows
    .map((cells) => ({
      name: cells[0],
      id: cells[1],
      current: cells[2],
      available: cells[3],
      source: cells[4] || ''
    }))
    .filter((row) => row.id && !/^[-\s]*$/.test(row.id))
    // An empty or unchanged "available" is not an upgrade.
    .filter((row) => row.available && row.available !== row.current);
}

const WINGET_LIST_SCRIPT = String.raw`
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { 'HUB_NO_WINGET' } else {
  winget upgrade --include-unknown --accept-source-agreements --disable-interactivity
}
`;

async function wingetUpgrades() {
  if (!IS_WIN) return { available: false, packages: [], note: 'winget gibt es nur unter Windows.' };

  let out = '';
  try {
    // Listing is quick and goes through the shared shell. Installing does not;
    // see runUpgrade below for why.
    out = await processes.runPowerShell(WINGET_LIST_SCRIPT, 90000, { background: true });
  } catch (err) {
    log.warn(`winget nicht lesbar: ${err.message}`);
    return { available: false, packages: [], note: `winget antwortet nicht: ${err.message}` };
  }

  if (out.includes('HUB_NO_WINGET')) {
    return {
      available: false,
      packages: [],
      note: 'winget ist nicht installiert. Es gehört zum App Installer aus dem Microsoft Store.'
    };
  }

  return { available: true, packages: parseUpgrades(out), note: null };
}

/* ------------------------------------------------------------------- Steam */

/**
 * Steam's own view of whether a game is current.
 *
 * StateFlags is a bit field; bit 2 is "update required". A pending download
 * shows as BytesDownloaded lagging BytesToDownload, but only strictly: a
 * finished install leaves the two equal.
 */
function parseSteamState(text) {
  const get = (key) => {
    const m = new RegExp(`"${key}"\\s*"([^"]*)"`, 'i').exec(String(text || ''));
    return m ? m[1] : null;
  };
  const flags = Number(get('StateFlags')) || 0;
  const toDownload = Number(get('BytesToDownload')) || 0;
  const downloaded = Number(get('BytesDownloaded')) || 0;

  return {
    appid: get('appid'),
    name: get('name'),
    flags,
    bytesToDownload: toDownload,
    bytesDownloaded: downloaded,
    updateRequired: (flags & 2) !== 0 || (toDownload > 0 && downloaded < toDownload),
    updateRunning: (flags & 256) !== 0 || (flags & 1024) !== 0,
    remainingBytes: toDownload > downloaded ? toDownload - downloaded : 0
  };
}

async function steamUpdates() {
  if (!IS_WIN) return { available: false, games: [], note: 'Nur unter Windows.' };

  let installed = [];
  try {
    installed = await scanner.scanSteam();
  } catch (err) {
    return { available: false, games: [], note: `Steam-Bibliothek nicht lesbar: ${err.message}` };
  }
  if (!installed.length) return { available: true, games: [], note: null };

  const games = [];
  for (const game of installed) {
    if (!game.installDir) continue;
    // The manifest sits two levels above common/<installdir>.
    const manifest = path.join(path.dirname(path.dirname(game.installDir)), `appmanifest_${game.appId}.acf`);
    try {
      const state = parseSteamState(await fsp.readFile(manifest, 'utf8'));
      if (!state.updateRequired && !state.updateRunning) continue;
      games.push({
        appId: game.appId,
        name: game.name,
        running: state.updateRunning,
        remainingBytes: state.remainingBytes
      });
    } catch (_) { /* an unreadable manifest says nothing either way */ }
  }

  return { available: true, games, note: null };
}

/* -------------------------------------------------------------------- Epic */

async function epicGames() {
  if (!IS_WIN) return { available: false, games: [], note: 'Nur unter Windows.' };
  try {
    const games = await scanner.scanEpic();
    return { available: true, games: games.map((g) => ({ name: g.name, id: g.id })), note: null };
  } catch (err) {
    return { available: false, games: [], note: err.message };
  }
}

/* ---------------------------------------------------------------- overview */

async function scan() {
  const [winget, steam, epic] = await Promise.all([
    wingetUpgrades(),
    steamUpdates(),
    epicGames()
  ]);

  return {
    ts: Date.now(),
    winget,
    steam,
    epic,
    // Only the winget figure is a promise the hub can keep by itself.
    actionable: winget.packages.length
  };
}

/* --------------------------------------------------------------- upgrading */

let running = null;
let emit = () => {};

function setEmitter(fn) {
  emit = typeof fn === 'function' ? fn : () => {};
}

function state() {
  return running
    ? { running: true, target: running.target, startedAt: running.startedAt, lines: running.lines.slice(-200) }
    : { running: false, lines: [] };
}

/**
 * Runs winget directly rather than through the shared PowerShell host.
 *
 * The one deliberate exception to "everything goes through pshost". An upgrade
 * takes minutes and there is exactly one pipe: routing it through the host
 * would block the process list, the metrics and every other system query for
 * the whole download. It also needs its output line by line while it runs,
 * which a request-and-response host cannot give.
 */
function runUpgrade({ id = null } = {}) {
  if (!IS_WIN) throw new Error('winget gibt es nur unter Windows');
  if (running) throw new Error('Es läuft bereits eine Aktualisierung');

  const args = id
    ? ['upgrade', '--id', id, '--exact', '--silent']
    : ['upgrade', '--all', '--silent'];
  args.push('--include-unknown', '--accept-source-agreements',
    '--accept-package-agreements', '--disable-interactivity');

  const child = spawn('winget.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  running = { target: id, startedAt: Date.now(), lines: [], child };

  const push = (text, stream) => {
    for (const line of cleanOutput(text).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !running) continue;
      running.lines.push(trimmed);
      if (running.lines.length > 800) running.lines.shift();
      emit({ kind: 'line', text: trimmed, stream });
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => push(chunk, 'out'));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => push(chunk, 'err'));

  child.on('error', (err) => {
    log.error(`winget konnte nicht gestartet werden: ${err.message}`);
    running = null;
    emit({ kind: 'done', ok: false, error: err.message });
  });

  child.on('close', (code) => {
    const ms = running ? Date.now() - running.startedAt : 0;
    log.info(`Aktualisierung beendet (Code ${code}, ${Math.round(ms / 1000)} s)`);
    running = null;
    // winget returns non-zero for "nothing to do" as well as for real
    // failures, so the code alone is not a verdict worth repeating to a user.
    emit({ kind: 'done', ok: code === 0, code, ms });
  });

  return { started: true, target: id };
}

function cancelUpgrade() {
  if (!running) return { running: false };
  try { running.child.kill(); } catch (_) { /* already gone */ }
  return { running: false, cancelled: true };
}

/* ----------------------------------------------------------------- actions */

const TARGETS = {
  steam: 'steam://open/games',
  'steam-downloads': 'steam://open/downloads',
  epic: 'com.epicgames.launcher://apps',
  'windows-update': 'ms-settings:windowsupdate',
  store: 'ms-windows-store://downloadsandupdates'
};

/** Hands over to whatever owns the download. */
async function openExternal(what, id) {
  if (what === 'steam-validate') {
    if (!/^\d+$/.test(String(id || ''))) throw new Error('Ungültige Spiel-Kennung');
    await shell.openExternal(`steam://validate/${id}`);
    return { ok: true };
  }
  const target = TARGETS[what];
  if (!target) throw new Error(`Unbekanntes Ziel: ${what}`);
  await shell.openExternal(target);
  return { ok: true };
}

module.exports = {
  scan,
  wingetUpgrades,
  steamUpdates,
  epicGames,
  runUpgrade,
  cancelUpgrade,
  openExternal,
  setEmitter,
  state,
  // Exported for the tests: the parsers are where this breaks silently.
  parseWingetTable,
  parseUpgrades,
  parseSteamState,
  cleanOutput,
  WINGET_LIST_SCRIPT
};
