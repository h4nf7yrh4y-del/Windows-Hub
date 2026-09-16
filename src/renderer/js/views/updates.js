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
  // Three slots rather than one result: each source is drawn the moment it
  // answers. winget can take a minute and a half, and a view that waits for
  // its slowest source is a view that is empty for a minute and a half.
  let data = { winget: null, steam: null, epic: null };
  // Whether the launchers are up needs a process list, which is the one slow
  // part of a game scan. It arrives separately and until it does the view says
  // so rather than guessing "zu".
  let clients = null;
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
    if (!winget) {
      return el('section', { class: 'upd-section' }, [
        sectionHead('Programme', 'winget wird abgefragt …'),
        el('div', { class: 'empty', style: { padding: '28px' } }, [
          el('div', { class: 'empty-title', text: 'Wird gesucht' }),
          el('div', { style: { fontSize: '12px' },
            text: 'winget fragt seine Quellen ab. Das dauert auf manchen Rechnern eine Minute.' })
        ])
      ]);
    }
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

  function steamGameRow(game) {
    const percent = game.bytesToDownload
      ? Math.min(100, (game.bytesDownloaded / game.bytesToDownload) * 100)
      : 0;

    return el('div', { class: 'upd-row' }, [
      el('span', { class: `upd-dot ${game.running ? 'busy' : 'wait'}` }),
      el('div', { class: 'stack gap-2 grow', style: { minWidth: '0' } }, [
        el('div', { class: 'upd-name truncate', text: game.name }),
        el('div', { class: 'upd-id truncate', text: game.running
          ? `Wird geladen${game.bytesToDownload ? ` · ${bytes(game.bytesDownloaded)} von ${bytes(game.bytesToDownload)}` : ''}`
          : `Update ausstehend${game.remainingBytes ? ` · ${bytes(game.remainingBytes)}` : ''}` }),
        game.bytesToDownload ? el('div', { class: 'upd-bar' }, [
          el('i', { style: { width: `${percent}%` } })
        ]) : null
      ]),
      el('button', {
        class: 'btn subtle sm',
        title: 'Steam aktualisiert das Spiel und startet es anschließend',
        onClick: () => steamGame(game, 'launch')
      }, ['Aktualisieren und starten']),
      el('button', {
        class: 'btn subtle sm',
        title: 'Steam prüft alle Dateien und lädt fehlende nach. Dauert bei großen Spielen.',
        onClick: () => steamGame(game, 'validate')
      }, ['Nur aktualisieren'])
    ]);
  }

  function renderSteam() {
    const steam = data.steam;
    // The head is built first and identically in both states. Dropping the
    // buttons while the list loads would take away an action that does not
    // depend on the list at all -- starting Steam's own update run works
    // whether or not the hub has finished reading the manifests.
    const head = sectionHead(
      'Steam-Spiele',
      !steam
        ? 'Bibliothek wird gelesen …'
        : (steam.available
          ? `${steam.installed} Spiele installiert · Client ${clients === null ? 'wird geprüft' : (clients.steam ? 'läuft' : 'ist zu')}. `
            + 'Der Download läuft über Steam; der Hub stößt ihn an und liest den Fortschritt aus den Manifesten.'
          : null),
      [
        el('button', {
          class: 'btn primary sm',
          title: 'Steam starten, falls nötig, und die Downloadliste öffnen',
          onClick: () => steamAll()
        }, [svg(ICON_DOWN, { width: 12, height: 12 }), 'Steam-Updates starten'])
      ]
    );

    if (!steam) return el('section', { class: 'upd-section' }, [head]);
    const block = el('section', { class: 'upd-section' }, [head]);

    if (!steam.available) {
      block.appendChild(el('div', { class: 'upd-hint', text: steam.note || 'Steam nicht gefunden.' }));
      return block;
    }

    if (!steam.games.length) {
      // With the client closed the list is an opinion from disk: Steam learns
      // that a game is out of date by talking to its servers, not by sitting
      // there. Saying that is the difference between "nothing to do" and
      // "nothing known".
      block.appendChild(el('div', { class: 'upd-hint', text: clients && clients.steam
        ? 'Kein Spiel ist als veraltet markiert.'
        : 'Kein Spiel ist als veraltet markiert — aber Steam ist zu, und es erfährt von Updates erst, '
          + 'wenn es läuft. Diese Liste ist bei geschlossenem Client nicht das letzte Wort.' }));
      return block;
    }

    for (const game of steam.games) block.appendChild(steamGameRow(game));
    return block;
  }

  function renderEpic() {
    const epic = data.epic;
    const head = sectionHead(
      'Epic Games',
      epic
        ? 'Der Launcher nennt keinen Aktualisierungsstand. Er bringt ein Spiel aber auf Stand, bevor er es startet — das ist der einzige Hebel, den er anbietet.'
        : 'Bibliothek wird gelesen …',
      [
        el('button', {
          class: 'btn primary sm',
          title: 'Launcher starten; er prüft beim Anmelden seine Bibliothek',
          onClick: () => epicAll()
        }, [svg(ICON_DOWN, { width: 12, height: 12 }), 'Launcher prüfen lassen'])
      ]
    );

    if (!epic) return el('section', { class: 'upd-section' }, [head]);
    const block = el('section', { class: 'upd-section' }, [head]);

    if (!epic.available || !epic.games.length) {
      block.appendChild(el('div', { class: 'upd-hint', text: epic.note
        || 'Keine installierten Epic-Spiele gefunden.' }));
      return block;
    }

    const games = epic.games
      .filter((g) => !filter || g.name.toLowerCase().includes(filter));

    for (const game of games) {
      block.appendChild(el('div', { class: 'upd-row' }, [
        el('span', { class: 'upd-dot' }),
        el('div', { class: 'stack gap-2 grow', style: { minWidth: '0' } }, [
          el('div', { class: 'upd-name truncate', text: game.name }),
          el('div', { class: 'upd-id truncate', text: 'Stand unbekannt — der Launcher prüft beim Start' })
        ]),
        el('button', {
          class: 'btn subtle sm',
          title: 'Der Launcher aktualisiert das Spiel und startet es anschließend',
          disabled: game.launchUri ? null : '',
          onClick: () => epicGame(game)
        }, ['Aktualisieren und starten'])
      ]));
    }
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
    // Each half reports for itself: a count that silently reads zero while its
    // source is still being asked is a wrong answer, not a pending one.
    const total = data.winget ? (data.winget.packages || []).length : 0;
    const steam = data.steam ? (data.steam.games || []).length : 0;
    const parts = [];
    if (!data.winget) parts.push('winget wird abgefragt …');
    else parts.push(total ? `${total} Programm${total === 1 ? '' : 'e'} aktualisierbar` : 'Programme aktuell');
    if (steam) parts.push(`${steam} Steam-Spiel${steam === 1 ? '' : 'e'} wartet auf Steam`);
    if (selected.size) parts.push(`${selected.size} ausgewählt`);
    statusLine.textContent = parts.join(' · ');
    allButton.disabled = running || !total ? '' : null;
    allButton.classList.toggle('off', running || !total);
  }

  function render() {
    clear(listHost);
    listHost.append(renderWinget(), renderSteam(), renderEpic(), renderSystem());
    updateCounts();
  }

  /* -------------------------------------------------------------- actions */

  async function open(what, id) {
    try {
      await api.updates.open(what, id);
    } catch (err) { notifyError(err.message); }
  }

  /* --------------------------------------------------------- game updates */

  let steamTimer = null;

  /**
   * Keeps the Steam rows current while a download runs.
   *
   * The manifests are rewritten by Steam as it downloads, so the progress is
   * real data rather than an animation. Polling only while something is
   * actually moving keeps it from reading the library every few seconds for
   * the rest of the session.
   */
  function watchSteam() {
    if (steamTimer) return;
    steamTimer = setInterval(async () => {
      try {
        const progress = await api.updates.steamProgress();
        if (!data.steam) return;
        data.steam = { ...data.steam, ...progress };
        render();
        if (!progress.games.some((g) => g.running)) stopWatchingSteam();
      } catch (_) { stopWatchingSteam(); }
    }, 4000);
  }

  function stopWatchingSteam() {
    if (steamTimer) clearInterval(steamTimer);
    steamTimer = null;
  }

  async function steamAll() {
    try {
      const result = await api.updates.steamAll();
      notifyOk(result.note);
      watchSteam();
    } catch (err) { notifyError(err.message); }
  }

  async function steamGame(game, mode) {
    if (mode === 'validate') {
      const sure = await confirmDialog({
        title: `„${game.name}" prüfen und aktualisieren`,
        message: 'Steam vergleicht jede einzelne Datei des Spiels mit dem Server und lädt nach, '
          + 'was fehlt oder veraltet ist.\n\n'
          + 'Das ist der einzige Weg, ein Spiel zu aktualisieren, ohne es zu starten — er liest '
          + 'dafür aber die gesamte Installation von der Festplatte und dauert bei großen Spielen '
          + 'einige Minuten.',
        confirmLabel: 'Prüfen',
        width: '520px'
      });
      if (!sure) return;
    }

    try {
      const result = await api.updates.steamGame(game.appId, mode);
      notifyOk(result.note);
      watchSteam();
    } catch (err) { notifyError(err.message); }
  }

  async function epicAll() {
    try {
      const result = await api.updates.epicAll();
      notifyOk(result.note);
    } catch (err) { notifyError(err.message); }
  }

  async function epicGame(game) {
    if (!game.launchUri) { notifyError('Für dieses Spiel steht keine Startadresse im Manifest'); return; }
    try {
      const result = await api.updates.epicGame(game.launchUri);
      notifyOk(result.note);
    } catch (err) { notifyError(err.message); }
  }

  /**
   * Asks both sources at once and draws each answer as it lands.
   *
   * The games come from local manifests and are there immediately; winget has
   * to reach its sources. Awaiting them together would hold the fast half
   * hostage to the slow one.
   */
  async function scan() {
    if (busy) return;
    busy = true;
    statusLine.textContent = 'Suche läuft …';
    scanButton.disabled = '';
    selected = new Set();
    render();

    const games = api.updates.scanGames().then((result) => {
      data.steam = result.steam;
      data.epic = result.epic;
      render();
      // Something may already be downloading from an earlier visit.
      if ((result.steam.games || []).some((g) => g.running)) watchSteam();
    }).catch((err) => notifyError(err.message));

    const running = api.updates.clients().then((result) => {
      clients = result;
      render();
    }).catch(() => { clients = null; });

    const packages = api.updates.scanWinget().then((result) => {
      data.winget = result.winget;
      render();
    }).catch((err) => {
      statusLine.textContent = err.message;
      notifyError(err.message);
    });

    try {
      await Promise.all([games, running, packages]);
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
        : `${((data.winget && data.winget.packages) || []).length} Programme werden nacheinander aktualisiert. `
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
    stopWatchingSteam();
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
