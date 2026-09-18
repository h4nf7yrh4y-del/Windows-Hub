# Windows Hub

Electron-Launcher für Windows: Profile starten Programmgruppen, dazu Task-Manager,
Dateimanager, Bildschirmsteuerung, Overlays und eine Claude-Code-Konsole.
Ein Hauptprozess, mehrere Fenster, kein Bundler.

## Befehle

```bash
npm install         # einmalig
npm run dev         # startet mit geöffneten DevTools
npm run lint        # Syntaxprüfung plus die maschinell prüfbaren Regeln
npm test            # Logiktests, ~344 Zusicherungen
npm run test:ui     # startet die echte App und bedient 29 Ansichten
npm run check       # alles zusammen
npm run dist        # baut Installer und portable exe nach release/ (nur Windows)
```

`npm test` prüft erzeugte PowerShell-Skripte mit PowerShells eigenem Parser, sofern
eine PowerShell vorhanden ist; sonst wird dieser Teil übersprungen. Mit `PWSH_PATH`
lässt sich ein Binary angeben.

`npm run test:ui` braucht ein Display. Unter Windows und macOS ist das gegeben, unter
Linux wird `xvfb` benutzt; fehlt beides, wird der Lauf mit Hinweis übersprungen statt
fehlzuschlagen.

## Aufbau

- `src/main/` — Hauptprozess. Jede Datei ist ein Fachgebiet: `launcher` startet und
  beendet Profile, `tweaks` ändert den Systemzustand drumherum, `pshost` ist die
  einzige Stelle, die PowerShell ausführt, `ipc` die einzige, die den Renderer an das
  System lässt.
- `src/preload/preload.js` — die einzige Brücke. Explizite Methodenliste, kein
  generisches `invoke(channel, …)`.
- `src/renderer/` — native ES-Module, die der Browser direkt lädt. `js/views/` ist eine
  Datei pro Ansicht, `js/widgets/` sind wiederverwendbare Bausteine.
- `test/` — Logiktests in `test/*.test.js`, Oberflächentests in `test/ui/`.

## Regeln, die nicht offensichtlich sind

Sechs davon prüft `scripts/rules-check.js` bei jedem `npm run lint` mit. Die Auswahl
ist nicht willkürlich: es sind die, die schon einen Build gekostet haben und danach
noch einmal gebrochen wurden — einmal Stunden, nachdem die Regel hier hinzugefügt
worden war. Eine Regel in einer Datei ist ein Hinweis für den, der daran denkt
nachzulesen. `test/rules.test.js` füttert jede Regel mit genau der Zeile, die damals
den Build gekostet hat, und prüft außerdem, dass sie bei der korrigierten Fassung
schweigt — ein Prüfer, der nur auf einem sauberen Baum gelaufen ist, hat nie gezeigt,
dass er etwas findet.

**Der Renderer gilt als nicht vertrauenswürdig.** `contextIsolation: true`,
`nodeIntegration: false`. Jeder IPC-Handler prüft seine eigenen Eingaben. Ein neuer
Kanal braucht einen Eintrag in `ipc.js`, in `preload.js` und in `renderer/js/api.js`.

**Die Oberfläche wird über `hub://` ausgeliefert, nicht über `file://`.** ES-Module
über `file://` blockiert Chromium, und ohne JavaScript-MIME-Typ verweigert es
Modulskripte ganz. Der Handler dafür steht in `main.js`.

**Alle PowerShell-Aufrufe laufen über `processes.runPowerShell`,** das an `pshost`
weiterreicht: ein langlebiger Prozess, Aufträge einzeln über die Standardeingabe als
Base64. Niemals `execFile('powershell.exe', …)` neu einführen — der Prozessstart ist
der teure Teil, und der Host bezahlt ihn einmal. Hintergrundabfragen übergeben
`{ background: true }` und stellen sich hinten an.

**Skripte mit Backslashes brauchen `String.raw`.** Ein normales Template-Literal
verschluckt sie, und ein Registrierungspfad ohne Backslashes schlägt nicht fehl,
sondern liefert stillschweigend nichts. Jedes erzeugte Skript gehört in
`test/powershell.test.js`, das sie durch den echten Parser schickt.

**Lange Vorgänge gehören nicht in den PowerShell-Host.** Der Host hat genau eine
Leitung. Ein `winget upgrade` dauert Minuten und würde Prozessliste, Messwerte und
jede andere Systemabfrage so lange blockieren; außerdem braucht es seine Ausgabe
zeilenweise, was ein Frage-Antwort-Host nicht liefert. `updates.js` startet winget
deshalb als eigenen Prozess. Das gilt auch fürs bloße *Auflisten*: das lief erst über
den Host, weil es „schnell" sei — auf einem Rechner mit kalten Quellen dauerte es
neunzig Sekunden, und solange stand alles andere an, bis hin zu „läuft Steam?". Wie
lange etwas dauert, entscheidet die langsamste Maschine, nicht die eigene.

**Ausgaben, die für Menschen gemacht sind, werden nach Spaltenposition gelesen.**
winget beschriftet seine Spalten in der Systemsprache. Der Parser in `updates.js`
nimmt die Positionen aus der Kopfzeile und die Strichlinie darunter, nicht die
Wörter — sonst funktioniert er in genau einer Sprache. Ein Parser, der nichts findet,
meldet „alles aktuell", und gute Nachrichten prüft niemand nach.

**Was geprüft wird, gehört in eine eigene Funktion — nicht in den Aufruf.**
`shell.openExternal(pruefe(x))` wertet erst `shell.openExternal` aus und dann das
Argument: die Prüfung läuft also *nach* dem Zugriff. In der echten Anwendung fällt
das nie auf, im Test ohne Electron sofort. Ebenso gehört eine Prüfung vor die
Plattformabfrage, sonst läuft sie nur unter Windows und nirgends im Test.

**Ein Oberflächentest fragt nicht noch einmal, was die Ansicht schon gefragt hat.**
Die Ansicht stellt ihre Abfragen beim Öffnen; ein `evalExpr`, das dieselbe Abfrage
wiederholt, zahlt sie ein zweites Mal. Auf dem Windows-Runner waren das neunzig
Sekunden pro winget-Aufruf und drei zusätzliche Minuten für die Suite. Geprüft wird,
was die Ansicht anzeigt, nicht was sich noch einmal abrufen lässt.

**Kein Logiktest behauptet „scheitert an der Plattform".** Die Zusicherung
`assert.rejects(x(), /Windows/)` ist unter Linux wahr und unter Windows sinnlos: dort
gibt es keine Sperre, an der etwas scheitert, also *tut* der Aufruf, was er soll. Das ist
inzwischen dreimal passiert — `updates.run`, `audio.setDefault`, `discord.open` — und
kostete beim zweiten Mal wieder fünf Minuten Testlauf, weil dabei der PowerShell-Host
startete. Geprüft wird die Zurückweisung einer ungültigen Eingabe: die gilt überall
gleich und beweist genau das, worum es ging — dass die Prüfung vor der Plattformabfrage
steht.

**Ein Test, der eine Aktion aufruft, führt sie auch aus.** Unter Linux warf
`updates.run(null)` „nur unter Windows verfügbar", und genau das prüfte der
Oberflächentest. Auf dem Windows-Runner warf derselbe Aufruf nichts — er startete
`winget upgrade --all` und aktualisierte den Rechner, bis der Testlauf in die
Zehn-Minuten-Grenze lief. Wer eine Absicherung prüfen will, prüft die Prüfung: eine
abgewiesene Eingabe, keinen Aufruf, der nur zufällig scheitert. Und eine Zusicherung,
die „außerhalb von Windows" im Namen trägt, gehört auf die Plattform geprüft oder gar
nicht geschrieben.

**Logiktests fassen nichts an, was einen Prozess startet.** `require` auf ein
Hauptprozess-Modul ist harmlos, ein Aufruf darin oft nicht: ein Test, der unter
Linux brav am `IS_WIN`-Riegel scheitert, lief auf dem Windows-Runner durch, startete
den PowerShell-Host und hielt den Testlauf fünf Minuten lang offen, bis der Host
wegen Leerlauf aufgab. Testbar ist die reine Funktion davor, nicht die Wirkung.

**Eine Zeitüberschreitung im Host ist teurer als das Warten.** Der hängende Auftrag
besetzt die Leitung bis zum Ende seines Limits und kostet danach einen Neustart des
Hosts — alles, was dahinter wartet, zahlt zusätzlich einen kalten PowerShell-Start.
Ein knappes Limit macht eine langsame Abfrage also nicht billiger, sondern teurer. Was
bekanntermaßen lange dauert, bekommt Zeit und `{ background: true }`, damit es sich
nicht vor etwas drängelt, auf das jemand wartet.

**Ein unbekannter Wert wird abgewiesen, nicht auf den harmlosen zurückgesetzt.** Das
Muster ist hier dreimal aufgetreten: ein unbekannter Steam-Modus, eine unbekannte
Sicherungs-Art, eine unbekannte Discord-Art. Jedes Mal sah der Rückfall harmlos aus,
und jedes Mal hätte er die Prüfung genau dort ausgehebelt, wo sie gebraucht wird — eine
vertippte Sprungmarke in den Sprachkanal wird sonst zu „Discord öffnen", steht richtig
in der Liste und springt woanders hin.

**Kennungen kommen aus `crypto.randomUUID()`, nicht aus der Uhr.** `Date.now()` als
Kennung heißt: zwei Einträge in derselben Millisekunde teilen sich eine, und der zweite
überschreibt den ersten stillschweigend.

**Zusicherungen auf feste Anzahlen brechen beim nächsten Feature.** „Zehn Einträge in
der Seitenleiste" und „der erste Abschnitt ist winget" sind beide schon gebrochen, und
zwar aus dem einzigen Grund, der kein Fehler ist. Geprüft wird, was da sein muss — über
seinen Namen, nicht über seine Position.

**Ein leeres Ergebnis ist etwas anderes als ein Fehler.** Unter Windows heißt „nichts
gefunden" oft Exitcode ungleich null. Wo das zutrifft, muss der Aufrufer unterscheiden
können — `killByName` meldet deshalb `matched`.

**Nie auf eine Stoppuhr warten, immer auf ein Ereignis.** Weder im Code noch in Tests.
Feste Pausen sind auf einem ausgelasteten Rechner eine Münze, und genau dann wird
diese Anwendung benutzt. Die Testtreiber haben dafür `waitFor`, `waitIn`,
`waitForWindow`.

**Was ohne die Daten funktioniert, bleibt während des Ladens bedienbar.** Ein
Platzhalter ersetzt die Liste, nicht den Abschnitt: „Steam-Updates starten" hängt nicht
daran, ob die Bibliothek schon gelesen ist, und darf deshalb nicht verschwinden.

**Langsame Abfragen dürfen die Oberfläche nicht aufhalten.** Was sofort da ist, wird
sofort gezeichnet; was dauert, wird nachgetragen. Dieser Fehler ist hier schon fünfmal
passiert — Dateimanager-Seitenleiste, Funktionskatalog, Dashboard, Update-Center,
Discord-Panel. Beim fünften Mal bestand der ganze Inhalt aus einer Konstante und der
Konfiguration, und die Ansicht wartete trotzdem eine halbe Minute: eine einzige Zeile
„läuft der Client?" hing mit dran. Eine Antwort, die man schon hat, wartet auf nichts.

Beim vierten Mal kam eine Verschärfung dazu: eine Abfrage ist nicht schnell, nur weil
sie wenig tut. `steamUpdates` las Manifestdateien in Millisekunden und hängte dann eine
einzige Zeile „läuft der Client?" an, die über den PowerShell-Host geht — eine Leitung,
zu dem Zeitpunkt mitten in einer winget-Abfrage. Damit wartete die schnelle Hälfte
neunzig Sekunden auf ein Detail. Was den Host braucht, wird getrennt abgefragt und
nachgetragen, und bis dahin sagt die Oberfläche „wird geprüft" statt zu raten.

## Sprache und Stil

Oberflächentexte, Fehlermeldungen und Logzeilen auf Deutsch. Kommentare und
Commit-Nachrichten auf Englisch, und zwar über das *Warum*: was der Code tut, steht im
Code. Kommentare, die nur die nächste Zeile wiederholen, gehören gelöscht.

Keine Emojis, keine Ausrufezeichen in der Oberfläche. Ein Hinweis, der eine Einschränkung
erklärt, ist besser als einer, der sie verschweigt.

## Bauen und Veröffentlichen

Jeder Push auf einen Branch löst den Workflow in `.github/workflows/build.yml` aus:
Tests unter Linux, dann Bauen und dieselben Oberflächentests auf einem Windows-Runner.
Gebaut wird immer, **veröffentlicht nur, wenn es etwas zu veröffentlichen gibt**: wenn
die Version in `package.json` sich gegenüber dem vorherigen Commit geändert hat, bei
einem Push auf einen `v*`-Tag, oder wenn der Workflow von Hand mit dem Schalter
„Release" gestartet wird. Der Grund steht in der Zusammenfassung des Laufs, damit eine
ausbleibende Release nie stillschweigend passiert.

Das hat einen handfesten Grund: Die beiden exe sind je rund 106 MB, und ihr Upload hat
eine Viertelstunde gedauert — bei jedem Push, auch wenn sich nur ein Kommentar geändert
hat. Eine neue exe ist also eine Entscheidung, keine Nebenwirkung. Nur ein grüner Lauf
veröffentlicht. Der Windows-Runner hat zwei Kerne und eine kaputte WMI-Energieverwaltung
— was dort langsam ist, ist oft ein echter Engpass und nicht nur CI.
