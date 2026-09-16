import { el, clear, svg, bytes, debounce } from '../util.js';
import { api } from '../api.js';
import { confirmDialog } from '../widgets/modal.js';
import { notifyError, notifyOk } from '../widgets/toast.js';

/**
 * What has an update waiting, and what the hub can do about it.
 *
 * The layout follows the honesty of the underlying module: one section the hub
 * can act on by itself, and two it can only report and hand over. Mixing them
 * into one list with the same buttons would be the easy design and the
 * dishonest one — a row that looks actionable and is not is worse than a row
 * that says so.
 */

const ICON_REFRESH = 'M20 11a8 8 0 10-2.3 5.7M20 5v6h-6';
const ICON_DOWN = 'M12 4v12M6 12l6 6 6-6';
const ICON_STOP = 'M6 6h12v12H6z';
const ICON_LINK = 'M10 14a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 10a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1';

export function createUpdatesView() {
  let data = null;
  let busy = false;
  let running = false;
  let filter = '';
  let selected = new Set();
  let releaseProgress = null;

  const statusLine = el('span', { class: 'label', text: 'Noch nicht gesucht' });
  const listHost = el('div', { class: 'upd-list' });
  const logHost = el('div', { class: 'upd-log' });
  const logPane = el('div', { class: 'upd-log-pane hidden' }, [
    el('div', { class: 'upd-log-head' }, [
      el('span', { class: 'label', text: 'Verlauf' }),
      el('button', {
        class: 'btn danger sm',
        text: 'Abbrechen',
        onClick: async () => {
          try {
            await api.updates.cancel();
            notifyOk('Abgebrochen');
          } catch (err) { notifyError(err.message); }
        }
      })
    ]),
    logHost
  ]);

  const search = el('input', {
    class: 'input',
    placeholder: 'Programm suchen …',
    style: { maxWidth: '260px' },
    oninput: debounce((event) => { filter = event.target.value.trim().toLowerCase(); render(); }, 160)
  });

  const scanButton = el('button', { class: 'btn subtle' }, [
    svg(ICON_REFRESH, { width: 13, height: 13 }), 'Suchen'
  ]);

  const allButton = el('button', { class: 'btn primary' }, [
    svg(ICON_DOWN, { width: 13, height: 13 }), 'Alle aktualisieren'
  ]);

  /* ------------------------------------------------------------- sections */

  function sectionHead(title, note, actions) {
    return el('div', { class: 'upd-section-head' }, [
      el('div', { class: 'stack gap-4', style: { minWidth: '0' } }, [
        el('div', { class: 'upd-section-title', text: title }),
        note ? el('div', { class: 'upd-section-note', text: note }) : null
      ]),
      actions ? el('div', { class: 'row gap-8' }, actions) : null
    ]);
  }

  function packageRow(pkg) {
    const checkbox = el('div', {
      class: 'upd-check',
      role: 'checkbox',
      'aria-checked': String(selected.has(pkg.id)),
      onClick: (event) => {
        const next = event.currentTarget.getAttribute('aria-checked') !== 'true';
        event.currentTarget.setAttribute('aria-checked', String(next));
        if (next) selected.add(pkg.id); else selected.delete(pkg.id);
        updateCounts();
      }
    });

    return el('div', { class: 'upd-row' }, [
      checkbox,
      el('div', { class: 'stack gap-2 grow', style: { minWidth: '0' } }, [
        el('div', { class: 'upd-name truncate', text: pkg.name }),
        el('div', { class: 'upd-id truncate mono', text: pkg.id })
      ]),
      el('div', { class: 'upd-version' }, [
        el('span', { class: 'upd-from', text: pkg.current }),
        el('span', { class: 'upd-arrow', text: '→' }),
        el('span', { class: 'upd-to', text: pkg.available })
      ]),
      el('button', {
        class: 'btn subtle sm',
        text: 'Aktualisieren',
        disabled: running ? '' : null,
        onClick: () => upgrade(pkg.id, pkg.name)
      })
    ]);
  }

  function renderWinget() {
    const winget = data.winget;
    const packages = (winget.packages || [])
      .filter((p) => !filter || p.name.toLowerCase().includes(filter) || p.id.toLowerCase().includes(filter));

    const block = el('section', { class: 'upd-section' }, [
      sectionHead(
        'Programme',
        winget.available
          ? 'Über winget, den Paketmanager von Windows. Diese Einträge kann der Hub selbst installieren.'
          : null
      )
    ]);

    if (!winget.available) {
      block.appendChild(el('div', { class: 'panel notice' }, [
        el('div', { class: 'notice-title', text: 'winget steht nicht zur Verfügung' }),
        el('div', { class: 'notice-body', text: winget.note || 'Unbekannter Grund.' })
      ]));
      return block;
    }

    if (!packages.length) {
      block.appendChild(el('div', { class: 'empty', style: { padding: '28px' } }, [
        el('div', { class: 'empty-title', text: filter ? 'Kein Treffer' : 'Alles aktuell' }),
        el('div', { style: { fontSize: '12px' }, text: filter
          ? 'Andere Schreibweise probieren.'
          : 'winget kennt für die installierten Programme keine neuere Version.' })
      ]));
      return block;
    }

    for (const pkg of packages) block.appendChild(packageRow(pkg));
    return block;
  }

  function renderSteam() {
    const steam = data.steam;
    const block = el('section', { class: 'upd-section' }, [
      sectionHead(
        'Steam-Spiele',
        'Steam lädt selbst herunter. Der Hub liest den Zustand aus den Manifesten und übergibt an den Client.',
        [
          el('button', {
            class: 'btn subtle sm',
            title: 'Downloadliste in Steam öffnen',
            onClick: () => open('steam-downloads')
          }, [svg(ICON_LINK, { width: 12, height: 12 }), 'Downloads in Steam'])
        ]
      )
    ]);

    if (!steam.available) {
      block.appendChild(el('div', { class: 'upd-hint', text: steam.note || 'Steam nicht gefunden.' }));
      return block;
    }

    if (!steam.games.length) {
      block.appendChild(el('div', { class: 'upd-hint', text:
        'Kein Spiel ist als veraltet markiert. Steam merkt das selbst erst, wenn der Client läuft — '
        + 'bei geschlossenem Steam ist diese Liste also nicht das letzte Wort.' }));
      return block;
    }

    for (const game of steam.games) {
      block.appendChild(el('div', { class: 'upd-row' }, [
        el('span', { class: `upd-dot ${game.running ? 'busy' : 'wait'}` }),
        el('div', { class: 'stack gap-2 grow', style: { minWidth: '0' } }, [
          el('div', { class: 'upd-name truncate', text: game.name }),
          el('div', { class: 'upd-id truncate', text: game.running
            ? 'Wird gerade aktualisiert'
            : `Update ausstehend${game.remainingBytes ? ` · ${bytes(game.remainingBytes)}` : ''}` })
        ]),
        el('button', {
          class: 'btn subtle sm',
          title: 'Steam öffnen, damit der Download startet',
          onClick: () => open('steam-downloads')
        }, ['In Steam öffnen'])
      ]));
    }
    return block;
  }

  function renderEpic() {
    const epic = data.epic;
    const block = el('section', { class: 'upd-section' }, [
      sectionHead(
        'Epic Games',
        'Der Launcher veröffentlicht keinen Aktualisierungsstand. Der Hub kann ihn nur öffnen.',
        [
          el('button', {
            class: 'btn subtle sm',
            onClick: () => open('epic')
          }, [svg(ICON_LINK, { width: 12, height: 12 }), 'Launcher öffnen'])
        ]
      )
    ]);

    if (!epic.available || !epic.games.length) {
      block.appendChild(el('div', { class: 'upd-hint', text: epic.note
        || 'Keine installierten Epic-Spiele gefunden.' }));
      return block;
    }

    block.appendChild(el('div', { class: 'upd-hint', text:
      `${epic.games.length} installierte Spiele. Ob eines davon veraltet ist, weiß nur der Launcher selbst.` }));
    return block;
  }

  function renderSystem() {
    return el('section', { class: 'upd-section' }, [
      sectionHead('System', 'Windows-Updates und Store-Apps laufen über ihre eigenen Stellen.'),
      el('div', { class: 'row gap-8' }, [
        el('button', { class: 'btn subtle sm', onClick: () => open('windows-update') },
          [svg(ICON_LINK, { width: 12, height: 12 }), 'Windows Update']),
        el('button', { class: 'btn subtle sm', onClick: () => open('store') },
          [svg(ICON_LINK, { width: 12, height: 12 }), 'Microsoft Store'])
      ]),
      el('div', { class: 'upd-hint', text:
        'Windows-Updates lassen sich ohne erhöhte Rechte und ohne Zusatzmodul nicht auslösen. '
        + 'Ein Knopf, der so tut, wäre schlimmer als einer, der weiterleitet.' })
    ]);
  }

  /* ------------------------------------------------------------ rendering */

  function updateCounts() {
    if (!data) return;
    const total = (data.winget.packages || []).length;
    const steam = (data.steam.games || []).length;
    const parts = [];
    parts.push(total ? `${total} Programm${total === 1 ? '' : 'e'} aktualisierbar` : 'Programme aktuell');
    if (steam) parts.push(`${steam} Steam-Spiel${steam === 1 ? '' : 'e'} wartet auf Steam`);
    if (selected.size) parts.push(`${selected.size} ausgewählt`);
    statusLine.textContent = parts.join(' · ');
    allButton.disabled = running || !total ? '' : null;
    allButton.classList.toggle('off', running || !total);
  }

  function render() {
    clear(listHost);
    if (!data) {
      listHost.appendChild(el('div', { class: 'empty', style: { padding: '40px' } }, [
        el('div', { class: 'empty-title', text: 'Noch nicht gesucht' }),
        el('div', { style: { fontSize: '12px' }, text: 'Die Suche fragt winget, die Steam-Manifeste und die Epic-Bibliothek ab.' })
      ]));
      return;
    }
    listHost.append(renderWinget(), renderSteam(), renderEpic(), renderSystem());
    updateCounts();
  }

  /* -------------------------------------------------------------- actions */

  async function open(what, id) {
    try {
      await api.updates.open(what, id);
    } catch (err) { notifyError(err.message); }
  }

  async function scan() {
    if (busy) return;
    busy = true;
    statusLine.textContent = 'Suche läuft …';
    scanButton.disabled = '';
    try {
      data = await api.updates.scan();
      selected = new Set();
      render();
    } catch (err) {
      statusLine.textContent = err.message;
      notifyError(err.message);
    } finally {
      busy = false;
      scanButton.removeAttribute('disabled');
    }
  }

  function appendLog(text, stream) {
    logHost.appendChild(el('div', { class: `upd-log-line${stream === 'err' ? ' err' : ''}`, text }));
    logHost.scrollTop = logHost.scrollHeight;
  }

  async function upgrade(id, label) {
    const sure = await confirmDialog({
      title: id ? `„${label}" aktualisieren` : 'Alle aktualisieren',
      message: id
        ? `winget installiert die neue Version von „${label}". Das Programm sollte dabei geschlossen sein.\n\n`
          + 'Manche Installationsprogramme verlangen erhöhte Rechte — dann erscheint die Windows-Abfrage.'
        : `${(data.winget.packages || []).length} Programme werden nacheinander aktualisiert. `
          + 'Das kann je nach Größe dauern und einzelne Programme beenden.\n\n'
          + 'Manche Installationsprogramme verlangen erhöhte Rechte — dann erscheint die Windows-Abfrage.',
      confirmLabel: 'Aktualisieren',
      width: '520px'
    });
    if (!sure) return;

    clear(logHost);
    logPane.classList.remove('hidden');
    running = true;
    updateCounts();
    render();

    try {
      await api.updates.run(id || null);
      appendLog(id ? `Aktualisierung von ${label} gestartet` : 'Aktualisierung aller Programme gestartet');
    } catch (err) {
      running = false;
      notifyError(err.message);
      render();
    }
  }

  /* ---------------------------------------------------------------- shell */

  scanButton.addEventListener('click', () => scan());
  allButton.addEventListener('click', () => upgrade(null, null));

  const view = el('section', { class: 'view fixed-height', id: 'view-updates' }, [
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h2', { class: 'glitch', dataset: { text: 'Updates' }, text: 'Updates' }),
        el('div', { class: 'view-sub', text: 'Programme, Spiele und System auf einen Blick' })
      ]),
      el('div', { class: 'view-actions' }, [search, scanButton, allButton])
    ]),
    el('div', { class: 'upd-status' }, [statusLine]),
    el('div', { class: 'upd-body' }, [listHost, logPane])
  ]);

  function bind() {
    if (releaseProgress) return;
    releaseProgress = api.updates.onProgress((event) => {
      if (event.kind === 'line') { appendLog(event.text, event.stream); return; }
      if (event.kind === 'done') {
        running = false;
        appendLog(event.ok
          ? `Fertig nach ${Math.round((event.ms || 0) / 1000)} s`
          : `Beendet mit Code ${event.code ?? '?'}${event.error ? ` (${event.error})` : ''}`,
        event.ok ? 'out' : 'err');
        if (event.ok) notifyOk('Aktualisierung abgeschlossen');
        // The list is stale the moment something was installed.
        scan();
      }
    });
  }

  view.addEventListener('view:mount', bind);
  view.addEventListener('view:unmount', () => {
    if (releaseProgress) { releaseProgress(); releaseProgress = null; }
  });

  bind();
  render();

  // Reading winget takes several seconds; starting it on mount means the list
  // is usually there by the time someone has read the heading.
  api.updates.state().then((current) => {
    if (current.running) {
      running = true;
      logPane.classList.remove('hidden');
      for (const line of current.lines || []) appendLog(line, 'out');
    }
    scan();
  }).catch(() => scan());

  return view;
}
