'use strict';

const crypto = require('crypto');
const store = require('./store');
const launcher = require('./launcher');
const logger = require('./logger');

const log = logger.scoped('scheduler');

/**
 * Starts and stops profiles at a time of day.
 *
 * The interesting decision here is what to do about time that has already
 * passed. A schedule set for 20:00 on a machine that was switched on at 23:00
 * must not launch a game three hours late, so a due entry is only run inside a
 * short window after its time; outside it the entry is quietly marked as
 * handled for that day. Anything else turns a convenience into an ambush.
 *
 * The tick is thirty seconds, which is the resolution a minute-based schedule
 * needs and cheap enough to run all day.
 */

const TICK_MS = 30000;
const CATCH_UP_MS = 5 * 60 * 1000;

const DAY_LABELS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

const ACTIONS = {
  launch: { label: 'Profil starten' },
  stop: { label: 'Profil beenden' }
};

let timer = null;
let notify = () => {};

/* ---------------------------------------------------------------- helpers */

function entries() {
  const state = store.state;
  if (!Array.isArray(state.schedules)) state.schedules = [];
  return state.schedules;
}

function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes, text: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}` };
}

function sanitize(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Eintrag fehlt');
  const time = parseTime(raw.time);
  if (!time) throw new Error('Uhrzeit muss im Format HH:MM stehen');
  const profileId = typeof raw.profileId === 'string' ? raw.profileId.trim() : '';
  if (!profileId) throw new Error('Kein Profil gewählt');
  const days = Array.isArray(raw.days)
    ? [...new Set(raw.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : [];
  if (!days.length) throw new Error('Mindestens ein Wochentag muss gewählt sein');

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    profileId,
    action: ACTIONS[raw.action] ? raw.action : 'launch',
    time: time.text,
    days,
    enabled: raw.enabled !== false,
    lastRun: Number(raw.lastRun) || 0
  };
}

/** The moment an entry is due on a given day, or null if that day is not chosen. */
function dueAt(entry, reference) {
  if (!entry.days.includes(reference.getDay())) return null;
  const parsed = parseTime(entry.time);
  if (!parsed) return null;
  const due = new Date(reference);
  due.setHours(parsed.hours, parsed.minutes, 0, 0);
  return due.getTime();
}

/** The next time an entry will fire, looking up to a week ahead. */
function nextRun(entry, from = new Date()) {
  if (!entry.enabled) return null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = new Date(from);
    day.setDate(day.getDate() + offset);
    const due = dueAt(entry, day);
    if (due === null) continue;
    if (due > from.getTime()) return due;
  }
  return null;
}

function describe(entry) {
  const all = entry.days.length === 7;
  const weekdays = entry.days.length === 5 && entry.days.every((d) => d >= 1 && d <= 5);
  const weekend = entry.days.length === 2 && entry.days.includes(0) && entry.days.includes(6);
  const days = all ? 'täglich' : weekdays ? 'Mo–Fr' : weekend ? 'Sa + So' : entry.days.map((d) => DAY_LABELS[d]).join(', ');
  return `${days} um ${entry.time}`;
}

/* ------------------------------------------------------------------ ticks */

async function fire(entry) {
  const profile = store.state.profiles.find((p) => p.id === entry.profileId);
  if (!profile) {
    log.warn(`Zeitplan ${entry.id} verweist auf ein gelöschtes Profil`);
    return;
  }

  log.info(`Zeitplan: ${ACTIONS[entry.action].label} · ${profile.name}`);
  try {
    if (entry.action === 'stop') {
      await launcher.stopProfile(profile);
    } else {
      await launcher.launchProfile(profile, (event) => notify('profile:progress', event));
      profile.lastLaunched = Date.now();
      profile.launchCount = (profile.launchCount || 0) + 1;
    }
    notify('schedule:fired', { id: entry.id, profileId: profile.id, profileName: profile.name, action: entry.action, ok: true });
  } catch (err) {
    log.error(`Zeitplan fehlgeschlagen: ${err.message}`);
    notify('schedule:fired', { id: entry.id, profileId: profile.id, profileName: profile.name, action: entry.action, ok: false, error: err.message });
  }
}

async function tick() {
  const list = entries();
  if (!list.length) return;

  const now = new Date();
  let changed = false;

  for (const entry of list) {
    if (!entry.enabled) continue;
    const due = dueAt(entry, now);
    if (due === null) continue;
    if (now.getTime() < due) continue;
    // Already handled for this occurrence.
    if (entry.lastRun >= due) continue;

    entry.lastRun = due;
    changed = true;

    if (now.getTime() - due > CATCH_UP_MS) {
      // The machine was off or asleep when this was due. Marking it as handled
      // above is the whole point: a game must not start hours late because a
      // laptop was opened in the evening.
      log.info(`Zeitplan ${entry.id} übersprungen, Zeitpunkt liegt ${Math.round((now.getTime() - due) / 60000)} Minuten zurück`);
      continue;
    }

    await fire(entry);
  }

  if (changed) store.save();
}

function start(notifier) {
  if (typeof notifier === 'function') notify = notifier;
  if (timer) return;

  // Everything that was due before this start is marked as handled, so nothing
  // from earlier today fires just because the hub was opened.
  const now = new Date();
  let changed = false;
  for (const entry of entries()) {
    const due = dueAt(entry, now);
    if (due !== null && now.getTime() - due > CATCH_UP_MS && entry.lastRun < due) {
      entry.lastRun = due;
      changed = true;
    }
  }
  if (changed) store.save();

  timer = setInterval(() => { tick().catch((err) => log.error(err.message)); }, TICK_MS);
  if (timer.unref) timer.unref();
  log.info(`Zeitplan aktiv · ${entries().length} Einträge`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/* -------------------------------------------------------------------- API */

function list() {
  const now = new Date();
  return {
    actions: Object.entries(ACTIONS).map(([value, spec]) => ({ value, ...spec })),
    dayLabels: DAY_LABELS,
    entries: entries().map((entry) => ({
      ...entry,
      description: describe(entry),
      nextRun: nextRun(entry, now)
    }))
  };
}

function save(raw) {
  const entry = sanitize(raw);
  const list_ = entries();
  const index = list_.findIndex((e) => e.id === entry.id);

  // A new or retimed entry must not fire for a moment that has already passed
  // today, so its own occurrence today counts as handled.
  const now = new Date();
  const due = dueAt(entry, now);
  if (due !== null && due <= now.getTime()) entry.lastRun = due;

  if (index >= 0) list_[index] = entry;
  else list_.push(entry);
  store.save();
  return { ...entry, description: describe(entry), nextRun: nextRun(entry, now) };
}

function remove(id) {
  const list_ = entries();
  const before = list_.length;
  store.state.schedules = list_.filter((e) => e.id !== id);
  store.save();
  return { removed: before - store.state.schedules.length };
}

async function runNow(id) {
  const entry = entries().find((e) => e.id === id);
  if (!entry) throw new Error('Eintrag nicht gefunden');
  await fire(entry);
  return { ok: true };
}

module.exports = {
  start, stop, list, save, remove, runNow,
  // Exported for the tests: the time arithmetic is where this can go wrong.
  sanitize, parseTime, dueAt, nextRun, describe, DAY_LABELS, ACTIONS, CATCH_UP_MS
};
