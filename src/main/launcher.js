'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { shell } = require('electron');
const processes = require('./processes');
const tweaks = require('./tweaks');

/**
 * Launches single apps and whole profiles.
 *
 * Profile steps run sequentially with per-step delays, because launching
 * Spotify, Discord and a game in the same millisecond is how you get a game
 * that loses focus three times during its splash screen.
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

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step.delayMs) {
      emit({ phase: 'wait', index: i, total: steps.length, step, waitMs: step.delayMs });
      await sleep(step.delayMs);
    }
    emit({ phase: 'launch', index: i, total: steps.length, step });
    try {
      const info = await launchItem(step.launch || step);
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
  }

  emit({ phase: 'finished', total: steps.length, results });

  // The priority is set once the program exists, which can be a minute after
  // the launch step returned. Nothing waits for it.
  tweaks.applyLatePriority(profile)
    .then((outcome) => { if (outcome && outcome.applied) emit({ phase: 'priority', ...outcome }); })
    .catch(() => { /* reported through the log */ });

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

  return { ok: true, results, unresolved, restored };
}

module.exports = { launchItem, launchProfile, stopProfile, stopPlan, namesForApp, expand, URI_PROCESSES };
