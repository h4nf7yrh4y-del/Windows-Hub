import { el, clear, svg } from '../util.js';
import { api } from '../api.js';
import { openModal, confirmDialog } from '../widgets/modal.js';
import { notifyError, notifyOk } from '../widgets/toast.js';

/**
 * How much time went where.
 *
 * The numbers come from the same process check that drives the running
 * indicator, so this needed no new data source — only somewhere to show it.
 * Deliberately a dialog rather than a view: it is something you look at
 * occasionally, not a place you navigate to.
 */

const ICON_TRASH = 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13';

export function duration(ms) {
  const minutes = Math.round((Number(ms) || 0) / 60000);
  if (minutes < 1) return '—';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function relativeDay(timestamp) {
  if (!timestamp) return 'nie';
  const days = Math.floor((Date.now() - timestamp) / (24 * 3600 * 1000));
  if (days <= 0) return 'heute';
  if (days === 1) return 'gestern';
  if (days < 7) return `vor ${days} Tagen`;
  return new Date(timestamp).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function dayChart(days) {
  const peak = Math.max(1, ...days.map((d) => d.ms));
  return el('div', { class: 'stat-days' }, days.map((day) => {
    const date = new Date(day.at);
    return el('div', {
      class: 'stat-day',
      title: `${date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}: ${duration(day.ms)}`
    }, [
      el('div', { class: 'stat-day-bar' }, [
        el('i', { style: { height: `${Math.max(2, (day.ms / peak) * 100)}%` } })
      ]),
      el('span', { class: 'stat-day-label', text: date.toLocaleDateString('de-DE', { weekday: 'narrow' }) })
    ]);
  }));
}

export function openStats() {
  const host = el('div', { class: 'stack gap-12' });

  async function render() {
    let data;
    try {
      data = await api.sessions.stats();
    } catch (err) {
      notifyError(err.message);
      return;
    }

    clear(host);

    if (!data.sessionCount) {
      host.appendChild(el('div', { class: 'empty', style: { padding: '34px' } }, [
        el('div', { class: 'empty-title', text: 'Noch keine Zeiten erfasst' }),
        el('div', { style: { fontSize: '12px', lineHeight: '1.6' }, text:
          'Die Messung beginnt, sobald du ein Profil startest, und endet, wenn dessen Programme zu sind. '
          + 'Läufe unter einer Minute werden nicht gezählt, und ein Lauf, bei dem der Hub abstürzt, geht verloren '
          + '— eine fehlende Sitzung ist die kleinere Unwahrheit als eine erfundene.' })
      ]));
      return;
    }

    host.appendChild(el('div', { class: 'stat-summary' }, [
      el('div', { class: 'stat-box' }, [
        el('div', { class: 'stat-value', text: duration(data.weekMs) }),
        el('div', { class: 'stat-label', text: 'Letzte 7 Tage' })
      ]),
      el('div', { class: 'stat-box' }, [
        el('div', { class: 'stat-value', text: duration(data.totalMs) }),
        el('div', { class: 'stat-label', text: 'Insgesamt' })
      ]),
      el('div', { class: 'stat-box' }, [
        el('div', { class: 'stat-value', text: String(data.sessionCount) }),
        el('div', { class: 'stat-label', text: 'Sitzungen' })
      ])
    ]));

    host.appendChild(dayChart(data.days));

    const rows = data.rows.filter((row) => row.sessions > 0);
    if (rows.length) {
      host.appendChild(el('div', { class: 'stack gap-4' }, rows.map((row) => el('div', {
        class: `stat-row${row.running ? ' live' : ''}`,
        style: { '--row-accent': row.accent || 'var(--accent)' }
      }, [
        el('div', { class: 'stack grow', style: { minWidth: '0' } }, [
          el('div', { class: 'app-name truncate', text: row.name }),
          el('div', { class: 'app-target', text:
            `${row.sessions} Sitzungen · längste ${duration(row.longestMs)} · zuletzt ${relativeDay(row.lastEnd)}` })
        ]),
        el('div', { class: 'stat-times' }, [
          el('span', { class: 'stat-week', text: duration(row.weekMs) }),
          el('span', { class: 'stat-total', text: duration(row.totalMs) })
        ]),
        row.running ? el('span', { class: 'badge accent', text: 'läuft' }) : null
      ]))));
    }

    const notes = [];
    if (data.deletedProfilesMs) {
      // Dropping these rows would quietly rewrite the past.
      notes.push(`${duration(data.deletedProfilesMs)} entfallen auf inzwischen gelöschte Profile.`);
    }
    notes.push('Gemessen wird, solange Prozesse des Profils laufen — nicht, wie lange der Hub offen war.');
    host.appendChild(el('div', { class: 'setting-hint', text: notes.join(' ') }));
  }

  openModal({
    title: 'Spielzeit',
    width: '620px',
    render: () => host,
    actions: (close) => [
      el('button', {
        class: 'btn subtle sm',
        title: 'Alle erfassten Zeiten löschen',
        onClick: async () => {
          const sure = await confirmDialog({
            title: 'Zeiten löschen',
            message: 'Alle erfassten Sitzungen werden entfernt. Die Profile selbst bleiben.',
            confirmLabel: 'Löschen',
            danger: true
          });
          if (!sure) return;
          try {
            await api.sessions.clear();
            notifyOk('Zeiten gelöscht');
            render();
          } catch (err) { notifyError(err.message); }
        }
      }, [svg(ICON_TRASH, { width: 13, height: 13 }), 'Zurücksetzen']),
      el('div', { class: 'grow' }),
      el('button', { class: 'btn subtle', text: 'Schließen', onClick: () => close() })
    ]
  });

  render();
}
