'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app } = require('electron');
const { runPowerShell } = require('./processes');
const logger = require('./logger');

const log = logger.scoped('windowlayout');

/**
 * Where a profile's programs end up on screen.
 *
 * The hub starts Discord, Spotify and a game, and Windows scatters them
 * wherever it likes -- which on a two-monitor desk is the one thing that has
 * to be redone by hand after every single launch. A profile can remember
 * where its windows belong and put them back.
 *
 * Three honest limits, all of them visible in the interface rather than
 * discovered later:
 *
 *   1. A window is matched by process name, so a program with several windows
 *      gets its largest one moved. For Discord or Spotify that is the right
 *      one; for a browser with two windows open it is a guess.
 *   2. Windows do not exist at the moment a program is started. This waits for
 *      them to appear, and gives up after a deadline rather than hanging.
 *   3. Positions are physical pixels on the monitor arrangement they were
 *      recorded on. Plug a different monitor in and a remembered position can
 *      land nowhere; those entries are skipped rather than dropped off screen.
 */

const IS_WIN = process.platform === 'win32';
const CS_SOURCE = path.join(__dirname, 'ps', 'windows.cs.txt');

// Long enough for a launcher to hand over to a game, short enough that a
// program which never opens a window does not hold the rest up.
const WAIT_MS = 25000;
const POLL_MS = 700;
const MAX_ENTRIES = 20;

let helperPaths = null;
let compiling = null;

/** The C# lives inside the packaged asar, which PowerShell cannot read. */
async function ensureHelper() {
  if (helperPaths) return helperPaths;

  const dir = path.join(app.getPath('userData'), 'native');
  await fsp.mkdir(dir, { recursive: true });

  const source = await fsp.readFile(CS_SOURCE, 'utf8');
  const csPath = path.join(dir, 'HubWindows.cs');
  const dllPath = path.join(dir, 'HubWindows.dll');

  let existing = null;
  try { existing = await fsp.readFile(csPath, 'utf8'); } catch (_) { /* first run */ }

  if (existing !== source) {
    await fsp.writeFile(csPath, source, 'utf8');
    // A stale assembly would keep serving the previous version of the code.
    try { await fsp.unlink(dllPath); } catch (_) { /* nothing to remove */ }
  }

  helperPaths = { csPath, dllPath };
  return helperPaths;
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function preamble({ csPath, dllPath }) {
  return `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not ('HubWindows' -as [type])) {
  if (Test-Path -LiteralPath ${psLiteral(dllPath)}) {
    try { Add-Type -Path ${psLiteral(dllPath)} } catch { }
  }
}
if (-not ('HubWindows' -as [type])) {
  $src = Get-Content -Raw -LiteralPath ${psLiteral(csPath)}
  try {
    Add-Type -TypeDefinition $src -OutputAssembly ${psLiteral(dllPath)}
    Add-Type -Path ${psLiteral(dllPath)}
  } catch {
    Add-Type -TypeDefinition $src
  }
}
`;
}

/**
 * Compiles the helper once, at startup, with a compiler-sized budget.
 *
 * Same reasoning as the display and audio helpers: `Add-Type` runs the real
 * C# compiler, which on a cold machine is tens of seconds, and everything
 * else queues behind it on the one shell the hub has.
 */
async function ensureCompiled() {
  if (!IS_WIN) return { ok: false, reason: 'Nur unter Windows verfügbar' };
  if (compiling) return compiling;

  compiling = (async () => {
    const paths = await ensureHelper();
    if (fs.existsSync(paths.dllPath)) return { ok: true, cached: true };
    const started = Date.now();
    try {
      await runPowerShell(`${preamble(paths)}
if ('HubWindows' -as [type]) { 'ok' } else { throw 'Fenster-Hilfsklasse konnte nicht geladen werden' }
`, 180000);
      return { ok: true, ms: Date.now() - started };
    } catch (err) {
      return { ok: false, reason: err.message, ms: Date.now() - started };
    }
  })();

  const result = await compiling;
  compiling = Promise.resolve(result);
  return result;
}

/* ------------------------------------------------------------------- pure */
/*
 * Everything down to the next marker is free of PowerShell, of Electron and
 * of the clock, so `test/windowlayout.test.js` can exercise the decisions
 * that actually go wrong: which window of several gets moved, and whether a
 * remembered position still lands on a screen.
 */

/** How a process is compared: lower case, no path, no extension. */
function processKey(name) {
  const base = String(name || '').trim().split(/[\\/]/).pop();
  return base.replace(/\.exe$/i, '').toLowerCase();
}

/**
 * One remembered position, or null.
 *
 * A zero-sized or negative rectangle is refused rather than stored: putting a
 * window back at zero width is indistinguishable from losing it.
 */
function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const process = processKey(raw.process);
  if (!process) return null;

  const x = Math.round(Number(raw.x));
  const y = Math.round(Number(raw.y));
  const width = Math.round(Number(raw.width));
  const height = Math.round(Number(raw.height));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < 80 || height < 60) return null;

  return { process, x, y, width, height, maximized: !!raw.maximized };
}

/** The stored layout: one entry per process, bounded, in the order given. */
function sanitizeLayout(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const entries = [];
  for (const item of raw) {
    const entry = sanitizeEntry(item);
    if (!entry || seen.has(entry.process)) continue;
    seen.add(entry.process);
    entries.push(entry);
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

/**
 * Which window to move when a process owns several.
 *
 * The largest one, which is the main window in every case worth having an
 * opinion about -- a chat client's main window against its own settings
 * dialog, a game against its launcher. Ties keep the order Windows gave,
 * so the same machine answers the same way twice.
 */
function pickWindow(windows, process) {
  const key = processKey(process);
  if (!key) return null;

  let best = null;
  let bestArea = -1;
  for (const win of windows || []) {
    if (!win || processKey(win.process) !== key) continue;
    const area = (Number(win.width) || 0) * (Number(win.height) || 0);
    if (area > bestArea) { best = win; bestArea = area; }
  }
  return best;
}

/**
 * Whether a remembered rectangle still lands on a screen.
 *
 * Deliberately generous: a window counts as placeable when a decent corner of
 * it would be visible, not when it fits entirely. Someone who likes a window
 * hanging off the right edge should keep it there. What this refuses is the
 * position on a monitor that is no longer plugged in, where the window would
 * vanish somewhere nobody can reach it.
 */
function fitsAnyMonitor(entry, monitors) {
  if (!entry) return false;
  const MARGIN = 48;
  return (monitors || []).some((monitor) => {
    if (!monitor) return false;
    const mx = Number(monitor.x) || 0;
    const my = Number(monitor.y) || 0;
    const mw = Number(monitor.width) || 0;
    const mh = Number(monitor.height) || 0;
    if (mw <= 0 || mh <= 0) return false;
    return entry.x + entry.width > mx + MARGIN
      && entry.x < mx + mw - MARGIN
      && entry.y + entry.height > my + MARGIN
      && entry.y < my + mh - MARGIN;
  });
}

/** What a snapshot of the given processes looks like, from a window listing. */
function snapshotFrom(windows, processes) {
  const wanted = [...new Set((processes || []).map(processKey).filter(Boolean))];
  const entries = [];
  for (const process of wanted) {
    const win = pickWindow(windows, process);
    if (!win) continue;
    const entry = sanitizeEntry({
      process,
      x: win.x,
      y: win.y,
      width: win.width,
      height: win.height,
      maximized: win.maximized
    });
    if (entry) entries.push(entry);
  }
  return entries;
}

/* --------------------------------------------------------------- end pure */

function parseJson(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch (_) { return null; }
}

const asArray = (value) => (value === null || value === undefined ? [] : (Array.isArray(value) ? value : [value]));

/* -------------------------------------------------------------- the system */

/** Every window a person would call a window, with where it sits. */
async function list() {
  if (!IS_WIN) return [];
  const ready = await ensureCompiled();
  if (!ready.ok) return [];

  try {
    const paths = await ensureHelper();
    const out = await runPowerShell(`${preamble(paths)}
[HubWindows]::List() | ConvertTo-Json -Compress -Depth 3
`, 20000);
    return asArray(parseJson(out))
      .filter((w) => w && w.Handle)
      .map((w) => ({
        handle: Number(w.Handle),
        pid: Number(w.ProcessId) || 0,
        process: String(w.Process || ''),
        title: String(w.Title || ''),
        x: Number(w.X) || 0,
        y: Number(w.Y) || 0,
        width: Number(w.Width) || 0,
        height: Number(w.Height) || 0,
        maximized: !!w.Maximized
      }));
  } catch (err) {
    log.debug(`Fensterliste nicht lesbar: ${err.message}`);
    return [];
  }
}

async function monitors() {
  if (!IS_WIN) return [];
  const ready = await ensureCompiled();
  if (!ready.ok) return [];

  try {
    const paths = await ensureHelper();
    const out = await runPowerShell(`${preamble(paths)}
[HubWindows]::Monitors() | ConvertTo-Json -Compress -Depth 2
`, 15000);
    return asArray(parseJson(out))
      .filter(Boolean)
      .map((m) => ({
        x: Number(m.X) || 0,
        y: Number(m.Y) || 0,
        width: Number(m.Width) || 0,
        height: Number(m.Height) || 0,
        primary: !!m.Primary
      }));
  } catch (err) {
    log.debug(`Monitorliste nicht lesbar: ${err.message}`);
    return [];
  }
}

async function move(handle, entry) {
  const paths = await ensureHelper();

  // Every value is pulled out and named before it reaches the template. Two
  // reasons, and the second one is the one that bites: gluing a `$` onto an
  // interpolation to make `$true` reads as a typo, and `test/powershell.test.js`
  // guesses the type of every `${...}` from its text -- anything mentioning an
  // entry, a path or a name is substituted as a string. `$${entry.maximized}`
  // therefore became `$'PLACEHOLDER'`, which is not PowerShell, and the parser
  // said so on both runners.
  const target = Math.trunc(handle);
  const left = Math.trunc(entry.x);
  const top = Math.trunc(entry.y);
  const wide = Math.trunc(entry.width);
  const high = Math.trunc(entry.height);
  const maximized = entry.maximized ? '$true' : '$false';

  const out = await runPowerShell(`${preamble(paths)}
[HubWindows]::Move(${target}, ${left}, ${top}, ${wide}, ${high}, ${maximized})
`, 15000);
  return /true/i.test((out || '').trim());
}

/** What the profile editor stores: where the given processes sit right now. */
async function snapshot(processes) {
  if (!IS_WIN) throw new Error('Fensterpositionen gibt es nur unter Windows');
  const windows = await list();
  return snapshotFrom(windows, processes);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Puts a profile's windows back.
 *
 * Polls rather than sleeps: the thing being waited for is "a window for this
 * process exists", and Win32 offers no event for that without installing a
 * hook into other processes, which is a far bigger promise than this feature
 * is worth. Every entry is checked on each pass, so one program that never
 * opens a window costs the others nothing but the wait they were going to
 * spend anyway.
 */
async function apply(layout, { timeoutMs = WAIT_MS, intervalMs = POLL_MS } = {}) {
  const entries = sanitizeLayout(layout);
  if (!entries.length) return { applied: [], skipped: [], missing: [] };
  if (!IS_WIN) return { applied: [], skipped: [], missing: entries.map((e) => e.process) };

  const screens = await monitors();
  const pending = new Map(entries.map((entry) => [entry.process, entry]));
  const applied = [];
  const skipped = [];
  const deadline = Date.now() + timeoutMs;

  while (pending.size && Date.now() < deadline) {
    const windows = await list();

    for (const [key, entry] of Array.from(pending)) {
      const win = pickWindow(windows, key);
      if (!win) continue;
      pending.delete(key);

      // Checked against the monitors as Win32 sees them, in the same pixels
      // the position was recorded in.
      if (screens.length && !fitsAnyMonitor(entry, screens)) {
        skipped.push({ process: key, reason: 'Die gemerkte Position liegt auf keinem angeschlossenen Bildschirm' });
        continue;
      }

      try {
        const ok = await move(win.handle, entry);
        if (ok) applied.push(key);
        else skipped.push({ process: key, reason: 'Das Fenster liess sich nicht verschieben' });
      } catch (err) {
        skipped.push({ process: key, reason: err.message });
      }
    }

    if (pending.size && Date.now() < deadline) await wait(intervalMs);
  }

  const missing = Array.from(pending.keys());
  if (applied.length || skipped.length || missing.length) {
    log.info(`Fensterlayout: ${applied.length} gesetzt, ${skipped.length} übersprungen, ${missing.length} ohne Fenster`);
  }
  return { applied, skipped, missing };
}

module.exports = {
  list,
  monitors,
  snapshot,
  apply,
  ensureCompiled,
  // Pure, and the part worth testing.
  processKey,
  sanitizeEntry,
  sanitizeLayout,
  pickWindow,
  fitsAnyMonitor,
  snapshotFrom,
  WAIT_MS,
  MAX_ENTRIES
};
