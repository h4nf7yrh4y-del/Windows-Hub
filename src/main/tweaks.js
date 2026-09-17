'use strict';

const { powerSaveBlocker } = require('electron');
const processes = require('./processes');
const audio = require('./audio');
const store = require('./store');
const logger = require('./logger');

const log = logger.scoped('tweaks');
const IS_WIN = process.platform === 'win32';

/**
 * System changes a profile makes around the programs it starts.
 *
 * Launching Spotify, Discord and a game is the visible half of a profile; the
 * useful half is everything else the machine should do while that profile is
 * running — full performance instead of a balanced power plan, the game above
 * the browser in the scheduler, the twenty background processes closed, and no
 * screensaver in the middle of a mission.
 *
 * Everything here is reversible, and every change is written down before it is
 * made. The snapshot lives in the configuration file rather than in memory, so
 * a hub that is killed while a profile runs can still put the machine back the
 * way it found it on the next start.
 */

/**
 * Realtime is deliberately absent. It outranks the kernel's own input and
 * audio threads, and a game that stops responding takes the mouse pointer with
 * it — there is no way back except the power button.
 */
const PRIORITIES = [
  { value: 'normal', label: 'Normal', hint: 'Keine Änderung gegenüber dem Standard.' },
  { value: 'abovenormal', label: 'Höher als normal', hint: 'Bevorzugt gegenüber Hintergrundprogrammen, ohne sie auszuhungern.' },
  { value: 'high', label: 'Hoch', hint: 'Deutlich bevorzugt. Sinnvoll für ein Spiel, nicht für mehrere Programme gleichzeitig.' }
];

/* --------------------------------------------------------------- helpers */

function quote(value) {
  // Single-quoted PowerShell strings only need the quote itself doubled.
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Strips path and extension the same way the process list reports names. */
function processName(value) {
  const last = String(value || '').split(/[\\/]/).filter(Boolean).pop();
  return (last || '').replace(/\.exe$/i, '').trim();
}

const PROTECTED = new Set([
  'system', 'system idle process', 'registry', 'smss', 'csrss', 'wininit',
  'winlogon', 'services', 'lsass', 'memory compression', 'idle', 'explorer',
  'dwm', 'fontdrvhost', 'sihost', 'ctfmon', 'audiodg', 'windows hub'
]);

function parseJson(out) {
  const trimmed = (out || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    log.warn(`Antwort nicht lesbar: ${err.message}`);
    return null;
  }
}

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/* ----------------------------------------------------------- power plans */

const PLANS_SCRIPT = String.raw`
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$plans = @(Get-CimInstance -Namespace root\cimv2\power -ClassName Win32_PowerPlan |
  Select-Object ElementName, InstanceID, IsActive)
ConvertTo-Json -Compress -Depth 3 -InputObject $plans
`;

/**
 * Reading the power schemes goes through WMI, which is the slowest query in
 * the whole application: the first access to that namespace can take several
 * seconds. Two unrelated screens want the same list, and the set of schemes
 * changes about once a year, so the answer is cached for a minute and the
 * cache is dropped the moment a plan is switched.
 */
let planCache = { at: 0, plans: null };
let planFailedAt = 0;
let planInFlight = null;
const PLAN_CACHE_MS = 60000;
const PLAN_RETRY_MS = 30000;
// The old value here was twelve seconds, on the reasoning that a machine
// needing longer has a broken provider and waiting only blocks the queue. That
// was half the picture: a job that times out blocks the queue for its whole
// timeout AND costs a host replacement, because the hung script still owns the
// only pipe. On the two-core runner the next view's process list then landed on
// a cold PowerShell and never arrived. Waiting is cheaper than timing out, and
// the query goes in as background work so it can never get ahead of something
// a person is waiting for.
const PLAN_TIMEOUT_MS = 40000;

async function listPowerPlans({ force = false } = {}) {
  if (!IS_WIN) return [];
  if (!force && planCache.plans && Date.now() - planCache.at < PLAN_CACHE_MS) return planCache.plans;
  // A failed read is remembered too, briefly. Without that, a provider that
  // hangs is asked again on every screen and occupies the shell each time.
  if (!force && planFailedAt && Date.now() - planFailedAt < PLAN_RETRY_MS) return planCache.plans || [];
  if (planInFlight) return planInFlight;

  planInFlight = (async () => {
    const parsed = parseJson(await processes.runPowerShell(PLANS_SCRIPT, PLAN_TIMEOUT_MS, { background: true }).catch((err) => {
      log.warn(`Energiepläne nicht lesbar: ${err.message}`);
      return '';
    }));
    const plans = asArray(parsed).map((row) => {
      const match = /\{([0-9a-f-]+)\}/i.exec(String(row.InstanceID || ''));
      return { guid: match ? match[1] : null, label: row.ElementName, active: !!row.IsActive };
    }).filter((plan) => plan.guid);

    if (plans.length) {
      planCache = { at: Date.now(), plans };
      planFailedAt = 0;
    } else {
      planFailedAt = Date.now();
    }
    return plans;
  })();

  try {
    return await planInFlight;
  } finally {
    planInFlight = null;
  }
}

function setPowerPlanScript(guid) {
  return `
$ErrorActionPreference = "Stop"
powercfg /setactive ${guid}
if ($LASTEXITCODE -ne 0) { throw "powercfg meldete Code $LASTEXITCODE" }
`;
}

async function setPowerPlan(guid) {
  if (!/^[0-9a-f-]{36}$/i.test(String(guid))) throw new Error('Ungültiger Energieplan');
  await processes.runPowerShell(setPowerPlanScript(guid), 25000);
  planCache = { at: 0, plans: null };
  planFailedAt = 0;
  return guid;
}

/* --------------------------------------------------- closing and restoring */

/**
 * Asks the listed programs to close, then insists.
 *
 * The polite request comes first because a browser that is killed outright
 * loses its open tabs and shows a crash bar on the next start. The executable
 * path of everything that was closed is captured before it goes away, so the
 * same programs can be started again afterwards.
 */
function closeScript(names) {
  const list = names.map(quote).join(', ');
  return `
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$names = @(${list})
$closed = @()
foreach ($name in $names) {
  foreach ($p in @(Get-Process -Name $name)) {
    $path = $null
    try { $path = $p.Path } catch { $path = $null }
    $closed += [PSCustomObject]@{ name = $p.ProcessName; path = $path }
    try { [void]$p.CloseMainWindow() } catch { }
  }
}
Start-Sleep -Milliseconds 2500
foreach ($name in $names) {
  foreach ($p in @(Get-Process -Name $name)) {
    try { $p.Kill() } catch { }
  }
}
ConvertTo-Json -Compress -Depth 3 -InputObject $closed
`;
}

function restartScript(entries) {
  const list = entries.map((e) => quote(e.path)).join(', ');
  return `
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$paths = @(${list})
$started = @()
foreach ($path in $paths) {
  if (Test-Path -LiteralPath $path) {
    try {
      Start-Process -FilePath $path | Out-Null
      $started += $path
    } catch { }
  }
}
ConvertTo-Json -Compress -Depth 2 -InputObject $started
`;
}

async function closeApps(names) {
  const wanted = [...new Set(names.map(processName).filter(Boolean))]
    .filter((name) => !PROTECTED.has(name.toLowerCase()));
  if (!wanted.length) return [];
  if (!IS_WIN) return [];

  const parsed = parseJson(await processes.runPowerShell(closeScript(wanted), 30000));
  // One entry per executable, not per process: closing a browser yields
  // twenty rows pointing at the same file, and restarting it twenty times
  // would be worse than not restarting it at all.
  const byPath = new Map();
  for (const row of asArray(parsed)) {
    if (!row || !row.path) continue;
    if (!byPath.has(row.path)) byPath.set(row.path, { name: row.name, path: row.path });
  }
  return [...byPath.values()];
}

async function restartApps(entries) {
  const usable = entries.filter((e) => e && e.path);
  if (!usable.length || !IS_WIN) return [];
  const parsed = parseJson(await processes.runPowerShell(restartScript(usable), 30000));
  return asArray(parsed);
}

/* ------------------------------------------------------------- priorities */

const NAME_TO_PID_SCRIPT = (name) => `
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$p = @(Get-Process -Name ${quote(name)} | Sort-Object -Property WorkingSet64 -Descending)
if ($p.Count -gt 0) { $p[0].Id } else { 0 }
`;

async function findPid(name) {
  if (!IS_WIN) return 0;
  const out = await processes.runPowerShell(NAME_TO_PID_SCRIPT(name), 15000).catch(() => '');
  return Number(String(out).trim()) || 0;
}

/**
 * Waits for a program to exist before changing its priority.
 *
 * A game launched through Steam is not the process Steam starts: the launcher
 * exits and the game appears seconds later under a different name, so setting
 * the priority immediately after the launch step would target nothing.
 */
async function applyPriority(name, priority, { timeoutMs = 90000 } = {}) {
  const target = processName(name);
  if (!target || !priority || priority === 'normal') return { applied: false };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = await findPid(target);
    if (pid) {
      await processes.setPriority(pid, priority);
      log.info(`Priorität ${priority} für ${target} (PID ${pid})`);
      return { applied: true, pid, name: target, priority };
    }
    if (Date.now() >= deadline) return { applied: false, name: target, reason: 'Programm ist nicht erschienen' };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/* --------------------------------------------------------- awake handling */

let blockerId = null;

function keepAwake(enabled) {
  if (enabled) {
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return blockerId;
    blockerId = powerSaveBlocker.start('prevent-display-sleep');
    return blockerId;
  }
  if (blockerId !== null) {
    try { if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId); } catch (_) { /* already gone */ }
    blockerId = null;
  }
  return null;
}

/* ------------------------------------------------------------- the config */

function defaults() {
  return {
    powerPlan: null,
    priority: 'normal',
    priorityTarget: '',
    closeApps: [],
    restoreClosed: true,
    keepAwake: false,
    // Endpoint id of the playback device this profile wants, or null.
    audioDevice: null,
    restore: true
  };
}

function sanitize(raw) {
  const base = defaults();
  if (!raw || typeof raw !== 'object') return base;
  const priority = PRIORITIES.some((p) => p.value === raw.priority) ? raw.priority : base.priority;
  return {
    powerPlan: /^[0-9a-f-]{36}$/i.test(String(raw.powerPlan || '')) ? String(raw.powerPlan) : null,
    priority,
    priorityTarget: typeof raw.priorityTarget === 'string' ? processName(raw.priorityTarget).slice(0, 64) : '',
    closeApps: Array.isArray(raw.closeApps)
      ? [...new Set(raw.closeApps.map(processName).filter(Boolean))].slice(0, 40)
      : [],
    restoreClosed: raw.restoreClosed !== false,
    keepAwake: !!raw.keepAwake,
    // Checked against the same shape the audio module requires, so an id from
    // an edited config file cannot reach a PowerShell string.
    audioDevice: audio.DEVICE_ID.test(String(raw.audioDevice || '')) ? String(raw.audioDevice) : null,
    restore: raw.restore !== false
  };
}

/** True when a profile actually asks for something, so the UI can stay quiet otherwise. */
function isActive(system) {
  const s = sanitize(system);
  return !!(s.powerPlan || (s.priority && s.priority !== 'normal') || s.closeApps.length
    || s.keepAwake || s.audioDevice);
}

/* ---------------------------------------------------------------- runtime */

function snapshotStore() {
  const state = store.state;
  if (!state.tweakSnapshot || typeof state.tweakSnapshot !== 'object') state.tweakSnapshot = null;
  return state;
}

function saveSnapshot(snapshot) {
  const state = snapshotStore();
  state.tweakSnapshot = snapshot;
  store.save();
}

/**
 * Applies everything a profile asks for, in the order that hurts least:
 * background programs first (so the power plan is not switched for a machine
 * that is about to lose half its processes), then the power plan, then the
 * screen. The priority is applied later, once the launched program exists.
 */
async function apply(profile, emit = () => {}) {
  const system = sanitize(profile && profile.system);
  const report = { applied: [], failed: [] };
  if (!isActive(system)) return report;

  const snapshot = {
    profileId: profile.id,
    profileName: profile.name,
    at: Date.now(),
    previousPowerPlan: null,
    previousAudioDevice: null,
    closed: [],
    restoreClosed: system.restoreClosed,
    restore: system.restore
  };

  if (system.closeApps.length) {
    emit({ phase: 'tweak', step: 'close', names: system.closeApps });
    try {
      snapshot.closed = await closeApps(system.closeApps);
      report.applied.push(snapshot.closed.length
        ? `${snapshot.closed.length} Hintergrundprogramme beendet`
        : 'Keine der genannten Hintergrundprogramme lief');
    } catch (err) {
      report.failed.push(`Hintergrundprogramme: ${err.message}`);
    }
  }

  if (system.powerPlan) {
    emit({ phase: 'tweak', step: 'power' });
    try {
      const plans = await listPowerPlans();
      const active = plans.find((p) => p.active);
      snapshot.previousPowerPlan = active ? active.guid : null;
      await setPowerPlan(system.powerPlan);
      const chosen = plans.find((p) => p.guid.toLowerCase() === system.powerPlan.toLowerCase());
      report.applied.push(`Energieplan: ${chosen ? chosen.label : system.powerPlan}`);
    } catch (err) {
      report.failed.push(`Energieplan: ${err.message}`);
    }
  }

  if (system.audioDevice) {
    emit({ phase: 'tweak', step: 'audio' });
    try {
      // Remembered before switching, so the revert has somewhere to go back
      // to. A failure here is reported and does not stop the profile: the
      // interface it uses is undocumented and may be gone one Windows update
      // from now, and a game that refuses to start over an audio device would
      // be the worse outcome.
      snapshot.previousAudioDevice = await audio.current();
      await audio.setDefault(system.audioDevice);
      report.applied.push('Wiedergabegerät umgeschaltet');
    } catch (err) {
      snapshot.previousAudioDevice = null;
      report.failed.push(`Wiedergabegerät: ${err.message}`);
    }
  }

  if (system.keepAwake) {
    keepAwake(true);
    report.applied.push('Bildschirm bleibt an');
  }

  saveSnapshot(snapshot);
  return report;
}

/**
 * Runs after the profile's programs are up.
 *
 * Kept separate from apply() because it has to wait for a process that does
 * not exist yet, and nothing else should be delayed by that wait.
 */
async function applyLatePriority(profile) {
  const system = sanitize(profile && profile.system);
  if (!system.priority || system.priority === 'normal') return { applied: false };

  // Without an explicit target, the last executable step of the profile is the
  // best guess: profiles are written launcher-first, game-last.
  let target = system.priorityTarget;
  if (!target) {
    const exeSteps = (profile.apps || []).filter((a) => a && a.enabled !== false)
      .filter((a) => a.processName || (a.launch && a.launch.type === 'exe'));
    const last = exeSteps[exeSteps.length - 1];
    if (last) target = last.processName || processName(last.launch.target);
  }
  if (!target) return { applied: false, reason: 'Kein Programm für die Priorität bekannt' };

  try {
    return await applyPriority(target, system.priority);
  } catch (err) {
    return { applied: false, name: target, reason: err.message };
  }
}

/**
 * Puts back whatever the last apply() changed.
 *
 * With a profileId it only acts on that profile's snapshot: stopping profile A
 * must not undo the power plan profile B set two minutes ago.
 */
async function revert({ silent = false, profileId = null } = {}) {
  const state = snapshotStore();
  const snapshot = state.tweakSnapshot;
  if (!snapshot) { keepAwake(false); return { reverted: [], skipped: true }; }
  if (profileId && snapshot.profileId !== profileId) {
    return { reverted: [], skipped: true, reason: 'Ein anderes Profil hält den Systemzustand' };
  }
  keepAwake(false);

  const reverted = [];
  const failed = [];

  if (snapshot.restore !== false && snapshot.previousPowerPlan) {
    try {
      await setPowerPlan(snapshot.previousPowerPlan);
      reverted.push('Energieplan zurückgesetzt');
    } catch (err) {
      failed.push(`Energieplan: ${err.message}`);
    }
  }

  if (snapshot.restore !== false && snapshot.previousAudioDevice) {
    try {
      await audio.setDefault(snapshot.previousAudioDevice);
      reverted.push('Wiedergabegerät zurückgesetzt');
    } catch (err) {
      failed.push(`Wiedergabegerät: ${err.message}`);
    }
  }

  if (snapshot.restore !== false && snapshot.restoreClosed && (snapshot.closed || []).length) {
    try {
      const started = await restartApps(snapshot.closed);
      reverted.push(`${started.length} Hintergrundprogramme neu gestartet`);
    } catch (err) {
      failed.push(`Hintergrundprogramme: ${err.message}`);
    }
  }

  saveSnapshot(null);
  if (!silent && (reverted.length || failed.length)) {
    log.info(`Systemzustand zurückgesetzt: ${[...reverted, ...failed].join(', ')}`);
  }
  return { reverted, failed };
}

/**
 * Called once at startup.
 *
 * If a snapshot is still lying around, the hub did not get to revert it —
 * a crash, a forced shutdown, or the emergency exit. Leaving the machine on a
 * changed power plan because of that would be the kind of side effect nobody
 * connects back to a launcher weeks later.
 */
async function restoreAfterCrash() {
  const state = snapshotStore();
  if (!state.tweakSnapshot) return { restored: false };
  log.warn(`Offene Systemänderungen von „${state.tweakSnapshot.profileName || '?'}" werden zurückgesetzt`);
  const result = await revert({ silent: true });
  return { restored: true, ...result };
}

function status() {
  const snapshot = snapshotStore().tweakSnapshot;
  return {
    supported: IS_WIN,
    priorities: PRIORITIES,
    awake: blockerId !== null,
    active: snapshot ? {
      profileId: snapshot.profileId,
      profileName: snapshot.profileName,
      since: snapshot.at,
      closed: (snapshot.closed || []).length,
      powerPlanChanged: !!snapshot.previousPowerPlan
    } : null
  };
}

/** Whatever the last successful read produced, without asking again. */
function cachedPowerPlans() {
  return planCache.plans || [];
}

module.exports = {
  PRIORITIES,
  setPowerPlan,
  cachedPowerPlans,
  defaults,
  sanitize,
  isActive,
  processName,
  listPowerPlans,
  apply,
  applyLatePriority,
  revert,
  restoreAfterCrash,
  status,
  keepAwake,
  // Exported for the PowerShell syntax tests.
  PLANS_SCRIPT,
  closeScript,
  restartScript,
  setPowerPlanScript,
  NAME_TO_PID_SCRIPT
};
