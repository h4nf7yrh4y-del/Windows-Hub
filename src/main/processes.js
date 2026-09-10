'use strict';

const { execFile } = require('child_process');
const os = require('os');
const pshost = require('./pshost');

/**
 * Task-manager backend.
 *
 * One PowerShell round trip per poll (~200-400ms) instead of a per-process
 * shell-out. CPU percentage is derived from the delta of total processor
 * seconds between two polls, normalised by elapsed wall time and core count,
 * which is how Task Manager itself reports it.
 */

const IS_WIN = process.platform === 'win32';
const CORES = os.cpus().length || 1;

let prev = new Map(); // pid -> { cpuSeconds, ts }
let lastPoll = 0;
let inFlight = null;

const PS_SCRIPT = `
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-Process | ForEach-Object {
  [PSCustomObject]@{
    id      = $_.Id
    name    = $_.ProcessName
    ws      = $_.WorkingSet64
    cpu     = $_.CPU
    title   = $_.MainWindowTitle
    threads = $_.Threads.Count
    start   = if ($_.StartTime) { $_.StartTime.ToFileTimeUtc() } else { 0 }
  }
} | ConvertTo-Json -Compress -Depth 2
`;

/**
 * Every PowerShell query in the app goes through here.
 *
 * The script used to be handed to a freshly started powershell.exe as base64
 * UTF-16LE, which solved the quoting problem but paid for a process start each
 * time. It now goes to a host that is already running and is fed the same
 * base64, so the quoting guarantees are unchanged and the start is paid once.
 * The contract is the same as before: a script that throws rejects, a script
 * that writes nothing resolves with an empty string.
 */
function runPowerShell(script, timeout = 40000) {
  return pshost.run(script, timeout);
}

function runCommand(cmd, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 24 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function rawWindows() {
  const out = await runPowerShell(PS_SCRIPT);
  const trimmed = (out || '').trim();
  if (!trimmed) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Unparsable process list: ${err.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((p) => ({
    pid: Number(p.id),
    name: p.name || 'unknown',
    memory: Number(p.ws) || 0,
    cpuSeconds: typeof p.cpu === 'number' ? p.cpu : 0,
    title: (p.title || '').trim(),
    threads: Number(p.threads) || 0,
    startedAt: Number(p.start) || 0
  }));
}

// Dev fallback so the UI is testable outside Windows.
async function rawPosix() {
  const out = await runCommand('ps', ['-eo', 'pid,comm,rss,time,nlwp', '--no-headers']);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const [pid, name, rss, time, nlwp] = parts;
      const seg = (time || '0:0').split(':').map(Number).reverse();
      const cpuSeconds = (seg[0] || 0) + (seg[1] || 0) * 60 + (seg[2] || 0) * 3600;
      return {
        pid: Number(pid),
        name,
        memory: (Number(rss) || 0) * 1024,
        cpuSeconds,
        title: '',
        threads: Number(nlwp) || 0,
        startedAt: 0
      };
    });
}

async function list() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const now = Date.now();
    const rows = IS_WIN ? await rawWindows() : await rawPosix();
    const elapsedSec = lastPoll ? (now - lastPoll) / 1000 : 0;
    const next = new Map();
    const totalMem = os.totalmem();

    const result = rows.map((row) => {
      const before = prev.get(row.pid);
      let cpu = 0;
      if (before && elapsedSec > 0.2) {
        const delta = row.cpuSeconds - before.cpuSeconds;
        if (delta >= 0) cpu = Math.min(100, (delta / elapsedSec / CORES) * 100);
      }
      next.set(row.pid, { cpuSeconds: row.cpuSeconds });
      return {
        pid: row.pid,
        name: row.name,
        title: row.title,
        memory: row.memory,
        memoryPercent: totalMem ? (row.memory / totalMem) * 100 : 0,
        cpu,
        threads: row.threads,
        startedAt: row.startedAt
      };
    });

    prev = next;
    lastPoll = now;
    return { ts: now, cores: CORES, processes: result };
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * Just the distinct names of running processes.
 *
 * The full list() call fetches working set, CPU time and window titles for
 * every process, which costs a few hundred milliseconds. Profile status only
 * needs to know whether a name is alive, so this asks for nothing else and
 * stays cheap enough to poll every few seconds.
 */
const NAMES_SCRIPT = `
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
@(Get-Process | Select-Object -ExpandProperty ProcessName -Unique) | ConvertTo-Json -Compress
`;

let namesInFlight = null;

async function runningNames() {
  if (namesInFlight) return namesInFlight;

  namesInFlight = (async () => {
    if (!IS_WIN) {
      const out = await runCommand('ps', ['-eo', 'comm=', '--no-headers']);
      return [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))];
    }
    const out = await runPowerShell(NAMES_SCRIPT, 40000);
    const trimmed = (out || '').trim();
    if (!trimmed) return [];
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch (_) { return []; }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((n) => typeof n === 'string' && n);
  })();

  try {
    return await namesInFlight;
  } finally {
    namesInFlight = null;
  }
}

/** Normalises "Game.exe", "GAME" and "game" to one comparable key. */
function normalizeName(name) {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/\.(exe|com|bat|cmd)$/i, '').toLowerCase();
}

async function kill(pid, { tree = true, force = true } = {}) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid PID');
  if (id === process.pid) throw new Error('Refusing to kill the hub itself');

  if (IS_WIN) {
    const args = ['/PID', String(id)];
    if (tree) args.push('/T');
    if (force) args.push('/F');
    await runCommand('taskkill', args);
    return { ok: true, pid: id };
  }
  process.kill(id, force ? 'SIGKILL' : 'SIGTERM');
  return { ok: true, pid: id };
}

async function killByName(name, opts = {}) {
  if (!name || typeof name !== 'string') throw new Error('Invalid process name');
  const clean = name.replace(/\.exe$/i, '');
  if (IS_WIN) {
    const args = ['/IM', `${clean}.exe`];
    if (opts.tree !== false) args.push('/T');
    if (opts.force !== false) args.push('/F');
    try {
      await runCommand('taskkill', args);
    } catch (err) {
      // taskkill exits non-zero when nothing matched; that is not a failure here.
      if (!/not found|nicht gefunden/i.test(err.message)) throw err;
    }
    return { ok: true, name: clean };
  }
  try { await runCommand('pkill', ['-f', clean]); } catch (_) { /* nothing matched */ }
  return { ok: true, name: clean };
}

async function setPriority(pid, priority) {
  const map = { low: 64, belownormal: 16384, normal: 32, abovenormal: 32768, high: 128, realtime: 256 };
  const value = map[String(priority).toLowerCase()];
  if (!value) throw new Error(`Unknown priority: ${priority}`);
  if (!IS_WIN) throw new Error('Priority changes are Windows-only');
  await runPowerShell(`(Get-Process -Id ${Number(pid)}).PriorityClass=${value}`);
  return { ok: true };
}

function reset() {
  prev = new Map();
  lastPoll = 0;
}

module.exports = {
  list, runningNames, normalizeName, kill, killByName, setPriority, reset,
  runPowerShell, PS_SCRIPT
};
