'use strict';

/**
 * What the "Braucht Aufmerksamkeit" card says.
 *
 * Four numbers come in from four different, already-existing reads; this is
 * only the wording and the thresholds, not the reads themselves -- those are
 * exercised where they already live (updates, storage, trash, hotkeys).
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
const { attentionItems } = new Function(`${body}; return { attentionItems };`)();

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

const CLEAR = { expiringSoon: 0, cold: 0, collisions: 0, steamActionable: 0, wingetActionable: 0 };

console.log('Braucht Aufmerksamkeit');

test('nothing to report is an empty list, not a row that says so', () => {
  assert.deepStrictEqual(attentionItems(CLEAR), []);
});

test('winget not checked yet (null, the same as never scanned) counts as nothing', () => {
  // The card never runs the scan itself -- it only reads what the Updates
  // view already found. Nothing found and nothing checked must look the
  // same here, or this would end up guessing.
  assert.deepStrictEqual(attentionItems({ ...CLEAR, wingetActionable: null }), []);
});

test('Steam and winget updates are added together, not shown twice', () => {
  const items = attentionItems({ ...CLEAR, steamActionable: 2, wingetActionable: 3 });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].key, 'updates');
  assert.ok(/5 Updates verfügbar/.test(items[0].text), items[0].text);
});

test('one of something is singular, not "1 Updates"', () => {
  const items = attentionItems({ ...CLEAR, steamActionable: 1 });
  assert.ok(/1 Update verfügbar/.test(items[0].text), items[0].text);
});

test('a cold game is reported in the singular too', () => {
  const items = attentionItems({ ...CLEAR, cold: 1 });
  assert.ok(/1 Spiel liegt/.test(items[0].text), items[0].text);
});

test('several cold games use the plural verb', () => {
  const items = attentionItems({ ...CLEAR, cold: 4 });
  assert.ok(/4 Spiele liegen/.test(items[0].text), items[0].text);
});

test('all four can appear together, in a fixed order', () => {
  const items = attentionItems({ expiringSoon: 1, cold: 1, collisions: 1, steamActionable: 1, wingetActionable: 0 });
  assert.deepStrictEqual(items.map((i) => i.key), ['updates', 'storage', 'trash', 'hotkeys']);
});

test('a hotkey collision is named as one that does not fire', () => {
  const items = attentionItems({ ...CLEAR, collisions: 2 });
  assert.ok(/2 Tastenkürzel greifen nicht/.test(items[0].text), items[0].text);
});

console.log(`\n${passed} assertions passed.`);
