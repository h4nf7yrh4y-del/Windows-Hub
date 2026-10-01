'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { shell } = require('electron');
const processes = require('./processes');
const tweaks = require('./tweaks');
const windowlayout = require('./windowlayout');
const logger = require('./logger');

const log = logger.scoped('launcher');

/**
 * Launches single apps and whole profiles.
 *
 * Profile steps run sequentially, because launching Spotify, Discord and a game
 * in the same millisecond is how you get a game that loses focus three times
 * during its splash screen.
 *
 * There are two ways to space them out, and the difference matters. `delayMs`
 * is a fixed pause before a step, which is a guess about the slowest machine
 * this profile will ever run on: too short and the sequence is wrong, too long
 * and every launch pays for the worst case. `waitFor` waits until the previous
 * program is actually there — its process, or its window — which is the thing
 * the delay was standing in for all along. `delayMs` stays, because a program
 * the hub cannot recognise still has to be waited for somehow.
 */

const IS_WIN = process.platform === 'win32';

function expand(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/%([^%]+)%/g, (match, name) => process.env[name] || match);
}

function launchExe(item) {
  const target = expand(item.target);
  if (!target) throw new Error('Missing executable path');
  if (!fs.existsSync(target)) throw new Error(`Not found: ${target}`);
  const child = spawn(target, (item.args || []).map(expand), {
    detached: true,
    stdio: 'ignore',
    cwd: item.cwd ? expand(item.cwd) : path.dirname(target),
    windowsHide: false
  });
  child.unref();
  return { pid: child.pid };
}

async function launchUri(item) {
  const target = expand(item.target);
  if (!target) throw new Error('Missing URI');
  await shell.openExternal(target);
  return { uri: target };
}

function launchAppsFolder(item) {
  const target = expand(item.target);
  if (!target) throw new Error('Missing AppID');
  const child = spawn('explorer.exe', [`shell:AppsFolder\\${target}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  return { appId: target };
}

function launchShell(item) {
  const target = expand(item.target);
  if (!target) throw new Error('Missing command');
  const child = IS_WIN
    ? spawn('cmd.exe', ['/c', target], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn('/bin/sh', ['-c', target], { detached: true, stdio: 'ignore' });
  child.unref();
  return { command: target };
}

async function launchItem(item) {
  if (!item || typeof item !== 'object') throw new Error('Invalid launch item');
  switch (item.type) {
    case 'exe': return launchExe(item);
    case 'uri': return launchUri(item);
    case 'appsfolder': return launchAppsFolder(item);
    case 'shell': return launchShell(item);
    default: throw new Error(`Unknown launch type: ${item.type}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

/* ------------------------------------------------------------------- pure */
/*
 * The decisions about waiting, free of the clock, of PowerShell and of
 * Electron. What goes wrong when a step waits is never the polling: it is
 * waiting for something that can never be recognised, and reporting that as a
 * wait rather than as "this entry cannot be waited for".
 */

// What a step can wait for once it has been started. `none` is the default and
// means the sequence continues immediately, as it always did.
const WAIT_KINDS = ['none', 'process', 'window'];

// Long enough for a launcher to hand a game over on a cold disk. A step that
// is still not up by then continues anyway: a sequence that stops dead because
// one program is slow is worse than one that starts the next program early.
const READY_MS = 45000;
const READY_POLL_MS = 900;

/** How a process name is compared: no path, no extension, lower case. */
function readyKey(name) {
  return stripExtension(baseName(name)).toLowerCase();
}

/**
 * What waiting for one step will actually do.
 *
 * The kind that comes back is not always the one that was asked for, and that
 * difference is the whole point of having this separately: a window can only
 * be waited for while the window helper is loadable, and nothing at all can be
 * waited for when the entry has no process name — `steam://rungameid/553850`
 * names a game, not a process. Both cases carry a reason, so the interface can
 * say why a wait did not happen instead of showing one that could only ever
 * run into its deadline.
 *
 * An unknown condition is reported, not treated as a wait: the value is
 * refused where it enters the app, and by the time it is read the only useful
 * thing left to do with it is to say so.
 */
function readyPlan(step, { windows = true } = {}) {
  const asked = (step && step.waitFor) || 'none';
  if (!WAIT_KINDS.includes(asked)) {
    return { kind: 'none', asked, names: [], reason: `Unbekannte Wartebedingung: ${asked}` };
  }
  if (asked === 'none') return { kind: 'none', asked, names: [] };

  const names = namesForApp(step);
  if (!names.length) {
    return { kind: 'none', asked, names, reason: 'Für diesen Eintrag ist kein Prozessname bekannt' };
  }
  if (asked === 'window' && !windows) {
    return {
      kind: 'process',
      asked,
      names,
      reason: 'Fenster sind auf diesem Rechner nicht abfragbar, es wird auf den Prozess gewartet'
    };
  }
  return { kind: asked, asked, names };
}

/** Whether a step counts as up, in one snapshot of the machine. */
function isUp(kind, names, snapshot = {}) {
  const wanted = new Set((names || []).map(readyKey).filter(Boolean));
  // No name is not "already up": the caller is expected to have turned that
  // into a plan without a wait, and answering true here would hide it.
  if (!wanted.size) return false;
  if (kind === 'window') {
    return (snapshot.windows || []).some((win) => win && wanted.has(readyKey(win.process)));
  }
  return (snapshot.running || []).some((name) => wanted.has(readyKey(name)));
}

/** The wait budget for one step, bounded the way the editor bounds it. */
function readyTimeout(step) {
  const raw = Number(step && step.waitTimeoutMs);
  if (!Number.isFinite(raw) || raw <= 0) return READY_MS;
  return Math.max(2000, Math.min(180000, Math.round(raw)));
}

/* --------------------------------------------------------------- end pure */

/**
 * Waits until a started step is actually up, or until its budget runs out.
 *
 * Polled, for the same reason `windowlayout.apply` polls: Windows has no
 * notification for "another process now has a window" that does not involve
 * injecting a hook into that process. The condition being waited on is still
 * the program being there, not a number of seconds somebody guessed — which is
 * the entire difference to `delayMs`.
 *
 * `probe` exists so the loop can be exercised without a machine underneath it.
 */
async function waitUntilUp(plan, { timeoutMs = READY_MS, intervalMs = READY_POLL_MS, probe } = {}) {
  const read = probe || (async (kind) => ({
    running: await processes.runningNames(),
    windows: kind === 'window' ? await windowlayout.list() : []
  }));

  const started = Date.now();
  const deadline = started + timeoutMs;

  for (;;) {
    let snapshot;
    try {
      snapshot = await read(plan.kind);
    } catch (err) {
      return { ok: false, ms: Date.now() - started, reason: err.message };
    }
    if (isUp(plan.kind, plan.names, snapshot)) return { ok: true, ms: Date.now() - started };

    const left = deadline - Date.now();
    if (left <= 0) return { ok: false, ms: Date.now() - started, reason: 'Zeit abgelaufen' };
    await sleep(Math.min(intervalMs, left));
  }
}

/**
 * Runs a profile's steps in order.
 * `emit` receives {phase, index, total, step, ok, error} so the UI can render
 * a live boot sequence instead of a spinner.
 */
async function launchProfile(profile, emit = () => {}) {
  if (!profile || !Array.isArray(profile.apps)) throw new Error('Profile has no apps');
  const steps = profile.apps.filter((a) => a && a.enabled !== false);
  const results = [];

  emit({ phase: 'start', total: steps.length, profileId: profile.id, profileName: profile.name });

  // Before anything is moved and before the monitor setup changes, because
  // both are what will scatter the desktop. Awaited rather than backgrounded:
  // a picture of the desk taken after it has been cleared is worthless.
  if (profile.restoreDesktop) {
    emit({ phase: 'desktop', step: 'hold' });
    try {
      const held = await windowlayout.holdDesktop(profile.id);
      emit({ phase: 'desktop', step: 'held', count: held.held, reason: held.reason });
    } catch (err) {
      emit({ phase: 'desktop', step: 'held', count: 0, error: err.message });
      log.debug(`Desktop nicht gemerkt: ${err.message}`);
    }
  }

  // The machine is prepared before the first program starts: closing a browser
  // after the game is already loading would fight it for the disk.
  let tweakReport = null;
  if (tweaks.isActive(profile.system)) {
    try {
      tweakReport = await tweaks.apply(profile, emit);
      emit({ phase: 'tweaks', report: tweakReport });
    } catch (err) {
      emit({ phase: 'tweaks', report: { applied: [], failed: [err.message] } });
    }
  }

  // Started rather than awaited: compiling the window helper is a compiler run,
  // and doing it here would delay every launch in the profile instead of only
  // the first step that actually waits for a window. By then the compile has
  // been running alongside the launches and is usually already done.
  const windowHelper = steps.some((step) => step && step.waitFor === 'window')
    ? windowlayout.ensureCompiled().catch((err) => ({ ok: false, reason: err.message }))
    : null;

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step.delayMs) {
      emit({ phase: 'wait', index: i, total: steps.length, step, waitMs: step.delayMs });
      await sleep(step.delayMs);
    }
    emit({ phase: 'launch', index: i, total: steps.length, step });
    let launched = false;
    try {
      const info = await launchItem(step.launch || step);
      launched = true;
      results.push({ name: step.name, ok: true, info });
      emit({ phase: 'done', index: i, total: steps.length, step, ok: true, info });
    } catch (err) {
      results.push({ name: step.name, ok: false, error: err.message });
      emit({ phase: 'done', index: i, total: steps.length, step, ok: false, error: err.message });
      if (step.required) {
        emit({ phase: 'aborted', index: i, total: steps.length, step, error: err.message });
        return { ok: false, results, aborted: true };
      }
    }

    // Only something that was actually started can be waited for. A wait that
    // runs out does not abort the sequence, not even for a required step: the
    // program was started, all that failed is recognising it.
    if (launched && step.waitFor && step.waitFor !== 'none') {
      let windows = true;
      if (step.waitFor === 'window') {
        const helper = windowHelper ? await windowHelper : { ok: false };
        windows = !!helper.ok;
      }

      const plan = readyPlan(step, { windows });
      if (plan.kind === 'none') {
        emit({ phase: 'ready', index: i, total: steps.length, step, kind: 'none', ok: false, waited: false, reason: plan.reason });
        log.debug(`${step.name}: nicht abwartbar — ${plan.reason}`);
      } else {
        const timeoutMs = readyTimeout(step);
        emit({ phase: 'awaiting', index: i, total: steps.length, step, kind: plan.kind, names: plan.names, timeoutMs, reason: plan.reason });
        const outcome = await waitUntilUp(plan, { timeoutMs });
        emit({ phase: 'ready', index: i, total: steps.length, step, kind: plan.kind, waited: true, ...outcome });
        if (!outcome.ok) log.debug(`${step.name}: ${outcome.reason}`);
      }
    }
  }

  emit({ phase: 'finished', total: steps.length, results });

  // The priority is set once the program exists, which can be a minute after
  // the launch step returned. Nothing waits for it.
  tweaks.applyLatePriority(profile)
    .then((outcome) => { if (outcome && outcome.applied) emit({ phase: 'priority', ...outcome }); })
    .catch(() => { /* reported through the log */ });

  // Same reasoning, one step further out: a window appears later than the
  // process does, and a game can take half a minute to get there. Nobody
  // waits in front of the launch dialog for that.
  if ((profile.layout || []).length) {
    windowlayout.apply(profile.layout)
      .then((outcome) => emit({ phase: 'layout', ...outcome }))
      .catch((err) => log.debug(`Fensterlayout nicht angewendet: ${err.message}`));
  }

  return { ok: results.every((r) => r.ok), results, tweaks: tweakReport };
}

/**
 * Protocol handlers where the scheme is the program itself.
 *
 * A profile that starts Spotify through `spotify:` used to contribute no
 * process name at all, so stopping the profile silently left it running: it
 * was never skipped, it never appeared in the list. These are the cases where
 * the scheme reliably identifies the process.
 */
const URI_PROCESSES = {
  spotify: ['Spotify'],
  discord: ['Discord', 'DiscordPTB', 'DiscordCanary'],
  slack: ['slack'],
  steam: ['steam'],
  'com.epicgames.launcher': ['EpicGamesLauncher'],
  obsidian: ['Obsidian'],
  teams: ['ms-teams', 'Teams']
};

/**
 * A launcher URI that starts something else is deliberately not resolved.
 *
 * `steam://rungameid/553850` names a game, not a process, and mapping it to
 * Steam would close the launcher and leave the game running — worse than doing
 * nothing, because it looks like it worked. These are reported as unresolved
 * so the interface can say which entry needs a process name.
 */
const LAUNCHES_SOMETHING_ELSE = /^(steam:\/\/(rungameid|run|launch)|com\.epicgames\.launcher:\/\/apps)/i;

function baseName(value) {
  return String(value || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function stripExtension(value) {
  return String(value || '').replace(/\.(exe|com|bat|cmd)$/i, '').trim();
}

/** Best guess at the process name behind one launch entry, or null. */
function namesForApp(app) {
  if (!app) return [];
  if (app.processName) return [stripExtension(app.processName)].filter(Boolean);

  const launch = app.launch || {};
  const target = expand(launch.target || '');

  if (launch.type === 'exe') {
    const name = stripExtension(baseName(target));
    return name ? [name] : [];
  }

  if (launch.type === 'uri') {
    if (LAUNCHES_SOMETHING_ELSE.test(target)) return [];
    const scheme = (/^([a-z0-9.+-]+):/i.exec(target) || [])[1];
    return scheme ? (URI_PROCESSES[scheme.toLowerCase()] || []) : [];
  }

  if (launch.type === 'appsfolder') {
    // A Store app id looks like Publisher.App_hash!AppId; the part after the
    // exclamation mark is usually what the process is called.
    const appId = target.split('!').pop();
    const name = stripExtension(appId);
    return name && name !== target ? [name] : [];
  }

  if (launch.type === 'shell') {
    // The first token of the command line, quoted or not.
    const first = (/^\s*"([^"]+)"/.exec(target) || [])[1] || target.trim().split(/\s+/)[0];
    const name = stripExtension(baseName(first));
    return name ? [name] : [];
  }

  return [];
}

/**
 * What stopping a profile will close, and what it cannot.
 *
 * Exported so the confirmation dialog can show exactly this list. A dialog that
 * computes its own answer would eventually disagree with what actually happens.
 */
function stopPlan(profile) {
  if (!profile) throw new Error('Unknown profile');
  const names = new Set();
  const unresolved = [];

  for (const app of (profile.apps || [])) {
    if (app && app.enabled === false) continue;
    const resolved = namesForApp(app);
    if (!resolved.length) {
      unresolved.push({
        name: (app && app.name) || 'Unbenannt',
        type: (app && app.launch && app.launch.type) || 'unbekannt',
        target: (app && app.launch && app.launch.target) || ''
      });
      continue;
    }
    for (const name of resolved) names.add(name);
  }

  for (const extra of (profile.alsoClose || [])) {
    const name = stripExtension(baseName(extra));
    if (name) names.add(name);
  }

  return { names: [...names], unresolved };
}

/**
 * Closes everything the profile is responsible for.
 *
 * Whether a program was already running before the profile started makes no
 * difference: a profile owns its programs while it is active, so stopping it
 * closes them either way.
 */
async function stopProfile(profile) {
  if (!profile) throw new Error('Unknown profile');
  const { names, unresolved } = stopPlan(profile);

  const results = [];
  for (const name of names) {
    try {
      const outcome = await processes.killByName(name);
      results.push({ name, ok: true, matched: outcome.matched !== false });
    } catch (err) {
      results.push({ name, ok: false, matched: false, error: err.message });
    }
  }

  // Whatever the profile changed about the machine is undone here, whether or
  // not every program actually closed.
  let restored = null;
  try {
    restored = await tweaks.revert({ profileId: profile.id });
  } catch (err) {
    restored = { reverted: [], failed: [err.message] };
  }

  // After the tweaks, deliberately. Reverting a single-monitor switch is the
  // thing that moved every window in the first place, so putting positions back
  // before that would place them on an arrangement that is about to change.
  let desktop = null;
  if (profile.restoreDesktop) {
    try {
      desktop = await windowlayout.restoreDesktop(profile.id);
    } catch (err) {
      desktop = { applied: [], skipped: [], missing: [], held: 0, error: err.message };
    }
  }

  return { ok: true, results, unresolved, restored, desktop };
}

/**
 * What stopping everything will close.
 *
 * The union, deduplicated: a program three profiles name is killed once and
 * listed once. An unresolved entry keeps the name of the profile it came from,
 * because "one entry cannot be matched to a process" is useless advice when
 * there are five profiles and somebody has to go and find which one.
 *
 * Same reasoning as `stopPlan`: the dialog asks for this rather than working it
 * out, so what it promises and what happens cannot drift apart.
 */
function stopAllPlan(profiles) {
  const names = new Set();
  const unresolved = [];
  const covered = [];

  for (const profile of profiles || []) {
    if (!profile) continue;
    const plan = stopPlan(profile);
    for (const name of plan.names) names.add(name);
    for (const entry of plan.unresolved) {
      unresolved.push({ ...entry, profile: profile.name || 'Unbenannt' });
    }
    covered.push({ id: profile.id, name: profile.name || 'Unbenannt' });
  }

  return { names: [...names], unresolved, profiles: covered };
}

/**
 * Closes everything every profile is responsible for, in one pass.
 *
 * Not a loop over `stopProfile`, and the difference is not only speed. That
 * would kill the same program once per profile that names it, revert the system
 * state once per profile when only one of them can be holding it, and put the
 * desktop back several times over -- each pass moving windows the previous one
 * had just moved.
 */
async function stopAll(profiles) {
  const { names, unresolved, profiles: covered } = stopAllPlan(profiles);

  const results = [];
  for (const name of names) {
    try {
      const outcome = await processes.killByName(name);
      results.push({ name, ok: true, matched: outcome.matched !== false });
    } catch (err) {
      results.push({ name, ok: false, matched: false, error: err.message });
    }
  }

  // Without a profile id on purpose: whatever is held goes back, whoever put it
  // there. Asking per profile would be one call that does the work and the rest
  // doing nothing -- and the one that matters could belong to a profile that is
  // not in this list any more.
  let restored = null;
  try {
    restored = await tweaks.revert();
  } catch (err) {
    restored = { reverted: [], failed: [err.message] };
  }

  let desktop = null;
  try {
    desktop = await windowlayout.restoreAllDesktops();
  } catch (err) {
    desktop = { applied: [], skipped: [], missing: [], held: 0, error: err.message };
  }

  log.info(`Alles beendet: ${results.filter((r) => r.ok && r.matched).length} von ${names.length} Namen liefen`);
  return { ok: true, results, unresolved, restored, desktop, profiles: covered };
}

module.exports = {
  launchItem, launchProfile, stopProfile, stopPlan, stopAll, stopAllPlan,
  namesForApp, expand, URI_PROCESSES,
  // Waiting: the pure decisions, plus the loop that needs a probe handed to it.
  readyPlan, isUp, readyTimeout, waitUntilUp,
  WAIT_KINDS, READY_MS
};
