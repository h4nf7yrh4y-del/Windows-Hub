'use strict';

/**
 * The disk report.
 *
 * What is worth testing here is the judgement, not the reading: how long ago
 * counts as "cold", what a missing timestamp means, and whether a game id on
 * its way into an uninstall URI is checked before anything is executed. The
 * numbers themselves come from Steam's own manifests.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// `electron` is a path string outside a real Electron process; the modules
// under test only need `app.getPath` while loading.
const realResolve = Module._resolveFilename;
const stub = { app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0', isPackaged: false }, shell: {} };
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

const storage = require('../src/main/storage');

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

const DAY = 24 * 60 * 60 * 1000;

console.log('Speicher');

/* ------------------------------------------------------------- judgements */

add('a game played today is not stale', () => {
  const days = storage.daysSince(Date.now() - 3600 * 1000);
  assert.strictEqual(days, 0);
  assert.strictEqual(storage.staleness(days), 'recent');
});

add('a year of silence reads as cold', () => {
  const days = storage.daysSince(Date.now() - 400 * DAY);
  assert.ok(days > 365, String(days));
  assert.strictEqual(storage.staleness(days), 'cold');
});

add('the boundaries fall where the labels say', () => {
  assert.strictEqual(storage.staleness(30), 'recent');
  assert.strictEqual(storage.staleness(31), 'idle');
  assert.strictEqual(storage.staleness(180), 'idle');
  assert.strictEqual(storage.staleness(181), 'cold');
});

add('never launched is unknown, not brand new', () => {
  // Steam writes zero for a game it has never started. Treating that as
  // "played just now" would hide exactly the candidates this view exists for.
  assert.strictEqual(storage.daysSince(0), null);
  assert.strictEqual(storage.daysSince(null), null);
  assert.strictEqual(storage.staleness(null), 'unknown');
});

add('a timestamp in the future does not produce negative days', () => {
  // A clock that went backwards, or a manifest from another machine.
  assert.strictEqual(storage.daysSince(Date.now() + 10 * DAY), 0);
});

/* ------------------------------------------------------------------ drive */

add('the drive letter is taken from the path', () => {
  assert.strictEqual(storage.driveOf('D:\\SteamLibrary\\steamapps\\common\\Game'), 'D:');
  assert.strictEqual(storage.driveOf('c:/games'), 'C:');
});

add('a path without a letter yields nothing rather than a guess', () => {
  assert.strictEqual(storage.driveOf('/home/user/games'), null);
  assert.strictEqual(storage.driveOf(''), null);
  assert.strictEqual(storage.driveOf(null), null);
});

/* ------------------------------------------------------------ uninstalling */

add('an uninstall needs a numeric game id', () => {
  // The value ends up in a steam:// URI handed to the shell, so it is checked
  // in a function of its own, before the platform is looked at.
  assert.throws(() => storage.uninstallUri('abc'), /Kennung/);
  assert.throws(() => storage.uninstallUri('../../evil'), /Kennung/);
  assert.throws(() => storage.uninstallUri('553850; calc'), /Kennung/);
  assert.throws(() => storage.uninstallUri(''), /Kennung/);
  assert.throws(() => storage.uninstallUri(null), /Kennung/);
});

add('a real id produces the documented address', () => {
  assert.strictEqual(storage.uninstallUri('553850'), 'steam://uninstall/553850');
});

add('the uninstall refuses a bad id before it reaches the shell', async () => {
  await assert.rejects(storage.uninstallSteamGame('nope'), /Kennung/);
});

/* -------------------------------------------------------------- measuring */

add('a directory is added up, subdirectories included', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-storage-'));
  fs.writeFileSync(path.join(root, 'a.bin'), Buffer.alloc(1000));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'b.bin'), Buffer.alloc(2500));

  const result = await storage.measure(root);
  assert.strictEqual(result.bytes, 3500);
  assert.strictEqual(result.files, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

add('an empty directory measures zero rather than failing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-storage-empty-'));
  const result = await storage.measure(root);
  assert.strictEqual(result.bytes, 0);
  assert.strictEqual(result.files, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

add('a relative or missing path is refused', async () => {
  await assert.rejects(storage.measure('relative/path'), /Ordner/);
  await assert.rejects(storage.measure(''), /Ordner/);
  await assert.rejects(storage.measure(null), /Ordner/);
});

add('a directory that does not exist yields zero, not an exception', async () => {
  // A library on an unplugged drive is the normal case for this, and it must
  // not take the whole report down with it.
  const result = await storage.measure(path.join(os.tmpdir(), 'hub-does-not-exist-12345'));
  assert.strictEqual(result.bytes, 0);
});

(async () => {
  for (const [name, fn] of queue) await test(name, fn);
  console.log(`\n${passed} assertions passed.`);
})();
