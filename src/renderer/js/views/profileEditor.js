import { el, svg, clear, uuid, colorFromString, resolveProcessName, normalizeProcessName } from '../util.js';
import { openModal, confirmDialog } from '../widgets/modal.js';
import { notifyError, notifyOk, toast } from '../widgets/toast.js';
import { api } from '../api.js';
import { state, loadProfiles, loadLibrary, refreshRunning } from '../state.js';

const ICON_TRASH = 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13';
const ICON_PLUS = 'M12 5v14M5 12h14';
const ICON_GRIP = 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01';

const PRESET_ACCENTS = ['#00f0ff', '#ff2e88', '#ffb400', '#26e08a', '#8b5cf6', '#ff6b35', '#4d9fff', '#ff0044'];

const LAUNCH_TYPE_LABELS = {
  exe: 'Programm',
  uri: 'URI / Protokoll',
  appsfolder: 'Windows-App',
  shell: 'Befehl'
};

function blankProfile() {
  return {
    id: uuid(),
    name: '',
    tagline: '',
    accent: '#00f0ff',
    cover: null,
    apps: [],
    alsoClose: [],
    minimizeOnLaunch: true
  };
}

function describeLaunch(launch) {
  if (!launch) return '';
  if (launch.type === 'exe') return launch.target;
  if (launch.type === 'uri') return launch.target;
  if (launch.type === 'appsfolder') return `shell:AppsFolder\\${launch.target}`;
  return launch.target;
}

/**
 * Lets the user point an entry at a running process.
 *
 * Games started through steam:// have no executable path the hub could read,
 * so the reliable way to learn the process name is to start the game once and
 * pick it from the list of what is actually running.
 */
async function pickProcess(app, input, onPicked) {
  let names = [];
  try {
    await refreshRunning();
    names = Array.from(state.running).sort();
  } catch (err) {
    notifyError(err.message);
    return;
  }

  const listHost = el('div', { class: 'stack gap-4', style: { maxHeight: '46vh', overflowY: 'auto' } });
  const search = el('input', { class: 'input', placeholder: 'Prozess suchen …', autofocus: true });

  const render = (query = '') => {
    clear(listHost);
    const needle = query.trim().toLowerCase();
    const shown = names.filter((n) => !needle || n.includes(needle));
    if (!shown.length) {
      listHost.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'empty-title', text: 'Nichts gefunden' })]));
      return;
    }
    for (const name of shown) {
      listHost.appendChild(el('button', {
        class: 'fm-side-btn',
        onClick: () => {
          app.processName = name;
          input.value = name;
          if (onPicked) onPicked();
          if (ctxClose) ctxClose();
        }
      }, [el('span', { class: 'mono truncate', text: name })]));
    }
  };

  let ctxClose = null;
  search.addEventListener('input', () => render(search.value));
  render();

  const { close } = openModal({
    title: 'Laufenden Prozess auswählen',
    width: '520px',
    render: () => el('div', { class: 'stack gap-12' }, [
      el('div', { class: 'faint', style: { fontSize: '11.5px', lineHeight: '1.6' },
        text: 'Starte das Spiel einmal, dann taucht es hier auf. Der gewählte Name wird für die Laufstatus-Anzeige und zum Beenden des Profils verwendet.' }),
      search,
      listHost
    ]),
    actions: (closeFn) => [el('button', { class: 'btn subtle', text: 'Abbrechen', onClick: () => closeFn() })]
  });
  ctxClose = close;
}

/* ---------------------------------------------------------- app row editor */

function appRow(app, ctx) {
  const row = el('div', { class: 'editor-app', draggable: 'true', dataset: { id: app.id } });

  const handle = el('div', { class: 'drag-handle', title: 'Ziehen zum Umsortieren' }, [
    svg(ICON_GRIP, { width: 15, height: 15, strokeWidth: 2 })
  ]);

  const derived = resolveProcessName({ ...app, processName: null });

  const procInput = el('input', {
    class: 'input proc-input',
    value: app.processName || '',
    placeholder: derived ? `${derived} (automatisch)` : 'Prozessname für Statusanzeige',
    title: 'Nach diesem Prozess wird geprüft, ob das Programm läuft',
    onChange: (event) => {
      const value = normalizeProcessName(event.target.value);
      app.processName = value || null;
      event.target.value = value;
      if (ctx.onStatusFieldChange) ctx.onStatusFieldChange();
    }
  });

  const meta = el('div', { class: 'stack gap-4', style: { minWidth: '0' } }, [
    el('div', { class: 'app-name truncate', text: app.name }),
    el('div', { class: 'app-target', text: `${LAUNCH_TYPE_LABELS[app.launch.type] || app.launch.type} · ${describeLaunch(app.launch)}` }),
    el('div', { class: 'proc-row' }, [
      el('span', { class: 'label', text: 'Prozess' }),
      procInput,
      el('button', {
        class: 'btn subtle xs',
        text: 'wählen',
        title: 'Aus den gerade laufenden Prozessen auswählen',
        onClick: () => pickProcess(app, procInput)
      })
    ])
  ]);

  const delay = el('input', {
    class: 'input delay-input',
    type: 'number',
    min: '0',
    step: '500',
    value: String(app.delayMs || 0),
    title: 'Verzögerung vor dem Start (ms)',
    onChange: (event) => {
      const value = Math.max(0, Math.min(120000, Number(event.target.value) || 0));
      app.delayMs = value;
      event.target.value = String(value);
    }
  });

  const toggle = el('div', {
    class: 'toggle',
    role: 'switch',
    'aria-checked': String(app.enabled !== false),
    title: 'Aktiv',
    style: { transform: 'scale(0.72)' },
    onClick: (event) => {
      app.enabled = !(app.enabled !== false);
      event.currentTarget.setAttribute('aria-checked', String(app.enabled));
    }
  });

  const remove = el('button', {
    class: 'icon-btn danger',
    title: 'Entfernen',
    onClick: () => {
      ctx.profile.apps = ctx.profile.apps.filter((a) => a.id !== app.id);
      ctx.renderApps();
    }
  }, [svg(ICON_TRASH, { width: 15, height: 15 })]);

  row.append(handle, meta, delay, toggle, remove);

  row.addEventListener('dragstart', (event) => {
    ctx.dragId = app.id;
    row.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));
  row.addEventListener('dragover', (event) => event.preventDefault());
  row.addEventListener('drop', (event) => {
    event.preventDefault();
    if (!ctx.dragId || ctx.dragId === app.id) return;
    const apps = ctx.profile.apps;
    const from = apps.findIndex((a) => a.id === ctx.dragId);
    const to = apps.findIndex((a) => a.id === app.id);
    if (from < 0 || to < 0) return;
    apps.splice(to, 0, apps.splice(from, 1)[0]);
    ctx.dragId = null;
    ctx.renderApps();
  });

  return row;
}

/* ------------------------------------------------------------ app pickers */

async function pickFromLibrary(ctx) {
  let library = state.library;
  if (!library) {
    toast('Scanne installierte Programme …');
    try { library = await loadLibrary(); } catch (err) { notifyError(err.message); return; }
  }

  const listHost = el('div', { class: 'stack gap-4', style: { maxHeight: '46vh', overflowY: 'auto' } });
  const search = el('input', { class: 'input', placeholder: 'Suchen …', autofocus: true });

  const render = (query = '') => {
    clear(listHost);
    const needle = query.trim().toLowerCase();
    const items = (library.items || [])
      .filter((item) => !needle || item.name.toLowerCase().includes(needle))
      .slice(0, 200);

    if (!items.length) {
      listHost.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'empty-title', text: 'Nichts gefunden' })]));
      return;
    }

    for (const item of items) {
      listHost.appendChild(el('div', {
        class: 'lib-card',
        onClick: async () => {
          const entry = {
            id: uuid(),
            name: item.name,
            launch: item.launch,
            delayMs: ctx.profile.apps.length * 2000,
            enabled: true,
            required: false,
            processName: item.exe ? normalizeProcessName(item.exe.split(/[\\/]/).pop()) : null
          };
          ctx.profile.apps.push(entry);
          ctx.renderApps();
          ctx.closePicker();

          // A steam:// entry carries no executable, so look inside the install
          // directory for the most likely one instead of leaving it untracked.
          if (!entry.processName && item.installDir) {
            try {
              const guess = await api.library.guessExecutable(item.installDir);
              if (guess && guess.name) {
                entry.processName = normalizeProcessName(guess.name);
                ctx.renderApps();
                toast(`Prozess erkannt: ${entry.processName}`, 'ok');
              }
            } catch (_) { /* the user can still set it by hand */ }
          }
        }
      }, [
        el('div', { class: 'lib-icon' }, [el('span', { class: 'lib-initial', text: item.name.charAt(0).toUpperCase() })]),
        el('div', { class: 'lib-meta grow' }, [
          el('div', { class: 'lib-name truncate', text: item.name }),
          el('div', { class: 'lib-src', text: item.source })
        ])
      ]));
    }
  };

  search.addEventListener('input', () => render(search.value));
  render();

  const { close } = openModal({
    title: 'Programm hinzufügen',
    width: '620px',
    render: () => el('div', { class: 'stack gap-12' }, [search, listHost]),
    actions: (closeFn) => [el('button', { class: 'btn subtle', text: 'Abbrechen', onClick: () => closeFn() })]
  });
  ctx.closePicker = close;
}

function addManual(ctx) {
  const name = el('input', { class: 'input', placeholder: 'z. B. Spotify' });
  const type = el('select', { class: 'select' }, [
    el('option', { value: 'exe', text: 'Programm (.exe)' }),
    el('option', { value: 'uri', text: 'URI / Protokoll (steam://, spotify:)' }),
    el('option', { value: 'shell', text: 'Befehl (cmd)' }),
    el('option', { value: 'appsfolder', text: 'Windows-App (AppID)' })
  ]);
  const target = el('input', { class: 'input', placeholder: 'Pfad oder URI' });
  const browse = el('button', {
    class: 'btn subtle sm',
    text: 'Durchsuchen',
    onClick: async () => {
      try {
        const picked = await api.library.pickExecutable();
        if (!picked) return;
        target.value = picked;
        if (!name.value) name.value = picked.split(/[\\/]/).pop().replace(/\.(exe|bat|cmd|lnk)$/i, '');
      } catch (err) { notifyError(err.message); }
    }
  });
  const delay = el('input', { class: 'input', type: 'number', min: '0', step: '500', value: String(ctx.profile.apps.length * 2000) });

  openModal({
    title: 'Manuell hinzufügen',
    width: '540px',
    render: () => el('div', { class: 'stack gap-12' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Name' }), name]),
      el('div', { class: 'field' }, [el('label', { text: 'Typ' }), type]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Ziel' }),
        el('div', { class: 'row gap-8' }, [target, browse])
      ]),
      el('div', { class: 'field' }, [el('label', { text: 'Verzögerung (ms)' }), delay])
    ]),
    actions: (close) => [
      el('button', { class: 'btn subtle', text: 'Abbrechen', onClick: () => close() }),
      el('button', {
        class: 'btn primary',
        text: 'Hinzufügen',
        onClick: () => {
          if (!name.value.trim() || !target.value.trim()) {
            notifyError('Name und Ziel sind erforderlich');
            return;
          }
          ctx.profile.apps.push({
            id: uuid(),
            name: name.value.trim(),
            launch: { type: type.value, target: target.value.trim() },
            delayMs: Math.max(0, Number(delay.value) || 0),
            enabled: true,
            required: false,
            processName: type.value === 'exe'
              ? normalizeProcessName(target.value.split(/[\\/]/).pop())
              : null
          });
          ctx.renderApps();
          close();
        }
      })
    ]
  });
}

/* ------------------------------------------------------------------ editor */

export function openProfileEditor(existing, onSaved) {
  const profile = existing
    ? JSON.parse(JSON.stringify(existing))
    : blankProfile();
  if (!profile.apps) profile.apps = [];

  const ctx = { profile, dragId: null, renderApps: () => {}, closePicker: () => {} };

  const nameInput = el('input', { class: 'input', value: profile.name, placeholder: 'z. B. HELLDIVERS 2' });
  const taglineInput = el('input', { class: 'input', value: profile.tagline || '', placeholder: 'Kurzbeschreibung' });
  const colorInput = el('input', { type: 'color', value: profile.accent || '#00f0ff' });

  const swatches = el('div', { class: 'accent-swatches' }, PRESET_ACCENTS.map((color) => el('button', {
    class: `swatch${profile.accent === color ? ' active' : ''}`,
    style: { background: color, color },
    title: color,
    onClick: (event) => {
      profile.accent = color;
      colorInput.value = color;
      event.currentTarget.parentElement.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
      event.currentTarget.classList.add('active');
    }
  })));

  colorInput.addEventListener('input', () => { profile.accent = colorInput.value; });

  const coverPreview = el('div', {
    style: {
      width: '100%',
      height: '96px',
      border: '1px solid var(--hairline)',
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundImage: profile.cover ? `url("${profile.cover}")` : 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, [profile.cover ? null : el('span', { class: 'label', text: 'Kein Hintergrund' })]);

  const appsHost = el('div', { class: 'editor-apps' });

  ctx.renderApps = () => {
    clear(appsHost);
    if (!profile.apps.length) {
      appsHost.appendChild(el('div', { class: 'empty', style: { padding: '26px' } }, [
        el('div', { class: 'empty-title', text: 'Keine Programme' }),
        el('div', { text: 'Füge Spotify, Discord und dein Spiel hinzu.', style: { fontSize: '12px' } })
      ]));
      return;
    }
    profile.apps.forEach((app) => appsHost.appendChild(appRow(app, ctx)));
  };
  ctx.renderApps();

  const body = el('div', { class: 'stack gap-16' }, [
    el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } }, [
      el('div', { class: 'field' }, [el('label', { text: 'Profilname' }), nameInput]),
      el('div', { class: 'field' }, [el('label', { text: 'Untertitel' }), taglineInput])
    ]),

    el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', alignItems: 'start' } }, [
      el('div', { class: 'field' }, [
        el('label', { text: 'Akzentfarbe' }),
        el('div', { class: 'row gap-8' }, [colorInput, swatches])
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Hintergrundbild' }),
        coverPreview,
        el('div', { class: 'row gap-8' }, [
          el('button', {
            class: 'btn subtle sm',
            text: 'Bild wählen',
            onClick: async () => {
              try {
                const dataUrl = await api.library.pickImage();
                if (!dataUrl) return;
                profile.cover = dataUrl;
                coverPreview.style.backgroundImage = `url("${dataUrl}")`;
                clear(coverPreview);
              } catch (err) { notifyError(err.message); }
            }
          }),
          el('button', {
            class: 'btn subtle sm',
            text: 'Entfernen',
            onClick: () => {
              profile.cover = null;
              coverPreview.style.backgroundImage = 'none';
              clear(coverPreview).appendChild(el('span', { class: 'label', text: 'Kein Hintergrund' }));
            }
          })
        ])
      ])
    ]),

    el('div', { class: 'stack gap-8' }, [
      el('div', { class: 'row between' }, [
        el('span', { class: 'label', text: 'Startsequenz' }),
        el('div', { class: 'row gap-8' }, [
          el('button', { class: 'btn subtle sm', text: 'Aus Bibliothek', onClick: () => pickFromLibrary(ctx) }, []),
          el('button', { class: 'btn subtle sm', onClick: () => addManual(ctx) }, [svg(ICON_PLUS, { width: 13, height: 13 }), 'Manuell'])
        ])
      ]),
      appsHost,
      el('div', {
        class: 'faint',
        style: { fontSize: '11px' },
        text: 'Die Verzögerung gilt vor dem jeweiligen Start. Starte das Spiel zuletzt, damit es den Fokus behält.'
      })
    ]),

    el('div', { class: 'setting-row' }, [
      el('div', {}, [
        el('div', { class: 'setting-label', text: 'Hub beim Start minimieren' }),
        el('div', { class: 'setting-hint', text: 'Empfohlen, damit das Spiel nicht gegen den Hub um den Fokus kämpft.' })
      ]),
      el('div', {
        class: 'toggle',
        role: 'switch',
        'aria-checked': String(profile.minimizeOnLaunch !== false),
        onClick: (event) => {
          profile.minimizeOnLaunch = !(profile.minimizeOnLaunch !== false);
          event.currentTarget.setAttribute('aria-checked', String(profile.minimizeOnLaunch));
        }
      })
    ])
  ]);

  openModal({
    title: existing ? 'Profil bearbeiten' : 'Neues Profil',
    width: '780px',
    render: () => body,
    actions: (close) => [
      existing
        ? el('button', {
          class: 'btn danger',
          text: 'Löschen',
          onClick: async () => {
            const sure = await confirmDialog({
              title: 'Profil löschen',
              message: `„${existing.name}" wird dauerhaft entfernt. Installierte Programme bleiben unberührt.`,
              confirmLabel: 'Löschen',
              danger: true
            });
            if (!sure) return;
            try {
              await api.profiles.remove(existing.id);
              await loadProfiles();
              notifyOk('Profil gelöscht');
              close();
              if (onSaved) onSaved(null);
            } catch (err) { notifyError(err.message); }
          }
        })
        : null,
      el('div', { class: 'grow' }),
      el('button', { class: 'btn subtle', text: 'Abbrechen', onClick: () => close() }),
      el('button', {
        class: 'btn primary',
        text: 'Speichern',
        onClick: async () => {
          profile.name = nameInput.value.trim();
          profile.tagline = taglineInput.value.trim();
          profile.accent = colorInput.value;
          if (!profile.name) { notifyError('Profilname fehlt'); return; }
          if (!profile.accent) profile.accent = colorFromString(profile.name);
          try {
            const saved = await api.profiles.save(profile);
            await loadProfiles();
            notifyOk(`Profil „${saved.name}" gespeichert`);
            close();
            if (onSaved) onSaved(saved);
          } catch (err) { notifyError(err.message); }
        }
      })
    ]
  });
}
