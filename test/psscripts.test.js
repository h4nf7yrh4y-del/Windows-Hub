'use strict';

/**
 * The structural script checker, checked.
 *
 * Same reasoning as `test/rules.test.js`: a checker that has only ever run
 * against a clean tree has not been shown to catch anything. This one exists
 * because of one specific line, so that line is what it gets fed -- and then
 * the corrected version, which it has to let through.
 *
 * The quiet half matters as much: this runs on every lint, and a check that
 * flags working scripts is one somebody removes from the lint step.
 */

const assert = require('assert');
const { faultsIn } = require('../scripts/psscripts-check');
const { fillPlaceholders, collect } = require('../scripts/generated-ps');

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

const whats = (script) => faultsIn(script).map((f) => f.what);

console.log('Skriptprüfer');

/* ------------------------------------------------------------ it catches */

test('the line that cost the build is caught', () => {
  // Verbatim from windowlayout.js before the fix. Correct at runtime,
  // unparseable once the test substitutes the interpolation.
  const filled = fillPlaceholders(
    "[HubWindows]::Move(${Math.trunc(handle)}, ${entry.x}, ${entry.y}, "
    + "$${entry.maximized ? 'true' : 'false'})");
  assert.ok(filled.includes("$'PLACEHOLDER'"), `substitution changed: ${filled}`);
  assert.deepStrictEqual(whats(filled), ['ein $ direkt vor einem Anführungszeichen']);
});

test('the corrected version is let through', () => {
  const filled = fillPlaceholders('[HubWindows]::Move(${target}, ${left}, ${top}, ${maximized})');
  assert.deepStrictEqual(whats(filled), []);
});

test('a double quote against a dollar is caught too', () => {
  assert.deepStrictEqual(whats('Write-Output $"x"'), ['ein $ direkt vor einem Anführungszeichen']);
});

test('an interpolation the filler could not resolve is caught', () => {
  assert.deepStrictEqual(whats('[Hub]::Do(${'), ['eine nicht aufgelöste JavaScript-Einsetzung']);
});

test('an empty script is a fault, not a pass', () => {
  // The extraction returning nothing would otherwise read as "all clear".
  assert.strictEqual(faultsIn('').length, 1);
  assert.strictEqual(faultsIn('   \n  ').length, 1);
});

/* -------------------------------------------------------- it stays quiet */

test('ordinary PowerShell is not flagged', () => {
  assert.deepStrictEqual(whats("Get-Process | Where-Object { $_.Name -eq 'steam' }"), []);
  assert.deepStrictEqual(whats('$ErrorActionPreference = "Stop"'), []);
  assert.deepStrictEqual(whats('[HubDisplay]::List($true) | ConvertTo-Json'), []);
});

test('a subexpression is not mistaken for the fault', () => {
  // `$(` is the shape that is allowed; only `$'` and `$"` are not.
  assert.deepStrictEqual(whats('Write-Output "$($game.Name)"'), []);
});

test('every script in the tree passes right now', () => {
  // The clean-tree half. On its own it proves nothing, which is what the
  // cases above are for -- together they mean something.
  const bad = collect().filter((entry) => faultsIn(entry.script).length);
  assert.deepStrictEqual(bad.map((entry) => entry.name), []);
});

test('there are scripts to check at all', () => {
  // A broken extraction would make every other assertion here vacuous.
  assert.ok(collect().length >= 10, `only ${collect().length} scripts found`);
});

console.log(`\n${passed} assertions passed.`);
