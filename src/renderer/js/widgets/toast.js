import { el, $ } from '../util.js';
import { record } from '../activity.js';

const TITLES = { info: 'System', ok: 'Erfolg', warn: 'Achtung', error: 'Fehler' };
// Info-level toasts are mostly transient progress ("Scanne …") and would
// drown out the events actually worth remembering after the fact.
const REMEMBERED = new Set(['ok', 'warn', 'error']);

export function toast(message, kind = 'info', ttl = 4200) {
  if (REMEMBERED.has(kind)) record(kind, message);

  const host = $('#toasts');
  if (!host) return;
  const node = el('div', { class: `toast ${kind}` }, [
    el('div', { class: 'toast-title', text: TITLES[kind] || TITLES.info }),
    el('div', { class: 'toast-msg', text: String(message) })
  ]);
  host.appendChild(node);
  const remove = () => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  };
  const timer = setTimeout(remove, ttl);
  node.addEventListener('click', () => { clearTimeout(timer); remove(); });
}

export const notifyOk    = (m) => toast(m, 'ok');
export const notifyWarn  = (m) => toast(m, 'warn');
export const notifyError = (m) => toast(m, 'error', 6500);
