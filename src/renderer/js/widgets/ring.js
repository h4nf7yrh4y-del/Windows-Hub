import { el } from '../util.js';
import { countTo } from '../motion.js';

const R = 46;
const CIRC = 2 * Math.PI * R;

/** Circular gauge built from inline SVG; only the dash offset changes. */
export class Ring {
  constructor({ caption = '', unit = '%', color = 'var(--accent)' } = {}) {
    const ns = 'http://www.w3.org/2000/svg';
    const svgEl = document.createElementNS(ns, 'svg');
    svgEl.setAttribute('viewBox', '0 0 108 108');

    const track = document.createElementNS(ns, 'circle');
    track.setAttribute('class', 'ring-track');
    track.setAttribute('cx', '54');
    track.setAttribute('cy', '54');
    track.setAttribute('r', String(R));

    const value = document.createElementNS(ns, 'circle');
    value.setAttribute('class', 'ring-value');
    value.setAttribute('cx', '54');
    value.setAttribute('cy', '54');
    value.setAttribute('r', String(R));
    value.setAttribute('stroke-dasharray', String(CIRC));
    value.setAttribute('stroke-dashoffset', String(CIRC));
    value.style.stroke = color;

    svgEl.append(track, value);

    this.num = el('div', { class: 'ring-num', text: '--' });
    this.cap = el('div', { class: 'ring-cap', text: caption });
    this.unit = unit;
    this.valueCircle = value;

    this.node = el('div', { class: 'ring' }, [
      svgEl,
      el('div', { class: 'ring-label' }, [this.num, this.cap])
    ]);
  }

  set(percent, displayText) {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    this.valueCircle.setAttribute('stroke-dashoffset', String(CIRC * (1 - clamped / 100)));
    const stroke = clamped >= 90 ? 'var(--danger)' : clamped >= 75 ? 'var(--warn)' : 'var(--accent)';
    this.valueCircle.style.stroke = stroke;

    if (displayText !== undefined) {
      this.num.textContent = displayText;
      this.num.__countValue = undefined;
    } else {
      countTo(this.num, clamped);
    }
    return this;
  }

  setCaption(text) {
    this.cap.textContent = text;
    return this;
  }
}
