import { el, clear, svg } from '../util.js';
import { api } from '../api.js';
import { notifyError } from '../widgets/toast.js';

/**
 * What is playing, with the three buttons worth having.
 *
 * Shared between the hub and the second screen. It polls only while it is on
 * screen, because each read is a system call, and it hides itself entirely
 * when nothing is playing rather than sitting there as an empty frame — an
 * element that says "nothing" all day is worse than no element.
 */

const ICON_PREV = 'M19 5v14l-9-7zM6 5h2v14H6z';
const ICON_NEXT = 'M5 5v14l9-7zM16 5h2v14h-2z';
const ICON_PLAY = 'M7 4l13 8-13 8z';
const ICON_PAUSE = 'M7 5h4v14H7zM13 5h4v14h-4z';
const ICON_NOTE = 'M9 18V6l10-2v12M9 18a2 2 0 11-4 0 2 2 0 014 0zM19 16a2 2 0 11-4 0 2 2 0 014 0z';

const POLL_MS = 6000;

function time(ms) {
  if (!ms || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function createMediaBar({ compact = false } = {}) {
  let timer = null;
  let busy = false;
  let data = null;

  const title = el('div', { class: 'media-title truncate', text: '' });
  const artist = el('div', { class: 'media-artist truncate', text: '' });
  const source = el('div', { class: 'media-source truncate', text: '' });
  const progress = el('i');
  const elapsed = el('span', { class: 'media-time', text: '' });
  const total = el('span', { class: 'media-time', text: '' });

  function button(icon, label, command, enabled = () => true) {
    return el('button', {
      class: 'media-btn',
      title: label,
      onClick: async (event) => {
        event.stopPropagation();
        if (!enabled()) return;
        try {
          data = await api.media.command(command);
          paint();
        } catch (err) { notifyError(err.message); }
      }
    }, [svg(icon, { width: 13, height: 13, strokeWidth: 0 })]);
  }

  const prevButton = button(ICON_PREV, 'Vorheriger Titel', 'previous', () => data && data.canPrev);
  const playButton = button(ICON_PLAY, 'Abspielen oder anhalten', 'playpause');
  const nextButton = button(ICON_NEXT, 'Nächster Titel', 'next', () => data && data.canNext);

  for (const node of [prevButton, playButton, nextButton]) {
    node.querySelector('svg path').setAttribute('fill', 'currentColor');
  }

  const node = el('div', { class: `media-bar${compact ? ' compact' : ''} hidden` }, [
    el('span', { class: 'media-mark' }, [svg(ICON_NOTE, { width: 14, height: 14 })]),
    el('div', { class: 'media-meta' }, [title, artist, compact ? null : source]),
    el('div', { class: 'media-progress' }, [
      elapsed,
      el('div', { class: 'media-bar-track' }, [progress]),
      total
    ]),
    el('div', { class: 'media-controls' }, [prevButton, playButton, nextButton])
  ]);

  function paint() {
    // Nothing playing means the bar is not there at all.
    const active = !!(data && data.available && data.title);
    node.classList.toggle('hidden', !active);
    if (!active) return;

    node.classList.toggle('paused', !data.playing);
    title.textContent = data.title;
    artist.textContent = data.artist || '';
    source.textContent = data.album || '';

    const percent = data.durationMs ? Math.min(100, (data.positionMs / data.durationMs) * 100) : 0;
    progress.style.width = `${percent}%`;
    elapsed.textContent = time(data.positionMs);
    total.textContent = time(data.durationMs);

    const glyph = playButton.querySelector('svg path');
    glyph.setAttribute('d', data.playing ? ICON_PAUSE : ICON_PLAY);
    glyph.setAttribute('fill', 'currentColor');

    prevButton.classList.toggle('off', !data.canPrev);
    nextButton.classList.toggle('off', !data.canNext);
  }

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      data = await api.media.read();
      paint();
    } catch (_) {
      // A failed read is the same as nothing playing as far as this is
      // concerned; the module behind it already logs the reason.
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return;
    poll();
    timer = setInterval(poll, POLL_MS);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  node.addEventListener('media:start', start);
  node.addEventListener('media:stop', stop);
  start();

  return { node, start, stop, refresh: poll };
}
