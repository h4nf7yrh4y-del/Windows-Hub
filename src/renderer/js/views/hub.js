import { el, svg, clear, relativeTime, colorFromString, resolveProcessName, profileStatus } from '../util.js';
import { api } from '../api.js';
import { state, on, loadProfiles, watchRunning, refreshRunning } from '../state.js';
import { openProfileEditor } from './profileEditor.js';
import { openScheduleManager } from './schedule.js';
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
  // Asked from the main process rather than worked out here, so what the
  // dialog promises and what actually gets closed cannot drift apart.
  let plan = { names: [], unresolved: [] };
  try {
    plan = await api.profiles.stopPlan(profile.id);
  } catch (err) {
    notifyError(err.message);
    return;
  }

  const lines = [
    plan.names.length
      ? `Beendet werden: ${plan.names.join(', ')}.`
      : 'Für dieses Profil ist kein einziges Programm zuordenbar.',
    'Das geschieht unabhängig davon, ob ein Programm schon vor dem Profilstart lief. Nicht gespeicherter Fortschritt geht verloren.'
  ];

  if (plan.unresolved.length) {
    // The old failure was invisible: an entry that resolves to no process name
    // was silently left out and the hub still reported success.
    lines.push(
      `Ohne hinterlegten Prozess und daher nicht zu beenden: ${plan.unresolved.map((u) => u.name).join(', ')}. `
      + 'Im Profileditor lässt sich der Prozess über „wählen" aus den laufenden Programmen festlegen.'
    );
  }

  const sure = await confirmDialog({
    title: `„${profile.name}" beenden`,
    message: lines.join('\n\n'),
    confirmLabel: 'Beenden',
    danger: true,
    width: '520px'
  });
  if (!sure) return;

  try {
    const result = await api.profiles.stop(profile.id);
    const closed = (result.results || []).filter((r) => r.ok && r.matched);
    const failed = (result.results || []).filter((r) => !r.ok);

    if (failed.length) {
      notifyError(`${failed.map((f) => f.name).join(', ')} konnte nicht beendet werden: ${failed[0].error}`);
    } else if (closed.length) {
      notifyOk(`${profile.name}: ${closed.length} Programm${closed.length === 1 ? '' : 'e'} beendet`);
    } else {
      // Saying "stopped" when nothing was running is how the old bug hid.
      notifyOk(`${profile.name}: es lief nichts mehr`);
    }
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

/** Short description of a profile's system changes, or null when it has none. */
function systemSummary(profile) {
  const system = profile.system || {};
  const parts = [];
  if (system.powerPlan) parts.push('Energieplan');
  if (system.priority && system.priority !== 'normal') parts.push('Priorität');
  if ((system.closeApps || []).length) parts.push(`${system.closeApps.length} Programme werden beendet`);
  if (system.keepAwake) parts.push('Bildschirm bleibt an');
  return parts.length ? parts.join(' · ') : null;
}

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
    el('div', { class: 'card-meta' }, [
      `${(profile.apps || []).length} Programme · ${profile.launchCount || 0}× · ${relativeTime(profile.lastLaunched)}`,
      // Says at a glance that starting this profile changes more than which
      // programs are open.
      systemSummary(profile) ? el('span', { class: 'card-tweaks', title: systemSummary(profile) }, ['SYS']) : null
    ])
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
        el('button', { class: 'btn subtle', text: 'Zeitplan', title: 'Profile zu festen Zeiten starten oder beenden', onClick: () => openScheduleManager() }),
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

/** Stops a profile by id, for callers that have no card to click. */
async function stopProfileByName(profileId) {
  const profile = state.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error('Profil nicht gefunden');
  await stopProfile(profile);
}

export { render as renderHub, launchProfile, stopProfileByName };
