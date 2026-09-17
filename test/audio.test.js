'use strict';

/**
 * Switching the default playback device.
 *
 * None of the switching can run here: it needs Windows, a compiled C# helper
 * and real audio hardware. What can be checked is the gate in front of it --
 * the device id ends up interpolated into a PowerShell string, so its shape is
 * decided by a function of its own that runs before the platform is looked at.
 * Behind the platform guard it would only ever run on Windows, which is to say
 * never in a test.
 *
 * The second thing worth pinning down is that a profile carrying a device id
 * counts as having system changes at all. Without that, `apply` returns early,
 * the switch never happens, and nothing anywhere says why.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-audio-'));

const realResolve = Module._resolveFilename;
const stub = {
  app: { getPath: () => TMP, getVersion: () => '0.0.0', isPackaged: false },
  shell: {},
  powerSaveBlocker: { start: () => 1, stop: () => {}, isStarted: () => false }
};
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

const audio = require('../src/main/audio');
const tweaks = require('../src/main/tweaks');

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

// The shape Windows actually uses for a render endpoint.
const REAL_ID = '{0.0.0.00000000}.{a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d}';

console.log('Wiedergabegerät');

/* ------------------------------------------------------------- the gate */

add('a real endpoint id passes', () => {
  assert.strictEqual(audio.checkDeviceId(REAL_ID), REAL_ID);
});

add('anything that is not one is refused', () => {
  // The value is interpolated into a PowerShell string, so the shape is the
  // whole defence.
  assert.throws(() => audio.checkDeviceId('Speakers'), /Gerätekennung/);
  assert.throws(() => audio.checkDeviceId(''), /Gerätekennung/);
  assert.throws(() => audio.checkDeviceId(null), /Gerätekennung/);
  assert.throws(() => audio.checkDeviceId('{0.0.0.00000000}'), /Gerätekennung/);
});

add('a quote cannot travel inside an id', () => {
  // A single quote would end the PowerShell literal it is placed in.
  assert.throws(() => audio.checkDeviceId(`${REAL_ID}'; calc; '`), /Gerätekennung/);
  assert.throws(() => audio.checkDeviceId("{0.0.0.0}.{'}"), /Gerätekennung/);
});

add('a bad id is refused as a bad id on every platform', async () => {
  // The refusal has to read the same everywhere. If the shape check sat behind
  // the platform guard, this would come back as "Windows only" off Windows and
  // the check itself would never be exercised.
  await assert.rejects(audio.setDefault('nonsense'), /Gerätekennung/);
  await assert.rejects(audio.setDefault(''), /Gerätekennung/);
});

/*
 * There is deliberately no case here that calls setDefault or list with
 * something valid.
 *
 * The first version did, asserting that a well-formed id "stops at the
 * platform guard". On Windows there is no guard to stop at: the call went
 * through, compiled the C# helper, asked Windows to switch to a device the
 * runner does not have, and held the test run open for five minutes waiting
 * for the PowerShell host to go idle. Which is both of this project's rules
 * about tests at once -- a test that calls an action performs it, and logic
 * tests do not touch anything that starts a process.
 *
 * What those cases were really about is the ordering of the check, and that is
 * covered above: the refusal works on any machine, which is only possible
 * because the check runs first. The real device list is exercised by the
 * interface tests, which start the actual application.
 */

/* ---------------------------------------------------- the profile setting */

add('a stored device id survives sanitising', () => {
  const system = tweaks.sanitize({ audioDevice: REAL_ID });
  assert.strictEqual(system.audioDevice, REAL_ID);
});

add('a hand-edited config cannot smuggle one in', () => {
  // The config file is plain JSON on disk and people do edit it.
  assert.strictEqual(tweaks.sanitize({ audioDevice: "'; calc; '" }).audioDevice, null);
  assert.strictEqual(tweaks.sanitize({ audioDevice: 'Speakers' }).audioDevice, null);
  assert.strictEqual(tweaks.sanitize({ audioDevice: 42 }).audioDevice, null);
});

add('a profile with only a device still counts as changing the system', () => {
  // Otherwise apply() returns early, the switch never happens, and nothing
  // says why.
  assert.strictEqual(tweaks.isActive({ audioDevice: REAL_ID }), true);
  assert.strictEqual(tweaks.isActive({}), false);
});

add('the default is not to touch the audio', () => {
  assert.strictEqual(tweaks.defaults().audioDevice, null);
});

(async () => {
  for (const [name, fn] of queue) await test(name, fn);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  console.log(`\n${passed} assertions passed.`);
})();
