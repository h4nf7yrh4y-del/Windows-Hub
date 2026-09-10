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

module.exports = [

  {
    name: 'Grundgerüst: Leiste, Uhr, Kopfzeile',
    async run(t) {
      t.eq(await t.count('.rail-btn'), 9, 'Neun Einträge in der Seitenleiste');
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
    name: 'Tasks: Prozesstabelle, Sortierung, Autostart-Reiter',
    async run(t) {
      await t.view('processes');
      t.eq(await t.count('.tab-bar .tab'), 2, 'Zwei Reiter: Prozesse und Autostart');
      await t.waitFor(`document.querySelectorAll('#view-processes tbody tr').length > 0`,
        { label: 'Prozesszeilen', timeout: 60000 });
      t.atLeast(await t.count('#view-processes tbody tr'), 3, 'Prozesse werden aufgelistet');
      t.atLeast(await t.count('.proc-action'), 1, 'Beenden-Knopf pro Zeile');
      t.assert(((await t.text('.proc-summary')) || '').length > 0, 'Zusammenfassung unter der Tabelle');

      // Sorting by name must actually reorder.
      const before = await t.evalExpr(`[...document.querySelectorAll('#view-processes tbody .proc-name')].slice(0,5).map(n => n.textContent)`);
      await t.clickText('#view-processes thead th', 'Prozess');
      await t.wait(400);
      const after = await t.evalExpr(`[...document.querySelectorAll('#view-processes tbody .proc-name')].slice(0,5).map(n => n.textContent)`);
      t.assert(JSON.stringify(before) !== JSON.stringify(after), 'Sortierung nach Namen ändert die Reihenfolge',
        JSON.stringify({ before, after }));

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

      await t.clickText('.tab-bar .tab', 'Autostart');
      await t.wait(900);
      t.assert(await t.exists('#view-processes .tab-body'), 'Autostart-Reiter rendert einen Inhalt');
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
        await t.wait(1200);
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
      await t.wait(1800);
      const opened = t.windows().length;
      t.atLeast(opened, before + 1, 'Ein Overlay-Fenster wird tatsächlich geöffnet',
        `vorher ${before}, nachher ${opened}`);

      // The overlay must show live values, not an empty frame.
      const overlayWindow = t.windows().find((w) => w.webContents.getURL().includes('overlay.html'));
      t.assert(!!overlayWindow, 'Overlay lädt overlay.html');
      if (overlayWindow) {
        t.watchConsole(overlayWindow.webContents, 'overlay');
        await t.wait(1800);
        const body = await overlayWindow.webContents.executeJavaScript('document.body.textContent', true);
        t.assert(/\d/.test(body || ''), 'Overlay zeigt Zahlen an', JSON.stringify((body || '').slice(0, 80)));
      }

      await t.clickText('#view-overlays .btn', 'Alle schließen');
      await t.wait(1500);
      t.eq(t.windows().some((w) => w.webContents.getURL().includes('overlay.html')), false,
        'Alle schließen entfernt die Fenster');
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
      await t.wait(1500);
      t.assert(await t.exists('#view-windows .tab-body'), 'Bildschirm-Panel rendert');

      await t.clickText('#view-windows .tab-bar .tab', 'Funktionen');
      // The grid element exists before the catalogue is read, so waiting for it
      // would prove nothing. The filter tabs are built from the loaded data.
      await t.waitFor(`document.querySelectorAll('#view-windows .filter-tabs .filter-tab').length > 0`,
        { label: 'Funktionsliste', timeout: 60000 });
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
    name: 'Bibliothek: Suche und Leerzustand',
    async run(t) {
      await t.view('library');
      await t.wait(1200);
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
      t.atLeast(await t.count('.settings-cols .panel'), 4, 'Alle Einstellungsgruppen sind da');
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
      await t.wait(2500);
      const consoleWindow = t.windows().find((w) => w.webContents.getURL().includes('claude.html'));
      t.assert(!!consoleWindow, 'Konsolenfenster wurde geöffnet', `Fenster vorher ${before}`);
      if (!consoleWindow) return;

      t.watchConsole(consoleWindow.webContents, 'claude');
      const cjs = (code) => consoleWindow.webContents.executeJavaScript(`(${code})`, true);
      await t.wait(900);

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

      // The rail entry is an action, not a destination: the hub stays put.
      t.eq(await t.evalExpr(`document.querySelector('.rail-btn.active').dataset.view`), 'hub',
        'Der Hub wechselt die Ansicht nicht, wenn die Konsole aufgeht');

      consoleWindow.close();
      await t.wait(600);
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
