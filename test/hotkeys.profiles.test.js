'use strict';

/**
 * A key that starts one profile.
 *
 * What can go quietly wrong here is a binding that looks set and never fires:
 * two profiles on the same key, a key that is already a hub action, a key left
 * pointing at a profile that was deleted. None of those look like errors --
 * they look like a hotkey that does nothing, which people blame on the key.
 *
 * Electron is stubbed, because `globalShortcut` needs a real app. The stub
 * answers the way Windows does: a combination that is already taken comes back
 * as a bare `false`.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-hotkey-'));

// What the fake system has already given away, so a second attempt fails the
// way the real one does.
const owned = new Set();
let registrations = [];

const stub = {
  app: { getPath: () => TMP, getVersion: () => '0.0.0', isPackaged: false },
  globalShortcut: {
    register(accelerator, handler) {
      if (owned.has(accelerator)) return false;
      owned.add(accelerator);
      registrations.push({ accelerator, handler });
      return true;
    },
    unregister(accelerator) { owned.delete(accelerator); },
    unregisterAll() { owned.clear(); }
  }
};

const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

const store = require('../src/main/store');
const hotkeys = require('../src/main/hotkeys');

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

function seed(profiles) {
  owned.clear();
  registrations = [];
  hotkeys.dispose();
  store.state.profiles = profiles;
  store.state.hotkeys = { toggleHub: '', toggleOverlays: '', openClaude: '', toggleDashboard: '' };
  return hotkeys.init({}, { onProfile: (id) => { seed.lastLaunched = id; } });
}

const profile = (id, name, hotkey) => ({ id, name, apps: [], hotkey });

console.log('Profil-Tastenkürzel');

/* ----------------------------------------------------------------- binding */

test('a profile with a key gets one', () => {
  seed([profile('a', 'Gaming', 'Alt+Shift+1')]);
  const list = hotkeys.listProfiles();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].accelerator, 'Alt+Shift+1');
  assert.strictEqual(list[0].active, true);
});

test('a profile without one is not listed', () => {
  seed([profile('a', 'Gaming', ''), profile('b', 'Arbeit', undefined)]);
  assert.deepStrictEqual(hotkeys.listProfiles(), []);
});

test('pressing the key launches that profile and no other', () => {
  seed([profile('a', 'Gaming', 'Alt+Shift+1'), profile('b', 'Arbeit', 'Alt+Shift+2')]);
  const second = registrations.find((r) => r.accelerator === 'Alt+Shift+2');
  second.handler();
  assert.strictEqual(seed.lastLaunched, 'b');
});

/* --------------------------------------------------------------- collisions */

test('two profiles on the same key: the second is refused, not silently dropped', () => {
  // Both would look bound in the editor, and only one would ever fire.
  const results = seed([profile('a', 'Erst', 'Alt+Shift+1'), profile('b', 'Zweit', 'Alt+Shift+1')]);
  const refused = results.filter((r) => r.profileId && !r.ok);
  assert.strictEqual(refused.length, 1);
  assert.ok(/vergeben/.test(refused[0].reason), refused[0].reason);
  assert.strictEqual(refused[0].profileId, 'b');
});

test('a key already used by a hub action is refused', () => {
  owned.clear();
  registrations = [];
  hotkeys.dispose();
  store.state.profiles = [profile('a', 'Gaming', 'Alt+Shift+H')];
  store.state.hotkeys = { toggleHub: 'Alt+Shift+H', toggleOverlays: '', openClaude: '', toggleDashboard: '' };

  const results = hotkeys.init({ toggleHub: () => {} }, { onProfile: () => {} });
  const mine = results.find((r) => r.profileId === 'a');
  assert.strictEqual(mine.ok, false);
  assert.ok(/vergeben/.test(mine.reason), mine.reason);
  // And the hub action keeps working: a profile must not take a key away.
  assert.ok(registrations.some((r) => r.accelerator === 'Alt+Shift+H'));
});

test('a refused binding is reported as inactive, not as bound', () => {
  seed([profile('a', 'Erst', 'Alt+Shift+1'), profile('b', 'Zweit', 'Alt+Shift+1')]);
  const second = hotkeys.listProfiles().find((entry) => entry.profileId === 'b');
  assert.strictEqual(second.active, false, 'a key that never fires must not look bound');
});

/* ------------------------------------------------------------- rebinding */

test('a removed profile gives its key back', () => {
  seed([profile('a', 'Gaming', 'Alt+Shift+1')]);
  store.state.profiles = [];
  hotkeys.applyProfiles();
  assert.deepStrictEqual(hotkeys.listProfiles(), []);
  assert.strictEqual(owned.has('Alt+Shift+1'), false, 'the key is free again');
});

test('a key moved to another profile follows', () => {
  seed([profile('a', 'Erst', 'Alt+Shift+1'), profile('b', 'Zweit', '')]);
  store.state.profiles = [profile('a', 'Erst', ''), profile('b', 'Zweit', 'Alt+Shift+1')];
  registrations = [];
  hotkeys.applyProfiles();

  const list = hotkeys.listProfiles();
  assert.deepStrictEqual(list.map((e) => e.profileId), ['b']);
  registrations.find((r) => r.accelerator === 'Alt+Shift+1').handler();
  assert.strictEqual(seed.lastLaunched, 'b');
});

test('rebinding twice does not leave a stale registration', () => {
  // Everything is unregistered first on purpose: working out which single
  // binding changed would be a second source of truth.
  seed([profile('a', 'Gaming', 'Alt+Shift+1')]);
  hotkeys.applyProfiles();
  hotkeys.applyProfiles();
  assert.strictEqual(hotkeys.listProfiles().length, 1);
  assert.strictEqual(hotkeys.listProfiles()[0].active, true);
});

/* -------------------------------------------------------------- validation */

test('the same rule as the settings panel applies', () => {
  // A bare letter registered globally swallows that key in every other
  // application, which is a trap rather than a feature.
  assert.ok(hotkeys.validate('A'), 'a bare key must be refused');
  assert.ok(hotkeys.validate('Alt'), 'modifiers alone must be refused');
  assert.strictEqual(hotkeys.validate('Alt+Shift+1'), null);
  assert.strictEqual(hotkeys.validate(''), null, 'empty means unbound');
});

hotkeys.dispose();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
console.log(`\n${passed} assertions passed.`);
