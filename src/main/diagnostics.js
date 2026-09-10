'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { app, dialog, shell } = require('electron');

const logger = require('./logger');
const store = require('./store');
const metrics = require('./metrics');
const gpu = require('./gpu');
const display = require('./display');

const log = logger.scoped('diagnostics');

/**
 * Builds one plain-text report that makes a bug report actionable.
 *
 * Everything a question about "it does not work on my machine" needs is in
 * here: versions, hardware, what the platform probes actually returned, the
 * shape of the configuration, and the tail of the log.
 *
 * Deliberately excluded: cover images, which are large base64 blobs, and the
 * file paths inside profiles beyond their basename. The report is meant to be
 * pasted into a chat or an issue, so it should not carry a user's directory
 * layout or a megabyte of artwork.
 */

function line(char = '-', width = 66) {
  return char.repeat(width);
}

function section(title) {
  return `\n${line('=')}\n${title}\n${line('=')}\n`;
}

function pairs(rows) {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${String(k).padEnd(width)}  ${v === null || v === undefined ? '—' : v}`).join('\n');
}

/**
 * Last path segment regardless of separator.
 *
 * `path.basename` only honours the separator of the host platform, so on a
 * non-Windows machine a Windows path would come through whole and the
 * redaction would silently leak the user's directory layout. The report has
 * to be safe no matter where it is produced.
 */
function baseName(value) {
  return String(value).split(/[\\/]/).filter(Boolean).pop() || String(value);
}

/**
 * Keeps the shape of a path but drops the person out of it.
 *
 * The installation and configuration directories are worth seeing in a bug
 * report — they say whether a build is portable or installed — but on Windows
 * both sit under C:\Users\<name>, so printing them raw puts the user's name
 * in a file meant to be handed to someone else.
 */
function redactPath(value) {
  if (value === null || value === undefined) return value;
  let out = String(value);
  const home = os.homedir();
  if (home && out.toLowerCase().startsWith(home.toLowerCase())) {
    out = `~${out.slice(home.length)}`;
  }
  return out
    .replace(/([A-Za-z]:\\Users\\)[^\\]+/gi, '$1<Benutzer>')
    .replace(/(\/(?:home|Users)\/)[^/]+/g, '$1<Benutzer>');
}

function bytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Strips anything bulky or needlessly personal from the stored config. */
function sanitizeConfig(state) {
  const settings = { ...(state.settings || {}) };
  const profiles = (state.profiles || []).map((p) => ({
    name: p.name,
    accent: p.accent,
    hasCover: !!p.cover,
    minimizeOnLaunch: p.minimizeOnLaunch,
    launchCount: p.launchCount || 0,
    apps: (p.apps || []).map((a) => ({
      name: a.name,
      type: a.launch ? a.launch.type : null,
      // Only the executable name, never the directory it sits in.
      target: a.launch && a.launch.target
        ? (a.launch.type === 'exe' ? baseName(a.launch.target) : a.launch.target)
        : null,
      delayMs: a.delayMs,
      enabled: a.enabled !== false,
      processName: a.processName || null
    }))
  }));

  return {
    settings,
    hotkeys: state.hotkeys || {},
    overlays: state.overlays || {},
    profileCount: profiles.length,
    profiles
  };
}

async function probe(name, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    return { name, ok: true, ms: Date.now() - started, value };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - started, error: err.message };
  }
}

async function build() {
  log.info('Diagnosebericht wird erstellt');
  const state = store.state;
  const parts = [];

  parts.push(`Windows Hub · Diagnosebericht`);
  parts.push(`Erstellt am ${new Date().toLocaleString('de-DE')}`);

  /* ------------------------------------------------------------- versions */
  parts.push(section('Programm'));
  let version = app.getVersion();
  try { version = require('../../package.json').version || version; } catch (_) { /* packaged */ }
  parts.push(pairs([
    ['Version', version],
    ['Electron', process.versions.electron],
    ['Chromium', process.versions.chrome],
    ['Node', process.versions.node],
    ['Paketiert', app.isPackaged ? 'ja' : 'nein (Entwicklungsmodus)'],
    ['Programmpfad', app.getAppPath()],
    ['Konfiguration', store.configPath()],
    ['Betriebszeit Hub', `${Math.round(process.uptime())} s`]
  ]));

  /* ------------------------------------------------------------- machine */
  parts.push(section('Rechner'));
  const cpu = os.cpus()[0] || {};
  parts.push(pairs([
    ['Plattform', `${process.platform} ${os.release()} (${process.arch})`],
    ['Rechnername', os.hostname()],
    ['CPU', cpu.model || 'unbekannt'],
    ['Kerne', os.cpus().length],
    ['RAM gesamt', bytes(os.totalmem())],
    ['RAM frei', bytes(os.freemem())],
    ['Betriebszeit System', `${Math.round(os.uptime() / 3600)} h`]
  ]));

  let staticInfo = null;
  try { staticInfo = await metrics.getStaticInfo(); } catch (_) { /* optional */ }
  if (staticInfo) {
    parts.push('');
    parts.push(pairs([
      ['System', staticInfo.distro || '—'],
      ['Build', staticInfo.build || '—'],
      ['CPU-Marke', staticInfo.cpuBrand || '—'],
      ['Physische Kerne', staticInfo.physicalCores || '—'],
      ['Mainboard', staticInfo.board || '—']
    ]));
  }

  /* -------------------------------------------------------------- probes */
  // The point of the report: which platform calls actually work here, how
  // long they took, and what they said when they failed.
  parts.push(section('Plattform-Abfragen'));
  const probes = await Promise.all([
    probe('GPU-Zähler', () => gpu.read()),
    probe('Bildschirme', () => display.list({ includeModes: false })),
    probe('Messwerte', async () => metrics.fastSample())
  ]);

  for (const result of probes) {
    parts.push(`\n  ${result.name}: ${result.ok ? 'OK' : 'FEHLER'} (${result.ms} ms)`);
    if (!result.ok) {
      parts.push(`    ${result.error}`);
      continue;
    }
    if (result.name === 'GPU-Zähler') {
      const value = result.value || {};
      parts.push(`    Quelle: ${value.source || '—'}${value.note ? ` · ${value.note}` : ''}`);
      for (const adapter of value.adapters || []) {
        parts.push(`    ${adapter.model || '?'} · Last ${adapter.load ?? '—'}%`
          + ` · VRAM ${adapter.memTotal ? bytes(adapter.memTotal) : '—'}`
          + ` · Temp ${adapter.temp ?? '—'} · Quelle ${adapter.loadSource || '—'}`);
      }
      if (!(value.adapters || []).length) parts.push('    Keine Adapter gemeldet');
    }
    if (result.name === 'Bildschirme') {
      const value = result.value || {};
      if (!value.supported) parts.push(`    ${value.note || 'nicht verfügbar'}`);
      for (const monitor of value.monitors || []) {
        parts.push(`    ${monitor.name} · ${monitor.width}x${monitor.height}@${monitor.refresh}`
          + ` · ${monitor.primary ? 'primär' : 'sekundär'}`
          + ` · Helligkeit ${monitor.brightness && monitor.brightness.supported ? `${monitor.brightness.value}% (${monitor.brightness.source})` : 'nicht steuerbar'}`);
      }
    }
    if (result.name === 'Messwerte') {
      const value = result.value || {};
      parts.push(`    CPU ${(value.cpu && value.cpu.total || 0).toFixed(1)}%`
        + ` · RAM ${(value.mem && value.mem.percent || 0).toFixed(1)}%`
        + ` · Laufwerke ${(value.slow && value.slow.disks || []).length}`
        + ` · Netz ${value.slow && value.slow.net ? value.slow.net.iface : '—'}`);
    }
  }

  /* ------------------------------------------------------- configuration */
  parts.push(section('Konfiguration'));
  parts.push('  Persönliche Pfade und Hintergrundbilder sind entfernt.');
  parts.push('');
  parts.push(JSON.stringify(sanitizeConfig(state), null, 2).split('\n').map((l) => `  ${l}`).join('\n'));

  /* ------------------------------------------------------------------ log */
  const logInfo = logger.paths();
  parts.push(section('Protokoll'));
  parts.push(pairs([
    ['Verzeichnis', logInfo.dir || '—'],
    ['Dateien', (logInfo.files || []).map((f) => `${f.name} (${bytes(f.size)})`).join(', ') || '—'],
    ['Schreiben deaktiviert', logInfo.disabled ? 'ja' : 'nein']
  ]));
  parts.push('');
  const tail = logger.tail(250);
  parts.push(tail.length ? tail.map((l) => `  ${l}`).join('\n') : '  (leer)');

  parts.push(`\n${line()}\nEnde des Berichts\n`);

  // A final pass over the whole text rather than trusting every call site to
  // remember. A user directory can arrive from anywhere — a library path, a
  // temporary directory, a stack trace in the log tail — and the one field
  // nobody thought about is exactly the one that ends up in a pasted report.
  return redactPath(parts.join('\n'));
}

/** Writes the report next to the logs and returns its path. */
async function save() {
  const report = await build();
  const dir = path.join(app.getPath('userData'), 'diagnostics');
  await fsp.mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `hub-diagnose-${stamp}.txt`);
  await fsp.writeFile(file, report, 'utf8');
  log.info(`Diagnosebericht gespeichert: ${file}`);
  return { path: file, bytes: Buffer.byteLength(report, 'utf8') };
}

/** Save-as dialog, so the file lands somewhere the user can find again. */
async function exportTo(win) {
  const report = await build();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const result = await dialog.showSaveDialog(win, {
    title: 'Diagnosebericht speichern',
    defaultPath: path.join(app.getPath('downloads'), `hub-diagnose-${stamp}.txt`),
    filters: [{ name: 'Textdatei', extensions: ['txt'] }]
  });

  if (result.canceled || !result.filePath) return { canceled: true };
  await fsp.writeFile(result.filePath, report, 'utf8');
  log.info(`Diagnosebericht exportiert: ${result.filePath}`);
  return { canceled: false, path: result.filePath, bytes: Buffer.byteLength(report, 'utf8') };
}

async function openLogFolder() {
  const info = logger.paths();
  if (!info.dir) throw new Error('Kein Protokollverzeichnis');
  if (info.file && fs.existsSync(info.file)) shell.showItemInFolder(info.file);
  else await shell.openPath(info.dir);
  return { ok: true };
}

module.exports = { build, save, exportTo, openLogFolder, sanitizeConfig };
