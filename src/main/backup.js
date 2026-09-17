'use strict';

const fs = require('fs');
const path = require('path');

const store = require('./store');
const logger = require('./logger');

const log = logger.scoped('backup');

/**
 * Taking the configuration out and putting it back.
 *
 * Everything the hub knows lives in one JSON file, so this could have been
 * "copy that file" -- except for two things that make a straight copy the
 * wrong answer.
 *
 * The file holds state that only means something on this machine: which power
 * plan was switched away from before a profile started, which console sessions
 * exist, which monitor the hub opened on. Restoring a snapshot of that on
 * another machine would leave the hub believing it has changes to undo that it
 * never made. Those fields are left out on the way out, and ignored on the way
 * back in.
 *
 * And an import is a destructive operation on the thing the user cares about
 * most. It refuses anything it cannot recognise, it can add instead of
 * replace, and it writes a copy of what was there before either way.
 */

const FORMAT = 'windows-hub-backup';
const FORMAT_VERSION = 1;

/*
 * What travels, and what does not.
 *
 * `include` is a list rather than a filter of `exclude`, because the failure
 * modes point opposite ways: a new field nobody added to an exclude list ends
 * up in the backup and comes back on another machine; a new field nobody added
 * to the include list is merely missing. Missing is the failure worth having.
 */
const INCLUDE = ['settings', 'profiles', 'library', 'schedules', 'dashboard'];

// Kept out on purpose, each for its own reason.
const MACHINE_ONLY = {
  tweakSnapshot: 'beschreibt Systemänderungen dieses Rechners, die zurückgenommen werden müssen',
  claudeSessions: 'verweist auf Sitzungen, die nur lokal existieren',
  playSessions: 'ist die Spielzeit dieses Rechners',
  lastProfileId: 'ist der Zustand dieses Fensters'
};

/** The object written to disk. */
function build() {
  const state = store.state;
  const data = {};
  for (const key of INCLUDE) {
    if (state[key] !== undefined) data[key] = state[key];
  }

  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    schemaVersion: store.SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    // Not the machine name: a backup is a file people mail to themselves, and
    // the hostname is not theirs to spread.
    app: 'Windows Hub',
    data
  };
}

/** A filename that sorts by date and needs no explanation. */
function suggestedName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `windows-hub-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

async function exportTo(target) {
  const file = String(target || '');
  if (!file || !path.isAbsolute(file)) throw new Error('Kein gültiger Zielpfad');

  const payload = build();
  const text = JSON.stringify(payload, null, 2);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, text, 'utf8');

  log.info(`Sicherung geschrieben: ${payload.data.profiles ? payload.data.profiles.length : 0} Profile`);
  return {
    file,
    bytes: Buffer.byteLength(text, 'utf8'),
    profiles: (payload.data.profiles || []).length,
    schedules: (payload.data.schedules || []).length,
    // Named so the interface can say what was deliberately not taken along.
    omitted: Object.entries(MACHINE_ONLY).map(([key, why]) => ({ key, why }))
  };
}

/**
 * Reads a backup and says what is in it, without changing anything.
 *
 * Its own step because "import" on a file the user picked from a folder full
 * of JSON should not be a guess. A wrong file is refused by name, and a right
 * one is summarised before anything is overwritten.
 */
function inspect(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch (err) {
    throw new Error(`Die Datei ist kein gültiges JSON: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object') throw new Error('Die Datei enthält kein Objekt');
  if (parsed.format !== FORMAT) {
    throw new Error('Das ist keine Sicherung des Windows Hub');
  }
  if (Number(parsed.formatVersion) > FORMAT_VERSION) {
    throw new Error(`Die Sicherung stammt aus einer neueren Fassung (Format ${parsed.formatVersion})`);
  }

  const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];

  return {
    createdAt: parsed.createdAt || null,
    schemaVersion: Number(parsed.schemaVersion) || null,
    profiles: profiles.length,
    profileNames: profiles.map((p) => (p && typeof p.name === 'string' ? p.name : '?')).slice(0, 40),
    schedules: Array.isArray(data.schedules) ? data.schedules.length : 0,
    hasSettings: !!data.settings,
    customApps: data.library && Array.isArray(data.library.customApps) ? data.library.customApps.length : 0
  };
}

/**
 * Puts a backup back.
 *
 * `mode` is the whole decision:
 *   replace  the stored profiles become the ones in the file
 *   merge    profiles from the file are added, matching ids are updated
 *
 * Merge is the default because it is the recoverable one. Either way the
 * current configuration is copied next to itself first: an import is the one
 * operation here that can lose work, and an undo that exists on disk beats a
 * dialog asking whether the user is sure.
 */
async function importFrom(text, { mode = 'merge' } = {}) {
  if (mode !== 'merge' && mode !== 'replace') throw new Error(`Unbekannter Modus: ${mode}`);
  const summary = inspect(text);
  const parsed = JSON.parse(String(text));
  const data = parsed.data || {};

  const backupPath = `${store.configPath()}.vor-import-${Date.now()}`;
  try {
    await fs.promises.copyFile(store.configPath(), backupPath);
  } catch (err) {
    // A first run has no file to copy. Anything else is worth knowing about
    // before overwriting, but not worth refusing over.
    if (err.code !== 'ENOENT') log.warn(`Sicherheitskopie nicht möglich: ${err.message}`);
  }

  const state = store.state;
  const report = { mode, added: 0, updated: 0, kept: 0, settings: false, schedules: 0 };

  if (data.settings && typeof data.settings === 'object') {
    // Merged rather than assigned: a backup from an older build would
    // otherwise remove settings it never knew about.
    state.settings = { ...state.settings, ...data.settings };
    report.settings = true;
  }

  const incoming = Array.isArray(data.profiles) ? data.profiles.filter((p) => p && p.id && p.name) : [];
  if (mode === 'replace') {
    report.added = incoming.length;
    state.profiles = incoming;
  } else {
    const byId = new Map(state.profiles.map((p) => [p.id, p]));
    for (const profile of incoming) {
      if (byId.has(profile.id)) { byId.set(profile.id, profile); report.updated += 1; }
      else { byId.set(profile.id, profile); report.added += 1; }
    }
    report.kept = state.profiles.length - report.updated;
    state.profiles = [...byId.values()];
  }

  if (Array.isArray(data.schedules)) {
    state.schedules = mode === 'replace'
      ? data.schedules
      : [...state.schedules, ...data.schedules.filter((s) => s && s.id
        && !state.schedules.some((own) => own.id === s.id))];
    report.schedules = state.schedules.length;
  }

  if (data.library && Array.isArray(data.library.customApps)) {
    state.library = state.library || { customApps: [] };
    state.library.customApps = mode === 'replace'
      ? data.library.customApps
      : [...state.library.customApps, ...data.library.customApps];
  }

  if (data.dashboard && typeof data.dashboard === 'object') {
    // The monitor choice is left alone: a display id from another machine
    // means nothing here, and the second screen would open in the wrong place
    // or not at all.
    state.dashboard = { ...state.dashboard, enabled: !!data.dashboard.enabled };
  }

  store.save();
  log.info(`Sicherung eingelesen (${mode}): ${report.added} neu, ${report.updated} ersetzt`);
  return { ...report, summary, previousConfig: backupPath };
}

module.exports = {
  build,
  suggestedName,
  exportTo,
  inspect,
  importFrom,
  FORMAT,
  FORMAT_VERSION,
  INCLUDE,
  MACHINE_ONLY
};
