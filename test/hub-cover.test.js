'use strict';

/**
 * Which app id a profile's cover art belongs to.
 *
 * Read out of the launch URI on purpose, not a separate stored field --
 * `scanner.js` already writes `steam://rungameid/<id>` for every Steam
 * entry, and keeping a second copy of the same id current would be a
 * second place for it to go stale.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/js/views/hub.js'), 'utf8');
const start = source.indexOf('/* ------------------------------------------------------------------- pure */');
const end = source.indexOf('/* --------------------------------------------------------------- end pure */');
assert.ok(start >= 0 && end > start, 'the pure region markers are gone from hub.js');
const body = source.slice(start, end).replace(/^function/gm, 'function');
// eslint-disable-next-line no-new-func
const { steamAppId } = new Function(`${body}; return { steamAppId };`)();

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

const steamApp = (id) => ({ enabled: true, launch: { type: 'uri', target: `steam://rungameid/${id}` } });
const exe = (target) => ({ enabled: true, launch: { type: 'exe', target } });

console.log('Titelbild');

test('a Steam entry gives up its app id', () => {
  assert.strictEqual(steamAppId([steamApp('1145360')]), '1145360');
});

test('a profile with no Steam entry has no cover', () => {
  assert.strictEqual(steamAppId([exe('C:/Spotify/Spotify.exe')]), null);
  assert.strictEqual(steamAppId([]), null);
  assert.strictEqual(steamAppId(null), null);
});

test('a disabled Steam entry does not count', () => {
  // A disabled entry is not part of what the profile actually launches.
  const disabled = { ...steamApp('1145360'), enabled: false };
  assert.strictEqual(steamAppId([disabled]), null);
});

test('the first Steam entry wins, matching the "one game per profile" idea', () => {
  assert.strictEqual(steamAppId([exe('C:/Discord/Discord.exe'), steamApp('1145360'), steamApp('570')]), '1145360');
});

test('a malformed entry is skipped, not thrown on', () => {
  assert.strictEqual(steamAppId([null, { enabled: true }, steamApp('570')]), '570');
});

test('an app id of zero is not a valid Steam app id', () => {
  assert.strictEqual(steamAppId([steamApp('0')]), null);
});

console.log(`\n${passed} assertions passed.`);
