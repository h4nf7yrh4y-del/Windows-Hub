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

/* ---------------------------------------------------------- whole desktop */
/*
 * The snapshot taken before a profile rearranges the desk. Nothing here calls
 * the system: `holdDesktop` and `restoreDesktop` run PowerShell, and a logic
 * test that touches those is how a Linux-green suite hung the Windows runner
 * for five minutes on a warming host.
 */

console.log('\nDesktop-Schnappschuss');

test('the desktop is one entry per program, largest window first seen', () => {
  const entries = layout.desktopFrom([
    win('explorer', 0, 0, 600, 400),
    win('explorer', 100, 100, 1200, 900),
    win('code', 50, 50, 1400, 1000)
  ]);
  assert.deepStrictEqual(entries.map((e) => e.process), ['explorer', 'code']);
  // The bigger Explorer window wins, which is the documented limit rather than
  // an accident: three file windows come back as one.
  assert.strictEqual(entries[0].width, 1200);
});

test('a desktop snapshot may hold far more than a profile layout', () => {
  const many = Array.from({ length: 40 }, (_, i) => win(`prog${i}`, i, i, 800, 600));
  assert.strictEqual(layout.desktopFrom(many).length, 40);
  // The profile layout keeps its own, much smaller bound.
  assert.strictEqual(layout.sanitizeLayout(layout.desktopFrom(many)).length, layout.MAX_ENTRIES);
});

test('the desktop bound is a ceiling, not a suggestion', () => {
  const many = Array.from({ length: layout.DESKTOP_MAX + 25 }, (_, i) => win(`prog${i}`, i, i, 800, 600));
  assert.strictEqual(layout.desktopFrom(many).length, layout.DESKTOP_MAX);
  // Asking for more than the ceiling does not raise it.
  assert.strictEqual(layout.sanitizeLayout(layout.desktopFrom(many), 500).length, layout.DESKTOP_MAX);
});

test('a window too small to put back is not remembered', () => {
  // Same rule as a profile entry: a 20x10 rectangle restored is a lost window.
  assert.deepStrictEqual(layout.desktopFrom([win('tiny', 0, 0, 20, 10)]), []);
});

test('nothing is remembered for a profile that never held a desktop', () => {
  assert.deepStrictEqual(layout.heldDesktop('kein-profil'), []);
  assert.strictEqual(layout.forgetDesktop('kein-profil'), false);
});

/* --------------------------------------------- two profiles, one desktop */
/*
 * "Close everything" can meet two profiles that each remembered the desktop.
 * The order they are merged in is the whole question, and getting it backwards
 * is invisible: the windows go somewhere, just not where they started.
 */

const snap = (at, entries) => ({ at, entries: layout.sanitizeLayout(entries, layout.DESKTOP_MAX) });

test('for a program both remember, the older snapshot wins', () => {
  // The newer one already describes a desk the first profile had rearranged,
  // so it is the wrong answer however reasonable it looks.
  const merged = layout.mergeHeld([
    snap(2000, [{ process: 'code', x: 900, y: 0, width: 1000, height: 900 }]),
    snap(1000, [{ process: 'code', x: 100, y: 100, width: 1200, height: 800 }])
  ]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].x, 100, 'the position from before anything was touched');
});

test('programs only one of them knows are kept', () => {
  const merged = layout.mergeHeld([
    snap(1000, [{ process: 'code', x: 0, y: 0, width: 800, height: 600 }]),
    snap(2000, [{ process: 'firefox', x: 50, y: 50, width: 900, height: 700 }])
  ]);
  assert.deepStrictEqual(merged.map((e) => e.process).sort(), ['code', 'firefox']);
});

test('a snapshot without a time is treated as the oldest', () => {
  // Missing rather than wrong: sorting it to the back would let a later
  // snapshot overwrite it, which is the one outcome to avoid.
  const merged = layout.mergeHeld([
    snap(5000, [{ process: 'code', x: 900, y: 0, width: 800, height: 600 }]),
    { entries: layout.sanitizeLayout([{ process: 'code', x: 10, y: 10, width: 800, height: 600 }]) }
  ]);
  assert.strictEqual(merged[0].x, 10);
});

test('merging nothing, or nonsense, yields an empty layout', () => {
  assert.deepStrictEqual(layout.mergeHeld([]), []);
  assert.deepStrictEqual(layout.mergeHeld(null), []);
  assert.deepStrictEqual(layout.mergeHeld([null, {}, { entries: 'nope' }]), []);
});

test('the merge is bounded like every other layout here', () => {
  const many = (offset) => Array.from({ length: 40 }, (_, i) => (
    { process: `prog${i + offset}`, x: i, y: i, width: 800, height: 600 }
  ));
  const merged = layout.mergeHeld([snap(1000, many(0)), snap(2000, many(100))]);
  assert.strictEqual(merged.length, layout.DESKTOP_MAX);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
console.log(`\n${passed} assertions passed.`);
