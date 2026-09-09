'use strict';

const { execFile, spawn } = require('child_process');
const path = require('path');
const { app, dialog } = require('electron');

const logger = require('./logger');
const log = logger.scoped('claude');

/**
 * Claude Code integration.
 *
 * Deliberately not an embedded terminal. A real one needs a pseudo-terminal,
 * which on Windows means a native module, and that turns a build with no
 * compiled dependencies into one that has to be rebuilt per Electron version
 * and architecture. For the value it adds here that is a bad trade.
 *
 * What is here instead: detect the CLI, open it in a folder the user picks,
 * and hand it the hub's own diagnostics report for analysis. The last one is
 * the reason this belongs in the app at all, because the report is exactly
 * the context needed to answer "why is my PC behaving strangely".
 *
 * Analysis runs through `claude -p`, which is the non-interactive mode. It
 * consumes the user's own Claude quota, so it never runs on its own: the
 * renderer has to ask for it explicitly.
 */

const IS_WIN = process.platform === 'win32';

let detection = null;
let detectedAt = 0;
const DETECT_TTL = 60 * 1000;

function run(command, args, { timeout = 20000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error((stderr || err.message || '').trim() || 'Aufruf fehlgeschlagen'));
        resolve(stdout);
      });
  });
}

/** Looks for the CLI on PATH, the usual npm locations, and reports its version. */
async function detect({ force = false } = {}) {
  if (!force && detection && Date.now() - detectedAt < DETECT_TTL) return detection;

  const candidates = IS_WIN
    ? ['claude.cmd', 'claude.exe', 'claude']
    : ['claude'];

  for (const candidate of candidates) {
    try {
      const out = await run(candidate, ['--version'], { timeout: 15000 });
      const version = (out || '').trim().split('\n')[0];
      detection = { installed: true, command: candidate, version, checkedAt: Date.now() };
      detectedAt = Date.now();
      log.info(`Claude Code gefunden: ${candidate} · ${version}`);
      return detection;
    } catch (_) { /* try the next candidate */ }
  }

  detection = {
    installed: false,
    command: null,
    version: null,
    checkedAt: Date.now(),
    hint: 'Claude Code ist nicht auf dem Suchpfad. Installation über npm: npm install -g @anthropic-ai/claude-code'
  };
  detectedAt = Date.now();
  log.info('Claude Code nicht gefunden');
  return detection;
}

function requireInstalled() {
  if (!detection || !detection.installed) {
    throw new Error('Claude Code wurde nicht gefunden. Prüfe die Installation und drücke auf „Erneut suchen".');
  }
  return detection.command;
}

/** Opens an interactive session in a terminal window the user can type into. */
async function openTerminal(cwd, initialPrompt) {
  await detect();
  requireInstalled();

  const dir = cwd && typeof cwd === 'string' ? cwd : app.getPath('home');
  log.info(`Claude Code wird geöffnet in ${dir}`);

  if (!IS_WIN) {
    // Development convenience only; the shipped app is Windows-only.
    spawn('x-terminal-emulator', ['-e', 'claude'], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
    return { ok: true, directory: dir };
  }

  // Windows Terminal when present, otherwise the classic console host. Both
  // are started detached so closing the hub does not close the session.
  const args = initialPrompt
    ? `claude "${String(initialPrompt).replace(/"/g, "'")}"`
    : 'claude';

  const child = spawn('cmd.exe', ['/c', 'start', '""', 'wt.exe', '-d', dir, 'cmd', '/k', args], {
    detached: true, stdio: 'ignore', windowsHide: true
  });
  child.on('error', () => {
    spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', `cd /d "${dir}" && ${args}`], {
      detached: true, stdio: 'ignore', windowsHide: true
    }).unref();
  });
  child.unref();

  return { ok: true, directory: dir, prompt: initialPrompt || null };
}

async function pickFolder(win) {
  const result = await dialog.showOpenDialog(win, {
    title: 'Ordner für Claude Code wählen',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

/**
 * One-shot analysis of a report. Uses the caller's Claude quota, so it is
 * only ever started from an explicit action in the interface.
 */
async function analyse(reportPath, question) {
  await detect();
  const command = requireInstalled();

  if (typeof reportPath !== 'string' || !reportPath) throw new Error('Kein Bericht übergeben');

  const prompt = [
    question && String(question).trim()
      ? String(question).trim()
      : 'Analysiere diesen Diagnosebericht eines Windows-PCs.',
    '',
    'Antworte auf Deutsch und in dieser Form:',
    '1. Was fällt auf, nach Wichtigkeit sortiert',
    '2. Was davon ist wirklich ein Problem und was ist normal',
    '3. Konkrete nächste Schritte',
    '',
    `Der Bericht liegt in der Datei: ${reportPath}`,
    'Lies die Datei und beziehe dich auf konkrete Werte daraus.'
  ].join('\n');

  log.info('Analyse über Claude Code gestartet');
  const started = Date.now();

  try {
    const out = await run(command, ['-p', prompt], {
      timeout: 240000,
      cwd: path.dirname(reportPath)
    });
    const answer = (out || '').trim();
    log.info(`Analyse abgeschlossen nach ${Math.round((Date.now() - started) / 1000)} s`);
    if (!answer) throw new Error('Claude Code hat keine Antwort geliefert');
    return { ok: true, answer, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (err) {
    log.error('Analyse fehlgeschlagen:', err.message);
    if (/timed out|ETIMEDOUT/i.test(err.message)) {
      throw new Error('Die Analyse hat zu lange gedauert und wurde abgebrochen.');
    }
    throw new Error(`Analyse fehlgeschlagen: ${err.message}`);
  }
}

module.exports = { detect, openTerminal, pickFolder, analyse };
