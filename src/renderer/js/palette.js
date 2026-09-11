import { el, clear, svg } from './util.js';
import { api } from './api.js';
import { state } from './state.js';
import { notifyError, notifyOk } from './widgets/toast.js';

/**
 * One place to type what you want.
 *
 * A launcher with nine views, a program library and forty Windows settings has
 * the usual problem: everything is two or three clicks away and you have to
 * remember which drawer it lives in. The palette removes the remembering —
 * type a few letters of a profile, a program, a setting or a screen, and press
 * Enter.
 *
 * Matching is subsequence-based rather than substring: "hd2" finds
 * "Helldivers 2", which is how people actually type when they are in a hurry.
 */

const ICONS = {
  view: 'M4 6h16M4 12h16M4 18h16',
  profile: 'M7 4l13 8-13 8z',
  app: 'M6 4h12v16H6z',
  action: 'M12 5v14M5 12h14',
  feature: 'M12 15a3 3 0 100-6 3 3 0 000 6z'
};

const KIND_LABELS = {
  view: 'Ansicht',
  profile: 'Profil',
  app: 'Programm',
  action: 'Aktion',
  feature: 'Windows'
};

/**
 * Subsequence match with a score.
 *
 * Later characters of the needle must appear in order, not adjacently. Runs of
 * consecutive matches and matches at word starts score higher, so "hd2" ranks
 * "Helldivers 2" above a title that merely happens to contain h, d and 2.
 * Returns null when there is no match at all, so the caller can filter.
 */
export function fuzzyScore(haystack, needle) {
  if (!needle) return 0;
  const text = String(haystack).toLowerCase();
  const query = String(needle).toLowerCase().trim();
  if (!query) return 0;

  let score = 0;
  let index = 0;
  let run = 0;

  for (const char of query) {
    if (char === ' ') continue;
    const found = text.indexOf(char, index);
    if (found === -1) return null;

    // A match right after a separator is worth as much as a run: it is how
    // initials work, and initials are what people type.
    const atWordStart = found === 0 || /[\s\-_.:/\\]/.test(text[found - 1]);
    run = found === index ? run + 1 : 0;
    score += 1 + run * 2 + (atWordStart ? 3 : 0);
    index = found + 1;
  }

  // A short name that matched is more likely the one meant than a long one.
  return score + Math.max(0, 12 - text.length / 4);
}

/* ----------------------------------------------------------------- sources */

function viewEntries(showView) {
  const views = [
    ['hub', 'Hub', 'Profile starten und verwalten'],
    ['system', 'System', 'Auslastung, Diagramme, Hardware'],
    ['processes', 'Tasks', 'Prozesse, Netzwerk, Autostart'],
    ['files', 'Files', 'Dateimanager'],
    ['overlays', 'Overlay', 'Schwebende Leistungsanzeigen'],
    ['windows', 'Windows', 'Bildschirme und Systemfunktionen'],
    ['library', 'Library', 'Gefundene Programme'],
    ['settings', 'Setup', 'Einstellungen']
  ];
  return views.map(([id, label, hint]) => ({
    kind: 'view',
    title: label,
    hint,
    run: () => showView(id)
  }));
}

function profileEntries(showView) {
  const entries = [];
  for (const profile of state.profiles) {
    entries.push({
      kind: 'profile',
      title: profile.name,
      hint: `${(profile.apps || []).length} Programme starten`,
      accent: profile.accent,
      run: async () => {
        showView('hub');
        const { launchProfile } = await import('./views/hub.js');
        await launchProfile(profile);
      }
    });
    entries.push({
      kind: 'profile',
      title: `${profile.name} beenden`,
      hint: 'Alle Programme des Profils schließen',
      run: async () => {
        showView('hub');
        const { stopProfileByName } = await import('./views/hub.js');
        await stopProfileByName(profile.id);
      }
    });
  }
  return entries;
}

function libraryEntries() {
  const items = (state.library && state.library.items) || [];
  return items.slice(0, 600).map((item) => ({
    kind: 'app',
    title: item.name,
    hint: item.source || 'Programm starten',
    run: async () => {
      await api.library.launch(item.launch);
      notifyOk(`${item.name} gestartet`);
    }
  }));
}

function actionEntries(showView, actions) {
  return [
    { title: 'Dashboard umschalten', hint: 'Zweiter Bildschirm', run: () => api.dashboard.toggle() },
    { title: 'Overlays umschalten', hint: 'Alle schwebenden Anzeigen', run: () => api.overlays.toggle() },
    { title: 'Claude-Konsole öffnen', hint: 'Eigenes Fenster', run: () => api.claude.openWindow() },
    { title: 'Zeitplan öffnen', hint: 'Profile zu festen Zeiten', run: async () => {
      const { openScheduleManager } = await import('./views/schedule.js');
      openScheduleManager();
    } },
    { title: 'Neues Profil', hint: 'Startsequenz anlegen', run: async () => {
      showView('hub');
      const { openProfileEditor } = await import('./views/profileEditor.js');
      openProfileEditor(null, () => {});
    } },
    { title: 'Bibliothek neu durchsuchen', hint: 'Installierte Programme finden', run: async () => {
      showView('library');
      await api.library.scan({ force: true });
      notifyOk('Bibliothek aktualisiert');
    } },
    { title: 'Vollbild umschalten', hint: 'F11', run: () => api.window.toggleFullscreen() },
    { title: 'Protokollordner öffnen', hint: 'Logdateien im Explorer', run: () => api.diagnostics.openLogs() },
    { title: 'Diagnosebericht speichern', hint: 'Textdatei zum Weitergeben', run: async () => {
      const result = await api.diagnostics.export();
      if (!result.canceled) notifyOk('Bericht gespeichert');
    } },
    { title: 'Konfigurationsordner öffnen', hint: 'hub-config.json', run: () => api.settings.openConfigFolder() },
    ...(actions || [])
  ].map((entry) => ({ kind: 'action', ...entry }));
}

async function featureEntries() {
  try {
    const data = await api.features.list();
    if (!data.supported) return [];
    return data.items.map((item) => ({
      kind: 'feature',
      title: item.name,
      hint: item.category,
      run: async () => {
        if (item.canOpen) await api.features.open(item.id);
        else notifyOk(`${item.name} steht unter Windows → Funktionen`);
      }
    }));
  } catch (_) {
    return [];
  }
}

/* -------------------------------------------------------------------- view */

let openPalette = null;

export function closePalette() {
  if (openPalette) openPalette();
}

export function createPalette({ showView, actions }) {
  return async function open() {
    if (openPalette) return;

    let entries = [
      ...viewEntries(showView),
      ...profileEntries(showView),
      ...actionEntries(showView, actions),
      ...libraryEntries()
    ];

    const input = el('input', {
      class: 'pal-input',
      placeholder: 'Profil, Programm, Einstellung oder Ansicht …',
      spellcheck: 'false'
    });
    const listHost = el('div', { class: 'pal-list' });
    const countLine = el('div', { class: 'pal-count' });

    const backdrop = el('div', { class: 'pal-backdrop' }, [
      el('div', { class: 'pal' }, [
        el('div', { class: 'pal-head' }, [
          svg('M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4.5-4.5', { width: 16, height: 16 }),
          input,
          el('kbd', { class: 'pal-kbd', text: 'Esc' })
        ]),
        listHost,
        el('div', { class: 'pal-foot' }, [
          countLine,
          el('div', { class: 'pal-legend' }, [
            el('span', {}, [el('kbd', { text: '↑↓' }), 'wählen']),
            el('span', {}, [el('kbd', { text: '⏎' }), 'ausführen'])
          ])
        ])
      ])
    ]);

    let matches = [];
    let cursor = 0;

    function render() {
      clear(listHost);
      if (!matches.length) {
        listHost.appendChild(el('div', { class: 'pal-empty' }, [
          el('div', { class: 'empty-title', text: 'Nichts gefunden' }),
          el('div', { style: { fontSize: '12px' }, text: 'Andere Schreibweise probieren — es reichen die Anfangsbuchstaben.' })
        ]));
        countLine.textContent = '';
        return;
      }

      matches.forEach((entry, index) => {
        listHost.appendChild(el('div', {
          class: `pal-row${index === cursor ? ' active' : ''}`,
          dataset: { index: String(index) },
          onMouseEnter: () => { cursor = index; paintCursor(); },
          onClick: () => execute(index)
        }, [
          el('span', { class: `pal-icon ${entry.kind}` }, [
            svg(ICONS[entry.kind] || ICONS.action, { width: 13, height: 13 })
          ]),
          el('span', { class: 'pal-title truncate', text: entry.title }),
          el('span', { class: 'pal-hint truncate', text: entry.hint || '' }),
          el('span', { class: 'pal-kind', text: KIND_LABELS[entry.kind] || '' })
        ]));
      });
      countLine.textContent = `${matches.length} Treffer`;
    }

    function paintCursor() {
      listHost.querySelectorAll('.pal-row').forEach((row, index) => {
        row.classList.toggle('active', index === cursor);
        if (index === cursor) row.scrollIntoView({ block: 'nearest' });
      });
    }

    function filter() {
      const query = input.value.trim();
      if (!query) {
        // Without a query the useful default is the things you act on, not
        // four hundred installed programs.
        matches = entries.filter((e) => e.kind !== 'app' && e.kind !== 'feature').slice(0, 40);
      } else {
        matches = entries
          .map((entry) => ({ entry, score: fuzzyScore(`${entry.title} ${entry.hint || ''}`, query) }))
          .filter((row) => row.score !== null)
          .sort((a, b) => b.score - a.score)
          .slice(0, 40)
          .map((row) => row.entry);
      }
      cursor = 0;
      render();
    }

    async function execute(index) {
      const entry = matches[index];
      if (!entry) return;
      close();
      try {
        await entry.run();
      } catch (err) {
        notifyError(err.message);
      }
    }

    function onKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        cursor = Math.min(matches.length - 1, cursor + 1);
        paintCursor();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        cursor = Math.max(0, cursor - 1);
        paintCursor();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        execute(cursor);
      }
    }

    function close() {
      document.removeEventListener('keydown', onKey, true);
      backdrop.classList.add('closing');
      setTimeout(() => backdrop.remove(), 140);
      openPalette = null;
    }

    openPalette = close;
    backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(); });
    input.addEventListener('input', filter);
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(backdrop);
    filter();
    input.focus();

    // The Windows catalogue needs a system call, so it arrives after the
    // palette is already usable rather than delaying it.
    featureEntries().then((extra) => {
      if (!openPalette || !extra.length) return;
      entries = [...entries, ...extra];
      filter();
    });
  };
}
