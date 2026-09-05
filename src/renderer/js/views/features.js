import { el, clear, svg, debounce } from '../util.js';
import { api } from '../api.js';
import { confirmDialog } from '../widgets/modal.js';
import { notifyError, notifyOk, toast } from '../widgets/toast.js';

/**
 * Catalogue of Windows settings and tools worth knowing about.
 *
 * Switches only ever appear for per-user settings that need no elevation and
 * are reversible in one click. Everything heavier is shown read-only with a
 * button that opens the Windows page which owns it, because a switch whose
 * effect the user cannot predict is worse than no switch.
 */

const ICON_OPEN = ['M14 5h5v5', 'M19 5l-7 7', 'M19 13v6H5V5h6'];

export function createFeaturesPanel() {
  let data = null;
  let filter = '';
  let category = 'Alle';
  let explorerPending = false;

  const host = el('div', { class: 'feature-grid' });
  const tabsHost = el('div', { class: 'filter-tabs', style: { flexWrap: 'wrap' } });
  const statusLine = el('span', { class: 'label', text: 'Lade …' });
  const explorerBar = el('div', { class: 'panel notice hidden' }, [
    el('div', { class: 'notice-title', text: 'Neustart des Explorers nötig' }),
    el('div', { class: 'row between gap-12' }, [
      el('div', { class: 'notice-body', text:
        'Die geänderte Einstellung greift erst, wenn der Windows-Explorer neu startet. '
        + 'Dabei schließen sich offene Explorer-Fenster, geöffnete Programme bleiben unberührt.' }),
      el('button', {
        class: 'btn sm primary',
        text: 'Explorer neu starten',
        onClick: async () => {
          try {
            await api.features.restartExplorer();
            notifyOk('Explorer neu gestartet');
            explorerPending = false;
            explorerBar.classList.add('hidden');
          } catch (err) { notifyError(err.message); }
        }
      })
    ])
  ]);

  const search = el('input', {
    class: 'input',
    placeholder: 'Funktion suchen …',
    style: { maxWidth: '260px' },
    oninput: debounce((event) => { filter = event.target.value.trim().toLowerCase(); render(); }, 150)
  });

  async function load() {
    statusLine.textContent = 'Lese Einstellungen …';
    try {
      data = await api.features.list();
      renderTabs();
      render();
      statusLine.textContent = data.supported
        ? `${data.items.length} Einträge`
        : 'Nur unter Windows verfügbar';
    } catch (err) {
      statusLine.textContent = err.message;
    }
  }

  function renderTabs() {
    clear(tabsHost);
    const all = ['Alle', ...(data ? data.categories : [])];
    for (const name of all) {
      tabsHost.appendChild(el('button', {
        class: `filter-tab${name === category ? ' active' : ''}`,
        text: name,
        onClick: (event) => {
          category = name;
          tabsHost.querySelectorAll('.filter-tab').forEach((t) => t.classList.toggle('active', t.textContent === name));
          render();
          event.currentTarget.blur();
        }
      }));
    }
  }

  function card(item) {
    const toggle = item.canToggle
      ? el('div', {
        class: 'toggle',
        role: 'switch',
        'aria-checked': String(item.state === true),
        title: item.state === null ? 'Windows benutzt hier noch den Standardwert' : '',
        onClick: async (event) => {
          const next = event.currentTarget.getAttribute('aria-checked') !== 'true';
          event.currentTarget.setAttribute('aria-checked', String(next));
          try {
            const result = await api.features.toggle(item.id, next);
            item.state = next;
            if (result.needs === 'explorer') {
              explorerPending = true;
              explorerBar.classList.remove('hidden');
            }
            toast(`${item.name} ${next ? 'eingeschaltet' : 'ausgeschaltet'}`, 'ok');
          } catch (err) {
            event.currentTarget.setAttribute('aria-checked', String(!next));
            notifyError(err.message);
          }
        }
      })
      : null;

    const stateBadge = !item.canToggle && item.state !== null && item.state !== undefined
      ? el('span', { class: `badge ${item.state ? 'ok' : ''}`, text: item.state ? 'aktiv' : 'inaktiv' })
      : null;

    const actions = el('div', { class: 'row gap-8', style: { marginTop: 'auto', paddingTop: '12px' } }, [
      item.canOpen
        ? el('button', {
          class: 'btn subtle sm',
          onClick: async () => {
            try { await api.features.open(item.id); } catch (err) { notifyError(err.message); }
          }
        }, [svg(ICON_OPEN, { width: 12, height: 12 }), 'Öffnen'])
        : null,
      item.action
        ? el('button', {
          class: 'btn subtle sm',
          text: 'Anlegen',
          onClick: async () => {
            const sure = await confirmDialog({
              title: item.name,
              message: 'Auf dem Desktop wird ein Ordner „Alle Einstellungen" angelegt, der alle Systemsteuerungs-Einträge auflistet. Du kannst ihn jederzeit löschen.',
              confirmLabel: 'Anlegen'
            });
            if (!sure) return;
            try {
              const result = await api.features.action(item.id);
              notifyOk(result.message || 'Angelegt');
            } catch (err) { notifyError(err.message); }
          }
        })
        : null,
      el('div', { class: 'grow' }),
      item.readOnly ? el('span', { class: 'badge', text: 'nur lesbar' }) : null,
      stateBadge,
      toggle
    ]);

    return el('div', { class: 'feature-card' }, [
      el('div', { class: 'feature-head' }, [
        el('div', { class: 'feature-name', text: item.name }),
        el('span', { class: 'feature-cat', text: item.category })
      ]),
      el('div', { class: 'feature-desc', text: item.description }),
      item.hint ? el('div', { class: 'feature-hint', text: item.hint }) : null,
      item.needs === 'explorer'
        ? el('div', { class: 'feature-hint', style: { color: 'var(--warn)' }, text: 'Wirkt erst nach einem Neustart des Explorers.' })
        : null,
      actions
    ]);
  }

  function render() {
    clear(host);
    if (!data || !data.supported) {
      host.appendChild(el('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, [
        el('div', { class: 'empty-title', text: 'Nur unter Windows verfügbar' })
      ]));
      return;
    }

    const items = data.items
      .filter((i) => category === 'Alle' || i.category === category)
      .filter((i) => !filter
        || i.name.toLowerCase().includes(filter)
        || i.description.toLowerCase().includes(filter)
        || (i.hint || '').toLowerCase().includes(filter));

    if (!items.length) {
      host.appendChild(el('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, [
        el('div', { class: 'empty-title', text: 'Nichts gefunden' })
      ]));
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of items) frag.appendChild(card(item));
    host.appendChild(frag);
  }

  const panel = el('div', { class: 'tab-body', style: { overflowY: 'auto' } }, [
    el('div', { class: 'proc-toolbar' }, [
      search,
      el('button', { class: 'btn subtle sm', text: 'Neu einlesen', onClick: load }),
      el('div', { class: 'grow' }),
      el('div', { class: 'proc-summary' }, [statusLine])
    ]),
    tabsHost,
    el('div', { style: { height: '12px' } }),
    explorerBar,
    host
  ]);

  load();
  return panel;
}
