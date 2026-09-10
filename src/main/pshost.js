'use strict';

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const logger = require('./logger');

const log = logger.scoped('pshost');
const IS_WIN = process.platform === 'win32';

/**
 * One long-lived PowerShell instead of one per question.
 *
 * Every system query in this app — the process list, the GPU counters, the
 * drives, the display modes, the feature catalogue — used to start
 * powershell.exe from scratch. That start is the expensive part: the host loads
 * the .NET runtime and jits its own startup before it reads a single character,
 * which costs a few hundred milliseconds on an idle machine and, as the CI
 * runner demonstrated, tens of seconds on a busy one. The script itself is
 * usually the cheap half.
 *
 * So the process is kept alive and fed one job at a time over stdin. A job is
 * a base64 blob — no quoting, no line-break hazards — turned back into a
 * scriptblock and invoked, followed by a sentinel line that tells the reader
 * where the output ends. Invoking a scriptblock gives each job its own scope,
 * so nothing leaks from one to the next.
 *
 * If the host dies or a job hangs, the process is replaced and the work falls
 * back to a one-shot spawn. A slow answer is better than none; no answer at all
 * is what the old timeout produced.
 */

const BINARY = IS_WIN ? 'powershell.exe' : (process.env.PWSH_PATH || 'pwsh');
const ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'];

const PREAMBLE = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'\n";

// PSReadLine and friends emit terminal control sequences even with no terminal
// attached. They are not part of any answer.
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

const DEFAULT_TIMEOUT = 30000;
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

let child = null;
let buffer = '';
let current = null;         // { id, resolve, reject, timer }
const queue = [];
let consecutiveFailures = 0;
let disabled = false;       // fall back to one-shot spawns for the rest of the run
let idleTimer = null;
let starting = false;

/* ------------------------------------------------------------------ helpers */

function sentinel(id) { return `__HUB_END_${id}__`; }
function errorMark(id) { return `__HUB_ERR_${id}__`; }

function encode(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * One line, because the host executes a line at a time. The script arrives as
 * base64 so nothing inside it — quotes, newlines, backslashes, non-ASCII — has
 * to survive a second round of escaping.
 */
function jobLine(id, script) {
  // A thrown error is written to stdout with a marker rather than to stderr.
  // The two pipes have no ordering guarantee between them, so an error sent to
  // stderr could arrive after the sentinel that says the job is over, and the
  // caller would be told the script succeeded. On the same stream it cannot.
  return `$s=[System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encode(script)}')); `
    + `try { & ([scriptblock]::Create($s)) } catch { "${errorMark(id)}" + $_.Exception.Message }; `
    + `"${sentinel(id)}"\n`;
}

function clearIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function armIdleTimer() {
  clearIdleTimer();
  if (!child) return;
  idleTimer = setTimeout(() => {
    if (current || queue.length) { armIdleTimer(); return; }
    log.debug('Host wird nach Leerlauf beendet');
    stop();
  }, IDLE_SHUTDOWN_MS);
  if (idleTimer.unref) idleTimer.unref();
}

/* -------------------------------------------------------------- one-shot -- */

/** The way every call used to work; still the fallback when the host is unusable. */
function runOnce(script, timeout) {
  const encoded = Buffer.from(String(script), 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      BINARY,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout, maxBuffer: 24 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr || err.message));
        resolve(String(stdout).replace(ANSI, ''));
      }
    );
  });
}

/* ------------------------------------------------------------------ host -- */

/**
 * The host died under a job. Retrying it as a one-shot spawn is slower but
 * gives the caller a real answer instead of an error it cannot act on.
 */
function failCurrent(reason) {
  if (!current) return;
  const job = current;
  current = null;
  if (job.timer) clearTimeout(job.timer);
  consecutiveFailures += 1;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !disabled) {
    disabled = true;
    log.warn(`Host wird für diese Sitzung nicht mehr benutzt (${reason})`);
  }
  runOnce(job.script, job.timeout).then(job.resolve, job.reject);
}

function stop() {
  clearIdleTimer();
  const dying = child;
  child = null;
  buffer = '';
  if (dying) {
    dying.removeAllListeners();
    try { dying.stdin.end(); } catch (_) { /* already gone */ }
    try { dying.kill(); } catch (_) { /* already gone */ }
  }
}

function onData(chunk) {
  buffer += String(chunk).replace(ANSI, '');
  if (!current) { buffer = ''; return; }

  const marker = sentinel(current.id);
  const index = buffer.indexOf(marker);
  if (index === -1) {
    // Nothing can be answered yet. Keep only what could still be a partial
    // sentinel plus the payload; the payload has to be kept in full.
    return;
  }

  const output = buffer.slice(0, index);
  buffer = buffer.slice(index + marker.length);

  const job = current;
  current = null;
  if (job.timer) clearTimeout(job.timer);
  consecutiveFailures = 0;

  // Same contract the one-shot spawn had: a script that threw is a rejection,
  // a script that produced nothing is an empty answer.
  const errorAt = output.indexOf(errorMark(job.id));
  if (errorAt !== -1) {
    const message = output.slice(errorAt + errorMark(job.id).length).trim();
    job.reject(new Error(message || 'PowerShell meldete einen Fehler'));
    pump();
    return;
  }

  job.resolve(output.replace(/\r?\n$/, ''));
  pump();
}

function start() {
  if (child || disabled || starting) return child;
  starting = true;
  try {
    child = spawn(BINARY, ARGS, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (err) {
    starting = false;
    log.warn(`Host konnte nicht gestartet werden: ${err.message}`);
    return null;
  }
  starting = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', onData);

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).replace(ANSI, '').trim();
    if (text) log.debug(`stderr: ${text.slice(0, 400)}`);
  });

  child.on('error', (err) => {
    log.warn(`Host-Fehler: ${err.message}`);
    stop();
    failCurrent(err.message);
    pump();
  });

  child.on('exit', (code, signal) => {
    // Only worth reporting when it was not us who ended it.
    if (child) log.warn(`Host beendet (Code ${code}, Signal ${signal})`);
    stop();
    failCurrent('PowerShell-Host wurde beendet');
    pump();
  });

  try {
    child.stdin.write(PREAMBLE);
  } catch (err) {
    log.warn(`Host nimmt keine Eingaben an: ${err.message}`);
    stop();
    return null;
  }

  log.info(`PowerShell-Host gestartet (${BINARY})`);
  armIdleTimer();
  return child;
}

function pump() {
  if (current || !queue.length) { armIdleTimer(); return; }
  if (disabled) { drainToOneShot(); return; }
  if (!child && !start()) { drainToOneShot(); return; }

  const job = queue.shift();
  current = job;
  clearIdleTimer();

  job.timer = setTimeout(() => {
    // A hung job holds the only pipe there is, so the host is replaced rather
    // than waited on. The job itself is rejected and not retried: a script that
    // did not finish in its own time will not finish in a fresh process either,
    // and paying the timeout a second time only makes the wait longer.
    log.warn('Auftrag im Host hat die Zeit überschritten, Host wird ersetzt');
    stop();
    const hung = current;
    current = null;
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      disabled = true;
      log.warn('Host wird für diese Sitzung nicht mehr benutzt, es wird wieder einzeln gestartet');
    }
    hung.reject(new Error(`PowerShell hat nach ${hung.timeout} ms nicht geantwortet`));
    pump();
  }, job.timeout);

  try {
    child.stdin.write(jobLine(job.id, job.script));
  } catch (err) {
    clearTimeout(job.timer);
    current = null;
    stop();
    consecutiveFailures += 1;
    runOnce(job.script, job.timeout).then(job.resolve, job.reject);
    pump();
  }
}

function drainToOneShot() {
  while (queue.length) {
    const job = queue.shift();
    runOnce(job.script, job.timeout).then(job.resolve, job.reject);
  }
}

/* ------------------------------------------------------------------- API -- */

/**
 * Runs a script and resolves with everything it wrote to stdout.
 *
 * Errors thrown inside the script go to stderr and are logged rather than
 * rejected: the callers all treat an empty answer as "not available here",
 * which is the same thing a failed query means.
 */
function run(script, timeout = DEFAULT_TIMEOUT) {
  if (disabled) return runOnce(script, timeout);
  return new Promise((resolve, reject) => {
    queue.push({
      id: crypto.randomBytes(4).toString('hex'),
      script,
      timeout,
      resolve,
      reject,
      timer: null
    });
    pump();
  });
}

/** Starts the host before anything asks, so the first query is not the slow one. */
function warmUp() {
  if (disabled || child) return;
  start();
  if (child) run('$null', 10000).catch(() => { /* the point is the start, not the answer */ });
}

function dispose() {
  clearIdleTimer();
  for (const job of queue.splice(0)) job.reject(new Error('Beendet'));
  failCurrent('Beendet');
  stop();
}

function status() {
  return {
    binary: BINARY,
    running: !!child,
    queued: queue.length,
    busy: !!current,
    disabled,
    consecutiveFailures
  };
}

module.exports = { run, runOnce, warmUp, dispose, status, _jobLine: jobLine, ANSI };
