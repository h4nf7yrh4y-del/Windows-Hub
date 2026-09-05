import { el, clear, svg, debounce } from '../util.js';
import { api } from '../api.js';
import { confirmDialog } from '../widgets/modal.js';
import { notifyError, notifyOk } from '../widgets/toast.js';

/**
 * Autostart manager: everything Windows launches at sign-in.
 *
 * Entries can be removed or revealed, not toggled. Windows keeps the
 * enabled/disabled state in binary StartupApproved blobs; writing those wrong
 * leaves an entry no tool can restore, so the honest options are "keep" and
 * "remove" rather than a switch that half works.
 */

const ICON_TRASH = 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13';
const ICON_REVEAL = ['M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z'];

const SCOPE_BADGE = {
  'Benutzer': 'accent',
  'Benutzer (Ordner)': 'accent',
  'Benutzer (einmalig)': 'warn',
  'System': 'warn',
  'System (32-Bit)': 'warn',
  'System (Ordner)': 'warn'
};

export function createStartupPanel() {
  let entries = [];
  let filter = '';
  const tbody = el('tbody');
  const statusLine = el('span', { class: 'label', text: 'Lade …' });

  const search = el('input', {
    class: 'input',
    placeholder: 'Eintrag suchen …',
    style: { maxWidth: '260px' },
    oninput: debounce((event) => { filter = event.target.value.trim().toLowerCase(); render(); }, 150)
  });

  async function load() {
    statusLine.textContent = 'Lade …';
    try {
      const data = await api.startup.list();
      if (!data.supported) {
        entries = [];
        statusLine.textContent = 'Nur unter Windows verfügbar';
        render();
        return;
      }
      entries = data.entries;
      statusLine.textContent = `${entries.length} Autostart-Einträge`;
      render();
    } catch (err) {
      statusLine.textContent = `Fehler: ${err.message}`;
    }
  }

  async function removeEntry(entry) {
    const sure = await confirmDialog({
      title: 'Autostart-Eintrag entfernen',
      message: `„${entry.name}" wird aus dem Autostart entfernt. `
        + (entry.source === 'folder'
          ? 'Die Verknüpfung wandert in den Papierkorb.'
          : 'Der Registry-Eintrag wird gelöscht.')
        + ' Das Programm selbst bleibt installiert, startet aber nicht mehr automatisch mit Windows.',
      confirmLabel: 'Entfernen',
      danger: true
    });
    if (!sure) return;
    try {
      const result = await api.startup.remove(entry.id);
      notifyOk(`${result.name} entfernt (${result.method})`);
      await load();
    } catch (err) {
      notifyError(`${err.message}. Systemweite Einträge brauchen Administratorrechte.`);
    }
  }

  function render() {
    const list = filter
      ? entries.filter((e) => e.name.toLowerCase().includes(filter) || e.command.toLowerCase().includes(filter))
      : entries;

    clear(tbody);

    if (!list.length) {
      tbody.appendChild(el('tr', {}, [
        el('td', { colspan: '4' }, [
          el('div', { class: 'empty', style: { padding: '40px' } }, [
            el('div', { class: 'empty-title', text: entries.length ? 'Keine Treffer' : 'Keine Einträge' })
          ])
        ])
      ]));
      return;
    }

    for (const entry of list) {
      tbody.appendChild(el('tr', { title: entry.command }, [
        el('td', {}, [
          el('div', { class: 'stack', style: { minWidth: '0' } }, [
            el('div', { style: { fontWeight: '600' }, text: entry.name }),
            el('div', { class: 'mono truncate', style: { fontSize: '10.5px', color: 'var(--text-faint)', maxWidth: '520px' }, text: entry.command || '—' })
          ])
        ]),
        el('td', {}, [
          el('span', { class: `badge ${SCOPE_BADGE[entry.scope] || ''}`, text: entry.scope })
        ]),
        el('td', {}, [
          el('span', { class: 'badge', text: entry.source === 'folder' ? 'Ordner' : 'Registry' })
        ]),
        el('td', { class: 'num col-actions' }, [
          el('div', { class: 'row gap-4', style: { justifyContent: 'flex-end' } }, [
            el('button', {
              class: 'icon-btn',
              title: 'Speicherort öffnen',
              onClick: () => api.startup.reveal(entry.id).catch((err) => notifyError(err.message))
            }, [svg(ICON_REVEAL, { width: 14, height: 14 })]),
            el('button', {
              class: 'icon-btn danger',
              title: 'Aus Autostart entfernen',
              onClick: () => removeEntry(entry)
            }, [svg(ICON_TRASH, { width: 14, height: 14 })])
          ])
        ])
      ]));
    }
  }

  const panel = el('div', { class: 'stack grow', style: { display: 'flex', flexDirection: 'column', minHeight: '0' } }, [
    el('div', { class: 'proc-toolbar' }, [
      search,
      el('button', { class: 'btn subtle sm', text: 'Aktualisieren', onClick: load }),
      el('div', { class: 'grow' }),
      el('div', { class: 'proc-summary' }, [statusLine])
    ]),
    el('div', {
      class: 'faint',
      style: { fontSize: '11.5px', marginBottom: '10px', lineHeight: '1.6' },
      text: 'Entfernen löscht nur den Autostart-Eintrag, nicht das Programm. '
        + 'Einträge unter „System" gehören allen Benutzern und lassen sich nur mit Administratorrechten entfernen. '
        + 'Ein An- und Abschalten wie im Windows-Task-Manager bietet der Hub bewusst nicht, weil Windows diesen Zustand in einem Binärformat ablegt, das sich schlecht zuverlässig zurückschreiben lässt.'
    }),
    el('div', { class: 'table-wrap grow' }, [
      el('table', { class: 'table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'Eintrag', style: { cursor: 'default' } }),
            el('th', { text: 'Bereich', style: { cursor: 'default' } }),
            el('th', { text: 'Quelle', style: { cursor: 'default' } }),
            el('th', { text: '', style: { cursor: 'default' } })
          ])
        ]),
        tbody
      ])
    ])
  ]);

  load();
  return panel;
}
