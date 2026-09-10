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

console.log(`\n${passed} assertions passed.`);
