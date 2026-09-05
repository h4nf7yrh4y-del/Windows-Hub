'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { shell } = require('electron');
const { runPowerShell } = require('./processes');

/**
 * Autostart manager: everything Windows launches at sign-in.
 *
 * Reads the four Run keys plus both Startup folders. Entries can be removed,
 * never silently rewritten. Disabling is deliberately not offered: Windows
 * stores that state in the binary StartupApproved blobs, and getting it subtly
 * wrong leaves an entry that neither this hub nor Task Manager can restore.
 * Removing a Run value is reversible by reinstalling or re-adding it; a
 * corrupted approval blob is not.
 */

const IS_WIN = process.platform === 'win32';

const RUN_KEYS = [
  { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run',                scope: 'Benutzer' },
  { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',            scope: 'Benutzer (einmalig)' },
  { hive: 'HKLM', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run',                scope: 'System' },
  { hive: 'HKLM', key: 'Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run',   scope: 'System (32-Bit)' }
];

function psPath(entry) {
  return `${entry.hive}:\\${entry.key}`;
}

async function readRunKey(entry) {
  const script = `
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$k = Get-Item -LiteralPath '${psPath(entry)}'
if ($k) {
  @($k.GetValueNames() | ForEach-Object {
    [PSCustomObject]@{ name = $_; value = [string]$k.GetValue($_) }
  }) | ConvertTo-Json -Compress
}
`;

  try {
    const out = await runPowerShell(script);
    const trimmed = (out || '').trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((x) => x && x.name).map((x) => ({
      id: `reg:${entry.hive}:${entry.key}:${x.name}`,
      name: x.name,
      command: x.value || '',
      source: 'registry',
      hive: entry.hive,
      key: entry.key,
      scope: entry.scope,
      removable: true
    }));
  } catch (_) {
    return [];
  }
}

function startupFolders() {
  return [
    process.env.APPDATA
      && { dir: path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), scope: 'Benutzer (Ordner)' },
    process.env.ProgramData
      && { dir: path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'StartUp'), scope: 'System (Ordner)' }
  ].filter(Boolean);
}

async function readStartupFolder(entry) {
  let files = [];
  try { files = await fsp.readdir(entry.dir); } catch (_) { return []; }

  const out = [];
  for (const file of files) {
    if (file.toLowerCase() === 'desktop.ini') continue;
    const full = path.join(entry.dir, file);
    let target = full;
    if (file.toLowerCase().endsWith('.lnk')) {
      try {
        const link = shell.readShortcutLink(full);
        if (link && link.target) target = link.target;
      } catch (_) { /* unreadable shortcut, keep the file path */ }
    }
    out.push({
      id: `file:${full.toLowerCase()}`,
      name: path.basename(file, path.extname(file)),
      command: target,
      source: 'folder',
      file: full,
      scope: entry.scope,
      removable: true
    });
  }
  return out;
}

async function list() {
  if (!IS_WIN) return { entries: [], supported: false };

  const [registry, folders] = await Promise.all([
    Promise.all(RUN_KEYS.map(readRunKey)),
    Promise.all(startupFolders().map(readStartupFolder))
  ]);

  const entries = [].concat(...registry, ...folders)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { entries, supported: true, count: entries.length };
}

async function remove(id) {
  if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');
  if (typeof id !== 'string' || !id) throw new Error('Eintrag fehlt');

  const { entries } = await list();
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error('Eintrag nicht gefunden');

  if (entry.source === 'folder') {
    await shell.trashItem(entry.file);
    return { ok: true, name: entry.name, method: 'Papierkorb' };
  }

  // Doubling single quotes is the PowerShell escape inside a literal string.
  const safeName = entry.name.replace(/'/g, "''");
  await runPowerShell(`
$ErrorActionPreference = "Stop"
Remove-ItemProperty -LiteralPath '${psPath(entry)}' -Name '${safeName}' -Force
`);
  return { ok: true, name: entry.name, method: 'Registry' };
}

/** Extracts a launchable path out of a Run command line for "reveal". */
function extractPath(command) {
  if (!command) return null;
  const quoted = /^"([^"]+)"/.exec(command);
  if (quoted) return quoted[1];
  const bare = /^([^\s]+\.(?:exe|bat|cmd|com))/i.exec(command);
  return bare ? bare[1] : null;
}

async function reveal(id) {
  const { entries } = await list();
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error('Eintrag nicht gefunden');
  const target = entry.source === 'folder' ? entry.file : extractPath(entry.command);
  if (!target || !fs.existsSync(target)) throw new Error('Pfad nicht auffindbar');
  shell.showItemInFolder(target);
  return { ok: true };
}

module.exports = { list, remove, reveal, extractPath };
