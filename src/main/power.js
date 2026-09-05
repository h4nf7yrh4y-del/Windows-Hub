'use strict';

const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

/**
 * Power actions. Deliberately destructive, so the renderer is required to
 * confirm before calling any of these.
 */
const ACTIONS = {
  shutdown: () => run('shutdown', ['/s', '/t', '0']),
  restart: () => run('shutdown', ['/r', '/t', '0']),
  logoff: () => run('shutdown', ['/l']),
  lock: () => run('rundll32.exe', ['user32.dll,LockWorkStation']),
  // Hibernation must be off, otherwise this hibernates instead of sleeping.
  sleep: () => run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'])
};

async function perform(action) {
  if (!IS_WIN) throw new Error('Power actions are Windows-only');
  const fn = ACTIONS[action];
  if (!fn) throw new Error(`Unknown power action: ${action}`);
  await fn();
  return { ok: true, action };
}

module.exports = { perform, actions: Object.keys(ACTIONS) };
