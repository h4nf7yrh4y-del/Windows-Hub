'use strict';

/**
 * What the first run offers.
 *
 * The choosing is the whole feature. An empty profile grid and a list of four
 * hundred Start Menu entries fail in the same way -- there is nothing to
 * decide from -- so what gets shown, in what order, and how much of it is the
 * part worth testing. The dialog around it is exercised by the interface
 * tests, which start the real application.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// An ES module for the browser. Only the region the module marks as free of
// imports and of the DOM is lifted out and run here.
const source = fs.readFileSync(
  path.join(__dirname, '..', 'src/renderer/js/views/welcome.js'), 'utf8');
const start = source.indexOf('/* ------------------------------------------------------------------- pure */');
const end = source.indexOf('/* --------------------------------------------------------------- end pure */');
assert.ok(start >= 0 && end > start, 'the pure region markers are gone from welcome.js');
const body = source.slice(start, end).replace(/^export function/gm, 'function');
// eslint-disable-next-line no-new-func
const { rank, candidates, companionsFrom } =
  new Function(`${body}; return { rank, candidates, companionsFrom };`)();

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

const game = (name, source_) => ({
  id: `${source_}:${name}`, name, source: source_, kind: 'game', launch: { type: 'uri', target: 'x' }
});
const app = (name) => ({
  id: `lnk:${name}`, name, source: 'startmenu', kind: 'app', launch: { type: 'exe', target: 'x.exe' }
});

console.log('Erststart');

/* ------------------------------------------------------------------ order */

test('games from a launcher come first', () => {
  // They are what a profile is for, and they are the entries with a launch
  // target that reliably works.
  const list = candidates([app('Rechner'), game('Helldivers 2', 'steam'), app('Editor')]);
  assert.strictEqual(list[0].name, 'Helldivers 2');
});

test('Epic counts as much as Steam', () => {
  assert.strictEqual(rank(game('A', 'epic')), rank(game('B', 'steam')));
  assert.ok(rank(game('A', 'steam')) < rank(app('C')));
});

test('within a group the order is alphabetical, not arbitrary', () => {
  // Scan order depends on the filesystem, which means the same machine can
  // show a different list twice in a row.
  const list = candidates([game('Zulu', 'steam'), game('Alpha', 'steam'), game('Mike', 'steam')]);
  assert.deepStrictEqual(list.map((i) => i.name), ['Alpha', 'Mike', 'Zulu']);
});

/* ----------------------------------------------------------------- length */

test('the list is capped', () => {
  // Four hundred entries is the same problem as none: nothing to decide from.
  const many = Array.from({ length: 400 }, (_, i) => app(`Programm ${String(i).padStart(3, '0')}`));
  assert.ok(candidates(many).length <= 24, String(candidates(many).length));
});

test('the cap keeps the games even when programs outnumber them', () => {
  const many = Array.from({ length: 400 }, (_, i) => app(`Programm ${i}`));
  const list = candidates([...many, game('Helldivers 2', 'steam')]);
  assert.ok(list.some((i) => i.name === 'Helldivers 2'), 'the game must survive the cap');
});

/* ---------------------------------------------------------------- rubbish */

test('entries without a launch target are dropped', () => {
  // A row that cannot be started would produce a profile that does nothing.
  const list = candidates([
    { id: 'a', name: 'Kaputt' },
    { id: 'b', name: 'Auch kaputt', launch: null },
    game('Gut', 'steam')
  ]);
  assert.deepStrictEqual(list.map((i) => i.name), ['Gut']);
});

test('nothing found is an empty list, not a crash', () => {
  assert.deepStrictEqual(candidates([]), []);
  assert.deepStrictEqual(candidates([null, undefined]), []);
});

/* -------------------------------------------------------------- companions */

test('the usual companions are recognised', () => {
  const found = companionsFrom([game('Spiel', 'steam'), app('Discord'), app('Spotify')]);
  assert.deepStrictEqual(found.map((i) => i.name), ['Discord', 'Spotify']);
});

test('a companion that is not installed is simply absent', () => {
  assert.deepStrictEqual(companionsFrom([game('Spiel', 'steam')]), []);
});

test('a lookalike is not offered', () => {
  // "Discord Update Helper" or "Spotify Web Helper" are not what anyone means,
  // and a profile that launches one would be quietly wrong.
  const found = companionsFrom([app('Discord Update Helper'), app('Spotify Web Helper')]);
  assert.deepStrictEqual(found, []);
});

test('each companion is offered once', () => {
  const found = companionsFrom([app('Discord'), app('Discord')]);
  assert.strictEqual(found.length, 1);
});

console.log(`\n${passed} assertions passed.`);
