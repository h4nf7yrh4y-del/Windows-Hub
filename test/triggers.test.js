'use strict';

/**
 * Profiles that react to a running program.
 *
 * The part worth testing is the state machine, because every one of its
 * mistakes is silent: acting twice on the same launch, giving the system state
 * back while the game is still up, or holding it forever after the game is
 * gone. None of those look like errors -- they look like a power plan that is
 * wrong for no reason.
 *
 * `evaluate` takes the process list as an argument precisely so it can be
 * driven from here without a clock and without Windows.
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-trigger-'));

const realResolve = Module._resolveFilename;
const stub = {
  app: { getPath: () => TMP, getVersion: () => '0.0.0', isPackaged: false },
  shell: {},
  powerSaveBlocker: { start: () => 1, stop: () => {}, isStarted: () => false }
};
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

const store = require('../src/main/store');
const tweaks = require('../src/main/tweaks');
const triggers = require('../src/main/triggers');

let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

const queue = [];
const add = (name, fn) => queue.push([name, fn]);

console.log('Profil-Auslöser');

/* ------------------------------------------------------------------ shape */

add('an unset trigger is off and reverts', () => {
  const t = triggers.sanitize(undefined);
  assert.strictEqual(t.enabled, false);
  assert.strictEqual(t.action, 'system');
  assert.strictEqual(t.revertOnExit, true);
  assert.deepStrictEqual(t.processes, []);
});

add('an unknown action falls back to the harmless one', () => {
  // "full" starts programs. Anything that is not exactly that must not be
  // read as it -- a typo in a config file should not launch a game.
  assert.strictEqual(triggers.sanitize({ action: 'quatsch' }).action, 'system');
  assert.strictEqual(triggers.sanitize({ action: 'FULL' }).action, 'system');
  assert.strictEqual(triggers.sanitize({ action: 'full' }).action, 'full');
});

add('process names are cleaned and deduplicated', () => {
  const t = triggers.sanitize({ processes: ['Game.exe', 'game', 'GAME.EXE', '', null, 'other'] });
  assert.deepStrictEqual(t.processes, ['game', 'other']);
});

add('a garbage trigger does not throw', () => {
  assert.doesNotThrow(() => triggers.sanitize('nonsense'));
  assert.doesNotThrow(() => triggers.sanitize({ processes: 'not-an-array' }));
  assert.deepStrictEqual(triggers.sanitize({ processes: 'nope' }).processes, []);
});

/* ------------------------------------------------------------- what to watch */

add('without its own names the profile\'s programs are watched', () => {
  const profile = {
    id: 'p1',
    name: 'Spiel',
    apps: [
      { enabled: true, launch: { type: 'exe', target: 'C:\\Games\\Helldivers2.exe' } },
      { enabled: true, launch: { type: 'exe', target: 'C:\\Tools\\Discord.exe' } }
    ]
  };
  const names = triggers.watchNames(profile);
  assert.ok(names.includes('helldivers2'), names.join(','));
  assert.ok(names.includes('discord'), names.join(','));
});

add('its own names win over the derived ones', () => {
  const profile = {
    id: 'p1',
    trigger: { enabled: true, processes: ['handpicked'] },
    apps: [{ enabled: true, launch: { type: 'exe', target: 'C:\\Games\\Other.exe' } }]
  };
  assert.deepStrictEqual(triggers.watchNames(profile), ['handpicked']);
});

add('a profile of launcher addresses alone yields nothing to watch', () => {
  // This is the case that has to be reported rather than silently watched for:
  // steam://rungameid starts something whose process name is not in the URI.
  const profile = {
    id: 'p1',
    apps: [{ enabled: true, launch: { type: 'uri', target: 'steam://rungameid/553850' } }]
  };
  assert.deepStrictEqual(triggers.watchNames(profile), []);
});

add('a disabled entry is not watched for', () => {
  const profile = {
    id: 'p1',
    apps: [
      { enabled: false, launch: { type: 'exe', target: 'C:\\Games\\Off.exe' } },
      { enabled: true, launch: { type: 'exe', target: 'C:\\Games\\On.exe' } }
    ]
  };
  assert.deepStrictEqual(triggers.watchNames(profile), ['on']);
});

/* ----------------------------------------------------------- the machine */

function seed(trigger) {
  const state = store.state;
  state.profiles = [{
    id: 'p1',
    name: 'Testprofil',
    apps: [{ enabled: true, launch: { type: 'exe', target: 'C:\\Games\\Game.exe' } }],
    // No system changes: apply() returns early, so these cases exercise the
    // machine rather than Windows.
    system: tweaks.defaults(),
    trigger
  }];
  state.tweakSnapshot = null;
  triggers._seen.clear();
  return state.profiles[0];
}

function memory() {
  return triggers._seen.get('p1') || null;
}

add('a disabled trigger never reacts', async () => {
  seed({ enabled: false });
  await triggers.evaluate(['game']);
  assert.strictEqual(memory(), null, 'nothing should be remembered');
});

add('an appearing program is noticed once, not on every pass', async () => {
  seed({ enabled: true });
  await triggers.evaluate(['game']);
  assert.strictEqual(memory().running, true);
  const first = memory().heldSince;

  await triggers.evaluate(['game']);
  await triggers.evaluate(['game', 'chrome']);
  assert.strictEqual(memory().heldSince, first, 'it must not act again while it is still running');
});

add('a single missed pass does not give the state back', async () => {
  // Games restart their own process between launcher and engine. Reverting
  // there flips the power plan across a loading screen.
  seed({ enabled: true });
  await triggers.evaluate(['game']);
  await triggers.evaluate([]);
  assert.strictEqual(memory().running, true, 'still considered running');
  assert.strictEqual(memory().missedTicks, 1);
});

add('after enough missed passes it counts as gone', async () => {
  seed({ enabled: true });
  await triggers.evaluate(['game']);
  for (let i = 0; i < triggers.GONE_TICKS; i += 1) await triggers.evaluate([]);
  assert.strictEqual(memory().running, false);
  assert.strictEqual(memory().missedTicks, 0, 'the counter resets for the next launch');
});

add('a restart within the grace period is not two launches', async () => {
  seed({ enabled: true });
  await triggers.evaluate(['game']);
  const held = memory().heldSince;
  await triggers.evaluate([]);
  await triggers.evaluate(['game']);
  assert.strictEqual(memory().running, true);
  assert.strictEqual(memory().missedTicks, 0);
  assert.strictEqual(memory().heldSince, held, 'the same launch, not a new one');
});

add('another profile holding the system state is not overruled', async () => {
  const profile = seed({ enabled: true });
  profile.system = { ...tweaks.defaults(), keepAwake: true };
  // Somebody else owns the single power plan and the single list of closed
  // programs. Taking it would leave their state unrecoverable.
  store.state.tweakSnapshot = { profileId: 'someone-else', profileName: 'Anderes', at: Date.now(), closed: [] };

  await triggers.evaluate(['game']);
  assert.strictEqual(memory().running, true, 'it still notices');
  assert.ok(!memory().heldSince, 'but it does not take the state');
  store.state.tweakSnapshot = null;
});

add('names are matched however the process list spells them', async () => {
  seed({ enabled: true, processes: ['game'] });
  await triggers.evaluate(['GAME.EXE']);
  assert.strictEqual(memory().running, true);
});

add('an unrelated process list changes nothing', async () => {
  seed({ enabled: true });
  await triggers.evaluate(['chrome', 'explorer', 'steam']);
  assert.strictEqual(memory().running, false);
  assert.strictEqual(memory().heldSince, null);
});

/* ---------------------------------------------------------------- listing */

add('the listing says why a trigger cannot fire', () => {
  const state = store.state;
  state.profiles = [{
    id: 'p2',
    name: 'Nur Steam',
    apps: [{ enabled: true, launch: { type: 'uri', target: 'steam://rungameid/553850' } }],
    trigger: { enabled: true }
  }];
  triggers._seen.clear();

  const row = triggers.list().find((r) => r.profileId === 'p2');
  assert.strictEqual(row.usable, false);
  assert.ok(row.reason && row.reason.length > 20, String(row.reason));
  assert.ok(/Prozessnamen/.test(row.reason), row.reason);
});

add('a usable trigger reports no complaint', () => {
  const state = store.state;
  state.profiles = [{
    id: 'p3',
    name: 'Gut',
    apps: [{ enabled: true, launch: { type: 'exe', target: 'C:\\Games\\Good.exe' } }],
    trigger: { enabled: true }
  }];
  const row = triggers.list().find((r) => r.profileId === 'p3');
  assert.strictEqual(row.usable, true);
  assert.strictEqual(row.reason, null);
});

(async () => {
  for (const [name, fn] of queue) await test(name, fn);
  triggers.stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  console.log(`\n${passed} assertions passed.`);
})();
