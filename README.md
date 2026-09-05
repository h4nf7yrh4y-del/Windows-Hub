# Windows Hub

Ein Vollbild-Launcher für Windows im Cyberpunk-Stil. Startet mit dem PC, bündelt
Spiel- und Programmprofile und bringt Systemüberwachung sowie einen Task-Manager
direkt mit.

![Status](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-00f0ff) ![Status](https://img.shields.io/badge/stack-Electron-ff2e88)

---

## Was es kann

**Profile.** Ein Profil bündelt mehrere Programme zu einer Startsequenz. Beispiel
„Helldivers 2": Spotify sofort, Discord nach 2 Sekunden, das Spiel nach 4 Sekunden.
Die Verzögerungen sind wichtig, damit das Spiel den Fokus behält und nicht während
seines Splash-Screens von Discord überlagert wird. Jedes Profil hat eine eigene
Akzentfarbe und optional ein Hintergrundbild; beim Start färbt sich die gesamte
Oberfläche in dieser Farbe ein.

**Bibliothek.** Der Hub findet installierte Programme selbst, statt dass du Pfade
tippst. Gescannt werden Steam-Bibliotheken (auch auf mehreren Laufwerken), Epic-Games-
Manifeste, Startmenü-Verknüpfungen und alle über `Get-StartApps` registrierten Apps,
inklusive UWP- und Xbox-Game-Pass-Titel.

**Systemüberwachung.** CPU gesamt und pro Kern, RAM, GPU-Auslastung, Laufwerks-
belegung, Datenträger- und Netzwerkdurchsatz, Betriebszeit, Temperaturen. Alles live
als Ringe, Verlaufsgraphen und Balken. Die GPU-Werte kommen von AMD, Intel und NVIDIA
gleichermaßen, aufgeschlüsselt nach Engine, also 3D, Video-Kodierung, Compute und
Kopieren getrennt.

**Task-Manager.** Vollständige Prozessliste mit echter CPU-Prozentberechnung über
Zeitdeltas, Speicherverbrauch absolut und relativ, Threads und Fenstertitel.
Sortierbar, durchsuchbar, Prozesse lassen sich samt Unterprozessen beenden.
Systemkritische Prozesse sind gesperrt.

**Floating-Overlays.** Sechs frei platzierbare Mini-Fenster, die immer im
Vordergrund bleiben: eine kompakte Balkenleiste mit CPU, RAM, GPU und Netz sowie
je ein eigenes Widget pro Messwert. Größe, Deckkraft und Position sind pro Widget
einstellbar. Ein fixiertes Overlay nimmt keine Klicks mehr an, du klickst durch es
hindurch. Aktive Overlays kommen beim nächsten Hub-Start automatisch zurück.

**Dateimanager.** Zweispaltig mit Schnellzugriff und Laufwerksleiste, Verlauf
vorwärts und rückwärts, Breadcrumb-Navigation, Sortierung, Mehrfachauswahl mit
Strg und Umschalt, rekursive Suche, Kopieren, Verschieben, Umbenennen, Ordner
anlegen und Eigenschaften samt Ordnergrößenberechnung. Gelöschtes landet im
Papierkorb.

**Autostart-Manager.** Als zweiter Tab im Task-Manager. Zeigt alle vier Run-Schlüssel
der Registry und beide Autostart-Ordner mit Befehlszeile und Bereich. Einträge lassen
sich entfernen und im Explorer anzeigen.

**Systemsteuerung.** Sperren, Energiesparen, Abmelden, Neustart, Herunterfahren.
Jede dieser Aktionen verlangt eine Bestätigung.

---

## Installation

Voraussetzung ist Node.js 18 oder neuer.

```bash
npm install
npm start
```

### Fertige exe herunterladen

Jeder Push baut die Windows-Dateien automatisch auf einem Windows-Runner. Du musst
nichts selbst kompilieren:

1. Im Repository auf **Actions** gehen.
2. Den obersten Lauf von **Build Windows** öffnen.
3. Unten unter **Artifacts** liegen zwei Dateien:
   - `WindowsHub-setup` enthält den Installer.
   - `WindowsHub-portable` enthält eine einzelne exe, die ohne Installation startet.

Für einen dauerhaften Download-Link genügt ein Tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Dann hängt der Lauf beide Dateien an ein GitHub-Release.

### Selbst bauen

Das geht nur unter Windows, weil electron-builder dort die Windows-Werkzeugkette
braucht:

```bash
npm run dist
```

Das Ergebnis liegt in `release/` als `WindowsHub-<version>-setup.exe` und
`WindowsHub-<version>-portable.exe`.

---

## Erste Schritte

1. Hub starten, links auf **Library** wechseln und den Scan abwarten.
2. Zurück auf **Hub**, dann **Neues Profil**.
3. Name vergeben, Akzentfarbe wählen, über **Aus Bibliothek** die Programme
   hinzufügen.
4. Verzögerungen setzen. Bewährt hat sich: Musik bei 0 ms, Chat bei 2000 ms,
   Spiel bei 4000 ms.
5. **Hub beim Start minimieren** aktiviert lassen.
6. Unter **Setup** den Punkt **Mit Windows starten** einschalten.

Die Reihenfolge in der Startsequenz lässt sich per Drag-and-drop ändern.

---

## Tastenkürzel

| Taste | Wirkung |
|---|---|
| `F11` | Vollbild umschalten |
| `Alt` + `1` … `7` | Direkt zu Hub, System, Tasks, Files, Overlay, Library, Setup |
| `Strg` + `Umschalt` + `Q` | Hub sofort beenden, auch im Kiosk-Modus |
| `F5` | Oberfläche neu laden |
| `Esc` | Offenen Dialog schließen |

Im Dateimanager zusätzlich:

| Taste | Wirkung |
|---|---|
| `Strg` + `C` / `X` / `V` | Kopieren, Ausschneiden, Einfügen |
| `Strg` + `A` | Alles auswählen |
| `Entf` | In den Papierkorb |
| `F2` | Umbenennen |
| `Rücktaste` | Eine Ebene nach oben |
| `Enter` im Suchfeld | Rekursiv ab dem aktuellen Ordner suchen |

---

## Konfiguration

Alles liegt in einer einzigen Datei unter
`%APPDATA%\Windows Hub\hub-config.json`. Sie ist von Hand lesbar und editierbar
und eignet sich als Backup. Über **Setup → Konfiguration öffnen** springst du direkt
dorthin. Ist die Datei beschädigt, wird sie als `.broken-<zeitstempel>` beiseite
gelegt statt gelöscht.

Ein Profileintrag sieht so aus:

```json
{
  "id": "…",
  "name": "HELLDIVERS 2",
  "tagline": "Managed Democracy",
  "accent": "#ffb400",
  "minimizeOnLaunch": true,
  "apps": [
    { "name": "Spotify", "launch": { "type": "uri", "target": "spotify:" }, "delayMs": 0 },
    { "name": "Discord", "launch": { "type": "uri", "target": "discord://" }, "delayMs": 2000 },
    { "name": "Helldivers 2", "launch": { "type": "uri", "target": "steam://rungameid/553850" }, "delayMs": 4000 }
  ]
}
```

Unterstützte Starttypen:

| Typ | Bedeutung | Beispiel |
|---|---|---|
| `exe` | Programm direkt starten | `C:\Program Files\App\app.exe` |
| `uri` | Protokoll-Handler | `steam://rungameid/553850` |
| `appsfolder` | Windows-App über ihre AppID | `Microsoft.XboxApp_…!App` |
| `shell` | Beliebiger Befehl über `cmd` | `wt -p PowerShell` |

---

## Architektur

```
src/main/        Hauptprozess: Fenster, IPC, OS-Zugriffe
  main.js        Lebenszyklus, Vollbild, Autostart, hub:// Protokoll
  ipc.js         Alle IPC-Handler, jeder validiert seine Eingaben selbst
  store.js       JSON-Konfiguration mit atomarem Schreiben
  metrics.js     Zweistufiger Telemetrie-Sammler
  processes.js   Prozessliste und Beenden
  scanner.js     Erkennung installierter Programme und Spiele
  launcher.js    Startsequenzen für Profile
  gpu.js         Herstellerneutrale GPU-Telemetrie über die Windows-Zähler
  files.js       Dateioperationen mit Papierkorb und Schutzregeln
  startup.js     Autostart-Einträge aus Registry und Startordnern
  overlays.js    Lebenszyklus der Floating-Fenster
  power.js       Herunterfahren, Neustart, Sperren
src/preload/     Die einzige Brücke zwischen Renderer und System
src/renderer/    Oberfläche, reines ES-Modul-JavaScript ohne Build-Schritt
  index.html     Hauptfenster
  overlay.html   Ein Floating-Widget, Typ kommt aus der eigenen URL
```

Zwei Entscheidungen, die den Rest erklären:

**Telemetrie läuft zweistufig.** CPU und RAM kommen jede Sekunde aus Node-Bordmitteln
und kosten praktisch nichts. Laufwerke, Netzwerk und GPU kommen alle fünf Sekunden
über `systeminformation`, weil jede dieser Abfragen unter Windows PowerShell oder WMI
startet. Ein Monitor, der die Werte verfälscht, die er anzeigt, wäre wertlos.

**Der Renderer läuft unter einem eigenen Protokoll.** Statt `file://` liefert ein
`hub://`-Handler die Oberfläche aus. Dadurch bleiben `contextIsolation`, `webSecurity`
und eine strenge Content-Security-Policy aktiv, und ES-Module funktionieren trotzdem.
Der Renderer hat keinen Node-Zugriff; alles läuft über die im Preload aufgezählten
Methoden.

Die Prozessliste wird pro Abfrage mit genau einem PowerShell-Aufruf geholt. Die
CPU-Prozente entstehen aus der Differenz der Prozessorsekunden zwischen zwei Abfragen,
geteilt durch die verstrichene Zeit und die Kernanzahl. Genau so rechnet auch der
Windows-Task-Manager.

**GPU-Werte kommen aus den Windows-Grafikzählern, nicht von `nvidia-smi`.** Der
naheliegende Weg über `systeminformation` ruft intern `nvidia-smi` auf und liefert
deshalb nur für NVIDIA etwas Brauchbares. Windows selbst veröffentlicht seit Version
1709 Zähler pro Grafik-Engine, und genau darauf baut auch die GPU-Spalte des
Windows-Task-Managers auf. Sie decken jeden WDDM-2.0-Treiber ab, also AMD, Intel und
NVIDIA gleichermaßen. Der Hub liest sie über die WMI-Leistungsklassen statt über
`Get-Counter`, weil WMI-Klassen- und Eigenschaftsnamen unveränderlich englisch sind,
während `Get-Counter`-Pfade lokalisiert werden und auf einem deutschen Windows
`\GPU-Engine(*)\Prozentsatz der Auslastung` heißen würden.

Die Auslastung ist bewusst das Maximum über die Engine-Typen und nicht deren Summe.
3D-, Video- und Kopier-Engine laufen parallel auf derselben Hardware; sie zu addieren
ergibt Werte über 100 Prozent. Innerhalb eines Engine-Typs werden die Anteile der
einzelnen Prozesse dagegen sehr wohl addiert.

**PowerShell-Aufrufe gehen über `-EncodedCommand`.** Das Skript wird als
Base64-kodiertes UTF-16LE übergeben, wodurch Anführungszeichen, Zeilenumbrüche und
Umlaute unverändert ankommen und nichts für den Kommandozeilen-Parser von Windows
maskiert werden muss.

**Overlays sind eigenständige Verbraucher des Messstroms.** Der Sammler zählt
Fensterabonnenten und Overlay-Fenster getrennt, damit die Widgets weiterlaufen,
während der Hub minimiert ist. Ein Overlay kennt seinen Typ nur aus der eigenen
Fenster-URL, nie aus einer Nachricht, und kann deshalb ausschließlich sich selbst
anzeigen und schließen.

**Der Dateimanager weigert sich, Laufwerkswurzeln, `C:\Windows`, die Programm-
verzeichnisse und das Benutzerverzeichnis selbst zu verändern.** Kopieren in den
eigenen Unterordner wird ebenfalls abgelehnt, sonst läuft der Datenträger voll.
Gelöschtes geht in den Papierkorb; endgültiges Löschen bietet der Hub gar nicht erst
an.

---

## Grenzen, ehrlich

Diese Punkte sind keine Bugs, sondern Eigenschaften des gewählten Ansatzes. Du
solltest sie kennen, bevor du den Hub dauerhaft einsetzt.

**Der Hub verbraucht selbst 150 bis 250 MB RAM.** Das ist der Preis von Electron und
bei einem Werkzeug, das RAM-Verbrauch anzeigt, unangenehm. Deutlich sparsamer ginge es
nur mit WPF oder WinUI in C#, dann aber mit erheblich mehr Aufwand für genau die
Animationen und Effekte, die den Reiz ausmachen. Auf einem Gaming-PC mit 16 GB oder
mehr fällt es nicht ins Gewicht, auf einem 8-GB-Rechner schon eher.

**GPU-Temperatur und Lüfterdrehzahl liefern nur NVIDIA-Karten.** Auslastung und
Videospeicher funktionieren bei AMD, Intel und NVIDIA gleich gut, weil sie aus den
Windows-GPU-Zählern kommen. Für Temperatur und Lüfter gibt es keinen solchen Zähler:
NVIDIA gibt sie über `nvidia-smi` heraus, AMD und Intel stellen unter Windows gar
keine allgemein abfragbare Schnittstelle dafür bereit. Diese beiden Felder bleiben
dort leer, solange kein Sensorprogramm wie HWiNFO oder LibreHardwareMonitor läuft.
Der Hub liest solche Programme bewusst nicht aus, das wäre eine zusätzliche
Abhängigkeit für zwei Zahlen.

**Die GPU-Zähler brauchen Windows 10 ab Version 1709 und einen WDDM-2.0-Treiber.**
Auf älteren Systemen bleibt die Auslastung leer, und der Hub sagt das im
Grafik-Bereich auch so.

**Bei mehreren Grafikkarten ist die Zuordnung eine begründete Vermutung.** Die Zähler
sind nach Adapter-LUID gruppiert, und Windows bietet keinen dokumentierten Weg, eine
LUID einem Eintrag aus `Win32_VideoController` zuzuordnen. Der Hub paart deshalb die
Zählergruppe mit dem höchsten belegten Videospeicher mit der Karte mit dem meisten
VRAM. Bei genau einer Karte, also im Normalfall, ist die Zuordnung exakt. Auf einem
Notebook mit iGPU und dGPU kann sie in seltenen Fällen vertauscht sein.

**CPU-Temperatur bleibt oft leer.** Windows gibt Sensordaten ohne erhöhte Rechte
und ohne Zusatztreiber meist nicht heraus.

**Prozesse mit höheren Rechten lassen sich nicht beenden,** solange der Hub nicht als
Administrator läuft. Dauerhaft als Administrator zu starten ist eine bewusste
Abwägung, nicht der Standard.

**Der Kiosk-Modus ist keine Sicherheitsgrenze.** `Strg` + `Umschalt` + `Q` beendet den
Hub immer, und der Task-Manager von Windows bleibt erreichbar. Er verhindert
versehentliches Verlassen des Vollbilds, mehr nicht.

**Der Autostart hängt am `Run`-Schlüssel des aktuellen Benutzers.** Manche
Optimierungs- und Aufräumprogramme entfernen solche Einträge eigenmächtig.

**Die erzeugte Installationsdatei ist nicht signiert.** SmartScreen wird beim ersten
Start warnen. Ein Code-Signing-Zertifikat kostet Geld; ohne eines lässt sich das nicht
umgehen.

**Programme werden nur gestartet, nicht überwacht.** Der Hub prüft nicht, ob ein
Spiel tatsächlich hochgekommen ist. Die Verzögerungen sind feste Zeiten, keine
Bedingungen. Bei sehr langsamen Datenträgern musst du die Werte anpassen.

**Der Bibliotheks-Scan ist auf fünf Minuten zwischengespeichert.** Nach einer
Neuinstallation musst du in der Bibliothek einmal **Neu scannen** drücken.

**Die Overlays sind über echten Vollbild-Spielen unsichtbar.** Das ist die wichtigste
Einschränkung dieser Funktion. Windows setzt das Bild im exklusiven Vollbildmodus
direkt auf der Grafikkarte zusammen und lässt kein fremdes Fenster darüber. Steam und
Discord schaffen das nur, weil sie sich in die Grafikschnittstelle des Spiels
einklinken, und genau das kann Electron nicht. Stell das Spiel auf **randloses
Fenster**, dann funktionieren die Overlays. Läuft es echt im Vollbild, hilft nur ein
zweiter Monitor oder das eingebaute Overlay des Spiels.

**Kopieren und Verschieben großer Ordner zeigen keinen Fortschritt.** Der Vorgang
läuft asynchron und blockiert die Oberfläche nicht, aber du siehst nur „läuft" und
danach das Ergebnis. Für ein 200-GB-Spielverzeichnis nimm den Explorer.

**Der Dateimanager listet höchstens 8000 Einträge pro Ordner** und bricht die
rekursive Suche nach 400 Treffern, sechs Ebenen oder zwölf Sekunden ab. Das ist eine
bewusste Grenze, damit ein Ordner mit 80000 Dateien die Oberfläche nicht einfriert.

**Autostart-Einträge lassen sich entfernen, aber nicht abschalten.** Windows legt den
Aktiv-Zustand in binären `StartupApproved`-Blobs ab. Diese falsch zu schreiben
hinterlässt einen Eintrag, den weder der Hub noch der Windows-Task-Manager wieder
geradebiegen kann. Entfernen ist umkehrbar, ein kaputter Blob nicht, deshalb gibt es
hier bewusst keinen Schalter. Zum reinen Abschalten nimm den Windows-Task-Manager.

**Systemweite Autostart-Einträge und Registry-Schlüssel unter `HKLM` brauchen
Administratorrechte.** Ohne diese schlägt das Entfernen mit einer Fehlermeldung fehl.

---

## Entwicklung

```bash
npm run dev     # startet mit geöffneten DevTools
npm run lint    # prüft alle Quelldateien auf Syntaxfehler
npm test        # prüft die GPU-Auswertung und die PowerShell-Skripte
npm run check   # lint und test zusammen
npm run pack    # baut ein entpacktes Verzeichnis statt eines Installers
```

Die Tests brauchen kein Windows. Die GPU-Auswertung wird gegen aufgezeichnete
Zählerdaten geprüft, und wenn eine PowerShell vorhanden ist, werden zusätzlich alle
erzeugten Skripte von PowerShells eigenem Parser auf Syntaxfehler geprüft und die
JSON-Ausgabe gegen den Node-seitigen Parser gehalten. Ohne PowerShell wird dieser
Teil übersprungen; mit `PWSH_PATH` lässt sich ein Binary explizit angeben. Das ist
wichtig, weil ein Syntaxfehler in einem dieser Skripte unter Windows nicht abstürzt,
sondern nur ein leeres Ergebnis liefert.

Es gibt bewusst keinen Bundler. Der Renderer besteht aus nativen ES-Modulen, die der
Browser direkt lädt; eine Änderung ist nach `F5` sichtbar.

---

## Lizenz

MIT
