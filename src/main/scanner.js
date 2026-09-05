'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app, shell } = require('electron');
const { runPowerShell } = require('./processes');

/**
 * Discovers what is actually installed so building a profile is picking from a
 * list instead of typing paths by hand.
 *
 * Sources, in order of usefulness:
 *   1. Steam library manifests  -> real games with a stable steam:// launch URI
 *   2. Epic Games manifests     -> same for the Epic launcher
 *   3. Start Menu .lnk files    -> exact target paths, good icons
 *   4. Get-StartApps            -> catch-all incl. UWP / Xbox Game Pass titles
 */

const IS_WIN = process.platform === 'win32';

function uniqueBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch (_) { return false; }
}

/* ------------------------------------------------------------------ Steam */

function parseVdfPaths(text) {
  // libraryfolders.vdf: grab every "path" value regardless of schema version.
  const out = [];
  const re = /"path"\s*"([^"]+)"/gi;
  let m;
  while ((m = re.exec(text))) out.push(m[1].replace(/\\\\/g, '\\'));
  return out;
}

function parseAcf(text) {
  const get = (key) => {
    const m = new RegExp(`"${key}"\\s*"([^"]*)"`, 'i').exec(text);
    return m ? m[1] : null;
  };
  return {
    appid: get('appid'),
    name: get('name'),
    installdir: get('installdir'),
    sizeOnDisk: Number(get('SizeOnDisk')) || 0,
    lastPlayed: Number(get('LastPlayed')) || 0
  };
}

async function steamRoot() {
  const candidates = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Steam'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Steam'),
    'C:\\Steam',
    'D:\\Steam'
  ].filter(Boolean);

  if (IS_WIN) {
    try {
      const out = await runPowerShell(String.raw`
$ErrorActionPreference = "SilentlyContinue"
(Get-ItemProperty -Path "HKCU:\Software\Valve\Steam" -Name SteamPath).SteamPath
`);
      const p = (out || '').trim();
      if (p) candidates.unshift(p.replace(/\//g, '\\'));
    } catch (_) { /* registry unavailable, fall back to defaults */ }
  }

  for (const c of candidates) {
    if (await exists(path.join(c, 'steamapps'))) return c;
  }
  return null;
}

async function scanSteam() {
  const root = await steamRoot();
  if (!root) return [];

  const libraries = new Set([root]);
  const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
  if (await exists(vdf)) {
    try {
      const text = await fsp.readFile(vdf, 'utf8');
      for (const p of parseVdfPaths(text)) libraries.add(p);
    } catch (_) { /* unreadable library index */ }
  }

  const games = [];
  for (const lib of libraries) {
    const appsDir = path.join(lib, 'steamapps');
    let entries = [];
    try { entries = await fsp.readdir(appsDir); } catch (_) { continue; }
    for (const entry of entries) {
      if (!/^appmanifest_\d+\.acf$/i.test(entry)) continue;
      try {
        const text = await fsp.readFile(path.join(appsDir, entry), 'utf8');
        const meta = parseAcf(text);
        if (!meta.appid || !meta.name) continue;
        if (/^(Steamworks Common Redistributables|Proton|Steam Linux Runtime)/i.test(meta.name)) continue;
        games.push({
          id: `steam:${meta.appid}`,
          name: meta.name,
          source: 'steam',
          kind: 'game',
          launch: { type: 'uri', target: `steam://rungameid/${meta.appid}` },
          appId: meta.appid,
          installDir: meta.installdir ? path.join(appsDir, 'common', meta.installdir) : null,
          sizeOnDisk: meta.sizeOnDisk,
          lastPlayed: meta.lastPlayed
        });
      } catch (_) { /* skip malformed manifest */ }
    }
  }
  return games;
}

/* ------------------------------------------------------------------- Epic */

async function scanEpic() {
  const base = process.env.ProgramData
    ? path.join(process.env.ProgramData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
    : null;
  if (!base || !(await exists(base))) return [];

  let files = [];
  try { files = await fsp.readdir(base); } catch (_) { return []; }

  const out = [];
  for (const file of files) {
    if (!file.endsWith('.item')) continue;
    try {
      const data = JSON.parse(await fsp.readFile(path.join(base, file), 'utf8'));
      if (!data.DisplayName || !data.AppName) continue;
      out.push({
        id: `epic:${data.AppName}`,
        name: data.DisplayName,
        source: 'epic',
        kind: 'game',
        launch: {
          type: 'uri',
          target: `com.epicgames.launcher://apps/${data.NamespaceId || ''}%3A${data.CatalogItemId || ''}%3A${data.AppName}?action=launch&silent=true`
        },
        installDir: data.InstallLocation || null,
        exe: data.InstallLocation && data.LaunchExecutable
          ? path.join(data.InstallLocation, data.LaunchExecutable)
          : null
      });
    } catch (_) { /* skip malformed manifest */ }
  }
  return out;
}

/* -------------------------------------------------------------- Start Menu */

async function walk(dir, depth = 0, acc = []) {
  if (depth > 4) return acc;
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, depth + 1, acc);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk')) acc.push(full);
  }
  return acc;
}

const SHORTCUT_NOISE = /(uninstall|deinstall|readme|help|documentation|website|homepage|manual|support|license|changelog|report a bug|repair|modify)/i;

async function scanStartMenu() {
  if (!IS_WIN) return [];
  const roots = [
    process.env.ProgramData && path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ].filter(Boolean);

  const links = [];
  for (const root of roots) {
    if (await exists(root)) await walk(root, 0, links);
  }

  const out = [];
  for (const link of links) {
    const base = path.basename(link, '.lnk');
    if (SHORTCUT_NOISE.test(base)) continue;
    let info = null;
    try { info = shell.readShortcutLink(link); } catch (_) { continue; }
    if (!info || !info.target) continue;
    const target = info.target;
    if (!/\.(exe|bat|cmd)$/i.test(target)) continue;
    if (/\\windows\\(system32|syswow64)\\/i.test(target) && !/\\(mstsc|notepad|calc|control|taskmgr|cmd)\.exe$/i.test(target)) continue;
    out.push({
      id: `lnk:${target.toLowerCase()}`,
      name: base,
      source: 'startmenu',
      kind: 'app',
      launch: { type: 'exe', target, args: info.args ? info.args.split(' ').filter(Boolean) : [], cwd: info.workingDirectory || null },
      exe: target,
      icon: info.icon || target
    });
  }
  return out;
}

/* ------------------------------------------------------------- Get-StartApps */

async function scanStartApps() {
  if (!IS_WIN) return [];
  try {
    const out = await runPowerShell(`
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
@(Get-StartApps) | ConvertTo-Json -Compress
`);
    const trimmed = (out || '').trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((x) => x && x.Name && x.AppID)
      .filter((x) => !SHORTCUT_NOISE.test(x.Name))
      .map((x) => ({
        id: `startapp:${String(x.AppID).toLowerCase()}`,
        name: x.Name,
        source: 'startapps',
        kind: /\.exe$/i.test(x.AppID) ? 'app' : 'uwp',
        launch: { type: 'appsfolder', target: x.AppID },
        appId: x.AppID
      }));
  } catch (_) {
    return [];
  }
}

/* ------------------------------------------------------------------ Public */

let cache = null;
let cacheAt = 0;
let scanning = null;

async function scan({ force = false } = {}) {
  if (!force && cache && Date.now() - cacheAt < 5 * 60 * 1000) return cache;
  if (scanning) return scanning;

  scanning = (async () => {
    const [steamGames, epicGames, shortcuts, startApps] = await Promise.all([
      scanSteam().catch(() => []),
      scanEpic().catch(() => []),
      scanStartMenu().catch(() => []),
      scanStartApps().catch(() => [])
    ]);

    // Prefer entries with a real launch path; StartApps only fills gaps.
    const knownNames = new Set(
      [...steamGames, ...epicGames, ...shortcuts].map((x) => x.name.toLowerCase())
    );
    const extras = startApps.filter((x) => !knownNames.has(x.name.toLowerCase()));

    const all = uniqueBy(
      [...steamGames, ...epicGames, ...shortcuts, ...extras],
      (x) => x.id
    ).sort((a, b) => a.name.localeCompare(b.name));

    cache = { ts: Date.now(), count: all.length, items: all };
    cacheAt = Date.now();
    return cache;
  })();

  try { return await scanning; } finally { scanning = null; }
}

const iconCache = new Map();

async function getIcon(target) {
  if (!target) return null;
  const key = target.toLowerCase();
  if (iconCache.has(key)) return iconCache.get(key);
  try {
    const image = await app.getFileIcon(target, { size: 'large' });
    const dataUrl = image && !image.isEmpty() ? image.toDataURL() : null;
    iconCache.set(key, dataUrl);
    return dataUrl;
  } catch (_) {
    iconCache.set(key, null);
    return null;
  }
}

module.exports = { scan, getIcon, scanSteam, scanEpic, scanStartMenu, scanStartApps };
