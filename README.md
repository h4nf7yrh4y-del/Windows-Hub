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

**Systemzustand pro Profil.** Ein Profil startet nicht nur Programme, es richtet auch
den Rechner darauf ein. Im Reiter **System** des Profileditors lassen sich vier Dinge
festlegen: ein Energieplan, der beim Start aktiviert und beim Beenden wieder
zurückgestellt wird; eine höhere Prozesspriorität für das Spiel, gesetzt erst dann,
wenn der Prozess tatsächlich auftaucht — ein über Steam gestartetes Spiel erscheint
Sekunden später und unter eigenem Namen; eine Liste von Hintergrundprogrammen, die vor
dem Start geschlossen und danach optional wieder gestartet werden; und ein Schalter,
der Bildschirmschoner und Energiesparmodus aussetzt.

Geschlossen wird in zwei Stufen: erst die höfliche Aufforderung, dann nach zweieinhalb
Sekunden hart. Ein Browser, der sofort abgeschossen wird, verliert seine Tabs und meldet
beim nächsten Start einen Absturz. Der Pfad jedes beendeten Programms wird vorher
gemerkt, damit es sich neu starten lässt.

Alles, was ein Profil am System ändert, wird vor der Änderung in die Konfigurationsdatei
geschrieben. Wird der Hub abgeschossen, während ein Profil läuft, findet der nächste
Start diesen Vermerk und stellt den vorherigen Zustand wieder her — ein Energieplan darf
nicht deshalb umgestellt bleiben, weil ein Launcher abgestürzt ist. Die Prioritätsstufe
*Echtzeit* wird bewusst nicht angeboten: sie verdrängt die Eingabe- und Audio-Threads
des Kernels, und ein Spiel, das dann hängt, nimmt den Mauszeiger mit.

**Laufstatus.** Jede Profilkarte zeigt, ob ihre Programme gerade laufen: grün für
alles, gelb für teilweise, grau für gestoppt. Die einzelnen Einträge sind ebenso
markiert, sodass du siehst, ob nur Discord fehlt oder das Spiel selbst. Der Hub prüft
dafür alle vier Sekunden, welche Prozessnamen aktiv sind.

**Bildschirme.** Helligkeit, Auflösung, Bildwiederholrate und Hauptbildschirm pro
Monitor, dazu die Anzeigemodi hinter Windows-Taste und P. Eine Auflösungsänderung
wird nach fünfzehn Sekunden automatisch zurückgenommen, wenn du sie nicht bestätigst,
damit ein schwarzer Bildschirm kein Problem bleibt.

**Windows-Funktionen.** Ein Katalog aus 39 Einstellungen und Werkzeugen, die nützlich
und schwer zu finden sind, von Spielmodus über Zeigerbeschleunigung und das klassische
Kontextmenü bis zum Zuverlässigkeitsverlauf. 24 davon lassen sich direkt im Hub
umstellen: als Schalter, als Auswahlliste dort wo an und aus nicht reicht, und mit
Administrator-Abfrage bei den drei Einträgen, die den ganzen Rechner betreffen.
Die restlichen elf sind Werkzeuge wie der Geräte-Manager, die man nicht einschalten,
sondern nur starten kann.

**Protokoll und Diagnose.** Alles Nennenswerte landet in einer rotierenden Logdatei:
Startumgebung, fehlgeschlagene Systemaufrufe samt betroffenem Kanal und Fehler aus der
Oberfläche. Ein Knopf schreibt daraus einen Diagnosebericht mit Versionen, Hardware,
dem Ergebnis aller Plattform-Abfragen und der Konfiguration, aus der persönliche Pfade
und Hintergrundbilder entfernt sind.

**Claude-Code-Konsole.** Ein eigenes Fenster mit laufender Sitzung: Ordner, Modell und
Berechtigungen einstellen, Nachrichten schicken, Antworten im Zeichenfluss mitlesen.
Jeder Werkzeugaufruf erscheint als eigene Karte mit Befehl und Ergebnis, die laufenden
Kosten stehen in der Kopfzeile. Daneben weiterhin: Erkennung der Befehlszeile, Öffnen
in einem Terminal und Auswertung des Diagnoseberichts.

**Globale Tastenkürzel.** Ein Kürzel holt den Hub aus jedem Programm heraus nach
vorne, ein zweites blendet alle Overlays ein und aus. Beide sind frei belegbar.

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

Jeder Push baut die Windows-Dateien auf einem Windows-Runner und veröffentlicht sie
unter **Releases**. Du musst nichts selbst kompilieren:

| Datei | Wofür |
|---|---|
| `WindowsHub-<version>-portable.exe` | Startet direkt, ohne Installation |
| `WindowsHub-<version>-setup.exe` | Installer mit Verknüpfungen |

Der Release-Link führt direkt auf die exe, ohne Zip-Archiv. Solange dieses
Repository privat ist, musst du dafür allerdings bei GitHub mit deinem Konto
angemeldet sein; ein anonymer Download ergibt einen 404. Erst wenn du das
Repository öffentlich stellst, funktioniert der Link für jeden.

Dieselben Dateien liegen zusätzlich unter **Actions** beim jeweiligen Lauf als
Artefakte. Die sind immer in ein Zip verpackt und ebenfalls nur angemeldet
erreichbar, deshalb ist der Release der bequemere Weg.

Beide Dateien sind nicht signiert. Windows SmartScreen warnt beim ersten Start,
über *Weitere Informationen* und *Trotzdem ausführen* kommst du daran vorbei. Ein
Code-Signing-Zertifikat kostet Geld; ohne eines lässt sich das nicht umgehen.

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
6. Im Reiter **System** optional Energieplan, Priorität und die Programme
   festlegen, die vorher zu sollen.
7. Unter **Setup** den Punkt **Mit Windows starten** einschalten.

Die Reihenfolge in der Startsequenz lässt sich per Drag-and-drop ändern.

---

## Tastenkürzel

Systemweit, also auch während ein Spiel läuft:

| Taste | Wirkung |
|---|---|
| `Alt` + `Umschalt` + `H` | Hub nach vorne holen oder ausblenden |
| `Strg` + `Umschalt` + `Q` | Hub sofort beenden, auch im Kiosk-Modus |

Die erste Kombination ist unter **Setup → Tastenkürzel** frei belegbar, ebenso ein
optionales Kürzel für die Overlays. Jede Belegung braucht mindestens Strg, Alt oder
Umschalt, sonst würde die Taste in allen anderen Programmen verschluckt.

Innerhalb des Hub-Fensters:

| Taste | Wirkung |
|---|---|
| `F11` | Vollbild umschalten |
| `Alt` + `1` … `9` | Direkt zu Hub, System, Tasks, Files, Overlay, Windows, Claude, Library, Setup |
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
  hotkeys.js     Globale Tastenkürzel mit Prüfung und Rückfall
  logger.js      Rotierende Logdatei mit Kopie der letzten Zeilen im Speicher
  diagnostics.js Diagnosebericht mit entfernten persönlichen Daten
  claudecode.js  Erkennung der Claude-Code-Befehlszeile und einmalige Aufrufe
  claudesession.js Laufende Sitzung über das Streaming-JSON-Protokoll
  display.js     Monitore: Helligkeit, Auflösung, Hauptbildschirm
  winfeatures.js Katalog der Windows-Einstellungen und -Werkzeuge
  ps/            C#-Hilfsklasse für die Win32-Aufrufe der Bildschirmsteuerung
  files.js       Dateioperationen mit Papierkorb und Schutzregeln
  startup.js     Autostart-Einträge aus Registry und Startordnern
  overlays.js    Lebenszyklus der Floating-Fenster
  power.js       Herunterfahren, Neustart, Sperren
src/preload/     Die einzige Brücke zwischen Renderer und System
src/renderer/    Oberfläche, reines ES-Modul-JavaScript ohne Build-Schritt
  index.html     Hauptfenster
  overlay.html   Ein Floating-Widget, Typ kommt aus der eigenen URL
  claude.html    Fenster der Claude-Code-Konsole
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

**Die Bildschirmsteuerung braucht drei getrennte Mechanismen.** Windows bietet für
Helligkeit keine einheitliche Schnittstelle: die WMI-Klasse `WmiMonitorBrightness`
kennt ausschließlich das eingebaute Notebook-Panel, externe Monitore laufen über
DDC/CI, und Auflösung sowie Hauptbildschirm gehen über `ChangeDisplaySettingsEx`. Die
letzten beiden sind reine Win32-Aufrufe ohne PowerShell-Entsprechung, deshalb liegt in
`ps/display.cs.txt` eine kleine C#-Klasse, die beim ersten Aufruf übersetzt und als
DLL zwischengespeichert wird. Bei jedem Aufruf neu zu übersetzen würde einem Regler
ein bis zwei Sekunden Verzögerung geben.

**Der Funktionskatalog kennt vier Arten von Steuerung.** Ein Schalter für einen
An-Aus-Wert, eine Auswahlliste wo es mehr als zwei sinnvolle Zustände gibt, eine
Sonderbehandlung für Einstellungen die kein einzelner Wert sind wie das klassische
Kontextmenü unter Windows 11, und den Energieplan über `powercfg`.

Schreibzugriffe gehen ausschließlich unter HKCU, mit genau drei ausgenommenen
Einträgen: GPU-Planung, Aktivitätsverlauf und Diagnosedaten wirken systemweit. Die
sind als solche gekennzeichnet, fragen vorher nach und laufen dann als einzelner
erhöhter Befehl hinter einer Windows-Abfrage. **Der Hub selbst läuft nie mit
Administratorrechten.** Ein Programm, das mit Windows startet und den ganzen Tag
erhöhte Rechte hält, ist ein deutlich schlechterer Tausch als eine Rückfrage pro
Aktion.

**Protokolliert wird synchron und angehängt.** Ein Protokoll, das beim Absturz seine
letzten Zeilen verliert, verliert genau den Teil, auf den es ankam. Die letzten
Einträge liegen zusätzlich im Speicher, damit der Diagnosebericht sie mitnehmen kann,
ohne eine Datei zu lesen, die gerade rotiert.

**Der Diagnosebericht entfernt persönliche Daten, bevor er sie zeigt.** Hintergrund-
bilder sind eingebettete Bilddaten von teils mehreren hundert Kilobyte und fliegen
raus, von Programmpfaden bleibt nur der Dateiname. Der Bericht ist zum Weitergeben
gedacht, er darf also weder deine Ordnerstruktur noch ein Megabyte Bildmaterial
enthalten.

**Die Konsole spricht das Protokoll, sie emuliert kein Terminal.**
`claude --print --input-format stream-json --output-format stream-json` hält einen
Prozess offen, der Nachrichten als JSON-Zeilen auf der Standardeingabe liest und
Ereignisse als JSON-Zeilen ausgibt. Das ist eine vollwertige programmierbare
Schnittstelle, weshalb kein Pseudo-Terminal nötig ist und damit auch kein natives
Modul, das je Electron-Version und Architektur neu übersetzt werden müsste. Die
Konsole ist ein echter Client dieses Protokolls, kein Abgreifen einer Terminalausgabe.

**Berechtigungen sind die sicherheitskritische Stelle.** Im Fenster kann nichts eine
Rückfrage beantworten, deshalb läuft die Sitzung mit `--permission-prompts none`:
alles, was nachfragen würde, wird abgelehnt. Was Claude darf, entscheidet allein der
gewählte Modus, und die drei Beschreibungen im Fenster sind gegen das tatsächliche
Verhalten geprüft. „Nur lesen" erlaubt auch suchende Befehle, nicht nur das Lesen von
Dateien; das steht so dort, weil sonst beim ersten Bash-Aufruf das Vertrauen weg wäre.

**Jede Sitzung verbraucht das Kontingent des angemeldeten Kontos.** Deshalb läuft
nichts von selbst, und die laufenden Kosten stehen dauerhaft in der Kopfzeile.

**Der Laufstatus fragt nur Prozessnamen ab, nicht die volle Prozessliste.** Die
Liste im Task-Manager holt Arbeitsspeicher, Prozessorzeit und Fenstertitel für jeden
Prozess und braucht dafür einige hundert Millisekunden. Für den Status genügt die
Frage, ob ein Name lebt, deshalb gibt es dafür eine eigene, deutlich billigere
Abfrage. Sie läuft nur, solange eine Ansicht sie tatsächlich anzeigt.

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

**Der Laufstatus braucht einen Prozessnamen.** Bei Programmen, die der Hub direkt
über eine exe startet, ergibt er sich von selbst. Bei Spielen über `steam://` gibt es
keinen Pfad, aus dem sich etwas ableiten ließe. Für Steam-Titel rät der Hub die
größte exe im Installationsverzeichnis, was meist stimmt, aber nicht immer. Trifft es
nicht zu, startest du das Spiel einmal und wählst den Prozess im Profil-Editor über
**wählen** aus der Liste der laufenden Prozesse. Einträge ohne Prozessnamen werden
gestrichelt dargestellt und als unbekannt behandelt, nicht als gestoppt.

**Das Hub-Kürzel kann kein Vollbild-Spiel überlagern.** Es holt das Fenster über
normale Fenster und über Spiele im randlosen Fenstermodus nach vorne. Im exklusiven
Vollbildmodus verweigert Windows das, dieselbe Grenze wie bei den Overlays. Das
Kürzel selbst wird trotzdem ausgelöst, du siehst nur nichts davon.

**Werkzeuge haben keinen Schalter, und das ist kein Versäumnis.** Geräte-Manager,
Ereignisanzeige, Datenträgerbereinigung und die anderen elf sind Programme, keine
Einstellungen. Sie sind im Katalog als Werkzeug gekennzeichnet, damit die fehlende
Schaltfläche als Absicht lesbar ist.

**Manche Änderungen greifen nicht sofort.** Alles was den Explorer betrifft braucht
dessen Neustart, den der Hub auf Wunsch übernimmt. Die Zeigerbeschleunigung greift
erst nach der nächsten Anmeldung, die GPU-Planung erst nach einem Neustart. Jeder
betroffene Eintrag sagt das direkt auf der Karte.

**Diagnosedaten lassen sich nicht ganz abschalten.** In Windows Home und Pro ist
„Erforderlich" die niedrigste Stufe, die Windows tatsächlich anwendet. Die Stufe 0
greift nur in Enterprise-Ausgaben, deshalb steht sie hier gar nicht erst zur Auswahl.

**Helligkeit externer Monitore hängt an DDC/CI.** Das ist ein Steuerkanal über das
Bildkabel, den viele Monitore beherrschen, aber längst nicht alle. Manche haben ihn
im eigenen Menü ab Werk deaktiviert, oft unter einem Namen wie „DDC/CI" oder
„Monitorsteuerung". Antwortet der Monitor nicht, zeigt der Hub das offen an statt
einen wirkungslosen Regler.

**Nachtmodus, HDR und Skalierung lassen sich nicht schalten.** Windows legt den
Nachtmodus in einem undokumentierten Binärformat ab, das sich zwischen Builds ändert,
und für HDR gibt es gar keine Schnittstelle. Der Hub öffnet dafür die passende
Windows-Seite, statt eine Steuerung vorzutäuschen.

**Bei mehreren Monitoren ist die Zuordnung der Helligkeit eine Vermutung.** DDC/CI
und die Anzeigegeräte werden von Windows getrennt aufgezählt, ohne gemeinsame
Kennung. Der Hub paart sie über die Reihenfolge. Bei einem Monitor stimmt das immer,
bei mehreren fast immer.

**Auflösungsänderungen sind das Riskanteste im ganzen Programm.** Deshalb wird jede
Änderung zuerst beim Treiber angefragt, und danach läuft im Hauptprozess ein Timer,
der nach fünfzehn Sekunden zurückstellt. Der Timer liegt bewusst nicht in der
Oberfläche: er muss auch dann auslösen, wenn vom Bildschirm nichts mehr zu sehen ist.

**Ein Kürzel kann von einem anderen Programm belegt sein.** Windows vergibt globale
Tastenkombinationen nach dem Prinzip „wer zuerst kommt". Der Hub meldet das beim
Setzen und behält die vorherige Belegung, statt stillschweigend nichts zu tun.

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
npm run test:ui # startet die App und bedient jede Ansicht
npm run check   # lint, test und test:ui zusammen
npm run pack    # baut ein entpacktes Verzeichnis statt eines Installers
```

Die Tests brauchen kein Windows. Ist eine PowerShell vorhanden, wird zusätzlich die
C#-Hilfsklasse für die Bildschirmsteuerung übersetzt. Die Win32-Aufrufe darin gibt es
außerhalb von Windows nicht, aber der Compiler muss den Quelltext trotzdem annehmen,
und ein Tippfehler würde sonst erst zur Laufzeit auffallen. Die GPU-Auswertung wird gegen aufgezeichnete
Zählerdaten geprüft, und wenn eine PowerShell vorhanden ist, werden zusätzlich alle
erzeugten Skripte von PowerShells eigenem Parser auf Syntaxfehler geprüft und die
JSON-Ausgabe gegen den Node-seitigen Parser gehalten. Ohne PowerShell wird dieser
Teil übersprungen; mit `PWSH_PATH` lässt sich ein Binary explizit angeben. Das ist
wichtig, weil ein Syntaxfehler in einem dieser Skripte unter Windows nicht abstürzt,
sondern nur ein leeres Ergebnis liefert.

### Oberflächentests

`npm run test:ui` startet die echte Anwendung in einem echten Electron, klickt sich
durch alle Ansichten und prüft, was dabei entsteht: dass die Profilkarten das gesäte
Testprofil zeigen, dass sich der Editor öffnen und folgenlos abbrechen lässt, dass die
Systemwerte sich tatsächlich bewegen, dass ein Overlay ein echtes Fenster aufmacht und
„Alle schließen" auch die Schalter zurücksetzt, dass jede Ansicht ein zweites Betreten
überlebt, und dass im Diagnosebericht kein Benutzername steht. Die Konfiguration liegt
dabei in einem Wegwerfverzeichnis; die eigene Einrichtung wird nicht angefasst.

Unter Linux wird `xvfb` benutzt, falls kein `DISPLAY` gesetzt ist. Fehlt beides, wird
der Lauf mit einem Hinweis übersprungen statt fehlzuschlagen. Windows-eigene Aufrufe
scheitern auf einem Linux-Rechner erwartungsgemäß — geprüft wird dort, dass die
Oberfläche das mit einem Hinweis beantwortet und nicht mit einer leeren Fläche. In der
CI läuft derselbe Durchlauf zusätzlich auf einem Windows-Runner, und das ist die einzige
Stelle, an der die Windows-Pfade wirklich ausgeführt werden.

Es gibt bewusst keinen Bundler. Der Renderer besteht aus nativen ES-Modulen, die der
Browser direkt lädt; eine Änderung ist nach `F5` sichtbar.

---

## Lizenz

MIT
