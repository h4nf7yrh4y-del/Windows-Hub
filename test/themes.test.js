'use strict';

/**
 * The colour presets.
 *
 * A theme is a pair of colours plus effect switches, and the only thing worth
 * testing is that the set is coherent: unique ids, both colours present and
 * valid, and a matcher that recognises a stored configuration as one of the
 * presets — otherwise the interface would show none of them as selected while
 * clearly displaying one.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/js/themes.js'), 'utf8');
const body = source.replace(/^export /gm, '');
// eslint-disable-next-line no-new-func
const { THEMES, findTheme, matchTheme, themePatch } =
  new Function(`${body}; return { THEMES, findTheme, matchTheme, themePatch };`)();

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

console.log('Themen');

test('there are several themes and their ids are unique', () => {
  assert.ok(THEMES.length >= 4);
  const ids = THEMES.map((t) => t.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('every theme has two valid, different colours', () => {
  for (const theme of THEMES) {
    assert.ok(/^#[0-9a-f]{6}$/i.test(theme.accent), `${theme.id}: ${theme.accent}`);
    assert.ok(/^#[0-9a-f]{6}$/i.test(theme.accent2), `${theme.id}: ${theme.accent2}`);
    assert.notStrictEqual(theme.accent.toLowerCase(), theme.accent2.toLowerCase(),
      `${theme.id} has the same colour twice, which is not a pair`);
  }
});

test('every theme has a label, a hint and both effect switches', () => {
  for (const theme of THEMES) {
    assert.ok(theme.label && theme.hint, theme.id);
    assert.strictEqual(typeof theme.effects.scanlines, 'boolean', theme.id);
    assert.strictEqual(typeof theme.effects.grid, 'boolean', theme.id);
  }
});

test('no two themes share a colour pair', () => {
  const pairs = THEMES.map((t) => `${t.accent}|${t.accent2}`.toLowerCase());
  assert.strictEqual(new Set(pairs).size, pairs.length,
    'duplicate pairs would make the matcher pick the wrong one');
});

test('a theme is found by id, and an unknown id is null rather than a crash', () => {
  assert.strictEqual(findTheme('matrix').label, 'Matrix');
  assert.strictEqual(findTheme('gibt-es-nicht'), null);
  assert.strictEqual(findTheme(undefined), null);
});

test('stored settings are matched back to their theme', () => {
  for (const theme of THEMES) {
    const stored = themePatch(theme);
    const found = matchTheme(stored);
    assert.ok(found, `${theme.id} was not recognised from its own patch`);
    assert.strictEqual(found.id, theme.id);
  }
});

test('matching ignores the case the colours were written in', () => {
  const theme = THEMES[0];
  assert.strictEqual(matchTheme({ accent: theme.accent.toUpperCase(), accent2: theme.accent2.toUpperCase() }).id,
    theme.id);
});

test('a hand-picked pair matches no theme', () => {
  assert.strictEqual(matchTheme({ accent: '#123456', accent2: '#654321' }), null);
  // One colour changed is no longer that theme either.
  assert.strictEqual(matchTheme({ accent: THEMES[0].accent, accent2: '#123456' }), null);
});

test('missing settings do not throw', () => {
  assert.strictEqual(matchTheme(null), null);
  assert.strictEqual(matchTheme({}), null);
});

test('the patch carries the effects, not just the colours', () => {
  const patch = themePatch(findTheme('mono'));
  assert.strictEqual(patch.scanlines, false);
  assert.strictEqual(patch.grid, false);
  assert.strictEqual(patch.accent, findTheme('mono').accent);
});

console.log(`\n${passed} assertions passed.`);
