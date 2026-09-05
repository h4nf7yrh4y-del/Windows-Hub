import { el, clear, bytes } from '../util.js';
import { api } from '../api.js';
import { state, saveSettings, applyTheme } from '../state.js';
import { confirmDialog } from '../widgets/modal.js';
import { notifyError, notifyOk, toast } from '../widgets/toast.js';

const PRESET_ACCENTS = ['#00f0ff', '#ff2e88', '#ffb400', '#26e08a', '#8b5cf6', '#ff6b35', '#4d9fff', '#ff0044'];

const POWER_ACTIONS = [
  { id: 'lock',     label: 'Sperren',      danger: false, message: 'Der Bildschirm wird gesperrt.' },
  { id: 'sleep',    label: 'Energiesparen',danger: false, message: 'Der PC wechselt in den Energiesparmodus.' },
  { id: 'logoff',   label: 'Abmelden',     danger: true,  message: 'Alle Programme werden geschlossen und du wirst abgemeldet.' },
  { id: 'restart',  label: 'Neu starten',  danger: true,  message: 'Der PC startet sofort neu. Nicht gespeicherte Arbeit geht verloren.' },
  { id: 'shutdown', label: 'Herunterfahren',danger: true, message: 'Der PC wird sofort heruntergefahren.' }
];

function panel(title, children) {
  return el('div', { class: 'panel bracketed' }, [
    el('span', { class: 'bracket tl' }), el('span', { class: 'bracket tr' }),
    el('span', { class: 'bracket bl' }), el('span', { class: 'bracket br' }),
    el('div', { class: 'panel-head' }, [el('div', { class: 'panel-title', text: title })]),
    ...[].concat(children)
  ]);
}

function toggleRow(label, hint, key, { onChange } = {}) {
  const toggle = el('div', {
    class: 'toggle',
    role: 'switch',
    'aria-checked': String(!!state.settings[key])
  });

  toggle.addEventListener('click', async () => {
    const next = !(toggle.getAttribute('aria-checked') === 'true');
    toggle.setAttribute('aria-checked', String(next));
    try {
      await saveSettings({ [key]: next });
      if (onChange) onChange(next);
    } catch (err) {
      toggle.setAttribute('aria-checked', String(!next));
      notifyError(err.message);
    }
  });

  return el('div', { class: 'setting-row' }, [
    el('div', {}, [
      el('div', { class: 'setting-label', text: label }),
      hint ? el('div', { class: 'setting-hint', text: hint }) : null
    ]),
    toggle
  ]);
}

function selectRow(label, hint, key, options) {
  const select = el('select', { class: 'select', style: { width: 'auto', minWidth: '110px' } },
    options.map((o) => el('option', { value: String(o.value), text: o.label })));
  select.value = String(state.settings[key]);
  select.addEventListener('change', async () => {
    try {
      await saveSettings({ [key]: Number(select.value) });
      notifyOk('Gespeichert');
    } catch (err) { notifyError(err.message); }
  });

  return el('div', { class: 'setting-row' }, [
    el('div', {}, [
      el('div', { class: 'setting-label', text: label }),
      hint ? el('div', { class: 'setting-hint', text: hint }) : null
    ]),
    select
  ]);
}

export function createSettingsView() {
  const info = state.appInfo || {};

  /* ------------------------------------------------------------ appearance */

  const colorInput = el('input', { type: 'color', value: state.settings.accent });
  const swatches = el('div', { class: 'accent-swatches' }, PRESET_ACCENTS.map((color) => el('button', {
    class: `swatch${state.settings.accent === color ? ' active' : ''}`,
    style: { background: color, color },
    title: color,
    onClick: async (event) => {
      colorInput.value = color;
      swatches.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
      event.currentTarget.classList.add('active');
      try { await saveSettings({ accent: color }); } catch (err) { notifyError(err.message); }
    }
  })));

  let colorTimer = null;
  colorInput.addEventListener('input', () => {
    document.documentElement.style.setProperty('--accent', colorInput.value);
    if (colorTimer) clearTimeout(colorTimer);
    colorTimer = setTimeout(() => {
      saveSettings({ accent: colorInput.value }).catch((err) => notifyError(err.message));
    }, 350);
  });

  const secondaryInput = el('input', { type: 'color', value: state.settings.accent2 });
  let secondaryTimer = null;
  secondaryInput.addEventListener('input', () => {
    document.documentElement.style.setProperty('--accent-2', secondaryInput.value);
    if (secondaryTimer) clearTimeout(secondaryTimer);
    secondaryTimer = setTimeout(() => {
      saveSettings({ accent2: secondaryInput.value }).catch((err) => notifyError(err.message));
    }, 350);
  });

  /* ---------------------------------------------------------------- power */

  const powerButtons = el('div', { class: 'row gap-8', style: { flexWrap: 'wrap' } },
    POWER_ACTIONS.map((action) => el('button', {
      class: `btn ${action.danger ? 'danger' : 'subtle'} sm`,
      text: action.label,
      onClick: async () => {
        const sure = await confirmDialog({
          title: action.label,
          message: action.message,
          confirmLabel: action.label,
          danger: action.danger
        });
        if (!sure) return;
        try { await api.power.perform(action.id); } catch (err) { notifyError(err.message); }
      }
    })));

  /* ------------------------------------------------------------- diagnostics */

  const diag = el('div', { class: 'kv-list' });
  function renderDiag() {
    clear(diag);
    const s = state.staticInfo || {};
    const rows = [
      ['Version', info.version || '—'],
      ['Electron', info.electron || '—'],
      ['Chromium', info.chrome || '—'],
      ['Node', info.node || '—'],
      ['Plattform', info.platform || '—'],
      ['Rechner', s.hostname || '—'],
      ['RAM', s.totalMem ? bytes(s.totalMem) : '—'],
      ['Profile', String(state.profiles.length)],
      ['Bibliothek', state.library ? String(state.library.items.length) : 'nicht gescannt']
    ];
    for (const [key, value] of rows) {
      diag.appendChild(el('div', { class: 'kv' }, [
        el('span', { class: 'kv-key', text: key }),
        el('span', { class: 'kv-val', text: String(value) })
      ]));
    }
  }
  renderDiag();

  const view = el('section', { class: 'view', id: 'view-settings' }, [
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h2', { class: 'glitch', dataset: { text: 'Einstellungen' }, text: 'Einstellungen' }),
        el('div', { class: 'view-sub', text: info.configPath || '' })
      ])
    ]),

    el('div', { class: 'settings-cols' }, [

      panel('Start & Fenster', [
        toggleRow('Mit Windows starten', 'Registriert den Hub als Autostart-Eintrag des aktuellen Benutzers.', 'autostart', {
          onChange: (v) => toast(v ? 'Autostart aktiviert' : 'Autostart deaktiviert', 'ok')
        }),
        toggleRow('Im Vollbild starten', 'Der Hub öffnet sich formatfüllend. F11 schaltet jederzeit um.', 'startFullscreen'),
        toggleRow('Kiosk-Modus', 'Blockiert das Verlassen des Vollbilds. Beenden weiterhin über Strg+Umschalt+Q.', 'kiosk'),
        toggleRow('Beim Profilstart minimieren', 'Der Hub tritt in den Hintergrund, sobald ein Profil gestartet wird.', 'minimizeOnLaunch'),
        toggleRow('Boot-Animation', 'Die Startsequenz beim Öffnen des Hubs.', 'bootAnimation')
      ]),

      panel('Darstellung', [
        el('div', { class: 'setting-row' }, [
          el('div', {}, [
            el('div', { class: 'setting-label', text: 'Primäre Akzentfarbe' }),
            el('div', { class: 'setting-hint', text: 'Färbt Rahmen, Diagramme und Effekte.' })
          ]),
          el('div', { class: 'row gap-8' }, [colorInput])
        ]),
        el('div', { style: { padding: '4px 0 12px' } }, [swatches]),
        el('div', { class: 'setting-row' }, [
          el('div', {}, [el('div', { class: 'setting-label', text: 'Sekundäre Akzentfarbe' })]),
          secondaryInput
        ]),
        toggleRow('Scanlines & Rauschen', 'CRT-Overlay. Aus, wenn es dich stört oder Leistung kostet.', 'scanlines'),
        toggleRow('Raster-Hintergrund', 'Animiertes Perspektivraster im Hintergrund.', 'grid'),
        toggleRow('Bewegung reduzieren', 'Schaltet Animationen fast vollständig ab.', 'reduceMotion', {
          onChange: () => applyTheme()
        })
      ]),

      panel('Telemetrie', [
        selectRow('Aktualisierung CPU/RAM', 'Günstig, da rein aus Node-Bordmitteln.', 'metricsIntervalMs', [
          { value: 500, label: '0,5 s' }, { value: 1000, label: '1 s' },
          { value: 2000, label: '2 s' }, { value: 5000, label: '5 s' }
        ]),
        selectRow('Aktualisierung Disk/Netz/GPU', 'Teurer: jede Abfrage startet WMI bzw. PowerShell.', 'slowMetricsIntervalMs', [
          { value: 3000, label: '3 s' }, { value: 5000, label: '5 s' },
          { value: 10000, label: '10 s' }, { value: 30000, label: '30 s' }
        ]),
        selectRow('Task-Manager-Intervall', 'Standardwert für die Prozessliste.', 'processIntervalMs', [
          { value: 1000, label: '1 s' }, { value: 2000, label: '2 s' },
          { value: 3000, label: '3 s' }, { value: 5000, label: '5 s' }
        ]),
        toggleRow('GPU-Telemetrie abfragen', 'Nutzt die Windows-GPU-Zähler und funktioniert mit AMD, Intel und NVIDIA. Abschalten spart eine WMI-Abfrage pro Intervall.', 'showGpu')
      ]),

      panel('System', [
        el('div', { class: 'setting-hint', style: { marginBottom: '12px' }, text: 'Diese Aktionen wirken sofort nach der Bestätigung.' }),
        powerButtons,
        el('div', { style: { height: '16px' } }),
        el('div', { class: 'row gap-8' }, [
          el('button', {
            class: 'btn subtle sm',
            text: 'Konfiguration öffnen',
            onClick: async () => {
              try { await api.settings.openConfigFolder(); } catch (err) { notifyError(err.message); }
            }
          })
        ])
      ]),

      panel('Diagnose', [diag])
    ])
  ]);

  return view;
}
