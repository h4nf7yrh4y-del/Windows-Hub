'use strict';

const { shell } = require('electron');
const { runPowerShell } = require('./processes');
const tweaks = require('./tweaks');

/**
 * Catalogue of Windows settings and tools that are useful and hard to find.
 *
 * Controls come in four shapes, chosen by what the setting actually is:
 *
 *   toggle    a per-user on/off value under HKCU. No elevation, reversible in
 *             one click.
 *   choice    a value with more than two meaningful states, such as where the
 *             Explorer opens or how much telemetry is sent.
 *   custom    a setting that is not a single value, like the classic Windows 11
 *             context menu, which is the presence or absence of a registry key.
 *   powerplan the active power scheme, read and set through powercfg.
 *
 * Anything writing outside HKCU is marked `elevated` and goes through a UAC
 * prompt for that one command. The hub itself never runs elevated: a launcher
 * that starts with Windows and holds administrator rights all day is a much
 * worse trade than a prompt per action.
 *
 * Tools such as the Device Manager or DirectX diagnostics have no switch by
 * nature. Opening them is the action, and they are labelled as tools so the
 * absence of a switch reads as intentional rather than missing.
 */

const IS_WIN = process.platform === 'win32';

const EXPLORER_ADVANCED = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
const GAME_STORE = 'HKCU:\\System\\GameConfigStore';
const PERSONALIZE = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
const CONTEXT_MENU_CLSID = '{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}';

const CATALOGUE = [
  /* ------------------------------------------------------------- Spielen */
  {
    id: 'game-mode',
    category: 'Spielen',
    name: 'Spielmodus',
    description: 'Windows priorisiert das Spiel im Vordergrund und schiebt Hintergrundaufgaben wie Updates zurück.',
    hint: 'In der Regel eingeschaltet lassen. Auf sehr starken Rechnern ist der Unterschied klein.',
    open: 'ms-settings:gaming-gamemode',
    control: { kind: 'toggle', path: 'HKCU:\\Software\\Microsoft\\GameBar', name: 'AutoGameModeEnabled', on: 1, off: 0 }
  },
  {
    id: 'game-dvr',
    category: 'Spielen',
    name: 'Hintergrundaufzeichnung der Xbox Game Bar',
    description: 'Nimmt dauerhaft die letzten Minuten mit, damit man sie nachträglich speichern kann.',
    hint: 'Kostet dauerhaft Leistung. Abschalten, wenn du die Funktion nie nutzt.',
    open: 'ms-settings:gaming-gamedvr',
    control: { kind: 'toggle', path: GAME_STORE, name: 'GameDVR_Enabled', on: 1, off: 0 }
  },
  {
    id: 'gpu-scheduling',
    category: 'Spielen',
    name: 'Hardwarebeschleunigte GPU-Planung',
    description: 'Lässt die Grafikkarte ihren eigenen Speicher verwalten statt Windows. Kann Eingabeverzögerung leicht senken.',
    hint: 'Wirkt systemweit, deshalb die Administrator-Abfrage. Greift erst nach einem Neustart.',
    open: 'ms-settings:display-advancedgraphics',
    needs: 'reboot',
    control: {
      kind: 'toggle',
      path: 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers',
      name: 'HwSchMode', on: 2, off: 1, elevated: true
    }
  },
  {
    id: 'power-plan',
    category: 'Spielen',
    name: 'Energieplan',
    description: 'Bestimmt, wie aggressiv der Prozessor heruntertaktet. „Höchstleistung" hält Takt und Latenz stabil.',
    hint: 'Auf Notebooks kostet das spürbar Akkulaufzeit. Der Plan „Ultimative Leistung" ist ab Werk versteckt und lässt sich unten freischalten.',
    open: { type: 'shell', target: 'powercfg.cpl' },
    control: { kind: 'powerplan' },
    action: 'unlock-ultimate',
    actionLabel: 'Ultimative Leistung freischalten'
  },
  {
    id: 'mouse-acceleration',
    category: 'Spielen',
    name: 'Zeigerbeschleunigung',
    description: 'Windows bewegt den Zeiger weiter, je schneller du die Maus bewegst. Für Zielen in Spielen unerwünscht.',
    hint: 'Heißt in den Windows-Einstellungen „Zeigergenauigkeit verbessern". Greift nach der nächsten Anmeldung.',
    open: 'ms-settings:mousetouchpad',
    needs: 'signout',
    control: { kind: 'toggle', path: 'HKCU:\\Control Panel\\Mouse', name: 'MouseSpeed', on: 1, off: 0, type: 'String' }
  },
  {
    id: 'sticky-keys',
    category: 'Spielen',
    name: 'Nachfrage der Einrastfunktion',
    description: 'Der Dialog, der nach fünfmal Umschalt erscheint und mitten im Spiel den Fokus nimmt.',
    hint: 'Abschalten deaktiviert nur die Nachfrage, nicht die Bedienhilfe selbst.',
    open: 'ms-settings:easeofaccess-keyboard',
    control: {
      kind: 'toggle',
      path: 'HKCU:\\Control Panel\\Accessibility\\StickyKeys',
      name: 'Flags', on: '510', off: '506', type: 'String'
    }
  },
  {
    id: 'graphics-preference',
    category: 'Spielen',
    name: 'Grafikeinstellungen pro Programm',
    description: 'Legt fest, welche Grafikkarte ein einzelnes Programm benutzt. Auf Notebooks der Hebel gegen ruckelnde Spiele.',
    hint: 'Wird pro Programm gesetzt, es gibt also keinen einzelnen Schalter dafür.',
    open: 'ms-settings:display-advancedgraphics'
  },

  /* ------------------------------------------------------------ Explorer */
  {
    id: 'file-extensions',
    category: 'Explorer',
    name: 'Dateiendungen anzeigen',
    description: 'Zeigt .exe, .txt und so weiter im Dateinamen an.',
    hint: 'Sicherheitsrelevant: ohne Endungen sieht „Rechnung.pdf.exe" wie ein PDF aus.',
    needs: 'explorer',
    control: { kind: 'toggle', path: EXPLORER_ADVANCED, name: 'HideFileExt', on: 0, off: 1 }
  },
  {
    id: 'hidden-files',
    category: 'Explorer',
    name: 'Versteckte Dateien anzeigen',
    description: 'Blendet Ordner wie AppData und ProgramData ein.',
    needs: 'explorer',
    control: { kind: 'toggle', path: EXPLORER_ADVANCED, name: 'Hidden', on: 1, off: 2 }
  },
  {
    id: 'classic-context-menu',
    category: 'Explorer',
    name: 'Klassisches Kontextmenü',
    description: 'Bringt unter Windows 11 das vollständige Rechtsklick-Menü zurück, ohne den Umweg über „Weitere Optionen".',
    hint: 'Setzt einen Eintrag unter HKCU und ist jederzeit zurücknehmbar. Unter Windows 10 wirkungslos.',
    needs: 'explorer',
    control: { kind: 'custom', id: 'classic-context-menu' }
  },
  {
    id: 'launch-to',
    category: 'Explorer',
    name: 'Explorer öffnet mit',
    description: 'Welche Ansicht beim Öffnen eines Explorer-Fensters erscheint.',
    needs: 'explorer',
    control: {
      kind: 'choice', path: EXPLORER_ADVANCED, name: 'LaunchTo',
      options: [
        { value: 1, label: 'Dieser PC' },
        { value: 2, label: 'Schnellzugriff' },
        { value: 3, label: 'Downloads' }
      ]
    }
  },
  {
    id: 'clipboard-history',
    category: 'Explorer',
    name: 'Zwischenablage-Verlauf',
    description: 'Merkt sich die letzten kopierten Inhalte. Aufrufbar mit Windows-Taste und V.',
    hint: 'Eine der nützlichsten Funktionen, die kaum jemand kennt.',
    open: 'ms-settings:clipboard',
    control: { kind: 'toggle', path: 'HKCU:\\Software\\Microsoft\\Clipboard', name: 'EnableClipboardHistory', on: 1, off: 0 }
  },
  {
    id: 'dark-mode',
    category: 'Explorer',
    name: 'Dunkles Design für Apps',
    description: 'Schaltet Explorer, Einstellungen und viele Programme auf dunkel.',
    needs: 'explorer',
    control: { kind: 'toggle', path: PERSONALIZE, name: 'AppsUseLightTheme', on: 0, off: 1 }
  },
  {
    id: 'transparency',
    category: 'Explorer',
    name: 'Transparenzeffekte',
    description: 'Die Milchglasoptik von Startmenü und Taskleiste.',
    hint: 'Abschalten bringt auf schwachen Rechnern spürbar flüssigere Menüs.',
    control: { kind: 'toggle', path: PERSONALIZE, name: 'EnableTransparency', on: 1, off: 0 }
  },
  {
    id: 'god-mode',
    category: 'Explorer',
    name: 'God Mode',
    description: 'Ein Ordner, der alle rund 200 Systemsteuerungs-Einträge auf einer Seite auflistet.',
    hint: 'Kein Hack, sondern eine dokumentierte Ordner-Kennung. Legt eine Verknüpfung auf dem Desktop an.',
    action: 'godmode',
    actionLabel: 'Auf dem Desktop anlegen'
  },

  /* ----------------------------------------------------------- Taskleiste */
  {
    id: 'taskbar-align',
    category: 'Taskleiste',
    name: 'Symbole linksbündig',
    description: 'Stellt die Taskleiste unter Windows 11 von mittig auf links, wie in Windows 10.',
    needs: 'explorer',
    control: {
      kind: 'choice', path: EXPLORER_ADVANCED, name: 'TaskbarAl',
      options: [{ value: 0, label: 'Links' }, { value: 1, label: 'Mittig' }]
    }
  },
  {
    id: 'taskbar-widgets',
    category: 'Taskleiste',
    name: 'Widgets',
    description: 'Das Wetter- und Nachrichtenfeld in der Taskleiste.',
    hint: 'Läuft dauerhaft im Hintergrund und lädt Inhalte nach.',
    needs: 'explorer',
    control: { kind: 'toggle', path: EXPLORER_ADVANCED, name: 'TaskbarDa', on: 1, off: 0 }
  },
  {
    id: 'taskview-button',
    category: 'Taskleiste',
    name: 'Task-Ansicht-Schaltfläche',
    description: 'Die Schaltfläche für virtuelle Desktops. Die Tastenkombination funktioniert weiterhin.',
    needs: 'explorer',
    control: { kind: 'toggle', path: EXPLORER_ADVANCED, name: 'ShowTaskViewButton', on: 1, off: 0 }
  },
  {
    id: 'search-box',
    category: 'Taskleiste',
    name: 'Suchfeld',
    description: 'Wie viel Platz die Suche in der Taskleiste einnimmt.',
    needs: 'explorer',
    control: {
      kind: 'choice',
      path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Search',
      name: 'SearchboxTaskbarMode',
      options: [
        { value: 0, label: 'Ausgeblendet' },
        { value: 1, label: 'Nur Symbol' },
        { value: 2, label: 'Volles Feld' }
      ]
    }
  },
  {
    id: 'recent-apps',
    category: 'Taskleiste',
    name: 'Zuletzt hinzugefügte Apps im Startmenü',
    description: 'Die Liste frisch installierter Programme oben im Startmenü.',
    needs: 'explorer',
    control: { kind: 'toggle', path: EXPLORER_ADVANCED, name: 'Start_TrackProgs', on: 1, off: 0 }
  },

  /* --------------------------------------------------------- Datenschutz */
  {
    id: 'advertising-id',
    category: 'Datenschutz',
    name: 'Werbe-ID',
    description: 'Eine Kennung, mit der Apps geräteübergreifend Werbeprofile bilden.',
    open: 'ms-settings:privacy-general',
    control: {
      kind: 'toggle',
      path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo',
      name: 'Enabled', on: 1, off: 0
    }
  },
  {
    id: 'web-search',
    category: 'Datenschutz',
    name: 'Websuche im Startmenü',
    description: 'Schickt beim Tippen im Startmenü jede Eingabe an Bing.',
    hint: 'Abschalten macht die lokale Suche zusätzlich spürbar schneller.',
    needs: 'explorer',
    control: {
      kind: 'toggle',
      path: 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\Explorer',
      name: 'DisableSearchBoxSuggestions', on: 0, off: 1
    }
  },
  {
    id: 'toast-notifications',
    category: 'Datenschutz',
    name: 'Benachrichtigungen',
    description: 'Die Einblendungen unten rechts. Aus, wenn beim Spielen nichts stören soll.',
    hint: 'Für zeitlich begrenzte Ruhe ist der Fokus-Assistent die bessere Wahl.',
    open: 'ms-settings:notifications',
    control: {
      kind: 'toggle',
      path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications',
      name: 'ToastEnabled', on: 1, off: 0
    }
  },
  {
    id: 'activity-history',
    category: 'Datenschutz',
    name: 'Aktivitätsverlauf',
    description: 'Welche Apps und Dateien du benutzt hast, für die Zeitleiste und die Synchronisierung.',
    hint: 'Eine systemweite Richtlinie, daher die Administrator-Abfrage.',
    open: 'ms-settings:privacy-activityhistory',
    control: {
      kind: 'toggle',
      path: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\System',
      name: 'PublishUserActivities', on: 1, off: 0, elevated: true
    }
  },
  {
    id: 'diagnostics',
    category: 'Datenschutz',
    name: 'Diagnosedaten',
    description: 'Umfang der Telemetrie, die an Microsoft geht.',
    hint: 'In Windows Home und Pro ist „Erforderlich" die niedrigste Stufe, die tatsächlich greift. Ganz aus geht nur in Enterprise.',
    open: 'ms-settings:privacy-feedback',
    control: {
      kind: 'choice',
      path: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection',
      name: 'AllowTelemetry',
      elevated: true,
      options: [
        { value: 1, label: 'Erforderlich' },
        { value: 2, label: 'Erweitert' },
        { value: 3, label: 'Vollständig' }
      ]
    }
  },
  {
    id: 'app-permissions',
    category: 'Datenschutz',
    name: 'App-Berechtigungen',
    description: 'Welche Programme an Kamera, Mikrofon, Standort und Dateien dürfen.',
    hint: 'Wird pro App und Berechtigung gesetzt, dafür gibt es keinen Sammelschalter.',
    open: 'ms-settings:privacy-microphone'
  },

  /* --------------------------------------------------------------- System */
  {
    id: 'storage-sense',
    category: 'System',
    name: 'Speicheroptimierung',
    description: 'Räumt temporäre Dateien und den Papierkorb automatisch auf.',
    hint: 'Sinnvoll auf kleinen SSDs. Prüfe die Aufbewahrungsfristen in den Windows-Einstellungen, bevor du es einschaltest.',
    open: 'ms-settings:storagesense',
    control: {
      kind: 'toggle',
      path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy',
      name: '01', on: 1, off: 0
    }
  },
  {
    id: 'startup-apps',
    category: 'System',
    name: 'Autostart-Apps',
    description: 'Die Windows-eigene Übersicht mit Bewertung der Startauswirkung.',
    hint: 'Der Hub zeigt dieselben Einträge unter Tasks, dort auch die aus der Registry.',
    open: 'ms-settings:startupapps'
  },
  {
    id: 'optional-features',
    category: 'System',
    name: 'Windows-Features',
    description: 'Hyper-V, Windows-Sandbox, WSL, .NET-Versionen und weitere Bestandteile an- und abschalten.',
    tool: true,
    open: { type: 'shell', target: 'optionalfeatures.exe' }
  },
  {
    id: 'device-manager',
    category: 'System',
    name: 'Geräte-Manager',
    description: 'Treiberstatus, fehlende Geräte, Hardware-Konflikte.',
    tool: true,
    open: { type: 'shell', target: 'devmgmt.msc' }
  },
  {
    id: 'system-info',
    category: 'System',
    name: 'Systeminformationen',
    description: 'Vollständige Hardware- und Treiberübersicht, inklusive BIOS-Version und Virtualisierungsstatus.',
    tool: true,
    open: { type: 'shell', target: 'msinfo32.exe' }
  },
  {
    id: 'dxdiag',
    category: 'System',
    name: 'DirectX-Diagnose',
    description: 'Grafik-, Sound- und Eingabegeräte mit Treiberdaten. Der Standardbericht für Spiele-Support.',
    tool: true,
    open: { type: 'shell', target: 'dxdiag.exe' }
  },

  /* -------------------------------------------------------------- Wartung */
  {
    id: 'reliability',
    category: 'Wartung',
    name: 'Zuverlässigkeitsverlauf',
    description: 'Zeitachse aller Abstürze, Bluescreens und fehlgeschlagenen Updates der letzten Wochen.',
    hint: 'Die mit Abstand beste Anlaufstelle, wenn der PC „seit letzter Woche komisch" ist. Kennt fast niemand.',
    tool: true,
    open: { type: 'shell', target: 'perfmon.exe', args: ['/rel'] }
  },
  {
    id: 'event-viewer',
    category: 'Wartung',
    name: 'Ereignisanzeige',
    description: 'Das vollständige Systemprotokoll. Detaillierter als der Zuverlässigkeitsverlauf, aber auch unübersichtlicher.',
    tool: true,
    open: { type: 'shell', target: 'eventvwr.msc' }
  },
  {
    id: 'disk-cleanup',
    category: 'Wartung',
    name: 'Datenträgerbereinigung',
    description: 'Entfernt Update-Reste, alte Windows-Installationen und temporäre Dateien.',
    hint: 'Über „Systemdateien bereinigen" wird meist zweistellig viel Speicher frei.',
    tool: true,
    open: { type: 'shell', target: 'cleanmgr.exe' }
  },
  {
    id: 'resource-monitor',
    category: 'Wartung',
    name: 'Ressourcenmonitor',
    description: 'Zeigt, welcher Prozess gerade welche Datei liest und welche Netzwerkverbindung offen hat.',
    hint: 'Beantwortet die Frage „warum rattert meine Festplatte", die der Task-Manager offen lässt.',
    tool: true,
    open: { type: 'shell', target: 'resmon.exe' }
  },
  {
    id: 'memory-diagnostic',
    category: 'Wartung',
    name: 'Speicherdiagnose',
    description: 'Prüft den Arbeitsspeicher auf Fehler. Läuft beim nächsten Neustart.',
    hint: 'Erste Maßnahme bei zufälligen Bluescreens ohne erkennbares Muster.',
    tool: true,
    open: { type: 'shell', target: 'mdsched.exe' }
  },
  {
    id: 'windows-update',
    category: 'Wartung',
    name: 'Windows Update',
    description: 'Updates und der Verlauf bereits installierter Aktualisierungen.',
    tool: true,
    open: 'ms-settings:windowsupdate'
  },
  {
    id: 'recovery',
    category: 'Wartung',
    name: 'Wiederherstellung',
    description: 'Systemwiederherstellungspunkte, Zurücksetzen und die erweiterten Startoptionen.',
    tool: true,
    open: 'ms-settings:recovery'
  }
];

/* ------------------------------------------------------------ PowerShell */

function esc(value) {
  return String(value).replace(/'/g, "''");
}

function regType(control) {
  return control.type === 'String' ? 'String' : 'DWord';
}

function regValue(control, value) {
  return control.type === 'String' ? `'${esc(value)}'` : String(Number(value));
}

/**
 * Runs one command with administrator rights.
 *
 * The elevated part is a separate short-lived process behind a UAC prompt, so
 * the hub keeps running unprivileged. Cancelling the prompt makes Start-Process
 * throw, which surfaces as a plain "cancelled" rather than a silent no-op.
 */
async function runElevated(innerScript) {
  const encoded = Buffer.from(innerScript, 'utf16le').toString('base64');
  // Built as a variable rather than a continued line: PowerShell's backtick
  // continuation is easy to misread and breaks naive script extraction.
  const out = await runPowerShell(`
$ErrorActionPreference = "Stop"
$arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}')
try {
  $proc = Start-Process -FilePath "powershell.exe" -Verb RunAs -WindowStyle Hidden -PassThru -Wait -ArgumentList $arguments
  if ($proc.ExitCode -ne 0) { "EXIT:" + $proc.ExitCode } else { "OK" }
} catch {
  "CANCELLED"
}
`, 120000);

  const text = (out || '').trim();
  if (/^OK$/m.test(text)) return { ok: true };
  if (/CANCELLED/.test(text)) throw new Error('Die Administrator-Abfrage wurde abgebrochen');
  const code = /EXIT:(-?\d+)/.exec(text);
  throw new Error(`Die Änderung schlug fehl${code ? ` (Code ${code[1]})` : ''}`);
}

/* --------------------------------------------------------------- reading */

const CLASSIC_MENU_PATH = `HKCU:\\Software\\Classes\\CLSID\\${CONTEXT_MENU_CLSID}\\InprocServer32`;

function readableEntries() {
  return CATALOGUE
    .map((entry) => ({ entry, control: entry.control }))
    .filter((x) => x.control && (x.control.kind === 'toggle' || x.control.kind === 'choice'));
}

async function readStates() {
  if (!IS_WIN) return { values: {}, powerPlans: null, classicMenu: null };

  const targets = readableEntries();
  const lines = targets.map(({ entry, control }) =>
    `  [PSCustomObject]@{ id = '${esc(entry.id)}'; value = (Get-ItemProperty -LiteralPath '${esc(control.path)}' -Name '${esc(control.name)}' -ErrorAction SilentlyContinue).'${esc(control.name)}' }`);

  // The registry reads are fast; the power schemes are not, and they live in
  // tweaks where they are cached and shared with the profile editor. Keeping
  // them out of this script is the difference between a catalogue that appears
  // at once and one that waits on WMI.
  const script = `
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$values = @(
${lines.join('\n')}
)

$classic = Test-Path -LiteralPath '${esc(CLASSIC_MENU_PATH)}'

[PSCustomObject]@{ values = $values; classic = $classic } | ConvertTo-Json -Compress -Depth 4
`;

  const plansPromise = tweaks.listPowerPlans().catch(() => []);

  try {
    const out = await runPowerShell(script, 30000);
    const trimmed = (out || '').trim();
    if (!trimmed) return { values: {}, powerPlans: await plansPromise, classicMenu: null };
    const parsed = JSON.parse(trimmed);

    const values = {};
    const rows = Array.isArray(parsed.values) ? parsed.values : (parsed.values ? [parsed.values] : []);
    for (const row of rows) {
      if (row && row.id) values[row.id] = row.value === undefined ? null : row.value;
    }

    return { values, powerPlans: await plansPromise, classicMenu: !!parsed.classic };
  } catch (_) {
    return { values: {}, powerPlans: await plansPromise.catch(() => []), classicMenu: null };
  }
}

function describeControl(entry, states) {
  const control = entry.control;
  if (!control) return null;

  if (control.kind === 'powerplan') {
    const plans = states.powerPlans || [];
    return {
      kind: 'choice',
      elevated: false,
      options: plans.map((p) => ({ value: p.guid, label: p.label })),
      value: (plans.find((p) => p.active) || {}).guid || null
    };
  }

  if (control.kind === 'custom') {
    return { kind: 'toggle', elevated: false, value: states.classicMenu === null ? null : !!states.classicMenu };
  }

  const raw = states.values[entry.id];
  const missing = raw === null || raw === undefined;

  if (control.kind === 'choice') {
    return {
      kind: 'choice',
      elevated: !!control.elevated,
      options: control.options,
      // An absent value means Windows is on its default, which is not
      // necessarily any of the listed options.
      value: missing ? null : (control.type === 'String' ? String(raw) : Number(raw))
    };
  }

  const current = control.type === 'String' ? String(raw) : Number(raw);
  return {
    kind: 'toggle',
    elevated: !!control.elevated,
    value: missing ? null : current === (control.type === 'String' ? String(control.on) : Number(control.on))
  };
}

async function list() {
  const states = await readStates();

  const items = CATALOGUE.map((entry) => ({
    id: entry.id,
    category: entry.category,
    name: entry.name,
    description: entry.description,
    hint: entry.hint || null,
    tool: !!entry.tool,
    canOpen: !!entry.open,
    action: entry.action || null,
    actionLabel: entry.actionLabel || null,
    needs: entry.needs || null,
    control: describeControl(entry, states)
  }));

  const categories = [];
  for (const item of items) {
    if (!categories.includes(item.category)) categories.push(item.category);
  }

  return { supported: IS_WIN, items, categories };
}

/* --------------------------------------------------------------- writing */

function find(id) {
  const entry = CATALOGUE.find((e) => e.id === id);
  if (!entry) throw new Error(`Unbekannter Eintrag: ${id}`);
  return entry;
}

async function writeRegistry(control, value) {
  const script = `
$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath '${esc(control.path)}')) { New-Item -Path '${esc(control.path)}' -Force | Out-Null }
Set-ItemProperty -LiteralPath '${esc(control.path)}' -Name '${esc(control.name)}' -Value ${regValue(control, value)} -Type ${regType(control)} -Force
`;
  if (control.elevated) return runElevated(script);
  await runPowerShell(script, 25000);
  return { ok: true };
}

async function setClassicContextMenu(enabled) {
  const script = enabled
    ? `
$ErrorActionPreference = "Stop"
New-Item -Path '${esc(CLASSIC_MENU_PATH)}' -Force | Out-Null
Set-ItemProperty -LiteralPath '${esc(CLASSIC_MENU_PATH)}' -Name '(Default)' -Value '' -Force
`
    : `
$ErrorActionPreference = "Stop"
$key = 'HKCU:\\Software\\Classes\\CLSID\\${CONTEXT_MENU_CLSID}'
if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force }
`;
  await runPowerShell(script, 25000);
  return { ok: true };
}

/**
 * Delegated so the cached scheme list is dropped in the same place it is
 * filled. Switching the plan here and reading a stale "active" flag over
 * there would be a bug nobody would look for.
 */
async function setPowerPlan(guid) {
  await tweaks.setPowerPlan(guid);
  return { ok: true, guid };
}

/** Sets a toggle or a choice, whichever the entry declares. */
async function setControl(id, value) {
  const entry = find(id);
  const control = entry.control;
  if (!control) throw new Error(`${entry.name} hat keinen Schalter`);

  if (control.kind === 'powerplan') {
    if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');
    await setPowerPlan(value);
    return { ok: true, id, needs: entry.needs || null };
  }

  if (control.kind === 'custom') {
    if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');
    await setClassicContextMenu(!!value);
    return { ok: true, id, needs: entry.needs || null };
  }

  if (control.kind === 'choice') {
    const allowed = control.options.map((o) => String(o.value));
    if (!allowed.includes(String(value))) throw new Error(`Ungültiger Wert für ${entry.name}`);
    if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');
    await writeRegistry(control, value);
    return { ok: true, id, needs: entry.needs || null, elevated: !!control.elevated };
  }

  // toggle
  const target = value ? control.on : control.off;
  if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');
  await writeRegistry(control, target);
  return { ok: true, id, enabled: !!value, needs: entry.needs || null, elevated: !!control.elevated };
}

async function open(id) {
  const entry = find(id);
  if (!entry.open) throw new Error(`${entry.name} hat keine eigene Seite`);
  if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');

  if (typeof entry.open === 'string') {
    await shell.openExternal(entry.open);
    return { ok: true, id };
  }

  const args = (entry.open.args || []).map((a) => `"${String(a).replace(/"/g, '')}"`).join(', ');
  const argumentList = args ? ` -ArgumentList ${args}` : '';
  const target = String(entry.open.target).replace(/"/g, '');

  await runPowerShell(`
$ErrorActionPreference = "Stop"
Start-Process -FilePath "${target}"${argumentList}
`, 15000);
  return { ok: true, id };
}

async function restartExplorer() {
  if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');
  await runPowerShell(`
$ErrorActionPreference = "SilentlyContinue"
Stop-Process -Name explorer -Force
Start-Sleep -Milliseconds 800
if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
`, 25000);
  return { ok: true };
}

const ACTIONS = {
  godmode: {
    script: `
$ErrorActionPreference = "Stop"
$desktop = [Environment]::GetFolderPath('Desktop')
$target = Join-Path $desktop 'Alle Einstellungen.{ED7BA470-8E54-465E-825C-99712043E01C}'
if (-not (Test-Path -LiteralPath $target)) { New-Item -Path $target -ItemType Directory | Out-Null }
`,
    message: 'Ordner „Alle Einstellungen" liegt auf dem Desktop'
  },
  'unlock-ultimate': {
    // The scheme ships with Windows but is hidden; duplicating the built-in
    // GUID makes it appear in the list.
    script: `
$ErrorActionPreference = "SilentlyContinue"
powercfg -duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61 | Out-Null
`,
    message: 'Energieplan „Ultimative Leistung" steht jetzt zur Auswahl'
  }
};

async function runAction(id) {
  const entry = find(id);
  const action = ACTIONS[entry.action];
  if (!action) throw new Error(`Unbekannte Aktion für ${id}`);
  if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');
  await runPowerShell(action.script, 30000);
  return { ok: true, id, message: action.message };
}

module.exports = {
  list, setControl, open, restartExplorer, runAction,
  CATALOGUE, ACTIONS, CLASSIC_MENU_PATH, esc, regType, regValue
};
