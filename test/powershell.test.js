'use strict';

/**
 * Validates every PowerShell script the app generates.
 *
 * These scripts are the least testable part of the codebase: they only run on
 * Windows, and a syntax error surfaces as an empty result rather than a crash.
 * PowerShell's own parser catches that without needing Windows, and its
 * ConvertTo-Json output is used to check the Node-side parsing against the
 * real serialisation rather than an assumption about it.
 *
 * Skipped with a notice when no PowerShell binary is available.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const gpu = require('../src/main/gpu');
const processes = require('../src/main/processes');

function findPowerShell() {
  const candidates = [process.env.PWSH_PATH, 'pwsh', 'powershell', 'powershell.exe'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '$PSVersionTable.PSVersion.Major'], {
        encoding: 'utf8',
        timeout: 20000
      });
      if (probe.status === 0) return candidate;
    } catch (_) { /* try the next candidate */ }
  }
  return null;
}

const shell = findPowerShell();

if (!shell) {
  console.log('PowerShell script validation');
  console.log('  skipped: no pwsh or powershell binary found');
  console.log('  (set PWSH_PATH to enable these checks)');
  module.exports = { skipped: true };
  return;
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

function run(script) {
  const file = path.join(os.tmpdir(), `hub-ps-${process.pid}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(file, script, 'utf8');
  try {
    return execFileSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 60000 });
  } finally {
    try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
  }
}

console.log(`PowerShell script validation (${shell})`);

/* ------------------------------------------------------------- syntax pass */

const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

// Every script the app can hand to PowerShell, including the ones assembled
// from user-influenced values.
const SCRIPTS = {
  'gpu static': gpu.STATIC_SCRIPT,
  'gpu sample': gpu.SAMPLE_SCRIPT,
  'process list': processes.PS_SCRIPT,
  'startup read': `
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$k = Get-Item -LiteralPath '${RUN_KEY}'
if ($k) {
  @($k.GetValueNames() | ForEach-Object {
    [PSCustomObject]@{ name = $_; value = [string]$k.GetValue($_) }
  }) | ConvertTo-Json -Compress
}
`,
  // A registry value name containing an apostrophe must stay inside the literal.
  'startup remove with quote in name': `
$ErrorActionPreference = "Stop"
Remove-ItemProperty -LiteralPath '${RUN_KEY}' -Name '${"O'Brien Updater".replace(/'/g, "''")}' -Force
`
};

// Pull the remaining inline scripts straight out of the sources so a newly
// added one cannot slip past this test.
for (const file of ['src/main/files.js', 'src/main/scanner.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const blocks = [...source.matchAll(/runPowerShell\((?:String\.raw)?`([\s\S]*?)`\)/g)].map((m) => m[1]);
  blocks.forEach((block, i) => { SCRIPTS[`${path.basename(file)} #${i + 1}`] = block; });
}

const PARSE_CHECK = `
$errors = $null
$tokens = $null
$text = Get-Content -Raw -LiteralPath $args[0]
[void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) {
  foreach ($e in $errors) { Write-Output ("line " + $e.Extent.StartLineNumber + ": " + $e.Message) }
} else {
  Write-Output "CLEAN"
}
`;

function parseCheck(script) {
  const target = path.join(os.tmpdir(), `hub-check-${process.pid}-${Math.random().toString(36).slice(2)}.ps1`);
  const checker = path.join(os.tmpdir(), `hub-checker-${process.pid}.ps1`);
  fs.writeFileSync(target, script, 'utf8');
  fs.writeFileSync(checker, PARSE_CHECK, 'utf8');
  try {
    return execFileSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', checker, target], { encoding: 'utf8', timeout: 60000 }).trim();
  } finally {
    try { fs.unlinkSync(target); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(checker); } catch (_) { /* ignore */ }
  }
}

for (const [name, script] of Object.entries(SCRIPTS)) {
  test(`${name} parses`, () => {
    const result = parseCheck(script);
    assert.strictEqual(result, 'CLEAN', `parser reported:\n       ${result}`);
  });
}

test('registry paths keep their backslashes', () => {
  assert.ok(gpu.STATIC_SCRIPT.includes('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\'),
    'the display class key lost its backslashes');
});

test('scripts are genuinely multi-line', () => {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    assert.ok(script.split('\n').length > 1, `${name} collapsed onto one line`);
  }
});

/* ----------------------------------------- serialisation round trip */

test('nested @() keeps a single counter row as an array', () => {
  const out = run(`
$eng = @([PSCustomObject]@{ Name='pid_5120_luid_0x00000000_0x0000C4B7_phys_0_eng_0_engtype_3D'; UtilizationPercentage=71.4 })
$mem = @([PSCustomObject]@{ Name='luid_0x00000000_0x0000C4B7_phys_0'; DedicatedUsage=8804600000; SharedUsage=412000000 })
[PSCustomObject]@{ engines = $eng; memory = $mem } | ConvertTo-Json -Compress -Depth 3
`);
  const parsed = JSON.parse(out.trim());
  assert.ok(Array.isArray(parsed.engines), 'engines collapsed to a bare object');
  const adapters = gpu.aggregate(parsed.engines, parsed.memory);
  assert.strictEqual(adapters.length, 1);
  assert.ok(Math.abs(adapters[0].load - 71.4) < 0.001);
  assert.strictEqual(adapters[0].memUsedBytes, 8804600000);
});

test('real ConvertTo-Json output drives the aggregation correctly', () => {
  const out = run(`
$eng = @(
  [PSCustomObject]@{ Name='pid_5120_luid_0x00000000_0x0000C4B7_phys_0_eng_0_engtype_3D'; UtilizationPercentage=61.5 }
  [PSCustomObject]@{ Name='pid_9184_luid_0x00000000_0x0000C4B7_phys_0_eng_1_engtype_3D'; UtilizationPercentage=25.5 }
  [PSCustomObject]@{ Name='pid_3312_luid_0x00000000_0x0000C4B7_phys_0_eng_4_engtype_VideoEncode'; UtilizationPercentage=12.0 }
)
$mem = @([PSCustomObject]@{ Name='luid_0x00000000_0x0000C4B7_phys_0'; DedicatedUsage=6000000000; SharedUsage=0 })
[PSCustomObject]@{ engines = $eng; memory = $mem } | ConvertTo-Json -Compress -Depth 3
`);
  const parsed = JSON.parse(out.trim());
  const adapters = gpu.aggregate(parsed.engines, parsed.memory);
  assert.strictEqual(adapters.length, 1);
  assert.ok(Math.abs(adapters[0].breakdown['3D'] - 87.0) < 0.001, 'the two 3D rows should sum to 87');
  assert.ok(Math.abs(adapters[0].load - 87.0) < 0.001, 'load should follow the busiest engine');
  assert.ok(Math.abs(adapters[0].breakdown['Video-Kodierung'] - 12.0) < 0.001);
});

test('a top-level pipe collapses one row, which the parsers must tolerate', () => {
  // This is why every caller normalises with Array.isArray(...) ? ... : [...].
  const out = run(`
@([PSCustomObject]@{ name='OneDrive'; value='"C:\\Users\\a\\OneDrive.exe" /background' }) | ConvertTo-Json -Compress
`);
  const parsed = JSON.parse(out.trim());
  assert.ok(!Array.isArray(parsed), 'expected the documented collapse to a bare object');
  const normalised = Array.isArray(parsed) ? parsed : [parsed];
  assert.strictEqual(normalised.length, 1);
  assert.strictEqual(normalised[0].name, 'OneDrive');
  assert.ok(normalised[0].value.includes('C:\\Users\\a\\OneDrive.exe'));
});

test('non-ASCII survives the UTF-8 output encoding', () => {
  const out = run(`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
@([PSCustomObject]@{ name='Größe'; value='Übermäßig lang – ok' }) | ConvertTo-Json -Compress
`);
  const parsed = JSON.parse(out.trim());
  assert.strictEqual(parsed.name, 'Größe');
  assert.ok(parsed.value.includes('Übermäßig'));
});

console.log(`\n${passed} assertions passed.`);
