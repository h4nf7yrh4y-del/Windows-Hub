import { el, clear, svg } from '../util.js';
import { api } from '../api.js';
import { notifyError, notifyOk, toast } from '../widgets/toast.js';

/**
 * Control panel for the floating performance widgets.
 * Each card toggles one overlay window and carries its own size, opacity and
 * click-through settings.
 */

const ICON_LOCK = ['M6 11h12v9H6z', 'M9 11V8a3 3 0 016 0v3'];
const ICON_CLOSE_ALL = 'M6 6l12 12M18 6L6 18';

const DESCRIPTIONS = {
  combo: 'CPU, RAM, GPU und Netzwerk als kompakte Balkenleiste. Die beste Wahl beim Spielen.',
  cpu: 'Prozessorauslastung mit Verlauf, Temperatur und Kernanzahl.',
  ram: 'Belegter Arbeitsspeicher mit Verlauf und absoluten Werten.',
  gpu: 'Grafikauslastung, Temperatur und Videospeicher.',
  net: 'Download- und Upload-Rate mit Verlauf.',
  disk: 'Lese- und Schreibdurchsatz aller Datenträger.',
  media: 'Titel, Interpret und Steuerung der aktuellen Wiedergabe, zum Beispiel aus Spotify.'
};

const SCALES = [
  { value: 0.85, label: 'S' },
  { value: 1, label: 'M' },
  { value: 1.25, label: 'L' },
  { value: 1.5, label: 'XL' }
];

export function createOverlaysView() {
  const grid = el('div', { class: 'overlay-grid' });
  const countLine = el('div', { class: 'view-sub', text: 'Lade …' });

  async function refresh() {
    let items = [];
    try {
      items = await api.overlays.list();
    } catch (err) {
      notifyError(err.message);
      return;
    }

    clear(grid);
    const open = items.filter((i) => i.open).length;
    countLine.textContent = open
      ? `${open} von ${items.length} Overlays aktiv`
      : `${items.length} Overlays verfügbar`;

    for (const item of items) grid.appendChild(card(item, refresh));
  }

  function card(item, reload) {
    const toggle = el('div', {
      class: 'toggle',
      role: 'switch',
      'aria-checked': String(item.open),
      onClick: async (event) => {
        const next = event.currentTarget.getAttribute('aria-checked') !== 'true';
        event.currentTarget.setAttribute('aria-checked', String(next));
        try {
          await api.overlays.set(item.type, next);
          await reload();
        } catch (err) {
          notifyError(err.message);
          await reload();
        }
      }
    });

    const scaleButtons = el('div', { class: 'seg' }, SCALES.map((s) => el('button', {
      class: `seg-btn${Math.abs(item.scale - s.value) < 0.01 ? ' active' : ''}`,
      text: s.label,
      title: `Größe ${s.label}`,
      onClick: async () => {
        try { await api.overlays.update(item.type, { scale: s.value }); await reload(); }
        catch (err) { notifyError(err.message); }
      }
    })));

    const opacity = el('input', {
      type: 'range',
      class: 'range',
      min: '30',
      max: '100',
      step: '5',
      value: String(Math.round(item.opacity * 100)),
      title: 'Deckkraft'
    });
    let opacityTimer = null;
    opacity.addEventListener('input', () => {
      if (opacityTimer) clearTimeout(opacityTimer);
      opacityTimer = setTimeout(() => {
        api.overlays.update(item.type, { opacity: Number(opacity.value) / 100 })
          .catch((err) => notifyError(err.message));
      }, 180);
    });

    const lock = el('button', {
      class: `btn sm ${item.locked ? 'primary' : 'subtle'}`,
      title: item.locked
        ? 'Fixiert: Klicks gehen durch das Overlay hindurch'
        : 'Fixieren: Klicks gehen durch das Overlay hindurch, es lässt sich dann nicht mehr ziehen',
      onClick: async () => {
        try {
          await api.overlays.update(item.type, { locked: !item.locked });
          toast(item.locked ? 'Overlay wieder beweglich' : 'Overlay fixiert, Klicks gehen hindurch', 'ok');
          await reload();
        } catch (err) { notifyError(err.message); }
      }
    }, [svg(ICON_LOCK, { width: 13, height: 13 }), item.locked ? 'Fixiert' : 'Fixieren']);

    return el('div', { class: `overlay-card${item.open ? ' active' : ''}` }, [
      el('div', { class: 'row between gap-12' }, [
        el('div', {}, [
          el('div', { class: 'overlay-name', text: item.label }),
          el('div', { class: 'overlay-type mono', text: item.type })
        ]),
        toggle
      ]),
      el('div', { class: 'overlay-desc', text: DESCRIPTIONS[item.type] || '' }),
      el('div', { class: 'overlay-controls' }, [
        el('div', { class: 'row between gap-8' }, [
          el('span', { class: 'label', text: 'Größe' }),
          scaleButtons
        ]),
        el('div', { class: 'row between gap-8' }, [
          el('span', { class: 'label', text: 'Deckkraft' }),
          opacity
        ]),
        el('div', { class: 'row between gap-8' }, [
          el('span', { class: 'label', text: 'Position' }),
          lock
        ])
      ])
    ]);
  }

  const view = el('section', { class: 'view', id: 'view-overlays' }, [
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h2', { class: 'glitch', dataset: { text: 'Overlays' }, text: 'Overlays' }),
        countLine
      ]),
      el('div', { class: 'view-actions' }, [
        el('button', { class: 'btn subtle', text: 'Aktualisieren', onClick: refresh }),
        el('button', {
          class: 'btn danger',
          onClick: async () => {
            try { await api.overlays.closeAll(); notifyOk('Alle Overlays geschlossen'); await refresh(); }
            catch (err) { notifyError(err.message); }
          }
        }, [svg(ICON_CLOSE_ALL, { width: 13, height: 13 }), 'Alle schließen'])
      ])
    ]),

    el('div', { class: 'panel notice' }, [
      el('div', { class: 'notice-title', text: 'Wichtig zur Sichtbarkeit' }),
      el('div', { class: 'notice-body', text:
        'Die Overlays erscheinen über normalen Fenstern und über Spielen im randlosen Fenstermodus. '
        + 'Über einem echten Vollbild-Spiel sind sie nicht sichtbar, weil Windows das Bild in diesem Modus '
        + 'direkt auf der Grafikkarte zusammensetzt. Stelle das Spiel auf "Randloses Fenster", dann funktioniert es.' })
    ]),

    el('div', { style: { height: '16px' } }),
    grid,

    el('div', { class: 'faint', style: { fontSize: '11.5px', marginTop: '18px', lineHeight: '1.7' } }, [
      el('div', { text: 'Ein Overlay lässt sich mit gedrückter Maustaste an eine beliebige Stelle ziehen. Die Position wird gemerkt.' }),
      el('div', { text: 'Fixierte Overlays nehmen keine Klicks mehr an, du klickst durch sie hindurch ins Spiel. Zum Verschieben die Fixierung wieder aufheben.' }),
      el('div', { text: 'Aktive Overlays öffnen sich beim nächsten Start des Hubs automatisch wieder.' })
    ])
  ]);

  refresh();

  // The overlay hotkey can open or close widgets while this panel is open.
  const unsubscribe = api.overlays.onChanged(() => refresh());
  view.addEventListener('view:unmount', () => { if (unsubscribe) unsubscribe(); });

  return view;
}
