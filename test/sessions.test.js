'use strict';

/**
 * Playtime bookkeeping.
 *
 * The interesting part is what is deliberately *not* recorded. A session only
 * counts once its programs are gone, so a hub that is killed mid-game loses
 * that run — writing a start with no end would produce a fourteen-hour session
 * the next time the numbers were read, and a missing session is a smaller lie
 * than an invented one. A launch whose programs never appeared is not a
 * session at all.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The formatter lives in the renderer; it is pure, so it is lifted out.
const viewSource = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/js/views/stats.js'), 'utf8');
const start = viewSource.indexOf('export function duration');
const end = viewSource.indexOf('function relativeDay');
// eslint-disable-next-line no-new-func
const duration = new Function(
  `${viewSource.slice(start, end).replace('export function', 'function')}; return duration;`
)();

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

console.log('Spielzeit');

/* ------------------------------------------------------------- formatting */

test('a run under a minute is not shown as zero', () => {
  assert.strictEqual(duration(0), '—');
  assert.strictEqual(duration(20000), '—');
});

test('minutes below an hour stay minutes', () => {
  assert.strictEqual(duration(60000), '1 min');
  assert.strictEqual(duration(45 * 60000), '45 min');
});

test('an hour and more reads as hours and minutes', () => {
  assert.strictEqual(duration(60 * 60000), '1 h');
  assert.strictEqual(duration(95 * 60000), '1 h 35 min');
  assert.strictEqual(duration(12 * 3600000), '12 h');
});

test('nonsense input does not produce nonsense output', () => {
  assert.strictEqual(duration(null), '—');
  assert.strictEqual(duration(undefined), '—');
  assert.strictEqual(duration('abc'), '—');
  assert.strictEqual(duration(-5000), '—');
});

/* ------------------------------------------------------------- thresholds */

// The store resolves its path through Electron's app object, which does not
// exist in plain Node. A throwaway directory stands in for it.
const os = require('os');
const Module = require('module');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sessions-'));
const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => dataDir }, shell: {} };
  return realLoad.call(this, request, parent, isMain);
};
const sessions = require('../src/main/sessions');
Module._load = realLoad;

test('the minimum session is long enough to exclude a misclick', () => {
  assert.ok(sessions.MIN_SESSION_MS >= 30000,
    'a launch abandoned after ten seconds is not playtime');
  assert.ok(sessions.MIN_SESSION_MS <= 5 * 60000,
    'but a short round still has to count');
});

test('a program is given more than one poll to come back', () => {
  assert.ok(sessions.GRACE_TICKS >= 2,
    'a game dropping to its launcher for a moment must not split into two sessions');
});

test('statistics on an untouched store are empty rather than broken', () => {
  const stats = sessions.stats();
  assert.strictEqual(stats.sessionCount, 0);
  assert.strictEqual(stats.totalMs, 0);
  assert.strictEqual(stats.days.length, 14, 'always fourteen days, even with no data');
  assert.ok(Array.isArray(stats.rows));
  assert.deepStrictEqual(stats.tracking, []);
});

test('the day chart is ordered oldest to newest and ends today', () => {
  const { days } = sessions.stats();
  for (let i = 1; i < days.length; i += 1) {
    assert.ok(days[i].at > days[i - 1].at, 'days must run forwards');
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  assert.strictEqual(days[days.length - 1].at, today.getTime());
});

test('watching a profile with no identifiable process records nothing', () => {
  sessions.watch({ id: 'x', name: 'Ohne Prozess', apps: [{ name: 'A', launch: { type: 'uri', target: 'steam://rungameid/1' } }] });
  assert.deepStrictEqual(sessions.stats().tracking, [],
    'there is nothing to watch, and pretending otherwise would record a session that never happened');
});

test('releasing a profile that was never watched is not an error', () => {
  assert.strictEqual(sessions.release('gibt-es-nicht'), null);
});

console.log(`\n${passed} assertions passed.`);

try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
