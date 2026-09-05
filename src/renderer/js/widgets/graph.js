import { hexToRgba } from '../util.js';

/**
 * Canvas time-series graph: filled area, glow line, grid, optional second
 * series. Kept on canvas rather than SVG because these redraw once a second
 * for the whole session and DOM churn is not free.
 */
export class Graph {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.capacity = options.capacity || 90;
    this.max = options.max ?? 100;
    this.autoScale = options.autoScale || false;
    this.color = options.color || '#00f0ff';
    this.color2 = options.color2 || null;
    this.fill = options.fill !== false;
    this.grid = options.grid !== false;
    this.series = [];
    this.series2 = [];
    this._resize = this._resize.bind(this);
    this._observer = new ResizeObserver(this._resize);
    this._observer.observe(canvas);
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

  setColor(color, color2) {
    this.color = color || this.color;
    if (color2 !== undefined) this.color2 = color2;
  }

  push(value, value2) {
    // Prefill with zeros on the first sample so the graph reads left-to-right
    // from the start instead of drawing a stub in the right-hand corner.
    if (!this.series.length) this.series = new Array(this.capacity - 1).fill(0);
    this.series.push(Number(value) || 0);
    if (this.series.length > this.capacity) this.series.shift();

    if (value2 !== undefined) {
      if (!this.series2.length) this.series2 = new Array(this.capacity - 1).fill(0);
      this.series2.push(Number(value2) || 0);
      if (this.series2.length > this.capacity) this.series2.shift();
    }
    this.draw();
  }

  reset() {
    this.series = [];
    this.series2 = [];
    this.draw();
  }

  _peak() {
    if (!this.autoScale) return this.max;
    const all = this.series.concat(this.series2);
    const peak = all.length ? Math.max(...all) : 0;
    // Never collapse the scale to zero while the buffer is still all prefill.
    return Math.max(peak * 1.25, 1);
  }

  _drawSeries(data, color, peak) {
    if (data.length < 2) return;
    const { ctx, w, h } = this;
    const step = w / (this.capacity - 1);
    const offset = w - (data.length - 1) * step;
    const y = (v) => h - (Math.min(v, peak) / peak) * (h - 4) - 2;

    if (this.fill) {
      const gradient = ctx.createLinearGradient(0, 0, 0, h);
      gradient.addColorStop(0, hexToRgba(color, 0.34));
      gradient.addColorStop(1, hexToRgba(color, 0.02));
      ctx.beginPath();
      ctx.moveTo(offset, y(data[0]));
      for (let i = 1; i < data.length; i += 1) ctx.lineTo(offset + i * step, y(data[i]));
      ctx.lineTo(offset + (data.length - 1) * step, h);
      ctx.lineTo(offset, h);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(offset, y(data[0]));
    for (let i = 1; i < data.length; i += 1) ctx.lineTo(offset + i * step, y(data[i]));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.shadowColor = hexToRgba(color, 0.85);
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  draw() {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    if (this.grid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.045)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i += 1) {
        const y = (h / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
        ctx.stroke();
      }
      for (let i = 1; i < 6; i += 1) {
        const x = (w / 6) * i;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
        ctx.stroke();
      }
    }

    const peak = this._peak();
    if (this.color2 && this.series2.length) this._drawSeries(this.series2, this.color2, peak);
    this._drawSeries(this.series, this.color, peak);
  }

  destroy() {
    this._observer.disconnect();
  }
}
