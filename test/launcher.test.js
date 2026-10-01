'use strict';

/**
 * Which processes a profile is responsible for closing.
 *
 * This is where a real bug lived: stopping a profile only derived a process
 * name for entries launched from an exe path. A profile that starts Spotify
 * through `spotify:` contributed nothing at all, so the program was never in
 * the list — and the hub still reported that the profile had been stopped.
 * Silence is the worst possible outcome here, so the assertions cover both
 * what is resolved and what is deliberately reported as unresolvable.
 */

const assert = require('assert');
const launcher = require('../src/main/launcher');

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

const app = (name, type, target, extra = {}) => ({ name, launch: { type, target }, ...extra });

console.log('Profil beenden');

/* --------------------------------------------------------- single entries */

test('an exe entry resolves to its file name without the extension', () => {
  assert.deepStrictEqual(launcher.namesForApp(app('Spiel', 'exe', 'D:\\Games\\HD2\\helldivers2.exe')), ['helldivers2']);
  assert.deepStrictEqual(launcher.namesForApp(app('Tool', 'exe', '/opt/tool/run')), ['run']);
});

test('an explicit process name wins over everything derived', () => {
  const entry = app('Spiel', 'exe', 'D:\\Games\\launcher.exe', { processName: 'helldivers2.exe' });
  assert.deepStrictEqual(launcher.namesForApp(entry), ['helldivers2']);
});

test('a protocol handler that is the program itself resolves', () => {
  assert.deepStrictEqual(launcher.namesForApp(app('Spotify', 'uri', 'spotify:')), ['Spotify']);
  assert.ok(launcher.namesForApp(app('Discord', 'uri', 'discord://')).includes('Discord'));
});

test('a launcher URI that starts something else stays unresolved', () => {
  // Mapping this to Steam would close the launcher and leave the game running,
  // which looks like success and is worse than doing nothing.
  assert.deepStrictEqual(launcher.namesForApp(app('Spiel', 'uri', 'steam://rungameid/553850')), []);
  assert.deepStrictEqual(launcher.namesForApp(app('Spiel', 'uri', 'com.epicgames.launcher://apps/fortnite')), []);
  // Opening the launcher itself is a different matter.
  assert.deepStrictEqual(launcher.namesForApp(app('Steam', 'uri', 'steam://open/games')), ['steam']);
});

test('a Store app resolves to the id after the exclamation mark', () => {
  assert.deepStrictEqual(
    launcher.namesForApp(app('Spotify', 'appsfolder', 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify')),
    ['Spotify']
  );
});

test('a shell command resolves to its first token', () => {
  assert.deepStrictEqual(launcher.namesForApp(app('Skript', 'shell', '"C:\\Tools\\my app.exe" --flag')), ['my app']);
  assert.deepStrictEqual(launcher.namesForApp(app('Skript', 'shell', 'notepad.exe C:\\x.txt')), ['notepad']);
});

test('an unknown protocol resolves to nothing rather than to a guess', () => {
  assert.deepStrictEqual(launcher.namesForApp(app('Irgendwas', 'uri', 'zzz-unbekannt://start')), []);
});

/* ------------------------------------------------------------ whole plans */

const PROFILE = {
  name: 'Helldivers 2',
  apps: [
    app('Spotify', 'uri', 'spotify:'),
    app('Discord', 'uri', 'discord://'),
    app('Spiel', 'uri', 'steam://rungameid/553850'),
    app('Overlay', 'exe', 'C:\\Tools\\overlay.exe'),
    app('Aus', 'exe', 'C:\\Tools\\aus.exe', { enabled: false })
  ],
  alsoClose: ['chrome.exe', 'C:\\Programs\\Teams\\Teams.exe']
};

test('the plan covers every launch type the profile uses', () => {
  const plan = launcher.stopPlan(PROFILE);
  assert.ok(plan.names.includes('Spotify'), 'Spotify was the entry that used to be missing');
  assert.ok(plan.names.includes('Discord'));
  assert.ok(plan.names.includes('overlay'));
});

test('extra names are stripped of path and extension', () => {
  const plan = launcher.stopPlan(PROFILE);
  assert.ok(plan.names.includes('chrome'));
  assert.ok(plan.names.includes('Teams'));
});

test('a disabled entry is not closed', () => {
  const plan = launcher.stopPlan(PROFILE);
  assert.ok(!plan.names.includes('aus'), 'a switched-off step is not part of the profile');
});

test('what cannot be resolved is reported, not dropped', () => {
  const plan = launcher.stopPlan(PROFILE);
  assert.strictEqual(plan.unresolved.length, 1);
  assert.strictEqual(plan.unresolved[0].name, 'Spiel');
  assert.strictEqual(plan.unresolved[0].type, 'uri');
});

test('the same name from two entries is only killed once', () => {
  const plan = launcher.stopPlan({
    apps: [app('A', 'exe', 'C:\\x\\same.exe'), app('B', 'exe', 'D:\\y\\same.exe')],
    alsoClose: ['same']
  });
  assert.deepStrictEqual(plan.names, ['same']);
});

test('an empty profile produces an empty plan rather than throwing', () => {
  assert.deepStrictEqual(launcher.stopPlan({ apps: [] }), { names: [], unresolved: [] });
  assert.deepStrictEqual(launcher.stopPlan({}), { names: [], unresolved: [] });
});

/* ------------------------------------------------------------ stop them all */
/*
 * One button for "close everything". The plan is what the dialog shows, so the
 * two mistakes worth pinning are both about the list: killing the same program
 * once per profile that names it, and reporting an unresolved entry without
 * saying which profile to go and fix.
 */

console.log('\nAlles beenden');

const ALL = [
  {
    id: 'p1',
    name: 'Zocken',
    apps: [app('Spiel', 'exe', 'D:\\hd2.exe'), app('Discord', 'uri', 'discord://')],
    alsoClose: ['chrome.exe']
  },
  {
    id: 'p2',
    name: 'Arbeit',
    // Discord again, on purpose: the same program in two profiles.
    apps: [app('Discord', 'uri', 'discord://'), app('Editor', 'exe', 'C:\\code.exe')]
  },
  {
    id: 'p3',
    name: 'Steam-Spiel',
    apps: [app('Irgendwas', 'uri', 'steam://rungameid/553850')]
  }
];

test('a program named by two profiles is listed once', () => {
  const plan = launcher.stopAllPlan(ALL);
  assert.strictEqual(plan.names.filter((n) => n === 'Discord').length, 1,
    `Discord appears more than once: ${plan.names.join(', ')}`);
  assert.ok(plan.names.includes('hd2'));
  assert.ok(plan.names.includes('code'));
  assert.ok(plan.names.includes('chrome'), 'alsoClose is part of it too');
});

test('an unresolved entry says which profile it came from', () => {
  // Without the profile name this is useless advice: "one entry cannot be
  // matched" leaves somebody searching five profiles for it.
  const plan = launcher.stopAllPlan(ALL);
  assert.strictEqual(plan.unresolved.length, 1);
  assert.strictEqual(plan.unresolved[0].name, 'Irgendwas');
  assert.strictEqual(plan.unresolved[0].profile, 'Steam-Spiel');
});

test('every profile is accounted for, running or not', () => {
  const plan = launcher.stopAllPlan(ALL);
  assert.deepStrictEqual(plan.profiles.map((p) => p.name), ['Zocken', 'Arbeit', 'Steam-Spiel']);
});

test('a disabled entry is left out here as well', () => {
  const plan = launcher.stopAllPlan([
    { id: 'x', name: 'P', apps: [app('Aus', 'exe', 'C:\\off.exe', { enabled: false }), app('An', 'exe', 'C:\\on.exe')] }
  ]);
  assert.deepStrictEqual(plan.names, ['on']);
});

test('nothing at all is an empty plan, not a throw', () => {
  assert.deepStrictEqual(launcher.stopAllPlan([]), { names: [], unresolved: [], profiles: [] });
  assert.deepStrictEqual(launcher.stopAllPlan(null), { names: [], unresolved: [], profiles: [] });
  // A null in the list is skipped rather than turned into "Unbenannt".
  assert.deepStrictEqual(launcher.stopAllPlan([null]).profiles, []);
});

test('a profile without a name still gets one in the plan', () => {
  const plan = launcher.stopAllPlan([{ id: 'x', apps: [app('A', 'uri', 'steam://rungameid/1')] }]);
  assert.strictEqual(plan.profiles[0].name, 'Unbenannt');
  assert.strictEqual(plan.unresolved[0].profile, 'Unbenannt');
});

/* ------------------------------------------------------ waiting for a step */
/*
 * The setting that replaces "wait two seconds and hope". What can go wrong here
 * is not the polling but the decision: a wait on an entry the hub cannot
 * recognise would tick along to its deadline and look like a slow program,
 * when in truth nothing was ever being watched for.
 */

console.log('\nWarten auf ein Programm');

test('no wait is the default, and it stays the default', () => {
  assert.strictEqual(launcher.readyPlan(app('X', 'exe', 'C:\\x.exe')).kind, 'none');
  assert.strictEqual(launcher.readyPlan(app('X', 'exe', 'C:\\x.exe', { waitFor: 'none' })).kind, 'none');
  assert.strictEqual(launcher.readyPlan(null).kind, 'none');
});

test('a wait on an entry with a process name is planned as asked', () => {
  const plan = launcher.readyPlan(app('Spiel', 'exe', 'D:\\hd2.exe', { waitFor: 'process' }));
  assert.strictEqual(plan.kind, 'process');
  assert.deepStrictEqual(plan.names, ['hd2']);
  assert.strictEqual(plan.reason, undefined);
});

test('an entry without a process name cannot be waited for, and says so', () => {
  // The exact case: a steam:// game id names a game, not a process. Waiting for
  // it would run the full budget every launch and look like a slow game.
  const plan = launcher.readyPlan(app('Spiel', 'uri', 'steam://rungameid/553850', { waitFor: 'window' }));
  assert.strictEqual(plan.kind, 'none');
  assert.strictEqual(plan.asked, 'window');
  assert.match(plan.reason, /Prozessname/);
});

test('a window wait falls back to the process when the helper is unavailable', () => {
  const plan = launcher.readyPlan(app('Discord', 'uri', 'discord://', { waitFor: 'window' }), { windows: false });
  assert.strictEqual(plan.kind, 'process');
  assert.strictEqual(plan.asked, 'window');
  assert.match(plan.reason, /Prozess/);
});

test('an unknown condition is reported, never silently turned into a wait', () => {
  const plan = launcher.readyPlan(app('X', 'exe', 'C:\\x.exe', { waitFor: 'fenster' }));
  assert.strictEqual(plan.kind, 'none');
  assert.match(plan.reason, /Unbekannte Wartebedingung/);
});

test('a process counts as up whatever case or extension it is reported in', () => {
  assert.ok(launcher.isUp('process', ['Spotify'], { running: ['chrome', 'SPOTIFY.exe'] }));
  assert.ok(launcher.isUp('process', ['hd2'], { running: ['hd2'] }));
  assert.ok(!launcher.isUp('process', ['hd2'], { running: ['hd2launcher'] }));
});

test('a window wait is not satisfied by the process alone', () => {
  const running = { running: ['hd2'], windows: [] };
  assert.ok(!launcher.isUp('window', ['hd2'], running));
  assert.ok(launcher.isUp('window', ['hd2'], { windows: [{ process: 'hd2.exe' }] }));
});

test('nothing to watch for is not the same as already up', () => {
  // Answering true here would turn "cannot be waited for" into a silent pass.
  assert.ok(!launcher.isUp('process', [], { running: ['hd2'] }));
});

test('the wait budget has a floor, a ceiling and a default', () => {
  assert.strictEqual(launcher.readyTimeout({}), launcher.READY_MS);
  assert.strictEqual(launcher.readyTimeout({ waitTimeoutMs: 0 }), launcher.READY_MS);
  assert.strictEqual(launcher.readyTimeout({ waitTimeoutMs: 50 }), 2000);
  assert.strictEqual(launcher.readyTimeout({ waitTimeoutMs: 999999 }), 180000);
  assert.strictEqual(launcher.readyTimeout({ waitTimeoutMs: 8000 }), 8000);
});

/* The loop itself, with the machine replaced by a counter. */

const later = [];
const asyncTest = (name, fn) => later.push([name, fn]);

asyncTest('the wait ends when the program appears, not when a timer runs out', async () => {
  let calls = 0;
  const outcome = await launcher.waitUntilUp(
    { kind: 'process', names: ['hd2'] },
    {
      timeoutMs: 20000,
      intervalMs: 1,
      probe: async () => {
        calls += 1;
        return { running: calls >= 3 ? ['hd2'] : [] };
      }
    }
  );
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(calls, 3, 'stopped on the third answer, not after a fixed wait');
});

asyncTest('an exhausted budget reports it and does not throw', async () => {
  const outcome = await launcher.waitUntilUp(
    { kind: 'process', names: ['hd2'] },
    { timeoutMs: 0, intervalMs: 1, probe: async () => ({ running: [] }) }
  );
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.reason, /Zeit/);
});

asyncTest('a probe that fails ends the wait instead of looping on the error', async () => {
  const outcome = await launcher.waitUntilUp(
    { kind: 'process', names: ['hd2'] },
    { timeoutMs: 20000, intervalMs: 1, probe: async () => { throw new Error('Host weg'); } }
  );
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'Host weg');
});

(async () => {
  for (const [name, fn] of later) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok   ${name}`);
    } catch (err) {
      console.error(`  FAIL ${name}\n       ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed} assertions passed.`);
})();
