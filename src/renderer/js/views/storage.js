import { el, clear, svg } from '../util.js';
import { api } from '../api.js';
import { confirmDialog } from '../widgets/modal.js';
import { notifyError, notifyOk } from '../widgets/toast.js';

/**
 * Where the disk went.
 *
 * The question this answers is not "what is large" but "what is large and not
 * earning it". A game played every evening is not a candidate however big it
 * is, so every row shows size and last launch together, and the default order
 * puts the cold ones first.
 *
 * Nothing here is measured that Steam already knows. Epic knows neither size
 * nor last launch, so those rows say so and offer to measure — one game at a
 * time, because walking a hundred thousand files is not something to do behind
 * someone's back.
 */

const ICON_REFRESH = 'M20 11a8 8 0 10-2.3 5.7 M20 5v6h-6';
const ICON_FOLDER = 'M3 7h6l2 2h10v10H3z';
const ICON_TRASH = 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13';
const ICON_RULER = 'M4 14l10-10 6 6-10 10z M8 10l2 2 M11 7l2 2';

function bytes(value) {
  const n = Number(value) || 0;
  if (n <= 0) return '—';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  const gb = n / (1024 * 1024 * 1024);
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

function lastPlayedLabel(game) {
  if (!game.measured && game.source === 'epic') return 'Epic nennt keinen Spielstand';
  if (!game.lastPlayed) return 'nie gestartet';
  if (game.days === 0) return 'heute gespielt';
  if (game.days === 1) return 'gestern gespielt';
  if (game.days < 30) return `vor ${game.days} Tagen`;
  const months = Math.round(game.days / 30);
  if (months < 24) return `vor ${months} Monaten`;
  return `vor über ${Math.floor(game.days / 365)} Jahren`;
}

const ORDERS = [
  ['cold', 'Größe, Kaltes zuerst'],
  ['size', 'Nur Größe'],
  ['age', 'Wie lange nicht gespielt'],
  ['name', 'Name']
];

export function createStorageView() {
  let data = null;
  let order = 'cold';
  let filter = '';
  let busy = false;
  // Sizes measured in this session, keyed by install directory. Kept in the
  // view rather than written back: it is a snapshot, and a stale number on
  // disk would be worse than no number.
  const measured = new Map();

  const statusLine = el('span', { class: 'label', text: 'Wird gelesen …' });
  const listHost = el('div', { class: 'upd-list' });
  const driveHost = el('div', { class: 'stor-drives' });

  const search = el('input', {
    class: 'input',
    placeholder: 'Spiel suchen …',
    style: { maxWidth: '240px' },
    oninput: (event) => { filter = event.target.value.trim().toLowerCase(); render(); }
  });

  const orderSelect = el('select', {
    class: 'input',
    style: { maxWidth: '220px' },
    onchange: (event) => { order = event.target.value; render(); }
  }, ORDERS.map(([value, label]) => el('option', { value, text: label })));

  const refreshButton = el('button', { class: 'btn subtle' }, [
    svg(ICON_REFRESH, { width: 13, height: 13 }), 'Neu lesen'
  ]);

  /* ---------------------------------------------------------------- drives */

  function renderDrives() {
    clear(driveHost);
    const drives = (data && data.drives) || [];
    if (!drives.length) {
      driveHost.appendChild(el('div', { class: 'upd-hint', text: 'Keine Laufwerke gelesen.' }));
      return;
    }

    for (const drive of drives) {
      const used = Math.max(0, (drive.size || 0) - (drive.free || 0));
      const percent = drive.size ? Math.min(100, (used / drive.size) * 100) : 0;
      // Anything past ninety per cent is where Windows starts behaving badly,
      // which is the point at which this screen stops being curiosity.
      const tight = percent >= 90;

      driveHost.appendChild(el('div', { class: `stor-drive${tight ? ' tight' : ''}` }, [
        el('div', { class: 'row gap-8 between' }, [
          el('span', { class: 'stor-drive-name', text: `${drive.letter || drive.path} ${drive.label || ''}`.trim() }),
          el('span', { class: 'label', text: `${bytes(drive.free)} frei von ${bytes(drive.size)}` })
        ]),
        el('div', { class: 'upd-bar' }, [el('i', { style: { width: `${percent}%` } })]),
        tight ? el('div', { class: 'stor-drive-warn', text: 'Unter zehn Prozent frei.' }) : null
      ]));
    }
  }

  /* ----------------------------------------------------------------- games */

  function sortGames(games) {
    const list = [...games];
    if (order === 'size') return list.sort((a, b) => b.bytes - a.bytes);
    if (order === 'name') return list.sort((a, b) => a.name.localeCompare(b.name));
    if (order === 'age') {
      // Never launched sorts with the oldest, not with the newest: it is the
      // same answer for this purpose.
      return list.sort((a, b) => (b.days === null ? Infinity : b.days) - (a.days === null ? Infinity : a.days));
    }
    // "cold": size weighted by how long it has been sitting there. A large
    // game played yesterday drops below a middling one from last year.
    const weight = (g) => g.bytes * (g.staleness === 'cold' ? 3 : g.staleness === 'idle' ? 1.5 : 1);
    return list.sort((a, b) => weight(b) - weight(a));
  }

  function sizeCell(game) {
    const known = measured.get(game.installDir);
    if (game.measured) return bytes(game.bytes);
    if (known === 'pending') return 'wird gemessen …';
    if (typeof known === 'number') return bytes(known);
    return 'unbekannt';
  }

  async function measureGame(game) {
    if (!game.installDir) { notifyError('Kein Installationsordner bekannt'); return; }
    measured.set(game.installDir, 'pending');
    render();
    try {
      const result = await api.storage.measure(game.installDir);
      measured.set(game.installDir, result.bytes);
    } catch (err) {
      measured.delete(game.installDir);
      notifyError(err.message);
    }
    render();
  }

  async function uninstall(game) {
    const sure = await confirmDialog({
      title: `„${game.name}" entfernen`,
      message: `Steam wird gebeten, das Spiel zu deinstallieren, und fragt selbst noch einmal nach.\n\n`
        + `Frei würden etwa ${bytes(game.bytes)}. Spielstände liegen meist im Steam-Cloud-Speicher `
        + 'und bleiben erhalten, lokale Mods und Konfigurationen nicht immer.',
      confirmLabel: 'An Steam übergeben',
      width: '520px'
    });
    if (!sure) return;
    try {
      const result = await api.storage.uninstall(game.appId);
      notifyOk(result.note || 'An Steam übergeben');
    } catch (err) {
      notifyError(err.message);
    }
  }

  function gameRow(game) {
    return el('div', { class: 'upd-row' }, [
      el('span', { class: `stor-dot ${game.staleness}`, title: lastPlayedLabel(game) }),
      el('div', { class: 'stack gap-2 grow', style: { minWidth: '0' } }, [
        el('div', { class: 'upd-name truncate', text: game.name }),
        el('div', { class: 'upd-id truncate', text:
          `${game.source === 'steam' ? 'Steam' : 'Epic'} · ${lastPlayedLabel(game)}`
          + (game.drive ? ` · ${game.drive}` : '') })
      ]),
      el('div', { class: 'stor-size mono', text: sizeCell(game) }),
      !game.measured && game.installDir
        ? el('button', {
          class: 'btn subtle sm',
          title: 'Den Installationsordner durchzählen. Dauert bei großen Spielen.',
          disabled: measured.get(game.installDir) === 'pending' ? '' : null,
          onClick: () => measureGame(game)
        }, [svg(ICON_RULER, { width: 12, height: 12 }), 'Messen'])
        : null,
      game.installDir
        ? el('button', {
          class: 'btn subtle sm',
          title: 'Im Explorer zeigen',
          onClick: async () => {
            try { await api.files.reveal(game.installDir); } catch (err) { notifyError(err.message); }
          }
        }, [svg(ICON_FOLDER, { width: 12, height: 12 })])
        : null,
      game.source === 'steam'
        ? el('button', {
          class: 'btn danger sm',
          title: 'An Steam übergeben, damit es das Spiel entfernt',
          onClick: () => uninstall(game)
        }, [svg(ICON_TRASH, { width: 12, height: 12 })])
        : null
    ]);
  }

  /* ------------------------------------------------------------- rendering */

  function render() {
    renderDrives();
    clear(listHost);

    if (!data) {
      listHost.appendChild(el('div', { class: 'empty', style: { padding: '40px' } }, [
        el('div', { class: 'empty-title', text: 'Wird gelesen' }),
        el('div', { style: { fontSize: '12px' },
          text: 'Laufwerke und Spielebibliotheken werden abgefragt.' })
      ]));
      return;
    }

    const games = sortGames(
      data.games.filter((g) => !filter || g.name.toLowerCase().includes(filter))
    );

    if (!games.length) {
      listHost.appendChild(el('div', { class: 'empty', style: { padding: '40px' } }, [
        el('div', { class: 'empty-title', text: filter ? 'Kein Treffer' : 'Keine Spiele gefunden' }),
        el('div', { style: { fontSize: '12px' }, text: filter
          ? 'Andere Schreibweise probieren.'
          : 'Es wurde weder eine Steam- noch eine Epic-Bibliothek gefunden.' })
      ]));
      return;
    }

    for (const game of games) listHost.appendChild(gameRow(game));
    updateStatus();
  }

  function updateStatus() {
    if (!data) { statusLine.textContent = 'Wird gelesen …'; return; }
    const { totals } = data;
    const parts = [`${totals.games} Spiele`, `${bytes(totals.bytes)} belegt`];
    if (totals.coldCount) {
      parts.push(`${totals.coldCount} davon seit über einem Jahr nicht gestartet (${bytes(totals.coldBytes)})`);
    }
    if (totals.measured < totals.games) {
      parts.push(`${totals.games - totals.measured} ohne bekannte Größe`);
    }
    statusLine.textContent = parts.join(' · ');
  }

  async function load() {
    if (busy) return;
    busy = true;
    refreshButton.disabled = '';
    try {
      data = await api.storage.overview();
      render();
    } catch (err) {
      statusLine.textContent = err.message;
      notifyError(err.message);
    } finally {
      busy = false;
      refreshButton.removeAttribute('disabled');
    }
  }

  refreshButton.addEventListener('click', () => load());

  const view = el('section', { class: 'view fixed-height', id: 'view-storage' }, [
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h2', { class: 'glitch', dataset: { text: 'Speicher' }, text: 'Speicher' }),
        el('div', { class: 'view-sub', text: 'Was die Platte belegt und was es dafür zurückgibt' })
      ]),
      el('div', { class: 'view-actions' }, [search, orderSelect, refreshButton])
    ]),
    el('div', { class: 'upd-status' }, [statusLine]),
    driveHost,
    el('div', { class: 'upd-body' }, [listHost])
  ]);

  render();
  load();

  return view;
}
