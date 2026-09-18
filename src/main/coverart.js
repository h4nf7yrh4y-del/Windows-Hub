'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const logger = require('./logger');

const log = logger.scoped('coverart');

/**
 * Steam header images for profile cards.
 *
 * Steam serves these from a fixed, unauthenticated URL keyed by app id --
 * no API key, no login, the same image the store page itself uses. Epic
 * has nothing comparable without one, so a profile built around an Epic
 * title keeps the plain accent-coloured card it has always had rather than
 * showing an image for one source and not the other.
 *
 * Fetched once and kept on disk after that: a hub with a dozen profiles
 * open on every boot is not a reason to ask Steam's CDN a dozen times a day
 * for something that never changes once a game is released.
 */

// Steam app ids are small decimal numbers. Validated before the network
// call and before the path is built from it, not inside either.
const APP_ID = /^[1-9][0-9]{0,9}$/;

function dir() {
  return path.join(app.getPath('userData'), 'covers');
}

function cachePath(appId) {
  return path.join(dir(), `${appId}.jpg`);
}

function urlFor(appId) {
  if (!APP_ID.test(String(appId))) throw new Error(`Ungültige Steam-App-ID: ${appId}`);
  return `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`;
}

// App ids confirmed this session to have no header image. Steam not having
// one is a permanent fact about the app id, not a transient failure, so
// asking again on every hub visit would only ever produce the same 404.
const missing = new Set();

function download(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode === 404) { res.resume(); resolve(null); return; }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Steam-CDN antwortete mit ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim Laden des Titelbilds')));
  });
}

function toDataUrl(buf) {
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/** The cached image if there is one, fetching and saving it if not. */
async function get(appId) {
  const id = String(appId || '');
  if (!APP_ID.test(id)) return { ok: false, reason: 'ungueltige-id' };
  if (missing.has(id)) return { ok: false, reason: 'kein-titelbild' };

  const file = cachePath(id);
  try {
    const cached = await fs.promises.readFile(file);
    return { ok: true, dataUrl: toDataUrl(cached) };
  } catch (_) { /* not cached yet, fall through to fetching it */ }

  const url = urlFor(id);
  try {
    const buf = await download(url);
    if (!buf) {
      missing.add(id);
      return { ok: false, reason: 'kein-titelbild' };
    }
    await fs.promises.mkdir(dir(), { recursive: true });
    await fs.promises.writeFile(file, buf);
    return { ok: true, dataUrl: toDataUrl(buf) };
  } catch (err) {
    // Worth knowing about, not worth surfacing: a card without a cover is a
    // perfectly normal card.
    log.debug(`Titelbild für ${id} nicht ladbar: ${err.message}`);
    return { ok: false, reason: 'fehler' };
  }
}

module.exports = { get, urlFor, dir };
