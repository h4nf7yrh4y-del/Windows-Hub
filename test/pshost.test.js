'use strict';

/**
 * The long-lived PowerShell host.
 *
 * This is the piece every system query now goes through, so its framing has to
 * be exactly right: a sentinel that lands inside someone's JSON, or a job that
 * inherits a variable from the one before, would produce wrong answers rather
 * than obvious failures. Runs against whatever PowerShell is available; skipped
 * with a notice when there is none.
 */

const assert = require('assert');
const { spawnSync } = require('child_process');

function findPowerShell() {
  const candidates = [process.env.PWSH_PATH, 'pwsh', 'powershell', 'powershell.exe'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ['-NoProfile', '-Command', '1'], { encoding: 'utf8', timeout: 20000 });
      if (probe.status === 0) return candidate;
    } catch (_) { /* next */ }
  }
  return null;
}

const shell = findPowerShell();
if (!shell) {
  console.log('PowerShell-Host');
  console.log('  skipped: no pwsh or powershell binary found');
  console.log('  (set PWSH_PATH to enable these checks)');
  module.exports = { skipped: true };
  return;
}

process.env.PWSH_PATH = shell;
const pshost = require('../src/main/pshost');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

/* --------------------------------------------------------------- framing */

function jobLineChecks() {
  const line = pshost._jobLine('abc123', "'hi'");
  assert.ok(!/\n.+/.test(line.trim()), 'the job must be a single line');
  assert.ok(line.includes('__HUB_END_abc123__'), 'sentinel missing');
  // The script itself must not appear literally: that is the whole point of
  // encoding it, and a literal quote would end the surrounding string.
  assert.ok(!line.includes("& ([scriptblock]::Create('hi'"), 'script was inlined instead of encoded');
}

(async () => {
  console.log(`PowerShell-Host (${shell})`);

  await test('a job is one line and carries its own sentinel', jobLineChecks);

  await test('a simple script comes back as text', async () => {
    const out = await pshost.run("'hallo'");
    assert.strictEqual(out.trim(), 'hallo');
  });

  await test('JSON survives unchanged', async () => {
    const out = await pshost.run("@('a','b') | ConvertTo-Json -Compress");
    assert.deepStrictEqual(JSON.parse(out.trim()), ['a', 'b']);
  });

  await test('backslashes and non-ASCII survive both directions', async () => {
    const script = String.raw`[PSCustomObject]@{ p = 'C:\Users\Grüße'; s = "Straße" } | ConvertTo-Json -Compress`;
    const parsed = JSON.parse((await pshost.run(script)).trim());
    assert.strictEqual(parsed.p, 'C:\\Users\\Grüße');
    assert.strictEqual(parsed.s, 'Straße');
  });

  await test('a script that throws rejects and does not take the host with it', async () => {
    await assert.rejects(pshost.run("throw 'kaputt'"), /kaputt/,
      'a thrown error must reach the caller, exactly as a one-shot spawn did');
    const after = await pshost.run("'noch da'");
    assert.strictEqual(after.trim(), 'noch da', 'the host died on an error inside a job');
  });

  await test('a script that writes nothing is an empty answer, not an error', async () => {
    const out = await pshost.run("$ErrorActionPreference='SilentlyContinue'; Get-Item '/gibt-es-nicht-zzz' | Out-Null");
    assert.strictEqual(out.trim(), '');
  });

  await test('nothing leaks from one job into the next', async () => {
    await pshost.run('$leak = 42');
    const out = await pshost.run('if ($null -eq $leak) { "sauber" } else { "leck: $leak" }');
    assert.strictEqual(out.trim(), 'sauber');
  });

  await test('a sentinel-shaped string inside the output is not mistaken for the end', async () => {
    // Nothing else can produce this: the id is random per job.
    const out = await pshost.run('"__HUB_END_deadbeef__"; "danach"');
    assert.ok(out.includes('danach'), `output was cut short:\n${JSON.stringify(out)}`);
  });

  await test('jobs queued at once come back in order and complete', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => pshost.run(`${n} * 2`)));
    assert.deepStrictEqual(results.map((r) => r.trim()), ['2', '4', '6', '8', '10']);
  });

  await test('the host is reused rather than restarted per call', async () => {
    const first = await pshost.run('$PID');
    const second = await pshost.run('$PID');
    assert.strictEqual(first.trim(), second.trim(), 'a second call started a new process');
    assert.ok(pshost.status().running, 'the host should still be alive');
  });

  await test('a hung job fails on time and the host recovers', async () => {
    await assert.rejects(
      pshost.run('Start-Sleep -Seconds 30', 1200),
      /nicht geantwortet/,
      'a job past its timeout must reject rather than hang'
    );
    const after = await pshost.run("'wieder da'");
    assert.strictEqual(after.trim(), 'wieder da', 'the host did not come back after a hung job');
  });

  await test('being reused is measurably cheaper than starting each time', async () => {
    await pshost.run('1');
    const hostStart = Date.now();
    for (let i = 0; i < 3; i += 1) await pshost.run(`${i}`);
    const hostMs = Date.now() - hostStart;

    const onceStart = Date.now();
    for (let i = 0; i < 3; i += 1) await pshost.runOnce(`${i}`, 30000);
    const onceMs = Date.now() - onceStart;

    console.log(`       Host ${hostMs} ms · Einzelstarts ${onceMs} ms`);
    assert.ok(hostMs * 2 < onceMs,
      `the host (${hostMs} ms) should be far faster than three cold starts (${onceMs} ms)`);
  });

  pshost.dispose();
  console.log(`\n${passed} assertions passed.`);
})();
