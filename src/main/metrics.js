'use strict';

const os = require('os');

/**
 * Two-tier metrics collector.
 *
 * Tier 1 (fast, ~1s): pure Node built-ins. CPU deltas and memory cost
 * essentially nothing, so the hub does not distort the numbers it displays.
 * Tier 2 (slow, ~5s): systeminformation. On Windows these calls shell out to
 * PowerShell/WMI and are expensive, so they run sequentially, never overlap,
 * and are skipped entirely while nothing is subscribed.
 */

let si = null;
try {
  si = require('systeminformation');
} catch (err) {
  console.warn('[metrics] systeminformation unavailable:', err.message);
}

let prevCpu = null;
let fastTimer = null;
let slowTimer = null;
let slowBusy = false;
let subscribers = 0;
let onSample = () => {};

const slow = {
  disks: [],
  diskIO: null,
  net: null,
  gpu: [],
  cpuTemp: null,
  battery: null,
  updatedAt: 0
};

let staticInfo = null;

function cpuTimes() {
  return os.cpus().map((c) => {
    const t = c.times;
    const idle = t.idle;
    const total = t.user + t.nice + t.sys + t.irq + t.idle;
    return { idle, total };
  });
}

function sampleCpu() {
  const now = cpuTimes();
  if (!prevCpu || prevCpu.length !== now.length) {
    prevCpu = now;
    return { total: 0, cores: now.map(() => 0) };
  }
  const cores = now.map((c, i) => {
    const dIdle = c.idle - prevCpu[i].idle;
    const dTotal = c.total - prevCpu[i].total;
    if (dTotal <= 0) return 0;
    return Math.min(100, Math.max(0, ((dTotal - dIdle) / dTotal) * 100));
  });
  prevCpu = now;
  const total = cores.reduce((a, b) => a + b, 0) / (cores.length || 1);
  return { total, cores };
}

function sampleMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return { total, free, used, percent: total ? (used / total) * 100 : 0 };
}

function fastSample() {
  const cpu = sampleCpu();
  const mem = sampleMemory();
  return {
    ts: Date.now(),
    cpu,
    mem,
    uptime: os.uptime(),
    slow
  };
}

async function safe(fn, fallback) {
  if (!si) return fallback;
  try {
    return await fn();
  } catch (err) {
    return fallback;
  }
}

async function collectSlow({ includeGpu = true } = {}) {
  if (slowBusy || !si) return;
  slowBusy = true;
  try {
    const fsSize = await safe(() => si.fsSize(), []);
    slow.disks = (fsSize || [])
      .filter((d) => d && d.size > 0)
      .map((d) => ({
        fs: d.fs,
        mount: d.mount,
        type: d.type,
        size: d.size,
        used: d.used,
        available: d.available,
        percent: d.use != null ? d.use : (d.size ? (d.used / d.size) * 100 : 0)
      }));

    const io = await safe(() => si.disksIO(), null);
    if (io) {
      slow.diskIO = {
        readBytesPerSec: io.rIO_sec != null ? io.rIO_sec : null,
        writeBytesPerSec: io.wIO_sec != null ? io.wIO_sec : null,
        readOps: io.rIO,
        writeOps: io.wIO
      };
    }

    const net = await safe(() => si.networkStats(), []);
    if (Array.isArray(net) && net.length) {
      const primary = net.reduce((a, b) => ((b.rx_sec || 0) + (b.tx_sec || 0) > (a.rx_sec || 0) + (a.tx_sec || 0) ? b : a));
      slow.net = {
        iface: primary.iface,
        rxSec: Math.max(0, primary.rx_sec || 0),
        txSec: Math.max(0, primary.tx_sec || 0),
        rxTotal: primary.rx_bytes,
        txTotal: primary.tx_bytes
      };
    }

    if (includeGpu) {
      const graphics = await safe(() => si.graphics(), null);
      if (graphics && Array.isArray(graphics.controllers)) {
        slow.gpu = graphics.controllers.map((g) => ({
          model: g.model,
          vendor: g.vendor,
          vram: g.vram,
          memUsed: g.memoryUsed,
          memTotal: g.memoryTotal,
          load: g.utilizationGpu,
          temp: g.temperatureGpu,
          fanSpeed: g.fanSpeed
        }));
      }
    }

    const temp = await safe(() => si.cpuTemperature(), null);
    if (temp && temp.main != null && !Number.isNaN(temp.main)) slow.cpuTemp = temp.main;

    const bat = await safe(() => si.battery(), null);
    if (bat && bat.hasBattery) {
      slow.battery = { percent: bat.percent, charging: bat.isCharging, timeRemaining: bat.timeRemaining };
    } else {
      slow.battery = null;
    }

    slow.updatedAt = Date.now();
  } finally {
    slowBusy = false;
  }
}

async function getStaticInfo() {
  if (staticInfo) return staticInfo;
  const base = {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cores: os.cpus().length,
    cpuModel: (os.cpus()[0] || {}).model || 'Unknown CPU',
    totalMem: os.totalmem()
  };
  const osInfo = await safe(() => si.osInfo(), null);
  const cpu = await safe(() => si.cpu(), null);
  const mem = await safe(() => si.memLayout(), null);
  const board = await safe(() => si.baseboard(), null);
  staticInfo = {
    ...base,
    distro: osInfo ? `${osInfo.distro} ${osInfo.release}` : `${base.platform} ${base.release}`,
    build: osInfo ? osInfo.build : null,
    cpuBrand: cpu ? `${cpu.manufacturer} ${cpu.brand}`.trim() : base.cpuModel,
    cpuSpeed: cpu ? cpu.speed : null,
    physicalCores: cpu ? cpu.physicalCores : null,
    memoryModules: Array.isArray(mem)
      ? mem.filter((m) => m.size > 0).map((m) => ({ size: m.size, type: m.type, speed: m.clockSpeed, bank: m.bank }))
      : [],
    board: board ? `${board.manufacturer} ${board.model}`.trim() : null
  };
  return staticInfo;
}

function start(handler, opts = {}) {
  onSample = typeof handler === 'function' ? handler : () => {};
  const fastMs = Math.max(250, opts.fastMs || 1000);
  const slowMs = Math.max(2000, opts.slowMs || 5000);
  stop();
  sampleCpu(); // prime the delta
  fastTimer = setInterval(() => {
    if (subscribers <= 0) return;
    try { onSample(fastSample()); } catch (err) { console.error('[metrics]', err.message); }
  }, fastMs);
  slowTimer = setInterval(() => {
    if (subscribers <= 0) return;
    collectSlow({ includeGpu: opts.includeGpu !== false });
  }, slowMs);
  collectSlow({ includeGpu: opts.includeGpu !== false });
}

function stop() {
  if (fastTimer) clearInterval(fastTimer);
  if (slowTimer) clearInterval(slowTimer);
  fastTimer = null;
  slowTimer = null;
}

function subscribe() { subscribers += 1; return subscribers; }
function unsubscribe() { subscribers = Math.max(0, subscribers - 1); return subscribers; }

module.exports = { start, stop, subscribe, unsubscribe, fastSample, collectSlow, getStaticInfo, slow };
