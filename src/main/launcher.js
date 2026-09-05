'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { shell } = require('electron');
const processes = require('./processes');

/**
 * Launches single apps and whole profiles.
 *
 * Profile steps run sequentially with per-step delays, because launching
 * Spotify, Discord and a game in the same millisecond is how you get a game
 * that loses focus three times during its splash screen.
 */

const IS_WIN = process.platform === 'win32';

function expand(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/%([^%]+)%/g, (match, name) => process.env[name] || match);
}

function launchExe(item) {
  const target = expand(item.target);
  if (!target) throw new Error('Missing executable path');
  if (!fs.existsSync(target)) throw new Error(`Not found: ${target}`);
  const child = spawn(target, (item.args || []).map(expand), {
    detached: true,
    stdio: 'ignore',
    cwd: item.cwd ? expand(item.cwd) : path.dirname(target),
    windowsHide: false
  });
  child.unref();
  return { pid: child.pid };
}

async function launchUri(item) {
  const target = expand(item.target);
  if (!target) throw new Error('Missing URI');
  await shell.openExternal(target);
  return { uri: target };
}

function launchAppsFolder(item) {
  const target = expand(item.target);
  if (!target) throw new Error('Missing AppID');
  const child = spawn('explorer.exe', [`shell:AppsFolder\\${target}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  return { appId: target };
}

function launchShell(item) {
  const target = expand(item.target);
  if (!target) throw new Error('Missing command');
  const child = IS_WIN
    ? spawn('cmd.exe', ['/c', target], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn('/bin/sh', ['-c', target], { detached: true, stdio: 'ignore' });
  child.unref();
  return { command: target };
}

async function launchItem(item) {
  if (!item || typeof item !== 'object') throw new Error('Invalid launch item');
  switch (item.type) {
    case 'exe': return launchExe(item);
    case 'uri': return launchUri(item);
    case 'appsfolder': return launchAppsFolder(item);
    case 'shell': return launchShell(item);
    default: throw new Error(`Unknown launch type: ${item.type}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

/**
 * Runs a profile's steps in order.
 * `emit` receives {phase, index, total, step, ok, error} so the UI can render
 * a live boot sequence instead of a spinner.
 */
async function launchProfile(profile, emit = () => {}) {
  if (!profile || !Array.isArray(profile.apps)) throw new Error('Profile has no apps');
  const steps = profile.apps.filter((a) => a && a.enabled !== false);
  const results = [];

  emit({ phase: 'start', total: steps.length, profileId: profile.id, profileName: profile.name });

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step.delayMs) {
      emit({ phase: 'wait', index: i, total: steps.length, step, waitMs: step.delayMs });
      await sleep(step.delayMs);
    }
    emit({ phase: 'launch', index: i, total: steps.length, step });
    try {
      const info = await launchItem(step.launch || step);
      results.push({ name: step.name, ok: true, info });
      emit({ phase: 'done', index: i, total: steps.length, step, ok: true, info });
    } catch (err) {
      results.push({ name: step.name, ok: false, error: err.message });
      emit({ phase: 'done', index: i, total: steps.length, step, ok: false, error: err.message });
      if (step.required) {
        emit({ phase: 'aborted', index: i, total: steps.length, step, error: err.message });
        return { ok: false, results, aborted: true };
      }
    }
  }

  emit({ phase: 'finished', total: steps.length, results });
  return { ok: results.every((r) => r.ok), results };
}

/** Closes everything a profile started, by process name. */
async function stopProfile(profile) {
  if (!profile) throw new Error('Unknown profile');
  const names = new Set();
  for (const app of profile.apps || []) {
    const explicit = app.processName;
    if (explicit) { names.add(explicit); continue; }
    const target = app.launch && app.launch.type === 'exe' ? app.launch.target : null;
    if (target) names.add(path.basename(target));
  }
  for (const extra of profile.alsoClose || []) names.add(extra);

  const results = [];
  for (const name of names) {
    try {
      await processes.killByName(name);
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
    }
  }
  return { ok: true, results };
}

module.exports = { launchItem, launchProfile, stopProfile, expand };
