'use strict';

/**
 * Updating the hub itself.
 *
 * Almost nothing here can be exercised for real: a self-update needs a
 * packaged build, a release on GitHub and a version that is actually newer.
 * What can be checked is the part that decides what the interface offers --
 * whether this build may install an update at all, and whether a failure comes
 * back as a sentence instead of a stack trace. Both are the difference between
 * an honest screen and one that shows a button that cannot work.
 */

const assert = require('assert');
const Module = require('module');

/*
 * `electron` is a path string outside a real Electron process, so the module
 * under test cannot require it. The stub is the smallest thing that satisfies
 * it, and it is installed before the require rather than after, because the
 * module reads `process.platform` and `app.isPackaged` while loading.
 */
const realResolve = Module._resolveFilename;
const stub = {
  app: {
    isPackaged: false,
    getVersion: () => '9.9.9',
    getPath: () => '/tmp'
  }
};
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

const selfupdate = require('../src/main/selfupdate');

let passed = 0;

/**
 * Awaits the body.
 *
 * A synchronous runner calls an async case, throws the promise away and prints
 * "ok" whatever happened. One case here is async, and a test that checks
 * nothing looks exactly like one that passes.
 */
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

console.log('Selbst-Update');

/* ------------------------------------------------------------ what it may do */

add('a run from source says so instead of offering an update', () => {
  // `npm run dev` has no installation to replace. Reporting "up to date"
  // there would be a lie that looks like good news.
  const reason = selfupdate.blockedReason();
  assert.ok(reason, 'there must be a reason');
  assert.strictEqual(selfupdate.canInstall(), false);
});

add('the reason is a sentence, not a code', () => {
  const reason = selfupdate.blockedReason();
  assert.ok(reason.length > 20, reason);
  assert.ok(!/undefined|null|\[object/.test(reason), reason);
});

add('the state carries everything the interface needs to decide', () => {
  const state = selfupdate.state();
  for (const key of ['supported', 'reason', 'portable', 'packaged', 'status',
    'currentVersion', 'availableVersion', 'percent', 'releasesUrl']) {
    assert.ok(key in state, `missing ${key}`);
  }
  assert.strictEqual(typeof state.supported, 'boolean');
  assert.strictEqual(state.availableVersion, null, 'nothing has been found yet');
});

add('the download page is a real GitHub address', () => {
  assert.ok(/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases/.test(selfupdate.RELEASES_URL),
    selfupdate.RELEASES_URL);
});

add('checking on an unpackaged build resolves rather than throwing', async () => {
  const state = await selfupdate.check();
  assert.strictEqual(state.status, 'idle');
});

add('installing without a downloaded update is refused', () => {
  assert.throws(() => selfupdate.install(), /Quellcode|Windows|portable|heruntergeladen/);
});

/* --------------------------------------------------------------- messages */

add('a missing latest.yml is explained, not reported as a 404', () => {
  // This is the failure that happens when a release carries the executables
  // but not the metadata, and "404" alone sends nobody to the right place.
  const message = selfupdate.usefulError(
    new Error('HttpError: 404 Not Found. Cannot find latest.yml in the latest release')
  );
  assert.ok(/latest\.yml/.test(message), message);
  assert.ok(/Veröffentlichung|Build/.test(message), message);
});

add('a network failure reads as one', () => {
  assert.ok(/Verbindung/.test(selfupdate.usefulError(new Error('getaddrinfo ENOTFOUND github.com'))));
  assert.ok(/Verbindung/.test(selfupdate.usefulError(new Error('connect ETIMEDOUT'))));
});

add('an empty error still produces something to show', () => {
  assert.ok(selfupdate.usefulError(null).length > 0);
  assert.ok(selfupdate.usefulError(new Error('')).length > 0);
});

(async () => {
  for (const [name, fn] of queue) await test(name, fn);
  console.log(`\n${passed} assertions passed.`);
})();
