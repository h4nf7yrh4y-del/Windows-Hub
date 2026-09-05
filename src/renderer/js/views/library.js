import { el, clear, debounce, bytes } from '../util.js';
import { api } from '../api.js';
import { state, loadLibrary } from '../state.js';
import { notifyError, notifyOk, toast } from '../widgets/toast.js';

/**
 * Everything the scanner found: Steam and Epic games, Start Menu shortcuts and
 * Windows apps. Doubles as a quick launcher and as the source for profiles.
 */

const FILTERS = [
  { id: 'all',       label: 'Alle',        test: () => true },
  { id: 'game',      label: 'Spiele',      test: (i) => i.kind === 'game' },
  { id: 'steam',     label: 'Steam',       test: (i) => i.source === 'steam' },
  { id: 'epic',      label: 'Epic',        test: (i) => i.source === 'epic' },
  { id: 'app',       label: 'Programme',   test: (i) => i.kind === 'app' },
  { id: 'uwp',       label: 'Windows-Apps',test: (i) => i.kind === 'uwp' }
];

const iconCache = new Map();

async function attachIcon(node, item) {
  const target = item.exe || (item.launch && item.launch.type === 'exe' ? item.launch.target : null);
  if (!target) return;
  if (iconCache.has(target)) {
    const cached = iconCache.get(target);
    if (cached) node.replaceChildren(el('img', { src: cached, alt: '' }));
    return;
  }
  try {
    const dataUrl = await api.library.icon(target);
    iconCache.set(target, dataUrl);
    if (dataUrl) node.replaceChildren(el('img', { src: dataUrl, alt: '' }));
  } catch (_) {
    iconCache.set(target, null);
  }
}

export function createLibraryView() {
  let activeFilter = 'all';
  let query = '';

  const grid = el('div', { class: 'lib-grid' });
  const countLine = el('div', { class: 'view-sub', text: 'Noch nicht gescannt' });

  const search = el('input', {
    class: 'input',
    placeholder: 'Suchen …',
    style: { maxWidth: '260px' },
    oninput: debounce((event) => { query = event.target.value.trim().toLowerCase(); render(); }, 150)
  });

  const tabs = el('div', { class: 'filter-tabs' }, FILTERS.map((f) => el('button', {
    class: `filter-tab${f.id === activeFilter ? ' active' : ''}`,
    text: f.label,
    dataset: { filter: f.id },
    onClick: (event) => {
      activeFilter = f.id;
      tabs.querySelectorAll('.filter-tab').forEach((t) => t.classList.toggle('active', t.dataset.filter === f.id));
      render();
      event.currentTarget.blur();
    }
  })));

  async function launch(item) {
    try {
      await api.library.launch(item.launch);
      notifyOk(`${item.name} gestartet`);
    } catch (err) {
      notifyError(`${item.name}: ${err.message}`);
    }
  }

  function card(item) {
    const iconHost = el('div', { class: 'lib-icon' }, [
      el('span', { class: 'lib-initial', text: item.name.charAt(0).toUpperCase() })
    ]);
    attachIcon(iconHost, item);

    return el('div', {
      class: 'lib-card',
      title: item.launch ? item.launch.target : item.name,
      onClick: () => launch(item)
    }, [
      iconHost,
      el('div', { class: 'lib-meta grow' }, [
        el('div', { class: 'lib-name truncate', text: item.name }),
        el('div', { class: 'lib-src', text: item.sizeOnDisk ? `${item.source} · ${bytes(item.sizeOnDisk)}` : item.source })
      ])
    ]);
  }

  function render() {
    clear(grid);
    const library = state.library;
    if (!library) {
      grid.appendChild(el('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, [
        el('div', { class: 'empty-title', text: 'Bibliothek leer' }),
        el('div', { text: 'Starte einen Scan, um installierte Spiele und Programme zu finden.' })
      ]));
      return;
    }

    const filterDef = FILTERS.find((f) => f.id === activeFilter) || FILTERS[0];
    const items = (library.items || [])
      .filter(filterDef.test)
      .filter((i) => !query || i.name.toLowerCase().includes(query));

    countLine.textContent = `${items.length} von ${library.items.length} Einträgen`;

    if (!items.length) {
      grid.appendChild(el('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, [
        el('div', { class: 'empty-title', text: 'Nichts gefunden' })
      ]));
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of items.slice(0, 400)) frag.appendChild(card(item));
    grid.appendChild(frag);
  }

  async function scan(force) {
    countLine.textContent = 'Scanne …';
    try {
      await loadLibrary({ force });
      render();
      toast(`${state.library.items.length} Einträge gefunden`, 'ok');
    } catch (err) {
      countLine.textContent = `Scan fehlgeschlagen: ${err.message}`;
      notifyError(err.message);
    }
  }

  const view = el('section', { class: 'view', id: 'view-library' }, [
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h2', { class: 'glitch', dataset: { text: 'Bibliothek' }, text: 'Bibliothek' }),
        countLine
      ]),
      el('div', { class: 'view-actions' }, [
        search,
        el('button', { class: 'btn subtle', text: 'Neu scannen', onClick: () => scan(true) })
      ])
    ]),
    tabs,
    el('div', { style: { height: '14px' } }),
    grid
  ]);

  if (state.library) render();
  else scan(false);

  return view;
}
