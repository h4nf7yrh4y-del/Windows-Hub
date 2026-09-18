'use strict';

/**
 * How a trigger event becomes a line in the activity feed.
 *
 * The module is an ES module for the browser with a stateful part (the list
 * itself, `crypto.randomUUID()`, a Set of listeners) that only makes sense
 * inside a page. Only the pure mapping is lifted out and run here.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/js/activity.js'), 'utf8');
const start = source.indexOf('/* ------------------------------------------------------------------- pure */');
const end = source.indexOf('/* --------------------------------------------------------------- end pure */');
assert.ok(start >= 0 && end > start, 'the pure region markers are gone from activity.js');
const body = source.slice(start, end).replace(/^function/gm, 'function');
// eslint-disable-next-line no-new-func
const { describeTriggerEvent } = new Function(`${body}; return { describeTriggerEvent };`)();

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

console.log('Aktivitätsverlauf');

test('a trigger taking over the system state reads as a success', () => {
  const entry = describeTriggerEvent({ kind: 'applied', profileId: 'a', name: 'Gaming', action: 'system' });
  assert.strictEqual(entry.kind, 'ok');
  assert.ok(/Gaming/.test(entry.message));
});

test('a full launch says so, not just "applied"', () => {
  const entry = describeTriggerEvent({ kind: 'applied', name: 'Gaming', action: 'full' });
  assert.ok(/vollständig gestartet/.test(entry.message), entry.message);
});

test('giving the system state back is informational, not a success or a failure', () => {
  const entry = describeTriggerEvent({ kind: 'reverted', name: 'Gaming' });
  assert.strictEqual(entry.kind, 'info');
});

test('another profile already holding the state is a warning', () => {
  const entry = describeTriggerEvent({ kind: 'blocked', name: 'Gaming' });
  assert.strictEqual(entry.kind, 'warn');
});

test('a failed trigger carries the reason along', () => {
  const entry = describeTriggerEvent({ kind: 'error', name: 'Gaming', error: 'Energieplan konnte nicht gesetzt werden' });
  assert.strictEqual(entry.kind, 'error');
  assert.ok(/Energieplan konnte nicht gesetzt werden/.test(entry.message));
});

test('a missing reason still produces a readable line', () => {
  const entry = describeTriggerEvent({ kind: 'error', name: 'Gaming' });
  assert.ok(/unbekannter Fehler/.test(entry.message));
});

test('an event kind this does not know is refused, not guessed at', () => {
  assert.strictEqual(describeTriggerEvent({ kind: 'kicked-off-orbit', name: 'Gaming' }), null);
});

test('an event without a name is refused: there would be nothing to say', () => {
  assert.strictEqual(describeTriggerEvent({ kind: 'applied' }), null);
  assert.strictEqual(describeTriggerEvent(null), null);
});

console.log(`\n${passed} assertions passed.`);
