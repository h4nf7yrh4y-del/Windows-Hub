'use strict';

/**
 * When a desktop notification is worth showing.
 *
 * `show` itself constructs an Electron Notification and is not testable
 * without a real app; the decision in front of it is, and it is the whole
 * feature. The case that matters is the one that is easy to get backwards:
 * the hub already shows a toast for everything it does, so notifying while
 * someone is looking at the hub is how an application teaches people to
 * dismiss its notifications unread.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-notify-'));

const realResolve = Module._resolveFilename;
const stub = {
  app: { getPath: () => TMP, getVersion: () => '0.0.0', isPackaged: false },
  Notification: { isSupported: () => false }
};
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

const notify = require('../src/main/notify');

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

console.log('Benachrichtigungen');

test('hidden hub, switched on, supported: shown', () => {
  assert.strictEqual(notify.shouldNotify({ supported: true, enabled: true, visible: false }), true);
});

test('nothing is shown while the hub is the window on screen', () => {
  // The toast already said it. Saying it twice is how notifications get
  // dismissed without being read.
  assert.strictEqual(notify.shouldNotify({ supported: true, enabled: true, visible: true }), false);
});

test('switched off means off, even when nobody is looking', () => {
  assert.strictEqual(notify.shouldNotify({ supported: true, enabled: false, visible: false }), false);
});

test('a platform without notifications is not an error, just silence', () => {
  assert.strictEqual(notify.shouldNotify({ supported: false, enabled: true, visible: false }), false);
});

test('unsupported beats every other reason to show one', () => {
  assert.strictEqual(notify.shouldNotify({ supported: false, enabled: true, visible: true }), false);
  assert.strictEqual(notify.shouldNotify({ supported: false, enabled: false, visible: false }), false);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
console.log(`\n${passed} assertions passed.`);
