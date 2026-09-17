'use strict';

/**
 * Taking the configuration out and putting it back.
 *
 * Two things here can lose someone's work, so they are what the cases are
 * about: an import that accepts a file it does not understand, and an import
 * that discards profiles when it was only meant to add them. Everything else
 * is JSON.
 *
 * The third thing worth checking is what does *not* travel. The config holds
 * state that only means something on this machine -- chiefly the record of
 * system changes waiting to be undone -- and carrying that to another machine
 * would leave the hub believing it has changes to revert that it never made.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-backup-'));

const realResolve = Module._resolveFilename;
const stub = { app: { getPath: () => TMP, getVersion: () => '0.0.0', isPackaged: false }, shell: {} };
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

const store = require('../src/main/store');
const backup = require('../src/main/backup');

let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

const queue = [];
const add = (name, fn) => queue.push([name, fn]);

console.log('Sicherung');

function seed() {
  const state = store.state;
  state.profiles = [
    { id: 'a', name: 'Alpha', apps: [] },
    { id: 'b', name: 'Beta', apps: [] }
  ];
  state.schedules = [{ id: 's1', profileId: 'a', time: '20:00' }];
  state.settings = { ...state.settings, accent: '#123456' };
  state.tweakSnapshot = { profileId: 'a', profileName: 'Alpha', at: 1, closed: ['chrome'] };
  state.playSessions = [{ profileId: 'a', start: 1, end: 2, ms: 1 }];
  state.claudeSessions = ['session-xyz'];
  return state;
}

/* ------------------------------------------------------------- what travels */

add('the backup carries the things that mean something anywhere', () => {
  seed();
  const payload = backup.build();
  assert.strictEqual(payload.format, 'windows-hub-backup');
  assert.strictEqual(payload.data.profiles.length, 2);
  assert.strictEqual(payload.data.schedules.length, 1);
  assert.strictEqual(payload.data.settings.accent, '#123456');
});

add('machine-only state is left behind', () => {
  seed();
  const payload = backup.build();
  // A snapshot of pending system changes restored on another machine would
  // have the hub trying to undo a power plan it never switched.
  assert.strictEqual(payload.data.tweakSnapshot, undefined);
  assert.strictEqual(payload.data.playSessions, undefined);
  assert.strictEqual(payload.data.claudeSessions, undefined);
  assert.strictEqual(payload.data.lastProfileId, undefined);
});

add('every omission has a stated reason', () => {
  // So the interface can say what it did not take rather than quietly not
  // taking it.
  for (const [key, why] of Object.entries(backup.MACHINE_ONLY)) {
    assert.ok(why && why.length > 10, `${key} needs a reason`);
  }
});

add('the suggested name sorts by date', () => {
  assert.ok(/^windows-hub-\d{4}-\d{2}-\d{2}\.json$/.test(backup.suggestedName()), backup.suggestedName());
});

/* ------------------------------------------------------------- refusing junk */

add('something that is not JSON is refused by name', () => {
  assert.throws(() => backup.inspect('nicht mal annähernd json'), /JSON/);
  assert.throws(() => backup.inspect(''), /JSON/);
});

add('someone else\'s JSON is refused', () => {
  // A folder full of .json files is the normal case for picking the wrong one.
  assert.throws(() => backup.inspect('{"some":"other file"}'), /Windows Hub/);
  assert.throws(() => backup.inspect('[1,2,3]'), /Windows Hub/);
});

add('a backup from a newer format is refused rather than half-read', () => {
  const text = JSON.stringify({ format: 'windows-hub-backup', formatVersion: 99, data: {} });
  assert.throws(() => backup.inspect(text), /neueren/);
});

add('a valid backup is summarised before anything is written', () => {
  seed();
  const summary = backup.inspect(JSON.stringify(backup.build()));
  assert.strictEqual(summary.profiles, 2);
  assert.deepStrictEqual(summary.profileNames, ['Alpha', 'Beta']);
  assert.strictEqual(summary.schedules, 1);
  assert.strictEqual(summary.hasSettings, true);
});

/* ---------------------------------------------------------------- importing */

add('an unknown mode is refused, not guessed', async () => {
  // One of the two modes discards profiles.
  seed();
  const text = JSON.stringify(backup.build());
  await assert.rejects(backup.importFrom(text, { mode: 'quatsch' }), /Modus/);
  await assert.rejects(backup.importFrom(text, { mode: 'REPLACE' }), /Modus/);
});

add('merging adds what is new and keeps what is not in the file', async () => {
  seed();
  const text = JSON.stringify({
    format: 'windows-hub-backup',
    formatVersion: 1,
    data: { profiles: [{ id: 'c', name: 'Gamma', apps: [] }] }
  });

  const report = await backup.importFrom(text, { mode: 'merge' });
  assert.strictEqual(report.added, 1);
  const ids = store.state.profiles.map((p) => p.id).sort();
  assert.deepStrictEqual(ids, ['a', 'b', 'c'], 'nothing was lost');
});

add('merging replaces a profile with the same id', async () => {
  seed();
  const text = JSON.stringify({
    format: 'windows-hub-backup',
    formatVersion: 1,
    data: { profiles: [{ id: 'a', name: 'Alpha neu', apps: [] }] }
  });

  const report = await backup.importFrom(text, { mode: 'merge' });
  assert.strictEqual(report.updated, 1);
  assert.strictEqual(report.added, 0);
  assert.strictEqual(store.state.profiles.length, 2, 'no duplicate');
  assert.strictEqual(store.state.profiles.find((p) => p.id === 'a').name, 'Alpha neu');
});

add('replacing discards what was there, and only then', async () => {
  seed();
  const text = JSON.stringify({
    format: 'windows-hub-backup',
    formatVersion: 1,
    data: { profiles: [{ id: 'z', name: 'Zeta', apps: [] }] }
  });

  await backup.importFrom(text, { mode: 'replace' });
  assert.deepStrictEqual(store.state.profiles.map((p) => p.id), ['z']);
});

add('a profile without an id or a name is dropped rather than stored', async () => {
  // These break the profile list in ways that show up much later.
  seed();
  const text = JSON.stringify({
    format: 'windows-hub-backup',
    formatVersion: 1,
    data: { profiles: [{ name: 'Ohne Kennung' }, { id: 'ok', name: 'Gut' }, null, 'string'] }
  });

  await backup.importFrom(text, { mode: 'replace' });
  assert.deepStrictEqual(store.state.profiles.map((p) => p.id), ['ok']);
});

add('settings are merged so an old backup does not remove new ones', async () => {
  seed();
  store.state.settings.gamepad = true;
  const text = JSON.stringify({
    format: 'windows-hub-backup',
    formatVersion: 1,
    data: { settings: { accent: '#abcdef' } }
  });

  await backup.importFrom(text, { mode: 'merge' });
  assert.strictEqual(store.state.settings.accent, '#abcdef');
  assert.strictEqual(store.state.settings.gamepad, true, 'a setting the backup never knew about survives');
});

add('the monitor choice from another machine is not adopted', async () => {
  // A display id means nothing on a different set of monitors; the second
  // screen would open somewhere that does not exist.
  seed();
  store.state.dashboard = { enabled: false, display: 'local-monitor', autoOpen: false };
  const text = JSON.stringify({
    format: 'windows-hub-backup',
    formatVersion: 1,
    data: { dashboard: { enabled: true, display: 'fremder-monitor', autoOpen: true } }
  });

  await backup.importFrom(text, { mode: 'merge' });
  assert.strictEqual(store.state.dashboard.enabled, true, 'the switch travels');
  assert.strictEqual(store.state.dashboard.display, 'local-monitor', 'the monitor does not');
});

add('a copy of the previous configuration is left behind', async () => {
  seed();
  store.save();
  const text = JSON.stringify({ format: 'windows-hub-backup', formatVersion: 1, data: { profiles: [] } });

  const report = await backup.importFrom(text, { mode: 'replace' });
  assert.ok(report.previousConfig, 'the path is reported');
  assert.ok(fs.existsSync(report.previousConfig), `expected a copy at ${report.previousConfig}`);
});

/* ---------------------------------------------------------------- exporting */

add('the exported file can be read back', async () => {
  seed();
  const target = path.join(TMP, 'out', 'backup.json');
  const result = await backup.exportTo(target);
  assert.strictEqual(result.profiles, 2);
  assert.ok(result.bytes > 0);

  const summary = backup.inspect(fs.readFileSync(target, 'utf8'));
  assert.strictEqual(summary.profiles, 2);
});

add('a relative target is refused', async () => {
  await assert.rejects(backup.exportTo('irgendwo/backup.json'), /Zielpfad/);
  await assert.rejects(backup.exportTo(''), /Zielpfad/);
});

(async () => {
  for (const [name, fn] of queue) await test(name, fn);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  console.log(`\n${passed} assertions passed.`);
})();
