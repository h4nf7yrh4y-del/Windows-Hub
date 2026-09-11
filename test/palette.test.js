'use strict';

/**
 * The palette's matcher.
 *
 * Subsequence matching is the whole point: people type "hd2" for
 * "Helldivers 2", not "helldiv". The scoring decides whether that lands on the
 * right entry or on whatever else happens to contain an h, a d and a 2, which
 * is the difference between a search box people use and one they avoid.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The module is an ES module for the browser and imports the app's own
// helpers, so only the pure function is lifted out of the source.
const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/js/palette.js'), 'utf8');
const start = source.indexOf('export function scoreEntry');
const end = source.indexOf('/* ----------------------------------------------------------------- sources */');
const body = source.slice(start, end).replace(/^export function/gm, 'function');
// eslint-disable-next-line no-new-func
const { fuzzyScore, scoreEntry } =
  new Function(`${body}; return { fuzzyScore, scoreEntry };`)();

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

const best = (needle, ...candidates) => candidates
  .map((text) => ({ text, score: fuzzyScore(text, needle) }))
  .filter((row) => row.score !== null)
  .sort((a, b) => b.score - a.score)[0];

console.log('Befehlspalette');

test('an exact substring matches', () => {
  assert.ok(fuzzyScore('Helldivers 2', 'helldivers') !== null);
  assert.ok(fuzzyScore('Helldivers 2', 'divers') !== null);
});

test('initials match across words', () => {
  assert.ok(fuzzyScore('Helldivers 2', 'hd2') !== null, 'this is how people actually type');
  assert.ok(fuzzyScore('Neues Profil', 'np') !== null);
});

test('letters out of order do not match', () => {
  assert.strictEqual(fuzzyScore('Helldivers 2', '2hd'), null);
  assert.strictEqual(fuzzyScore('Spotify', 'ytops'), null);
});

test('a letter that is not there at all does not match', () => {
  assert.strictEqual(fuzzyScore('Spotify', 'spotifyx'), null);
});

test('matching is case-insensitive in both directions', () => {
  assert.ok(fuzzyScore('SPOTIFY', 'spot') !== null);
  assert.ok(fuzzyScore('spotify', 'SPOT') !== null);
});

test('the intended entry wins over an accidental one', () => {
  // "hd2" is a subsequence of both, but only one of them means it.
  assert.strictEqual(best('hd2', 'Helldivers 2', 'Hintergrunddienste 2020').text, 'Helldivers 2');
});

test('a word-start match beats a match buried in the middle', () => {
  assert.strictEqual(best('set', 'Setup', 'Bildschirm-Einstellungen-Reset').text, 'Setup');
});

test('a consecutive run beats scattered letters', () => {
  assert.strictEqual(best('disc', 'Discord', 'Datei im Systemcache').text, 'Discord');
});

test('the shorter of two equally good matches wins', () => {
  assert.strictEqual(best('hub', 'Hub', 'Hub mit sehr langem Zusatztitel hintendran').text, 'Hub');
});

test('an empty query matches everything with no preference', () => {
  assert.strictEqual(fuzzyScore('irgendwas', ''), 0);
  assert.strictEqual(fuzzyScore('irgendwas', '   '), 0);
});

test('spaces in the query are ignored rather than required', () => {
  assert.ok(fuzzyScore('Helldivers 2', 'h d 2') !== null);
});

test('scores are numbers, so sorting is meaningful', () => {
  const score = fuzzyScore('Spotify', 'spo');
  assert.strictEqual(typeof score, 'number');
  assert.ok(score > 0);
});

/* --------------------------------------------------------- entry scoring */

const bestEntry = (needle, ...entries) => entries
  .map((entry) => ({ entry, score: scoreEntry(entry, needle) }))
  .filter((row) => row.score !== null)
  .sort((a, b) => b.score - a.score)[0].entry;

test('a title that is exactly the query wins outright', () => {
  assert.strictEqual(
    bestEntry('system', { title: 'System', hint: 'Auslastung' }, { title: 'Systeminformationen', hint: 'Werkzeug' }).title,
    'System'
  );
});

test('a title match beats a hint match', () => {
  // Someone typing a word means the entry called that, not one whose
  // description happens to mention it.
  assert.strictEqual(
    bestEntry('overlay',
      { title: 'Overlay', hint: 'Schwebende Anzeigen' },
      { title: 'Irgendwas', hint: 'Zeigt ein Overlay an' }).title,
    'Overlay'
  );
});

test('an entry is still found by its hint alone', () => {
  assert.ok(scoreEntry({ title: 'Setup', hint: 'Einstellungen' }, 'einstell') !== null);
});

test('an entry that matches nowhere scores null', () => {
  assert.strictEqual(scoreEntry({ title: 'Setup', hint: 'Einstellungen' }, 'zzzqqq'), null);
});

test('an entry without a hint does not throw', () => {
  assert.ok(scoreEntry({ title: 'Hub' }, 'hub') !== null);
  assert.strictEqual(scoreEntry({ title: 'Hub' }, 'zzz'), null);
});

console.log(`\n${passed} assertions passed.`);
