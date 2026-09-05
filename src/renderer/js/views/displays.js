import { el, clear, svg } from '../util.js';
import { api } from '../api.js';
import { openModal } from '../widgets/modal.js';
import { notifyError, notifyOk, notifyWarn, toast } from '../widgets/toast.js';

/**
 * Monitor control.
 *
 * A resolution change can black out the screen, so it is never applied
 * outright: the main process reverts after fifteen seconds unless the change
 * is confirmed here. The countdown is a courtesy; the safety net is the timer
 * in main, which fires even when nothing on screen is readable.
 */

const ICON_MONITOR = ['M3 5h18v11H3z', 'M9 20h6M12 16v4'];
const ICON_SUN = ['M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4',
  'M12 8a4 4 0 100 8 4 4 0 000-8z'];

const PROJECTION_MODES = [
  { id: 'internal', label: 'Nur Hauptbildschirm' },
  { id: 'clone', label: 'Duplizieren' },
  { id: 'extend', label: 'Erweitern' },
  { id: 'external', label: 'Nur zweiter' }
];

const SETTINGS_LINKS = [
  { page: 'display', label: 'Anzeigeeinstellungen' },
  { page: 'nightlight', label: 'Nachtmodus' },
  { page: 'advanced', label: 'Erweiterte Anzeige' },
  { page: 'graphics', label: 'Grafikeinstellungen' },
  { page: 'hdr', label: 'HDR' }
];

export function createDisplaysPanel() {
  let data = null;
  const host = el('div', { class: 'stack gap-16' });
  const statusLine = el('span', { class: 'label', text: 'Lade …' });

  async function load() {
    statusLine.textContent = 'Lese Bildschirme …';
    try {
      data = await api.display.list();
      render();
      statusLine.textContent = data.supported
        ? `${data.monitors.length} Bildschirm${data.monitors.length === 1 ? '' : 'e'}`
        : 'Nicht verfügbar';
    } catch (err) {
      statusLine.textContent = err.message;
      clear(host).appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'empty-title', text: 'Fehler' }),
        el('div', { text: err.message })
      ]));
    }
  }

  /* ------------------------------------------------------------ brightness */

  function brightnessRow(monitor) {
    const info = monitor.brightness || {};
    if (!info.supported) {
      return el('div', { class: 'kv' }, [
        el('span', { class: 'kv-key', text: 'Helligkeit' }),
        el('span', {
          class: 'kv-val faint',
          style: { fontFamily: 'var(--font-body)', textAlign: 'right', maxWidth: '320px' },
          text: 'Nicht steuerbar. Externe Monitore brauchen dafür DDC/CI, das im Monitormenü oft abgeschaltet ist.'
        })
      ]);
    }

    const value = el('span', { class: 'mono', style: { minWidth: '44px', textAlign: 'right' }, text: `${info.value ?? 0}%` });
    const slider = el('input', {
      type: 'range',
      class: 'range',
      min: '0',
      max: '100',
      step: '5',
      value: String(info.value ?? 50),
      style: { width: '180px' }
    });

    let timer = null;
    slider.addEventListener('input', () => {
      value.textContent = `${slider.value}%`;
      if (timer) clearTimeout(timer);
      // Each change is a PowerShell round trip, so only the value the user
      // settles on is actually sent.
      timer = setTimeout(async () => {
        try {
          await api.display.brightness(
            { source: info.source, ddcIndex: info.ddcIndex },
            Number(slider.value)
          );
        } catch (err) {
          notifyError(err.message);
        }
      }, 320);
    });

    return el('div', { class: 'row gap-12', style: { padding: '8px 0' } }, [
      svg(ICON_SUN, { width: 15, height: 15 }),
      el('span', { class: 'kv-key', style: { minWidth: '78px' }, text: 'Helligkeit' }),
      slider,
      value,
      el('span', { class: 'badge', text: info.source === 'panel' ? 'Notebook' : 'DDC/CI' })
    ]);
  }

  /* ----------------------------------------------------------- resolution */

  async function applyMode(monitor, mode) {
    let result;
    try {
      result = await api.display.setMode(monitor.device, mode);
    } catch (err) {
      notifyError(err.message);
      return;
    }

    let remaining = Math.round(result.revertInMs / 1000);
    const counter = el('span', { class: 'mono', text: `${remaining}` });
    let interval = null;
    let settled = false;

    const finish = async (keep, close) => {
      if (settled) return;
      settled = true;
      if (interval) clearInterval(interval);
      if (keep) {
        try {
          await api.display.confirmMode();
          notifyOk(`${mode.width} × ${mode.height} bei ${mode.refresh} Hz übernommen`);
        } catch (err) { notifyError(err.message); }
      } else {
        // Letting the timer run is the revert; main handles it either way.
        toast('Wird zurückgesetzt …');
      }
      close();
      setTimeout(load, keep ? 500 : result.revertInMs + 1500);
    };

    const { close } = openModal({
      title: 'Auflösung beibehalten?',
      width: '480px',
      render: () => el('div', { class: 'stack gap-12' }, [
        el('div', { style: { fontSize: '13.5px', lineHeight: '1.6' },
          text: `${monitor.name} läuft jetzt mit ${mode.width} × ${mode.height} bei ${mode.refresh} Hz.` }),
        el('div', { class: 'faint', style: { fontSize: '12px', lineHeight: '1.6' } }, [
          'Ohne Bestätigung wird in ', counter,
          ' Sekunden automatisch auf ',
          `${result.previous.width} × ${result.previous.height} bei ${result.previous.refresh} Hz`,
          ' zurückgestellt. Wenn du dieses Fenster nicht lesen kannst, warte einfach ab.'
        ])
      ]),
      actions: (closeFn) => [
        el('button', { class: 'btn subtle', text: 'Zurücksetzen', onClick: () => finish(false, closeFn) }),
        el('button', { class: 'btn primary', text: 'Beibehalten', onClick: () => finish(true, closeFn) })
      ],
      onClose: () => { if (!settled) finish(false, () => {}); }
    });

    interval = setInterval(() => {
      remaining -= 1;
      counter.textContent = String(Math.max(0, remaining));
      if (remaining <= 0) finish(false, close);
    }, 1000);
  }

  function modeSelector(monitor) {
    const select = el('select', { class: 'select', style: { maxWidth: '260px' } });
    const current = `${monitor.width}x${monitor.height}@${monitor.refresh}`;

    for (const mode of monitor.modes) {
      const key = `${mode.width}x${mode.height}@${mode.refresh}`;
      select.appendChild(el('option', {
        value: key,
        text: `${mode.width} × ${mode.height} · ${mode.refresh} Hz`
      }));
    }
    if (monitor.modes.length) select.value = current;

    return el('div', { class: 'row gap-12', style: { padding: '8px 0' } }, [
      el('span', { class: 'kv-key', style: { minWidth: '78px' }, text: 'Auflösung' }),
      select,
      el('button', {
        class: 'btn subtle sm',
        text: 'Anwenden',
        onClick: () => {
          const [size, refresh] = select.value.split('@');
          const [width, height] = size.split('x');
          if (select.value === current) { notifyWarn('Das ist bereits die aktive Auflösung'); return; }
          applyMode(monitor, { width: Number(width), height: Number(height), refresh: Number(refresh) });
        }
      })
    ]);
  }

  /* --------------------------------------------------------------- render */

  function monitorPanel(monitor, index) {
    return el('div', { class: 'panel bracketed' }, [
      el('span', { class: 'bracket tl' }), el('span', { class: 'bracket tr' }),
      el('span', { class: 'bracket bl' }), el('span', { class: 'bracket br' }),
      el('div', { class: 'panel-head' }, [
        el('div', { class: 'panel-title' }, [`Bildschirm ${index + 1}`]),
        el('div', { class: 'row gap-8' }, [
          monitor.primary
            ? el('span', { class: 'badge accent', text: 'Hauptbildschirm' })
            : el('button', {
              class: 'btn subtle sm',
              text: 'Als Hauptbildschirm',
              onClick: async () => {
                try {
                  await api.display.setPrimary(monitor.device);
                  notifyOk(`${monitor.name} ist jetzt der Hauptbildschirm`);
                  setTimeout(load, 800);
                } catch (err) { notifyError(err.message); }
              }
            })
        ])
      ]),
      el('div', { class: 'row gap-12', style: { marginBottom: '10px' } }, [
        svg(ICON_MONITOR, { width: 20, height: 20 }),
        el('div', { class: 'stack', style: { minWidth: '0' } }, [
          el('div', { style: { fontFamily: 'var(--font-display)', fontSize: '14px', letterSpacing: '0.05em' }, text: monitor.name }),
          el('div', { class: 'mono', style: { fontSize: '10.5px', color: 'var(--text-faint)' },
            text: `${monitor.width} × ${monitor.height} · ${monitor.refresh} Hz · ${monitor.depth} Bit · Position ${monitor.x}/${monitor.y}` })
        ])
      ]),
      brightnessRow(monitor),
      monitor.modes.length ? modeSelector(monitor) : null,
      el('div', { class: 'faint', style: { fontSize: '10.5px', marginTop: '6px' }, text: monitor.adapter })
    ]);
  }

  function render() {
    clear(host);
    if (!data || !data.supported) {
      host.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'empty-title', text: 'Nicht verfügbar' }),
        el('div', { text: (data && data.note) || 'Bildschirmsteuerung ist nur unter Windows verfügbar.' })
      ]));
      return;
    }

    host.appendChild(el('div', { class: 'panel notice' }, [
      el('div', { class: 'notice-title', text: 'Bevor du die Auflösung änderst' }),
      el('div', { class: 'notice-body', text:
        'Eine nicht unterstützte Auflösung kann den Bildschirm schwarz lassen. Der Hub stellt deshalb nach fünfzehn Sekunden '
        + 'automatisch zurück, wenn du nicht bestätigst. Falls du nichts mehr siehst: einfach warten, nichts drücken.' })
    ]));

    for (const [index, monitor] of data.monitors.entries()) {
      host.appendChild(monitorPanel(monitor, index));
    }

    host.appendChild(el('div', { class: 'panel bracketed' }, [
      el('span', { class: 'bracket tl' }), el('span', { class: 'bracket tr' }),
      el('span', { class: 'bracket bl' }), el('span', { class: 'bracket br' }),
      el('div', { class: 'panel-head' }, [el('div', { class: 'panel-title', text: 'Anzeigemodus' })]),
      el('div', { class: 'row gap-8', style: { flexWrap: 'wrap' } }, PROJECTION_MODES.map((mode) => el('button', {
        class: 'btn subtle sm',
        text: mode.label,
        onClick: async () => {
          try {
            await api.display.projection(mode.id);
            toast(`Umgeschaltet auf ${mode.label}`, 'ok');
            setTimeout(load, 2500);
          } catch (err) { notifyError(err.message); }
        }
      }))),
      el('div', { class: 'faint', style: { fontSize: '11px', marginTop: '10px' },
        text: 'Entspricht Windows-Taste und P.' })
    ]));

    host.appendChild(el('div', { class: 'panel bracketed' }, [
      el('span', { class: 'bracket tl' }), el('span', { class: 'bracket tr' }),
      el('span', { class: 'bracket bl' }), el('span', { class: 'bracket br' }),
      el('div', { class: 'panel-head' }, [el('div', { class: 'panel-title', text: 'Windows-Seiten' })]),
      el('div', { class: 'faint', style: { fontSize: '11.5px', marginBottom: '10px', lineHeight: '1.6' },
        text: 'Nachtmodus, HDR und Skalierung haben keine offene Schnittstelle. Dafür öffnet der Hub die zuständige Windows-Seite.' }),
      el('div', { class: 'row gap-8', style: { flexWrap: 'wrap' } }, SETTINGS_LINKS.map((link) => el('button', {
        class: 'btn subtle sm',
        text: link.label,
        onClick: () => api.display.openSettings(link.page).catch((err) => notifyError(err.message))
      })))
    ]));
  }

  const panel = el('div', { class: 'tab-body', style: { overflowY: 'auto' } }, [
    el('div', { class: 'proc-toolbar' }, [
      el('button', { class: 'btn subtle sm', text: 'Neu einlesen', onClick: load }),
      el('div', { class: 'grow' }),
      el('div', { class: 'proc-summary' }, [statusLine])
    ]),
    host
  ]);

  // A revert driven by the timer in main has to be reflected here too.
  const unsubscribe = api.display.onReverted((event) => {
    if (event && event.reverted) notifyWarn('Auflösung wurde automatisch zurückgesetzt');
    else if (event) notifyError(`Zurücksetzen fehlgeschlagen: ${event.error}`);
    load();
  });
  panel.addEventListener('panel:dispose', () => { if (unsubscribe) unsubscribe(); });

  load();
  return panel;
}
