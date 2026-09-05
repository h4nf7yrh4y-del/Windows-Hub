/* Small DOM + formatting helpers. No framework, no build step. */

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, val] of Object.entries(value)) {
        if (val === null || val === undefined) continue;
        // Object.assign silently drops custom properties; setProperty does not.
        if (prop.startsWith('--')) node.style.setProperty(prop, String(val));
        else node.style[prop] = val;
      }
    }
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  return node;
}

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function svg(pathData, { viewBox = '0 0 24 24', width = 24, height = 24, strokeWidth = 1.6 } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const root = document.createElementNS(ns, 'svg');
  root.setAttribute('viewBox', viewBox);
  root.setAttribute('width', width);
  root.setAttribute('height', height);
  root.setAttribute('fill', 'none');
  root.setAttribute('stroke', 'currentColor');
  root.setAttribute('stroke-width', strokeWidth);
  root.setAttribute('stroke-linecap', 'round');
  root.setAttribute('stroke-linejoin', 'round');
  for (const d of [].concat(pathData)) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    root.appendChild(p);
  }
  return root;
}

/* ------------------------------------------------------------ formatting */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function bytes(value, digits = 1) {
  const n = Number(value) || 0;
  if (n < 1024) return `${Math.round(n)} B`;
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i <= 1 ? 0 : digits)} ${UNITS[i]}`;
}

export function bytesPerSec(value) {
  return `${bytes(value, 1)}/s`;
}

export function pct(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--%';
  return `${n.toFixed(digits)}%`;
}

export function duration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export function relativeTime(ts) {
  if (!ts) return 'nie';
  const diff = Date.now() - Number(ts);
  if (diff < 0) return 'gerade eben';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `vor ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `vor ${days} d`;
  return new Date(Number(ts)).toLocaleDateString('de-DE');
}

export function severity(percent) {
  const n = Number(percent) || 0;
  if (n >= 90) return 'crit';
  if (n >= 75) return 'warn';
  return '';
}

/* ------------------------------------------------------------------ misc */

export function debounce(fn, ms = 200) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function throttle(fn, ms = 100) {
  let last = 0;
  let queued = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); return; }
    if (queued) clearTimeout(queued);
    queued = setTimeout(() => { last = Date.now(); queued = null; fn(...args); }, ms - (now - last));
  };
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Deterministic accent colour derived from a name, for entries without one. */
export function colorFromString(text) {
  let hash = 0;
  for (let i = 0; i < String(text).length; i += 1) {
    hash = (hash * 31 + String(text).charCodeAt(i)) >>> 0;
  }
  const palette = ['#00f0ff', '#ff2e88', '#ffb400', '#26e08a', '#8b5cf6', '#ff6b35', '#00d4a0', '#4d9fff'];
  return palette[hash % palette.length];
}

export function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return `rgba(0, 240, 255, ${alpha})`;
  const int = parseInt(m[1], 16);
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
