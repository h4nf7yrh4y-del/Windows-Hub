'use strict';

/**
 * Matching a saved monitor choice to a monitor that is actually connected.
 *
 * Electron's display ids are not stable: they change when a monitor is
 * unplugged, when the machine reboots, and sometimes after a driver update.
 * Storing only the id would mean a hub that quietly opens on the wrong screen
 * one morning, which is exactly the kind of fault nobody reports as a bug.
 * The fallback chain is therefore what these assertions are about.
 */

const assert = require('assert');
const Module = require('module');

/* --------------------------------------------------------------- fake screen */

let displays = [];
let primaryId = 1;

// screens.js pulls in electron for `screen`; in plain Node that resolves to a
// path string, so the module is loaded against a stand-in instead.
const realResolve = Module._resolveFilename;
const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') {
    return {
      screen: {
        getAllDisplays: () => displays,
        getPrimaryDisplay: () => displays.find((d) => d.id === primaryId) || displays[0]
      }
    };
  }
  return realLoad.call(this, request, parent, isMain);
};

const screens = require('../src/main/screens');
Module._load = realLoad;
Module._resolveFilename = realResolve;

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

const display = (id, label, x, width = 1920, height = 1080) => ({
  id,
  label,
  bounds: { x, y: 0, width, height },
  workArea: { x, y: 0, width, height: height - 48 },
  size: { width, height },
  scaleFactor: 1,
  rotation: 0
});

console.log('Bildschirmwahl');

/* ------------------------------------------------------------------- list */

displays = [display(2, 'DELL U2720Q', 1920), display(1, 'LG 27GL850', 0)];
primaryId = 1;

test('displays are listed left to right, not in driver order', () => {
  assert.deepStrictEqual(screens.list().map((d) => d.label), ['LG 27GL850', 'DELL U2720Q']);
});

test('the primary display is marked as such', () => {
  const list = screens.list();
  assert.strictEqual(list.find((d) => d.label === 'LG 27GL850').primary, true);
  assert.strictEqual(list.find((d) => d.label === 'DELL U2720Q').primary, false);
});

/* ---------------------------------------------------------------- resolve */

test('no saved choice means the primary display', () => {
  assert.strictEqual(screens.resolve(null).display.id, 1);
  assert.strictEqual(screens.resolve(null).match, 'primary');
  assert.strictEqual(screens.resolve('nonsense').match, 'primary');
});

test('a matching id wins outright', () => {
  const saved = screens.remember(displays[0]);
  const result = screens.resolve(saved);
  assert.strictEqual(result.display.id, 2);
  assert.strictEqual(result.match, 'id');
});

test('a monitor that came back under a new id is found by name and place', () => {
  const saved = screens.remember(displays[0]);
  displays = [display(77, 'DELL U2720Q', 1920), display(1, 'LG 27GL850', 0)];
  const result = screens.resolve(saved);
  assert.strictEqual(result.display.id, 77, 'the same monitor, renumbered');
  assert.strictEqual(result.match, 'label');
});

test('a monitor that kept its place but lost its name is still found', () => {
  displays = [display(88, '', 1920), display(1, 'LG 27GL850', 0)];
  const result = screens.resolve({ id: 2, label: 'DELL U2720Q', x: 1920, y: 0 });
  assert.strictEqual(result.display.id, 88);
  assert.strictEqual(result.match, 'position');
});

test('a monitor that moved but kept its name is found by name alone', () => {
  displays = [display(99, 'DELL U2720Q', 3840), display(1, 'LG 27GL850', 0)];
  const result = screens.resolve({ id: 2, label: 'DELL U2720Q', x: 1920, y: 0 });
  assert.strictEqual(result.display.id, 99);
  assert.strictEqual(result.match, 'label-only');
});

test('an unplugged monitor falls back to the primary and says so', () => {
  displays = [display(1, 'LG 27GL850', 0)];
  const result = screens.resolve({ id: 2, label: 'DELL U2720Q', x: 1920, y: 0 });
  assert.strictEqual(result.display.id, 1);
  assert.strictEqual(result.match, 'fallback', 'the interface has to be able to tell the user');
});

/* -------------------------------------------------------------- otherThan */

test('with one monitor there is no second screen to offer', () => {
  displays = [display(1, 'LG 27GL850', 0)];
  assert.strictEqual(screens.otherThan(displays[0]), null);
});

test('with two monitors the other one is offered', () => {
  displays = [display(1, 'LG 27GL850', 0), display(2, 'DELL U2720Q', 1920)];
  assert.strictEqual(screens.otherThan(displays[0]).id, 2);
  assert.strictEqual(screens.otherThan(displays[1]).id, 1);
});

/* --------------------------------------------------------------- remember */

test('a remembered choice keeps more than the id', () => {
  const saved = screens.remember(displays[1]);
  assert.strictEqual(saved.id, 2);
  assert.strictEqual(saved.label, 'DELL U2720Q');
  assert.strictEqual(saved.x, 1920);
  assert.ok(saved.width > 0, 'without the size a stale entry cannot be recognised');
});

test('remembering nothing is not an error', () => {
  assert.strictEqual(screens.remember(null), null);
});

console.log(`\n${passed} assertions passed.`);
