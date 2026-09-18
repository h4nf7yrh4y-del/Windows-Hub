'use strict';

/**
 * What each view has to do to count as working.
 *
 * The assertions deliberately check structure and behaviour, not pixels: a
 * screenshot test would fail on every colour change, while these fail only
 * when something a user relies on stops existing. Windows-only data is absent
 * on the CI runner, so the checks target the shell each view builds around
 * that data, plus its empty and error states.
 */

/** Asserts that an IPC call comes back as a refusal mentioning `needle`. */
async function assertRejects(t, expression, needle, message) {
  const result = await t.evalExpr(`${expression}.then((r) => r)`);
  t.assert(result && result.ok === false && String(result.error || '').includes(needle),
    message, JSON.stringify(result));
}

module.exports = [

  {
    name: 'Grundgerüst: Leiste, Uhr, Kopfzeile',
    async run(t) {
      // A minimum plus the entries that have to be there, rather than an
      // exact count: the count was ten, adding a view made it eleven, and the
      // test failed for the one reason that is not a defect. What matters is
      // that nothing silently disappears from the rail.
      t.atLeast(await t.count('.rail-btn'), 10, 'Die Seitenleiste ist vollständig');
      const rail = await t.evalExpr(`[...document.querySelectorAll('.rail-btn')].map((n) => n.textContent.trim())`);
      for (const entry of ['Hub', 'Tasks', 'Updates', 'Speicher', 'Setup']) {
        t.assert(rail.some((label) => label.includes(entry)), `„${entry}" in der Seitenleiste`, rail.join(' | '));
      }
      t.assert(/^v\d+\.\d+\.\d+/.test((await t.text('#brand-version')) || ''),
        'Versionsnummer wird angezeigt', await t.text('#brand-version'));
      t.assert(/^\d{2}:\d{2}$/.test(((await t.text('#clock-time')) || '').trim()),
        'Uhrzeit ist gesetzt', await t.text('#clock-time'));
      t.assert(await t.exists('#mini-cpu-meter i'), 'CPU-Miniatur im Kopf vorhanden');
      t.assert(await t.exists('#mini-ram-meter i'), 'RAM-Miniatur im Kopf vorhanden');
      t.eq(await t.evalExpr(`document.getElementById('boot') === null
        || getComputedStyle(document.getElementById('boot')).display === 'none'
        || document.getElementById('boot').classList.contains('done')`), true,
      'Boot-Sequenz ist abgeschlossen');

      // The rail indicator is a moving element; if it never lands on the
      // active button the navigation looks broken even when it works.
      const indicator = await t.evalExpr(`(() => {
        const node = document.querySelector('.rail-indicator');
        if (!node) return null;
        return { top: Math.round(node.getBoundingClientRect().top), h: Math.round(node.getBoundingClientRect().height) };
      })()`);
      t.assert(indicator && indicator.h > 0, 'Aktiv-Markierung der Leiste ist sichtbar', JSON.stringify(indicator));
    }
  },

  {
    name: 'Befehlspalette: öffnen, suchen, ausführen',
    async run(t) {
      await t.view('hub');

      // The binding people try without being told.
      await t.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));`);
      await t.waitFor(`!!document.querySelector('.pal')`, { label: 'Palette' });

      t.assert(await t.exists('.pal-input'), 'Die Palette hat ein Eingabefeld');
      t.atLeast(await t.count('.pal-row'), 8, 'Ohne Eingabe stehen die Aktionen bereit');

      // Four hundred installed programs would drown the useful defaults.
      t.eq(await t.evalExpr(`[...document.querySelectorAll('.pal-row .pal-kind')].some((n) => n.textContent === 'Programm')`),
        false, 'Programme erscheinen erst, wenn danach gesucht wird');

      const typed = await t.js(`
        const input = document.querySelector('.pal-input');
        input.value = 'hd2';
        input.dispatchEvent(new Event('input'));
        return true;
      `);
      t.assert(typed, 'Eingabe möglich');
      await t.wait(300);

      t.eq(await t.evalExpr(`(document.querySelector('.pal-row .pal-title') || {}).textContent || null`),
        'Helldivers 2', 'Die Anfangsbuchstaben finden das Profil');
      t.eq(await t.evalExpr(`document.querySelector('.pal-row').classList.contains('active')`), true,
        'Der erste Treffer ist vorgewählt');

      // Arrow keys move the selection without touching the text.
      await t.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));`);
      await t.wait(200);
      t.eq(await t.evalExpr(`[...document.querySelectorAll('.pal-row')].findIndex((r) => r.classList.contains('active'))`),
        1, 'Pfeiltasten bewegen die Auswahl');

      await t.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
      await t.waitFor(`!document.querySelector('.pal')`, { label: 'geschlossene Palette' });

      // The handle in the top bar has to open the same thing.
      await t.click('#btn-palette');
      await t.waitFor(`!!document.querySelector('.pal')`, { label: 'Palette über den Knopf' });

      // Running an entry closes the palette and does what it says. The exact
      // title has to be first: on Windows the catalogue adds forty more
      // entries, and a palette whose top hit depends on the platform is a
      // palette nobody can trust.
      await t.js(`
        const input = document.querySelector('.pal-input');
        input.value = 'System';
        input.dispatchEvent(new Event('input'));
        return true;
      `);
      await t.waitFor(`(document.querySelector('.pal-row .pal-title') || {}).textContent === 'System'`,
        { label: 'System als erster Treffer' });
      await t.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
      await t.waitFor(`!document.querySelector('.pal')`, { label: 'Palette nach Ausführung' });
      // Generous because this actually builds the system view, which on the
      // two-core runner has taken ten seconds on its own -- the default budget
      // was shorter than the thing being waited for.
      await t.waitFor(`document.querySelector('.rail-btn.active').dataset.view === 'system'`,
        { label: 'gewechselte Ansicht', timeout: 45000 });
      t.eq(await t.evalExpr(`document.querySelector('.rail-btn.active').dataset.view`), 'system',
        'Enter führt den gewählten Eintrag aus');
    }
  },

  {
    name: 'Hub: Profilkarten und Anlegen-Kachel',
    async run(t) {
      await t.view('hub');
      t.eq(await t.count('.profile-grid .profile-card:not(.add-card)'), 1, 'Das gesäte Profil wird als Karte gezeigt');
      t.eq(await t.count('.profile-card.add-card'), 1, 'Anlegen-Kachel steht am Ende');
      t.eq(((await t.text('.card-name')) || '').trim(), 'Helldivers 2', 'Profilname steht auf der Karte');
      t.eq(await t.count('.card-apps .chip'), 3, 'Jedes Programm des Profils bekommt einen Chip');
      t.assert(((await t.text('[data-role="profile-count"]')) || '').includes('1 Profile'),
        'Zähler in der Kopfzeile stimmt', await t.text('[data-role="profile-count"]'));
      t.assert(await t.exists('.card-launch'), 'Startknopf auf der Karte');
      t.eq(await t.count('.card-actions .icon-btn'), 2, 'Beenden und Bearbeiten auf der Karte');
    }
  },

  {
    name: 'Profileditor: öffnen, Felder, abbrechen',
    async run(t) {
      await t.view('hub');
      await t.click('.profile-card.add-card');
      await t.waitFor(`!!document.querySelector('.modal')`, { label: 'Editor-Dialog' });
      t.assert(await t.exists('.modal .input'), 'Editor hat Eingabefelder');
      t.assert(await t.exists('.editor-apps'), 'Editor listet die Programme');
      t.assert(await t.exists('.accent-swatches'), 'Farbwahl im Editor vorhanden');

      // Cancelling must leave no profile behind and no dialog on screen.
      await t.clickText('.modal .btn', 'Abbrechen');
      await t.waitFor(`!document.querySelector('.modal')`, { label: 'geschlossener Dialog' });
      await t.view('hub');
      t.eq(await t.count('.profile-card:not(.add-card)'), 1, 'Abbrechen legt kein Profil an');
    }
  },

  {
    name: 'Profileditor: Systemreiter speichert die Einstellungen',
    async run(t) {
      await t.view('hub');
      // The pencil on the card, which is how a profile is edited; a click on
      // the card itself is reserved for launching it.
      await t.click('.profile-card .card-actions .icon-btn:last-child');
      await t.waitFor(`!!document.querySelector('.modal')`, { label: 'Editor-Dialog' });
      t.eq(await t.count('.modal .tab-bar .tab'), 2, 'Der Editor hat zwei Reiter');

      await t.clickText('.modal .tab-bar .tab', 'System');
      await t.wait(900);
      t.atLeast(await t.count('.modal .select'), 2, 'Energieplan und Priorität sind wählbar');
      t.atLeast(await t.count('.modal .toggle'), 3, 'Die drei Systemschalter sind da');
      t.assert(await t.evalExpr(
        `[...document.querySelectorAll('.modal .label')].some((n) => n.textContent.includes('zusätzlich schließen'))`
      ), 'Programme ohne Zuordnung lassen sich zum Beenden nachtragen');

      // Priority and its target belong together: no target field without a
      // priority to apply it to.
      t.eq(await t.evalExpr(
        `[...document.querySelectorAll('.modal .input')].some((i) => i.placeholder.includes('automatisch'))`
      ), true, 'Zielprogramm für die Priorität vorhanden');

      const set = await t.js(`
        const selects = [...document.querySelectorAll('.modal .select')];
        const priority = selects.find((s) => [...s.options].some((o) => o.value === 'high'));
        if (!priority) return null;
        priority.value = 'high';
        priority.dispatchEvent(new Event('change'));
        const input = [...document.querySelectorAll('.modal .input')].find((i) => i.placeholder && i.placeholder.includes('Prozessname'));
        input.value = 'helldivers2.exe';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return { priority: priority.value, chips: document.querySelectorAll('.modal .chip').length };
      `);
      t.assert(set && set.priority === 'high', 'Priorität lässt sich wählen', JSON.stringify(set));
      t.eq(set ? set.chips : 0, 1, 'Ein eingetippter Prozessname wird zum Chip');

      await t.clickText('.modal .btn', 'Speichern');
      await t.waitFor(`!document.querySelector('.modal')`, { label: 'geschlossener Dialog' });
      await t.wait(500);

      // The extension has to survive the round trip through the sanitizer.
      const stored = await t.evalExpr(
        `window.hub.profiles.list().then((r) => r.data.profiles[0].system)`
      );
      t.eq(stored && stored.priority, 'high', 'Priorität ist gespeichert', JSON.stringify(stored));
      t.assert(stored && stored.closeApps.includes('helldivers2'),
        'Der Prozessname ist ohne .exe gespeichert', JSON.stringify(stored && stored.closeApps));

      await t.view('hub');
      t.eq(await t.count('.card-tweaks'), 1, 'Die Karte zeigt, dass das Profil das System verändert');
    }
  },

  {
    name: 'Profil beenden: der Dialog zeigt, was wirklich geschlossen wird',
    async run(t) {
      await t.view('hub');

      // The seeded profile launches everything through protocol handlers, which
      // is exactly the case that used to contribute nothing to the kill list.
      const plan = await t.evalExpr(`window.hub.profiles.list()
        .then((r) => window.hub.profiles.stopPlan(r.data.profiles[0].id))
        .then((r) => r.data)`);
      t.assert(plan.names.includes('Spotify'), 'Spotify wird beendet, obwohl es über spotify: startet',
        JSON.stringify(plan.names));
      t.assert(plan.names.some((n) => n.startsWith('Discord')), 'Discord ebenso', JSON.stringify(plan.names));
      t.eq(plan.unresolved.length, 1, 'Das Spiel über steam://rungameid bleibt unzuordenbar', JSON.stringify(plan.unresolved));
      t.eq(plan.unresolved[0].name, 'Spiel', 'Und es wird namentlich gemeldet');

      // The dialog has to say both halves, otherwise the gap is invisible again.
      await t.click('.profile-card .card-actions .icon-btn:first-child');
      await t.waitFor(`!!document.querySelector('.modal')`, { label: 'Beenden-Dialog' });
      const text = (await t.text('.modal')) || '';
      t.assert(text.includes('Spotify'), 'Der Dialog nennt die Programme, die geschlossen werden');
      t.assert(text.includes('Spiel'), 'Und die, für die kein Prozess hinterlegt ist');
      t.assert(text.includes('vor dem Profilstart lief'),
        'Und dass ein vorher laufendes Programm ebenfalls beendet wird');

      await t.clickText('.modal .btn', 'Abbrechen');
      await t.waitFor(`!document.querySelector('.modal')`, { label: 'geschlossener Dialog' });
    }
  },

  {
    name: 'Spielzeit: Dialog, Leerzustand, Zurücksetzen',
    async run(t) {
      await t.view('hub');
      await t.clickText('#view-hub .btn', 'Spielzeit');
      await t.waitFor(`!!document.querySelector('.modal')`, { label: 'Spielzeit-Dialog' });

      // Nothing has run yet, so the dialog has to explain itself rather than
      // show three zeroes.
      const text = (await t.text('.modal')) || '';
      t.assert(text.includes('Noch keine Zeiten erfasst'), 'Ohne Daten steht dort, was gemessen wird');
      t.assert(text.includes('unter einer Minute'), 'Und dass sehr kurze Läufe nicht zählen');

      const stats = await t.evalExpr(`window.hub.sessions.stats().then((r) => r.data)`);
      t.eq(stats.sessionCount, 0, 'Noch keine Sitzungen');
      t.eq(stats.days.length, 14, 'Der Verlauf deckt immer vierzehn Tage ab');
      t.assert(Array.isArray(stats.rows), 'Die Profilzeilen sind eine Liste');

      await t.clickText('.modal .btn', 'Schließen');
      await t.waitFor(`!document.querySelector('.modal')`, { label: 'geschlossener Dialog' });
    }
  },

  {
    name: 'Zeitplan: anlegen, listen, entfernen',
    async run(t) {
      await t.view('hub');
      await t.clickText('#view-hub .btn', 'Zeitplan');
      await t.waitFor(`!!document.querySelector('.modal')`, { label: 'Zeitplan-Dialog' });
      t.assert(await t.exists('.modal .empty-title'), 'Ohne Einträge steht dort, wofür das gut ist');

      await t.clickText('.modal .btn', 'Eintrag hinzufügen');
      await t.waitFor(`document.querySelectorAll('.modal').length > 1`, { label: 'Editor-Dialog' });
      t.eq(await t.count('.modal .day-btn'), 7, 'Sieben Wochentage zur Wahl');
      t.atLeast(await t.evalExpr(`document.querySelectorAll('.modal .day-btn.active').length`), 1,
        'Eine sinnvolle Vorauswahl ist gesetzt');

      const set = await t.js(`
        const modal = [...document.querySelectorAll('.modal')].pop();
        modal.querySelector('input[type=time]').value = '20:15';
        return true;
      `);
      t.assert(set, 'Uhrzeit lässt sich setzen');

      await t.js(`
        const modal = [...document.querySelectorAll('.modal')].pop();
        [...modal.querySelectorAll('.btn')].find((b) => b.textContent.trim() === 'Speichern').click();
        return true;
      `);
      await t.wait(900);

      const stored = await t.evalExpr(`window.hub.schedule.list().then((r) => r.data.entries)`);
      t.eq(stored.length, 1, 'Der Eintrag ist gespeichert', JSON.stringify(stored));
      t.eq(stored[0].time, '20:15', 'Die Uhrzeit ist übernommen');
      t.assert(stored[0].nextRun > Date.now(), 'Der nächste Lauf liegt in der Zukunft');
      t.assert(String(stored[0].description).includes('20:15'), 'Die Beschreibung nennt die Uhrzeit', stored[0].description);

      // A time that has already passed today must not be pending for today.
      t.assert(stored[0].nextRun - Date.now() < 8 * 24 * 3600 * 1000,
        'Der nächste Lauf liegt innerhalb einer Woche');

      await t.wait(400);
      t.atLeast(await t.count('.sched-row'), 1, 'Die Liste zeigt den Eintrag');

      await t.js(`
        return window.hub.schedule.list()
          .then((r) => Promise.all(r.data.entries.map((e) => window.hub.schedule.remove(e.id))))
          .then(() => true);
      `);
      await t.wait(300);
      t.eq((await t.evalExpr(`window.hub.schedule.list().then((r) => r.data.entries.length)`)), 0,
        'Einträge lassen sich wieder entfernen');

      await t.js(`
        for (const node of document.querySelectorAll('.modal-backdrop')) node.remove();
        return true;
      `);
    }
  },

  {
    name: 'System: Ringe, Diagramme, Kernraster, laufende Werte',
    async run(t) {
      await t.view('system');
      t.assert(await t.exists('.dash-grid'), 'Dashboard-Raster wird gebaut');
      t.atLeast(await t.count('.ring-row .ring'), 2, 'Mindestens CPU- und RAM-Ring');
      t.atLeast(await t.count('canvas.graph-canvas'), 2, 'Verlaufsdiagramme sind vorhanden');
      t.atLeast(await t.count('.core-grid .core'), 1, 'Kernraster ist gefüllt');

      // Panels in one row must not stretch to the tallest one.
      const stretched = await t.evalExpr(`(() => {
        const panels = [...document.querySelectorAll('.dash-grid > .panel')];
        return panels.length > 1 && panels.every((p) => p.getBoundingClientRect().height === panels[0].getBoundingClientRect().height);
      })()`);
      t.eq(stretched, false, 'Panels behalten ihre eigene Höhe');

      t.atLeast(await t.count('.core-val'), 1, 'Kernauslastung wird gerendert');

      // The whole point of the view is that it keeps updating. Asserting that
      // the rendered text differs would fail on a machine whose cores really
      // are pinned at 100 % for three seconds, so count the samples instead.
      const samples = await t.evalExpr(`new Promise((resolve) => {
        let count = 0;
        const stop = window.hub.metrics.onSample(() => { count += 1; });
        setTimeout(() => { stop(); resolve(count); }, 3200);
      })`);
      t.atLeast(samples, 2, 'Der Messstrom liefert weiter Werte', `nur ${samples} Messungen in 3,2 s`);

      // A graph that only paints at the right edge was a real bug once.
      const painted = await t.evalExpr(`(() => {
        const c = document.querySelector('canvas.graph-canvas');
        if (!c || !c.width) return 'kein Canvas';
        const ctx = c.getContext('2d');
        const left = ctx.getImageData(2, 0, 1, c.height).data;
        for (let i = 3; i < left.length; i += 4) if (left[i] > 0) return true;
        return 'linke Kante leer';
      })()`);
      t.eq(painted, true, 'Diagramm zeichnet über die volle Breite', String(painted));
    }
  },

  {
    name: 'Tasks: Prozesstabelle, Sortierung, Netzwerk, Autostart',
    async run(t) {
      await t.view('processes');
      t.eq(await t.count('#view-processes .tab-bar .tab'), 3, 'Drei Reiter: Prozesse, Netzwerk, Autostart');
      // Generous on purpose. There is one PowerShell pipe, and on the two-core
      // runner a slow query ahead of this one times out, takes the host down
      // with it and makes the process list wait for a cold start as well. Sixty
      // seconds covered the query but not that chain.
      await t.waitFor(`document.querySelectorAll('#view-processes tbody tr').length > 0`,
        { label: 'Prozesszeilen', timeout: 150000 });
      t.atLeast(await t.count('#view-processes tbody tr'), 3, 'Prozesse werden aufgelistet');
      t.atLeast(await t.count('.proc-action'), 1, 'Beenden-Knopf pro Zeile');
      t.assert(((await t.text('.proc-summary')) || '').length > 0, 'Zusammenfassung unter der Tabelle');

      // Sorting by name must produce a sorted list. Asserting that the order
      // *changed* is wrong: on an idle machine every process sits at 0 % CPU,
      // and the default sort can already happen to be alphabetical.
      await t.clickText('#view-processes thead th', 'Prozess');
      await t.wait(500);
      const names = await t.evalExpr(
        `[...document.querySelectorAll('#view-processes tbody .proc-name')].slice(0, 12).map((n) => n.firstChild.textContent)`
      );
      const sorted = names.slice().sort((a, b) => a.localeCompare(b));
      t.assert(JSON.stringify(names) === JSON.stringify(sorted), 'Nach dem Klick ist die Liste alphabetisch',
        JSON.stringify(names));
      t.eq(await t.evalExpr(
        `[...document.querySelectorAll('#view-processes thead th')].some((n) => n.dataset.sorted)`
      ), true, 'Die sortierte Spalte ist als solche markiert');

      // The filter is the fastest way to find a process and must narrow the list.
      const total = await t.count('#view-processes tbody tr');
      await t.js(`
        const input = document.querySelector('#view-processes .input');
        input.value = 'zzz-gibt-es-nicht';
        input.dispatchEvent(new Event('input'));
      `);
      await t.wait(400);
      t.eq(await t.count('#view-processes tbody tr'), 0, 'Suche ohne Treffer leert die Tabelle');
      await t.js(`
        const input = document.querySelector('#view-processes .input');
        input.value = '';
        input.dispatchEvent(new Event('input'));
      `);
      await t.wait(400);
      t.eq(await t.count('#view-processes tbody tr'), total, 'Leere Suche zeigt wieder alles');

      // The priority column is a button per row rather than a dropdown per row;
      // off Windows there is nothing to set, so it stays plain text.
      const priority = await t.evalExpr(`window.hub.processes.priorityOptions().then((r) => r.data)`);
      t.assert(priority && Array.isArray(priority.options) && priority.options.length >= 4,
        'Die wählbaren Prioritätsstufen kommen aus dem Hauptprozess', JSON.stringify(priority));
      t.assert(!priority.options.some((o) => o.value === 'realtime'),
        'Echtzeit wird nicht zum Setzen angeboten');
      t.eq(await t.evalExpr(
        `[...document.querySelectorAll('#view-processes thead th')].some((n) => n.textContent === 'Priorität')`
      ), true, 'Die Tabelle hat eine Prioritätsspalte');

      await t.clickText('#view-processes .tab-bar .tab', 'Netzwerk');
      await t.waitFor(`document.querySelectorAll('.net-panel .table').length >= 2`,
        { label: 'Netzwerkpanel', timeout: 40000 });
      t.atLeast(await t.count('.net-panel .table'), 2, 'Programme und Verbindungen als eigene Tabellen');
      t.assert(await t.exists('.net-adapters'), 'Adapterliste wird gebaut');
      t.assert(((await t.text('.net-panel .proc-toolbar .label')) || '').length > 0,
        'Die Statuszeile sagt, was zu sehen ist');

      await t.clickText('#view-processes .tab-bar .tab', 'Autostart');
      await t.wait(900);
      t.assert(await t.exists('#view-processes .tab-body'), 'Autostart-Reiter rendert einen Inhalt');
      t.eq(await t.exists('.net-panel'), false, 'Der Netzwerkreiter wird beim Wechsel abgebaut');
    }
  },

  {
    name: 'Dateien: Seitenleiste, Navigation, Brotkrumen',
    async run(t) {
      await t.view('files');
      t.atLeast(await t.count('.fm-sidebar .fm-side-btn'), 1, 'Seitenleiste hat Ziele');
      await t.waitFor(`document.querySelectorAll('#view-files tbody tr').length > 0`,
        { label: 'Dateiliste', timeout: 60000 });
      const startCrumbs = await t.count('.fm-crumbs .crumb');
      t.atLeast(startCrumbs, 1, 'Pfad wird als Brotkrumen gezeigt');

      // Double-clicking a folder is the core interaction of a file manager.
      const entered = await t.js(`
        const row = [...document.querySelectorAll('#view-files tbody tr')]
          .find((r) => (r.children[2] || {}).textContent === 'Ordner');
        if (!row) return false;
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return true;
      `);
      if (entered) {
        // Reading a directory is a filesystem round trip; on a slow machine a
        // fixed wait is a coin toss.
        await t.waitFor(`document.querySelectorAll('.fm-crumbs .crumb').length > ${startCrumbs}`,
          { label: 'längerer Pfad', timeout: 20000 }).catch(() => {});
        t.atLeast(await t.count('.fm-crumbs .crumb'), startCrumbs + 1, 'Ordner öffnen verlängert den Pfad');
      } else {
        t.assert(true, 'Kein Unterordner zum Öffnen vorhanden, Navigation übersprungen');
      }
      t.assert(((await t.text('.fm-status')) || '').length > 0, 'Statuszeile meldet den Inhalt');
    }
  },

  {
    name: 'Overlays: Liste, echtes Fenster öffnen und schließen',
    async run(t) {
      await t.view('overlays');
      t.atLeast(await t.count('.overlay-grid > *'), 3, 'Alle Overlay-Typen werden angeboten');
      t.atLeast(await t.count('.overlay-grid .toggle'), 3, 'Jedes Overlay hat einen Schalter');

      const before = t.windows().length;
      await t.click('.overlay-grid .toggle');

      const overlayWindow = await t.waitForWindow('overlay.html');
      t.assert(!!overlayWindow, 'Ein Overlay-Fenster wird tatsächlich geöffnet', `Fenster vorher ${before}`);
      if (overlayWindow) {
        t.watchConsole(overlayWindow.webContents, 'overlay');
        // The overlay must show live values, not an empty frame — and the
        // first value arrives with the next sample, not on load.
        const body = await t.waitIn(overlayWindow,
          `(function () { var t = document.body.textContent; return /\\d/.test(t) ? t : false; })()`,
          { label: 'Werte im Overlay' }).catch(() => '');
        t.assert(/\d/.test(body || ''), 'Overlay zeigt Zahlen an', JSON.stringify(String(body).slice(0, 80)));
      }

      await t.clickText('#view-overlays .btn', 'Alle schließen');
      t.eq(await t.waitForNoWindow('overlay.html'), true, 'Alle schließen entfernt die Fenster');
      // The switches are repainted after the call returns, not with the click.
      await t.waitFor(
        `[...document.querySelectorAll('.overlay-grid .toggle')].every((n) => n.getAttribute('aria-checked') !== 'true')`,
        { label: 'zurückgesetzte Schalter' }
      ).catch(() => {});
      t.eq(await t.evalExpr(
        `[...document.querySelectorAll('.overlay-grid .toggle')].some((n) => n.getAttribute('aria-checked') === 'true')`
      ), false, 'Alle schließen setzt auch die Schalter zurück');
    }
  },

  {
    name: 'Windows: Bildschirme und Funktionen',
    async run(t) {
      await t.view('windows');
      t.eq(await t.count('#view-windows .tab-bar .tab'), 2, 'Zwei Reiter');
      await t.waitFor(`document.querySelectorAll('#view-windows .tab-body > *').length > 0`,
        { label: 'Bildschirm-Panel', timeout: 40000 });
      t.assert(await t.exists('#view-windows .tab-body'), 'Bildschirm-Panel rendert');

      // Reading the monitors goes through a compiled helper. On a cold, slow
      // machine that compile is the single longest operation in the app, so
      // this waits rather than assuming.
      const displays = await t.evalExpr(
        `window.hub.display.list().then((r) => ({ ok: r.ok, supported: r.ok && r.data.supported, note: r.ok ? r.data.note : r.error }))`
      );
      t.assert(displays.ok, 'Die Bildschirmabfrage antwortet', JSON.stringify(displays));

      await t.clickText('#view-windows .tab-bar .tab', 'Funktionen');
      // The grid element exists before the catalogue is read, so waiting for it
      // would prove nothing. The filter tabs are built from the loaded data.
      await t.waitFor(`document.querySelectorAll('#view-windows .filter-tabs .filter-tab').length > 0`,
        { label: 'Funktionsliste', timeout: 120000 });
      t.atLeast(await t.count('#view-windows .filter-tabs .filter-tab'), 2, 'Filter für die Funktionsliste');

      const supported = await t.evalExpr(`window.hub.features.list().then((r) => r.ok && r.data.supported)`);
      if (supported) {
        t.atLeast(await t.count('.feature-grid > *'), 10, 'Der Katalog listet die Windows-Funktionen');
        t.atLeast(await t.count('.feature-grid .toggle, .feature-grid .select'),
          1, 'Schaltbare Einträge haben ein Bedienelement');
      } else {
        // Expected on the CI runner: the catalogue is Windows-only.
        t.assert(await t.exists('#view-windows .empty-title'),
          'Ohne Windows erscheint ein Hinweis statt einer leeren Fläche');
        t.atLeast(await t.evalExpr(`window.hub.features.list().then((r) => r.data.items.length)`), 30,
          'Der Katalog selbst ist trotzdem vollständig');
      }
    }
  },

  {
    name: 'Zweiter Bildschirm: Fenster, Inhalt, Schalter',
    async run(t) {
      const status = await t.evalExpr(`window.hub.dashboard.status().then((r) => r.data)`);
      t.assert(Array.isArray(status.displays) && status.displays.length >= 1,
        'Die Bildschirme werden aufgezählt', JSON.stringify(status.displays));
      t.eq(status.open, false, 'Ohne Zutun ist das Dashboard zu');

      // On a single-screen machine the board would open on top of the hub,
      // which is not a feature — the button says so by staying away.
      t.eq(await t.evalExpr(`document.querySelector('#btn-dashboard').classList.contains('hidden')`),
        status.onlyOneDisplay, 'Der Knopf erscheint nur mit zweitem Bildschirm');

      const before = t.windows().length;
      await t.evalExpr(`window.hub.dashboard.open()`);
      const board = await t.waitForWindow('dashboard.html');
      t.assert(!!board, 'Das Dashboard-Fenster geht auf', `Fenster vorher ${before}`);
      if (!board) return;

      t.watchConsole(board.webContents, 'dashboard');
      await t.waitIn(board, `document.querySelectorAll('.dash-panel').length >= 5`,
        { label: 'Dashboard-Inhalt' });
      // The profile rows appear as soon as the profile list is read, without
      // waiting for the far slower "what is running" query.
      await t.waitIn(board, `document.querySelectorAll('.dash-profile').length >= 1`,
        { label: 'Profile auf dem Dashboard', timeout: 30000 });

      const content = await board.webContents.executeJavaScript(`(() => ({
        panels: document.querySelectorAll('.dash-panel').length,
        rings: document.querySelectorAll('.dash-rings .ring').length,
        clock: (document.querySelector('.dash-clock-time') || {}).textContent || '',
        canvases: document.querySelectorAll('.dash-graph canvas').length,
        profiles: document.querySelectorAll('.dash-profile').length
      }))()`, true);

      t.atLeast(content.panels, 5, 'Alle Bereiche werden gebaut', JSON.stringify(content));
      t.eq(content.rings, 3, 'CPU, RAM und GPU als Ringe');
      t.assert(/^\d{2}:\d{2}$/.test(content.clock.trim()), 'Die Uhr läuft', content.clock);
      t.atLeast(content.canvases, 2, 'Verläufe für CPU und Netzwerk');
      t.atLeast(content.profiles, 1, 'Das gesäte Profil erscheint auf dem zweiten Schirm');

      // It must keep receiving values even though it never has focus.
      //
      // Waits for the second sample rather than counting how many arrive in a
      // fixed window. The window version asked for two in 3.2 seconds, which
      // is a coin flip on a two-core runner that is already busy -- and this
      // project's rule is to wait for the event, not the clock. The deadline
      // is only there so a genuinely dead stream still fails.
      const samples = await board.webContents.executeJavaScript(`new Promise((resolve) => {
        let count = 0;
        const stop = window.hub.metrics.onSample(() => {
          count += 1;
          if (count >= 2) { stop(); resolve(count); }
        });
        setTimeout(() => { stop(); resolve(count); }, 30000);
      })`, true);
      t.atLeast(samples, 2, 'Der Messstrom erreicht auch das zweite Fenster', `nur ${samples} Messungen`);

      await t.evalExpr(`window.hub.dashboard.close()`);
      t.eq(await t.waitForNoWindow('dashboard.html'), true, 'Und lässt sich wieder schließen');
    }
  },

  {
    name: 'Updates: Abschnitte, Grenzen, Protokoll',
    async run(t) {
      await t.view('updates');

      // The four sections are drawn before anything is asked. The timeout is
      // deliberately short: winget took ninety seconds on the CI runner once,
      // and the whole view waited for it. Each source fills in its own section
      // when it answers, so none of them may gate the frame.
      await t.waitFor(`document.querySelectorAll('#view-updates .upd-section').length >= 5`,
        { label: 'Update-Abschnitte', timeout: 15000 });

      // Checked before anything has had time to answer: an action that does
      // not depend on the list must not disappear while the list loads. On the
      // Windows runner these two buttons were missing for a minute, because
      // the loading placeholder had dropped them.
      const earlyButtons = await t.evalExpr(
        `[...document.querySelectorAll('#view-updates button')].map((n) => n.textContent).join(' | ')`
      );
      t.assert(earlyButtons.includes('Steam-Updates starten'),
        'Steam-Updates lassen sich anstoßen, bevor die Bibliothek gelesen ist', earlyButtons);
      t.assert(earlyButtons.includes('Launcher prüfen lassen'),
        'Der Epic-Launcher lässt sich prüfen lassen, bevor die Bibliothek gelesen ist', earlyButtons);

      const titles = await t.evalExpr(
        `[...document.querySelectorAll('.upd-section-title')].map((n) => n.textContent)`
      );
      t.assert(titles.includes('Windows Hub'), 'Abschnitt für den Hub selbst', JSON.stringify(titles));
      t.assert(titles.includes('Programme'), 'Abschnitt für winget-Programme', JSON.stringify(titles));
      t.assert(titles.includes('Steam-Spiele'), 'Abschnitt für Steam');
      t.assert(titles.includes('Epic Games'), 'Abschnitt für Epic');
      t.assert(titles.includes('System'), 'Abschnitt für Windows und Store');

      // Each section says what it can do rather than offering a button that
      // quietly does nothing.
      const body = (await t.text('#view-updates')) || '';
      t.assert(body.includes('Ein Knopf, der so tut'),
        'Bei Windows Update steht, warum nur verlinkt wird');

      // The triggers reach the main process and are checked there, not here.
      await assertRejects(t, `window.hub.updates.steamGame('abc', 'validate')`, 'Kennung',
        'Eine unsinnige Spiel-Kennung wird abgewiesen');
      await assertRejects(t, `window.hub.updates.steamGame('553850', 'quatsch')`, 'Modus',
        'Ein unbekannter Modus wird abgewiesen');
      await assertRejects(t, `window.hub.updates.epicGame('https://example.com')`, 'Epic-Adresse',
        'Eine fremde Adresse wird abgewiesen');

      // The games come from local manifests and must not wait behind winget.
      const games = await t.evalExpr(`window.hub.updates.scanGames().then((r) => r.data)`);
      t.assert(games && games.steam && games.epic, 'Spiele werden getrennt von winget abgefragt',
        JSON.stringify(games));

      // Deliberately not a second `scanWinget()` call. The view already made
      // one on mount, and on a machine with cold sources that query takes a
      // minute and a half; asking again bought nothing and cost the suite
      // three minutes. What is waited for here is the section leaving its
      // pending state -- whatever it then says, it has to say something.
      // Found by its heading rather than by position. It used to be the first
      // section; adding one above it silently moved the test to a different
      // section, which still had text and so still passed the loose checks.
      const WINGET_SECTION = `[...document.querySelectorAll('#view-updates .upd-section')]`
        + `.find((n) => n.querySelector('.upd-section-title').textContent === 'Programme')`;
      await t.waitFor(`!/wird abgefragt/.test(${WINGET_SECTION}.textContent)`,
        { label: 'winget-Abschnitt', timeout: 150000 });
      const wingetText = await t.evalExpr(`${WINGET_SECTION}.textContent`);
      t.assert(/Alles aktuell|Aktualisieren|winget steht nicht zur Verfügung/.test(wingetText),
        'Der Programmabschnitt sagt, was Sache ist', wingetText.slice(0, 200));

      // Nothing is running, so the log pane stays out of the way.
      t.eq(await t.evalExpr(`document.querySelector('.upd-log-pane').classList.contains('hidden')`), true,
        'Das Protokoll erscheint erst, wenn etwas läuft');

      // Off Windows the hub cannot update itself, and the section has to say
      // so rather than leave an empty space where a button would be.
      const selfState = await t.evalExpr(`window.hub.selfupdate.state().then((r) => r.data)`);
      t.assert(typeof selfState.supported === 'boolean', 'Der Hub weiß, ob er sich selbst ersetzen kann');
      t.assert(selfState.supported || String(selfState.reason || '').length > 20,
        'Kann er es nicht, steht der Grund dabei', JSON.stringify(selfState.reason));
      t.assert(String(await t.text('#view-updates') || '').includes('Windows Hub'),
        'Der Hub taucht im Update-Center auf');

      // Deliberately NOT `run(null)`: on Windows that is not an error, it is
      // `winget upgrade --all`, and a test that installed software on the CI
      // runner is how this was discovered. The id check is the part that can
      // be exercised without starting anything.
      await assertRejects(t, `window.hub.updates.run('nicht; erlaubt')`, 'Paket-Kennung',
        'Eine unsinnige Paket-Kennung wird abgewiesen');
      await assertRejects(t, `window.hub.updates.run('../../evil')`, 'Paket-Kennung',
        'Und eine, die wie ein Pfad aussieht, auch');
      t.eq(await t.evalExpr(`window.hub.updates.state().then((r) => r.data.running)`), false,
        'Nach den abgewiesenen Aufrufen läuft nichts');
    }
  },

  {
    name: 'Profil-Auslöser: Schalter, Herleitung, Grenzen',
    async run(t) {
      await t.view('hub');
      await t.click('.profile-card:not(.add-card) .card-actions .icon-btn:last-child');
      await t.waitFor(`!!document.querySelector('.modal')`, { label: 'Editor' });
      await t.clickText('.modal .tab', 'System');
      await t.waitFor(`/Von selbst reagieren/.test(document.querySelector('.modal').textContent)`,
        { label: 'Auslöser-Abschnitt' });

      // Off by default. A profile that starts changing the power plan because
      // a process appeared, without anyone asking for it, would be a surprise.
      const before = await t.text('.modal');
      t.assert(!/Worauf geachtet wird/.test(before),
        'Ohne Schalter bleibt der Auslöser-Teil eingeklappt');

      await t.evalExpr(`(() => {
        const rows = [...document.querySelectorAll('.modal .setting-row')];
        const row = rows.find((r) => r.textContent.includes('Auf startende Programme achten'));
        row.querySelector('.toggle').click();
        return true;
      })()`);
      await t.waitFor(`/Worauf geachtet wird/.test(document.querySelector('.modal').textContent)`,
        { label: 'ausgeklappter Auslöser' });

      const after = (await t.text('.modal')) || '';
      t.assert(/Nur Systemzustand|Ganzes Profil/.test(after), 'Die Wirkung lässt sich wählen');

      // The audio picker states its own caveat rather than implying the
      // switch is a supported Windows feature.
      t.assert(/Wiedergabegerät/.test(after), 'Das Wiedergabegerät lässt sich wählen');
      await assertRejects(t, `window.hub.audio.setDefault('Lautsprecher')`, 'Gerätekennung',
        'Eine unsinnige Gerätekennung wird abgewiesen');
      t.assert(/Leer heißt|Sobald einer dieser Prozesse/.test(after),
        'Es steht dabei, worauf geachtet wird');

      await t.clickText('.modal .btn', 'Abbrechen');
      await t.waitFor(`!document.querySelector('.modal')`, { label: 'geschlossener Editor' });

      // The watcher only polls while a profile wants it, and the listing says
      // per profile whether it could ever fire.
      const rows = await t.evalExpr(`window.hub.triggers.list().then((r) => r.data)`);
      t.assert(Array.isArray(rows), 'Die Auslöser lassen sich auflisten');
      for (const row of rows) {
        t.assert(typeof row.usable === 'boolean', 'Jeder Eintrag sagt, ob er greifen kann');
        t.assert(row.usable || !row.trigger.enabled || (row.reason || '').length > 20,
          'Kann er nicht greifen, steht der Grund dabei', JSON.stringify(row));
      }
    }
  },

  {
    name: 'Speicher: Laufwerke, Sortierung, Grenzen',
    async run(t) {
      await t.view('storage');

      // Off Windows there are no Steam manifests, so the empty state is what
      // gets rendered -- and it has to say which of the two it is.
      await t.waitFor(
        `!!document.querySelector('#view-storage .upd-row') || !!document.querySelector('#view-storage .empty-title')`,
        { label: 'Speicherliste', timeout: 60000 });

      t.assert(await t.exists('#view-storage .view-head'), 'Die Ansicht hat einen Kopf');
      t.atLeast(await t.count('#view-storage select option'), 4, 'Mehrere Sortierungen');

      const body = (await t.text('#view-storage')) || '';
      t.assert(/Spiele|Wird gelesen|Keine Spiele|Laufwerke/.test(body),
        'Die Ansicht sagt, was sie gefunden hat', body.slice(0, 160));

      // The order is a pure function of the list, so switching it must not
      // throw even when the list is empty.
      await t.evalExpr(`(() => {
        const sel = document.querySelector('#view-storage select');
        sel.value = 'age';
        sel.dispatchEvent(new Event('change'));
        return true;
      })()`);
      t.assert(await t.exists('#view-storage'), 'Sortierung umschalten überlebt den Leerzustand');

      // Checked in the main process, and checked before the platform is, so
      // this assertion means the same thing on every machine.
      await assertRejects(t, `window.hub.storage.uninstall('nicht-numerisch')`, 'Kennung',
        'Eine unsinnige Spiel-Kennung wird abgewiesen');
      await assertRejects(t, `window.hub.storage.measure('relativ/pfad')`, 'Ordner',
        'Ein relativer Pfad wird abgewiesen');

      const overview = await t.evalExpr(`window.hub.storage.overview().then((r) => r.data)`);
      t.assert(overview && Array.isArray(overview.games), 'Die Abfrage liefert eine Spieleliste');
      t.assert(overview.totals && typeof overview.totals.bytes === 'number',
        'Und eine Summe', JSON.stringify(overview.totals));
    }
  },

  {
    name: 'Bibliothek: Suche und Leerzustand',
    async run(t) {
      await t.view('library');
      await t.waitFor(`!!document.querySelector('.lib-grid') || !!document.querySelector('#view-library .empty')`,
        { label: 'Bibliothek', timeout: 40000 });
      t.assert(await t.exists('.lib-grid') || await t.exists('#view-library .empty'),
        'Bibliothek rendert Raster oder Leerzustand');
      t.assert(await t.exists('#view-library .input'), 'Suchfeld vorhanden');
      t.atLeast(await t.count('#view-library .filter-tabs .filter-tab'), 2, 'Quellen lassen sich filtern');
    }
  },

  {
    name: 'Einstellungen: Panels, Schalter, Tastenkürzel, Diagnose',
    async run(t) {
      await t.view('settings');
      t.atLeast(await t.count('.settings-cols .panel'), 5, 'Alle Einstellungsgruppen sind da');
      t.assert(await t.evalExpr(
        `[...document.querySelectorAll('.panel-title')].some((n) => n.textContent === 'Bildschirme')`
      ), 'Die Bildschirmwahl hat einen eigenen Bereich');
      t.assert(await t.evalExpr(`(() => {
        const row = [...document.querySelectorAll('.setting-row')].find((r) => r.textContent.includes('Hub auf Bildschirm'));
        return !!(row && row.querySelector('select') && row.querySelector('select').options.length >= 1);
      })()`), 'Der Monitor für den Hub lässt sich wählen');
      t.atLeast(await t.count('.settings-cols .toggle'), 6, 'Schalter werden gerendert');
      t.atLeast(await t.count('.settings-cols .setting-row'), 8, 'Einstellungszeilen mit Beschriftung');
      t.assert(((await t.text('#view-settings .view-sub')) || '').includes('hub-config.json'),
        'Der Pfad zur Konfiguration steht in der Kopfzeile', await t.text('#view-settings .view-sub'));

      // A toggle has to survive the round trip through the main process.
      const changed = await t.js(`
        const row = [...document.querySelectorAll('.setting-row')]
          .find((r) => r.textContent.includes('Boot-Animation'));
        if (!row) return null;
        const box = row.querySelector('.toggle');
        const before = box.getAttribute('aria-checked') === 'true';
        box.click();
        return { before, after: box.getAttribute('aria-checked') === 'true' };
      `);
      t.assert(changed && changed.before !== changed.after, 'Ein Schalter lässt sich umlegen', JSON.stringify(changed));
      await t.wait(600);
      const persisted = await t.evalExpr(`window.hub.settings.get().then((r) => r.data.bootAnimation)`);
      t.eq(persisted, changed ? changed.after : null, 'Der neue Wert ist im Hauptprozess angekommen');

      // Put it back so a rerun starts from the same state.
      await t.js(`
        const row = [...document.querySelectorAll('.setting-row')].find((r) => r.textContent.includes('Boot-Animation'));
        row.querySelector('.toggle').click();
        return true;
      `);
      await t.wait(400);

      t.atLeast(await t.count('#view-settings .btn'), 4, 'Diagnose- und Konfigurationsknöpfe vorhanden');

      // A theme sets both accents and the effect switches in one go.
      t.atLeast(await t.count('.theme-card'), 4, 'Fertige Themen stehen zur Wahl');
      t.eq(await t.count('.theme-card.active'), 1, 'Genau eines ist als aktiv markiert');

      const before = await t.evalExpr(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
      await t.js(`
        const cards = [...document.querySelectorAll('.theme-card')];
        const other = cards.find((c) => !c.classList.contains('active'));
        other.click();
        return true;
      `);
      await t.wait(600);
      const after = await t.evalExpr(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
      t.assert(before !== after, 'Ein Klick auf ein Thema färbt die Oberfläche um', `${before} → ${after}`);
      t.eq(await t.count('.theme-card.active'), 1, 'Und die Markierung wandert mit');

      // The background leans on the live load rather than animating on its own.
      const loadVar = await t.evalExpr(`getComputedStyle(document.documentElement).getPropertyValue('--load').trim()`);
      t.assert(loadVar !== '' && Number(loadVar) >= 0 && Number(loadVar) <= 1,
        'Die Hintergrundeffekte bekommen die aktuelle Auslastung', JSON.stringify(loadVar));
    }
  },

  {
    name: 'Erststart: Assistent erscheint nicht ungefragt, lässt sich aber holen',
    async run(t) {
      // The seeded configuration already has a profile, which is exactly the
      // case that must NOT be greeted with a wizard: someone upgrading from a
      // version without the flag has a full grid and no interest in one.
      t.eq(await t.evalExpr(`!!document.querySelector('.modal')`), false,
        'Bei vorhandenen Profilen erscheint der Assistent nicht von selbst');

      await t.view('settings');
      await t.waitFor(`/Erste Schritte/.test(document.querySelector('#view-settings').textContent)`,
        { label: 'Erste-Schritte-Panel', timeout: 20000 });

      await t.clickText('#view-settings .btn', 'Assistent öffnen');
      await t.waitFor(`!!document.querySelector('.modal')`, { label: 'Assistent' });

      const text = (await t.text('.modal')) || '';
      t.assert(/Ein Profil startet mehrere Programme/.test(text),
        'Der Assistent erklärt, was ein Profil ist', text.slice(0, 120));
      t.assert(/Überspringen/.test(text), 'Er lässt sich überspringen');

      // Off Windows the scan finds nothing, and saying so is the point: an
      // empty grid without explanation looks like a broken dialog.
      await t.waitFor(
        `/Es wurde nichts gefunden|Programme werden gesucht|wird angelegt|Ohne Auswahl/.test(document.querySelector('.modal').textContent)`,
        { label: 'Ergebnis der Suche', timeout: 60000 });

      await t.clickText('.modal .btn', 'Überspringen');
      await t.waitFor(`!document.querySelector('.modal')`, { label: 'geschlossener Assistent' });

      // Dismissing counts: someone who closed it meant it.
      const settings = await t.evalExpr(`window.hub.settings.get().then((r) => r.data.welcomeSeen)`);
      t.eq(settings, true, 'Überspringen wird gemerkt');
    }
  },

  {
    name: 'Discord: Sprungmarken und die Grenze',
    async run(t) {
      await t.view('settings');
      // Short on purpose: the panel's contents are a constant and the stored
      // shortcuts, so there is nothing legitimate to wait for. It used to take
      // half a minute because it asked whether the client was running first.
      await t.waitFor(`/Selfbot/.test(document.querySelector('#view-settings').textContent)`,
        { label: 'Discord-Panel', timeout: 15000 });

      // The panel names what cannot be built, rather than leaving someone to
      // wonder why there is no chat window.
      const body = (await t.text('#view-settings')) || '';
      t.assert(/Chat und Sprache/.test(body), 'Die Grenze steht in der Oberfläche');
      t.assert(/Sprungmarke|Link aus Discord/.test(body), 'Sprungmarken lassen sich anlegen');

      // Every id reaches a URI the shell executes, and every check sits in
      // front of the platform guard so it means the same thing here.
      await assertRejects(t, `window.hub.discord.save({ kind: 'server', guildId: 'nein' })`, 'Server-Kennung',
        'Eine unsinnige Server-Kennung wird abgewiesen');
      await assertRejects(t, `window.hub.discord.save({ kind: 'quatsch' })`, 'Discord-Art',
        'Eine unbekannte Art wird abgewiesen');
      await assertRejects(t, `window.hub.discord.open('gibt-es-nicht')`, 'gibt es nicht',
        'Eine unbekannte Verknüpfung wird abgewiesen');

      const parsed = await t.evalExpr(
        `window.hub.discord.parse('https://discord.com/channels/123456789012345678/987654321098765432').then((r) => r.data)`);
      t.assert(parsed && parsed.guildId === '123456789012345678', 'Ein kopierter Link wird verstanden',
        JSON.stringify(parsed));

      const nonsense = await t.evalExpr(
        `window.hub.discord.parse('https://example.com/channels/1/2').then((r) => r.data)`);
      t.eq(nonsense, null, 'Ein fremder Link liefert nichts statt einer falschen Adresse');
    }
  },

  {
    name: 'Sicherung: Panel, Prüfung, abgewiesene Eingaben',
    async run(t) {
      await t.view('settings');
      await t.waitFor(`/Sichern und übertragen/.test(document.querySelector('#view-settings').textContent)`,
        { label: 'Sicherungs-Panel', timeout: 30000 });

      const body = (await t.text('#view-settings')) || '';
      t.assert(/Einstellungen sichern/.test(body), 'Sichern lässt sich auslösen');
      t.assert(/Sicherung einlesen/.test(body), 'Einlesen lässt sich auslösen');
      // The panel names what it deliberately leaves behind, rather than
      // letting someone discover it on the other machine.
      t.assert(/Nicht mitgenommen/.test(body), 'Es steht dabei, was nicht mitgeht');

      // Checked in the main process. A folder of json files is the normal way
      // to pick the wrong one, and an import that half-reads it loses profiles.
      await assertRejects(t, `window.hub.backup.import('kein json', 'merge')`, 'JSON',
        'Etwas, das kein JSON ist, wird abgewiesen');
      await assertRejects(t, `window.hub.backup.import('{"some":"other file"}', 'merge')`, 'Windows Hub',
        'Fremdes JSON wird abgewiesen');
      await assertRejects(t,
        `window.hub.backup.import('{"format":"windows-hub-backup","formatVersion":1,"data":{}}', 'quatsch')`,
        'Modus', 'Ein unbekannter Modus wird abgewiesen');
    }
  },

  {
    name: 'Diagnosebericht wird erzeugt und ist bereinigt',
    async run(t) {
      const report = await t.evalExpr(`window.hub.diagnostics.build().then((r) => r.ok ? r.data.report : 'FEHLER: ' + r.error)`);
      t.assert(typeof report === 'string' && report.length > 200, 'Bericht hat Inhalt',
        String(report).slice(0, 120));
      t.assert(report.includes('Windows Hub'), 'Bericht nennt die Anwendung');
      t.assert(!report.includes('base64'), 'Keine eingebetteten Bilder im Bericht');
      // Profile paths appear as bare file names; the few paths that stay in
      // must have the user name replaced.
      const leak = report.match(/(?:[A-Za-z]:\\Users\\|\/home\/|\/Users\/)(?!<Benutzer>)[^\\/\s]+/);
      t.assert(!leak, 'Kein Benutzername in einem Pfad des Berichts', leak ? leak[0] : '');
      t.assert(!/[A-Za-z]:\\Users\\[^\\]+\\[^\\]*\.exe/i.test(report),
        'Keine vollständigen Programmpfade im Bericht');
    }
  },

  {
    name: 'Claude-Konsole öffnet ein eigenes Fenster',
    async run(t) {
      // Start from a known view so the "the hub stays put" check below does
      // not depend on which test ran before this one.
      await t.view('hub');
      const before = t.windows().length;
      await t.click('.rail-btn[data-view="claude"]');

      const consoleWindow = await t.waitForWindow('claude.html');
      t.assert(!!consoleWindow, 'Konsolenfenster wurde geöffnet', `Fenster vorher ${before}`);
      if (!consoleWindow) return;
      await t.waitIn(consoleWindow, `document.querySelectorAll('.cc-setup select').length >= 2`,
        { label: 'Konsolen-Bedienelemente' });

      t.watchConsole(consoleWindow.webContents, 'claude');
      const cjs = (code) => consoleWindow.webContents.executeJavaScript(`(${code})`, true);

      t.atLeast(await cjs(`document.querySelectorAll('.cc-setup select').length`), 2,
        'Modell- und Modusauswahl vorhanden');
      const modes = await cjs(`[...document.querySelectorAll('.cc-setup select')[1].options].map((o) => o.value)`);
      t.assert(Array.isArray(modes) && modes.includes('plan') && modes.includes('bypassPermissions'),
        'Alle Berechtigungsstufen stehen zur Wahl', JSON.stringify(modes));

      // The dangerous mode has to look dangerous before anyone picks it.
      await cjs(`(() => {
        const s = document.querySelectorAll('.cc-setup select')[1];
        s.value = 'bypassPermissions';
        s.dispatchEvent(new Event('change'));
        return true;
      })()`);
      await t.wait(400);
      t.eq(await cjs(`document.querySelector('.cc-mode-note').classList.contains('danger')`), true,
        'Der Modus „Alles erlauben" ist als Risiko markiert');

      // Resuming has to be reachable, and has to say so when there is nothing
      // to resume rather than offering an empty dropdown.
      const resume = await cjs(`(() => {
        const selects = [...document.querySelectorAll('.cc-setup select')];
        const node = selects[selects.length - 1];
        return { options: node.options.length, first: node.options[0].value, disabled: node.disabled };
      })()`);
      t.eq(resume.options, 1, 'Ohne frühere Sitzungen steht nur „Neue Sitzung" zur Wahl');
      t.eq(resume.first, '', 'Die leere Auswahl bedeutet eine neue Sitzung');
      t.eq(resume.disabled, true, 'Ohne Auswahl ist die Liste nicht bedienbar');

      // The rail entry is an action, not a destination: the hub stays put.
      t.eq(await t.evalExpr(`document.querySelector('.rail-btn.active').dataset.view`), 'hub',
        'Der Hub wechselt die Ansicht nicht, wenn die Konsole aufgeht');

      consoleWindow.close();
      await t.wait(600);
    }
  },

  {
    name: 'Gamepad: Richtungswahl und Einstellungszeile',
    async run(t) {
      await t.view('settings');
      const row = await t.evalExpr(`(() => {
        const node = [...document.querySelectorAll('.setting-row')].find((r) => r.textContent.includes('Gamepad'));
        return node ? { toggle: !!node.querySelector('.toggle'), hint: node.textContent.includes('LB und RB') } : null;
      })()`);
      t.assert(row && row.toggle, 'Die Gamepad-Steuerung lässt sich abschalten', JSON.stringify(row));
      t.assert(row && row.hint, 'Die Belegung steht neben dem Schalter');
      t.assert(await t.evalExpr(
        `[...document.querySelectorAll('.setting-hint')].some((n) => n.textContent.includes('Kein Controller erkannt'))`
      ), 'Ohne Controller steht dort, warum nichts passiert');

      // The direction picker is the only real algorithm in the module, and it
      // is the part that decides whether pressing right in a grid feels right.
      const picks = await t.evalExpr(`(async () => {
        const mod = await import('hub://app/js/gamepad.js');
        const pick = mod._internals.pickInDirection;
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:600px;z-index:-1';
        document.body.appendChild(host);
        const at = (x, y, name) => {
          const n = document.createElement('div');
          n.dataset.name = name;
          n.style.cssText = 'position:absolute;width:60px;height:40px;left:' + x + 'px;top:' + y + 'px';
          host.appendChild(n);
          return n;
        };
        const mid   = at(250, 250, 'mid');
        const up    = at(250, 150, 'up');
        const down  = at(250, 350, 'down');
        const left  = at(100, 250, 'left');
        const right = at(400, 250, 'right');
        // Closer in raw distance than "down", but far off the axis.
        const skew  = at(430, 330, 'skew');
        const all = [mid, up, down, left, right, skew];
        const name = (n) => (n ? n.dataset.name : null);
        const out = {
          up: name(pick(mid, 'up', all)),
          down: name(pick(mid, 'down', all)),
          left: name(pick(mid, 'left', all)),
          right: name(pick(mid, 'right', all)),
          fromLeftGoingRight: name(pick(left, 'right', all)),
          nothingAbove: name(pick(up, 'up', all))
        };
        host.remove();
        return out;
      })()`);

      t.eq(picks.up, 'up', 'Nach oben wird der obere Nachbar gewählt');
      t.eq(picks.down, 'down', 'Nach unten gewinnt der ausgerichtete vor dem schrägen Kandidaten');
      t.eq(picks.left, 'left', 'Nach links wird der linke Nachbar gewählt');
      t.eq(picks.right, 'right', 'Nach rechts wird der rechte Nachbar gewählt');
      t.eq(picks.fromLeftGoingRight, 'mid', 'Von links nach rechts kommt zuerst die Mitte');
      t.eq(picks.nothingAbove, null, 'Über dem obersten Element liegt nichts');
    }
  },

  {
    name: 'Jede Ansicht überlebt zweimaliges Betreten',
    async run(t) {
      // Views that stay mounted tear down their listeners on unmount; the
      // file manager once lost its keyboard shortcuts on the second visit.
      const order = ['hub', 'system', 'processes', 'files', 'overlays', 'windows', 'library', 'settings'];
      for (const pass of [1, 2]) {
        for (const id of order) {
          await t.view(id);
          const rendered = await t.evalExpr(`(() => {
            const node = document.querySelector('#main > .view');
            return node ? { id: node.id, children: node.children.length } : null;
          })()`);
          t.assert(rendered && rendered.id === `view-${id}` && rendered.children >= 2,
            `${id} rendert im Durchgang ${pass}`, JSON.stringify(rendered));
        }
      }
      // The file manager's shortcuts live on the document and must still fire.
      await t.view('files');
      const bound = await t.evalExpr(`!!document.querySelector('#view-files .fm-toolbar')`);
      t.eq(bound, true, 'Dateimanager ist nach dem zweiten Betreten vollständig');
    }
  },

  {
    name: 'Tastenkürzel der Ansichten',
    async run(t) {
      await t.view('hub');
      await t.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', altKey: true, bubbles: true }));`);
      await t.wait(500);
      t.eq(await t.evalExpr(`document.querySelector('.rail-btn.active').dataset.view`), 'system',
        'Alt+2 springt zur Systemansicht');
      await t.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', altKey: true, bubbles: true }));`);
      await t.wait(500);
      t.eq(await t.evalExpr(`document.querySelector('.rail-btn.active').dataset.view`), 'hub',
        'Alt+1 kehrt zum Hub zurück');
    }
  }
];
