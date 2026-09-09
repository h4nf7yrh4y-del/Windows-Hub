/**
 * Motion helpers.
 *
 * Everything here degrades to an instant result when motion is reduced, and
 * nothing animates a value the user has not seen change: a counter that ticks
 * up from zero on every render is noise, so the first value always snaps.
 */

function reduced() {
  const root = document.documentElement;
  if (root.dataset.reduceMotion === 'true') return true;
  if (root.dataset.reduceMotion === 'false') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Counts a number element towards a new value.
 *
 * Only worth it for a step the eye can follow; tiny changes and the very
 * first render are written straight out, otherwise the display lags behind
 * reality for no benefit.
 */
export function countTo(node, value, { format = (v) => Math.round(v), duration = 420, minDelta = 2 } = {}) {
  const target = Number(value);
  if (!node || !Number.isFinite(target)) return;

  const from = Number(node.__countValue);
  node.__countValue = target;

  if (!Number.isFinite(from) || reduced() || Math.abs(target - from) < minDelta) {
    node.textContent = format(target);
    return;
  }

  if (node.__countFrame) cancelAnimationFrame(node.__countFrame);
  const started = performance.now();

  const step = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    const current = from + (target - from) * easeOut(progress);
    node.textContent = format(current);
    if (progress < 1) node.__countFrame = requestAnimationFrame(step);
    else { node.__countFrame = null; node.textContent = format(target); }
  };
  node.__countFrame = requestAnimationFrame(step);
}

/**
 * Moves a single highlight bar behind the active rail entry instead of having
 * it blink from one place to another.
 */
export function createRailIndicator(rail) {
  const indicator = document.createElement('div');
  indicator.className = 'rail-indicator';
  rail.appendChild(indicator);

  let current = null;

  const move = (button, { instant = false } = {}) => {
    if (!button) { indicator.style.opacity = '0'; return; }
    const railBox = rail.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    if (!box.height) return;

    if (instant || reduced() || !current) indicator.style.transition = 'none';
    else indicator.style.transition = '';

    indicator.style.opacity = '1';
    indicator.style.transform = `translateY(${box.top - railBox.top + rail.scrollTop}px)`;
    indicator.style.height = `${box.height}px`;

    if (instant || reduced() || !current) {
      // Force a reflow so the next move animates from here rather than 0.
      void indicator.offsetHeight;
      indicator.style.transition = '';
    }
    current = button;
  };

  return { move, node: indicator };
}

/**
 * Slides a view in from the direction it sits in the rail, so switching has a
 * sense of place rather than everything rising from below.
 */
export function enterView(node, direction) {
  if (!node) return;
  if (reduced()) { node.style.animation = 'none'; return; }
  node.style.animation = 'none';
  void node.offsetHeight;
  node.style.animation = direction === 'up'
    ? 'view-in-up 340ms var(--ease-out) both'
    : 'view-in-down 340ms var(--ease-out) both';
}

/**
 * A very slight parallax on the background layers, driven by pointer
 * position. Purely decorative, so it is skipped entirely under reduced
 * motion and throttled to one update per frame.
 */
export function bindParallax(layer) {
  if (!layer || reduced()) return () => {};

  let targetX = 0;
  let targetY = 0;
  let currentX = 0;
  let currentY = 0;
  let frame = null;
  let running = true;

  const onMove = (event) => {
    targetX = (event.clientX / window.innerWidth - 0.5) * 2;
    targetY = (event.clientY / window.innerHeight - 0.5) * 2;
    if (!frame) frame = requestAnimationFrame(tick);
  };

  function tick() {
    frame = null;
    // Ease towards the pointer so the movement never feels twitchy.
    currentX += (targetX - currentX) * 0.06;
    currentY += (targetY - currentY) * 0.06;
    layer.style.setProperty('--parallax-x', `${(-currentX * 14).toFixed(2)}px`);
    layer.style.setProperty('--parallax-y', `${(-currentY * 10).toFixed(2)}px`);
    if (running && (Math.abs(targetX - currentX) > 0.001 || Math.abs(targetY - currentY) > 0.001)) {
      frame = requestAnimationFrame(tick);
    }
  }

  window.addEventListener('mousemove', onMove, { passive: true });
  return () => {
    running = false;
    window.removeEventListener('mousemove', onMove);
    if (frame) cancelAnimationFrame(frame);
  };
}
