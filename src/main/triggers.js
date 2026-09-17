'use strict';

const store = require('./store');
const processes = require('./processes');
const tweaks = require('./tweaks');
const launcher = require('./launcher');
const logger = require('./logger');

const log = logger.scoped('triggers');

/**
 * Profiles that react to a program instead of waiting to be started.
 *
 * Until now a profile only worked one way round: press start, and it launches
 * its programs and changes the system around them. Start the same game from
 * Steam's own library and none of that happens -- the power plan stays on
 * balanced, the background clutter stays open, and the hub sits there knowing
 * exactly which profile was meant.
 *
 * The watcher closes that. It looks for the profile's own executables in the
 * process list that the metrics poller already fetches, and when one appears
 * it applies what was missing.
 *
 * Three decisions in here are the ones that matter:
 *
 *   1. The default action applies the *system* part only, not the programs.
 *      If the game is already running, launching the profile would start a
 *      second copy of everything -- including, for a Steam profile, the game.
 *      Anyone who wants the full launch can ask for it, per profile.
 *   2. Only one profile may hold the system state, because there is only one
 *      power plan and one list of closed programs. A trigger never takes it
 *      from whoever has it; it waits.
 *   3. A program has to be gone for several checks before the state is given
 *      back. Games restart their own process when they switch from launcher to
 *      engine, and a power plan that flips back and forth across a loading
 *      screen is worse than one that never changed.
 */

const TICK_MS = 4000;
// Two checks of grace on the way in, three on the way out. Appearing once is
// enough to be worth acting on; disappearing once is usually a restart.
const GONE_TICKS = 3;

let timer = null;
let notify = () => {};

// profileId -> { running, missedTicks, heldSince }
const seen = new Map();

function setNotifier(fn) {
  notify = typeof fn === 'function' ? fn : () => {};
}

/* ---------------------------------------------------------------- shape */

/**
 * A process name as it is compared.
 *
 * Lower case, because Windows does not care about the spelling and the two
 * sides of this comparison come from different places: one from a process
 * listing that writes "Helldivers2", one from a person typing "helldivers2".
 * Comparing them as written means the trigger never fires and nothing in the
 * interface says why.
 */
function norm(name) {
  return tweaks.processName(name).toLowerCase();
}

function defaults() {
  return {
    enabled: false,
    // Empty means "derive from the profile's own programs", which is what
    // makes this usable without typing process names by hand.
    processes: [],
    // 'system' applies the profile's system changes only.
    // 'full' runs the whole profile, programs included.
    action: 'system',
    // Undo the system changes when the program is gone again.
    revertOnExit: true
  };
}

function sanitize(raw) {
  const base = defaults();
  if (!raw || typeof raw !== 'object') return base;
  const action = raw.action === 'full' ? 'full' : 'system';
  return {
    enabled: !!raw.enabled,
    processes: Array.isArray(raw.processes)
      ? [...new Set(raw.processes.map(norm).filter(Boolean))].slice(0, 20)
      : [],
    action,
    revertOnExit: raw.revertOnExit !== false
  };
}

/**
 * The process names that mean "this profile's thing is running".
 *
 * Falls back to the profile's own programs, reusing the same derivation that
 * decides what stopping a profile closes. A profile whose entries are all
 * launcher URIs yields nothing -- and that is reported rather than silently
 * watching for nothing, because a trigger that can never fire looks identical
 * to one that simply has not fired yet.
 */
function watchNames(profile) {
  const trigger = sanitize(profile && profile.trigger);
  if (trigger.processes.length) return trigger.processes;

  const names = new Set();
  for (const app of (profile && profile.apps) || []) {
    if (!app || app.enabled === false) continue;
    for (const name of launcher.namesForApp(app)) {
      const clean = norm(name);
      if (clean) names.add(clean);
    }
  }
  return [...names];
}

/** Profiles with a usable trigger, and why the others are not usable. */
function list() {
  const profiles = store.state.profiles || [];
  return profiles.map((profile) => {
    const trigger = sanitize(profile.trigger);
    const names = watchNames(profile);
    const state = seen.get(profile.id);
    return {
      profileId: profile.id,
      name: profile.name,
      trigger,
      names,
      // The honest part: enabled but nothing to watch for.
      usable: trigger.enabled && names.length > 0,
      reason: !trigger.enabled
        ? null
        : (names.length
          ? null
          : 'Keines der Programme dieses Profils lässt sich als Prozess erkennen. '
            + 'Trage einen Prozessnamen von Hand ein.'),
      running: !!(state && state.running),
      holding: !!(state && state.heldSince)
    };
  });
}

/* ---------------------------------------------------------------- acting */

/** Whether anything at all is holding the system state right now. */
function heldBy() {
  const active = tweaks.status().active;
  return active ? active.profileId : null;
}

async function activate(profile, trigger) {
  const holder = heldBy();
  if (holder && holder !== profile.id) {
    // Someone else owns the single power plan and the single list of closed
    // programs. Taking it would leave their state unrecoverable.
    log.info(`„${profile.name}" erkannt, aber „${holder}" hält den Systemzustand`);
    notify({ kind: 'blocked', profileId: profile.id, name: profile.name });
    return;
  }

  log.info(`„${profile.name}" erkannt, Auslöser greift (${trigger.action})`);
  try {
    if (trigger.action === 'full') {
      await launcher.launchProfile(profile, () => {});
    } else {
      await tweaks.apply(profile, () => {});
      await tweaks.applyLatePriority(profile);
    }
    const state = seen.get(profile.id) || {};
    state.heldSince = Date.now();
    seen.set(profile.id, state);
    notify({ kind: 'applied', profileId: profile.id, name: profile.name, action: trigger.action });
  } catch (err) {
    log.warn(`Auslöser für „${profile.name}" fehlgeschlagen: ${err.message}`);
    notify({ kind: 'error', profileId: profile.id, name: profile.name, error: err.message });
  }
}

async function deactivate(profile) {
  const state = seen.get(profile.id);
  if (!state || !state.heldSince) return;
  state.heldSince = null;
  seen.set(profile.id, state);

  log.info(`„${profile.name}" ist beendet, Systemzustand wird zurückgegeben`);
  try {
    // Scoped to this profile: if the user started another one by hand in the
    // meantime, that one owns the state and this call does nothing.
    await tweaks.revert({ profileId: profile.id });
    notify({ kind: 'reverted', profileId: profile.id, name: profile.name });
  } catch (err) {
    log.warn(`Zurücksetzen nach „${profile.name}" fehlgeschlagen: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ tick */

/**
 * One pass over the process list.
 *
 * Exported so the tests can drive it with a list of their own; nothing here
 * reads the clock or sleeps, which is what makes it testable at all.
 */
async function evaluate(runningNames) {
  const running = new Set((runningNames || []).map(norm).filter(Boolean));
  const profiles = store.state.profiles || [];

  for (const profile of profiles) {
    const trigger = sanitize(profile.trigger);
    if (!trigger.enabled) { seen.delete(profile.id); continue; }

    const names = watchNames(profile);
    if (!names.length) continue;

    const isRunning = names.some((name) => running.has(name));
    const state = seen.get(profile.id) || { running: false, missedTicks: 0, heldSince: null };

    if (isRunning) {
      state.missedTicks = 0;
      if (!state.running) {
        state.running = true;
        seen.set(profile.id, state);
        await activate(profile, trigger);
        continue;
      }
      seen.set(profile.id, state);
      continue;
    }

    if (!state.running) { seen.set(profile.id, state); continue; }

    state.missedTicks += 1;
    seen.set(profile.id, state);
    // A game that restarts its own process between launcher and engine is
    // absent for a check or two. Reverting there would flip the power plan
    // across a loading screen.
    if (state.missedTicks < GONE_TICKS) continue;

    state.running = false;
    state.missedTicks = 0;
    seen.set(profile.id, state);
    if (trigger.revertOnExit) await deactivate(profile);
  }
}

async function tick() {
  try {
    const names = await processes.runningNames();
    await evaluate(names);
  } catch (err) {
    // A failed process listing is a bad moment, not a broken watcher.
    log.debug(`Auslöser-Durchlauf übersprungen: ${err.message}`);
  }
}

function anyEnabled() {
  return (store.state.profiles || []).some((p) => sanitize(p.trigger).enabled);
}

/**
 * Starts or stops the watcher to match the configuration.
 *
 * Called again whenever a profile changes, so a hub with no triggers set up
 * never polls at all.
 */
function refresh() {
  const wanted = anyEnabled();
  if (wanted && !timer) {
    timer = setInterval(tick, TICK_MS);
    if (timer.unref) timer.unref();
    log.info('Profil-Auslöser aktiv');
  } else if (!wanted && timer) {
    clearInterval(timer);
    timer = null;
    seen.clear();
    log.info('Profil-Auslöser aus, kein Profil nutzt sie');
  }
  return { watching: !!timer };
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  seen.clear();
}

module.exports = {
  defaults,
  sanitize,
  watchNames,
  list,
  evaluate,
  refresh,
  stop,
  setNotifier,
  TICK_MS,
  GONE_TICKS,
  // Test seam: the watcher's memory between passes.
  _seen: seen
};
