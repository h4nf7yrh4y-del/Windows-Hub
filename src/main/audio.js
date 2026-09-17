'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app } = require('electron');
const { runPowerShell } = require('./processes');
const logger = require('./logger');

const log = logger.scoped('audio');

/**
 * Which device Windows plays through.
 *
 * Headset for the game, speakers for the film, and today that means opening
 * the sound settings and clicking through a list every time. A profile already
 * knows which of the two situations it is.
 *
 * The honest part, which the interface repeats rather than hides: Windows has
 * no supported way to change this. Enumerating the devices and reading their
 * names is documented and stable; making one of them the default is an
 * interface Microsoft never documented. Every audio switcher on Windows uses
 * it, and it has worked from 7 through 11 -- that is evidence, not a promise.
 *
 * So the two halves are kept apart. If a Windows release breaks the switch,
 * listing still works, the hub still shows what is active, and the failure is
 * a message rather than a blank panel.
 */

const IS_WIN = process.platform === 'win32';
const CS_SOURCE = path.join(__dirname, 'ps', 'audio.cs.txt');

let helperPaths = null;
let compiling = null;

/** The C# lives inside the packaged asar, which PowerShell cannot read. */
async function ensureHelper() {
  if (helperPaths) return helperPaths;

  const dir = path.join(app.getPath('userData'), 'native');
  await fsp.mkdir(dir, { recursive: true });

  const source = await fsp.readFile(CS_SOURCE, 'utf8');
  const csPath = path.join(dir, 'HubAudio.cs');
  const dllPath = path.join(dir, 'HubAudio.dll');

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

if (-not ('HubAudio' -as [type])) {
  if (Test-Path -LiteralPath ${psLiteral(dllPath)}) {
    try { Add-Type -Path ${psLiteral(dllPath)} } catch { }
  }
}
if (-not ('HubAudio' -as [type])) {
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
 * The same reasoning as the display helper: `Add-Type` runs the real C#
 * compiler, which on a cold machine is tens of seconds -- far past what a
 * device listing is given, and everything else waits behind it on the one
 * shell the hub has.
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
if ('HubAudio' -as [type]) { 'ok' } else { throw 'Audio-Hilfsklasse konnte nicht geladen werden' }
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

/* ----------------------------------------------------------------- reading */

let cache = { at: 0, devices: null };
const CACHE_MS = 15000;

async function list({ force = false } = {}) {
  if (!IS_WIN) return { supported: false, devices: [], note: 'Nur unter Windows verfügbar.' };
  if (!force && cache.devices && Date.now() - cache.at < CACHE_MS) {
    return { supported: true, devices: cache.devices, note: null };
  }

  const ready = await ensureCompiled();
  if (!ready.ok) return { supported: false, devices: [], note: ready.reason };

  try {
    const paths = await ensureHelper();
    const out = await runPowerShell(`${preamble(paths)}
[HubAudio]::List()
`, 20000, { background: true });

    const trimmed = (out || '').trim();
    if (!trimmed) return { supported: true, devices: [], note: 'Keine Wiedergabegeräte gefunden.' };

    const parsed = JSON.parse(trimmed);
    const devices = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((d) => d && d.id)
      .map((d) => ({ id: String(d.id), name: String(d.name || d.id), active: !!d.default }));

    cache = { at: Date.now(), devices };
    return { supported: true, devices, note: null };
  } catch (err) {
    log.warn(`Wiedergabegeräte nicht lesbar: ${err.message}`);
    return { supported: false, devices: [], note: `Geräte nicht lesbar: ${err.message}` };
  }
}

async function current() {
  if (!IS_WIN) return null;
  const ready = await ensureCompiled();
  if (!ready.ok) return null;
  try {
    const paths = await ensureHelper();
    const out = await runPowerShell(`${preamble(paths)}
[HubAudio]::Current()
`, 15000, { background: true });
    return (out || '').trim() || null;
  } catch (_) {
    return null;
  }
}

/* ---------------------------------------------------------------- switching */

/**
 * What a device id may look like.
 *
 * Endpoint ids are of the form `{0.0.0.00000000}.{guid}`. The value comes from
 * the renderer and is interpolated into a PowerShell string, so it is checked
 * in a function of its own, before the platform is looked at -- otherwise the
 * check could only ever run on Windows, which is to say never in a test.
 */
const DEVICE_ID = /^\{[0-9.]+\}\.\{[0-9a-fA-F-]{36}\}$/;

function checkDeviceId(id) {
  const value = String(id || '');
  if (!DEVICE_ID.test(value)) throw new Error('Ungültige Gerätekennung');
  return value;
}

async function setDefault(id) {
  const device = checkDeviceId(id);
  if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');

  const ready = await ensureCompiled();
  if (!ready.ok) throw new Error(ready.reason || 'Audio-Hilfsklasse nicht verfügbar');

  const paths = await ensureHelper();
  const out = await runPowerShell(`${preamble(paths)}
[HubAudio]::SetDefault(${psLiteral(device)})
`, 20000);

  const answer = (out || '').trim();
  // The helper returns a sentence rather than throwing, so a refusal from
  // Windows arrives as something worth showing instead of a COM error code.
  if (answer !== 'ok') throw new Error(answer || 'Umschalten fehlgeschlagen');

  cache = { at: 0, devices: null };
  log.info(`Wiedergabegerät umgeschaltet: ${device}`);
  return { ok: true, id: device };
}

module.exports = {
  list,
  current,
  setDefault,
  ensureCompiled,
  // Exported for the tests: this decides what reaches a PowerShell string.
  checkDeviceId,
  DEVICE_ID
};
