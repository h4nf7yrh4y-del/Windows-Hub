'use strict';

/**
 * Validating a Steam app id before it becomes a URL or a file name.
 *
 * `get()` is deliberately not exercised here with anything that looks like
 * a real app id: that would be a genuine HTTPS request to Steam's CDN,
 * which a logic test must not make any more than it may spawn a process --
 * flaky, slow, and answering a question this file is not asking. Only the
 * refusal of a bad id, before any network access, is checked.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-coverart-'));

const realResolve = Module._resolveFilename;
const stub = { app: { getPath: () => TMP, getVersion: () => '0.0.0', isPackaged: false } };
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

const coverart = require('../src/main/coverart');

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

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('Titelbild-Cache');

test('a real-looking app id builds the expected CDN url', () => {
  assert.strictEqual(coverart.urlFor('1145360'),
    'https://cdn.akamai.steamstatic.com/steam/apps/1145360/header.jpg');
});

test('a leading zero, letters, or emptiness are refused before any url is built', () => {
  assert.throws(() => coverart.urlFor('0145360'));
  assert.throws(() => coverart.urlFor('abc'));
  assert.throws(() => coverart.urlFor(''));
  assert.throws(() => coverart.urlFor('123; rm -rf'));
});

(async () => {
  await testAsync('an invalid id is refused without touching the network', async () => {
    const result = await coverart.get('not-an-id');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'ungueltige-id');
  });

  await testAsync('a missing id is refused the same way', async () => {
    const result = await coverart.get(null);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'ungueltige-id');
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  console.log(`\n${passed} assertions passed.`);
})();
