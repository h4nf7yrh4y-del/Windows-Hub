'use strict';

const path = require('path');
const { app, BrowserWindow, globalShortcut, screen, protocol, net } = require('electron');
const url = require('url');

const logger = require('./logger');
const store = require('./store');
const metrics = require('./metrics');
const { registerIpc } = require('./ipc');
const overlays = require('./overlays');
const launcher = require('./launcher');
const hotkeys = require('./hotkeys');
const claudesession = require('./claudesession');
const tweaks = require('./tweaks');
const pshost = require('./pshost');
const scheduler = require('./scheduler');
const triggers = require('./triggers');
const sessions = require('./sessions');
const display = require('./display');
const screens = require('./screens');
const dashboard = require('./dashboard');
const tray = require('./tray');
const windowlayout = require('./windowlayout');
const log = logger.scoped('main');

const IS_DEV = process.argv.includes('--dev');
const IS_WIN = process.platform === 'win32';
const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');

let mainWindow = null;

// The renderer is served over a custom scheme instead of file://, so ES module
// imports, fetch and a strict CSP all behave like they would on the web.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'hub',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

function registerRendererProtocol() {
  protocol.handle('hub', async (request) => {
    const parsed = new URL(request.url);
    const rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '') || 'index.html';
    const resolved = path.resolve(RENDERER_ROOT, rel);
    // Refuse anything that escapes the renderer directory.
    if (resolved !== RENDERER_ROOT && !resolved.startsWith(RENDERER_ROOT + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    const response = await net.fetch(url.pathToFileURL(resolved).toString());
    // Chromium refuses module scripts without a JavaScript MIME type, and
    // file:// responses do not reliably carry one.
    const mime = MIME_TYPES[path.extname(resolved).toLowerCase()];
    if (!mime) return response;
    const headers = new Headers(response.headers);
    headers.set('Content-Type', mime);
    return new Response(response.body, { status: response.status, headers });
  });
}

// A hub that starts with Windows must never end up with two instances
// fighting over fullscreen.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function createWindow() {
  const settings = store.getSettings();
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1600, width),
    height: Math.min(950, height),
    minWidth: 1024,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: '#05070a',
    autoHideMenuBar: true,
    title: 'Windows Hub',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadURL('hub://app/index.html');

  mainWindow.once('ready-to-show', () => {
    // Which monitor the hub belongs on. Placing it before filling the screen
    // matters: a window that is already fullscreen ignores setBounds, so the
    // order decides whether the choice has any effect at all.
    const target = screens.resolve(settings.hubDisplay || null);
    if (target.display.id !== screen.getPrimaryDisplay().id || settings.hubDisplay) {
      screens.placeWindow(mainWindow, target.display, { fullscreen: false });
    }
    if (settings.kiosk) mainWindow.setKiosk(true);
    else if (settings.startFullscreen) screens.placeWindow(mainWindow, target.display, { fullscreen: true });
    mainWindow.show();
    mainWindow.focus();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Without this a crashed renderer leaves a blank window and the only way
  // out is the emergency exit. Reload once, and stop if it keeps dying so a
  // crash loop does not spin forever.
  let reloadAttempts = 0;
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error(`Renderer beendet: ${details.reason} (exitCode ${details.exitCode})`);
    if (details.reason === 'clean-exit' || mainWindow.isDestroyed()) return;
    reloadAttempts += 1;
    if (reloadAttempts > 3) {
      log.error('Renderer stürzt wiederholt ab, kein weiterer Neuladeversuch');
      return;
    }
    log.warn(`Oberfläche wird neu geladen (Versuch ${reloadAttempts})`);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    }, 600);
  });

  mainWindow.webContents.on('unresponsive', () => log.warn('Oberfläche reagiert nicht'));
  mainWindow.webContents.on('responsive', () => log.info('Oberfläche reagiert wieder'));

  // Never let the renderer navigate away or spawn extra windows.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  return mainWindow;
}

let claudeWindow = null;

/**
 * The Claude console gets its own window rather than a view in the hub: it is
 * something you keep open beside other work, resize, and move to a second
 * screen, none of which a panel inside a fullscreen launcher allows.
 */
function createClaudeWindow() {
  if (claudeWindow && !claudeWindow.isDestroyed()) {
    if (claudeWindow.isMinimized()) claudeWindow.restore();
    claudeWindow.show();
    claudeWindow.focus();
    return claudeWindow;
  }

  const display = screen.getPrimaryDisplay().workAreaSize;
  claudeWindow = new BrowserWindow({
    width: Math.min(1080, display.width - 80),
    height: Math.min(820, display.height - 80),
    minWidth: 620,
    minHeight: 480,
    show: false,
    frame: false,
    backgroundColor: '#05070a',
    title: 'Claude Code',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  claudeWindow.removeMenu();
  claudeWindow.loadURL('hub://app/claude.html');
  claudeWindow.once('ready-to-show', () => { claudeWindow.show(); claudeWindow.focus(); });
  claudeWindow.on('closed', () => { claudeWindow = null; });
  claudeWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  claudeWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  log.info('Claude-Konsole geöffnet');
  return claudeWindow;
}

function applyAutostart(enabled) {
  if (!IS_WIN) return { ok: false, reason: 'Autostart is Windows-only' };
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: ['--autostart']
    });
    return { ok: true, enabled: !!enabled };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Pulls the window in front of whatever is running.
 *
 * Windows does not reliably raise a window just because it was asked to, so
 * always-on-top is forced for a moment and then put back. This still cannot
 * beat a game in exclusive fullscreen, which the compositor draws directly.
 */
function revealWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();

  const wasOnTop = mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  mainWindow.focus();
  try { app.focus({ steal: true }); } catch (_) { /* not supported everywhere */ }

  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(wasOnTop);
  }, 250);
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const onScreen = mainWindow.isVisible() && !mainWindow.isMinimized();
  if (onScreen && mainWindow.isFocused()) mainWindow.minimize();
  else revealWindow();
}

function toggleOverlays() {
  if (overlays.count() > 0) {
    // Keeps the enabled flags, so the same set comes back on the next press.
    overlays.closeAll();
  } else {
    overlays.restore();
  dashboard.restore();
    // Nothing was ever enabled: give the key something to do rather than
    // leaving the user wondering whether it worked.
    if (overlays.count() === 0) {
      try { overlays.setEnabled('combo', true); } catch (err) { console.error('[hotkeys]', err.message); }
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlays:changed', { open: overlays.count() });
  }
}

function registerShortcuts() {
  // Deliberately the only global binding outside the user's own hotkeys:
  // it is the documented way out of kiosk mode. Fullscreen toggling is
  // handled inside the window instead, so F11 is not stolen from every
  // other application on the system.
  const emergencyExit = globalShortcut.register('CommandOrControl+Shift+Q', () => app.exit(0));
  if (!emergencyExit) console.warn('[main] Ctrl+Shift+Q konnte nicht registriert werden');

  const results = hotkeys.init({
    toggleHub: toggleWindow,
    toggleOverlays,
    openClaude: () => createClaudeWindow(),
    toggleDashboard: () => dashboard.toggle()
  }, {
    // A profile key does exactly what its Start button does. Failures are
    // logged rather than surfaced: the key was pressed from inside a game,
    // where a dialog would be worse than a line in the log.
    onProfile: (profileId) => {
      const profile = (store.state.profiles || []).find((p) => p.id === profileId);
      if (!profile) return;
      log.info(`Profil „${profile.name}" über Tastenkürzel gestartet`);
      launcher.launchProfile(profile, (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('profile:progress', event);
      }).catch((err) => log.error(`Tastenkürzel-Start fehlgeschlagen: ${err.message}`));
    }
  });
  for (const result of results) {
    if (!result.ok) console.warn(`[hotkeys] ${result.action}: ${result.reason}`);
  }
}

app.on('ready', () => {
  if (!gotLock) return;

  logger.init({ dir: path.join(app.getPath('userData'), 'logs'), level: IS_DEV ? 'debug' : 'info' });
  logger.logStartup({
    Autostart: process.argv.includes('--autostart') ? 'ja' : 'nein',
    Konfiguration: store.configPath()
  });

  store.load();
  const settings = store.getSettings();

  registerRendererProtocol();
  createWindow();
  registerIpc({
    getWindow: () => mainWindow,
    applyAutostart,
    revealWindow,
    openClaudeWindow: createClaudeWindow,
    toggleOverlays
  });

  overlays.init({
    preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    // Overlays are consumers of the metrics stream in their own right, so the
    // collector must keep running even when the hub window is hidden.
    onChange: (count) => metrics.setExtraSubscribers('overlays', count)
  });

  dashboard.init({
    preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    onChange: (open) => {
      metrics.setExtraSubscribers('dashboard', open ? 1 : 0);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dashboard:changed', dashboard.status());
      }
    }
  });

  metrics.start((sample) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('metrics:sample', sample);
    }
    overlays.broadcast('metrics:sample', sample);
    dashboard.send('metrics:sample', sample);
  }, {
    fastMs: settings.metricsIntervalMs,
    slowMs: settings.slowMetricsIntervalMs,
    includeGpu: settings.showGpu
  });

  overlays.restore();

  claudesession.setEmitter((event) => {
    for (const win of [claudeWindow, mainWindow]) {
      if (win && !win.isDestroyed()) win.webContents.send('claude:event', event);
    }
  });

  registerShortcuts();

  tray.init({
    iconPath: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    onOpen: revealWindow,
    onToggle: toggleWindow,
    onQuit: () => app.quit()
  });

  // Start the PowerShell host before anything asks for it, so the first
  // process list is not the one that pays for the runtime loading itself.
  if (IS_WIN) {
    pshost.warmUp();
    // Compiling the monitor helper is a compiler run and is paid once per
    // version. Doing it now, in the background, keeps it from happening the
    // first time someone opens the monitor panel — and from blocking every
    // other system query while it does.
    display.ensureCompiled()
      .then((result) => {
        if (result.ok && !result.cached) log.info(`Bildschirm-Hilfsklasse übersetzt (${result.ms} ms)`);
        else if (!result.ok) log.warn(`Bildschirm-Hilfsklasse: ${result.reason}`);
      })
      .catch((err) => log.warn(`Bildschirm-Hilfsklasse: ${err.message}`));

    // The window helper is only warmed up for someone who actually uses it.
    // Compiling it for every hub that never remembers a window position would
    // be a compiler run nobody asked for; leaving it entirely lazy would make
    // the first profile launch pay it, and the layout would time out waiting
    // for its own helper.
    if ((store.state.profiles || []).some((p) => p && (p.layout || []).length)) {
      windowlayout.ensureCompiled()
        .then((result) => {
          if (result.ok && !result.cached) log.info(`Fenster-Hilfsklasse übersetzt (${result.ms} ms)`);
          else if (!result.ok) log.warn(`Fenster-Hilfsklasse: ${result.reason}`);
        })
        .catch((err) => log.warn(`Fenster-Hilfsklasse: ${err.message}`));
    }
  }

  scheduler.start((channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  });

  // Starts polling only if a profile actually asks for it, so a hub without
  // triggers costs nothing.
  triggers.refresh();

  // A power plan the hub switched must not outlive the hub. If a snapshot is
  // still on disk, the last run ended without getting to undo it.
  tweaks.restoreAfterCrash().catch((err) => log.error(`Systemzustand: ${err.message}`));

  // Keep the stored autostart flag and the real login item in sync on boot.
  if (IS_WIN) {
    const current = app.getLoginItemSettings({ path: process.execPath, args: ['--autostart'] });
    if (current.openAtLogin !== settings.autostart) applyAutostart(settings.autostart);
  }
});

process.on('uncaughtException', (err) => {
  log.error('Unbehandelte Ausnahme im Hauptprozess:', err);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unbehandelte Zurückweisung im Hauptprozess:', reason);
});

app.on('window-all-closed', () => {
  metrics.stop();
  app.quit();
});

app.on('before-quit', () => {
  overlays.closeAll();
  dashboard.close();
  try { claudesession.stop(); } catch (_) { /* nothing running */ }
  // Releases the display blocker synchronously. The rest of the revert needs
  // PowerShell and cannot finish inside a quit handler, which is exactly why
  // the snapshot is on disk and gets picked up on the next start.
  try { tweaks.keepAwake(false); } catch (_) { /* nothing held */ }
});

app.on('will-quit', () => {
  log.info('Hub wird beendet');
  scheduler.stop();
  triggers.stop();
  sessions.stop();
  pshost.dispose();
  hotkeys.dispose();
  globalShortcut.unregisterAll();
  metrics.stop();
  tray.destroy();
  store.save();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
