'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app, shell } = require('electron');
const { runPowerShell } = require('./processes');

/**
 * Monitor control.
 *
 * Windows spreads this across three unrelated mechanisms, and each covers a
 * case the others do not:
 *   - WMI `WmiMonitorBrightness` handles the brightness of a laptop's built-in
 *     panel, and nothing else. External monitors are simply absent from it.
 *   - DDC/CI over `dxva2.dll` handles external monitors, when the monitor
 *     implements it. Many do; some do not, and there is no way to know but to
 *     ask.
 *   - `ChangeDisplaySettingsEx` handles resolution, refresh rate and which
 *     screen is primary.
 *
 * The last two are Win32 calls with no PowerShell equivalent, so a small C#
 * helper is compiled on first use and cached as a DLL: recompiling on every
 * call would add a second or two to something as interactive as a slider.
 */

const IS_WIN = process.platform === 'win32';
const CS_SOURCE = path.join(__dirname, 'ps', 'display.cs.txt');

let helperPaths = null;

/**
 * The C# lives inside the packaged asar, which PowerShell cannot read, so it
 * is written out once next to the compiled assembly.
 */
async function ensureHelper() {
  if (helperPaths) return helperPaths;

  const dir = path.join(app.getPath('userData'), 'native');
  await fsp.mkdir(dir, { recursive: true });

  const source = await fsp.readFile(CS_SOURCE, 'utf8');
  const csPath = path.join(dir, 'HubDisplay.cs');
  const dllPath = path.join(dir, 'HubDisplay.dll');

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

/**
 * Loads the helper, preferring the cached assembly. `-OutputAssembly` only
 * exists in Windows PowerShell, so a failure there falls back to compiling
 * in-memory rather than giving up.
 */
function preamble({ csPath, dllPath }) {
  return `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not ('HubDisplay' -as [type])) {
  if (Test-Path -LiteralPath ${psLiteral(dllPath)}) {
    try { Add-Type -Path ${psLiteral(dllPath)} } catch { }
  }
}
if (-not ('HubDisplay' -as [type])) {
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

function parseJson(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch (_) { return null; }
}

const asArray = (value) => (value === null || value === undefined ? [] : (Array.isArray(value) ? value : [value]));

/* ------------------------------------------------------------- enumeration */

async function nativeList(includeModes) {
  const paths = await ensureHelper();
  const out = await runPowerShell(`${preamble(paths)}
[HubDisplay]::List($${includeModes ? 'true' : 'false'}) | ConvertTo-Json -Compress -Depth 4
`, 30000);
  return asArray(parseJson(out));
}

/** Built-in laptop panel brightness. Absent on desktops, which is not an error. */
async function panelBrightness() {
  const out = await runPowerShell(`
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
@(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness |
  Select-Object InstanceName, CurrentBrightness) | ConvertTo-Json -Compress
`, 20000);
  return asArray(parseJson(out));
}

async function ddcBrightness() {
  const paths = await ensureHelper();
  const out = await runPowerShell(`${preamble(paths)}
[HubDisplay]::GetBrightness() | ConvertTo-Json -Compress -Depth 3
`, 30000);
  return asArray(parseJson(out));
}

async function list({ includeModes = true } = {}) {
  if (!IS_WIN) {
    return { supported: false, monitors: [], note: 'Bildschirmsteuerung ist nur unter Windows verfügbar.' };
  }

  const [monitors, panel, ddc] = await Promise.all([
    nativeList(includeModes).catch(() => []),
    panelBrightness().catch(() => []),
    ddcBrightness().catch(() => [])
  ]);

  if (!monitors.length) {
    return { supported: false, monitors: [], note: 'Es konnten keine Bildschirme gelesen werden.' };
  }

  const internal = panel.length ? Math.round(Number(panel[0].CurrentBrightness) || 0) : null;

  const merged = monitors.map((m, index) => {
    // DDC/CI enumerates in the same order as the attached display devices.
    // With one screen that is exact; with several it is the best available
    // pairing, because Windows exposes no shared identifier between the two.
    const ddcEntry = ddc[index] || null;
    const ddcSupported = !!(ddcEntry && ddcEntry.Supported);
    const range = ddcSupported ? Math.max(1, Number(ddcEntry.Maximum) - Number(ddcEntry.Minimum)) : 0;
    const ddcPercent = ddcSupported
      ? Math.round(((Number(ddcEntry.Current) - Number(ddcEntry.Minimum)) / range) * 100)
      : null;

    const modes = asArray(m.Modes)
      .map((mode) => ({
        width: Number(mode.Width),
        height: Number(mode.Height),
        refresh: Number(mode.Refresh),
        depth: Number(mode.Depth)
      }))
      .sort((a, b) => (b.width * b.height) - (a.width * a.height) || b.refresh - a.refresh);

    return {
      device: m.Device,
      adapter: m.Adapter,
      name: m.Name || m.Adapter,
      primary: !!m.Primary,
      width: Number(m.Width) || 0,
      height: Number(m.Height) || 0,
      refresh: Number(m.Refresh) || 0,
      depth: Number(m.Depth) || 0,
      x: Number(m.PositionX) || 0,
      y: Number(m.PositionY) || 0,
      modes,
      brightness: {
        // A laptop reports its panel through WMI; everything else has to go
        // through DDC/CI, and plenty of monitors answer neither.
        source: index === 0 && internal !== null ? 'panel' : (ddcSupported ? 'ddc' : null),
        value: index === 0 && internal !== null ? internal : ddcPercent,
        ddcIndex: ddcEntry ? Number(ddcEntry.Index) : null,
        supported: (index === 0 && internal !== null) || ddcSupported
      }
    };
  });

  return {
    supported: true,
    monitors: merged,
    hasPanel: internal !== null,
    ddcCount: ddc.filter((d) => d && d.Supported).length,
    note: null
  };
}

/* ------------------------------------------------------------- brightness */

async function setBrightness(target, value) {
  if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');
  const percent = Math.max(0, Math.min(100, Math.round(Number(value))));
  if (!Number.isFinite(percent)) throw new Error('Ungültiger Helligkeitswert');

  if (target && target.source === 'panel') {
    await runPowerShell(`
$ErrorActionPreference = "Stop"
$m = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods
if (-not $m) { throw "Kein interner Bildschirm gefunden" }
$m | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = ${percent} } | Out-Null
`, 20000);
    return { ok: true, source: 'panel', value: percent };
  }

  const index = Number(target && target.ddcIndex);
  if (!Number.isInteger(index) || index < 0) throw new Error('Dieser Bildschirm meldet keine Helligkeitssteuerung');

  const paths = await ensureHelper();
  const out = await runPowerShell(`${preamble(paths)}
if ([HubDisplay]::SetBrightness(${index}, ${percent})) { "OK" } else { "FAILED" }
`, 30000);

  if (!/OK/.test(out || '')) {
    throw new Error('Der Monitor hat die Helligkeitsänderung nicht angenommen. Oft ist DDC/CI im Monitormenü abgeschaltet.');
  }
  return { ok: true, source: 'ddc', value: percent };
}

/* ------------------------------------------------------------------ modes */

const DISP_CHANGE = {
  0: 'Erfolgreich',
  '-1': 'Die Einstellung wurde vom Treiber abgelehnt',
  '-2': 'Die Auflösung wird von diesem Bildschirm nicht unterstützt',
  '-3': 'Ein Neustart ist erforderlich',
  '-4': 'Der Grafiktreiber hat einen Fehler gemeldet',
  '-5': 'Ungültige Kombination aus Auflösung und Wiederholrate',
  '-6': 'Die Einstellung wird nicht unterstützt',
  '-100': 'Der Bildschirm konnte nicht gelesen werden'
};

async function setMode(device, width, height, refresh) {
  if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');
  if (typeof device !== 'string' || !device) throw new Error('Bildschirm fehlt');

  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  const r = Math.round(Number(refresh) || 0);
  if (!(w > 0 && h > 0)) throw new Error('Ungültige Auflösung');

  const paths = await ensureHelper();
  const out = await runPowerShell(`${preamble(paths)}
[HubDisplay]::SetMode(${psLiteral(device)}, ${w}, ${h}, ${r})
`, 30000);

  const code = parseInt((out || '').trim(), 10);
  if (code !== 0) {
    throw new Error(DISP_CHANGE[String(code)] || `Die Änderung schlug fehl (Code ${code})`);
  }
  return { ok: true, device, width: w, height: h, refresh: r };
}

/**
 * Applies a mode and schedules an automatic revert.
 *
 * A wrong resolution or refresh rate can leave the screen black, at which
 * point no dialog can be clicked. Windows solves this with a countdown that
 * reverts unless confirmed, and so does this: the timer lives in the main
 * process, so it still fires when the renderer is not visible at all.
 */
let pendingRevert = null;
let onRevert = () => {};

function setRevertHandler(handler) {
  onRevert = typeof handler === 'function' ? handler : () => {};
}

function cancelRevert() {
  if (!pendingRevert) return { ok: true, pending: false };
  clearTimeout(pendingRevert.timer);
  const { device } = pendingRevert;
  pendingRevert = null;
  return { ok: true, pending: false, device };
}

async function setModeSafely(device, width, height, refresh, { timeoutMs = 15000 } = {}) {
  const monitors = await nativeList(false);
  const before = monitors.find((m) => m.Device === device);
  if (!before) throw new Error('Bildschirm nicht gefunden');

  const previous = {
    width: Number(before.Width),
    height: Number(before.Height),
    refresh: Number(before.Refresh)
  };

  const applied = await setMode(device, width, height, refresh);

  // Only one revert can be outstanding; a second change replaces the first.
  cancelRevert();
  const timer = setTimeout(async () => {
    pendingRevert = null;
    try {
      await setMode(device, previous.width, previous.height, previous.refresh);
      onRevert({ device, reverted: true, previous });
    } catch (err) {
      onRevert({ device, reverted: false, error: err.message, previous });
    }
  }, Math.max(5000, timeoutMs));

  pendingRevert = { device, previous, timer };

  return {
    ...applied,
    previous,
    revertInMs: Math.max(5000, timeoutMs),
    revertsAt: Date.now() + Math.max(5000, timeoutMs)
  };
}

async function setPrimary(device) {
  if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');
  if (typeof device !== 'string' || !device) throw new Error('Bildschirm fehlt');

  const paths = await ensureHelper();
  const out = await runPowerShell(`${preamble(paths)}
[HubDisplay]::SetPrimary(${psLiteral(device)})
`, 30000);

  const code = parseInt((out || '').trim(), 10);
  if (code !== 0) throw new Error(DISP_CHANGE[String(code)] || `Die Änderung schlug fehl (Code ${code})`);
  return { ok: true, device };
}

/* ------------------------------------------------------------- projection */

const PROJECTION = {
  internal: { arg: '/internal', label: 'Nur Hauptbildschirm' },
  clone: { arg: '/clone', label: 'Duplizieren' },
  extend: { arg: '/extend', label: 'Erweitern' },
  external: { arg: '/external', label: 'Nur zweiter Bildschirm' }
};

async function setProjection(mode) {
  const spec = PROJECTION[mode];
  if (!spec) throw new Error(`Unbekannter Modus: ${mode}`);
  if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');
  // DisplaySwitch.exe ships with Windows and is exactly what Win+P drives.
  await runPowerShell(`Start-Process -FilePath "DisplaySwitch.exe" -ArgumentList "${spec.arg}" -WindowStyle Hidden`, 15000);
  return { ok: true, mode, label: spec.label };
}

async function openSettings(page) {
  const pages = {
    display: 'ms-settings:display',
    nightlight: 'ms-settings:nightlight',
    advanced: 'ms-settings:display-advanced',
    graphics: 'ms-settings:display-advancedgraphics',
    hdr: 'ms-settings:display-hdr',
    scaling: 'ms-settings:display'
  };
  const target = pages[page];
  if (!target) throw new Error(`Unbekannte Seite: ${page}`);
  await shell.openExternal(target);
  return { ok: true };
}

module.exports = {
  list, setBrightness, setMode, setModeSafely, cancelRevert, setRevertHandler,
  setPrimary, setProjection, openSettings, PROJECTION, DISP_CHANGE
};
