'use strict';

/**
 * Runner for the renderer smoke tests.
 *
 * The logic tests in test/*.test.js cover the main process. Everything the
 * user actually looks at — thirteen views, the rail, the overlays and the
 * Claude console — had no net at all, so a broken selector or a view that
 * throws on mount only showed up by looking at a screenshot. This starts the
 * real application in a real Electron, drives it the way a user would and
 * fails the build when a view stops rendering.
 *
 * It runs on Linux because that is where CI is. Windows-only calls fail there
 * by design; the point is that a view survives those failures with an error
 * state instead of a blank page.
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const DRIVER = path.join(__dirname, 'driver.js');
const MARKER = '__UITEST__ ';

function electronBinary() {
  try {
    const bin = require('electron');
    if (typeof bin === 'string' && fs.existsSync(bin)) return bin;
  } catch (_) { /* not installed */ }
  return null;
}

function has(command) {
  const probe = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim().length > 0;
}

function buildCommand(binary) {
  const args = [DRIVER, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];

  // Windows and macOS always have a window server. Only X11 can be missing,
  // which is exactly the case in Linux CI, so borrow xvfb there.
  if (process.platform !== 'linux' || process.env.DISPLAY) return { command: binary, args };
  if (has('xvfb-run')) {
    return {
      command: 'xvfb-run',
      args: ['-a', '--server-args=-screen 0 1600x1000x24', binary, ...args]
    };
  }
  return null;
}

function report(result) {
  const pad = (n) => String(n).padStart(2, ' ');
  let failed = 0;
  for (const test of result.tests) {
    const mark = test.ok ? '  ok' : 'FAIL';
    console.log(`${mark} ${pad(test.index)}. ${test.name}${test.ms != null ? `  (${test.ms} ms)` : ''}`);
    for (const check of test.checks) {
      if (!check.ok) {
        failed += 1;
        console.log(`       ✗ ${check.message}`);
        if (check.detail !== undefined) console.log(`         ${check.detail}`);
      }
    }
    if (test.error) {
      failed += 1;
      console.log(`       ✗ ${test.error}`);
    }
  }

  if (result.consoleErrors.length) {
    console.log('\nUnerwartete Konsolenfehler im Renderer:');
    for (const line of result.consoleErrors) console.log(`  ✗ ${line}`);
    failed += result.consoleErrors.length;
  }

  const checks = result.tests.reduce((sum, t) => sum + t.checks.length, 0);
  console.log(`\n${result.tests.length} Ansichten, ${checks} Prüfungen, ${failed} Fehler`);
  return failed;
}

function main() {
  const binary = electronBinary();
  if (!binary) {
    console.log('UI-Tests übersprungen: Electron ist nicht installiert (npm install).');
    return 0;
  }

  const cmd = buildCommand(binary);
  if (!cmd) {
    console.log('UI-Tests übersprungen: kein DISPLAY und kein xvfb-run vorhanden.');
    console.log('Unter Linux hilft: sudo apt-get install -y xvfb');
    return 0;
  }

  return new Promise((resolve) => {
    const child = spawn(cmd.command, cmd.args, {
      cwd: ROOT,
      env: { ...process.env, HUB_UI_TEST: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    // A hung renderer must not hang the build.
    const guard = setTimeout(() => {
      console.error('UI-Tests: Zeitüberschreitung nach 180 s, Prozess wird beendet.');
      child.kill('SIGKILL');
    }, 180000);

    child.on('close', (code) => {
      clearTimeout(guard);
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith(MARKER));
      if (!line) {
        console.error('UI-Tests: kein Ergebnis erhalten.');
        console.error(`Exitcode ${code}`);
        if (stdout.trim()) console.error(`--- stdout ---\n${stdout.trim().slice(-4000)}`);
        if (stderr.trim()) console.error(`--- stderr ---\n${stderr.trim().slice(-4000)}`);
        resolve(1);
        return;
      }

      let result;
      try {
        result = JSON.parse(line.slice(MARKER.length));
      } catch (err) {
        console.error(`UI-Tests: Ergebnis unlesbar: ${err.message}`);
        resolve(1);
        return;
      }

      // Anything the driver logged outside the marker is worth seeing when
      // something failed, but is noise otherwise.
      const failures = report(result);
      if (failures && stderr.trim()) {
        console.error(`\n--- stderr ---\n${stderr.trim().slice(-3000)}`);
      }
      resolve(failures ? 1 : 0);
    });
  });
}

Promise.resolve(main()).then((code) => process.exit(code));
