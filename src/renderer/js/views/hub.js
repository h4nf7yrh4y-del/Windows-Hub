import { el, svg, clear, relativeTime, colorFromString, resolveProcessName, profileStatus } from '../util.js';
import { api } from '../api.js';
import { state, on, loadProfiles, watchRunning, refreshRunning } from '../state.js';
import { openProfileEditor } from './profileEditor.js';
import { openScheduleManager } from './schedule.js';
import { openStats } from './stats.js';
import { LaunchOverlay } from './launchOverlay.js';
import { createMediaBar } from '../widgets/media.js';
import { notifyError, notifyOk, toast } from '../widgets/toast.js';
import { confirmDialog, openModal } from '../widgets/modal.js';
import { list as activityList, onChange as onActivityChange, clear as clearActivity } from '../activity.js';
import { wingetCache } from '../updatesCache.js';

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

// appId -> data URL, or null once confirmed there is none. Keyed by app id
// rather than profile id: the image never changes for a given Steam game,
// so a profile whose apps are re-ordered or renamed still hits the cache.
const coverCache = new Map();

function coverNode(dataUrl) {
  return el('div', { class: 'card-cover', style: { backgroundImage: `url("${dataUrl}")` } });
}

function profileCard(profile, index) {
  const accent = profile.accent || colorFromString(profile.name);
  const status = profileStatus(profile, state.running);
  // A picture someone chose on purpose in the editor always wins over one
  // fetched automatically; the Steam lookup only fills in when there is none.
  const appId = profile.cover ? null : steamAppId(profile.apps);
  const cachedCover = appId ? coverCache.get(appId) : undefined;
  const cover = profile.cover || cachedCover || null;

  const card = el('div', {
    class: 'profile-card',
    style: { '--card-accent': accent, animationDelay: `${index * 55}ms` },
    onDblClick: () => launchProfile(profile)
  }, [
    cover ? coverNode(cover) : null,
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

  // Drawn immediately without it; patched in once it arrives rather than
  // held up on a network call nobody asked to wait for. Cached, so this
  // only ever happens once per Steam app id per run of the hub.
  if (appId && cachedCover === undefined) {
    api.coverart.get(appId).then((result) => {
      const dataUrl = result && result.ok ? result.dataUrl : null;
      coverCache.set(appId, dataUrl);
      if (dataUrl && card.isConnected) card.insertBefore(coverNode(dataUrl), card.firstChild);
    }).catch(() => coverCache.set(appId, null));
  }

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

/**
 * Deleted profiles, and the way back.
 *
 * A dialog rather than a view: it is somewhere you go once, in the minute
 * after realising the mistake, not a place to navigate to.
 */
function openTrash() {
  const body = el('div', { class: 'stack gap-12' });

  const modal = openModal({
    title: 'Papierkorb',
    width: '560px',
    render: () => body
  });

  function days(entry) {
    const left = Math.ceil((entry.expiresAt - Date.now()) / (24 * 3600 * 1000));
    if (left <= 0) return 'läuft heute ab';
    return left === 1 ? 'noch einen Tag' : `noch ${left} Tage`;
  }

  async function render() {
    clear(body);
    let entries = [];
    try {
      entries = await api.trash.list();
    } catch (err) {
      body.appendChild(el('div', { class: 'faint', text: err.message }));
      return;
    }

    if (!entries.length) {
      body.appendChild(el('div', { class: 'empty', style: { padding: '28px' } }, [
        el('div', { class: 'empty-title', text: 'Nichts gelöscht' }),
        el('div', { style: { fontSize: '12px' },
          text: 'Gelöschte Profile landen hier und bleiben zwei Wochen.' })
      ]));
      return;
    }

    for (const entry of entries) {
      body.appendChild(el('div', { class: 'row gap-8 between' }, [
        el('div', { class: 'stack gap-2 grow', style: { minWidth: '0' } }, [
          el('div', { class: 'setting-label truncate', text: entry.name }),
          el('div', { class: 'setting-hint', text: `${entry.apps} Programme · ${days(entry)}` })
        ]),
        el('button', {
          class: 'btn primary sm',
          text: 'Zurückholen',
          onClick: async () => {
            try {
              const result = await api.trash.restore(entry.id);
              await loadProfiles();
              // Said out loud rather than silently: a restore that landed
              // under a different name is not the thing that was expected.
              toast(result.renamed
                ? `„${result.profile.name}" — der alte Platz war belegt`
                : `„${result.profile.name}" zurückgeholt`);
              render();
            } catch (err) { notifyError(err.message); }
          }
        }),
        el('button', {
          class: 'btn danger sm',
          text: 'Endgültig',
          onClick: async () => {
            const sure = await confirmDialog({
              title: `„${entry.name}" endgültig löschen`,
              message: 'Danach ist das Profil weg. Es gibt keinen zweiten Papierkorb.',
              confirmLabel: 'Endgültig löschen',
              danger: true
            });
            if (!sure) return;
            try { await api.trash.drop(entry.id); render(); } catch (err) { notifyError(err.message); }
          }
        })
      ]));
    }

    body.appendChild(el('div', { class: 'row gap-8', style: { marginTop: '8px' } }, [
      el('button', {
        class: 'btn subtle sm',
        text: 'Papierkorb leeren',
        onClick: async () => {
          const sure = await confirmDialog({
            title: 'Papierkorb leeren',
            message: `${entries.length} gelöschte Profile werden endgültig entfernt.`,
            confirmLabel: 'Leeren',
            danger: true
          });
          if (!sure) return;
          try { await api.trash.empty(); render(); } catch (err) { notifyError(err.message); }
        }
      })
    ]));
  }

  render();
  return modal;
}

/**
 * The last few things that happened, not just the one that just did.
 *
 * A toast answers "did that work" for whoever is looking at the screen at
 * that exact moment and then is gone -- minimize the hub while a trigger
 * fires in the background, or step away for a minute, and there was never
 * anything to come back to. This is the same events, kept a little longer.
 *
 * Absent entirely when there is nothing to show: an empty "Aktivität" panel
 * sitting there by default would be one more thing on a screen that already
 * has a lot on it, for no information at all.
 */
function activityPanel() {
  const rows = el('div', { class: 'activity-rows' });
  const panel = el('div', { class: 'panel activity-panel hidden' }, [
    el('div', { class: 'panel-head' }, [
      el('div', { class: 'panel-title', text: 'Aktivität' }),
      el('button', {
        class: 'btn subtle sm',
        text: 'Leeren',
        onClick: () => clearActivity()
      })
    ]),
    rows
  ]);

  function paint(entries) {
    panel.classList.toggle('hidden', !entries.length);
    clear(rows);
    for (const entry of entries.slice(0, 6)) {
      rows.appendChild(el('div', { class: `activity-row ${entry.kind}` }, [
        el('span', { class: 'activity-dot' }),
        el('span', { class: 'activity-msg truncate', text: entry.message }),
        el('span', { class: 'activity-time', text: relativeTime(entry.at) })
      ]));
    }
  }

  let unsubscribe = null;
  function start() {
    paint(activityList());
    if (!unsubscribe) unsubscribe = onActivityChange(paint);
  }
  function stop() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  }

  // Started immediately, the same way the media bar is: the very first time
  // a view is created, app.js does not fire `view:mount` for it, only for
  // the views it returns to.
  start();
  return { node: panel, start, stop };
}

const ATTENTION_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Four things the hub already knows, pulled into one place: a pending
 * winget or Steam update, a game nobody has played in a year, a deleted
 * profile about to age out of the bin, a hotkey that looks bound but does
 * not fire. Every one of them lives behind its own view today and stays
 * there unless someone happens to open it.
 *
 * Three of the four reads are cheap manifest and in-memory lookups and are
 * safe to repeat on every profile change. winget is not -- it can take the
 * better part of a minute on a cold cache, which is accepted on the Updates
 * view because opening it is a deliberate choice. It must not become a
 * hidden cost of the hub simply existing, so this never calls it: it only
 * reads `updatesCache.js`, which the Updates view fills in when a real scan
 * already happened. Nothing checked yet reads as nothing to report, the
 * same as the query having found no updates -- both mean there is nothing
 * this card can usefully say right now.
 */

/* ------------------------------------------------------------------- pure */
/*
 * What the card says, kept separate from how it says it (the click targets,
 * the DOM). `test/hub-attention.test.js` lifts this out and runs it
 * directly -- the wording and the thresholds are the part worth getting
 * right, and neither needs a page to check.
 */

/**
 * The Steam app id a profile's cover art belongs to, or null.
 *
 * Read out of the launch URI rather than a separate stored field: the
 * scanner already writes `steam://rungameid/<id>` for every Steam entry,
 * and a second place to keep the same id current would be a second place
 * for it to go stale. The first Steam app among the profile's enabled
 * entries wins, matching the "games first" ordering the first-run wizard
 * already uses -- a profile is usually built around one game.
 */
function steamAppId(apps) {
  for (const app of apps || []) {
    if (!app || app.enabled === false || !app.launch || app.launch.type !== 'uri') continue;
    const match = /^steam:\/\/rungameid\/([1-9][0-9]{0,9})$/.exec(String(app.launch.target || ''));
    if (match) return match[1];
  }
  return null;
}

function attentionItems({ expiringSoon, cold, collisions, steamActionable, wingetActionable }) {
  const items = [];
  const updateCount = steamActionable + (wingetActionable || 0);

  if (updateCount > 0) {
    items.push({ key: 'updates', text: `${updateCount} ${updateCount === 1 ? 'Update verfügbar' : 'Updates verfügbar'}` });
  }
  if (cold > 0) {
    items.push({ key: 'storage', text: `${cold} ${cold === 1 ? 'Spiel liegt' : 'Spiele liegen'} seit über einem Jahr ungenutzt` });
  }
  if (expiringSoon > 0) {
    items.push({
      key: 'trash',
      text: `${expiringSoon} ${expiringSoon === 1 ? 'gelöschtes Profil läuft' : 'gelöschte Profile laufen'} bald aus dem Papierkorb`
    });
  }
  if (collisions > 0) {
    items.push({ key: 'hotkeys', text: `${collisions} ${collisions === 1 ? 'Tastenkürzel greift' : 'Tastenkürzel greifen'} nicht` });
  }
  return items;
}

/* --------------------------------------------------------------- end pure */

function attentionPanel() {
  const rows = el('div', { class: 'attention-rows' });
  const panel = el('div', { class: 'panel attention-panel hidden' }, [
    el('div', { class: 'panel-head' }, [el('div', { class: 'panel-title', text: 'Braucht Aufmerksamkeit' })]),
    rows
  ]);

  function go(viewId) {
    const button = document.querySelector(`.rail-btn[data-view="${viewId}"]`);
    if (button) button.click();
  }

  // What each item's key does when clicked, kept apart from the pure
  // function that decides which keys appear at all.
  const ACTIONS = {
    updates: () => go('updates'),
    storage: () => go('storage'),
    trash: () => openTrash(),
    hotkeys: () => go('settings')
  };

  async function refresh() {
    let trash = [];
    let storage = null;
    let hotkeyRows = [];
    let steamActionable = 0;
    try {
      const [trashRes, storageRes, hotkeyRes, gamesRes] = await Promise.all([
        api.trash.list().catch(() => []),
        api.storage.overview().catch(() => null),
        api.hotkeys.profiles().catch(() => []),
        api.updates.scanGames().catch(() => null)
      ]);
      trash = trashRes;
      storage = storageRes;
      hotkeyRows = hotkeyRes;
      steamActionable = (gamesRes && gamesRes.steam && gamesRes.steam.games) ? gamesRes.steam.games.length : 0;
    } catch (_) { /* an empty card below is the honest result of a failed read */ }

    const winget = wingetCache();
    const items = attentionItems({
      expiringSoon: trash.filter((e) => e.expiresAt - Date.now() < 2 * ATTENTION_DAY_MS).length,
      cold: storage ? storage.totals.coldCount : 0,
      collisions: hotkeyRows.filter((r) => !r.active).length,
      steamActionable,
      wingetActionable: winget ? winget.actionable : 0
    });

    panel.classList.toggle('hidden', !items.length);
    clear(rows);
    for (const item of items) {
      rows.appendChild(el('button', {
        class: 'attention-row',
        onClick: ACTIONS[item.key]
      }, [
        el('span', { class: 'attention-msg', text: item.text }),
        svg('M9 6l6 6-6 6', { width: 12, height: 12 })
      ]));
    }
  }

  refresh();
  return { node: panel, refresh };
}

export function createHubView() {
  const mediaBar = createMediaBar();
  const activity = activityPanel();
  const attention = attentionPanel();

  host = el('section', { class: 'view', id: 'view-hub' }, [
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h2', { class: 'glitch', dataset: { text: 'Profile' }, text: 'Profile' }),
        el('div', { class: 'view-sub', dataset: { role: 'profile-count' }, text: '' })
      ]),
      el('div', { class: 'view-actions' }, [
        el('button', { class: 'btn subtle', text: 'Papierkorb', title: 'Gelöschte Profile zurückholen', onClick: () => openTrash() }),
        el('button', { class: 'btn subtle', text: 'Spielzeit', title: 'Wie lange welches Profil lief', onClick: () => openStats() }),
        el('button', { class: 'btn subtle', text: 'Zeitplan', title: 'Profile zu festen Zeiten starten oder beenden', onClick: () => openScheduleManager() }),
        el('button', { class: 'btn subtle', text: 'Aktualisieren', onClick: async () => { await loadProfiles(); toast('Profile neu geladen'); } }),
        el('button', { class: 'btn primary', onClick: () => openProfileEditor(null, render) }, [svg(ICON_PLUS, { width: 13, height: 13 }), 'Neues Profil'])
      ])
    ]),
    attention.node,
    mediaBar.node,
    activity.node,
    el('div', { class: 'profile-grid' })
  ]);

  on('profiles', () => { render(); attention.refresh(); });
  on('running', render);

  let releaseWatch = watchRunning();
  host.addEventListener('view:unmount', () => {
    if (releaseWatch) { releaseWatch(); releaseWatch = null; }
    // Each read is a system call; it stops with the view.
    mediaBar.stop();
    activity.stop();
  });
  host.addEventListener('view:mount', () => {
    if (!releaseWatch) releaseWatch = watchRunning();
    mediaBar.start();
    activity.start();
    // Trash and hotkeys have no push event of their own; a revisit is the
    // moment to notice whatever changed about them while the hub was not
    // the thing on screen.
    attention.refresh();
  });

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
