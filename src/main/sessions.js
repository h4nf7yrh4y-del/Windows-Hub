'use strict';

const store = require('./store');
const processes = require('./processes');
const launcher = require('./launcher');
const logger = require('./logger');

const log = logger.scoped('sessions');

/**
 * How long a profile actually ran.
 *
 * A launcher that knows what it started and when can answer the question people
 * actually have about their own machine — how much time went into which
 * profile this week — and it needs no new data source to do it: the same
 * process-name check that drives the running indicator.
 *
 * Tracking is bounded on purpose. It starts when a profile is launched and
 * stops once none of its programs are alive any more, so an idle hub polls
 * nothing. A session is only recorded once its programs are gone, which is also
 * why a hub that is killed mid-game loses that session: writing a start time
 * that never gets an end would produce a fourteen-hour session the next time
 * the numbers were read, and a missing session is a smaller lie than a wrong
 * one.
 */

const TICK_MS = 30000;
// Two consecutive empty polls before a session is considered over. A game that
// drops to a launcher for a moment should not split into two sessions.
const GRACE_TICKS = 2;
const MAX_SESSIONS = 2000;
// Anything shorter is a mistaken launch, not a session worth counting.
const MIN_SESSION_MS = 60000;

let timer = null;
const watched = new Map(); // profileId -> { names, startedAt, seenAt, missedTicks, everSeen }

function sessions() {
  const state = store.state;
  if (!Array.isArray(state.playSessions)) state.playSessions = [];
  return state.playSessions;
}

function record(profileId, startedAt, endedAt) {
  const ms = endedAt - startedAt;
  if (ms < MIN_SESSION_MS) return null;
  const list = sessions();
  const entry = { profileId, start: startedAt, end: endedAt, ms };
  list.push(entry);
  if (list.length > MAX_SESSIONS) list.splice(0, list.length - MAX_SESSIONS);
  store.save();
  log.info(`Sitzung erfasst: ${Math.round(ms / 60000)} min`);
  return entry;
}

/** Begins watching a profile. Called when it is launched. */
function watch(profile) {
  if (!profile) return;
  const { names } = launcher.stopPlan(profile);
  if (!names.length) {
    // Nothing identifiable to watch. Saying so beats silently recording
    // nothing and leaving the user to wonder why the numbers stay at zero.
    log.info(`„${profile.name}" hat keine erkennbaren Prozesse, keine Zeitmessung`);
    return;
  }

  watched.set(profile.id, {
    names: names.map((n) => n.toLowerCase()),
    startedAt: Date.now(),
    seenAt: Date.now(),
    missedTicks: 0,
    everSeen: false
  });
  start();
}

async function tick() {
  if (!watched.size) { stop(); return; }

  let names;
  try {
    names = new Set((await processes.runningNames()).map((n) => String(n).toLowerCase()));
  } catch (err) {
    // A failed poll is not evidence that anything stopped.
    log.debug(`Prozessliste nicht lesbar: ${err.message}`);
    return;
  }

  const now = Date.now();
  for (const [profileId, entry] of [...watched.entries()]) {
    const alive = entry.names.some((name) => names.has(name));

    if (alive) {
      entry.everSeen = true;
      entry.seenAt = now;
      entry.missedTicks = 0;
      continue;
    }

    entry.missedTicks += 1;
    if (entry.missedTicks < GRACE_TICKS) continue;

    // Never seen alive at all: the launch failed, or the programs are named
    // something else. Either way there is no session to record.
    if (entry.everSeen) record(profileId, entry.startedAt, entry.seenAt);
    watched.delete(profileId);
  }

  if (!watched.size) stop();
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch((err) => log.error(err.message)); }, TICK_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Ends tracking immediately, e.g. because the profile was stopped by hand. */
function release(profileId) {
  const entry = watched.get(profileId);
  if (!entry) return null;
  watched.delete(profileId);
  if (!watched.size) stop();
  return entry.everSeen ? record(profileId, entry.startedAt, Date.now()) : null;
}

/* ------------------------------------------------------------- statistics */

function since(days) {
  return Date.now() - days * 24 * 3600 * 1000;
}

function sum(list) {
  return list.reduce((total, entry) => total + (entry.ms || 0), 0);
}

/**
 * Totals per profile over a few windows.
 *
 * Profiles that were deleted keep their recorded time under their id, so the
 * caller can decide whether to show them; dropping the rows would quietly
 * rewrite the past.
 */
function stats() {
  const list = sessions();
  const profiles = store.state.profiles || [];
  const week = since(7);
  const month = since(30);

  const rows = profiles.map((profile) => {
    const own = list.filter((entry) => entry.profileId === profile.id);
    return {
      profileId: profile.id,
      name: profile.name,
      accent: profile.accent,
      sessions: own.length,
      totalMs: sum(own),
      weekMs: sum(own.filter((e) => e.end >= week)),
      monthMs: sum(own.filter((e) => e.end >= month)),
      lastEnd: own.length ? Math.max(...own.map((e) => e.end)) : 0,
      longestMs: own.length ? Math.max(...own.map((e) => e.ms)) : 0,
      running: watched.has(profile.id)
    };
  }).sort((a, b) => b.weekMs - a.weekMs || b.totalMs - a.totalMs);

  const orphanIds = new Set(list.map((e) => e.profileId));
  for (const profile of profiles) orphanIds.delete(profile.id);
  const orphan = list.filter((e) => orphanIds.has(e.profileId));

  // One bar per day for the last two weeks, for a shape rather than a number.
  const days = [];
  for (let i = 13; i >= 0; i -= 1) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() - i);
    const dayEnd = dayStart.getTime() + 24 * 3600 * 1000;
    days.push({
      at: dayStart.getTime(),
      ms: sum(list.filter((e) => e.end >= dayStart.getTime() && e.end < dayEnd))
    });
  }

  return {
    rows,
    days,
    totalMs: sum(list),
    weekMs: sum(list.filter((e) => e.end >= week)),
    sessionCount: list.length,
    deletedProfilesMs: sum(orphan),
    tracking: [...watched.keys()]
  };
}

function clear() {
  store.state.playSessions = [];
  store.save();
  return { ok: true };
}

module.exports = { watch, release, stats, clear, stop, MIN_SESSION_MS, GRACE_TICKS };
