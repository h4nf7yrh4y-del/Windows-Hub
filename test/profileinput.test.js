'use strict';

/**
 * What the renderer is allowed to store in a profile.
 *
 * The renderer is untrusted by design, so every field a profile carries is
 * bounded here rather than where it is used. Only the pure validators are
 * called: `registerIpc` is never run, so nothing in this file talks to a
 * window, a shell or PowerShell.
 *
 * The case that earns this file its own place is `waitFor`. An unknown value
 * there must be refused, not reset to "wait for nothing" — that pattern has
 * cost this project three times, and the shape is identical every time: a
 * setting that looks set, does nothing, and gives no reason.
 */

const assert = require('assert');
const { sanitizeApp, sanitizeProfile } = require('../src/main/ipc');

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

const entry = (extra = {}) => ({ name: 'X', launch: { type: 'exe', target: 'C:\\x.exe' }, ...extra });

console.log('Profil-Eingaben');

/* ----------------------------------------------------------- wait condition */

test('no wait condition becomes the explicit default', () => {
  assert.strictEqual(sanitizeApp(entry()).waitFor, 'none');
  assert.strictEqual(sanitizeApp(entry({ waitFor: '' })).waitFor, 'none');
  assert.strictEqual(sanitizeApp(entry({ waitFor: null })).waitFor, 'none');
});

test('the two real conditions survive unchanged', () => {
  assert.strictEqual(sanitizeApp(entry({ waitFor: 'process' })).waitFor, 'process');
  assert.strictEqual(sanitizeApp(entry({ waitFor: 'window' })).waitFor, 'window');
});

test('an unknown condition is refused, not quietly turned off', () => {
  assert.throws(() => sanitizeApp(entry({ waitFor: 'fenster' })), /Unknown wait condition/);
  assert.throws(() => sanitizeApp(entry({ waitFor: 'Process' })), /Unknown wait condition/);
  assert.throws(() => sanitizeApp(entry({ waitFor: true })), /Unknown wait condition/);
});

test('the wait budget is bounded, and zero means the default', () => {
  assert.strictEqual(sanitizeApp(entry()).waitTimeoutMs, 0);
  assert.strictEqual(sanitizeApp(entry({ waitTimeoutMs: -5 })).waitTimeoutMs, 0);
  assert.strictEqual(sanitizeApp(entry({ waitTimeoutMs: 999999 })).waitTimeoutMs, 180000);
  assert.strictEqual(sanitizeApp(entry({ waitTimeoutMs: '12000' })).waitTimeoutMs, 12000);
  assert.strictEqual(sanitizeApp(entry({ waitTimeoutMs: 'bald' })).waitTimeoutMs, 0);
});

/* ------------------------------------------------------------- the desktop */

test('restoring the desktop is off unless it was asked for', () => {
  assert.strictEqual(sanitizeProfile({ name: 'P' }).restoreDesktop, false);
  assert.strictEqual(sanitizeProfile({ name: 'P', restoreDesktop: true }).restoreDesktop, true);
  // Anything truthy is a yes; there is no third state to get wrong here.
  assert.strictEqual(sanitizeProfile({ name: 'P', restoreDesktop: 'ja' }).restoreDesktop, true);
});

test('an app with a bad wait condition fails the whole profile', () => {
  // Saving eleven of twelve entries and dropping the twelfth would be worse:
  // the editor would show a profile that is not the one that was stored.
  assert.throws(() => sanitizeProfile({ name: 'P', apps: [entry(), entry({ waitFor: 'x' })] }),
    /Unknown wait condition/);
});

console.log(`\n${passed} assertions passed.`);
