'use strict';

const crypto = require('crypto');
const store = require('./store');
const logger = require('./logger');

const log = logger.scoped('trash');

/**
 * Deleted profiles, kept for a while.
 *
 * A profile is twenty minutes of work: the programs, their order, the system
 * changes, the process names that could not be derived automatically. Deleting
 * one took a single click and a confirmation, and afterwards there was nothing
 * -- the backup helps only whoever remembered to take one before.
 *
 * Two weeks is long enough to notice the mistake and short enough that the
 * config file does not become an archive. Emptying is manual as well, because
 * a bin that quietly disposes of things on a schedule is the same problem in
 * slower motion: the entries go at the moment nobody is looking.
 */

const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
// Enough to undo a bad afternoon, not enough to hide a runaway.
const MAX_ENTRIES = 40;

function bin() {
  const state = store.state;
  if (!Array.isArray(state.trash)) state.trash = [];
  return state.trash;
}

/**
 * Drops what is past its date.
 *
 * Called on read rather than on a timer. A timer would have to survive
 * restarts to be worth anything, and the only moment the answer matters is
 * when someone looks.
 */
function prune() {
  const now = Date.now();
  const entries = bin();
  const kept = entries.filter((entry) => entry && entry.deletedAt && now - entry.deletedAt < KEEP_MS);
  if (kept.length !== entries.length) {
    store.state.trash = kept;
    store.save();
  }
  return store.state.trash;
}

function remember(profile) {
  if (!profile || !profile.id) return null;
  const entries = prune();

  const entry = {
    // Its own id: the profile can be restored and deleted again, and two bin
    // entries for the same profile must not collide.
    id: `trash-${crypto.randomUUID()}`,
    deletedAt: Date.now(),
    profile: JSON.parse(JSON.stringify(profile))
  };

  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  store.save();
  log.info(`„${profile.name}" in den Papierkorb gelegt`);
  return entry;
}

/** What the interface shows: enough to recognise it, not the whole profile. */
function list() {
  return prune().map((entry) => ({
    id: entry.id,
    deletedAt: entry.deletedAt,
    expiresAt: entry.deletedAt + KEEP_MS,
    name: entry.profile.name,
    accent: entry.profile.accent,
    apps: (entry.profile.apps || []).length
  }));
}

/**
 * Puts one back.
 *
 * The profile keeps its old id unless something already holds it -- restoring
 * over a profile that was recreated in the meantime would replace work rather
 * than recover it. A fresh id makes it a copy, which is recoverable; the
 * alternative is not.
 */
function restore(id) {
  const entries = prune();
  const index = entries.findIndex((entry) => entry.id === String(id || ''));
  if (index < 0) throw new Error('Dieser Eintrag ist nicht mehr im Papierkorb');

  const [entry] = entries.splice(index, 1);
  const profile = entry.profile;
  const profiles = store.state.profiles || [];

  let renamed = false;
  if (profiles.some((existing) => existing.id === profile.id)) {
    profile.id = crypto.randomUUID();
    profile.name = `${profile.name} (wiederhergestellt)`;
    renamed = true;
  }

  profiles.push(profile);
  store.state.profiles = profiles;
  store.save();
  log.info(`„${profile.name}" wiederhergestellt`);
  return { profile, renamed };
}

function drop(id) {
  const entries = prune();
  const before = entries.length;
  store.state.trash = entries.filter((entry) => entry.id !== String(id || ''));
  store.save();
  return { removed: before - store.state.trash.length };
}

function empty() {
  const count = bin().length;
  store.state.trash = [];
  store.save();
  if (count) log.info(`Papierkorb geleert (${count} Einträge)`);
  return { removed: count };
}

module.exports = { remember, list, restore, drop, empty, prune, KEEP_MS, MAX_ENTRIES };
