import { el, svg, clear } from '../util.js';
import { api } from '../api.js';
import { openModal } from '../widgets/modal.js';
import { notifyError } from '../widgets/toast.js';

/**
 * The part of a profile that changes the machine rather than starting programs.
 *
 * Kept in its own module because it is the one section that talks to the system
 * on its own — it reads the power plans and the running process list while the
 * editor is open — and because the editor was long enough already.
 */

const ICON_PLUS = 'M12 5v14M5 12h14';
const ICON_X = 'M6 6l12 12M18 6L6 18';

const DEFAULTS = {
  powerPlan: null,
  priority: 'normal',
  priorityTarget: '',
  closeApps: [],
  restoreClosed: true,
  keepAwake: false,
  restore: true
};

/** Names that are never worth offering as something to close. */
const HIDDEN = new Set([
  'system', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services',
  'lsass', 'explorer', 'dwm', 'fontdrvhost', 'sihost', 'ctfmon', 'audiodg',
  'svchost', 'runtimebroker', 'searchhost', 'shellexperiencehost',
  'startmenuexperiencehost', 'textinputhost', 'widgets', 'windows hub',
  'memory compression', 'idle', 'conhost', 'taskhostw'
]);

function toggleRow(label, hint, get, set) {
  const toggle = el('div', {
    class: 'toggle',
    role: 'switch',
    'aria-checked': String(!!get()),
    onClick: (event) => {
      const next = event.currentTarget.getAttribute('aria-checked') !== 'true';
      event.currentTarget.setAttribute('aria-checked', String(next));
      set(next);
    }
  });
  return el('div', { class: 'setting-row' }, [
    el('div', {}, [
      el('div', { class: 'setting-label', text: label }),
      el('div', { class: 'setting-hint', text: hint })
    ]),
    toggle
  ]);
}

/** Lets the user pick from what is actually running instead of typing names. */
async function pickRunning(current, onPick) {
  let rows = [];
  try {
    const data = await api.processes.list();
    const seen = new Map();
    for (const p of data.processes || []) {
      const key = p.name.toLowerCase();
      if (HIDDEN.has(key)) continue;
      const entry = seen.get(key) || { name: p.name, memory: 0, count: 0, title: '' };
      entry.memory += p.memory;
      entry.count += 1;
      if (!entry.title && p.title) entry.title = p.title;
      seen.set(key, entry);
    }
    // Heaviest first: those are the ones worth closing before a game.
    rows = [...seen.values()].sort((a, b) => b.memory - a.memory).slice(0, 60);
  } catch (err) {
    notifyError(err.message);
    return;
  }

  const chosen = new Set(current.map((n) => n.toLowerCase()));
  const listHost = el('div', { class: 'editor-apps', style: { maxHeight: '380px', overflow: 'auto' } });

  const render = () => {
    clear(listHost);
    for (const row of rows) {
      const active = chosen.has(row.name.toLowerCase());
      listHost.appendChild(el('div', {
        class: `pick-row${active ? ' selected' : ''}`,
        onClick: () => {
          const key = row.name.toLowerCase();
          if (chosen.has(key)) chosen.delete(key); else chosen.add(key);
          render();
        }
      }, [
        el('div', { class: 'stack grow' }, [
          el('div', { class: 'app-name truncate', text: row.name }),
          el('div', { class: 'app-target truncate', text: row.title || `${row.count} Prozess${row.count === 1 ? '' : 'e'}` })
        ]),
        el('span', { class: active ? 'badge accent' : 'badge', text: active ? 'gewählt' : `${Math.round(row.memory / 1048576)} MB` })
      ]));
    }
  };
  render();

  openModal({
    title: 'Hintergrundprogramme wählen',
    width: '560px',
    render: () => el('div', { class: 'stack gap-12' }, [
      el('div', { class: 'setting-hint', text:
        'Die Liste zeigt, was gerade läuft, nach Speicherverbrauch sortiert. Systemprozesse sind ausgeblendet.' }),
      listHost
    ]),
    actions: (close) => [
      el('div', { class: 'grow' }),
      el('button', { class: 'btn subtle', text: 'Abbrechen', onClick: () => close() }),
      el('button', {
        class: 'btn primary',
        text: 'Übernehmen',
        onClick: () => {
          const names = rows.filter((r) => chosen.has(r.name.toLowerCase())).map((r) => r.name);
          // Names typed by hand that are not running right now must survive.
          for (const name of current) {
            if (chosen.has(name.toLowerCase()) && !names.some((n) => n.toLowerCase() === name.toLowerCase())) {
              names.push(name);
            }
          }
          onPick(names);
          close();
        }
      })
    ]
  });
}

/**
 * Builds the section and writes straight into `profile.system`.
 * Returns the node; the editor only has to place it.
 */
export function createSystemSection(profile) {
  profile.system = { ...DEFAULTS, ...(profile.system || {}) };
  const system = profile.system;
  if (!Array.isArray(profile.alsoClose)) profile.alsoClose = [];

  /* ------------------------------------------------------------ power plan */

  const planSelect = el('select', { class: 'select' }, [
    el('option', { value: '', text: 'Nicht ändern' })
  ]);
  planSelect.value = '';
  planSelect.addEventListener('change', () => { system.powerPlan = planSelect.value || null; });

  const planHint = el('div', { class: 'setting-hint', text: 'Wird gelesen …' });

  api.tweaks.powerPlans().then((plans) => {
    for (const plan of plans) {
      planSelect.appendChild(el('option', {
        value: plan.guid,
        text: plan.active ? `${plan.label} (aktiv)` : plan.label
      }));
    }
    if (system.powerPlan) planSelect.value = system.powerPlan;
    // A stored plan that no longer exists would silently fall back to
    // "do not change" without the user ever being told.
    if (system.powerPlan && planSelect.value !== system.powerPlan) {
      planHint.textContent = 'Der gespeicherte Energieplan existiert auf diesem Rechner nicht mehr.';
      planHint.classList.add('warn');
      return;
    }
    planHint.textContent = plans.length
      ? 'Beim Beenden des Profils wird der vorherige Plan wiederhergestellt.'
      : 'Keine Energiepläne gefunden.';
  }).catch((err) => { planHint.textContent = err.message; });

  /* -------------------------------------------------------------- priority */

  const prioritySelect = el('select', { class: 'select' });
  const priorityHint = el('div', { class: 'setting-hint', text: '' });
  const priorityTarget = el('input', {
    class: 'input',
    value: system.priorityTarget || '',
    placeholder: 'automatisch: letztes Programm der Sequenz'
  });
  priorityTarget.addEventListener('input', () => {
    system.priorityTarget = priorityTarget.value.trim().replace(/\.exe$/i, '');
  });

  let priorities = [];
  const syncPriorityUi = () => {
    const spec = priorities.find((p) => p.value === prioritySelect.value);
    priorityHint.textContent = spec ? spec.hint : '';
    priorityTarget.disabled = prioritySelect.value === 'normal';
  };

  api.tweaks.status().then((status) => {
    priorities = status.priorities || [];
    for (const p of priorities) prioritySelect.appendChild(el('option', { value: p.value, text: p.label }));
    prioritySelect.value = system.priority || 'normal';
    syncPriorityUi();
  }).catch((err) => { priorityHint.textContent = err.message; });

  prioritySelect.addEventListener('change', () => {
    system.priority = prioritySelect.value;
    syncPriorityUi();
  });

  /* -------------------------------------------------- background programmes */

  const chipHost = el('div', { class: 'row gap-8', style: { flexWrap: 'wrap' } });
  const manualInput = el('input', { class: 'input', placeholder: 'Prozessname, z. B. chrome' });

  function renderChips() {
    clear(chipHost);
    if (!system.closeApps.length) {
      chipHost.appendChild(el('span', { class: 'faint', style: { fontSize: '12px' }, text: 'Nichts ausgewählt' }));
      return;
    }
    for (const name of system.closeApps) {
      chipHost.appendChild(el('span', { class: 'chip' }, [
        name,
        el('button', {
          class: 'chip-x',
          title: 'Entfernen',
          onClick: () => {
            system.closeApps = system.closeApps.filter((n) => n !== name);
            renderChips();
          }
        }, [svg(ICON_X, { width: 10, height: 10 })])
      ]));
    }
  }

  function addManual() {
    const name = manualInput.value.trim().replace(/\.exe$/i, '');
    if (!name) return;
    if (!system.closeApps.some((n) => n.toLowerCase() === name.toLowerCase())) system.closeApps.push(name);
    manualInput.value = '';
    renderChips();
  }

  manualInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); addManual(); }
  });

  renderChips();

  /* ------------------------------------------------ extras closed on stop */

  const alsoHost = el('div', { class: 'row gap-8', style: { flexWrap: 'wrap' } });
  const alsoInput = el('input', { class: 'input', placeholder: 'Prozessname, z. B. helldivers2' });

  function renderAlso() {
    clear(alsoHost);
    if (!profile.alsoClose.length) {
      alsoHost.appendChild(el('span', { class: 'faint', style: { fontSize: '12px' }, text: 'Nichts zusätzlich' }));
      return;
    }
    for (const name of profile.alsoClose) {
      alsoHost.appendChild(el('span', { class: 'chip' }, [
        name,
        el('button', {
          class: 'chip-x',
          title: 'Entfernen',
          onClick: () => {
            profile.alsoClose = profile.alsoClose.filter((n) => n !== name);
            renderAlso();
          }
        }, [svg(ICON_X, { width: 10, height: 10 })])
      ]));
    }
  }

  function addAlso() {
    const name = alsoInput.value.trim().replace(/\.(exe|com|bat|cmd)$/i, '');
    if (!name) return;
    if (!profile.alsoClose.some((n) => n.toLowerCase() === name.toLowerCase())) profile.alsoClose.push(name);
    alsoInput.value = '';
    renderAlso();
  }

  alsoInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); addAlso(); }
  });

  renderAlso();

  /* ----------------------------------------------------------------- shell */

  return el('div', { class: 'stack gap-12' }, [
    el('div', { class: 'row between' }, [
      el('span', { class: 'label', text: 'Systemzustand' }),
      el('span', { class: 'faint', style: { fontSize: '11px' }, text: 'Alles hier wird beim Beenden des Profils zurückgenommen' })
    ]),

    el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', alignItems: 'start' } }, [
      el('div', { class: 'field' }, [
        el('label', { text: 'Energieplan' }),
        planSelect,
        planHint
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Priorität des Spiels' }),
        prioritySelect,
        priorityHint
      ])
    ]),

    el('div', { class: 'field' }, [
      el('label', { text: 'Programm für die Priorität' }),
      priorityTarget,
      el('div', { class: 'setting-hint', text:
        'Leer lassen, wenn das letzte Programm der Startsequenz gemeint ist. Ein über Steam gestartetes Spiel '
        + 'erscheint unter seinem eigenen Namen, nicht unter dem des Launchers.' })
    ]),

    el('div', { class: 'stack gap-8' }, [
      el('div', { class: 'row between' }, [
        el('span', { class: 'label', text: 'Vorher beenden' }),
        el('button', {
          class: 'btn subtle sm',
          text: 'Aus laufenden Programmen',
          onClick: () => pickRunning(system.closeApps, (names) => { system.closeApps = names; renderChips(); })
        })
      ]),
      chipHost,
      el('div', { class: 'row gap-8' }, [
        manualInput,
        el('button', { class: 'btn subtle sm', onClick: addManual }, [svg(ICON_PLUS, { width: 13, height: 13 }), 'Hinzufügen'])
      ])
    ]),

    el('div', { class: 'stack gap-8' }, [
      el('div', { class: 'row between' }, [
        el('span', { class: 'label', text: 'Beim Beenden zusätzlich schließen' }),
        el('button', {
          class: 'btn subtle sm',
          text: 'Aus laufenden Programmen',
          onClick: () => pickRunning(profile.alsoClose, (names) => { profile.alsoClose = names; renderAlso(); })
        })
      ]),
      alsoHost,
      el('div', { class: 'row gap-8' }, [
        alsoInput,
        el('button', { class: 'btn subtle sm', onClick: addAlso }, [svg(ICON_PLUS, { width: 13, height: 13 }), 'Hinzufügen'])
      ]),
      el('div', { class: 'setting-hint', text:
        'Für Programme, die der Hub nicht von selbst zuordnen kann — etwa ein über Steam gestartetes Spiel, '
        + 'dessen Prozess anders heißt als der Eintrag. Beendet wird unabhängig davon, ob das Programm schon '
        + 'vor dem Profilstart lief.' })
    ]),

    toggleRow(
      'Beendete Programme danach neu starten',
      'Der Pfad wird vor dem Beenden gemerkt. Programme ohne lesbaren Pfad bleiben zu.',
      () => system.restoreClosed !== false,
      (v) => { system.restoreClosed = v; }
    ),

    toggleRow(
      'Bildschirm wach halten',
      'Verhindert Bildschirmschoner und Energiesparmodus, solange das Profil läuft. Sinnvoll für Controller-Spiele.',
      () => !!system.keepAwake,
      (v) => { system.keepAwake = v; }
    ),

    toggleRow(
      'Beim Beenden zurücksetzen',
      'Aus lassen heißt: Energieplan und geschlossene Programme bleiben, wie das Profil sie hinterlassen hat.',
      () => system.restore !== false,
      (v) => { system.restore = v; }
    )
  ]);
}
