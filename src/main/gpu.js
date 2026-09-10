'use strict';

const { runPowerShell } = require('./processes');

/**
 * Vendor-neutral GPU telemetry.
 *
 * The obvious route, systeminformation.graphics(), shells out to nvidia-smi
 * and therefore reports load and VRAM for NVIDIA cards only. AMD and Intel
 * come back with a model name and nothing else.
 *
 * Windows itself has the answer: since Windows 10 1709 the graphics kernel
 * publishes per-engine GPU counters, and Task Manager's own GPU column is
 * built on them. They cover every WDDM 2.0 driver, so AMD, Intel and NVIDIA
 * alike. They are read here through the WMI performance classes rather than
 * Get-Counter, because WMI class and property names are invariant English
 * while Get-Counter paths are localised ("GPU-Engine" / "Prozentsatz der
 * Auslastung" on a German install) and would break outside en-US.
 *
 * Temperature and fan speed have no such counter. Those still come from
 * nvidia-smi and stay empty on AMD and Intel unless a third-party sensor tool
 * is installed. That is a driver limitation, not something this module can
 * work around.
 */

const IS_WIN = process.platform === 'win32';

let si = null;
try {
  si = require('systeminformation');
} catch (_) { /* optional */ }

/* --------------------------------------------------------------- PowerShell */

// Static: adapter identity and true VRAM size. Refreshed rarely.
// String.raw keeps the registry path's backslashes intact; a plain template
// literal would silently swallow them.
const STATIC_SCRIPT = String.raw`
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$controllers = @(
  Get-CimInstance -ClassName Win32_VideoController |
    Select-Object Name, AdapterCompatibility, AdapterRAM, DriverVersion, VideoProcessor, PNPDeviceID
)

# AdapterRAM is a signed 32-bit field and saturates at 4 GB, so the real size
# comes from the display class registry keys instead.
$reg = @(
  Get-ChildItem "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}" |
    ForEach-Object {
      $p = Get-ItemProperty -LiteralPath $_.PSPath
      if ($p.DriverDesc) {
        $q = $p."HardwareInformation.qwMemorySize"
        if ($null -eq $q) { $q = $p."HardwareInformation.MemorySize" }
        if ($q -is [byte[]]) {
          $b = New-Object byte[] 8
          [Array]::Copy($q, $b, [Math]::Min(8, $q.Length))
          $q = [System.BitConverter]::ToInt64($b, 0)
        }
        [PSCustomObject]@{ desc = [string]$p.DriverDesc; vram = [int64]$q }
      }
    }
)

[PSCustomObject]@{ controllers = $controllers; registry = $reg } | ConvertTo-Json -Compress -Depth 4
`;

// Dynamic: engine utilisation and dedicated video memory, per adapter LUID.
// These WMI classes exist on Windows 10 1709 and newer with a WDDM 2.0 driver,
// and cover AMD, Intel and NVIDIA identically.
const SAMPLE_SCRIPT = String.raw`
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$eng = @(
  Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine |
    Where-Object { $_.Name -and $_.UtilizationPercentage -gt 0 } |
    Select-Object Name, UtilizationPercentage
)

$mem = @(
  Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory |
    Where-Object { $_.Name } |
    Select-Object Name, DedicatedUsage, SharedUsage
)

[PSCustomObject]@{ engines = $eng; memory = $mem } | ConvertTo-Json -Compress -Depth 3
`;

function parseJson(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch (_) { return null; }
}

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/* ------------------------------------------------------------ name parsing */

// e.g. pid_9184_luid_0x00000000_0x0000C4B7_phys_0_eng_3_engtype_3D
// Engine types carry underscores of their own (Graphics_1, Compute_0), so the
// trailing group must accept them or those names get truncated.
const ENGINE_RE = /luid_(0x[0-9a-f]+)_(0x[0-9a-f]+)_phys_(\d+)_eng_(\d+)_engtype_([A-Za-z0-9_]+)/i;
// e.g. luid_0x00000000_0x0000C4B7_phys_0
const MEMORY_RE = /luid_(0x[0-9a-f]+)_(0x[0-9a-f]+)_phys_(\d+)/i;

function engineKey(name) {
  const m = ENGINE_RE.exec(String(name || ''));
  if (!m) return null;
  return { luid: `${m[1]}_${m[2]}`, phys: Number(m[3]), engType: m[5] };
}

function memoryKey(name) {
  const m = MEMORY_RE.exec(String(name || ''));
  if (!m) return null;
  return { luid: `${m[1]}_${m[2]}`, phys: Number(m[3]) };
}

const ENGINE_LABELS = {
  '3D': '3D',
  Graphics_1: '3D',
  VideoDecode: 'Video-Dekodierung',
  VideoEncode: 'Video-Kodierung',
  VideoProcessing: 'Videoverarbeitung',
  Compute_0: 'Compute',
  Compute_1: 'Compute',
  Copy: 'Kopieren',
  Security: 'Sicherheit'
};

/* ------------------------------------------------------------------- state */

let staticCache = null;
let staticAt = 0;
let staticFailed = false;

let sensorCache = null;   // nvidia-smi derived temp/fan, refreshed slowly
let sensorAt = 0;

let counterSupported = null; // null = unknown, false = not available on this box
let lastResult = { supported: false, source: 'none', adapters: [], note: null };
let busy = false;

const STATIC_TTL = 5 * 60 * 1000;
const SENSOR_TTL = 20 * 1000;

/* ----------------------------------------------------------------- statics */

function isRealAdapter(name) {
  return !!name && !/^(Microsoft Basic Display|Microsoft Remote Display|RDP|DameWare|Citrix|VNC|Parsec)/i.test(name);
}

async function loadStatic() {
  if (!IS_WIN) return null;
  if (staticCache && Date.now() - staticAt < STATIC_TTL) return staticCache;
  if (staticFailed && Date.now() - staticAt < STATIC_TTL) return staticCache;

  try {
    const parsed = parseJson(await runPowerShell(STATIC_SCRIPT, 20000));
    if (!parsed) throw new Error('Keine Adapterdaten');

    const registry = asArray(parsed.registry);
    const controllers = asArray(parsed.controllers)
      .filter((c) => isRealAdapter(c.Name))
      .map((c, index) => {
        // Match the registry entry by driver description, which is the same
        // string Win32_VideoController reports as Name.
        const match = registry.find((r) => r.desc && c.Name && r.desc.trim() === String(c.Name).trim());
        const regVram = match && Number(match.vram) > 0 ? Number(match.vram) : 0;
        const wmiVram = Number(c.AdapterRAM) > 0 ? Number(c.AdapterRAM) : 0;
        return {
          index,
          model: c.Name,
          vendor: c.AdapterCompatibility || null,
          driver: c.DriverVersion || null,
          processor: c.VideoProcessor || null,
          // Prefer the registry value; AdapterRAM saturates at 4 GB.
          vramTotal: Math.max(regVram, wmiVram) || 0,
          vramFromRegistry: regVram > 0
        };
      });

    staticCache = { controllers };
    staticAt = Date.now();
    staticFailed = false;
    return staticCache;
  } catch (err) {
    staticFailed = true;
    staticAt = Date.now();
    return staticCache;
  }
}

/* ------------------------------------------------------------- temperature */

async function loadSensors() {
  if (!si) return null;
  if (sensorCache && Date.now() - sensorAt < SENSOR_TTL) return sensorCache;
  try {
    const graphics = await si.graphics();
    sensorCache = asArray(graphics && graphics.controllers).map((g) => ({
      model: g.model,
      vendor: g.vendor,
      temp: Number.isFinite(g.temperatureGpu) ? g.temperatureGpu : null,
      fan: Number.isFinite(g.fanSpeed) ? g.fanSpeed : null,
      load: Number.isFinite(g.utilizationGpu) ? g.utilizationGpu : null,
      memUsed: Number.isFinite(g.memoryUsed) ? g.memoryUsed : null,
      memTotal: Number.isFinite(g.memoryTotal) ? g.memoryTotal : null,
      vram: Number.isFinite(g.vram) ? g.vram : null
    }));
    sensorAt = Date.now();
    return sensorCache;
  } catch (_) {
    sensorAt = Date.now();
    return sensorCache;
  }
}

function matchSensor(sensors, adapter) {
  if (!sensors || !sensors.length) return null;
  if (sensors.length === 1) return sensors[0];
  const model = String(adapter.model || '').toLowerCase();
  return sensors.find((s) => String(s.model || '').toLowerCase() === model)
    || sensors.find((s) => model && String(s.model || '').toLowerCase().includes(model.slice(0, 12)))
    || null;
}

/* ------------------------------------------------------------------ sample */

/**
 * Pure aggregation of raw counter rows into one entry per adapter LUID.
 * Kept free of I/O so it can be tested against captured Windows data.
 */
function aggregate(engineRows, memoryRows) {
  const engines = asArray(engineRows);
  const memory = asArray(memoryRows);
  const byLuid = new Map();
  const ensure = (luid, phys) => {
    if (!byLuid.has(luid)) byLuid.set(luid, { luid, phys, engines: new Map(), dedicated: 0, shared: 0 });
    return byLuid.get(luid);
  };

  for (const row of engines) {
    const key = engineKey(row.Name);
    if (!key) continue;
    const entry = ensure(key.luid, key.phys);
    const value = Number(row.UtilizationPercentage) || 0;
    // Several processes drive the same engine type; their shares add up.
    entry.engines.set(key.engType, (entry.engines.get(key.engType) || 0) + value);
  }

  for (const row of memory) {
    const key = memoryKey(row.Name);
    if (!key) continue;
    const entry = ensure(key.luid, key.phys);
    entry.dedicated += Number(row.DedicatedUsage) || 0;
    entry.shared += Number(row.SharedUsage) || 0;
  }

  return Array.from(byLuid.values()).map((entry) => {
    const breakdown = {};
    let peak = 0;
    for (const [engType, value] of entry.engines) {
      const label = ENGINE_LABELS[engType] || engType;
      const capped = Math.min(100, value);
      breakdown[label] = Math.max(breakdown[label] || 0, capped);
      // Task Manager reports the busiest engine, not the sum of all of them,
      // because engines run in parallel on the same silicon.
      if (capped > peak) peak = capped;
    }
    return {
      luid: entry.luid,
      phys: entry.phys,
      load: peak,
      breakdown,
      memUsedBytes: entry.dedicated,
      memSharedBytes: entry.shared
    };
  });
}

async function readCounters() {
  if (!IS_WIN || counterSupported === false) return null;
  const parsed = parseJson(await runPowerShell(SAMPLE_SCRIPT, 20000, { background: true }));
  if (!parsed) {
    counterSupported = false;
    return null;
  }

  const engines = asArray(parsed.engines);
  const memory = asArray(parsed.memory);

  // A machine with no GPU activity legitimately reports zero engine rows, so
  // memory rows are the better signal that the counters exist at all.
  if (!engines.length && !memory.length) {
    if (counterSupported === null) counterSupported = false;
    return null;
  }
  counterSupported = true;

  return aggregate(engines, memory);
}

/**
 * With one GPU the mapping is exact. With several, LUIDs cannot be tied to
 * Win32_VideoController entries through any documented property, so pair them
 * by memory footprint: the counter group using the most dedicated memory
 * belongs to the adapter with the most VRAM.
 */
function pairAdapters(controllers, groups) {
  if (!groups || !groups.length) return controllers.map((c) => ({ ...c, counters: null }));
  if (controllers.length === 1) return [{ ...controllers[0], counters: groups[0] }];

  const remaining = groups.slice().sort((a, b) => b.memUsedBytes - a.memUsedBytes);
  const ordered = controllers.slice().sort((a, b) => b.vramTotal - a.vramTotal);
  const paired = new Map();
  ordered.forEach((controller, i) => paired.set(controller.index, remaining[i] || null));
  return controllers.map((c) => ({ ...c, counters: paired.get(c.index) || null, exactMatch: false }));
}

async function read() {
  if (busy) return lastResult;
  busy = true;
  try {
    if (!IS_WIN) {
      lastResult = { supported: false, source: 'none', adapters: [], note: 'GPU-Telemetrie ist nur unter Windows verfügbar.' };
      return lastResult;
    }

    const [statics, groups, sensors] = await Promise.all([
      loadStatic(),
      readCounters().catch(() => null),
      loadSensors()
    ]);

    const controllers = (statics && statics.controllers) || [];

    // No adapters from WMI at all: fall back entirely to systeminformation.
    if (!controllers.length) {
      const adapters = (sensors || []).map((s, index) => ({
        index,
        model: s.model,
        vendor: s.vendor,
        load: s.load,
        breakdown: null,
        memUsed: s.memUsed != null ? s.memUsed * 1024 * 1024 : null,
        memTotal: (s.memTotal != null ? s.memTotal : s.vram) != null
          ? (s.memTotal != null ? s.memTotal : s.vram) * 1024 * 1024 : null,
        temp: s.temp,
        fan: s.fan,
        loadSource: s.load != null ? 'nvidia-smi' : null
      }));
      lastResult = {
        supported: adapters.length > 0,
        source: 'si',
        adapters,
        note: adapters.length ? null : 'Keine Grafikkarte erkannt.'
      };
      return lastResult;
    }

    const merged = pairAdapters(controllers, groups).map((entry) => {
      const sensor = matchSensor(sensors, entry);
      const counters = entry.counters;

      const load = counters && counters.load != null
        ? counters.load
        : (sensor && sensor.load != null ? sensor.load : null);

      const memUsed = counters && counters.memUsedBytes > 0
        ? counters.memUsedBytes
        : (sensor && sensor.memUsed != null ? sensor.memUsed * 1024 * 1024 : null);

      const memTotal = entry.vramTotal > 0
        ? entry.vramTotal
        : (sensor && sensor.memTotal != null ? sensor.memTotal * 1024 * 1024 : null);

      return {
        index: entry.index,
        model: entry.model,
        vendor: entry.vendor,
        driver: entry.driver,
        load,
        breakdown: counters ? counters.breakdown : null,
        memUsed,
        memShared: counters ? counters.memSharedBytes : null,
        memTotal,
        temp: sensor ? sensor.temp : null,
        fan: sensor ? sensor.fan : null,
        loadSource: counters && counters.load != null
          ? 'counters'
          : (sensor && sensor.load != null ? 'nvidia-smi' : null),
        tempSource: sensor && sensor.temp != null ? 'nvidia-smi' : null
      };
    });

    // Busiest adapter first: on a laptop that is the discrete card under load.
    merged.sort((a, b) => (b.load || 0) - (a.load || 0) || (b.memTotal || 0) - (a.memTotal || 0));

    const anyLoad = merged.some((a) => a.load != null);
    lastResult = {
      supported: true,
      source: counterSupported ? 'counters' : (anyLoad ? 'si' : 'partial'),
      adapters: merged,
      note: anyLoad ? null
        : 'Die Windows-GPU-Zähler liefern keine Werte. Sie brauchen Windows 10 ab Version 1709 und einen WDDM-2.0-Treiber.'
    };
    return lastResult;
  } finally {
    busy = false;
  }
}

function reset() {
  staticCache = null;
  staticAt = 0;
  staticFailed = false;
  sensorCache = null;
  sensorAt = 0;
  counterSupported = null;
}

module.exports = {
  read,
  reset,
  ENGINE_LABELS,
  // Exported for tests: pure, no I/O.
  aggregate,
  pairAdapters,
  engineKey,
  memoryKey,
  STATIC_SCRIPT,
  SAMPLE_SCRIPT
};
