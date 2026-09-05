import { el, clear, bytes, bytesPerSec, pct, severity } from './util.js';

/**
 * Entry point for a floating overlay window.
 *
 * The window's type comes from its own URL, never from a message, so an
 * overlay can only ever render and close itself.
 */

const bridge = window.hub;
const params = new URLSearchParams(location.search);
const type = params.get('type') || 'combo';

const root = document.getElementById('overlay-root');
const content = root.querySelector('.ov-content');

root.querySelector('.ov-close').addEventListener('click', () => {
  if (bridge && bridge.overlay) bridge.overlay.close().catch(() => {});
});

/* ------------------------------------------------------------ mini sparkline */

class Spark {
  constructor(canvas, { color = '#00f0ff', color2 = null, capacity = 60, max = 100, autoScale = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = color;
    this.color2 = color2;
    this.capacity = capacity;
    this.max = max;
    this.autoScale = autoScale;
    this.a = [];
    this.b = [];
    this._resize = this._resize.bind(this);
    new ResizeObserver(this._resize).observe(canvas);
    this._resize();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
    this.draw();
  }

  push(a, b) {
    if (!this.a.length) this.a = new Array(this.capacity - 1).fill(0);
    this.a.push(Number(a) || 0);
    if (this.a.length > this.capacity) this.a.shift();
    if (b !== undefined) {
      if (!this.b.length) this.b = new Array(this.capacity - 1).fill(0);
      this.b.push(Number(b) || 0);
      if (this.b.length > this.capacity) this.b.shift();
    }
    this.draw();
  }

  _line(data, color, peak) {
    if (data.length < 2) return;
    const { ctx, w, h } = this;
    const step = w / (this.capacity - 1);
    const y = (v) => h - (Math.min(v, peak) / peak) * (h - 2) - 1;

    ctx.beginPath();
    ctx.moveTo(0, y(data[0]));
    for (let i = 1; i < data.length; i += 1) ctx.lineTo(i * step, y(data[i]));
    ctx.lineTo((data.length - 1) * step, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, `${color}55`);
    gradient.addColorStop(1, `${color}05`);
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(0, y(data[0]));
    for (let i = 1; i < data.length; i += 1) ctx.lineTo(i * step, y(data[i]));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  draw() {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    const peak = this.autoScale
      ? Math.max(Math.max(0, ...this.a, ...this.b) * 1.25, 1)
      : this.max;
    if (this.color2 && this.b.length) this._line(this.b, this.color2, peak);
    this._line(this.a, this.color, peak);
  }
}

/* ------------------------------------------------------------- view builders */

function headed(title) {
  const value = el('span', { class: 'ov-value', text: '--' });
  const unit = el('span', { class: 'ov-unit', text: '' });
  const sub = el('div', { class: 'ov-sub', text: '' });
  const canvas = el('canvas', { class: 'ov-graph' });
  const node = el('div', { class: 'ov-content-inner' }, [
    el('div', { class: 'ov-head' }, [
      el('span', { class: 'ov-title', text: title }),
      sub
    ]),
    el('div', {}, [value, unit]),
    canvas
  ]);
  node.style.display = 'flex';
  node.style.flexDirection = 'column';
  node.style.gap = '5px';
  node.style.height = '100%';
  return { node, value, unit, sub, canvas };
}

function buildCpu() {
  const ui = headed('CPU');
  content.appendChild(ui.node);
  const spark = new Spark(ui.canvas, { color: '#00f0ff' });
  return (sample) => {
    const total = sample.cpu ? sample.cpu.total : 0;
    ui.value.textContent = total.toFixed(0);
    ui.value.className = `ov-value ${severity(total)}`;
    ui.unit.textContent = '%';
    const temp = sample.slow && sample.slow.cpuTemp;
    const cores = (sample.cpu && sample.cpu.cores) || [];
    ui.sub.textContent = temp != null
      ? `${temp.toFixed(0)}°C · ${cores.length}C`
      : `${cores.length} Kerne`;
    spark.push(total);
  };
}

function buildRam() {
  const ui = headed('RAM');
  content.appendChild(ui.node);
  const spark = new Spark(ui.canvas, { color: '#ff2e88' });
  return (sample) => {
    const mem = sample.mem || {};
    ui.value.textContent = (mem.percent || 0).toFixed(0);
    ui.value.className = `ov-value ${severity(mem.percent)}`;
    ui.unit.textContent = '%';
    ui.sub.textContent = `${bytes(mem.used)} / ${bytes(mem.total)}`;
    spark.push(mem.percent || 0);
  };
}

function buildGpu() {
  const ui = headed('GPU');
  content.appendChild(ui.node);
  const spark = new Spark(ui.canvas, { color: '#26e08a' });
  return (sample) => {
    const gpu = ((sample.slow && sample.slow.gpu) || [])[0];
    if (!gpu || gpu.load == null) {
      ui.value.textContent = '--';
      ui.value.className = 'ov-value';
      ui.unit.textContent = '';
      ui.sub.textContent = gpu ? 'keine Telemetrie' : 'keine GPU';
      return;
    }
    ui.value.textContent = Math.round(gpu.load);
    ui.value.className = `ov-value ${severity(gpu.load)}`;
    ui.unit.textContent = '%';
    const parts = [];
    if (gpu.temp != null) parts.push(`${gpu.temp}°C`);
    if (gpu.memTotal) parts.push(`${Math.round(gpu.memUsed || 0)}/${Math.round(gpu.memTotal)}MB`);
    ui.sub.textContent = parts.join(' · ') || (gpu.model || '');
    spark.push(gpu.load);
  };
}

function buildNet() {
  const ui = headed('NETZ');
  content.appendChild(ui.node);
  const spark = new Spark(ui.canvas, { color: '#26e08a', color2: '#ffb400', autoScale: true });
  return (sample) => {
    const net = sample.slow && sample.slow.net;
    if (!net) { ui.value.textContent = '--'; ui.sub.textContent = 'keine Daten'; return; }
    ui.value.textContent = bytes(net.rxSec, 1).replace(/ .*/, '');
    ui.unit.textContent = `${bytes(net.rxSec, 1).split(' ')[1] || 'B'}/s ↓`;
    ui.sub.textContent = `↑ ${bytesPerSec(net.txSec)}`;
    spark.push(net.rxSec, net.txSec);
  };
}

function buildDisk() {
  const ui = headed('DATENTRÄGER');
  content.appendChild(ui.node);
  const spark = new Spark(ui.canvas, { color: '#8b5cf6', color2: '#4d9fff', autoScale: true });
  return (sample) => {
    const io = sample.slow && sample.slow.diskIO;
    if (!io) { ui.value.textContent = '--'; ui.sub.textContent = 'keine Daten'; return; }
    const read = io.readBytesPerSec || 0;
    const write = io.writeBytesPerSec || 0;
    ui.value.textContent = bytes(read, 1).replace(/ .*/, '');
    ui.unit.textContent = `${bytes(read, 1).split(' ')[1] || 'B'}/s R`;
    ui.sub.textContent = `W ${bytesPerSec(write)}`;
    spark.push(read, write);
  };
}

function buildCombo() {
  const rows = new Map();
  const host = el('div', { class: 'ov-rows' });

  for (const [key, label] of [['cpu', 'CPU'], ['ram', 'RAM'], ['gpu', 'GPU'], ['net', 'NET']]) {
    const bar = el('div', { class: 'ov-bar' }, [el('i')]);
    const num = el('span', { class: 'ov-num', text: '--' });
    host.appendChild(el('div', { class: 'ov-row' }, [
      el('span', { class: 'ov-key', text: label }),
      bar,
      num
    ]));
    rows.set(key, { bar, fill: bar.querySelector('i'), num });
  }

  content.appendChild(el('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '6px', height: '100%', justifyContent: 'center' }
  }, [
    el('div', { class: 'ov-title', text: 'Leistung' }),
    host
  ]));

  const setRow = (key, percent, text) => {
    const row = rows.get(key);
    if (!row) return;
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    row.fill.style.width = `${clamped}%`;
    row.bar.className = `ov-bar ${severity(clamped)}`;
    row.num.textContent = text;
  };

  return (sample) => {
    const cpu = sample.cpu ? sample.cpu.total : 0;
    const mem = sample.mem || {};
    setRow('cpu', cpu, pct(cpu, 0));
    setRow('ram', mem.percent, pct(mem.percent, 0));

    const gpu = ((sample.slow && sample.slow.gpu) || [])[0];
    if (gpu && gpu.load != null) setRow('gpu', gpu.load, pct(gpu.load, 0));
    else setRow('gpu', 0, '--');

    const net = sample.slow && sample.slow.net;
    if (net) {
      // The bar is scaled against 100 Mbit/s so it stays meaningful on a
      // typical home line rather than pinning at 100% on any transfer.
      const share = (net.rxSec / (12.5 * 1024 * 1024)) * 100;
      setRow('net', share, bytes(net.rxSec, 0).replace(' ', ''));
    } else {
      setRow('net', 0, '--');
    }
  };
}

const BUILDERS = {
  cpu: buildCpu,
  ram: buildRam,
  gpu: buildGpu,
  net: buildNet,
  disk: buildDisk,
  combo: buildCombo
};

/* -------------------------------------------------------------------- boot */

function start() {
  clear(content);
  const builder = BUILDERS[type];
  if (!builder) {
    content.appendChild(el('div', { class: 'ov-empty', text: `Unbekannt: ${type}` }));
    return;
  }
  const update = builder();

  if (!bridge || !bridge.metrics) {
    content.appendChild(el('div', { class: 'ov-empty', text: 'Keine Verbindung' }));
    return;
  }

  bridge.metrics.onSample((sample) => {
    try { update(sample); } catch (err) { console.error('[overlay]', err); }
  });

  // Fill in immediately instead of waiting a full tick.
  bridge.metrics.snapshot()
    .then((res) => { if (res && res.ok) update(res.data); })
    .catch(() => {});
}

start();
