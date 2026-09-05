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
als Ringe, Verlaufsgraphen und Balken.

**Task-Manager.** Vollständige Prozessliste mit echter CPU-Prozentberechnung über
Zeitdeltas, Speicherverbrauch absolut und relativ, Threads und Fenstertitel.
Sortierbar, durchsuchbar, Prozesse lassen sich samt Unterprozessen beenden.
Systemkritische Prozesse sind gesperrt.

**Systemsteuerung.** Sperren, Energiesparen, Abmelden, Neustart, Herunterfahren.
Jede dieser Aktionen verlangt eine Bestätigung.

---

## Installation

Voraussetzung ist Node.js 18 oder neuer.

```bash
npm install
npm start
```

Für ein installierbares Paket (muss unter Windows laufen):

```bash
npm run dist
```

Das Ergebnis liegt in `release/` als `WindowsHub-<version>-setup.exe`.

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
| `Alt` + `1` … `5` | Direkt zu Hub, System, Tasks, Library, Setup |
| `Strg` + `Umschalt` + `Q` | Hub sofort beenden, auch im Kiosk-Modus |
| `F5` | Oberfläche neu laden |
| `Esc` | Offenen Dialog schließen |

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
  power.js       Herunterfahren, Neustart, Sperren
src/preload/     Die einzige Brücke zwischen Renderer und System
src/renderer/    Oberfläche, reines ES-Modul-JavaScript ohne Build-Schritt
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

---

## Grenzen, ehrlich

Diese Punkte sind keine Bugs, sondern Eigenschaften des gewählten Ansatzes. Du
solltest sie kennen, bevor du den Hub dauerhaft einsetzt.

**Der Hub verbraucht selbst 150 bis 250 MB RAM.** Das ist der Preis von Electron und
bei einem Werkzeug, das RAM-Verbrauch anzeigt, unangenehm. Deutlich sparsamer ginge es
nur mit WPF oder WinUI in C#, dann aber mit erheblich mehr Aufwand für genau die
Animationen und Effekte, die den Reiz ausmachen. Auf einem Gaming-PC mit 16 GB oder
mehr fällt es nicht ins Gewicht, auf einem 8-GB-Rechner schon eher.

**GPU-Auslastung liefert in der Praxis nur NVIDIA.** Die Werte stammen aus
`nvidia-smi`. AMD- und Intel-Karten zeigen meist nur Modell und VRAM, das Auslastungs-
feld bleibt leer. Wenn deine GPU nichts liefert, schalte die Abfrage unter
**Setup → Telemetrie** ab, das spart eine teure Abfrage alle fünf Sekunden.

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

---

## Entwicklung

```bash
npm run dev     # startet mit geöffneten DevTools
npm run lint    # prüft alle Quelldateien auf Syntaxfehler
npm run pack    # baut ein entpacktes Verzeichnis statt eines Installers
```

Es gibt bewusst keinen Bundler. Der Renderer besteht aus nativen ES-Modulen, die der
Browser direkt lädt; eine Änderung ist nach `F5` sichtbar.

---

## Lizenz

MIT
