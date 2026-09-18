'use strict';

/**
 * The rule checker itself.
 *
 * A checker that has only been run against a clean tree has never been shown
 * to catch anything: it would report "all clear" just as happily with every
 * pattern misspelled. So each rule is given the exact code that broke a build
 * here, and has to flag it -- and then the corrected version, and has to stay
 * quiet.
 *
 * The second half matters as much as the first. The first version of the
 * exact-count rule flagged eleven perfectly good assertions, and a checker
 * that is wrong eleven times out of eleven teaches people to switch it off.
 */

const assert = require('assert');
const path = require('path');
const { RULES, scanText } = require('../scripts/rules-check');

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

const P = (...parts) => parts.join(path.sep);

/** The rule ids a snippet triggers in a given file. */
function hits(file, text) {
  return [...new Set(scanText(file, text).map((hit) => hit.rule.id))];
}

console.log('Regelprüfer');

/* ------------------------------------------------------- each rule catches */

test('the platform assertion is caught in a logic test', () => {
  // Cost a CI run twice: on Windows there is no guard to stop at, so the call
  // goes through and does the thing.
  const file = P('test', 'audio.test.js');
  assert.deepStrictEqual(
    hits(file, `  await assert.rejects(audio.setDefault(REAL_ID), /Windows/);`),
    ['platform-assertion']
  );
});

test('a check written inside the call is caught', () => {
  const file = P('src', 'main', 'updates.js');
  assert.deepStrictEqual(
    hits(file, `    await shell.openExternal(steamUpdateUri(id, 'validate'));`),
    ['check-inside-call']
  );
});

test('an id built from the clock is caught', () => {
  const file = P('src', 'main', 'discord.js');
  assert.deepStrictEqual(
    hits(file, "    id: raw.id ? raw.id : `dc-${Date.now().toString(36)}`,"),
    ['clock-as-id']
  );
});

test('an exact count on a growing list is caught', () => {
  const file = P('test', 'ui', 'cases.js');
  assert.deepStrictEqual(
    hits(file, `      t.eq(await t.count('.rail-btn'), 10, 'Zehn Einträge in der Seitenleiste');`),
    ['exact-count']
  );
});

test('a long fixed pause in a test is caught', () => {
  const file = P('test', 'ui', 'cases.js');
  assert.deepStrictEqual(hits(file, `      await t.wait(3200);`), ['sleep-in-test']);
});

test('a PowerShell started outside the host is caught', () => {
  const file = P('src', 'main', 'tweaks.js');
  assert.deepStrictEqual(
    hits(file, `  const out = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script]);`),
    ['own-powershell']
  );
});

/* ------------------------------------------------- and the fix stays quiet */

test('the corrected platform assertion passes', () => {
  const file = P('test', 'audio.test.js');
  assert.deepStrictEqual(
    hits(file, `  await assert.rejects(audio.setDefault('nonsense'), /Gerätekennung/);`), []);
});

test('the corrected call passes', () => {
  const file = P('src', 'main', 'updates.js');
  assert.deepStrictEqual(hits(file, [
    "    const uri = steamUpdateUri(id, 'validate');",
    '    await shell.openExternal(uri);'
  ].join('\n')), []);
});

test('a random id passes', () => {
  const file = P('src', 'main', 'discord.js');
  assert.deepStrictEqual(
    hits(file, '    id: raw.id ? raw.id : `dc-${crypto.randomUUID()}`,'), []);
});

test('atLeast on the rail passes', () => {
  const file = P('test', 'ui', 'cases.js');
  assert.deepStrictEqual(
    hits(file, `      t.atLeast(await t.count('.rail-btn'), 10, 'Die Seitenleiste ist vollständig');`), []);
});

/* ------------------------------------------------------- and stays out of the way */

test('exact counts that are real invariants are left alone', () => {
  // These are the eleven the first version of the rule flagged. None of them
  // grows when a feature is added; failing a build over them would make the
  // checker something to switch off.
  const file = P('test', 'ui', 'cases.js');
  for (const line of [
    `      t.eq(await t.count('.theme-card.active'), 1, 'Genau eines ist als aktiv markiert');`,
    `      t.eq(await t.count('#view-processes tbody tr'), 0, 'Suche ohne Treffer leert die Tabelle');`,
    `      t.eq(await t.count('.modal .day-btn'), 7, 'Sieben Wochentage zur Wahl');`,
    `      t.eq(await t.count('.modal .tab-bar .tab'), 2, 'Der Editor hat zwei Reiter');`
  ]) {
    assert.deepStrictEqual(hits(file, line), [], line.trim());
  }
});

test('a short wait is allowed', () => {
  // Sub-second waits after a synthetic event are not the failure mode; a
  // rule that banned every pause would be ignored rather than followed.
  assert.deepStrictEqual(hits(P('test', 'ui', 'cases.js'), '      await t.wait(300);'), []);
});

test('the host itself may start PowerShell', () => {
  assert.deepStrictEqual(
    hits(P('src', 'main', 'pshost.js'), `  child = spawn('powershell.exe', args);`), []);
});

test('the rules do not fire on the comments that explain them', () => {
  // Every one of these patterns is described in prose somewhere in this
  // repository, including in the checker's own source.
  const file = P('src', 'main', 'updates.js');
  assert.deepStrictEqual(
    hits(file, `    // Never write shell.openExternal(pruefe(x)) -- see CLAUDE.md.`), []);
  assert.deepStrictEqual(
    hits(file, `     * Also avoid id: Date.now() for the same reason.`), []);
});

/* ------------------------------------------------------------- the rules themselves */

test('every rule explains itself', () => {
  // The message names what is wrong, the reason names why it is worth a failed
  // build. Without the second, the next person works around the rule.
  for (const rule of RULES) {
    assert.ok(rule.id && rule.message, `rule without a name: ${JSON.stringify(rule)}`);
    assert.ok(rule.why && rule.why.length > 60, `rule ${rule.id} needs a reason`);
    assert.strictEqual(typeof rule.files, 'function', `rule ${rule.id} needs a scope`);
  }
});

test('rule ids are unique', () => {
  const ids = RULES.map((rule) => rule.id);
  assert.strictEqual(new Set(ids).size, ids.length, ids.join(', '));
});

console.log(`\n${passed} assertions passed.`);
