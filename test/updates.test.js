'use strict';

/**
 * The update parsers.
 *
 * Both of them read text that was written for a human to look at, which is
 * where this breaks silently: a parser that finds nothing produces "everything
 * is up to date", and nobody investigates good news. The winget table is
 * localised, so the assertions cover a German listing as well as an English
 * one — matching on header text would work in exactly one language.
 */

const assert = require('assert');
const updates = require('../src/main/updates');

let passed = 0;

/**
 * Awaits the body.
 *
 * A synchronous runner would call an async case, get a promise back, throw it
 * away and print "ok" whatever happened — which is how a test that checks
 * nothing looks exactly like a test that passes.
 */
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

console.log('Updates');

/* --------------------------------------------------------------- winget */

const ENGLISH = [
  'Name                           Id                       Version      Available    Source',
  '-----------------------------------------------------------------------------------------',
  'Mozilla Firefox (x64 en-US)    Mozilla.Firefox          142.0        143.0.1      winget',
  'Steam                          Valve.Steam              1758.0       1759.2       winget',
  '',
  '2 upgrades available.'
].join('\n');

const GERMAN = [
  'Name                           ID                       Version      Verfügbar    Quelle',
  '-----------------------------------------------------------------------------------------',
  'Discord                        Discord.Discord          1.0.9200     1.0.9205     winget',
  '',
  '1 Upgrades verfügbar.'
].join('\n');

add('an English listing is parsed', () => {
  const rows = updates.parseUpgrades(ENGLISH);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].id, 'Mozilla.Firefox');
  assert.strictEqual(rows[0].current, '142.0');
  assert.strictEqual(rows[0].available, '143.0.1');
  assert.strictEqual(rows[1].name, 'Steam');
});

add('a German listing is parsed the same way', () => {
  // The columns are in the same places; only the words above them differ.
  const rows = updates.parseUpgrades(GERMAN);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 'Discord.Discord');
  assert.strictEqual(rows[0].available, '1.0.9205');
});

add('a name containing spaces stays in one piece', () => {
  const rows = updates.parseUpgrades(ENGLISH);
  assert.strictEqual(rows[0].name, 'Mozilla Firefox (x64 en-US)');
});

add('the summary line is not mistaken for a package', () => {
  const ids = updates.parseUpgrades(ENGLISH).map((r) => r.id);
  assert.ok(!ids.some((id) => /upgrades/i.test(id)), ids.join(', '));
});

add('a listing without an Available column yields nothing', () => {
  // This is `winget list` output: four columns, nothing to upgrade.
  const text = [
    'Name        Id                Version    Source',
    '------------------------------------------------',
    'Steam       Valve.Steam       1758.0     winget'
  ].join('\n');
  assert.deepStrictEqual(updates.parseUpgrades(text), []);
});

add('a package pinned to an unknown version is skipped, not reported as current', () => {
  const text = [
    'Name        Id                Version      Available    Source',
    '----------------------------------------------------------------',
    'Seltsam     Weird.App         1.2.3        1.2.3        winget',
    'Gut         Good.App          1.0          2.0          winget'
  ].join('\n');
  const rows = updates.parseUpgrades(text);
  assert.strictEqual(rows.length, 1, 'an unchanged version is not an upgrade');
  assert.strictEqual(rows[0].id, 'Good.App');
});

add('output with no table at all is empty rather than an error', () => {
  assert.deepStrictEqual(updates.parseUpgrades(''), []);
  assert.deepStrictEqual(updates.parseUpgrades('Es ist alles aktuell.'), []);
  assert.deepStrictEqual(updates.parseUpgrades(null), []);
});

add('progress spinners and carriage returns are stripped before parsing', () => {
  // winget draws a spinner that overwrites itself; a naive split on newlines
  // turns that into a hundred empty rows.
  const noisy = `-\r\\\r|\r/\r${ENGLISH}`;
  const rows = updates.parseUpgrades(noisy);
  assert.strictEqual(rows.length, 2, 'the spinner must not break the table');
});

add('the second table of untargetable packages contributes no ids', () => {
  const text = [
    ENGLISH,
    '',
    '1 package has a version that cannot be determined.',
    'Name                           Id                       Version      Available    Source',
    '-----------------------------------------------------------------------------------------',
    'Irgendwas                      MSIX\\Broken              unknown      2.0          msstore'
  ].join('\n');
  const rows = updates.parseUpgrades(text);
  // Only the first table has a rule that the parser locks on to, so the extra
  // section must not produce phantom entries with empty ids.
  assert.ok(rows.every((r) => r.id && r.id.trim()), JSON.stringify(rows));
});

/* ---------------------------------------------------------------- Steam */

const ACF = (extra) => `"AppState"
{
\t"appid"\t\t"553850"
\t"name"\t\t"HELLDIVERS 2"
\t"installdir"\t\t"Helldivers 2"
${extra}
}`;

add('a fully installed game needs no update', () => {
  const state = updates.parseSteamState(ACF('\t"StateFlags"\t\t"4"\n\t"BytesToDownload"\t\t"100"\n\t"BytesDownloaded"\t\t"100"'));
  assert.strictEqual(state.updateRequired, false);
  assert.strictEqual(state.name, 'HELLDIVERS 2');
  assert.strictEqual(state.appid, '553850');
});

add('the update-required bit is recognised', () => {
  // 6 = fully installed plus update required.
  const state = updates.parseSteamState(ACF('\t"StateFlags"\t\t"6"'));
  assert.strictEqual(state.updateRequired, true);
});

add('a partial download counts as an update, an equal one does not', () => {
  const partial = updates.parseSteamState(ACF('\t"StateFlags"\t\t"4"\n\t"BytesToDownload"\t\t"900"\n\t"BytesDownloaded"\t\t"400"'));
  assert.strictEqual(partial.updateRequired, true);
  assert.strictEqual(partial.remainingBytes, 500);

  // A finished install leaves the two equal, which is not a pending download.
  const done = updates.parseSteamState(ACF('\t"StateFlags"\t\t"4"\n\t"BytesToDownload"\t\t"900"\n\t"BytesDownloaded"\t\t"900"'));
  assert.strictEqual(done.updateRequired, false);
  assert.strictEqual(done.remainingBytes, 0);
});

add('a running update is reported as running, not merely pending', () => {
  const state = updates.parseSteamState(ACF('\t"StateFlags"\t\t"260"'));
  assert.strictEqual(state.updateRunning, true);
});

add('a manifest that cannot be read yields zeroes rather than throwing', () => {
  const state = updates.parseSteamState('');
  assert.strictEqual(state.updateRequired, false);
  assert.strictEqual(state.appid, null);
  assert.doesNotThrow(() => updates.parseSteamState(null));
});

/* -------------------------------------------------------------- targets */

/* ------------------------------------------------------- update triggers */

add('a Steam game id must be numeric', async () => {
  // The id ends up in a steam:// URI handed to the shell, so it is checked
  // before the platform is, or the check could only ever run on Windows.
  await assert.rejects(updates.updateSteamGame('abc'), /Kennung/);
  await assert.rejects(updates.updateSteamGame('../../evil'), /Kennung/);
  await assert.rejects(updates.updateSteamGame(''), /Kennung/);
  await assert.rejects(updates.updateSteamGame(null), /Kennung/);
});

add('only the two known Steam modes are accepted', async () => {
  await assert.rejects(updates.updateSteamGame('553850', 'quatsch'), /Modus/);
  // Both real modes get past validation and fail only on the platform.
  await assert.rejects(updates.updateSteamGame('553850', 'launch'), /Windows/);
  await assert.rejects(updates.updateSteamGame('553850', 'validate'), /Windows/);
});

add('an Epic address must be a launcher URI', async () => {
  await assert.rejects(updates.updateEpicGame('https://example.com'), /Epic-Adresse/);
  await assert.rejects(updates.updateEpicGame('com.epicgames.launcher://other/x'), /Epic-Adresse/);
  await assert.rejects(updates.updateEpicGame(''), /Epic-Adresse/);
  // A space would end the argument; the manifest never produces one.
  await assert.rejects(updates.updateEpicGame('com.epicgames.launcher://apps/a b'), /Epic-Adresse/);
});

add('a real Epic launch URI passes validation', async () => {
  const uri = 'com.epicgames.launcher://apps/ns%3Acat%3AFortnite?action=launch&silent=true';
  await assert.rejects(updates.updateEpicGame(uri), /Windows/,
    'it should get past the shape check and stop at the platform');
});

add('opening an unknown target is refused', async () => {
  await assert.rejects(updates.openExternal('gibt-es-nicht'), /Unbekanntes Ziel/);
});

add('a Steam validation needs a numeric app id', async () => {
  await assert.rejects(updates.openExternal('steam-validate', '../../evil'), /Kennung/);
  await assert.rejects(updates.openExternal('steam-validate', ''), /Kennung/);
});

(async () => {
  for (const [name, fn] of queue) await test(name, fn);
  console.log(`\n${passed} assertions passed.`);
})();
