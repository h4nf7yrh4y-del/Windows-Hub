'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { app, shell } = require('electron');
const { runPowerShell } = require('./processes');

/**
 * File-manager backend.
 *
 * Deletes go to the recycle bin by default and refuse to touch drive roots or
 * system directories outright. Directory listings are capped and stat calls
 * run through a small concurrency pool, because a folder with 80k entries
 * should slow the view down, not wedge the main process.
 */

const IS_WIN = process.platform === 'win32';
const MAX_ENTRIES = 8000;
const STAT_CONCURRENCY = 48;

/* ------------------------------------------------------------------ guards */

const SYSTEM_DIRS = [
  process.env.SystemRoot,
  process.env.ProgramFiles,
  process.env['ProgramFiles(x86)'],
  process.env.ProgramData
].filter(Boolean).map((p) => path.resolve(p).toLowerCase());

function isDriveRoot(target) {
  const resolved = path.resolve(target);
  return path.dirname(resolved) === resolved;
}

/** Refuses operations that would be catastrophic and are never intended. */
function assertMutable(target, action = 'ändern') {
  const resolved = path.resolve(target);
  const lower = resolved.toLowerCase();

  if (isDriveRoot(resolved)) {
    throw new Error(`Laufwerkswurzel lässt sich nicht ${action}: ${resolved}`);
  }
  for (const dir of SYSTEM_DIRS) {
    if (lower === dir) throw new Error(`Systemverzeichnis lässt sich nicht ${action}: ${resolved}`);
  }
  if (lower === path.resolve(os.homedir()).toLowerCase()) {
    throw new Error('Das Benutzerverzeichnis selbst lässt sich nicht ändern.');
  }
  return resolved;
}

function requirePath(target, label = 'Pfad') {
  if (typeof target !== 'string' || !target.trim()) throw new Error(`${label} fehlt`);
  return path.resolve(target.trim());
}

/* ----------------------------------------------------------------- helpers */

async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

function classify(name, isDir) {
  if (isDir) return 'folder';
  const ext = path.extname(name).toLowerCase();
  if (['.exe', '.msi', '.bat', '.cmd', '.lnk', '.ps1'].includes(ext)) return 'app';
  if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico'].includes(ext)) return 'image';
  if (['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv'].includes(ext)) return 'video';
  if (['.mp3', '.flac', '.wav', '.ogg', '.m4a'].includes(ext)) return 'audio';
  if (['.zip', '.rar', '.7z', '.tar', '.gz', '.iso'].includes(ext)) return 'archive';
  if (['.txt', '.md', '.log', '.json', '.xml', '.yml', '.yaml', '.ini', '.cfg'].includes(ext)) return 'text';
  if (['.js', '.ts', '.py', '.cs', '.cpp', '.c', '.h', '.java', '.rs', '.go', '.html', '.css'].includes(ext)) return 'code';
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(ext)) return 'document';
  return 'file';
}

/* ------------------------------------------------------------------ drives */

async function drives() {
  if (!IS_WIN) {
    return [{ path: '/', label: 'Root', type: 'fixed', size: 0, free: 0 }];
  }
  try {
    const out = await runPowerShell(`
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

@(Get-CimInstance -ClassName Win32_LogicalDisk |
  Select-Object DeviceID, VolumeName, DriveType, Size, FreeSpace) | ConvertTo-Json -Compress
`);
    const trimmed = (out || '').trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const TYPES = { 2: 'removable', 3: 'fixed', 4: 'network', 5: 'optical' };
    return list.map((d) => ({
      path: `${d.DeviceID}\\`,
      label: d.VolumeName || TYPES[d.DriveType] || 'Laufwerk',
      letter: d.DeviceID,
      type: TYPES[d.DriveType] || 'unknown',
      size: Number(d.Size) || 0,
      free: Number(d.FreeSpace) || 0
    }));
  } catch (err) {
    return [];
  }
}

function quickLocations() {
  const names = [
    ['home', 'Benutzer'],
    ['desktop', 'Desktop'],
    ['downloads', 'Downloads'],
    ['documents', 'Dokumente'],
    ['pictures', 'Bilder'],
    ['music', 'Musik'],
    ['videos', 'Videos']
  ];
  const out = [];
  for (const [key, label] of names) {
    try {
      const target = app.getPath(key);
      if (target && fs.existsSync(target)) out.push({ label, path: target, key });
    } catch (_) { /* not every path exists on every system */ }
  }
  return out;
}

/* ----------------------------------------------------------------- listing */

async function list(target) {
  const dir = requirePath(target, 'Verzeichnis');
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') throw new Error(`Kein Zugriff auf ${dir}`);
    if (err.code === 'ENOENT') throw new Error(`Nicht gefunden: ${dir}`);
    if (err.code === 'ENOTDIR') throw new Error(`Kein Verzeichnis: ${dir}`);
    throw err;
  }

  const truncated = dirents.length > MAX_ENTRIES;
  const slice = truncated ? dirents.slice(0, MAX_ENTRIES) : dirents;

  const entries = await mapPool(slice, STAT_CONCURRENCY, async (dirent) => {
    const full = path.join(dir, dirent.name);
    let stats = null;
    try {
      stats = await fsp.lstat(full);
    } catch (_) { /* vanished or locked between readdir and lstat */ }

    const isLink = dirent.isSymbolicLink();
    let isDir = dirent.isDirectory();
    if (isLink) {
      try { isDir = (await fsp.stat(full)).isDirectory(); } catch (_) { isDir = false; }
    }

    return {
      name: dirent.name,
      path: full,
      isDir,
      isLink,
      kind: classify(dirent.name, isDir),
      ext: isDir ? '' : path.extname(dirent.name).replace('.', '').toLowerCase(),
      size: stats && !isDir ? stats.size : 0,
      modified: stats ? stats.mtimeMs : 0,
      created: stats ? stats.birthtimeMs : 0,
      hidden: dirent.name.startsWith('.') || !!(stats && (stats.mode & 0o200) === 0 && IS_WIN)
    };
  });

  const parent = isDriveRoot(dir) ? null : path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    truncated,
    total: dirents.length,
    entries
  };
}

/** Recursive name search, bounded by depth, time and result count. */
async function search(root, query, { maxResults = 400, maxDepth = 6, timeoutMs = 12000 } = {}) {
  const base = requirePath(root, 'Startverzeichnis');
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) throw new Error('Suchbegriff fehlt');

  const deadline = Date.now() + timeoutMs;
  const results = [];
  const queue = [{ dir: base, depth: 0 }];

  while (queue.length && results.length < maxResults && Date.now() < deadline) {
    const { dir, depth } = queue.shift();
    let dirents = [];
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }

    for (const dirent of dirents) {
      if (results.length >= maxResults) break;
      const full = path.join(dir, dirent.name);
      if (dirent.name.toLowerCase().includes(needle)) {
        let stats = null;
        try { stats = await fsp.lstat(full); } catch (_) { /* ignore */ }
        results.push({
          name: dirent.name,
          path: full,
          isDir: dirent.isDirectory(),
          kind: classify(dirent.name, dirent.isDirectory()),
          ext: dirent.isDirectory() ? '' : path.extname(dirent.name).replace('.', '').toLowerCase(),
          size: stats && !dirent.isDirectory() ? stats.size : 0,
          modified: stats ? stats.mtimeMs : 0
        });
      }
      if (dirent.isDirectory() && depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
    }
  }

  return {
    query: needle,
    root: base,
    results,
    truncated: results.length >= maxResults,
    timedOut: Date.now() >= deadline
  };
}

/* --------------------------------------------------------------- mutations */

async function createFolder(parent, name) {
  const dir = requirePath(parent, 'Zielverzeichnis');
  const clean = String(name || '').trim();
  if (!clean || /[\\/:*?"<>|]/.test(clean)) throw new Error('Ungültiger Ordnername');
  const target = path.join(dir, clean);
  await fsp.mkdir(target);
  return { path: target };
}

async function rename(target, name) {
  const source = assertMutable(requirePath(target, 'Quelle'), 'umbenennen');
  const clean = String(name || '').trim();
  if (!clean || /[\\/:*?"<>|]/.test(clean)) throw new Error('Ungültiger Name');
  const destination = path.join(path.dirname(source), clean);
  if (fs.existsSync(destination)) throw new Error(`Existiert bereits: ${clean}`);
  await fsp.rename(source, destination);
  return { path: destination };
}

/** Moves to the recycle bin. Permanent deletion is deliberately not exposed. */
async function trash(targets) {
  const list = [].concat(targets || []);
  if (!list.length) throw new Error('Nichts ausgewählt');
  const results = [];
  for (const item of list) {
    try {
      const resolved = assertMutable(requirePath(item, 'Ziel'), 'löschen');
      await shell.trashItem(resolved);
      results.push({ path: resolved, ok: true });
    } catch (err) {
      results.push({ path: item, ok: false, error: err.message });
    }
  }
  return { results, failed: results.filter((r) => !r.ok).length };
}

function uniqueDestination(dir, name) {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  for (let i = 2; i < 500; i += 1) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Kein freier Zielname gefunden');
}

async function transfer(sources, destination, mode) {
  const targetDir = requirePath(destination, 'Zielverzeichnis');
  const stats = await fsp.stat(targetDir);
  if (!stats.isDirectory()) throw new Error('Ziel ist kein Verzeichnis');

  const list = [].concat(sources || []);
  if (!list.length) throw new Error('Nichts ausgewählt');

  const results = [];
  for (const item of list) {
    try {
      const source = requirePath(item, 'Quelle');
      // Copying a folder into itself would recurse until the disk is full.
      const relative = path.relative(source, targetDir);
      if (relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))) {
        throw new Error('Ziel liegt innerhalb der Quelle');
      }
      const finalPath = uniqueDestination(targetDir, path.basename(source));
      if (mode === 'move') {
        assertMutable(source, 'verschieben');
        try {
          await fsp.rename(source, finalPath);
        } catch (err) {
          // rename fails across volumes; fall back to copy + delete.
          if (err.code !== 'EXDEV') throw err;
          await fsp.cp(source, finalPath, { recursive: true, force: false, errorOnExist: true });
          await fsp.rm(source, { recursive: true, force: true });
        }
      } else {
        await fsp.cp(source, finalPath, { recursive: true, force: false, errorOnExist: true });
      }
      results.push({ from: source, to: finalPath, ok: true });
    } catch (err) {
      results.push({ from: item, ok: false, error: err.message });
    }
  }
  return { results, failed: results.filter((r) => !r.ok).length };
}

/* ----------------------------------------------------------------- opening */

async function open(target) {
  const resolved = requirePath(target, 'Pfad');
  const error = await shell.openPath(resolved);
  if (error) throw new Error(error);
  return { ok: true };
}

async function reveal(target) {
  shell.showItemInFolder(requirePath(target, 'Pfad'));
  return { ok: true };
}

async function info(target) {
  const resolved = requirePath(target, 'Pfad');
  const stats = await fsp.lstat(resolved);
  return {
    path: resolved,
    name: path.basename(resolved),
    isDir: stats.isDirectory(),
    size: stats.size,
    modified: stats.mtimeMs,
    created: stats.birthtimeMs,
    accessed: stats.atimeMs,
    readOnly: (stats.mode & 0o200) === 0
  };
}

/** Recursive size of a folder, bounded so a huge tree cannot hang the UI. */
async function folderSize(target, { timeoutMs = 15000 } = {}) {
  const root = requirePath(target, 'Verzeichnis');
  const deadline = Date.now() + timeoutMs;
  let bytes = 0;
  let files = 0;
  let folders = 0;
  const queue = [root];

  while (queue.length && Date.now() < deadline) {
    const dir = queue.pop();
    let dirents = [];
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) { folders += 1; queue.push(full); continue; }
      try {
        const stats = await fsp.lstat(full);
        bytes += stats.size;
        files += 1;
      } catch (_) { /* skip unreadable entries */ }
    }
  }

  return { path: root, bytes, files, folders, complete: queue.length === 0 };
}

module.exports = {
  drives, quickLocations, list, search,
  createFolder, rename, trash, transfer,
  open, reveal, info, folderSize
};
