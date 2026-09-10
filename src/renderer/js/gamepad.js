import { el } from './util.js';

/**
 * Controller support.
 *
 * A launcher that starts fullscreen with the machine and is meant to sit in
 * front of a game is the one program that should not require a mouse, and this
 * one did. The hub is a web page, so the browser's own focus model would be the
 * obvious answer, except almost nothing here is a native control: profile
 * cards, toggles and table rows are divs with click handlers. Tab order would
 * skip them and arrow keys would do nothing.
 *
 * So focus is done spatially instead: collect what is visible and clickable,
 * and on a direction pick the candidate that lies that way, preferring the ones
 * that line up with where the focus already is. That is also how it should feel
 * — pressing right in a grid moves right, not to whatever comes next in the
 * document.
 */

/* --------------------------------------------------------------- constants */

// Standard mapping. Every pad that reports "standard" agrees on these.
const BUTTON = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9,
  L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15
};

const DEAD_ZONE = 0.45;
const REPEAT_FIRST_MS = 400;
const REPEAT_NEXT_MS = 110;
const SCROLL_SPEED = 14;

/**
 * Everything a controller may land on.
 *
 * Deliberately explicit rather than "anything clickable": a generic rule would
 * also catch the decorative rows and turn one press of down into a lottery.
 */
const FOCUSABLE = [
  '.rail-btn',
  'button:not([disabled])',
  '.toggle[role="switch"]',
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '.profile-card',
  '.lib-card',
  '.pick-row',
  'tbody tr[data-focusable]'
].join(', ');

/* ----------------------------------------------------------------- helpers */

function visible(node) {
  if (!node.isConnected) return false;
  const rect = node.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
  if (rect.right < 0 || rect.left > window.innerWidth) return false;
  const style = getComputedStyle(node);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
}

function centre(node) {
  const rect = node.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
}

/** Candidates inside the topmost dialog when one is open, otherwise the page. */
function scope() {
  const backdrops = document.querySelectorAll('.modal-backdrop');
  if (backdrops.length) return backdrops[backdrops.length - 1];
  return document.body;
}

function candidates() {
  return [...scope().querySelectorAll(FOCUSABLE)].filter(visible);
}

/**
 * Picks the nearest candidate in one direction.
 *
 * The score is the distance along the direction plus four times the sideways
 * offset, so a control that lines up wins over one that is nominally closer but
 * off to the side. Without that weighting, pressing down in a grid drifts into
 * the neighbouring column.
 */
function pickInDirection(from, direction, list) {
  const origin = centre(from);
  let best = null;
  let bestScore = Infinity;

  for (const node of list) {
    if (node === from) continue;
    const target = centre(node);
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;

    let along;
    let across;
    if (direction === 'left') { along = -dx; across = Math.abs(dy); }
    else if (direction === 'right') { along = dx; across = Math.abs(dy); }
    else if (direction === 'up') { along = -dy; across = Math.abs(dx); }
    else { along = dy; across = Math.abs(dx); }

    // Must actually lie in that direction, with a little tolerance so a row of
    // buttons that is one pixel off still counts as being to the side.
    if (along <= 6) continue;
    if (across > along * 3 + 220) continue;

    const score = along + across * 4;
    if (score < bestScore) { bestScore = score; best = node; }
  }
  return best;
}

function scrollableParent(node) {
  let current = node ? node.parentElement : null;
  while (current && current !== document.body) {
    const style = getComputedStyle(current);
    const scrolls = /(auto|scroll)/.test(style.overflowY);
    if (scrolls && current.scrollHeight > current.clientHeight + 4) return current;
    current = current.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

/* ------------------------------------------------------------------- state */

let enabled = true;
let attached = false;
let active = false;          // a pad has been used since the last mouse move
let focused = null;
let hintBar = null;
let rafHandle = null;
const held = new Map();      // action -> next repeat timestamp
let onViewChange = () => {};
let onToggleOverlays = () => {};

function setFocus(node, { scroll = true } = {}) {
  if (focused === node) return;
  if (focused) focused.classList.remove('gp-focus');
  focused = node || null;
  if (!focused) return;
  focused.classList.add('gp-focus');
  if (scroll) focused.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  // Native controls still want real focus so typing and the caret work.
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(focused.tagName)) {
    try { focused.focus({ preventScroll: true }); } catch (_) { /* not focusable */ }
  }
}

function ensureFocus() {
  if (focused && visible(focused) && scope().contains(focused)) return focused;
  const list = candidates();
  if (!list.length) { setFocus(null); return null; }
  // Start at the top left of whatever is on screen rather than at the rail,
  // which would mean every dialog opens with the focus somewhere else.
  const sorted = list.slice().sort((a, b) => {
    const ca = centre(a);
    const cb = centre(b);
    return (ca.y - cb.y) || (ca.x - cb.x);
  });
  setFocus(sorted[0]);
  return focused;
}

function move(direction) {
  const list = candidates();
  if (!list.length) return;
  const from = ensureFocus();
  if (!from) return;
  const next = pickInDirection(from, direction, list);
  if (next) { setFocus(next); return; }

  // Nothing that way: scroll instead, so a long list keeps moving at its end.
  const container = scrollableParent(from);
  if (container) container.scrollBy({ top: direction === 'down' ? 120 : direction === 'up' ? -120 : 0, behavior: 'smooth' });
}

function press() {
  const node = ensureFocus();
  if (!node) return;
  if (node.tagName === 'SELECT') {
    // A native dropdown cannot be opened programmatically, so step through it.
    node.selectedIndex = (node.selectedIndex + 1) % node.options.length;
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (node.tagName === 'INPUT' && node.type === 'checkbox') { node.click(); return; }
  node.click();
}

function back() {
  const backdrops = document.querySelectorAll('.modal-backdrop');
  if (backdrops.length) {
    // Same path a keyboard takes, so a dialog cannot be closed two ways with
    // two different results.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    setFocus(null);
    return;
  }
  const hub = document.querySelector('.rail-btn[data-view="hub"]');
  if (hub && !hub.classList.contains('active')) { hub.click(); setFocus(null); }
}

function cycleView(step) {
  const buttons = [...document.querySelectorAll('.rail-btn')];
  if (!buttons.length) return;
  const index = buttons.findIndex((b) => b.classList.contains('active'));
  const next = buttons[(Math.max(0, index) + step + buttons.length) % buttons.length];
  if (next) {
    next.click();
    setFocus(null);
    onViewChange(next.dataset.view);
  }
}

/* -------------------------------------------------------------- hint strip */

const HINTS = [
  ['A', 'Auswählen'],
  ['B', 'Zurück'],
  ['LB / RB', 'Ansicht'],
  ['Y', 'Overlays'],
  ['Start', 'Vollbild']
];

function showHints(on) {
  if (!hintBar) {
    hintBar = el('div', { class: 'gp-hints' }, HINTS.map(([key, label]) => el('span', { class: 'gp-hint' }, [
      el('b', { text: key }),
      label
    ])));
    document.body.appendChild(hintBar);
  }
  hintBar.classList.toggle('visible', !!on);
}

/* ------------------------------------------------------------------- loop */

function actionsFrom(pad) {
  const out = new Set();
  const button = (index) => !!(pad.buttons[index] && pad.buttons[index].pressed);
  const axis = (index) => pad.axes[index] || 0;

  if (button(BUTTON.UP) || axis(1) < -DEAD_ZONE) out.add('up');
  if (button(BUTTON.DOWN) || axis(1) > DEAD_ZONE) out.add('down');
  if (button(BUTTON.LEFT) || axis(0) < -DEAD_ZONE) out.add('left');
  if (button(BUTTON.RIGHT) || axis(0) > DEAD_ZONE) out.add('right');
  if (button(BUTTON.A)) out.add('press');
  if (button(BUTTON.B)) out.add('back');
  if (button(BUTTON.Y)) out.add('overlays');
  if (button(BUTTON.LB)) out.add('prevView');
  if (button(BUTTON.RB)) out.add('nextView');
  if (button(BUTTON.START)) out.add('fullscreen');
  return out;
}

// Directions repeat while held; everything else fires once per press.
const REPEATS = new Set(['up', 'down', 'left', 'right']);

function run(action) {
  switch (action) {
    case 'up': case 'down': case 'left': case 'right': move(action); break;
    case 'press': press(); break;
    case 'back': back(); break;
    case 'overlays': onToggleOverlays(); break;
    case 'prevView': cycleView(-1); break;
    case 'nextView': cycleView(1); break;
    case 'fullscreen':
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }));
      break;
    default: break;
  }
}

function pads() {
  return [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter(Boolean);
}

/**
 * The polling loop only runs while a controller is present.
 *
 * A hub that starts with the machine and stays open all day has no business
 * waking sixty times a second to ask about a device nobody plugged in. The
 * browser announces the first one on its own — Windows reports a pad the moment
 * a button is pressed — and the loop stops again when the last one goes.
 */
function startLoop() {
  if (rafHandle !== null || !enabled) return;
  rafHandle = requestAnimationFrame(tick);
}

function stopLoop() {
  if (rafHandle !== null) cancelAnimationFrame(rafHandle);
  rafHandle = null;
  held.clear();
}

function tick() {
  rafHandle = requestAnimationFrame(tick);
  if (!enabled) return;

  const list = pads();
  if (!list.length) {
    if (active) { active = false; showHints(false); document.body.classList.remove('gp-active'); }
    stopLoop();
    return;
  }

  const now = performance.now();
  const pressed = new Set();
  for (const pad of list) for (const action of actionsFrom(pad)) pressed.add(action);

  // The right stick scrolls, which is the only way through a long process
  // table without stepping over every row.
  for (const pad of list) {
    const vertical = pad.axes[3] || 0;
    if (Math.abs(vertical) > DEAD_ZONE) {
      const container = scrollableParent(focused || document.querySelector('#main'));
      if (container) container.scrollTop += vertical * SCROLL_SPEED;
      markActive();
    }
  }

  for (const action of pressed) {
    const due = held.get(action);
    if (due === undefined) {
      held.set(action, now + REPEAT_FIRST_MS);
      markActive();
      run(action);
    } else if (REPEATS.has(action) && now >= due) {
      held.set(action, now + REPEAT_NEXT_MS);
      run(action);
    }
  }

  for (const action of [...held.keys()]) {
    if (!pressed.has(action)) held.delete(action);
  }
}

function markActive() {
  if (active) return;
  active = true;
  document.body.classList.add('gp-active');
  showHints(true);
  ensureFocus();
}

/* ------------------------------------------------------------------- setup */

export function initGamepad({ onToggleOverlays: overlaysHandler, onViewChange: viewHandler } = {}) {
  if (attached) return;
  attached = true;
  if (overlaysHandler) onToggleOverlays = overlaysHandler;
  if (viewHandler) onViewChange = viewHandler;

  // Touching the mouse hands control back to it; the ring would otherwise sit
  // on an element the pointer is nowhere near.
  const release = () => {
    if (!active) return;
    active = false;
    document.body.classList.remove('gp-active');
    showHints(false);
    if (focused) { focused.classList.remove('gp-focus'); focused = null; }
  };
  window.addEventListener('mousemove', release, { passive: true });
  window.addEventListener('mousedown', release, { passive: true });

  window.addEventListener('gamepadconnected', () => { if (enabled) startLoop(); });
  window.addEventListener('gamepaddisconnected', () => {
    release();
    if (!pads().length) stopLoop();
  });

  // Some builds already report a pad that was connected before the window
  // existed, without ever firing the event for it.
  if (pads().length) startLoop();
}

export function setGamepadEnabled(value) {
  enabled = value !== false;
  if (enabled) {
    if (pads().length) startLoop();
    return;
  }
  stopLoop();
  active = false;
  document.body.classList.remove('gp-active');
  showHints(false);
  if (focused) { focused.classList.remove('gp-focus'); focused = null; }
}

export function gamepadState() {
  return {
    enabled,
    active,
    pads: pads().map((p) => ({ id: p.id, index: p.index, mapping: p.mapping, buttons: p.buttons.length }))
  };
}

export function disposeGamepad() {
  stopLoop();
  attached = false;
}

// Exported for the tests: the direction picker is the part with real logic in
// it, and it is worth being able to check without a controller.
export const _internals = { pickInDirection, FOCUSABLE, BUTTON };
