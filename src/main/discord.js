'use strict';

const crypto = require('crypto');
const { shell } = require('electron');
const processes = require('./processes');
const store = require('./store');
const logger = require('./logger');

const log = logger.scoped('discord');

/**
 * Discord, as far as it honestly goes.
 *
 * What was asked for was chat and voice inside the hub. That is not possible
 * without logging in as the user with their account token, which Discord calls
 * a self-bot, forbids outright, and bans accounts for. A feature that gets
 * someone's account taken away is not a feature, so this module does not go
 * near it.
 *
 * What is left is genuinely useful and entirely supported: the `discord://`
 * protocol the client registers. It can open a specific server, a specific
 * channel and a specific voice channel, which is the part of "get me into the
 * voice chat" that actually costs clicks. The hub also reports whether the
 * client is running, so a profile can say something true about it.
 *
 * Every id here comes from the renderer and ends up in a URI the shell
 * executes, so the addresses are built by pure functions that are checked
 * before the platform is.
 */

// Discord snowflakes: 17 to 20 digits today, with room to grow.
const SNOWFLAKE = /^\d{15,25}$/;

const KINDS = {
  app: 'Discord öffnen',
  server: 'Server öffnen',
  channel: 'Kanal öffnen',
  voice: 'Sprachkanal betreten',
  dms: 'Direktnachrichten'
};

/**
 * The address for one target.
 *
 * A pure function on purpose: it is the only place that decides what the shell
 * is asked to run, and keeping it free of platform checks is what lets the
 * refusals be tested anywhere.
 */
function linkFor(entry) {
  const kind = entry && entry.kind;
  if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) {
    throw new Error(`Unbekannte Discord-Art: ${kind}`);
  }
  if (kind === 'app') return 'discord://';
  if (kind === 'dms') return 'discord://-/channels/@me';

  const guild = String((entry && entry.guildId) || '');
  if (!SNOWFLAKE.test(guild)) throw new Error('Ungültige Server-Kennung');
  if (kind === 'server') return `discord://-/channels/${guild}`;

  const channel = String((entry && entry.channelId) || '');
  if (!SNOWFLAKE.test(channel)) throw new Error('Ungültige Kanal-Kennung');

  // A voice channel opens the same way a text one does; the client joins it
  // because of what the channel is, not because of anything in the address.
  return `discord://-/channels/${guild}/${channel}`;
}

/**
 * Pulls the ids out of a link someone copied from Discord.
 *
 * "Copy link" in Discord gives an https address, and asking people to find
 * two eighteen-digit numbers inside it by hand is how a feature goes unused.
 * Returns null rather than throwing: a paste that is not a Discord link is an
 * ordinary thing to happen while typing.
 */
function parseInvite(text) {
  const value = String(text || '').trim();

  const channels = /^(?:https?:\/\/)?(?:\w+\.)?discord(?:app)?\.com\/channels\/(\d{15,25})(?:\/(\d{15,25}))?/.exec(value);
  if (channels) {
    return { guildId: channels[1], channelId: channels[2] || null };
  }

  // The protocol form, in case someone pastes back what the hub produced.
  const protocol = /^discord:\/\/-\/channels\/(\d{15,25})(?:\/(\d{15,25}))?/.exec(value);
  if (protocol) return { guildId: protocol[1], channelId: protocol[2] || null };

  return null;
}

/* ------------------------------------------------------------------ store */

function shortcuts() {
  const state = store.state;
  if (!Array.isArray(state.discord)) state.discord = [];
  return state.discord;
}

function sanitizeEntry(raw) {
  // An unknown kind is refused, not replaced with the harmless one. Falling
  // back to 'app' would turn a mistyped voice-channel shortcut into a plain
  // "open Discord" that looks right in the list and goes somewhere else.
  const given = raw && raw.kind;
  if (given !== undefined && given !== null && given !== ''
    && !Object.prototype.hasOwnProperty.call(KINDS, given)) {
    throw new Error(`Unbekannte Discord-Art: ${given}`);
  }

  const entry = {
    // A random id, not a timestamp: two shortcuts created in the same
    // millisecond shared one, and the second silently replaced the first.
    id: typeof raw.id === 'string' && raw.id ? raw.id : `dc-${crypto.randomUUID()}`,
    label: String((raw && raw.label) || '').trim().slice(0, 60),
    kind: given || 'app',
    guildId: SNOWFLAKE.test(String((raw && raw.guildId) || '')) ? String(raw.guildId) : null,
    channelId: SNOWFLAKE.test(String((raw && raw.channelId) || '')) ? String(raw.channelId) : null
  };
  if (!entry.label) entry.label = KINDS[entry.kind];
  // Refuses here rather than at open time: a shortcut that cannot work should
  // not be storable in the first place.
  linkFor(entry);
  return entry;
}

function list() {
  return shortcuts().map((entry) => ({ ...entry, link: (() => {
    try { return linkFor(entry); } catch (_) { return null; }
  })() }));
}

function save(raw) {
  const entry = sanitizeEntry(raw || {});
  const all = shortcuts();
  const index = all.findIndex((e) => e.id === entry.id);
  if (index >= 0) all[index] = entry; else all.push(entry);
  store.save();
  return entry;
}

function remove(id) {
  const key = String(id || '');
  if (!key) throw new Error('Keine Kennung angegeben');
  const all = shortcuts();
  const before = all.length;
  store.state.discord = all.filter((e) => e.id !== key);
  store.save();
  return { removed: before - store.state.discord.length };
}

/* ----------------------------------------------------------------- acting */

async function running() {
  try {
    const names = await processes.runningNames();
    return names.some((name) => /^discord(ptb|canary|development)?$/i.test(String(name)));
  } catch (_) {
    return false;
  }
}

async function open(entry) {
  const link = linkFor(entry);
  if (process.platform !== 'win32') throw new Error('Nur unter Windows verfügbar');
  await shell.openExternal(link);
  log.info(`Discord geöffnet: ${entry.kind}`);
  return { ok: true, link };
}

async function openStored(id) {
  const entry = shortcuts().find((e) => e.id === String(id || ''));
  if (!entry) throw new Error('Diese Verknüpfung gibt es nicht');
  return open(entry);
}

/** What the interface shows about the client, without pretending to more. */
async function state() {
  return {
    running: await running(),
    shortcuts: list(),
    kinds: Object.entries(KINDS).map(([value, label]) => ({ value, label })),
    // Repeated in the interface, because the gap between what was asked for
    // and what exists is the thing worth being clear about.
    note: 'Chat und Sprache lassen sich nicht in den Hub holen: dafür müsste sich der Hub mit '
      + 'deinem Account anmelden, was Discord als Selfbot verbietet und mit Accountsperre ahndet. '
      + 'Was geht, sind Sprungmarken in den Client.'
  };
}

module.exports = {
  linkFor,
  parseInvite,
  list,
  save,
  remove,
  open,
  openStored,
  running,
  state,
  KINDS,
  SNOWFLAKE
};
