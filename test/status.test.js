'use strict';

/**
 * Profile running-state logic and hotkey validation.
 *
 * Both are pure decision code that the UI leans on heavily, so they are
 * checked directly rather than only through a rendered view.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const hotkeys = require('../src/main/hotkeys');
const processes = require('../src/main/processes');

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

/**
 * Loads the browser-side helpers by stripping the export keywords, so the same
 * source the renderer runs is exercised here.
 */
function loadModule(relative, names) {
  const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8')
    .replace(/^export\s+/gm, '')
    .replace(/^import[^;]+;$/gm, '');
  const sandbox = { crypto: { randomUUID: () => 'id' }, console, document: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\n;__out = { ${names.join(', ')} };`, sandbox);
  return sandbox.__out;
}

const util = loadModule('src/renderer/js/util.js', ['normalizeProcessName', 'resolveProcessName', 'profileStatus']);
const keys = loadModule('src/renderer/js/keys.js', ['toAccelerator', 'formatAccelerator']);

console.log('Process name resolution');

test('an explicit process name wins over anything derived', () => {
  const app = { processName: 'helldivers2', launch: { type: 'exe', target: 'C:\\games\\launcher.exe' } };
  assert.strictEqual(util.resolveProcessName(app), 'helldivers2');
});

test('an executable launch derives its own name', () => {
  const app = { launch: { type: 'exe', target: 'C:\\Program Files\\Discord\\Discord.exe' } };
  assert.strictEqual(util.resolveProcessName(app), 'discord');
});

test('a steam URI has nothing to derive from', () => {
  const app = { launch: { type: 'uri', target: 'steam://rungameid/553850' } };
  assert.strictEqual(util.resolveProcessName(app), null);
});

test('the renderer and main normalise names identically', () => {
  for (const value of ['Game.exe', 'GAME', '  discord.EXE ', 'steam', 'a.b.exe']) {
    assert.strictEqual(
      util.normalizeProcessName(value),
      processes.normalizeName(value),
      `mismatch for ${value}`
    );
  }
});

console.log('\nProfile status');

const profile = (apps) => ({ apps });
const running = (...names) => new Set(names);

test('every tracked entry alive reports running', () => {
  const p = profile([
    { name: 'Spotify', processName: 'spotify', launch: { type: 'uri', target: 'spotify:' } },
    { name: 'Game', processName: 'helldivers2', launch: { type: 'uri', target: 'steam://rungameid/553850' } }
  ]);
  const s = util.profileStatus(p, running('spotify', 'helldivers2'));
  assert.strictEqual(s.state, 'running');
  assert.strictEqual(s.running, 2);
  assert.strictEqual(s.tracked, 2);
});

test('some alive reports partial', () => {
  const p = profile([
    { name: 'Spotify', processName: 'spotify', launch: { type: 'uri', target: 'spotify:' } },
    { name: 'Game', processName: 'helldivers2', launch: { type: 'uri', target: 'steam://rungameid/553850' } }
  ]);
  const s = util.profileStatus(p, running('spotify'));
  assert.strictEqual(s.state, 'partial');
  assert.strictEqual(s.running, 1);
});

test('none alive reports idle', () => {
  const p = profile([{ name: 'Game', processName: 'helldivers2', launch: { type: 'uri', target: 'x:' } }]);
  assert.strictEqual(util.profileStatus(p, running('explorer')).state, 'idle');
});

test('a profile with nothing trackable reports unknown, not stopped', () => {
  // Claiming "stopped" for entries the hub cannot observe would be a lie.
  const p = profile([{ name: 'Game', launch: { type: 'uri', target: 'steam://rungameid/553850' } }]);
  const s = util.profileStatus(p, running('helldivers2'));
  assert.strictEqual(s.state, 'unknown');
  assert.strictEqual(s.tracked, 0);
});

test('disabled entries are ignored', () => {
  const p = profile([
    { name: 'Off', processName: 'notrunning', enabled: false, launch: { type: 'uri', target: 'x:' } },
    { name: 'On', processName: 'spotify', launch: { type: 'uri', target: 'y:' } }
  ]);
  const s = util.profileStatus(p, running('spotify'));
  assert.strictEqual(s.state, 'running');
  assert.strictEqual(s.tracked, 1);
});

test('untrackable entries do not drag a running profile down', () => {
  const p = profile([
    { name: 'Game', processName: 'helldivers2', launch: { type: 'uri', target: 'x:' } },
    { name: 'Mystery', launch: { type: 'uri', target: 'y:' } }
  ]);
  const s = util.profileStatus(p, running('helldivers2'));
  assert.strictEqual(s.state, 'running');
  assert.strictEqual(s.tracked, 1);
  assert.strictEqual(s.total, 2);
});

test('an empty profile is unknown rather than crashing', () => {
  assert.strictEqual(util.profileStatus({ apps: [] }, running()).state, 'unknown');
  assert.strictEqual(util.profileStatus({}, running()).state, 'unknown');
});

console.log('\nHotkey capture');

const ev = (code, mods = {}) => ({
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta
});

test('a modified letter becomes an accelerator', () => {
  assert.strictEqual(keys.toAccelerator(ev('KeyH', { alt: true, shift: true })), 'Alt+Shift+H');
  assert.strictEqual(keys.toAccelerator(ev('KeyG', { ctrl: true })), 'Ctrl+G');
});

test('function and named keys map correctly', () => {
  assert.strictEqual(keys.toAccelerator(ev('F9', { ctrl: true })), 'Ctrl+F9');
  assert.strictEqual(keys.toAccelerator(ev('Space', { alt: true })), 'Alt+Space');
  assert.strictEqual(keys.toAccelerator(ev('ArrowUp', { ctrl: true, alt: true })), 'Ctrl+Alt+Up');
  assert.strictEqual(keys.toAccelerator(ev('Digit4', { ctrl: true })), 'Ctrl+4');
});

test('a bare key is refused', () => {
  // Registering this globally would swallow the key everywhere else.
  assert.strictEqual(keys.toAccelerator(ev('KeyH')), null);
  assert.strictEqual(keys.toAccelerator(ev('F9')), null);
});

test('modifiers on their own are refused', () => {
  assert.strictEqual(keys.toAccelerator(ev('ShiftLeft', { shift: true })), null);
  assert.strictEqual(keys.toAccelerator(ev('ControlLeft', { ctrl: true })), null);
});

test('accelerators render in German', () => {
  assert.strictEqual(keys.formatAccelerator('Alt+Shift+H'), 'Alt + Umschalt + H');
  assert.strictEqual(keys.formatAccelerator('Ctrl+Alt+Up'), 'Strg + Alt + ↑');
  assert.strictEqual(keys.formatAccelerator(''), '');
});

console.log('\nHotkey validation (main process)');

test('an empty binding is allowed and means unbound', () => {
  assert.strictEqual(hotkeys.validate(''), null);
});

test('a valid combination passes', () => {
  assert.strictEqual(hotkeys.validate('Alt+Shift+H'), null);
  assert.strictEqual(hotkeys.validate('CommandOrControl+Shift+F1'), null);
});

test('a bare key is rejected on the main side too', () => {
  assert.ok(hotkeys.validate('H'), 'should report a problem');
  assert.ok(hotkeys.validate('F9'), 'should report a problem');
});

test('a combination of only modifiers is rejected', () => {
  assert.ok(hotkeys.validate('Ctrl+Shift'), 'should report a problem');
});

test('nonsense modifiers are rejected', () => {
  assert.ok(hotkeys.validate('Banana+H'), 'should report a problem');
});

console.log(`\n${passed} assertions passed.`);
