'use strict';

/**
 * Deleted profiles, kept for a while.
 *
 * The bin exists because deleting a profile was one click and twenty minutes
 * of work. What it must not do is create a second way to lose something:
 * restoring over a profile that was recreated in the meantime would replace
 * work rather than recover it, and an entry that expired without anyone
 * noticing is the original problem in slower motion.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-trash-'));

const realResolve = Module._resolveFilename;
const stub = { app: { getPath: () => TMP, getVersion: () => '0.0.0', isPackaged: false }, shell: {} };
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

const store = require('../src/main/store');
const trash = require('../src/main/trash');

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

const profile = (id, name, extra = {}) => ({
  id, name, accent: '#00f0ff', apps: [{ name: 'Spiel', enabled: true }], ...extra
});

function reset() {
  store.state.profiles = [];
  store.state.trash = [];
}

console.log('Papierkorb');

/* ------------------------------------------------------------- remembering */

test('a deleted profile is kept whole, not as a name', () => {
  // Restoring a name would be no better than writing it down on paper.
  reset();
  trash.remember(profile('a', 'Gaming', { hotkey: 'Alt+Shift+1', tagline: 'Abends' }));
  const restored = trash.restore(trash.list()[0].id).profile;
  assert.strictEqual(restored.hotkey, 'Alt+Shift+1');
  assert.strictEqual(restored.tagline, 'Abends');
  assert.strictEqual(restored.apps.length, 1);
});

test('the copy is independent of the original', () => {
  // The profile object goes on living in the caller; a shared reference would
  // let later edits rewrite history.
  reset();
  const original = profile('a', 'Gaming');
  trash.remember(original);
  original.name = 'Umbenannt';
  original.apps.push({ name: 'Noch was' });
  assert.strictEqual(trash.list()[0].name, 'Gaming');
  assert.strictEqual(trash.list()[0].apps, 1);
});

test('the newest deletion is first', () => {
  reset();
  trash.remember(profile('a', 'Erst'));
  trash.remember(profile('b', 'Zweit'));
  assert.deepStrictEqual(trash.list().map((e) => e.name), ['Zweit', 'Erst']);
});

test('nonsense is not remembered', () => {
  reset();
  assert.strictEqual(trash.remember(null), null);
  assert.strictEqual(trash.remember({ name: 'Ohne Kennung' }), null);
  assert.deepStrictEqual(trash.list(), []);
});

test('the same profile deleted twice makes two entries', () => {
  // It can be restored and deleted again; two entries must not collide.
  reset();
  trash.remember(profile('a', 'Gaming'));
  trash.remember(profile('a', 'Gaming'));
  const ids = trash.list().map((e) => e.id);
  assert.strictEqual(new Set(ids).size, 2, ids.join(', '));
});

/* -------------------------------------------------------------- restoring */

test('a restored profile is back in the list and gone from the bin', () => {
  reset();
  trash.remember(profile('a', 'Gaming'));
  const result = trash.restore(trash.list()[0].id);
  assert.strictEqual(result.renamed, false);
  assert.deepStrictEqual(store.state.profiles.map((p) => p.id), ['a']);
  assert.deepStrictEqual(trash.list(), []);
});

test('restoring onto an id that is taken makes a copy, and says so', () => {
  // Someone recreated the profile in the meantime. Overwriting it would
  // destroy the newer work to recover the older -- the exact thing the bin
  // exists to prevent.
  reset();
  trash.remember(profile('a', 'Gaming'));
  store.state.profiles = [profile('a', 'Neu gebaut')];

  const result = trash.restore(trash.list()[0].id);
  assert.strictEqual(result.renamed, true);
  assert.notStrictEqual(result.profile.id, 'a');
  assert.ok(/wiederhergestellt/.test(result.profile.name), result.profile.name);
  assert.strictEqual(store.state.profiles.length, 2, 'both survive');
  assert.strictEqual(store.state.profiles.find((p) => p.id === 'a').name, 'Neu gebaut');
});

test('restoring something that is not there says so', () => {
  reset();
  assert.throws(() => trash.restore('gibt-es-nicht'), /Papierkorb/);
  assert.throws(() => trash.restore(''), /Papierkorb/);
});

/* -------------------------------------------------------------- discarding */

test('dropping takes exactly one', () => {
  reset();
  trash.remember(profile('a', 'Erst'));
  trash.remember(profile('b', 'Zweit'));
  const target = trash.list().find((e) => e.name === 'Erst');
  assert.strictEqual(trash.drop(target.id).removed, 1);
  assert.deepStrictEqual(trash.list().map((e) => e.name), ['Zweit']);
});

test('emptying reports what it removed', () => {
  reset();
  trash.remember(profile('a', 'Erst'));
  trash.remember(profile('b', 'Zweit'));
  assert.strictEqual(trash.empty().removed, 2);
  assert.deepStrictEqual(trash.list(), []);
});

/* ---------------------------------------------------------------- expiry */

test('an entry past its date is gone', () => {
  reset();
  trash.remember(profile('a', 'Alt'));
  store.state.trash[0].deletedAt = Date.now() - trash.KEEP_MS - 1000;
  assert.deepStrictEqual(trash.list(), []);
});

test('an entry inside its date survives', () => {
  reset();
  trash.remember(profile('a', 'Frisch'));
  store.state.trash[0].deletedAt = Date.now() - trash.KEEP_MS + 60000;
  assert.strictEqual(trash.list().length, 1);
});

test('the listing says how long is left', () => {
  reset();
  trash.remember(profile('a', 'Gaming'));
  const entry = trash.list()[0];
  assert.ok(entry.expiresAt > Date.now(), 'there has to be time left');
  assert.ok(entry.expiresAt - entry.deletedAt === trash.KEEP_MS);
});

test('the bin does not grow without bound', () => {
  // Enough to undo a bad afternoon, not enough to turn the config into an
  // archive.
  reset();
  for (let i = 0; i < trash.MAX_ENTRIES + 10; i += 1) trash.remember(profile(`p${i}`, `Profil ${i}`));
  assert.strictEqual(trash.list().length, trash.MAX_ENTRIES);
  // And it is the oldest that go, not the newest.
  assert.strictEqual(trash.list()[0].name, `Profil ${trash.MAX_ENTRIES + 9}`);
});

test('a broken entry does not take the listing down', () => {
  // The config is plain JSON on disk and people edit it.
  reset();
  store.state.trash = [null, { id: 'x' }, { id: 'y', deletedAt: Date.now(), profile: { name: 'Gut', apps: [] } }];
  const list = trash.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'Gut');
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
console.log(`\n${passed} assertions passed.`);
