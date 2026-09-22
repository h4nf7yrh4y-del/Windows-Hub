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
const tweaks = require('../src/main/tweaks');
const network = require('../src/main/network');
const media = require('../src/main/media');

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

/* --------------------------- catalogue-driven and templated scripts ------ */

const winfeatures = require('../src/main/winfeatures');

// Both the state read and every write are assembled from the catalogue, so a
// badly quoted entry would only surface as an empty result at runtime.
{
  const readable = winfeatures.CATALOGUE
    .filter((e) => e.control && (e.control.kind === 'toggle' || e.control.kind === 'choice'));

  const lines = readable.map((e) => {
    const c = e.control;
    return `  [PSCustomObject]@{ id = '${winfeatures.esc(e.id)}'; value = (Get-ItemProperty -LiteralPath '${winfeatures.esc(c.path)}' -Name '${winfeatures.esc(c.name)}' -ErrorAction SilentlyContinue).'${winfeatures.esc(c.name)}' }`;
  });

  SCRIPTS['feature state read'] = `
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$values = @(
${lines.join('\n')}
)

$plans = @(Get-CimInstance -Namespace root\\cimv2\\power -ClassName Win32_PowerPlan |
  Select-Object ElementName, InstanceID, IsActive)

$classic = Test-Path -LiteralPath '${winfeatures.esc(winfeatures.CLASSIC_MENU_PATH)}'

[PSCustomObject]@{ values = $values; plans = $plans; classic = $classic } | ConvertTo-Json -Compress -Depth 4
`;

  // Every writable entry produces its own script; a single bad path or an
  // unescaped quote anywhere in the catalogue fails the parse.
  for (const entry of readable) {
    const c = entry.control;
    const value = c.kind === 'choice' ? c.options[0].value : c.on;
    SCRIPTS[`feature write: ${entry.id}`] = `
$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath '${winfeatures.esc(c.path)}')) { New-Item -Path '${winfeatures.esc(c.path)}' -Force | Out-Null }
Set-ItemProperty -LiteralPath '${winfeatures.esc(c.path)}' -Name '${winfeatures.esc(c.name)}' -Value ${winfeatures.regValue(c, value)} -Type ${winfeatures.regType(c)} -Force
`;
  }

  // Standalone actions carry raw scripts of their own.
  for (const [name, action] of Object.entries(winfeatures.ACTIONS)) {
    SCRIPTS[`feature action: ${name}`] = action.script;
  }
}

/* -------------------------------------------------- profile system tweaks -- */

// Process names come from the user, so the quoting is the part worth proving.
SCRIPTS['tweaks: power plans'] = tweaks.PLANS_SCRIPT;
SCRIPTS['tweaks: set power plan'] = tweaks.setPowerPlanScript('8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c');
SCRIPTS['tweaks: close apps'] = tweaks.closeScript(['chrome', 'Teams', "O'Brien Sync", 'Grüße']);
SCRIPTS['tweaks: restart apps'] = tweaks.restartScript([
  { path: String.raw`C:\Program Files\Google\Chrome\chrome.exe` },
  { path: String.raw`C:\Users\O'Brien\App\run.exe` }
]);
SCRIPTS['tweaks: find pid'] = tweaks.NAME_TO_PID_SCRIPT("O'Brien");
SCRIPTS['network: connections'] = network.CONNECTION_SCRIPT;

// WinRT from PowerShell is the least testable corner of this project: the API
// exists only on Windows and only in Windows PowerShell. The parser is the one
// thing that can be checked anywhere, and a typo here would surface as "no
// media playing" rather than as an error.
// winget no longer runs through PowerShell at all: it is spawned directly,
// because a listing can take ninety seconds and the host has one pipe.
SCRIPTS['media: read session'] = media.READ_SCRIPT;
for (const [name, method] of Object.entries(media.COMMANDS)) {
  SCRIPTS[`media: ${name}`] = media.commandScript(method);
}

test('every writable entry stays inside HKCU unless it asks for elevation', () => {
  for (const entry of winfeatures.CATALOGUE) {
    const c = entry.control;
    if (!c || !c.path) continue;
    if (c.elevated) continue;
    assert.ok(/^HKCU:/i.test(c.path), `${entry.id} writes to ${c.path} without elevation`);
  }
});

test('elevated entries are the only ones outside HKCU', () => {
  const outside = winfeatures.CATALOGUE
    .filter((e) => e.control && e.control.path && !/^HKCU:/i.test(e.control.path));
  assert.ok(outside.length > 0, 'expected at least one system-wide entry');
  for (const entry of outside) {
    assert.ok(entry.control.elevated, `${entry.id} is outside HKCU but not marked elevated`);
  }
});

test('choice options are unique and non-empty', () => {
  for (const entry of winfeatures.CATALOGUE) {
    const c = entry.control;
    if (!c || c.kind !== 'choice') continue;
    assert.ok(c.options.length >= 2, `${entry.id} has fewer than two options`);
    const values = c.options.map((o) => String(o.value));
    assert.strictEqual(new Set(values).size, values.length, `${entry.id} has duplicate option values`);
  }
});

// The display helper is loaded by a preamble that compiles C# on first use.
SCRIPTS['audio helper preamble'] = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not ('HubAudio' -as [type])) {
  if (Test-Path -LiteralPath 'C:\\Users\\a\\HubAudio.dll') {
    try { Add-Type -Path 'C:\\Users\\a\\HubAudio.dll' } catch { }
  }
}
if (-not ('HubAudio' -as [type])) {
  $src = Get-Content -Raw -LiteralPath 'C:\\Users\\a\\HubAudio.cs'
  try {
    Add-Type -TypeDefinition $src -OutputAssembly 'C:\\Users\\a\\HubAudio.dll'
    Add-Type -Path 'C:\\Users\\a\\HubAudio.dll'
  } catch {
    Add-Type -TypeDefinition $src
  }
}
[HubAudio]::List()
`;

SCRIPTS['display helper preamble'] = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not ('HubDisplay' -as [type])) {
  if (Test-Path -LiteralPath 'C:\\Users\\a\\HubDisplay.dll') {
    try { Add-Type -Path 'C:\\Users\\a\\HubDisplay.dll' } catch { }
  }
}
if (-not ('HubDisplay' -as [type])) {
  $src = Get-Content -Raw -LiteralPath 'C:\\Users\\a\\HubDisplay.cs'
  try {
    Add-Type -TypeDefinition $src -OutputAssembly 'C:\\Users\\a\\HubDisplay.dll'
    Add-Type -Path 'C:\\Users\\a\\HubDisplay.dll'
  } catch {
    Add-Type -TypeDefinition $src
  }
}
[HubDisplay]::List($true) | ConvertTo-Json -Compress -Depth 4
`;

/**
 * Several scripts are JavaScript templates. The interpolations are replaced
 * with values of the right shape so PowerShell sees a realistic script rather
 * than a literal `${...}`, which is not valid syntax in any language.
 */
function fillPlaceholders(block) {
  let out = block.replace(/\$\{preamble\(paths\)\}/g, '');
  // Interpolations nest, so the innermost are replaced first and the pass is
  // repeated until none are left.
  for (let pass = 0; pass < 8 && out.includes('${'); pass += 1) {
    out = out.replace(/\$\{[^{}]*\}/g, (match) => (
      // Anything naming a path, device or identifier stands in as a string;
      // everything else is treated as a number.
      /psLiteral|device|path|name|target|entry|spec|args/i.test(match)
        ? "'PLACEHOLDER'"
        : '50'
    ));
  }
  return out;
}

// Pull the inline scripts straight out of the sources so a newly added one
// cannot slip past this test.
for (const file of [
  'src/main/files.js',
  'src/main/scanner.js',
  'src/main/winfeatures.js',
  'src/main/display.js',
  'src/main/windowlayout.js'
]) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const blocks = [...source.matchAll(/runPowerShell\(\s*(?:String\.raw)?`([\s\S]*?)`/g)].map((m) => m[1]);
  blocks.forEach((block, i) => {
    SCRIPTS[`${path.basename(file)} #${i + 1}`] = fillPlaceholders(block);
  });
}

/* ------------------------------------------------ native helper compiles */

test('the C# display helper compiles', () => {
  // DllImport targets do not exist off Windows, but the compiler still has to
  // accept the source. A typo here would otherwise only surface at runtime.
  const csPath = path.join(__dirname, '..', 'src/main/ps/display.cs.txt');
  const checker = path.join(os.tmpdir(), `hub-cs-${process.pid}.ps1`);
  fs.writeFileSync(checker, `
$src = Get-Content -Raw -LiteralPath $args[0]
try {
  Add-Type -TypeDefinition $src -ErrorAction Stop
  $methods = ([HubDisplay].GetMethods('Public,Static,DeclaredOnly') | ForEach-Object { $_.Name }) -join ','
  Write-Output "COMPILED:$methods"
} catch {
  Write-Output ("FAILED: " + $_.Exception.Message)
}
`, 'utf8');
  try {
    const result = execFileSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', checker, csPath],
      { encoding: 'utf8', timeout: 120000 }).trim();
    assert.ok(result.startsWith('COMPILED'), `compiler said:\n       ${result}`);
    for (const method of ['List', 'SetMode', 'SetPrimary', 'GetBrightness', 'SetBrightness']) {
      assert.ok(result.includes(method), `missing method ${method}`);
    }
  } finally {
    try { fs.unlinkSync(checker); } catch (_) { /* ignore */ }
  }
});

test('the C# window helper compiles', () => {
  // Two callbacks marshalled into native code, one of them taking a struct by
  // reference. Get the delegate signature wrong and it compiles anyway, then
  // corrupts the stack at runtime -- so the compiler is the cheap half of the
  // check, and the enumeration returning anything at all is the other.
  const csPath = path.join(__dirname, '..', 'src/main/ps/windows.cs.txt');
  const checker = path.join(os.tmpdir(), `hub-cs-windows-${process.pid}.ps1`);
  fs.writeFileSync(checker, `
$src = Get-Content -Raw -LiteralPath $args[0]
try {
  Add-Type -TypeDefinition $src -ErrorAction Stop
  $methods = ([HubWindows].GetMethods('Public,Static,DeclaredOnly') | ForEach-Object { $_.Name }) -join ','
  Write-Output "COMPILED:$methods"
} catch {
  Write-Output ("FAILED: " + $_.Exception.Message)
}
`, 'utf8');
  try {
    const result = execFileSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', checker, csPath],
      { encoding: 'utf8', timeout: 120000 }).trim();
    assert.ok(result.startsWith('COMPILED'), `compiler said:\n       ${result}`);
    for (const method of ['List', 'Monitors', 'Move']) {
      assert.ok(result.includes(method), `missing method ${method}`);
    }
  } finally {
    try { fs.unlinkSync(checker); } catch (_) { /* ignore */ }
  }
});

test('the C# audio helper compiles', () => {
  // The COM interfaces here are hand-written declarations of an interface
  // Microsoft never documented. A wrong GUID or a method in the wrong slot
  // compiles fine and fails at runtime with a bare HRESULT, so the compiler
  // is only the first of two checks -- but it is the one that can run at all.
  const csPath = path.join(__dirname, '..', 'src/main/ps/audio.cs.txt');
  const checker = path.join(os.tmpdir(), `hub-cs-audio-${process.pid}.ps1`);
  fs.writeFileSync(checker, `
$src = Get-Content -Raw -LiteralPath $args[0]
try {
  Add-Type -TypeDefinition $src -ErrorAction Stop
  $methods = ([HubAudio].GetMethods('Public,Static,DeclaredOnly') | ForEach-Object { $_.Name }) -join ','
  Write-Output "COMPILED:$methods"
} catch {
  Write-Output ("FAILED: " + $_.Exception.Message)
}
`, 'utf8');
  try {
    const result = execFileSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', checker, csPath],
      { encoding: 'utf8', timeout: 120000 }).trim();
    assert.ok(result.startsWith('COMPILED'), `compiler said:\n       ${result}`);
    for (const method of ['List', 'Current', 'SetDefault']) {
      assert.ok(result.includes(method), `missing method ${method}`);
    }
  } finally {
    try { fs.unlinkSync(checker); } catch (_) { /* ignore */ }
  }
});

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

// The close/restart pair hands its result back as JSON, and the empty case is
// the one that used to break: a pipeline collapses an empty array to nothing,
// which the Node side would then read as "unparsable" instead of "nothing ran".
test('closing nothing yields an empty JSON array, not empty output', () => {
  const out = run(tweaks.closeScript(['gibt-es-sicher-nicht-zzz'])).trim();
  assert.strictEqual(out, '[]');
  assert.deepStrictEqual(JSON.parse(out), []);
});

test('restarting nothing yields an empty JSON array too', () => {
  const out = run(tweaks.restartScript([{ path: '/gibt/es/nicht/zzz' }])).trim();
  assert.strictEqual(out, '[]');
});

test('registry paths keep their backslashes', () => {
  assert.ok(gpu.STATIC_SCRIPT.includes('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\'),
    'the display class key lost its backslashes');
});

// The original bug this file was written for was fragments joined with an
// empty string, leaving several statements on one line with no separator.
// No separate assertion is needed for it: PowerShell's parser rejects exactly
// that, and every script above is run through the parser. A line-length
// heuristic only produced false alarms on legitimately long single statements.

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
