import { el, $, sleep } from './util.js';

/**
 * Startup sequence. Purely cosmetic, but it also gives the real init work a
 * place to hide: the caller passes tasks that run while the lines type out.
 */

const LINES = [
  ['CORE', 'Kernel-Schnittstelle initialisiert'],
  ['IPC', 'Sichere Bridge hergestellt'],
  ['CFG', 'Konfiguration geladen'],
  ['TLM', 'Telemetrie-Kanal aktiv'],
  ['PRF', 'Profile registriert'],
  ['GFX', 'Renderer synchronisiert'],
  ['SYS', 'Alle Systeme bereit']
];

export async function runBoot({ enabled = true, tasks = [] } = {}) {
  const boot = $('#boot');
  const app = $('#app');

  const finish = () => {
    if (boot) {
      boot.classList.add('leaving');
      setTimeout(() => boot.remove(), 440);
    }
    if (app) app.classList.remove('hidden');
  };

  if (!boot) {
    if (app) app.classList.remove('hidden');
    await Promise.allSettled(tasks.map((t) => t()));
    return;
  }

  if (!enabled) {
    boot.remove();
    if (app) app.classList.remove('hidden');
    await Promise.allSettled(tasks.map((t) => t()));
    return;
  }

  const lineHost = boot.querySelector('.boot-lines');
  const bar = boot.querySelector('.boot-bar > i');

  // Kick off the real work immediately; the animation runs alongside it.
  const work = Promise.allSettled(tasks.map((t) => t()));

  for (let i = 0; i < LINES.length; i += 1) {
    const [tag, text] = LINES[i];
    lineHost.appendChild(el('div', { class: 'boot-line' }, [
      el('span', { class: 'tag', text: `[${tag}]` }),
      el('span', { text }),
      el('span', { class: 'ok', text: 'OK' })
    ]));
    lineHost.scrollTop = lineHost.scrollHeight;
    if (bar) bar.style.width = `${((i + 1) / LINES.length) * 100}%`;
    await sleep(105 + Math.random() * 90);
  }

  await work;
  await sleep(180);
  finish();
}
