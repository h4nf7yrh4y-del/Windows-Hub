'use strict';

/**
 * Time arithmetic for scheduled profiles.
 *
 * The part worth testing is what happens to time that has already passed. A
 * schedule set for 20:00 must not launch a game when the machine is switched
 * on at 23:00, and it must not fire twice when the tick runs every thirty
 * seconds. Both are off-by-one problems that only show up on the day someone
 * relies on them.
 */

const assert = require('assert');
const scheduler = require('../src/main/scheduler');

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

console.log('Zeitplan');

/* ------------------------------------------------------------ time parsing */

test('a time is accepted in both one- and two-digit form', () => {
  assert.strictEqual(scheduler.parseTime('9:05').text, '09:05');
  assert.strictEqual(scheduler.parseTime('20:00').text, '20:00');
  assert.strictEqual(scheduler.parseTime(' 07:30 ').text, '07:30');
});

test('an impossible time is refused rather than wrapped around', () => {
  for (const bad of ['24:00', '12:60', '', 'abends', '8', '08:5', null, '1200']) {
    assert.strictEqual(scheduler.parseTime(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

/* --------------------------------------------------------------- sanitize */

test('an entry needs a profile, a time and at least one day', () => {
  assert.throws(() => scheduler.sanitize({ time: '20:00', days: [1] }), /Profil/);
  assert.throws(() => scheduler.sanitize({ profileId: 'p', days: [1] }), /HH:MM/);
  assert.throws(() => scheduler.sanitize({ profileId: 'p', time: '20:00', days: [] }), /Wochentag/);
});

test('days are de-duplicated, sorted and bounded to a week', () => {
  const entry = scheduler.sanitize({ profileId: 'p', time: '20:00', days: [5, 1, 1, 9, -2, 0, 6.5] });
  assert.deepStrictEqual(entry.days, [0, 1, 5]);
});

test('an unknown action falls back to launching', () => {
  assert.strictEqual(scheduler.sanitize({ profileId: 'p', time: '20:00', days: [1], action: 'formatC' }).action, 'launch');
  assert.strictEqual(scheduler.sanitize({ profileId: 'p', time: '20:00', days: [1], action: 'stop' }).action, 'stop');
});

/* ------------------------------------------------------------- due and next */

const MONDAY = new Date('2026-01-05T12:00:00');   // a Monday, midday
const entry = { profileId: 'p', time: '20:00', days: [1, 3], enabled: true, lastRun: 0 };

test('an entry is only due on the days it names', () => {
  assert.ok(scheduler.dueAt(entry, MONDAY) !== null, 'Monday is one of its days');
  const tuesday = new Date(MONDAY);
  tuesday.setDate(tuesday.getDate() + 1);
  assert.strictEqual(scheduler.dueAt(entry, tuesday), null, 'Tuesday is not');
});

test('the due moment is that day at that time, not the reference time', () => {
  const due = new Date(scheduler.dueAt(entry, MONDAY));
  assert.strictEqual(due.getHours(), 20);
  assert.strictEqual(due.getMinutes(), 0);
  assert.strictEqual(due.getDate(), MONDAY.getDate());
});

test('the next run is today when the time is still ahead', () => {
  const next = new Date(scheduler.nextRun(entry, MONDAY));
  assert.strictEqual(next.getDate(), MONDAY.getDate(), 'should still be today');
  assert.strictEqual(next.getHours(), 20);
});

test('the next run skips to the following chosen day once today has passed', () => {
  const lateMonday = new Date('2026-01-05T21:00:00');
  const next = new Date(scheduler.nextRun(entry, lateMonday));
  assert.strictEqual(next.getDay(), 3, 'Wednesday is the next chosen day');
});

test('a disabled entry has no next run at all', () => {
  assert.strictEqual(scheduler.nextRun({ ...entry, enabled: false }, MONDAY), null);
});

test('an entry that runs only on one day still finds it a week out', () => {
  const sundayOnly = { ...entry, days: [0] };
  const next = new Date(scheduler.nextRun(sundayOnly, MONDAY));
  assert.strictEqual(next.getDay(), 0);
  assert.ok(next.getTime() - MONDAY.getTime() < 8 * 24 * 3600 * 1000, 'must be within the week');
});

/* ---------------------------------------------------------------- catch-up */

test('the catch-up window is short enough that a missed slot is skipped', () => {
  assert.ok(scheduler.CATCH_UP_MS <= 15 * 60 * 1000,
    'a game must not start hours late because the machine was off');
  assert.ok(scheduler.CATCH_UP_MS >= 60 * 1000,
    'a tick that is a little late must still count as on time');
});

/* -------------------------------------------------------------- description */

test('common day sets get a readable name', () => {
  const describe = (days) => scheduler.describe({ days, time: '20:00' });
  assert.strictEqual(describe([0, 1, 2, 3, 4, 5, 6]), 'täglich um 20:00');
  assert.strictEqual(describe([1, 2, 3, 4, 5]), 'Mo–Fr um 20:00');
  assert.strictEqual(describe([0, 6]), 'Sa + So um 20:00');
  assert.strictEqual(describe([1, 4]), 'Mo, Do um 20:00');
});

console.log(`\n${passed} assertions passed.`);
