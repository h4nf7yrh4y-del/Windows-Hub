'use strict';

/**
 * Logger rotation, diagnostics redaction and config migration.
 *
 * The redaction test matters most: the report exists to be pasted into a chat
 * or an issue, so anything that leaks a user's directory layout or embeds a
 * megabyte of artwork is a defect, not a cosmetic issue.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

/* --------------------------------------------------------------- logger */

const logger = require('../src/main/logger');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-log-'));

console.log('Logger');

test('init creates the directory and returns the file path', () => {
  const file = logger.init({ dir: tmp, level: 'debug', console: false });
  assert.ok(fs.existsSync(tmp), 'directory missing');
  assert.strictEqual(path.basename(file), 'hub.log');
});

test('entries reach the file with level and scope', () => {
  logger.write('info', 'test', 'hallo welt');
  const content = fs.readFileSync(path.join(tmp, 'hub.log'), 'utf8');
  assert.ok(content.includes('INFO'), 'level missing');
  assert.ok(content.includes('[test]'), 'scope missing');
  assert.ok(content.includes('hallo welt'), 'message missing');
});

test('an Error is written with its stack', () => {
  logger.write('error', 'test', new Error('kaputt'));
  const content = fs.readFileSync(path.join(tmp, 'hub.log'), 'utf8');
  assert.ok(content.includes('kaputt'));
  assert.ok(/at .*diagnostics\.test/.test(content), 'stack missing');
});

test('entries below the level are kept out of the file', () => {
  logger.setLevel('warn');
  const before = fs.readFileSync(path.join(tmp, 'hub.log'), 'utf8').length;
  logger.write('debug', 'test', 'sollte fehlen');
  const after = fs.readFileSync(path.join(tmp, 'hub.log'), 'utf8');
  assert.strictEqual(after.length, before, 'debug entry was written anyway');
  // It is still available in memory for the report.
  assert.ok(logger.tail(50).some((l) => l.includes('sollte fehlen')));
  logger.setLevel('debug');
});

test('the in-memory tail is bounded', () => {
  for (let i = 0; i < 600; i += 1) logger.write('debug', 'test', `zeile ${i}`);
  const tail = logger.tail(1000);
  assert.ok(tail.length <= 400, `tail grew to ${tail.length}`);
  assert.ok(tail[tail.length - 1].includes('zeile 599'));
});

test('the file rotates once it grows past the limit', () => {
  const filler = 'x'.repeat(4000);
  for (let i = 0; i < 700; i += 1) logger.write('info', 'test', filler);
  const files = fs.readdirSync(tmp).filter((f) => /^hub(\.\d+)?\.log$/.test(f));
  assert.ok(files.length > 1, `expected rotation, found ${files.join(', ')}`);
  assert.ok(files.length <= 4, `too many kept: ${files.join(', ')}`);
  assert.ok(files.includes('hub.1.log'), 'rotated file missing');
});

test('paths() reports the files it keeps', () => {
  const info = logger.paths();
  assert.strictEqual(info.dir, tmp);
  assert.ok(info.files.length >= 2);
  assert.ok(info.files.every((f) => typeof f.size === 'number'));
});

/* ---------------------------------------------------- diagnostics redaction */

console.log('\nDiagnose-Bericht');

// diagnostics.js pulls in electron, so only the pure part is exercised here.
const { sanitizeConfig } = (() => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/diagnostics.js'), 'utf8');
  // Starts at baseName, which sanitizeConfig depends on, and stops before the
  // first function that needs Electron.
  const start = source.indexOf('function baseName');
  const end = source.indexOf('async function probe');
  const body = source.slice(start, end);
  const factory = new Function('path', `${body}; return { sanitizeConfig };`);
  return factory(path);
})();

const SAMPLE = {
  settings: { accent: '#00f0ff', autostart: true },
  hotkeys: { toggleHub: 'Alt+Shift+H' },
  overlays: { combo: { enabled: true } },
  profiles: [{
    name: 'HELLDIVERS 2',
    accent: '#ffd400',
    cover: `data:image/jpeg;base64,${'A'.repeat(500000)}`,
    minimizeOnLaunch: true,
    launchCount: 12,
    apps: [
      { name: 'Spiel', launch: { type: 'exe', target: 'C:\\Users\\alexander\\Games\\Secret\\game.exe' }, delayMs: 0, processName: 'game' },
      { name: 'Steam-Titel', launch: { type: 'uri', target: 'steam://rungameid/553850' }, delayMs: 2000 }
    ]
  }]
};

test('cover images are dropped, not embedded', () => {
  const out = sanitizeConfig(SAMPLE);
  const text = JSON.stringify(out);
  assert.ok(!text.includes('data:image'), 'a cover image survived into the report');
  assert.ok(text.length < 4000, `report grew to ${text.length} characters`);
  assert.strictEqual(out.profiles[0].hasCover, true, 'the fact that a cover exists should survive');
});

test('executable paths are reduced to their file name', () => {
  const out = sanitizeConfig(SAMPLE);
  const app = out.profiles[0].apps[0];
  assert.strictEqual(app.target, 'game.exe');
  const text = JSON.stringify(out);
  assert.ok(!text.includes('alexander'), 'the user directory leaked');
  assert.ok(!text.includes('Secret'), 'a directory name leaked');
});

test('URIs are kept, since they carry no personal path', () => {
  const out = sanitizeConfig(SAMPLE);
  assert.strictEqual(out.profiles[0].apps[1].target, 'steam://rungameid/553850');
});

test('settings and hotkeys are carried through', () => {
  const out = sanitizeConfig(SAMPLE);
  assert.strictEqual(out.settings.autostart, true);
  assert.strictEqual(out.hotkeys.toggleHub, 'Alt+Shift+H');
  assert.strictEqual(out.profileCount, 1);
});

test('an empty configuration does not throw', () => {
  assert.doesNotThrow(() => sanitizeConfig({}));
  assert.strictEqual(sanitizeConfig({}).profileCount, 0);
});

/* ------------------------------------------------------ config migration */

console.log('\nKonfigurations-Migration');

const store = require('../src/main/store');

test('a current configuration is left alone', () => {
  const result = store.migrate({ version: store.SCHEMA_VERSION, profiles: [] });
  assert.strictEqual(result.migrated, false);
});

test('a configuration from a newer build is kept, not discarded', () => {
  const result = store.migrate({ version: store.SCHEMA_VERSION + 5, profiles: [{ name: 'X' }] });
  assert.strictEqual(result.newer, true);
  assert.strictEqual(result.config.profiles.length, 1, 'profiles must survive');
});

test('a configuration with no version is treated as version 1', () => {
  const result = store.migrate({ profiles: [] });
  assert.strictEqual(result.from, 1);
});

console.log(`\n${passed} assertions passed.`);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
