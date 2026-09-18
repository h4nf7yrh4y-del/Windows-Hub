'use strict';

/**
 * What the tray's profile menu offers.
 *
 * Kept separate from `Menu.buildFromTemplate` and from the click handler,
 * which would launch a real profile -- this tests only the shaping, per the
 * rule against logic tests that touch anything that starts a process.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tray-'));

const realResolve = Module._resolveFilename;
const stub = { app: { getPath: () => TMP, getVersion: () => '0.0.0', isPackaged: false }, shell: {} };
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

const tray = require('../src/main/tray');

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

console.log('Ablage');

test('a profile becomes a label and an id', () => {
  const entries = tray.profileEntries([{ id: 'a', name: 'Gaming' }]);
  assert.deepStrictEqual(entries, [{ id: 'a', label: 'Gaming' }]);
});

test('no profiles is an empty list, not a crash', () => {
  assert.deepStrictEqual(tray.profileEntries([]), []);
  assert.deepStrictEqual(tray.profileEntries(null), []);
  assert.deepStrictEqual(tray.profileEntries(undefined), []);
});

test('a broken entry does not take the menu down', () => {
  // The config is plain JSON on disk and people edit it.
  const entries = tray.profileEntries([null, { id: 'a' }, { name: 'Ohne Kennung' }, { id: 'b', name: 'Gut' }]);
  assert.deepStrictEqual(entries, [{ id: 'b', label: 'Gut' }]);
});

test('order is preserved, since that is the order the profiles were created in', () => {
  const entries = tray.profileEntries([{ id: 'a', name: 'Erst' }, { id: 'b', name: 'Zweit' }]);
  assert.deepStrictEqual(entries.map((e) => e.label), ['Erst', 'Zweit']);
});

console.log(`\n${passed} assertions passed.`);
