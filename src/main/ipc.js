'use strict';

const crypto = require('crypto');
const { ipcMain, dialog, shell, app, nativeImage, BrowserWindow } = require('electron');

const store = require('./store');
const metrics = require('./metrics');
const processes = require('./processes');
const scanner = require('./scanner');
const launcher = require('./launcher');
const power = require('./power');
const files = require('./files');
const startup = require('./startup');
const overlays = require('./overlays');
const hotkeys = require('./hotkeys');
const display = require('./display');
const winfeatures = require('./winfeatures');
const network = require('./network');
const media = require('./media');
const updates = require('./updates');
const scheduler = require('./scheduler');
const sessions = require('./sessions');
const screens = require('./screens');
const dashboard = require('./dashboard');
const tweaks = require('./tweaks');
const diagnostics = require('./diagnostics');
const claudecode = require('./claudecode');
const claudesession = require('./claudesession');
const selfupdate = require('./selfupdate');
const storage = require('./storage');
const triggers = require('./triggers');
const backup = require('./backup');
const audio = require('./audio');
const discord = require('./discord');
const logger = require('./logger');

const log = logger.scoped('ipc');

/**
 * Single place where the renderer is allowed to reach the OS.
 * Every handler validates its own input; the renderer is treated as untrusted
 * because that is the only posture that survives a future plugin/theme system.
 */

function ok(data) { return { ok: true, data }; }
function fail(err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }

function wrap(handler, channel) {
  return async (event, ...args) => {
    try {
      return ok(await handler(...args));
    } catch (err) {
      log.error(`${channel || 'handler'}: ${err.message}`, err.stack ? `\n${err.stack}` : '');
      return fail(err);
    }
  };
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function sanitizeLaunch(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Launch definition is required');
  const type = requireString(raw.type, 'Launch type');
  if (!['exe', 'uri', 'appsfolder', 'shell'].includes(type)) throw new Error(`Unsupported launch type: ${type}`);
  const out = { type, target: requireString(raw.target, 'Launch target') };
  if (Array.isArray(raw.args)) out.args = raw.args.filter((a) => typeof a === 'string');
  if (typeof raw.cwd === 'string' && raw.cwd.trim()) out.cwd = raw.cwd.trim();
  return out;
}

function sanitizeApp(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('App entry is required');
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    name: requireString(raw.name, 'App name'),
    launch: sanitizeLaunch(raw.launch),
    delayMs: Number.isFinite(Number(raw.delayMs)) ? Math.max(0, Math.min(120000, Number(raw.delayMs))) : 0,
    enabled: raw.enabled !== false,
    required: !!raw.required,
    processName: typeof raw.processName === 'string' && raw.processName.trim()
      ? raw.processName.trim()
      : null,
    icon: typeof raw.icon === 'string' ? raw.icon : null
  };
}

function sanitizeProfile(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Profile is required');
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    name: requireString(raw.name, 'Profile name'),
    tagline: typeof raw.tagline === 'string' ? raw.tagline.slice(0, 120) : '',
    accent: /^#[0-9a-f]{6}$/i.test(raw.accent || '') ? raw.accent : '#00f0ff',
    cover: typeof raw.cover === 'string' ? raw.cover : null,
    icon: typeof raw.icon === 'string' ? raw.icon : null,
    apps: Array.isArray(raw.apps) ? raw.apps.map(sanitizeApp) : [],
    alsoClose: Array.isArray(raw.alsoClose) ? raw.alsoClose.filter((x) => typeof x === 'string') : [],
    minimizeOnLaunch: raw.minimizeOnLaunch !== false,
    system: tweaks.sanitize(raw.system),
    trigger: triggers.sanitize(raw.trigger),
    createdAt: Number(raw.createdAt) || Date.now(),
    lastLaunched: Number(raw.lastLaunched) || 0,
    launchCount: Number(raw.launchCount) || 0
  };
}

function registerIpc({ getWindow, applyAutostart, revealWindow, openClaudeWindow, toggleOverlays }) {
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  /* ---------------------------------------------------------- app / window */

  // app.getVersion() returns Electron's own version when running unpackaged,
  // so read package.json directly and keep getVersion as the fallback.
  let ownVersion = app.getVersion();
  try {
    ownVersion = require('../../package.json').version || ownVersion;
  } catch (_) { /* packaged builds fall back to getVersion */ }

  ipcMain.handle('app:info', wrap(async () => ({
    version: ownVersion,
    name: app.getName(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    configPath: store.configPath(),
    isWindows: process.platform === 'win32'
  }), 'app:info'));

  ipcMain.handle('window:minimize', wrap(async () => {
    const win = getWindow();
    if (win) win.minimize();
    return true;
  }, 'window:minimize'));

  ipcMain.handle('window:toggleFullscreen', wrap(async () => {
    const win = getWindow();
    if (!win) return false;
    const next = !win.isFullScreen();
    win.setFullScreen(next);
    return next;
  }, 'window:toggleFullscreen'));

  ipcMain.handle('window:isFullscreen', wrap(async () => {
    const win = getWindow();
    return win ? win.isFullScreen() : false;
  }, 'window:isFullscreen'));

  ipcMain.handle('window:close', wrap(async () => {
    app.quit();
    return true;
  }, 'window:close'));

  /* ------------------------------------------------------------- monitors */

  ipcMain.handle('screens:list', wrap(async () => {
    const settings = store.getSettings();
    const hub = screens.resolve(settings.hubDisplay || null);
    return {
      displays: screens.list(),
      hubDisplayId: hub.display.id,
      // True when the monitor the hub was pinned to is no longer connected.
      hubDisplayMissing: !!settings.hubDisplay && hub.match === 'fallback'
    };
  }, 'screens:list'));

  ipcMain.handle('window:setDisplay', wrap(async (displayId) => {
    const target = screens.list().find((d) => d.id === displayId);
    if (!target) throw new Error('Dieser Bildschirm ist nicht vorhanden');
    const { display } = screens.resolve({ id: target.id, label: target.label, x: target.bounds.x, y: target.bounds.y });
    store.setSettings({ hubDisplay: screens.remember(display) });
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      screens.placeWindow(win, display, { fullscreen: win.isFullScreen() });
    }
    return { displayId: display.id, label: display.label };
  }, 'window:setDisplay'));

  /* ------------------------------------------------------------ dashboard */

  ipcMain.handle('dashboard:status', wrap(async () => dashboard.status(), 'dashboard:status'));
  ipcMain.handle('dashboard:toggle', wrap(async () => ({ open: dashboard.toggle() }), 'dashboard:toggle'));
  ipcMain.handle('dashboard:open', wrap(async () => { dashboard.open(); return dashboard.status(); }, 'dashboard:open'));
  ipcMain.handle('dashboard:close', wrap(async () => { dashboard.close(); return dashboard.status(); }, 'dashboard:close'));
  ipcMain.handle('dashboard:setDisplay', wrap(async (displayId) => dashboard.setDisplay(displayId), 'dashboard:setDisplay'));
  ipcMain.handle('dashboard:setAutoOpen', wrap(async (value) => dashboard.setAutoOpen(!!value), 'dashboard:setAutoOpen'));

  /* -------------------------------------------------------------- settings */

  ipcMain.handle('settings:get', wrap(async () => store.getSettings(), 'settings:get'));

  ipcMain.handle('settings:set', wrap(async (patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('Settings patch is required');
    const before = store.getSettings();
    const next = store.setSettings(patch);
    if ('autostart' in patch && patch.autostart !== before.autostart) {
      const result = applyAutostart(patch.autostart);
      if (!result.ok) {
        store.setSettings({ autostart: before.autostart });
        throw new Error(result.reason || 'Autostart could not be changed');
      }
    }
    if (patch.metricsIntervalMs || patch.slowMetricsIntervalMs || 'showGpu' in patch) {
      metrics.start((sample) => send('metrics:sample', sample), {
        fastMs: next.metricsIntervalMs,
        slowMs: next.slowMetricsIntervalMs,
        includeGpu: next.showGpu
      });
    }
    return next;
  }, 'settings:set'));

  ipcMain.handle('settings:openConfigFolder', wrap(async () => {
    shell.showItemInFolder(store.configPath());
    return true;
  }, 'settings:openConfigFolder'));

  /* -------------------------------------------------------------- profiles */

  ipcMain.handle('profiles:list', wrap(async () => ({
    // Each entry carries the process name the main process would use, so the
    // running indicator and the stop action agree on what a program is called.
    // It is derived, never stored: sanitizeApp drops it again on save.
    profiles: store.state.profiles.map((profile) => ({
      ...profile,
      apps: (profile.apps || []).map((app) => ({
        ...app,
        resolvedProcess: launcher.namesForApp(app)[0] || null
      }))
    })),
    lastProfileId: store.state.lastProfileId
  }), 'profiles:list'));

  ipcMain.handle('profiles:save', wrap(async (raw) => {
    const profile = sanitizeProfile(raw);
    const state = store.state;
    const index = state.profiles.findIndex((p) => p.id === profile.id);
    if (index >= 0) state.profiles[index] = { ...state.profiles[index], ...profile };
    else state.profiles.push(profile);
    store.save();
    // The watcher polls only while at least one profile wants it, so every
    // change to the profiles has to be told.
    triggers.refresh();
    return profile;
  }, 'profiles:save'));

  ipcMain.handle('profiles:delete', wrap(async (id) => {
    const profileId = requireString(id, 'Profile id');
    const state = store.state;
    const before = state.profiles.length;
    state.profiles = state.profiles.filter((p) => p.id !== profileId);
    if (state.lastProfileId === profileId) state.lastProfileId = null;
    store.save();
    triggers.refresh();
    return { removed: before - state.profiles.length };
  }, 'profiles:delete'));

  ipcMain.handle('profiles:reorder', wrap(async (ids) => {
    if (!Array.isArray(ids)) throw new Error('Order array is required');
    const state = store.state;
    const byId = new Map(state.profiles.map((p) => [p.id, p]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    for (const p of state.profiles) if (!ids.includes(p.id)) ordered.push(p);
    state.profiles = ordered;
    store.save();
    return state.profiles;
  }, 'profiles:reorder'));

  ipcMain.handle('profiles:launch', wrap(async (id) => {
    const profileId = requireString(id, 'Profile id');
    const state = store.state;
    const profile = state.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error('Profile not found');

    const result = await launcher.launchProfile(profile, (event) => send('profile:progress', event));

    profile.lastLaunched = Date.now();
    profile.launchCount = (profile.launchCount || 0) + 1;
    state.lastProfileId = profile.id;
    store.save();

    // Begins the playtime measurement; it stops by itself once the profile's
    // programs are gone.
    sessions.watch(profile);

    const settings = store.getSettings();
    if (profile.minimizeOnLaunch !== false && settings.minimizeOnLaunch) {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.minimize();
    }
    return result;
  }, 'profiles:launch'));

  // The confirmation dialog shows exactly this. A dialog that worked it out
  // for itself would eventually disagree with what actually happens.
  ipcMain.handle('profiles:stopPlan', wrap(async (id) => {
    const profileId = requireString(id, 'Profile id');
    const profile = store.state.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error('Profile not found');
    return launcher.stopPlan(profile);
  }, 'profiles:stopPlan'));

  ipcMain.handle('profiles:stop', wrap(async (id) => {
    const profileId = requireString(id, 'Profile id');
    const profile = store.state.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error('Profile not found');
    // Closed by hand, so the session ends now rather than at the next poll.
    const session = sessions.release(profileId);
    const result = await launcher.stopProfile(profile);
    return { ...result, session };
  }, 'profiles:stop'));

  ipcMain.handle('sessions:stats', wrap(async () => sessions.stats(), 'sessions:stats'));
  ipcMain.handle('sessions:clear', wrap(async () => sessions.clear(), 'sessions:clear'));

  /* -------------------------------------------------------------- schedule */

  ipcMain.handle('schedule:list', wrap(async () => scheduler.list(), 'schedule:list'));
  ipcMain.handle('schedule:save', wrap(async (entry) => scheduler.save(entry), 'schedule:save'));
  ipcMain.handle('schedule:remove', wrap(async (id) => scheduler.remove(requireString(id, 'Eintrag')), 'schedule:remove'));
  ipcMain.handle('schedule:runNow', wrap(async (id) => scheduler.runNow(requireString(id, 'Eintrag')), 'schedule:runNow'));

  /* --------------------------------------------------------------- library */

  ipcMain.handle('library:scan', wrap(async (opts) => scanner.scan({ force: !!(opts && opts.force) }), 'library:scan'));
  ipcMain.handle('library:icon', wrap(async (target) => scanner.getIcon(requireString(target, 'Icon target')), 'library:icon'));
  ipcMain.handle('library:guessExecutable', wrap(async (installDir) =>
    scanner.guessExecutable(requireString(installDir, 'Installationsverzeichnis')), 'library:guessExecutable'));

  ipcMain.handle('library:pickExecutable', wrap(async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Programm auswählen',
      properties: ['openFile'],
      filters: [
        { name: 'Programme', extensions: ['exe', 'bat', 'cmd', 'lnk'] },
        { name: 'Alle Dateien', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  }, 'library:pickExecutable'));

  // Cover images are downscaled and inlined as data URLs so the config stays
  // portable and the renderer never needs file:// access.
  ipcMain.handle('library:pickImage', wrap(async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Bild auswählen',
      properties: ['openFile'],
      filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    });
    if (result.canceled || !result.filePaths.length) return null;

    const image = nativeImage.createFromPath(result.filePaths[0]);
    if (image.isEmpty()) throw new Error('Bild konnte nicht gelesen werden');
    const size = image.getSize();
    const resized = size.width > 900 ? image.resize({ width: 900, quality: 'good' }) : image;
    const jpeg = resized.toJPEG(82);
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  }, 'library:pickImage'));

  ipcMain.handle('launch:item', wrap(async (item) => launcher.launchItem(sanitizeLaunch(item)), 'launch:item'));

  /* --------------------------------------------------------------- metrics */

  ipcMain.handle('metrics:subscribe', wrap(async () => ({ subscribers: metrics.subscribe() }), 'metrics:subscribe'));
  ipcMain.handle('metrics:unsubscribe', wrap(async () => ({ subscribers: metrics.unsubscribe() }), 'metrics:unsubscribe'));
  ipcMain.handle('metrics:snapshot', wrap(async () => metrics.fastSample(), 'metrics:snapshot'));
  ipcMain.handle('metrics:static', wrap(async () => metrics.getStaticInfo(), 'metrics:static'));

  /* ------------------------------------------------------------- processes */

  ipcMain.handle('processes:list', wrap(async () => processes.list(), 'processes:list'));
  ipcMain.handle('processes:running', wrap(async () => ({
    ts: Date.now(),
    names: await processes.runningNames()
  }), 'processes:running'));
  ipcMain.handle('processes:kill', wrap(async (pid) => processes.kill(pid), 'processes:kill'));
  ipcMain.handle('processes:killByName', wrap(async (name) => processes.killByName(name), 'processes:killByName'));
  ipcMain.handle('processes:priority', wrap(async (pid, priority) => processes.setPriority(pid, priority), 'processes:priority'));
  ipcMain.handle('processes:priorityOptions', wrap(async () => ({
    supported: process.platform === 'win32',
    options: processes.SETTABLE_PRIORITIES.map((value) => ({ value, label: processes.PRIORITY_LABELS[value] })),
    labels: processes.PRIORITY_LABELS
  }), 'processes:priorityOptions'));

  /* -------------------------------------------------------- system tweaks */

  ipcMain.handle('tweaks:status', wrap(async () => tweaks.status(), 'tweaks:status'));
  ipcMain.handle('tweaks:powerPlans', wrap(async () => tweaks.listPowerPlans(), 'tweaks:powerPlans'));
  ipcMain.handle('tweaks:revert', wrap(async () => tweaks.revert(), 'tweaks:revert'));

  /* --------------------------------------------------------------- network */

  ipcMain.handle('network:overview', wrap(async () => network.overview(), 'network:overview'));

  /* --------------------------------------------------------------- updates */

  updates.setEmitter((event) => send('updates:progress', event));
  selfupdate.setEmitter((event) => send('selfupdate:progress', event));

  // The hub's own update. Kept apart from `updates:*` because it is a
  // different thing entirely: that view reports on other people's software,
  // this one replaces the running application.
  triggers.setNotifier((event) => send('triggers:event', event));
  /* ------------------------------------------------------------- discord */

  ipcMain.handle('discord:state', wrap(async () => discord.state(), 'discord:state'));
  ipcMain.handle('discord:save', wrap(async (entry) => discord.save(entry), 'discord:save'));
  ipcMain.handle('discord:remove', wrap(async (id) => discord.remove(id), 'discord:remove'));
  ipcMain.handle('discord:open', wrap(async (id) => discord.openStored(id), 'discord:open'));
  // Parsing is its own channel so the editor can show what it understood
  // before anything is stored.
  ipcMain.handle('discord:parse', wrap(async (text) =>
    discord.parseInvite(requireString(text, 'Adresse')), 'discord:parse'));

  ipcMain.handle('audio:list', wrap(async (force) =>
    audio.list({ force: force === true }), 'audio:list'));
  // The id is passed through: it is checked in the audio module, where the
  // check can also be tested, and a value normalised here could not be refused
  // there.
  ipcMain.handle('audio:setDefault', wrap(async (id) => audio.setDefault(id), 'audio:setDefault'));

  /* -------------------------------------------------------------- backup */

  // The file dialogs live here rather than in the renderer: the renderer never
  // learns a path it did not already have, and an import cannot be aimed at a
  // file the user did not pick.
  ipcMain.handle('backup:export', wrap(async () => {
    const win = getWindow();
    const result = await dialog.showSaveDialog(win, {
      title: 'Einstellungen sichern',
      defaultPath: backup.suggestedName(),
      filters: [{ name: 'Sicherung', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return null;
    return backup.exportTo(result.filePath);
  }, 'backup:export'));

  ipcMain.handle('backup:inspect', wrap(async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Sicherung auswählen',
      properties: ['openFile'],
      filters: [{ name: 'Sicherung', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    const file = result.filePaths[0];
    const text = await require('fs').promises.readFile(file, 'utf8');
    // The contents travel back with the summary so importing does not have to
    // read the file a second time and find something different.
    return { file, text, summary: backup.inspect(text) };
  }, 'backup:inspect'));

  // The mode is passed through rather than normalised: "replace" discards
  // profiles, and quietly turning an unknown value into a valid one would
  // defeat the check that exists to refuse it.
  ipcMain.handle('backup:import', wrap(async (text, mode) => {
    const result = await backup.importFrom(requireString(text, 'Sicherung'), { mode });
    triggers.refresh();
    return result;
  }, 'backup:import'));

  ipcMain.handle('triggers:list', wrap(async () => triggers.list(), 'triggers:list'));
  ipcMain.handle('triggers:refresh', wrap(async () => triggers.refresh(), 'triggers:refresh'));

  ipcMain.handle('storage:overview', wrap(async () => storage.overview(), 'storage:overview'));
  ipcMain.handle('storage:measure', wrap(async (dir) =>
    storage.measure(requireString(dir, 'Ordner')), 'storage:measure'));
  // The id is passed through unchanged: the module refuses a bad one, and a
  // value normalised here could not be refused there.
  ipcMain.handle('storage:uninstall', wrap(async (appId) =>
    storage.uninstallSteamGame(appId), 'storage:uninstall'));

  ipcMain.handle('selfupdate:state', wrap(async () => selfupdate.state(), 'selfupdate:state'));
  ipcMain.handle('selfupdate:check', wrap(async () => selfupdate.check(), 'selfupdate:check'));
  ipcMain.handle('selfupdate:download', wrap(async () => selfupdate.download(), 'selfupdate:download'));
  ipcMain.handle('selfupdate:install', wrap(async () => selfupdate.install(), 'selfupdate:install'));

  ipcMain.handle('updates:scan', wrap(async () => updates.scan(), 'updates:scan'));
  ipcMain.handle('updates:scanGames', wrap(async () => updates.scanGames(), 'updates:scanGames'));
  ipcMain.handle('updates:clients', wrap(async () => updates.clientState(), 'updates:clients'));
  ipcMain.handle('updates:scanWinget', wrap(async () => updates.scanWinget(), 'updates:scanWinget'));
  ipcMain.handle('updates:state', wrap(async () => updates.state(), 'updates:state'));
  ipcMain.handle('updates:run', wrap(async (id) =>
    updates.runUpgrade({ id: typeof id === 'string' && id ? id : null }), 'updates:run'));
  ipcMain.handle('updates:cancel', wrap(async () => updates.cancelUpgrade(), 'updates:cancel'));
  ipcMain.handle('updates:open', wrap(async (what, id) =>
    updates.openExternal(requireString(what, 'Ziel'), id), 'updates:open'));

  // Triggering a game update is the launcher's job; these are the hooks it
  // offers, driven from here instead of by hand.
  ipcMain.handle('updates:steamProgress', wrap(async () => updates.steamProgress(), 'updates:steamProgress'));
  ipcMain.handle('updates:steamAll', wrap(async () => updates.startSteamUpdates(), 'updates:steamAll'));
  // The mode is passed through rather than normalised: quietly turning an
  // unknown value into a valid one would defeat the check that exists to
  // refuse it, and one of the two modes starts a game.
  ipcMain.handle('updates:steamGame', wrap(async (appId, mode) =>
    updates.updateSteamGame(appId, mode), 'updates:steamGame'));
  ipcMain.handle('updates:epicAll', wrap(async () => updates.startEpicUpdates(), 'updates:epicAll'));
  ipcMain.handle('updates:epicGame', wrap(async (uri) =>
    updates.updateEpicGame(requireString(uri, 'Adresse')), 'updates:epicGame'));

  /* ----------------------------------------------------------------- media */

  ipcMain.handle('media:read', wrap(async () => media.read(), 'media:read'));
  ipcMain.handle('media:command', wrap(async (name) =>
    media.command(requireString(name, 'Befehl')), 'media:command'));

  /* ----------------------------------------------------------------- power */

  ipcMain.handle('power:perform', wrap(async (action) => power.perform(requireString(action, 'Power action')), 'power:perform'));
  ipcMain.handle('power:actions', wrap(async () => power.actions, 'power:actions'));

  /* -------------------------------------------------------------- overlays */

  ipcMain.handle('overlays:list', wrap(async () => overlays.list(), 'overlays:list'));

  ipcMain.handle('overlays:set', wrap(async (type, enabled) =>
    overlays.setEnabled(requireString(type, 'Overlay-Typ'), !!enabled), 'overlays:set'));

  ipcMain.handle('overlays:update', wrap(async (type, patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('Keine Änderungen übergeben');
    return overlays.update(requireString(type, 'Overlay-Typ'), patch);
  }, 'overlays:update'));

  ipcMain.handle('overlays:closeAll', wrap(async () => overlays.disableAll(), 'overlays:closeAll'));

  // Same behaviour as the global hotkey, so a controller and a keyboard cannot
  // end up with two different ideas of what "toggle" means.
  ipcMain.handle('overlays:toggle', wrap(async () => {
    if (typeof toggleOverlays !== 'function') throw new Error('Nicht verfügbar');
    toggleOverlays();
    return { open: overlays.count() };
  }, 'overlays:toggle'));

  // An overlay closing itself. The type comes from the window's own URL rather
  // than from the payload, so one overlay cannot close another.
  ipcMain.handle('overlay:close', async (event) => {
    try {
      const type = new URL(event.sender.getURL()).searchParams.get('type');
      if (type) {
        overlays.setEnabled(type, false);
        return ok({ closed: type });
      }
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) win.close();
      return ok({ closed: null });
    } catch (err) {
      return fail(err);
    }
  });

  /* -------------------------------------------------------------- displays */

  // The revert timer lives in main, so it still fires when the screen is
  // black and the renderer cannot be seen at all.
  display.setRevertHandler((event) => send('display:reverted', event));

  ipcMain.handle('display:list', wrap(async () => display.list(), 'display:list'));

  ipcMain.handle('display:brightness', wrap(async (target, value) => {
    if (!target || typeof target !== 'object') throw new Error('Bildschirm fehlt');
    return display.setBrightness(target, value);
  }, 'display:brightness'));

  ipcMain.handle('display:setMode', wrap(async (device, mode) => {
    if (!mode || typeof mode !== 'object') throw new Error('Modus fehlt');
    return display.setModeSafely(
      requireString(device, 'Bildschirm'),
      mode.width, mode.height, mode.refresh
    );
  }, 'display:setMode'));

  ipcMain.handle('display:confirmMode', wrap(async () => display.cancelRevert(), 'display:confirmMode'));
  ipcMain.handle('display:setPrimary', wrap(async (device) => display.setPrimary(requireString(device, 'Bildschirm')), 'display:setPrimary'));
  ipcMain.handle('display:projection', wrap(async (mode) => display.setProjection(requireString(mode, 'Modus')), 'display:projection'));
  ipcMain.handle('display:openSettings', wrap(async (page) => display.openSettings(requireString(page, 'Seite')), 'display:openSettings'));

  /* -------------------------------------------------------------- features */

  ipcMain.handle('features:list', wrap(async () => winfeatures.list(), 'features:list'));
  ipcMain.handle('features:set', wrap(async (id, value) =>
    winfeatures.setControl(requireString(id, 'Eintrag'), value), 'features:set'));
  ipcMain.handle('features:open', wrap(async (id) => winfeatures.open(requireString(id, 'Eintrag')), 'features:open'));
  ipcMain.handle('features:action', wrap(async (id) => winfeatures.runAction(requireString(id, 'Eintrag')), 'features:action'));
  ipcMain.handle('features:restartExplorer', wrap(async () => winfeatures.restartExplorer(), 'features:restartExplorer'));

  /* --------------------------------------------------------------- hotkeys */

  ipcMain.handle('hotkeys:list', wrap(async () => hotkeys.list(), 'hotkeys:list'));
  ipcMain.handle('hotkeys:set', wrap(async (action, accelerator) =>
    hotkeys.set(requireString(action, 'Aktion'), typeof accelerator === 'string' ? accelerator : ''), 'hotkeys:set'));

  ipcMain.handle('window:reveal', wrap(async () => {
    if (typeof revealWindow === 'function') revealWindow();
    return true;
  }, 'window:reveal'));

  /* ----------------------------------------------------------------- files */

  ipcMain.handle('files:drives', wrap(async () => files.drives(), 'files:drives'));
  ipcMain.handle('files:quickLocations', wrap(async () => files.quickLocations(), 'files:quickLocations'));
  ipcMain.handle('files:list', wrap(async (target) => files.list(target), 'files:list'));
  ipcMain.handle('files:search', wrap(async (root, query, opts) => files.search(root, query, opts || {}), 'files:search'));
  ipcMain.handle('files:createFolder', wrap(async (parent, name) => files.createFolder(parent, name), 'files:createFolder'));
  ipcMain.handle('files:rename', wrap(async (target, name) => files.rename(target, name), 'files:rename'));
  ipcMain.handle('files:trash', wrap(async (targets) => files.trash(targets), 'files:trash'));
  ipcMain.handle('files:transfer', wrap(async (sources, destination, mode) => {
    if (mode !== 'copy' && mode !== 'move') throw new Error('Modus muss copy oder move sein');
    return files.transfer(sources, destination, mode);
  }, 'files:transfer'));
  ipcMain.handle('files:open', wrap(async (target) => files.open(target), 'files:open'));
  ipcMain.handle('files:reveal', wrap(async (target) => files.reveal(target), 'files:reveal'));
  ipcMain.handle('files:info', wrap(async (target) => files.info(target), 'files:info'));
  ipcMain.handle('files:folderSize', wrap(async (target) => files.folderSize(target), 'files:folderSize'));

  /* --------------------------------------------------------------- startup */

  ipcMain.handle('startup:list', wrap(async () => startup.list(), 'startup:list'));
  ipcMain.handle('startup:remove', wrap(async (id) => startup.remove(id), 'startup:remove'));
  ipcMain.handle('startup:reveal', wrap(async (id) => startup.reveal(id), 'startup:reveal'));

  /* ----------------------------------------------------------- diagnostics */

  ipcMain.handle('diag:build', wrap(async () => ({ report: await diagnostics.build() }), 'diag:build'));
  ipcMain.handle('diag:save', wrap(async () => diagnostics.save(), 'diag:save'));
  ipcMain.handle('diag:export', wrap(async () => diagnostics.exportTo(getWindow()), 'diag:export'));
  ipcMain.handle('diag:openLogs', wrap(async () => diagnostics.openLogFolder(), 'diag:openLogs'));
  ipcMain.handle('diag:logInfo', wrap(async () => logger.paths(), 'diag:logInfo'));
  ipcMain.handle('diag:logTail', wrap(async (lines) => ({
    lines: logger.tail(Math.max(20, Math.min(1000, Number(lines) || 200)))
  }), 'diag:logTail'));

  // Errors the renderer catches are useless if they stay in the renderer.
  ipcMain.handle('diag:report', wrap(async (entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('Kein Eintrag übergeben');
    const level = ['warn', 'error', 'info'].includes(entry.level) ? entry.level : 'error';
    logger.write(level, 'renderer', String(entry.message || '').slice(0, 2000), entry.stack ? `\n${String(entry.stack).slice(0, 4000)}` : '');
    return { ok: true };
  }, 'diag:report'));

  /* ------------------------------------------------------------ Claude Code */

  ipcMain.handle('claude:detect', wrap(async (force) => claudecode.detect({ force: !!force }), 'claude:detect'));
  ipcMain.handle('claude:pickFolder', wrap(async () => claudecode.pickFolder(getWindow()), 'claude:pickFolder'));
  ipcMain.handle('claude:open', wrap(async (cwd, prompt) => claudecode.openTerminal(cwd, prompt), 'claude:open'));
  ipcMain.handle('claude:analyse', wrap(async (reportPath, question) =>
    claudecode.analyse(reportPath, question), 'claude:analyse'));

  /* -------------------------------------------------------- Claude console */

  ipcMain.handle('claude:openWindow', wrap(async () => {
    if (typeof openClaudeWindow !== 'function') throw new Error('Fenster nicht verfügbar');
    openClaudeWindow();
    return { ok: true };
  }, 'claude:openWindow'));

  ipcMain.handle('claude:options', wrap(async () => claudesession.options(), 'claude:options'));
  ipcMain.handle('claude:state', wrap(async () => claudesession.state(), 'claude:state'));
  ipcMain.handle('claude:start', wrap(async (opts) => claudesession.start(opts || {}), 'claude:start'));
  ipcMain.handle('claude:send', wrap(async (text) => claudesession.send(text), 'claude:send'));
  ipcMain.handle('claude:stop', wrap(async () => claudesession.stop(), 'claude:stop'));
  ipcMain.handle('claude:history', wrap(async (cwd) =>
    ({ sessions: claudesession.listHistory(typeof cwd === 'string' ? cwd : null) }), 'claude:history'));
  ipcMain.handle('claude:forget', wrap(async (id) =>
    claudesession.forgetSession(requireString(id, 'Sitzung')), 'claude:forget'));
  ipcMain.handle('claude:interrupt', wrap(async () => claudesession.interrupt(), 'claude:interrupt'));

  // The console runs in its own window and needs the frame controls itself.
  ipcMain.handle('claude:window', wrap(async (action) => {
    const win = BrowserWindow.getFocusedWindow()
      || BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('claude.html'));
    if (!win) throw new Error('Fenster nicht gefunden');
    if (action === 'minimize') win.minimize();
    else if (action === 'close') win.close();
    else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else throw new Error(`Unbekannte Aktion: ${action}`);
    return { ok: true };
  }, 'claude:window'));

  /* ----------------------------------------------------------------- shell */

  ipcMain.handle('shell:openExternal', wrap(async (url) => {
    const target = requireString(url, 'URL');
    if (!/^(https?|steam|spotify|discord|com\.epicgames\.launcher|ms-settings):/i.test(target)) {
      throw new Error('Blocked URL scheme');
    }
    await shell.openExternal(target);
    return true;
  }, 'shell:openExternal'));

  ipcMain.handle('shell:openPath', wrap(async (target) => {
    const p = requireString(target, 'Path');
    const error = await shell.openPath(p);
    if (error) throw new Error(error);
    return true;
  }, 'shell:openPath'));
}

module.exports = { registerIpc, sanitizeProfile, sanitizeApp, sanitizeLaunch };
