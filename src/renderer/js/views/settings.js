import { el, clear, bytes } from '../util.js';
import { toAccelerator, formatAccelerator } from '../keys.js';
import { api } from '../api.js';
import { setGamepadEnabled, gamepadState } from '../gamepad.js';
import { state, saveSettings, applyTheme } from '../state.js';
import { confirmDialog, openModal } from '../widgets/modal.js';
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
  const logLine = el('div', { class: 'setting-hint', text: 'Protokoll wird gelesen …' });
  let lastReportPath = null;

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

  async function refreshLogInfo() {
    try {
      const paths = await api.diagnostics.logInfo();
      const files = paths.files || [];
      const total = files.reduce((sum, f) => sum + f.size, 0);
      logLine.textContent = paths.disabled
        ? 'Protokoll konnte nicht geschrieben werden.'
        : `${files.length} Datei${files.length === 1 ? '' : 'en'} · ${bytes(total)} · ${paths.dir}`;
    } catch (err) {
      logLine.textContent = err.message;
    }
  }
  refreshLogInfo();

  async function showLogTail() {
    try {
      const data = await api.diagnostics.logTail(300);
      const pre = el('pre', {
        class: 'log-view',
        text: (data.lines || []).join('\n') || '(leer)'
      });
      openModal({
        title: 'Protokoll',
        width: '900px',
        render: () => pre,
        actions: (close) => [
          el('button', { class: 'btn subtle', text: 'Ordner öffnen', onClick: () => api.diagnostics.openLogs().catch((e) => notifyError(e.message)) }),
          el('button', { class: 'btn primary', text: 'Schließen', onClick: () => close() })
        ]
      });
      // Newest lines are the interesting ones.
      requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
    } catch (err) { notifyError(err.message); }
  }

  /* ---------------------------------------------------------- Claude Code */

  const claudeStatus = el('div', { class: 'setting-hint', text: 'Suche Claude Code …' });
  const claudeActions = el('div', { class: 'row gap-8', style: { flexWrap: 'wrap', marginTop: '12px' } });
  let claudeInfo = null;

  async function renderClaude(force = false) {
    clear(claudeActions);
    claudeStatus.textContent = 'Suche Claude Code …';
    try {
      claudeInfo = await api.claude.detect(force);
    } catch (err) {
      claudeStatus.textContent = err.message;
      return;
    }

    if (!claudeInfo.installed) {
      claudeStatus.textContent = claudeInfo.hint || 'Claude Code wurde nicht gefunden.';
      claudeActions.appendChild(el('button', { class: 'btn subtle sm', text: 'Erneut suchen', onClick: () => renderClaude(true) }));
      claudeActions.appendChild(el('button', {
        class: 'btn subtle sm',
        text: 'Installationsanleitung',
        onClick: () => api.shell.openExternal('https://code.claude.com/docs').catch((e) => notifyError(e.message))
      }));
      return;
    }

    claudeStatus.textContent = `Gefunden: ${claudeInfo.version}`;

    claudeActions.append(
      el('button', {
        class: 'btn primary sm',
        text: 'Konsole öffnen',
        onClick: () => api.claude.openWindow().catch((err) => notifyError(err.message))
      }),
      el('button', {
        class: 'btn subtle sm',
        text: 'In Terminal öffnen',
        onClick: async () => {
          try {
            const dir = await api.claude.pickFolder();
            if (!dir) return;
            await api.claude.open(dir);
            notifyOk('Claude Code gestartet');
          } catch (err) { notifyError(err.message); }
        }
      }),
      el('button', {
        class: 'btn subtle sm',
        text: 'Systembericht analysieren',
        onClick: () => analyseReport()
      }),
      el('button', { class: 'btn subtle sm', text: 'Erneut suchen', onClick: () => renderClaude(true) })
    );
  }

  /**
   * Writes a fresh report, then hands it to Claude Code. This spends the
   * user's own Claude quota, so it is never triggered automatically and the
   * confirmation says so plainly.
   */
  async function analyseReport() {
    const sure = await confirmDialog({
      title: 'Systembericht analysieren',
      message: 'Der Hub schreibt einen Diagnosebericht und lässt ihn von Claude Code auswerten. '
        + 'Das läuft über deine eigene Claude-Anmeldung und verbraucht dein Kontingent. Die Auswertung dauert meist unter einer Minute.',
      confirmLabel: 'Analysieren'
    });
    if (!sure) return;

    const body = el('div', { class: 'stack gap-12' }, [
      el('div', { class: 'row gap-8' }, [el('span', { class: 'pulse-dot' }), el('span', { text: 'Bericht wird erstellt …' })])
    ]);
    const { close } = openModal({
      title: 'Analyse läuft',
      width: '820px',
      render: () => body,
      actions: (closeFn) => [el('button', { class: 'btn subtle', text: 'Schließen', onClick: () => closeFn() })]
    });

    try {
      const saved = await api.diagnostics.save();
      lastReportPath = saved.path;
      clear(body).appendChild(el('div', { class: 'row gap-8' }, [
        el('span', { class: 'pulse-dot' }),
        el('span', { text: 'Claude Code wertet den Bericht aus. Das kann bis zu einer Minute dauern …' })
      ]));

      const result = await api.claude.analyse(saved.path, null);
      clear(body).append(
        el('div', { class: 'setting-hint', text: `Antwort nach ${result.seconds} Sekunden · Bericht: ${saved.path}` }),
        el('pre', { class: 'log-view answer', text: result.answer })
      );
    } catch (err) {
      clear(body).append(
        el('div', { style: { color: 'var(--danger)', lineHeight: '1.6' }, text: err.message }),
        lastReportPath
          ? el('div', { class: 'setting-hint', style: { marginTop: '10px' }, text: `Der Bericht liegt trotzdem unter: ${lastReportPath}` })
          : null
      );
    }
    void close;
  }

  renderClaude();

  /* -------------------------------------------------------------- hotkeys */

  const hotkeyHost = el('div', {});

  async function renderHotkeys() {
    clear(hotkeyHost);
    let bindings = [];
    try {
      bindings = await api.hotkeys.list();
    } catch (err) {
      hotkeyHost.appendChild(el('div', { class: 'faint', text: err.message }));
      return;
    }

    for (const binding of bindings) {
      const display = el('span', {
        class: `key-display${binding.accelerator ? '' : ' empty'}`,
        text: binding.accelerator ? formatAccelerator(binding.accelerator) : 'nicht belegt'
      });

      let capturing = false;
      let onKey = null;

      const stopCapture = () => {
        capturing = false;
        if (onKey) document.removeEventListener('keydown', onKey, true);
        onKey = null;
        captureBtn.textContent = 'Ändern';
        captureBtn.classList.remove('primary');
      };

      const captureBtn = el('button', {
        class: 'btn subtle sm',
        text: 'Ändern',
        onClick: () => {
          if (capturing) { stopCapture(); return; }
          capturing = true;
          captureBtn.textContent = 'Taste drücken …';
          captureBtn.classList.add('primary');

          onKey = async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Escape') { stopCapture(); return; }

            const accelerator = toAccelerator(event);
            if (!accelerator) {
              // Held modifiers alone, or a bare key: keep waiting.
              return;
            }
            stopCapture();
            try {
              await api.hotkeys.set(binding.action, accelerator);
              notifyOk(`${formatAccelerator(accelerator)} gesetzt`);
            } catch (err) {
              notifyError(err.message);
            }
            renderHotkeys();
          };
          document.addEventListener('keydown', onKey, true);
        }
      });

      const clearBtn = el('button', {
        class: 'icon-btn danger',
        title: 'Belegung entfernen',
        onClick: async () => {
          try {
            await api.hotkeys.set(binding.action, '');
            renderHotkeys();
          } catch (err) { notifyError(err.message); }
        }
      }, ['×']);

      hotkeyHost.appendChild(el('div', { class: 'setting-row' }, [
        el('div', {}, [
          el('div', { class: 'setting-label', text: binding.label }),
          el('div', { class: 'setting-hint', text: binding.accelerator && !binding.active
            ? 'Belegt von einem anderen Programm, aktuell ohne Wirkung.'
            : 'Wirkt systemweit, auch während ein Spiel läuft.' })
        ]),
        el('div', { class: 'row gap-8' }, [display, captureBtn, binding.accelerator ? clearBtn : null])
      ]));
    }
  }

  renderHotkeys();

  /* ------------------------------------------------------------- gamepad */

  // Says which controller the browser actually sees. "It does not work" is
  // almost always "Windows never reported a pad", and that is worth showing.
  const gamepadLine = el('div', { class: 'setting-hint', style: { marginTop: '8px' } });

  function renderGamepad() {
    const info = gamepadState();
    if (!info.pads.length) {
      gamepadLine.textContent = 'Kein Controller erkannt. Windows meldet ein Gerät erst, wenn eine Taste gedrückt wurde.';
      return;
    }
    gamepadLine.textContent = info.pads
      .map((p) => `${p.id} · ${p.buttons} Tasten${p.mapping === 'standard' ? '' : ' · abweichende Belegung'}`)
      .join(' | ');
  }

  renderGamepad();

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

      panel('Tastenkürzel', [
        hotkeyHost,
        toggleRow('Gamepad-Steuerung', 'Steuerkreuz und linker Stick bewegen die Auswahl, A wählt, B geht zurück, '
          + 'LB und RB wechseln die Ansicht, Y schaltet die Overlays, Start das Vollbild.', 'gamepad', {
          onChange: (value) => setGamepadEnabled(value)
        }),
        gamepadLine,
        el('div', { class: 'setting-hint', style: { marginTop: '12px', lineHeight: '1.65' },
          text: 'Jede Kombination braucht mindestens Strg, Alt oder Shift, sonst würde die Taste in allen anderen Programmen verschluckt. '
            + 'Über einem Spiel im echten Vollbildmodus kann Windows das Hub-Fenster nicht nach vorne holen; im randlosen Fenstermodus funktioniert es. '
            + 'Strg+Umschalt+Q beendet den Hub immer und lässt sich nicht ändern.' })
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

      panel('Diagnose', [
        diag,
        el('div', { style: { height: '14px' } }),
        logLine,
        el('div', { class: 'row gap-8', style: { flexWrap: 'wrap', marginTop: '12px' } }, [
          el('button', { class: 'btn subtle sm', text: 'Protokoll anzeigen', onClick: showLogTail }),
          el('button', {
            class: 'btn subtle sm',
            text: 'Protokollordner',
            onClick: () => api.diagnostics.openLogs().catch((err) => notifyError(err.message))
          }),
          el('button', {
            class: 'btn primary sm',
            text: 'Bericht exportieren',
            onClick: async (event) => {
              const button = event.currentTarget;
              button.setAttribute('aria-disabled', 'true');
              try {
                const result = await api.diagnostics.export();
                if (result.canceled) return;
                lastReportPath = result.path;
                notifyOk(`Bericht gespeichert (${bytes(result.bytes)})`);
              } catch (err) {
                notifyError(err.message);
              } finally {
                button.removeAttribute('aria-disabled');
                refreshLogInfo();
              }
            }
          })
        ]),
        el('div', { class: 'setting-hint', style: { marginTop: '12px', lineHeight: '1.65' },
          text: 'Der Bericht enthält Versionen, Hardware, das Ergebnis aller Plattform-Abfragen, '
            + 'die Konfiguration ohne persönliche Pfade und Hintergrundbilder sowie die letzten Protokollzeilen. '
            + 'Genau das, was zur Fehlersuche gebraucht wird.' })
      ]),

      panel('Claude Code', [
        claudeStatus,
        claudeActions,
        el('div', { class: 'setting-hint', style: { marginTop: '14px', lineHeight: '1.65' },
          text: 'Die Konsole ist ein eigenes Fenster mit laufender Sitzung: Nachrichten, Antworten im Zeichenfluss, '
            + 'sichtbare Werkzeugaufrufe und laufende Kosten. „In Terminal öffnen" startet stattdessen die gewohnte '
            + 'Befehlszeile. Beides läuft über deine eigene Anmeldung und verbraucht dein Kontingent.' })
      ])
    ])
  ]);

  // The view is rebuilt on every visit, so the listeners have to go with it.
  view.addEventListener('view:mount', () => {
    window.addEventListener('gamepadconnected', renderGamepad);
    window.addEventListener('gamepaddisconnected', renderGamepad);
    renderGamepad();
  });
  view.addEventListener('view:unmount', () => {
    window.removeEventListener('gamepadconnected', renderGamepad);
    window.removeEventListener('gamepaddisconnected', renderGamepad);
  });
  window.addEventListener('gamepadconnected', renderGamepad);
  window.addEventListener('gamepaddisconnected', renderGamepad);

  return view;
}
