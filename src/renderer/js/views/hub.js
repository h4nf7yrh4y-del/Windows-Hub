import { el, svg, clear, relativeTime, colorFromString, resolveProcessName, profileStatus } from '../util.js';
import { api } from '../api.js';
import { state, on, loadProfiles, watchRunning, refreshRunning } from '../state.js';
import { openProfileEditor } from './profileEditor.js';
import { LaunchOverlay } from './launchOverlay.js';
import { notifyError, notifyOk, toast } from '../widgets/toast.js';
import { confirmDialog } from '../widgets/modal.js';

const ICON_PLUS = 'M12 5v14M5 12h14';
const ICON_PLAY = 'M7 4l13 8-13 8z';
const ICON_EDIT = 'M4 20h4L19 9l-4-4L4 16v4zM14.5 5.5l4 4';
const ICON_STOP = 'M6 6h12v12H6z';

let activeOverlay = null;
let progressBound = false;

function bindProgress() {
  if (progressBound) return;
  progressBound = true;
  api.profiles.onProgress((event) => {
    if (activeOverlay) activeOverlay.handle(event);
  });
}

async function launchProfile(profile) {
  bindProgress();
  activeOverlay = new LaunchOverlay(profile).open();
  try {
    const result = await api.profiles.launch(profile.id);
    const failed = (result.results || []).filter((r) => !r.ok);
    if (failed.length) {
      notifyError(`${failed.length} von ${result.results.length} Starts fehlgeschlagen: ${failed.map((f) => f.name).join(', ')}`);
    } else {
      notifyOk(`${profile.name} gestartet`);
    }
    await activeOverlay.finish(failed.length ? 2600 : 1000);
  } catch (err) {
    notifyError(err.message);
    if (activeOverlay) activeOverlay.destroy();
  } finally {
    activeOverlay = null;
    await loadProfiles();
    // Games take a while to appear in the process list, so re-check twice.
    setTimeout(() => refreshRunning(), 2000);
    setTimeout(() => refreshRunning(), 8000);
  }
}

async function stopProfile(profile) {
  const sure = await confirmDialog({
    title: 'Profil beenden',
    message: `Alle Programme aus „${profile.name}" werden hart geschlossen. Nicht gespeicherter Fortschritt geht verloren.`,
    confirmLabel: 'Beenden',
    danger: true
  });
  if (!sure) return;
  try {
    await api.profiles.stop(profile.id);
    notifyOk(`${profile.name} beendet`);
    // Give the processes a moment to disappear before re-reading the list.
    setTimeout(() => refreshRunning(), 1200);
  } catch (err) {
    notifyError(err.message);
  }
}

const STATUS_LABELS = {
  running: 'läuft',
  partial: 'teilweise',
  idle: 'gestoppt',
  unknown: null
};

function profileCard(profile, index) {
  const accent = profile.accent || colorFromString(profile.name);
  const status = profileStatus(profile, state.running);

  const card = el('div', {
    class: 'profile-card',
    style: { '--card-accent': accent, animationDelay: `${index * 55}ms` },
    onDblClick: () => launchProfile(profile)
  }, [
    profile.cover ? el('div', { class: 'card-cover', style: { backgroundImage: `url("${profile.cover}")` } }) : null,
    el('div', { class: 'card-scrim' }),
    el('div', { class: 'card-glow' }),
    el('div', { class: 'row between' }, [
      el('div', { class: 'card-index', text: String(index + 1).padStart(2, '0') }),
      STATUS_LABELS[status.state]
        ? el('span', { class: `status-tag ${status.state}`, title: `${status.running} von ${status.tracked} überwachten Programmen läuft` }, [
          el('span', { class: 'status-dot' }),
          el('span', { text: STATUS_LABELS[status.state] })
        ])
        : null
    ]),
    el('div', { class: 'card-name', text: profile.name }),
    el('div', { class: 'card-tagline', text: profile.tagline || '' }),
    el('div', { class: 'card-apps' }, (profile.apps || []).filter((a) => a.enabled !== false).slice(0, 5).map((app) => {
      const name = resolveProcessName(app);
      // No process name means the entry cannot be watched, which the chip
      // shows as a neutral state rather than pretending it is stopped.
      const cls = !name ? 'chip untracked' : (state.running.has(name) ? 'chip live' : 'chip');
      return el('span', {
        class: cls,
        title: name ? `${name}.exe` : 'Kein Prozessname hinterlegt, Status unbekannt'
      }, [name ? el('span', { class: 'chip-dot' }) : null, app.name]);
    })),
    el('div', { class: 'card-foot' }, [
      el('button', { class: 'card-launch', onClick: (e) => { e.stopPropagation(); launchProfile(profile); } }, [
        svg(ICON_PLAY, { width: 11, height: 11, strokeWidth: 0 }),
        'Starten'
      ]),
      el('div', { class: 'card-actions' }, [
        el('button', {
          class: `icon-btn${status.state === 'running' || status.state === 'partial' ? ' danger active' : ''}`,
          title: 'Alle Programme beenden',
          onClick: (e) => { e.stopPropagation(); stopProfile(profile); }
        }, [svg(ICON_STOP, { width: 14, height: 14 })]),
        el('button', {
          class: 'icon-btn',
          title: 'Bearbeiten',
          onClick: (e) => { e.stopPropagation(); openProfileEditor(profile, render); }
        }, [svg(ICON_EDIT, { width: 15, height: 15 })])
      ])
    ]),
    el('div', { class: 'card-meta', text: `${(profile.apps || []).length} Programme · ${profile.launchCount || 0}× · ${relativeTime(profile.lastLaunched)}` })
  ]);

  // Fill icon into the play glyph without a stroke artifact.
  const playIcon = card.querySelector('.card-launch svg path');
  if (playIcon) playIcon.setAttribute('fill', 'currentColor');

  return card;
}

let host = null;

function render() {
  if (!host) return;
  const grid = host.querySelector('.profile-grid');
  if (!grid) return;
  clear(grid);

  state.profiles.forEach((profile, index) => grid.appendChild(profileCard(profile, index)));

  grid.appendChild(el('div', {
    class: 'profile-card add-card',
    style: { animationDelay: `${state.profiles.length * 55}ms` },
    onClick: () => openProfileEditor(null, render)
  }, [
    svg(ICON_PLUS),
    el('div', { class: 'label', text: 'Profil anlegen' })
  ]));

  const counter = host.querySelector('[data-role="profile-count"]');
  if (counter) counter.textContent = `${state.profiles.length} Profile geladen`;
}

export function createHubView() {
  host = el('section', { class: 'view', id: 'view-hub' }, [
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h2', { class: 'glitch', dataset: { text: 'Profile' }, text: 'Profile' }),
        el('div', { class: 'view-sub', dataset: { role: 'profile-count' }, text: '' })
      ]),
      el('div', { class: 'view-actions' }, [
        el('button', { class: 'btn subtle', text: 'Aktualisieren', onClick: async () => { await loadProfiles(); toast('Profile neu geladen'); } }),
        el('button', { class: 'btn primary', onClick: () => openProfileEditor(null, render) }, [svg(ICON_PLUS, { width: 13, height: 13 }), 'Neues Profil'])
      ])
    ]),
    el('div', { class: 'profile-grid' })
  ]);

  on('profiles', render);
  on('running', render);

  let releaseWatch = watchRunning();
  host.addEventListener('view:unmount', () => { if (releaseWatch) { releaseWatch(); releaseWatch = null; } });
  host.addEventListener('view:mount', () => { if (!releaseWatch) releaseWatch = watchRunning(); });

  render();
  return host;
}

export { render as renderHub, launchProfile };
