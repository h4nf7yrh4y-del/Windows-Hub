import { el, svg, clear } from '../util.js';
import { api } from '../api.js';
import { openModal, confirmDialog } from '../widgets/modal.js';
import { notifyError, notifyOk } from '../widgets/toast.js';
import { state } from '../state.js';

/**
 * Time-of-day rules for profiles.
 *
 * Kept behind a button rather than given a rail entry: it is something set up
 * twice and then forgotten, which is the opposite of what the rail is for.
 */

const ICON_PLUS = 'M12 5v14M5 12h14';
const ICON_TRASH = 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13';

const PRESETS = [
  { label: 'Täglich', days: [0, 1, 2, 3, 4, 5, 6] },
  { label: 'Mo–Fr', days: [1, 2, 3, 4, 5] },
  { label: 'Wochenende', days: [0, 6] }
];

function relativeNext(timestamp) {
  if (!timestamp) return 'nie';
  const diff = timestamp - Date.now();
  if (diff < 0) return 'überfällig';
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} Tagen`;
}

function editEntry(existing, meta, onSaved) {
  const draft = existing
    ? { ...existing }
    : { profileId: (state.profiles[0] || {}).id || '', action: 'launch', time: '20:00', days: [1, 2, 3, 4, 5], enabled: true };

  const profileSelect = el('select', { class: 'select' }, state.profiles.map((p) =>
    el('option', { value: p.id, text: p.name })));
  profileSelect.value = draft.profileId;

  const actionSelect = el('select', { class: 'select' }, meta.actions.map((a) =>
    el('option', { value: a.value, text: a.label })));
  actionSelect.value = draft.action;

  const timeInput = el('input', { class: 'input', type: 'time', value: draft.time });

  const dayButtons = meta.dayLabels.map((label, index) => el('button', {
    class: `day-btn${draft.days.includes(index) ? ' active' : ''}`,
    text: label,
    onClick: (event) => {
      const day = index;
      draft.days = draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day];
      event.currentTarget.classList.toggle('active', draft.days.includes(day));
    }
  }));

  openModal({
    title: existing ? 'Zeitplan bearbeiten' : 'Neuer Zeitplan',
    width: '520px',
    render: () => el('div', { class: 'stack gap-12' }, [
      el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } }, [
        el('div', { class: 'field' }, [el('label', { text: 'Profil' }), profileSelect]),
        el('div', { class: 'field' }, [el('label', { text: 'Aktion' }), actionSelect])
      ]),
      el('div', { class: 'field' }, [el('label', { text: 'Uhrzeit' }), timeInput]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Wochentage' }),
        el('div', { class: 'day-row' }, dayButtons),
        el('div', { class: 'row gap-8', style: { marginTop: '8px' } }, PRESETS.map((preset) => el('button', {
          class: 'btn subtle sm',
          text: preset.label,
          onClick: () => {
            draft.days = [...preset.days];
            dayButtons.forEach((b, i) => b.classList.toggle('active', draft.days.includes(i)));
          }
        })))
      ]),
      el('div', { class: 'setting-hint', text:
        'Der Hub muss zu diesem Zeitpunkt laufen. Ein Zeitpunkt, der mehr als fünf Minuten zurückliegt, '
        + 'wird übersprungen statt nachgeholt — sonst würde ein Spiel starten, nur weil der Rechner spät '
        + 'eingeschaltet wurde.' })
    ]),
    actions: (close) => [
      el('div', { class: 'grow' }),
      el('button', { class: 'btn subtle', text: 'Abbrechen', onClick: () => close() }),
      el('button', {
        class: 'btn primary',
        text: 'Speichern',
        onClick: async () => {
          try {
            await api.schedule.save({
              ...draft,
              profileId: profileSelect.value,
              action: actionSelect.value,
              time: timeInput.value
            });
            notifyOk('Zeitplan gespeichert');
            close();
            onSaved();
          } catch (err) { notifyError(err.message); }
        }
      })
    ]
  });
}

export function openScheduleManager() {
  const listHost = el('div', { class: 'stack gap-8' });
  let meta = { actions: [], dayLabels: [] };

  async function refresh() {
    let data;
    try {
      data = await api.schedule.list();
    } catch (err) {
      notifyError(err.message);
      return;
    }
    meta = data;
    clear(listHost);

    if (!data.entries.length) {
      listHost.appendChild(el('div', { class: 'empty', style: { padding: '30px' } }, [
        el('div', { class: 'empty-title', text: 'Kein Zeitplan' }),
        el('div', { style: { fontSize: '12px' }, text: 'Zum Beispiel: Arbeitsprofil werktags um 8, Spielprofil freitags um 20 Uhr.' })
      ]));
      return;
    }

    for (const entry of data.entries) {
      const profile = state.profiles.find((p) => p.id === entry.profileId);
      const action = data.actions.find((a) => a.value === entry.action);
      listHost.appendChild(el('div', { class: `sched-row${entry.enabled ? '' : ' off'}` }, [
        el('div', {
          class: 'toggle',
          role: 'switch',
          'aria-checked': String(!!entry.enabled),
          title: entry.enabled ? 'Deaktivieren' : 'Aktivieren',
          onClick: async (event) => {
            const next = event.currentTarget.getAttribute('aria-checked') !== 'true';
            event.currentTarget.setAttribute('aria-checked', String(next));
            try {
              await api.schedule.save({ ...entry, enabled: next });
              refresh();
            } catch (err) {
              notifyError(err.message);
              event.currentTarget.setAttribute('aria-checked', String(!next));
            }
          }
        }),
        el('div', { class: 'stack grow', style: { minWidth: '0' } }, [
          el('div', { class: 'app-name truncate', text: `${profile ? profile.name : 'Gelöschtes Profil'} · ${action ? action.label : entry.action}` }),
          el('div', { class: 'app-target', text: `${entry.description} · nächster Lauf ${relativeNext(entry.nextRun)}` })
        ]),
        el('button', {
          class: 'btn subtle xs',
          text: 'Jetzt',
          title: 'Sofort ausführen',
          onClick: async () => {
            try {
              await api.schedule.runNow(entry.id);
              notifyOk('Ausgeführt');
            } catch (err) { notifyError(err.message); }
          }
        }),
        el('button', { class: 'btn subtle xs', text: 'Ändern', onClick: () => editEntry(entry, meta, refresh) }),
        el('button', {
          class: 'icon-btn danger',
          title: 'Entfernen',
          onClick: async () => {
            const sure = await confirmDialog({
              title: 'Zeitplan entfernen',
              message: `„${entry.description}" wird gelöscht. Das Profil selbst bleibt.`,
              confirmLabel: 'Entfernen',
              danger: true
            });
            if (!sure) return;
            try {
              await api.schedule.remove(entry.id);
              refresh();
            } catch (err) { notifyError(err.message); }
          }
        }, [svg(ICON_TRASH, { width: 14, height: 14 })])
      ]));
    }
  }

  openModal({
    title: 'Zeitplan',
    width: '640px',
    render: () => el('div', { class: 'stack gap-12' }, [
      el('div', { class: 'setting-hint', text:
        'Startet oder beendet ein Profil zu festen Zeiten, solange der Hub läuft.' }),
      listHost
    ]),
    actions: (close) => [
      el('button', {
        class: 'btn primary',
        onClick: () => {
          if (!state.profiles.length) { notifyError('Lege zuerst ein Profil an'); return; }
          editEntry(null, meta, refresh);
        }
      }, [svg(ICON_PLUS, { width: 13, height: 13 }), 'Eintrag hinzufügen']),
      el('div', { class: 'grow' }),
      el('button', { class: 'btn subtle', text: 'Schließen', onClick: () => close() })
    ]
  });

  refresh();
}
