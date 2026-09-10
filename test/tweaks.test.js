'use strict';

/**
 * The system changes a profile makes around its programs.
 *
 * Everything here is input handling and quoting: the values come from the
 * profile editor, end up in a PowerShell script, and can switch the machine's
 * power plan or kill a process. A name that slips through unvalidated is not a
 * cosmetic problem, so the boundary is where the assertions sit.
 */

const assert = require('assert');
const tweaks = require('../src/main/tweaks');

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

console.log('Profil-Systemänderungen');

/* ------------------------------------------------------------ process names */

test('a full path is reduced to the process name', () => {
  assert.strictEqual(tweaks.processName('C:\\Program Files\\Google\\Chrome\\chrome.exe'), 'chrome');
  assert.strictEqual(tweaks.processName('/usr/bin/firefox'), 'firefox');
});

test('a bare name survives unchanged', () => {
  assert.strictEqual(tweaks.processName('Discord'), 'Discord');
});

test('empty and nonsense input do not throw', () => {
  assert.strictEqual(tweaks.processName(''), '');
  assert.strictEqual(tweaks.processName(null), '');
  assert.strictEqual(tweaks.processName(undefined), '');
  assert.strictEqual(tweaks.processName('   '), '');
});

/* ----------------------------------------------------------------- sanitize */

test('defaults are returned for anything that is not an object', () => {
  for (const input of [null, undefined, 'x', 42, []]) {
    const out = tweaks.sanitize(input);
    assert.strictEqual(out.priority, 'normal');
    assert.deepStrictEqual(out.closeApps, []);
    assert.strictEqual(out.powerPlan, null);
  }
});

test('only a real GUID is accepted as a power plan', () => {
  assert.strictEqual(tweaks.sanitize({ powerPlan: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c' }).powerPlan,
    '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c');
  for (const bad of ['', 'balanced', '../../etc', '8c5e7fda', "'; powercfg /x '"]) {
    assert.strictEqual(tweaks.sanitize({ powerPlan: bad }).powerPlan, null, `accepted ${bad}`);
  }
});

test('an unknown priority falls back to normal instead of reaching PowerShell', () => {
  assert.strictEqual(tweaks.sanitize({ priority: 'realtime' }).priority, 'normal');
  assert.strictEqual(tweaks.sanitize({ priority: 'high' }).priority, 'high');
});

test('realtime is not offered at all', () => {
  assert.ok(!tweaks.PRIORITIES.some((p) => p.value === 'realtime'),
    'realtime starves the input thread and has no way back');
});

test('the close list is de-duplicated, path-stripped and bounded', () => {
  const out = tweaks.sanitize({
    closeApps: ['C:\\x\\chrome.exe', 'chrome', 'CHROME', '', '  ', 'Teams']
  });
  assert.deepStrictEqual(out.closeApps, ['chrome', 'CHROME', 'Teams']);

  const many = tweaks.sanitize({ closeApps: Array.from({ length: 200 }, (_, i) => `app${i}`) });
  assert.strictEqual(many.closeApps.length, 40);
});

test('the priority target is stripped the same way as the close list', () => {
  assert.strictEqual(tweaks.sanitize({ priorityTarget: 'D:\\Games\\hd2.exe' }).priorityTarget, 'hd2');
});

test('the restore switches default to on', () => {
  const out = tweaks.sanitize({});
  assert.strictEqual(out.restore, true);
  assert.strictEqual(out.restoreClosed, true);
  assert.strictEqual(tweaks.sanitize({ restore: false }).restore, false);
});

/* ------------------------------------------------------------------ active */

test('a profile without system settings is not considered active', () => {
  assert.strictEqual(tweaks.isActive(undefined), false);
  assert.strictEqual(tweaks.isActive({}), false);
  assert.strictEqual(tweaks.isActive({ priority: 'normal', closeApps: [] }), false);
});

test('any single setting makes a profile active', () => {
  assert.strictEqual(tweaks.isActive({ keepAwake: true }), true);
  assert.strictEqual(tweaks.isActive({ priority: 'high' }), true);
  assert.strictEqual(tweaks.isActive({ closeApps: ['chrome'] }), true);
  assert.strictEqual(tweaks.isActive({ powerPlan: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c' }), true);
});

/* ---------------------------------------------------------------- quoting */

test('an apostrophe in a process name stays inside the PowerShell literal', () => {
  const script = tweaks.closeScript(["O'Brien Sync"]);
  assert.ok(script.includes("'O''Brien Sync'"), `not doubled:\n${script}`);
  // One name means exactly one opening quote per literal; an odd count would
  // mean a string ran on into the rest of the script.
  const quotes = (script.match(/'/g) || []).length;
  assert.strictEqual(quotes % 2, 0, 'unbalanced quotes');
});

test('a path with a quote survives the restart script', () => {
  const script = tweaks.restartScript([{ path: "C:\\Users\\O'Brien\\run.exe" }]);
  assert.ok(script.includes("'C:\\Users\\O''Brien\\run.exe'"));
});

test('backslashes in paths are not swallowed by the template', () => {
  const script = tweaks.restartScript([{ path: 'C:\\Program Files\\App\\a.exe' }]);
  assert.ok(script.includes('C:\\Program Files\\App\\a.exe'), 'path lost its separators');
});

test('the plan script keeps the WMI namespace intact', () => {
  assert.ok(tweaks.PLANS_SCRIPT.includes('root\\cimv2\\power'), 'namespace lost its backslashes');
});

console.log(`\n${passed} assertions passed.`);
