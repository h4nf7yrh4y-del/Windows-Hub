import { el, clear, svg } from '../util.js';
import { api } from '../api.js';
import { openModal } from '../widgets/modal.js';
import { notifyError, notifyOk } from '../widgets/toast.js';
import { loadProfiles, saveSettings, state } from '../state.js';

/**
 * The first five minutes.
 *
 * The hub has twenty-six views and, on a fresh install, an empty profile grid.
 * Someone opening it for the first time sees a launcher with nothing to launch
 * and no indication that it already knows what is on their machine -- the
 * scanner finds their Steam and Epic libraries, their Start Menu, their Store
 * apps, and none of that is visible until they go looking for it.
 *
 * So this offers one thing and finishes: pick a game, and it builds a profile
 * around it. Not a tour of the features, not a settings questionnaire. The
 * shortest path from "installed" to "there is something to press".
 *
 * Two decisions worth stating. It never runs twice: the flag is written when
 * the wizard is finished *or* dismissed, because someone who closed it meant
 * it. And it does not appear when profiles already exist -- an upgrade from an
 * older version is not a first run, whatever the flag says.
 */

const ICON_CHECK = 'M4 12l5 5L20 6';
const ICON_GAME = 'M7 12h4M9 10v4M15 11h.01M17.5 13h.01M4 8h16v8H4z';

/* ------------------------------------------------------------------- pure */
/*
 * Everything down to the next marker is free of imports and of the DOM, so
 * `test/welcome.test.js` lifts it out of this file and runs it directly. The
 * choosing is where this feature is right or wrong: an empty grid and a list
 * of four hundred Start Menu entries are the same failure.
 */

/** Games first, then the things most people actually launch. */
function rank(item) {
  if (item.source === 'steam' || item.source === 'epic') return 0;
  if (item.kind === 'game') return 1;
  return 2;
}

/**
 * What to offer.
 *
 * Deliberately short. A list of four hundred Start Menu entries is the same
 * problem as an empty grid: nothing to decide from. Games come first because
 * that is what a profile is for, and because they are the entries with a
 * reliable launch target.
 */
function candidates(items) {
  return [...items]
    .filter((item) => item && item.name && item.launch)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, 24);
}

/** The programs people usually want beside a game, if they are installed. */
const COMPANIONS = [/^discord$/i, /^spotify$/i, /^steam$/i, /^obs studio$/i, /^teamspeak/i];

function companionsFrom(items) {
  const found = [];
  for (const pattern of COMPANIONS) {
    const match = items.find((item) => item && item.name && pattern.test(item.name.trim()));
    if (match) found.push(match);
  }
  return found;
}

/* --------------------------------------------------------------- end pure */

function appEntry(item) {
  return {
    id: item.id,
    name: item.name,
    enabled: true,
    launch: item.launch,
    delayMs: 0
  };
}

export function openWelcome({ onDone } = {}) {
  let items = [];
  let chosen = null;
  const extras = new Set();

  const body = el('div', { class: 'stack gap-12' });
  const status = el('div', { class: 'setting-hint', text: 'Programme werden gesucht …' });

  /** Renders whatever is known right now; the scan fills it in. */
  function render() {
    clear(body);

    body.appendChild(el('div', { class: 'setting-hint', style: { lineHeight: '1.65' }, text:
      'Ein Profil startet mehrere Programme auf einmal und räumt das System drumherum auf. '
      + 'Such dir ein Spiel aus — den Rest kannst du später jederzeit ändern.' }));

    if (!items.length) {
      body.appendChild(status);
      return;
    }

    const grid = el('div', { class: 'wiz-grid' });
    for (const item of candidates(items)) {
      const active = chosen && chosen.id === item.id;
      grid.appendChild(el('button', {
        class: `wiz-card${active ? ' active' : ''}`,
        onClick: () => { chosen = active ? null : item; render(); }
      }, [
        svg(active ? ICON_CHECK : ICON_GAME, { width: 14, height: 14 }),
        el('span', { class: 'truncate', text: item.name })
      ]));
    }
    body.appendChild(grid);

    const companions = companionsFrom(items);
    if (companions.length) {
      body.appendChild(el('div', { class: 'setting-label', text: 'Soll noch etwas mitstarten?' }));
      const row = el('div', { class: 'wiz-grid' });
      for (const item of companions) {
        const on = extras.has(item.id);
        row.appendChild(el('button', {
          class: `wiz-card${on ? ' active' : ''}`,
          onClick: () => { if (on) extras.delete(item.id); else extras.add(item.id); render(); }
        }, [
          svg(on ? ICON_CHECK : ICON_GAME, { width: 14, height: 14 }),
          el('span', { class: 'truncate', text: item.name })
        ]));
      }
      body.appendChild(row);
    }

    body.appendChild(el('div', { class: 'setting-hint', text: chosen
      ? `„${chosen.name}" wird angelegt. Danach kannst du im Editor Systemeinstellungen `
        + 'hinterlegen — Energieplan, Hintergrundprogramme schließen, Wiedergabegerät.'
      : 'Ohne Auswahl wird nichts angelegt. Du kannst den Hub auch so benutzen und '
        + 'später ein Profil von Hand anlegen.' }));
  }

  /**
   * Writes the profile.
   *
   * Goes through the same channel the editor uses, so the entry is sanitised
   * in the main process like any other. A wizard that wrote a shape nothing
   * else can produce would be a second source of profiles to keep working.
   */
  async function create() {
    if (!chosen) return null;
    const apps = [appEntry(chosen), ...items.filter((i) => extras.has(i.id)).map(appEntry)];
    const profile = {
      name: chosen.name,
      tagline: 'Beim Erststart angelegt',
      accent: state.settings.accent || '#00f0ff',
      apps,
      minimizeOnLaunch: true
    };
    const saved = await api.profiles.save(profile);
    await loadProfiles();
    return saved;
  }

  /** Remembered whether it was finished or dismissed; closing it meant it. */
  async function markSeen() {
    try {
      await saveSettings({ welcomeSeen: true });
    } catch (err) {
      // Not worth interrupting anyone over, but worth knowing about: the only
      // consequence is that the wizard appears again.
      console.warn('[welcome] Merker nicht gespeichert:', err.message);
    }
  }

  // Guards the flag against being written twice: the close handler fires for
  // every exit, including the ones that already recorded it.
  let seen = false;
  const remember = () => { if (!seen) { seen = true; markSeen(); } };

  const modal = openModal({
    title: 'Willkommen',
    width: '620px',
    render: () => body,
    actions: (close) => [
      el('button', {
        class: 'btn subtle',
        text: 'Überspringen',
        onClick: () => { remember(); close(null); if (onDone) onDone(null); }
      }),
      el('button', {
        class: 'btn primary',
        text: 'Profil anlegen',
        onClick: async (event) => {
          const button = event.currentTarget;
          button.setAttribute('aria-disabled', 'true');
          try {
            const saved = await create();
            remember();
            close(saved);
            if (saved) notifyOk(`Profil „${saved.name}" angelegt`);
            if (onDone) onDone(saved);
          } catch (err) {
            button.removeAttribute('aria-disabled');
            notifyError(err.message);
          }
        }
      })
    ],
    onClose: remember
  });

  render();

  // The scan is a system call and can take a few seconds; the dialog is up and
  // readable before it returns rather than after.
  api.library.scan().then((data) => {
    items = (data && data.items) || [];
    if (!items.length) {
      status.textContent = 'Es wurde nichts gefunden. Unter Windows durchsucht der Hub '
        + 'Steam, Epic, das Startmenü und die Store-Apps.';
      return;
    }
    render();
  }).catch((err) => {
    status.textContent = `Suche fehlgeschlagen: ${err.message}`;
  });

  return modal;
}

/**
 * Whether this is a first run, and if so, runs it.
 *
 * The flag alone is not enough. Someone upgrading from a version that predates
 * it has no flag and a full profile grid, and greeting them with a wizard
 * would be worse than never having written one.
 */
export async function maybeWelcome() {
  if (state.settings.welcomeSeen) return false;
  if ((state.profiles || []).length) {
    // Not a first run, whatever the flag says. Remember that so the check
    // stops happening.
    await saveSettings({ welcomeSeen: true }).catch(() => {});
    return false;
  }
  openWelcome();
  return true;
}
