'use strict';

/**
 * Runs inside Electron. Boots the real application against a throwaway
 * configuration directory, hands a small toolkit to each test case and prints
 * one JSON line the runner picks up.
 *
 * The user's own configuration is never touched: userData is redirected to a
 * temporary directory before the app is required, which is also why the seed
 * below can assume an empty, predictable state.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..', '..');
const MARKER = '__UITEST__ ';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-uitest-'));
app.setPath('userData', dataDir);

/**
 * A profile with one entry of every launch type. It never gets launched, but
 * it makes the hub and the editor render the same shapes a real user sees.
 */
const SEED = {
  version: 1,
  settings: {
    startFullscreen: false,
    kiosk: false,
    bootAnimation: true,
    confirmExit: false,
    autostart: false,
    metricsIntervalMs: 1000,
    slowMetricsIntervalMs: 5000
  },
  profiles: [
    {
      id: 'test-profile',
      name: 'Helldivers 2',
      tagline: 'Testprofil',
      accent: '#00f0ff',
      apps: [
        { id: 'a1', name: 'Spotify', launch: { type: 'uri', target: 'spotify:' }, delayMs: 0, enabled: true },
        { id: 'a2', name: 'Discord', launch: { type: 'uri', target: 'discord:' }, delayMs: 500, enabled: true },
        { id: 'a3', name: 'Spiel', launch: { type: 'uri', target: 'steam://rungameid/553850' }, delayMs: 1500, enabled: true }
      ],
      alsoClose: [],
      minimizeOnLaunch: false,
      createdAt: 1700000000000,
      lastLaunched: 0,
      launchCount: 0
    }
  ],
  library: { customApps: [] },
  lastProfileId: null
};

fs.writeFileSync(path.join(dataDir, 'hub-config.json'), JSON.stringify(SEED, null, 2), 'utf8');

/* ------------------------------------------------------------- collectors */

const consoleErrors = [];

/**
 * Renderer messages that are expected when the app runs on anything other
 * than Windows. Everything else counts as a regression, which is the whole
 * point of collecting them.
 */
const IGNORED_CONSOLE = [
  'Autostart is Windows-only',
  'Windows-only',
  'nur unter Windows',
  'Electron Security Warning',
  'Request Autofill',
  'Autofill.enable',
  'Autofill.setAddresses'
];

function watchConsole(contents, label) {
  contents.on('console-message', (...args) => {
    // Electron changed this event from positional arguments to a single
    // object; accept both so the harness survives an upgrade.
    let level;
    let message;
    let source;
    let line;
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && 'message' in args[0]) {
      ({ level, message, sourceId: source, lineNumber: line } = args[0]);
    } else {
      [, level, message, line, source] = args;
    }
    const isError = level === 'error' || level === 3;
    if (!isError) return;
    const text = String(message || '');
    if (IGNORED_CONSOLE.some((needle) => text.includes(needle))) return;
    consoleErrors.push(`${label}: ${text} (${source || '?'}:${line || 0})`);
  });
}

/* ---------------------------------------------------------------- toolkit */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Failure extends Error {}

function makeToolkit(win) {
  const checks = [];

  const js = (code) => win.webContents.executeJavaScript(`(() => { ${code} })()`, true);
  const evalExpr = (expr) => win.webContents.executeJavaScript(`(${expr})`, true);

  async function waitFor(expr, { timeout = 10000, interval = 120, label } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    for (;;) {
      try {
        last = await evalExpr(expr);
        if (last) return last;
      } catch (err) {
        last = `Fehler: ${err.message}`;
      }
      if (Date.now() >= deadline) {
        throw new Failure(`Zeitüberschreitung beim Warten auf ${label || expr} (zuletzt: ${JSON.stringify(last)})`);
      }
      await wait(interval);
    }
  }

  function assert(condition, message, detail) {
    checks.push({ ok: !!condition, message, detail: condition ? undefined : detail });
    return !!condition;
  }

  function eq(actual, expected, message) {
    return assert(
      actual === expected,
      message,
      `erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`
    );
  }

  function atLeast(actual, minimum, message) {
    return assert(
      typeof actual === 'number' && actual >= minimum,
      message,
      `erwartet mindestens ${minimum}, war ${JSON.stringify(actual)}`
    );
  }

  /** Clicks a rail entry and waits until its view is on screen. */
  async function view(id) {
    await js(`document.querySelector('.rail-btn[data-view="${id}"]').click();`);
    await waitFor(`document.querySelector('.rail-btn[data-view="${id}"]').classList.contains('active')`,
      { label: `Ansicht ${id} aktiv` });
    // enterView animates; give the transition a frame so measurements are real.
    await wait(350);
    return id;
  }

  async function click(selector) {
    const found = await js(`
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      node.click();
      return true;
    `);
    if (!found) throw new Failure(`Element nicht gefunden: ${selector}`);
    return true;
  }

  /** Clicks the first element whose text matches, which is how a user picks a button. */
  async function clickText(selector, text) {
    const found = await js(`
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const hit = nodes.find((n) => n.textContent.trim() === ${JSON.stringify(text)});
      if (!hit) return false;
      hit.click();
      return true;
    `);
    if (!found) throw new Failure(`Schaltfläche „${text}" nicht gefunden (${selector})`);
    return true;
  }

  const count = (selector) => evalExpr(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const text = (selector) => evalExpr(
    `(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || null`
  );
  const exists = (selector) => evalExpr(`!!document.querySelector(${JSON.stringify(selector)})`);

  return {
    win, js, evalExpr, waitFor, assert, eq, atLeast,
    view, click, clickText, count, text, exists, wait, checks,
    windows: () => BrowserWindow.getAllWindows(),
    dataDir
  };
}

/* ------------------------------------------------------------------- main */

async function findHubWindow() {
  const deadline = Date.now() + 30000;
  for (;;) {
    const win = BrowserWindow.getAllWindows()
      .find((w) => !w.isDestroyed() && w.webContents.getURL().includes('index.html'));
    if (win && !win.webContents.isLoading()) return win;
    if (Date.now() >= deadline) throw new Error('Hub-Fenster ist nicht erschienen');
    await wait(150);
  }
}

async function run() {
  const hub = await findHubWindow();
  watchConsole(hub.webContents, 'hub');

  // Fullscreen in a virtual display is unpredictable; a fixed size makes
  // layout assertions mean the same thing on every machine.
  hub.setFullScreen(false);
  hub.setSize(1500, 940);

  // The boot animation owns the screen until it is done.
  await hub.webContents.executeJavaScript(
    `new Promise((resolve) => {
       const check = () => (document.querySelector('.rail-btn') ? resolve(true) : setTimeout(check, 100));
       check();
     })`, true
  );
  await wait(600);

  const cases = require('./cases');
  const tests = [];

  for (let i = 0; i < cases.length; i += 1) {
    const testCase = cases[i];
    const toolkit = makeToolkit(hub);
    toolkit.watchConsole = watchConsole;
    const started = Date.now();
    let error = null;
    try {
      await testCase.run(toolkit);
    } catch (err) {
      error = err instanceof Failure ? err.message : `${err.message}${err.stack ? `\n${err.stack.split('\n')[1] || ''}` : ''}`;
    }
    tests.push({
      index: i + 1,
      name: testCase.name,
      checks: toolkit.checks,
      error,
      ms: Date.now() - started,
      ok: !error && toolkit.checks.every((c) => c.ok)
    });
  }

  return { tests, consoleErrors };
}

app.on('window-all-closed', (event) => { if (event && event.preventDefault) event.preventDefault(); });

app.on('ready', () => {
  setTimeout(() => {
    run()
      .then((result) => {
        process.stdout.write(`${MARKER}${JSON.stringify(result)}\n`);
        app.exit(0);
      })
      .catch((err) => {
        process.stdout.write(`${MARKER}${JSON.stringify({
          tests: [{ index: 0, name: 'Start', checks: [], error: err.message, ok: false }],
          consoleErrors
        })}\n`);
        app.exit(0);
      });
  }, 50);
});

require(path.join(ROOT, 'src', 'main', 'main.js'));
