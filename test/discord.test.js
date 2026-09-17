'use strict';

/**
 * Discord jump marks.
 *
 * What was asked for was chat and voice inside the hub, which is not possible
 * without signing in as the user with their account token -- a self-bot, which
 * Discord forbids and bans accounts for. So there is nothing here to test
 * about chat, and that absence is deliberate.
 *
 * What is here is the supported `discord://` protocol, and the two things
 * about it that can go wrong quietly: an address built from an id that is not
 * an id, and a pasted link the parser thinks it understood but did not.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-discord-'));

const realResolve = Module._resolveFilename;
const stub = { app: { getPath: () => TMP, getVersion: () => '0.0.0', isPackaged: false }, shell: {} };
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

const store = require('../src/main/store');
const discord = require('../src/main/discord');

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

const GUILD = '123456789012345678';
const CHANNEL = '987654321098765432';

console.log('Discord');

/* ------------------------------------------------------------- addresses */

add('the plain app link needs nothing', () => {
  assert.strictEqual(discord.linkFor({ kind: 'app' }), 'discord://');
  assert.strictEqual(discord.linkFor({ kind: 'dms' }), 'discord://-/channels/@me');
});

add('a server link carries the server', () => {
  assert.strictEqual(discord.linkFor({ kind: 'server', guildId: GUILD }),
    `discord://-/channels/${GUILD}`);
});

add('a channel link carries both ids', () => {
  assert.strictEqual(discord.linkFor({ kind: 'channel', guildId: GUILD, channelId: CHANNEL }),
    `discord://-/channels/${GUILD}/${CHANNEL}`);
  // A voice channel is the same address; the client joins because of what the
  // channel is, not because of anything in the link.
  assert.strictEqual(discord.linkFor({ kind: 'voice', guildId: GUILD, channelId: CHANNEL }),
    `discord://-/channels/${GUILD}/${CHANNEL}`);
});

add('an unknown kind is refused rather than guessed', () => {
  assert.throws(() => discord.linkFor({ kind: 'quatsch' }), /Discord-Art/);
  assert.throws(() => discord.linkFor({}), /Discord-Art/);
  assert.throws(() => discord.linkFor(null), /Discord-Art/);
});

add('an id that is not an id is refused', () => {
  // The value ends up in a URI the shell executes.
  assert.throws(() => discord.linkFor({ kind: 'server', guildId: 'nope' }), /Server-Kennung/);
  assert.throws(() => discord.linkFor({ kind: 'server', guildId: '../../evil' }), /Server-Kennung/);
  assert.throws(() => discord.linkFor({ kind: 'server', guildId: '' }), /Server-Kennung/);
  assert.throws(() => discord.linkFor({ kind: 'channel', guildId: GUILD, channelId: 'x' }), /Kanal-Kennung/);
});

add('a channel without its server is refused', () => {
  assert.throws(() => discord.linkFor({ kind: 'channel', channelId: CHANNEL }), /Server-Kennung/);
});

add('a bad id is refused as a bad id on every platform', async () => {
  // Deliberately only the refusal. Asserting that a valid entry "stops at the
  // platform guard" would, on Windows, mean no guard to stop at: the call
  // would go through and actually open Discord. The ordering of the check is
  // what this proves, and the refusal proves it on any machine.
  await assert.rejects(discord.open({ kind: 'server', guildId: 'nope' }), /Server-Kennung/);
  await assert.rejects(discord.open({ kind: 'quatsch' }), /Discord-Art/);
});

/* ---------------------------------------------------------------- parsing */

add('a copied channel link is understood', () => {
  const parsed = discord.parseInvite(`https://discord.com/channels/${GUILD}/${CHANNEL}`);
  assert.deepStrictEqual(parsed, { guildId: GUILD, channelId: CHANNEL });
});

add('a server link without a channel is understood too', () => {
  const parsed = discord.parseInvite(`https://discord.com/channels/${GUILD}`);
  assert.deepStrictEqual(parsed, { guildId: GUILD, channelId: null });
});

add('the older discordapp.com host still works', () => {
  const parsed = discord.parseInvite(`https://discordapp.com/channels/${GUILD}/${CHANNEL}`);
  assert.strictEqual(parsed.guildId, GUILD);
});

add('what the hub produced can be pasted back', () => {
  const parsed = discord.parseInvite(`discord://-/channels/${GUILD}/${CHANNEL}`);
  assert.deepStrictEqual(parsed, { guildId: GUILD, channelId: CHANNEL });
});

add('something else entirely yields nothing, not a wrong answer', () => {
  // A paste that is not a Discord link is an ordinary thing to happen, and a
  // parser that invents ids would build an address that silently goes nowhere.
  assert.strictEqual(discord.parseInvite('https://example.com/channels/1/2'), null);
  assert.strictEqual(discord.parseInvite('irgendein text'), null);
  assert.strictEqual(discord.parseInvite(''), null);
  assert.strictEqual(discord.parseInvite(null), null);
});

add('an invite link is not mistaken for a channel link', () => {
  // discord.gg/abc carries no ids at all; pretending otherwise would store a
  // shortcut that cannot work.
  assert.strictEqual(discord.parseInvite('https://discord.gg/abcdef'), null);
});

/* ---------------------------------------------------------------- storing */

add('an unknown kind is refused at save time, not replaced', () => {
  // Falling back to the harmless kind would turn a mistyped voice-channel
  // shortcut into a plain "open Discord" that looks right in the list.
  assert.throws(() => discord.save({ kind: 'quatsch', guildId: GUILD }), /Discord-Art/);
  // An absent kind is still allowed to default; only a wrong one is refused.
  store.state.discord = [];
  assert.doesNotThrow(() => discord.save({ label: 'Nur Discord' }));
});

add('a shortcut that cannot work is refused at save time', () => {
  // Not at open time: a broken shortcut should not be storable, or it fails
  // for the first time mid-game.
  assert.throws(() => discord.save({ kind: 'server', guildId: 'nein' }), /Server-Kennung/);
});

add('a saved shortcut comes back with its address', () => {
  store.state.discord = [];
  const entry = discord.save({ label: 'Freitagsrunde', kind: 'channel', guildId: GUILD, channelId: CHANNEL });
  const list = discord.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].label, 'Freitagsrunde');
  assert.strictEqual(list[0].link, `discord://-/channels/${GUILD}/${CHANNEL}`);
  assert.ok(entry.id);
});

add('a shortcut without a label gets a usable one', () => {
  store.state.discord = [];
  const entry = discord.save({ kind: 'server', guildId: GUILD });
  assert.ok(entry.label && entry.label.length > 3, entry.label);
});

add('saving the same id twice replaces rather than duplicates', () => {
  store.state.discord = [];
  const first = discord.save({ label: 'Alt', kind: 'server', guildId: GUILD });
  discord.save({ id: first.id, label: 'Neu', kind: 'server', guildId: GUILD });
  const list = discord.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].label, 'Neu');
});

add('removing takes exactly one', () => {
  store.state.discord = [];
  const a = discord.save({ label: 'A', kind: 'server', guildId: GUILD });
  discord.save({ label: 'B', kind: 'server', guildId: CHANNEL });
  const result = discord.remove(a.id);
  assert.strictEqual(result.removed, 1);
  assert.deepStrictEqual(discord.list().map((e) => e.label), ['B']);
});

add('opening a shortcut that does not exist says so', async () => {
  store.state.discord = [];
  await assert.rejects(discord.openStored('gibt-es-nicht'), /gibt es nicht/);
});

/* ------------------------------------------------------------ the honesty */

add('the note says outright what is not possible', () => {
  // The constant rather than `state()`: that would ask for a process list,
  // which on Windows starts the PowerShell host and holds the run open.
  assert.ok(/Selfbot/i.test(discord.LIMIT_NOTE), discord.LIMIT_NOTE);
  assert.ok(/Chat und Sprache/.test(discord.LIMIT_NOTE), discord.LIMIT_NOTE);
});

(async () => {
  for (const [name, fn] of queue) await test(name, fn);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  console.log(`\n${passed} assertions passed.`);
})();
