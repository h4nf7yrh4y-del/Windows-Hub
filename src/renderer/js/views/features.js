import { el, clear, svg, debounce } from '../util.js';
import { api } from '../api.js';
import { confirmDialog } from '../widgets/modal.js';
import { notifyError, notifyOk, toast } from '../widgets/toast.js';

/**
 * Catalogue of Windows settings and tools.
 *
 * Four kinds of entry render differently, and the difference is the point:
 * a switch, a selector, a tool that has nothing to switch, and a switch that
 * needs administrator rights and says so before it prompts.
 */

const ICON_OPEN = ['M14 5h5v5', 'M19 5l-7 7', 'M19 13v6H5V5h6'];
const ICON_SHIELD = ['M12 3l8 3v6c0 4.5-3.2 7.9-8 9-4.8-1.1-8-4.5-8-9V6z'];
const ICON_TOOL = ['M14.7 6.3a4 4 0 01-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 015.4-5.4z'];

const NEEDS_LABEL = {
  explorer: 'Wirkt erst nach einem Neustart des Explorers.',
  reboot: 'Wirkt erst nach einem Neustart des PCs.',
  signout: 'Wirkt erst nach der nächsten Anmeldung.'
};

export function createFeaturesPanel() {
  let data = null;
  let filter = '';
  let category = 'Alle';

  const host = el('div', { class: 'feature-grid' });
  const tabsHost = el('div', { class: 'filter-tabs', style: { flexWrap: 'wrap' } });
  const statusLine = el('span', { class: 'label', text: 'Lade …' });

  const explorerBar = el('div', { class: 'panel notice hidden' }, [
    el('div', { class: 'notice-title', text: 'Neustart des Explorers nötig' }),
    el('div', { class: 'row between gap-12' }, [
      el('div', { class: 'notice-body', text:
        'Die geänderte Einstellung greift erst, wenn der Windows-Explorer neu startet. '
        + 'Dabei schließen sich offene Explorer-Fenster, laufende Programme bleiben unberührt.' }),
      el('button', {
        class: 'btn sm primary',
        text: 'Explorer neu starten',
        onClick: async (event) => {
          const button = event.currentTarget;
          button.setAttribute('aria-disabled', 'true');
          try {
            await api.features.restartExplorer();
            notifyOk('Explorer neu gestartet');
            explorerBar.classList.add('hidden');
          } catch (err) {
            notifyError(err.message);
          } finally {
            button.removeAttribute('aria-disabled');
          }
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
      const controllable = data.items.filter((i) => i.control).length;
      statusLine.textContent = data.supported
        ? `${data.items.length} Einträge · ${controllable} direkt steuerbar`
        : 'Nur unter Windows verfügbar';
    } catch (err) {
      statusLine.textContent = err.message;
    }
  }

  function renderTabs() {
    clear(tabsHost);
    for (const name of ['Alle', ...(data ? data.categories : [])]) {
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

  function afterChange(item, result) {
    if (result && result.needs === 'explorer') explorerBar.classList.remove('hidden');
    else if (item.needs && NEEDS_LABEL[item.needs]) toast(NEEDS_LABEL[item.needs], 'warn');
  }

  /** A single confirmation before the UAC prompt, so it is never a surprise. */
  async function confirmElevation(item) {
    return confirmDialog({
      title: item.name,
      message: 'Diese Einstellung gilt für den ganzen Rechner und braucht deshalb Administratorrechte. '
        + 'Windows fragt gleich nach. Der Hub selbst läuft weiterhin ohne erhöhte Rechte.',
      confirmLabel: 'Fortfahren'
    });
  }

  function toggleControl(item) {
    const control = item.control;
    const node = el('div', {
      class: 'toggle',
      role: 'switch',
      'aria-checked': String(control.value === true),
      title: control.value === null ? 'Windows benutzt hier noch den Standardwert' : ''
    });

    node.addEventListener('click', async () => {
      const next = node.getAttribute('aria-checked') !== 'true';
      if (control.elevated && !(await confirmElevation(item))) return;

      node.setAttribute('aria-checked', String(next));
      try {
        const result = await api.features.set(item.id, next);
        control.value = next;
        toast(`${item.name} ${next ? 'eingeschaltet' : 'ausgeschaltet'}`, 'ok');
        afterChange(item, result);
      } catch (err) {
        node.setAttribute('aria-checked', String(!next));
        notifyError(err.message);
      }
    });

    return node;
  }

  function choiceControl(item) {
    const control = item.control;
    const select = el('select', { class: 'select', style: { width: 'auto', minWidth: '132px', maxWidth: '210px' } });

    if (control.value === null) {
      select.appendChild(el('option', { value: '', text: 'Standard' }));
    }
    for (const option of control.options) {
      select.appendChild(el('option', { value: String(option.value), text: option.label }));
    }
    select.value = control.value === null ? '' : String(control.value);

    let previous = select.value;
    select.addEventListener('change', async () => {
      const chosen = select.value;
      if (!chosen) { select.value = previous; return; }
      if (control.elevated && !(await confirmElevation(item))) { select.value = previous; return; }

      try {
        const result = await api.features.set(item.id, chosen);
        previous = chosen;
        control.value = chosen;
        const label = (control.options.find((o) => String(o.value) === chosen) || {}).label || chosen;
        toast(`${item.name}: ${label}`, 'ok');
        afterChange(item, result);
      } catch (err) {
        select.value = previous;
        notifyError(err.message);
      }
    });

    return select;
  }

  function card(item) {
    const control = item.control;
    const controlNode = control
      ? (control.kind === 'choice' ? choiceControl(item) : toggleControl(item))
      : null;

    const actionButton = item.action
      ? el('button', {
        class: 'btn subtle sm',
        text: item.actionLabel || 'Ausführen',
        onClick: async () => {
          const sure = await confirmDialog({
            title: item.name,
            message: item.hint || 'Diese Aktion jetzt ausführen?',
            confirmLabel: item.actionLabel || 'Ausführen'
          });
          if (!sure) return;
          try {
            const result = await api.features.action(item.id);
            notifyOk(result.message || 'Erledigt');
            load();
          } catch (err) { notifyError(err.message); }
        }
      })
      : null;

    return el('div', { class: `feature-card${item.tool ? ' is-tool' : ''}` }, [
      el('div', { class: 'feature-head' }, [
        el('div', { class: 'feature-name', text: item.name }),
        el('span', { class: 'feature-cat', text: item.category })
      ]),
      el('div', { class: 'feature-desc', text: item.description }),
      item.hint ? el('div', { class: 'feature-hint', text: item.hint }) : null,
      item.needs && NEEDS_LABEL[item.needs]
        ? el('div', { class: 'feature-hint warn', text: NEEDS_LABEL[item.needs] })
        : null,

      el('div', { class: 'feature-actions' }, [
        item.canOpen
          ? el('button', {
            class: 'btn subtle sm',
            onClick: async () => {
              try { await api.features.open(item.id); } catch (err) { notifyError(err.message); }
            }
          }, [svg(ICON_OPEN, { width: 12, height: 12 }), item.tool ? 'Starten' : 'Öffnen'])
          : null,
        actionButton,
        el('div', { class: 'grow' }),
        // A tool has nothing to switch, and saying so beats an empty corner.
        item.tool && !control
          ? el('span', { class: 'badge', title: 'Ein Werkzeug, keine Einstellung' }, [
            svg(ICON_TOOL, { width: 11, height: 11 }), 'Werkzeug'
          ])
          : null,
        control && control.elevated
          ? el('span', { class: 'badge warn', title: 'Gilt für den ganzen Rechner, fragt nach Administratorrechten' }, [
            svg(ICON_SHIELD, { width: 11, height: 11 }), 'Admin'
          ])
          : null,
        controlNode
      ])
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
