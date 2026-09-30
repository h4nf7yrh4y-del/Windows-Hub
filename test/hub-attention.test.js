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

const CLEAR = {
  expiringSoon: 0, cold: 0, collisions: 0, steamActionable: 0, wingetActionable: 0, held: null
};

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

/* --------------------------------------------------- a held system state */
/*
 * The row that exists because its absence was the expensive half of a real
 * bug: the machine stayed on a profile's power plan and nothing anywhere said
 * so. The wording has to name the profile and how long, because "something is
 * applied" is not actionable and a number of minutes is.
 */

const NOW = 1700000000000;
const held = (extra = {}) => ({
  profileId: 'p1', profileName: 'Helldivers 2', since: NOW - 90 * 60000, closed: 0, ...extra
});

test('a held system state is reported first, above everything else', () => {
  // Above the updates: it is the only row that says the machine is not the way
  // it was left, and it is the only one that costs something every minute.
  const items = attentionItems({
    ...CLEAR, held: held(), steamActionable: 3, cold: 2, collisions: 1, now: NOW
  });
  assert.strictEqual(items[0].key, 'held');
  assert.deepStrictEqual(items.map((i) => i.key), ['held', 'updates', 'storage', 'hotkeys']);
});

test('the row names the profile and how long it has held', () => {
  const items = attentionItems({ ...CLEAR, held: held(), now: NOW });
  assert.ok(/Helldivers 2/.test(items[0].text), items[0].text);
  assert.ok(/seit 1 Stunde/.test(items[0].text), items[0].text);
});

test('what is actually changed is named, not just that something is', () => {
  const items = attentionItems({
    ...CLEAR, held: held({ powerPlanChanged: true, closed: 3 }), now: NOW
  });
  assert.ok(/Energieplan/.test(items[0].text), items[0].text);
  assert.ok(/3 Programme/.test(items[0].text), items[0].text);
});

test('one closed program is singular', () => {
  const items = attentionItems({ ...CLEAR, held: held({ closed: 1 }), now: NOW });
  assert.ok(/1 Programm\b/.test(items[0].text), items[0].text);
});

test('the age is scaled, and never reads as zero', () => {
  const at = (ms) => attentionItems({ ...CLEAR, held: held({ since: NOW - ms }), now: NOW })[0].text;
  // A state applied seconds ago is still held -- "seit 0 Minuten" would read
  // like a rounding error rather than a fact.
  assert.ok(/seit 1 Minuten/.test(at(3000)), at(3000));
  assert.ok(/seit 45 Minuten/.test(at(45 * 60000)), at(45 * 60000));
  assert.ok(/seit 5 Stunden/.test(at(5 * 3600000)), at(5 * 3600000));
  assert.ok(/seit 1 Tag\b/.test(at(30 * 3600000)), at(30 * 3600000));
  assert.ok(/seit 3 Tagen/.test(at(80 * 3600000)), at(80 * 3600000));
});

test('nothing held is no row, and a malformed answer is not one either', () => {
  assert.deepStrictEqual(attentionItems({ ...CLEAR, held: null, now: NOW }), []);
  assert.deepStrictEqual(attentionItems({ ...CLEAR, held: {}, now: NOW }), []);
});

test('a state held without a known start still gets a row', () => {
  // Better a row without an age than no row at all: the point is that something
  // is applied, and the age is the detail.
  const items = attentionItems({ ...CLEAR, held: held({ since: 0 }), now: NOW });
  assert.strictEqual(items[0].key, 'held');
  assert.ok(!/seit/.test(items[0].text), items[0].text);
});

console.log(`\n${passed} assertions passed.`);
