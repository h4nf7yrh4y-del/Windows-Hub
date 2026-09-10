import { el, clear, svg, bytes, debounce } from '../util.js';
import { api } from '../api.js';
import { confirmDialog, openModal } from '../widgets/modal.js';
import { notifyError, notifyOk, notifyWarn, toast } from '../widgets/toast.js';

/**
 * File manager.
 *
 * Deletes go to the recycle bin, never straight to oblivion. Copy and move run
 * through an in-app clipboard so the same selection can be pasted repeatedly.
 */

const ICONS = {
  folder:   ['M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z'],
  file:     ['M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z', 'M14 3v5h5'],
  app:      ['M4 4h16v16H4z', 'M9 9h6v6H9z'],
  image:    ['M4 5h16v14H4z', 'M4 16l4.5-4.5 3 3L15 11l5 5'],
  video:    ['M4 6h16v12H4z', 'M10 9.5l5 2.5-5 2.5z'],
  audio:    ['M9 18V6l10-2v12', 'M9 18a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM19 16a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z'],
  archive:  ['M4 6h16v14H4z', 'M4 6l2-3h12l2 3', 'M12 10v5'],
  text:     ['M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z', 'M8 13h8M8 17h5'],
  code:     ['M9 8l-4 4 4 4M15 8l4 4-4 4'],
  document: ['M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z', 'M14 3v5h5', 'M8 13h8M8 17h6'],
  drive:    ['M3 6h18v6H3z', 'M3 12h18v6H3z', 'M7 9h.01M7 15h.01']
};

const ICON_UP = 'M12 19V5M5 12l7-7 7 7';
const ICON_REFRESH = ['M20 11a8 8 0 10-2.3 5.6', 'M20 5v6h-6'];
const ICON_NEW_FOLDER = ['M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z', 'M12 11v4M10 13h4'];
const ICON_TRASH = 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13';

const SORTS = {
  name: (a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }),
  size: (a, b) => a.size - b.size,
  modified: (a, b) => a.modified - b.modified,
  kind: (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
};

function formatDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.toLocaleDateString('de-DE')} ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
}

export function createFilesView() {
  let current = null;         // last listing payload
  let entries = [];
  let selection = new Set();  // paths
  let lastAnchor = null;
  let sortKey = 'name';
  let sortDir = 'asc';
  let filter = '';
  let clipboard = null;       // { mode: 'copy'|'move', paths: [] }
  let history = [];
  let historyIndex = -1;
  let searchMode = false;

  const sidebar = el('div', { class: 'fm-sidebar' });
  const listBody = el('tbody');
  const breadcrumb = el('div', { class: 'fm-crumbs' });
  const statusLine = el('div', { class: 'fm-status', text: '' });
  const selectionLine = el('div', { class: 'fm-status', text: '' });

  const search = el('input', {
    class: 'input',
    placeholder: 'Filtern, Enter = Suche',
    style: { maxWidth: '260px' }
  });

  search.addEventListener('input', debounce(() => {
    if (searchMode) return;
    filter = search.value.trim().toLowerCase();
    renderList();
  }, 140));

  search.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' || !current) return;
    const query = search.value.trim();
    if (!query) return;
    statusLine.textContent = `Suche „${query}" …`;
    try {
      const result = await api.files.search(current.path, query);
      searchMode = true;
      entries = result.results;
      selection.clear();
      renderList();
      statusLine.textContent = result.results.length
        ? `${result.results.length} Treffer${result.truncated ? ' (begrenzt)' : ''}${result.timedOut ? ', Zeitlimit erreicht' : ''}`
        : 'Keine Treffer';
    } catch (err) {
      notifyError(err.message);
    }
  });

  /* --------------------------------------------------------------- loading */

  async function navigate(target, { push = true } = {}) {
    try {
      const data = await api.files.list(target);
      current = data;
      entries = data.entries;
      selection.clear();
      lastAnchor = null;
      searchMode = false;
      filter = '';
      search.value = '';

      if (push) {
        history = history.slice(0, historyIndex + 1);
        history.push(data.path);
        historyIndex = history.length - 1;
      }

      renderCrumbs();
      renderList();
      statusLine.textContent = data.truncated
        ? `${data.entries.length} von ${data.total} Einträgen (begrenzt)`
        : `${data.entries.length} Einträge`;
    } catch (err) {
      notifyError(err.message);
      statusLine.textContent = err.message;
    }
  }

  async function reload() {
    if (current) await navigate(current.path, { push: false });
  }

  async function loadSidebar() {
    clear(sidebar);
    // The quick locations come from Electron itself and are instant; the drive
    // list needs a system query that can take seconds on a busy machine.
    // Waiting for both would leave the sidebar blank for that whole time.
    const drivesPromise = api.files.drives().catch(() => []);
    const quick = await api.files.quickLocations().catch(() => []);

    if (quick.length) {
      sidebar.appendChild(el('div', { class: 'fm-side-title', text: 'Schnellzugriff' }));
      for (const item of quick) {
        sidebar.appendChild(el('button', {
          class: 'fm-side-btn',
          onClick: () => navigate(item.path)
        }, [svg(ICONS.folder, { width: 15, height: 15 }), el('span', { class: 'truncate', text: item.label })]));
      }
    }

    const drivesTitle = el('div', { class: 'fm-side-title', text: 'Laufwerke' });
    const drivesHost = el('div', { class: 'fm-side-drives' }, [
      el('div', { class: 'fm-side-pending', text: 'wird gelesen …' })
    ]);
    sidebar.appendChild(drivesTitle);
    sidebar.appendChild(drivesHost);

    const drives = await drivesPromise;
    // The sidebar may have been rebuilt or torn down while the query ran.
    if (!drivesHost.isConnected) return;
    clear(drivesHost);

    if (!drives.length) {
      drivesHost.appendChild(el('div', { class: 'fm-side-pending', text: 'keine gefunden' }));
    } else {
      for (const drive of drives) {
        const usedPct = drive.size ? ((drive.size - drive.free) / drive.size) * 100 : 0;
        drivesHost.appendChild(el('button', {
          class: 'fm-side-btn drive',
          title: `${drive.path} · ${bytes(drive.free)} frei von ${bytes(drive.size)}`,
          onClick: () => navigate(drive.path)
        }, [
          svg(ICONS.drive, { width: 15, height: 15 }),
          el('div', { class: 'grow', style: { minWidth: '0' } }, [
            el('div', { class: 'truncate', text: `${drive.letter || drive.path} ${drive.label}` }),
            drive.size ? el('div', { class: 'fm-drive-meter' }, [
              el('i', { style: { width: `${usedPct}%` } })
            ]) : null,
            drive.size ? el('div', { class: 'fm-drive-sub', text: `${bytes(drive.free)} frei` }) : null
          ])
        ]));
      }
    }
  }

  /* ------------------------------------------------------------ rendering */

  function renderCrumbs() {
    clear(breadcrumb);
    if (!current) return;
    const parts = current.path.split(/[\\/]/).filter(Boolean);
    const isWin = /^[a-z]:$/i.test(parts[0] || '');
    let accum = isWin ? `${parts[0]}\\` : '/';

    breadcrumb.appendChild(el('button', {
      class: 'crumb',
      text: isWin ? parts[0] : '/',
      onClick: () => navigate(accum)
    }));

    parts.slice(isWin ? 1 : 0).forEach((part) => {
      accum = accum.endsWith('\\') || accum.endsWith('/') ? accum + part : `${accum}\\${part}`;
      const target = accum;
      breadcrumb.appendChild(el('span', { class: 'crumb-sep', text: '›' }));
      breadcrumb.appendChild(el('button', { class: 'crumb', text: part, onClick: () => navigate(target) }));
    });
  }

  function visibleEntries() {
    let list = entries.slice();
    if (filter && !searchMode) list = list.filter((e) => e.name.toLowerCase().includes(filter));
    const cmp = SORTS[sortKey] || SORTS.name;
    const dir = sortDir === 'desc' ? -1 : 1;
    list.sort((a, b) => {
      // Folders always group above files, regardless of sort column.
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return cmp(a, b) * dir;
    });
    return list;
  }

  function updateSelectionLine() {
    if (!selection.size) { selectionLine.textContent = ''; return; }
    const picked = entries.filter((e) => selection.has(e.path));
    const totalBytes = picked.reduce((sum, e) => sum + (e.isDir ? 0 : e.size), 0);
    selectionLine.textContent = `${selection.size} ausgewählt · ${bytes(totalBytes)}`;
  }

  function renderList() {
    const list = visibleEntries();
    clear(listBody);
    const frag = document.createDocumentFragment();

    for (const entry of list) {
      const icon = ICONS[entry.kind] || ICONS.file;
      const row = el('tr', {
        class: selection.has(entry.path) ? 'selected' : '',
        title: entry.path,
        onClick: (event) => handleSelect(entry, event, list),
        onDblClick: () => activate(entry)
      }, [
        el('td', {}, [
          el('div', { class: `fm-name kind-${entry.kind}` }, [
            svg(icon, { width: 15, height: 15 }),
            el('span', { class: 'truncate', text: entry.name }),
            entry.isLink ? el('span', { class: 'fm-link-mark', text: '↗' }) : null
          ])
        ]),
        el('td', { class: 'num', text: entry.isDir ? '—' : bytes(entry.size) }),
        el('td', { text: entry.isDir ? 'Ordner' : (entry.ext ? entry.ext.toUpperCase() : 'Datei') }),
        el('td', { class: 'num', text: formatDate(entry.modified) })
      ]);
      frag.appendChild(row);
    }

    listBody.appendChild(frag);

    if (!list.length) {
      listBody.appendChild(el('tr', {}, [
        el('td', { colspan: '4' }, [
          el('div', { class: 'empty', style: { padding: '40px' } }, [
            el('div', { class: 'empty-title', text: searchMode ? 'Keine Treffer' : 'Leerer Ordner' })
          ])
        ])
      ]));
    }
    updateSelectionLine();
  }

  function handleSelect(entry, event, list) {
    if (event.ctrlKey || event.metaKey) {
      if (selection.has(entry.path)) selection.delete(entry.path);
      else selection.add(entry.path);
      lastAnchor = entry.path;
    } else if (event.shiftKey && lastAnchor) {
      const from = list.findIndex((e) => e.path === lastAnchor);
      const to = list.findIndex((e) => e.path === entry.path);
      if (from >= 0 && to >= 0) {
        selection.clear();
        for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) selection.add(list[i].path);
      }
    } else {
      selection.clear();
      selection.add(entry.path);
      lastAnchor = entry.path;
    }
    renderList();
  }

  async function activate(entry) {
    if (entry.isDir) { await navigate(entry.path); return; }
    try {
      await api.files.open(entry.path);
    } catch (err) {
      notifyError(err.message);
    }
  }

  /* ------------------------------------------------------------- commands */

  function selectedPaths() { return Array.from(selection); }

  async function doNewFolder() {
    if (!current) return;
    const input = el('input', { class: 'input', placeholder: 'Ordnername', value: 'Neuer Ordner' });
    openModal({
      title: 'Neuer Ordner',
      width: '440px',
      render: () => el('div', { class: 'field' }, [el('label', { text: 'Name' }), input]),
      actions: (close) => [
        el('button', { class: 'btn subtle', text: 'Abbrechen', onClick: () => close() }),
        el('button', {
          class: 'btn primary',
          text: 'Anlegen',
          onClick: async () => {
            try {
              await api.files.createFolder(current.path, input.value);
              close();
              await reload();
              notifyOk('Ordner angelegt');
            } catch (err) { notifyError(err.message); }
          }
        })
      ]
    });
  }

  async function doRename() {
    const paths = selectedPaths();
    if (paths.length !== 1) { notifyWarn('Genau einen Eintrag auswählen'); return; }
    const entry = entries.find((e) => e.path === paths[0]);
    const input = el('input', { class: 'input', value: entry.name });
    openModal({
      title: 'Umbenennen',
      width: '440px',
      render: () => el('div', { class: 'field' }, [el('label', { text: 'Neuer Name' }), input]),
      actions: (close) => [
        el('button', { class: 'btn subtle', text: 'Abbrechen', onClick: () => close() }),
        el('button', {
          class: 'btn primary',
          text: 'Umbenennen',
          onClick: async () => {
            try {
              await api.files.rename(entry.path, input.value);
              close();
              await reload();
              notifyOk('Umbenannt');
            } catch (err) { notifyError(err.message); }
          }
        })
      ]
    });
  }

  async function doTrash() {
    const paths = selectedPaths();
    if (!paths.length) { notifyWarn('Nichts ausgewählt'); return; }
    const sure = await confirmDialog({
      title: 'In den Papierkorb',
      message: paths.length === 1
        ? `„${paths[0].split(/[\\/]/).pop()}" wird in den Papierkorb verschoben.`
        : `${paths.length} Einträge werden in den Papierkorb verschoben.`,
      confirmLabel: 'Verschieben',
      danger: true
    });
    if (!sure) return;
    try {
      const result = await api.files.trash(paths);
      if (result.failed) notifyError(`${result.failed} Einträge konnten nicht gelöscht werden`);
      else notifyOk(`${result.results.length} in den Papierkorb verschoben`);
      await reload();
    } catch (err) { notifyError(err.message); }
  }

  function doClipboard(mode) {
    const paths = selectedPaths();
    if (!paths.length) { notifyWarn('Nichts ausgewählt'); return; }
    clipboard = { mode, paths };
    toast(`${paths.length} Einträge ${mode === 'copy' ? 'kopiert' : 'ausgeschnitten'}`, 'ok');
    updatePasteButton();
  }

  async function doPaste() {
    if (!clipboard || !current) { notifyWarn('Zwischenablage ist leer'); return; }
    const { mode, paths } = clipboard;
    statusLine.textContent = `${mode === 'copy' ? 'Kopiere' : 'Verschiebe'} ${paths.length} Einträge …`;
    try {
      const result = await api.files.transfer(paths, current.path, mode);
      if (result.failed) {
        const first = result.results.find((r) => !r.ok);
        notifyError(`${result.failed} fehlgeschlagen: ${first ? first.error : ''}`);
      } else {
        notifyOk(`${result.results.length} Einträge ${mode === 'copy' ? 'kopiert' : 'verschoben'}`);
      }
      if (mode === 'move') { clipboard = null; updatePasteButton(); }
      await reload();
    } catch (err) {
      notifyError(err.message);
      await reload();
    }
  }

  async function doProperties() {
    const paths = selectedPaths();
    const target = paths.length === 1 ? paths[0] : (current && current.path);
    if (!target) return;
    try {
      const info = await api.files.info(target);
      const body = el('div', { class: 'kv-list' });
      const add = (k, v) => body.appendChild(el('div', { class: 'kv' }, [
        el('span', { class: 'kv-key', text: k }),
        el('span', { class: 'kv-val', style: { maxWidth: '380px', wordBreak: 'break-all' }, text: String(v) })
      ]));
      add('Name', info.name);
      add('Pfad', info.path);
      add('Typ', info.isDir ? 'Ordner' : 'Datei');
      if (!info.isDir) add('Größe', `${bytes(info.size)} (${info.size.toLocaleString('de-DE')} Bytes)`);
      add('Geändert', formatDate(info.modified));
      add('Erstellt', formatDate(info.created));
      add('Schreibgeschützt', info.readOnly ? 'ja' : 'nein');

      const sizeLine = el('div', { class: 'kv' }, [
        el('span', { class: 'kv-key', text: 'Inhalt' }),
        el('span', { class: 'kv-val', text: info.isDir ? 'wird berechnet …' : '—' })
      ]);
      if (info.isDir) {
        body.appendChild(sizeLine);
        api.files.folderSize(info.path).then((res) => {
          sizeLine.querySelector('.kv-val').textContent =
            `${bytes(res.bytes)} · ${res.files} Dateien · ${res.folders} Ordner${res.complete ? '' : ' (Zeitlimit)'}`;
        }).catch(() => {
          sizeLine.querySelector('.kv-val').textContent = 'nicht ermittelbar';
        });
      }

      openModal({
        title: 'Eigenschaften',
        width: '560px',
        render: () => body,
        actions: (close) => [
          el('button', { class: 'btn subtle', text: 'Im Explorer zeigen', onClick: () => api.files.reveal(info.path).catch((e) => notifyError(e.message)) }),
          el('button', { class: 'btn primary', text: 'Schließen', onClick: () => close() })
        ]
      });
    } catch (err) { notifyError(err.message); }
  }

  const pasteButton = el('button', {
    class: 'btn subtle sm',
    text: 'Einfügen',
    'aria-disabled': 'true',
    onClick: doPaste
  });

  function updatePasteButton() {
    pasteButton.setAttribute('aria-disabled', clipboard ? 'false' : 'true');
    pasteButton.textContent = clipboard
      ? `Einfügen (${clipboard.paths.length})`
      : 'Einfügen';
  }

  /* --------------------------------------------------------------- layout */

  function sortHeader(key, label, extraClass = '') {
    const th = el('th', {
      class: extraClass,
      text: label,
      onClick: () => {
        if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else { sortKey = key; sortDir = 'asc'; }
        renderHead();
        renderList();
      }
    });
    if (sortKey === key) {
      th.dataset.sorted = sortDir;
      th.dataset.arrow = sortDir === 'asc' ? '▲' : '▼';
    }
    return th;
  }

  const thead = el('thead');
  function renderHead() {
    clear(thead);
    thead.appendChild(el('tr', {}, [
      sortHeader('name', 'Name'),
      sortHeader('size', 'Größe', 'num'),
      sortHeader('kind', 'Typ'),
      sortHeader('modified', 'Geändert', 'num')
    ]));
  }
  renderHead();

  const view = el('section', { class: 'view fixed-height', id: 'view-files' }, [
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h2', { class: 'glitch', dataset: { text: 'Dateien' }, text: 'Dateien' }),
        statusLine
      ]),
      el('div', { class: 'view-actions' }, [
        search,
        el('button', { class: 'btn subtle sm', onClick: () => reload() }, [svg(ICON_REFRESH, { width: 13, height: 13 })])
      ])
    ]),

    el('div', { class: 'fm-toolbar' }, [
      el('button', {
        class: 'icon-btn',
        title: 'Zurück',
        onClick: () => {
          if (historyIndex > 0) { historyIndex -= 1; navigate(history[historyIndex], { push: false }); }
        }
      }, [svg('M15 19l-7-7 7-7', { width: 16, height: 16 })]),
      el('button', {
        class: 'icon-btn',
        title: 'Vorwärts',
        onClick: () => {
          if (historyIndex < history.length - 1) { historyIndex += 1; navigate(history[historyIndex], { push: false }); }
        }
      }, [svg('M9 5l7 7-7 7', { width: 16, height: 16 })]),
      el('button', {
        class: 'icon-btn',
        title: 'Übergeordneter Ordner',
        onClick: () => { if (current && current.parent) navigate(current.parent); }
      }, [svg(ICON_UP, { width: 16, height: 16 })]),
      breadcrumb
    ]),

    el('div', { class: 'fm-actions' }, [
      el('button', { class: 'btn subtle sm', onClick: doNewFolder }, [svg(ICON_NEW_FOLDER, { width: 13, height: 13 }), 'Neuer Ordner']),
      el('button', { class: 'btn subtle sm', text: 'Kopieren', onClick: () => doClipboard('copy') }),
      el('button', { class: 'btn subtle sm', text: 'Ausschneiden', onClick: () => doClipboard('move') }),
      pasteButton,
      el('button', { class: 'btn subtle sm', text: 'Umbenennen', onClick: doRename }),
      el('button', { class: 'btn subtle sm', text: 'Eigenschaften', onClick: doProperties }),
      el('button', {
        class: 'btn subtle sm',
        text: 'Im Explorer',
        onClick: () => {
          const target = selectedPaths()[0] || (current && current.path);
          if (target) api.files.reveal(target).catch((err) => notifyError(err.message));
        }
      }),
      el('div', { class: 'grow' }),
      selectionLine,
      el('button', { class: 'btn danger sm', onClick: doTrash }, [svg(ICON_TRASH, { width: 13, height: 13 }), 'Papierkorb'])
    ]),

    el('div', { class: 'fm-body' }, [
      sidebar,
      el('div', { class: 'table-wrap grow' }, [
        el('table', { class: 'table fm-table' }, [thead, listBody])
      ])
    ])
  ]);

  /* ---------------------------------------------------------- keyboard */

  function onKey(event) {
    if (!view.isConnected) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (document.querySelector('.modal-backdrop')) return;

    if (event.key === 'Delete') { event.preventDefault(); doTrash(); }
    else if (event.key === 'F2') { event.preventDefault(); doRename(); }
    else if (event.key === 'Backspace') {
      event.preventDefault();
      if (current && current.parent) navigate(current.parent);
    } else if (event.key === 'F5') {
      event.preventDefault();
      reload();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault(); doClipboard('copy');
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'x') {
      event.preventDefault(); doClipboard('move');
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
      event.preventDefault(); doPaste();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selection = new Set(visibleEntries().map((e) => e.path));
      renderList();
    }
  }

  document.addEventListener('keydown', onKey);
  view.addEventListener('view:unmount', () => document.removeEventListener('keydown', onKey));
  view.addEventListener('view:mount', () => {
    // Idempotent: adding the same listener twice is a no-op in the DOM.
    document.addEventListener('keydown', onKey);
    reload();
  });

  loadSidebar();
  api.files.quickLocations()
    .then((quick) => navigate(quick.length ? quick[0].path : (navigator.platform.startsWith('Win') ? 'C:\\' : '/')))
    .catch(() => navigate('/'));

  return view;
}
