'use strict';

/**
 * Which window gets moved where.
 *
 * Only the pure half is exercised here. `list`, `move` and `apply` all reach
 * Win32 through the PowerShell host, and a logic test that calls them would
 * start that host on the Windows runner and move real windows around -- the
 * mistake this project has already paid for three times elsewhere.
 *
 * What is left is exactly where this feature is right or wrong: picking one
 * window out of several belonging to the same program, and deciding whether a
 * position recorded on a monitor arrangement still means anything today.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-winlayout-'));

const realResolve = Module._resolveFilename;
const stub = { app: { getPath: () => TMP, getVersion: () => '0.0.0', isPackaged: false }, shell: {} };
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

const layout = require('../src/main/windowlayout');

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

const win = (process, x, y, width, height, extra = {}) =>
  ({ process, x, y, width, height, handle: 1, ...extra });

console.log('Fensterlayout');

/* ------------------------------------------------------------ process keys */

test('a process is compared without path, extension or case', () => {
  assert.strictEqual(layout.processKey('C:\\Program Files\\Discord\\Discord.exe'), 'discord');
  assert.strictEqual(layout.processKey('Spotify.EXE'), 'spotify');
  assert.strictEqual(layout.processKey('steam'), 'steam');
});

test('nothing usable is an empty key, not a crash', () => {
  assert.strictEqual(layout.processKey(''), '');
  assert.strictEqual(layout.processKey(null), '');
  assert.strictEqual(layout.processKey(undefined), '');
});

/* --------------------------------------------------------------- entries */

test('a position is kept whole', () => {
  const entry = layout.sanitizeEntry({ process: 'Discord.exe', x: 100, y: 200, width: 800, height: 600 });
  assert.deepStrictEqual(entry, { process: 'discord', x: 100, y: 200, width: 800, height: 600, maximized: false });
});

test('a negative coordinate survives, because a left-hand monitor has them', () => {
  // A second screen placed to the left of the primary one sits at negative x.
  // Refusing that would make the feature useless on exactly the setup it is
  // for.
  const entry = layout.sanitizeEntry({ process: 'discord', x: -1920, y: 0, width: 800, height: 600 });
  assert.strictEqual(entry.x, -1920);
});

test('a window with no size is refused rather than stored', () => {
  // Putting it back at zero width is indistinguishable from losing it.
  assert.strictEqual(layout.sanitizeEntry({ process: 'discord', x: 0, y: 0, width: 0, height: 600 }), null);
  assert.strictEqual(layout.sanitizeEntry({ process: 'discord', x: 0, y: 0, width: 800, height: 10 }), null);
});

test('nonsense in, nothing out', () => {
  assert.strictEqual(layout.sanitizeEntry(null), null);
  assert.strictEqual(layout.sanitizeEntry({ x: 1, y: 2, width: 800, height: 600 }), null);
  assert.strictEqual(layout.sanitizeEntry({ process: 'discord', x: 'links', y: 2, width: 800, height: 600 }), null);
});

test('one entry per process, and the list is bounded', () => {
  const many = Array.from({ length: layout.MAX_ENTRIES + 5 },
    (_, i) => ({ process: `p${i}`, x: 0, y: 0, width: 800, height: 600 }));
  assert.strictEqual(layout.sanitizeLayout(many).length, layout.MAX_ENTRIES);

  const duplicated = layout.sanitizeLayout([
    { process: 'discord', x: 0, y: 0, width: 800, height: 600 },
    { process: 'Discord.exe', x: 50, y: 50, width: 900, height: 700 }
  ]);
  assert.strictEqual(duplicated.length, 1);
  assert.strictEqual(duplicated[0].x, 0, 'the first one wins');
});

test('a layout that is not a list is simply empty', () => {
  assert.deepStrictEqual(layout.sanitizeLayout(null), []);
  assert.deepStrictEqual(layout.sanitizeLayout('discord'), []);
});

/* ------------------------------------------------------------ picking one */

test('the largest window of a program is the one that gets moved', () => {
  // A chat client's main window against its own settings dialog: area is the
  // only signal available that does not need a list of special cases.
  const picked = layout.pickWindow([
    win('discord', 0, 0, 400, 300),
    win('discord', 100, 100, 1200, 800),
    win('spotify', 0, 0, 1600, 900)
  ], 'discord');
  assert.strictEqual(picked.width, 1200);
});

test('a program that is not running yields nothing', () => {
  assert.strictEqual(layout.pickWindow([win('spotify', 0, 0, 800, 600)], 'discord'), null);
  assert.strictEqual(layout.pickWindow([], 'discord'), null);
  assert.strictEqual(layout.pickWindow(null, 'discord'), null);
});

test('matching ignores case and extension on both sides', () => {
  const picked = layout.pickWindow([win('Discord', 0, 0, 800, 600)], 'discord.exe');
  assert.ok(picked);
});

/* --------------------------------------------------------------- monitors */

const MONITORS = [
  { x: 0, y: 0, width: 1920, height: 1040, primary: true },
  { x: 1920, y: 0, width: 2560, height: 1400 }
];

test('a position on a connected monitor is placeable', () => {
  const entry = layout.sanitizeEntry({ process: 'discord', x: 2000, y: 100, width: 800, height: 600 });
  assert.strictEqual(layout.fitsAnyMonitor(entry, MONITORS), true);
});

test('a position on a monitor that is gone is refused', () => {
  // Recorded on a third screen that is not plugged in today. Placing the
  // window there would put it somewhere nobody can reach.
  const entry = layout.sanitizeEntry({ process: 'discord', x: 5000, y: 100, width: 800, height: 600 });
  assert.strictEqual(layout.fitsAnyMonitor(entry, MONITORS), false);
});

test('a window hanging off an edge on purpose is still placeable', () => {
  // Someone who likes it half off the right edge should keep it there.
  const entry = layout.sanitizeEntry({ process: 'discord', x: 1500, y: 100, width: 800, height: 600 });
  assert.strictEqual(layout.fitsAnyMonitor(entry, MONITORS), true);
});

test('a sliver of overlap is not enough to count', () => {
  const entry = layout.sanitizeEntry({ process: 'discord', x: -790, y: 100, width: 800, height: 600 });
  assert.strictEqual(layout.fitsAnyMonitor(entry, MONITORS), false);
});

test('without any monitor information nothing is claimed to fit', () => {
  const entry = layout.sanitizeEntry({ process: 'discord', x: 100, y: 100, width: 800, height: 600 });
  assert.strictEqual(layout.fitsAnyMonitor(entry, []), false);
  assert.strictEqual(layout.fitsAnyMonitor(entry, null), false);
});

/* -------------------------------------------------------------- snapshot */

test('a snapshot records only the programs that were asked for', () => {
  const entries = layout.snapshotFrom([
    win('discord', 10, 20, 800, 600),
    win('spotify', 30, 40, 900, 700),
    win('explorer', 0, 0, 1000, 800)
  ], ['Discord.exe', 'spotify']);

  assert.deepStrictEqual(entries.map((e) => e.process), ['discord', 'spotify']);
  assert.strictEqual(entries[0].x, 10);
});

test('a program without a window is left out, not stored empty', () => {
  const entries = layout.snapshotFrom([win('discord', 10, 20, 800, 600)], ['discord', 'spotify']);
  assert.deepStrictEqual(entries.map((e) => e.process), ['discord']);
});

test('a maximized window is remembered as maximized', () => {
  const entries = layout.snapshotFrom([win('discord', 0, 0, 1920, 1040, { maximized: true })], ['discord']);
  assert.strictEqual(entries[0].maximized, true);
});

test('asking for the same program twice records it once', () => {
  const entries = layout.snapshotFrom([win('discord', 0, 0, 800, 600)], ['discord', 'Discord.exe']);
  assert.strictEqual(entries.length, 1);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
console.log(`\n${passed} assertions passed.`);
