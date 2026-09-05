'use strict';

const { shell } = require('electron');
const { runPowerShell } = require('./processes');

/**
 * A curated catalogue of Windows settings and tools that are genuinely useful
 * and genuinely hard to find.
 *
 * Two deliberate limits keep this from turning into a registry editor with a
 * nice skin:
 *
 *   Toggles only ever write under HKCU. Those are per-user, need no elevation
 *   and are trivially reversible. Anything under HKLM, anything that changes
 *   how the machine boots, and anything that needs a driver reload is
 *   read-only here with a link to the Windows page that owns it.
 *
 *   Every entry says what it actually does. A switch whose effect the user
 *   cannot predict is worse than no switch.
 */

const IS_WIN = process.platform === 'win32';

const EXPLORER_ADVANCED = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';

const CATALOGUE = [
  /* ------------------------------------------------------------- Gaming */
  {
    id: 'game-mode',
    category: 'Spielen',
    name: 'Spielmodus',
    description: 'Windows priorisiert das Spiel im Vordergrund und schiebt Hintergrundaufgaben wie Updates zurück.',
    hint: 'In der Regel eingeschaltet lassen. Auf sehr starken Rechnern ist der Unterschied klein.',
    open: 'ms-settings:gaming-gamemode',
    toggle: { path: 'HKCU:\\Software\\Microsoft\\GameBar', name: 'AutoGameModeEnabled', on: 1, off: 0 }
  },
  {
    id: 'game-dvr',
    category: 'Spielen',
    name: 'Hintergrundaufzeichnung der Xbox Game Bar',
    description: 'Nimmt dauerhaft die letzten Minuten mit, damit man sie nachträglich speichern kann.',
    hint: 'Kostet dauerhaft Leistung. Abschalten, wenn du die Funktion nie nutzt.',
    open: 'ms-settings:gaming-gamedvr',
    toggle: { path: 'HKCU:\\System\\GameConfigStore', name: 'GameDVR_Enabled', on: 1, off: 0 }
  },
  {
    id: 'gpu-scheduling',
    category: 'Spielen',
    name: 'Hardwarebeschleunigte GPU-Planung',
    description: 'Lässt die Grafikkarte ihren eigenen Speicher verwalten statt Windows. Kann Eingabeverzögerung leicht senken.',
    hint: 'Braucht Administratorrechte und einen Neustart, deshalb hier nur ablesbar.',
    open: 'ms-settings:display-advancedgraphics',
    read: { path: 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', name: 'HwSchMode', on: 2 },
    readOnly: true
  },
  {
    id: 'graphics-preference',
    category: 'Spielen',
    name: 'Grafikeinstellungen pro Programm',
    description: 'Legt fest, welche Grafikkarte ein einzelnes Programm benutzt. Auf Notebooks der Hebel gegen ruckelnde Spiele.',
    open: 'ms-settings:display-advancedgraphics'
  },
  {
    id: 'power-plan',
    category: 'Spielen',
    name: 'Energieplan',
    description: 'Bestimmt, wie aggressiv der Prozessor heruntertaktet. „Höchstleistung" hält Takt und Latenz stabil.',
    hint: 'Auf Notebooks kostet das spürbar Akkulaufzeit.',
    open: { type: 'shell', target: 'powercfg.cpl' }
  },

  /* ------------------------------------------------------------ Explorer */
  {
    id: 'file-extensions',
    category: 'Explorer',
    name: 'Dateiendungen anzeigen',
    description: 'Zeigt .exe, .txt und so weiter im Dateinamen an.',
    hint: 'Sicherheitsrelevant: ohne Endungen sieht „Rechnung.pdf.exe" wie ein PDF aus.',
    toggle: { path: EXPLORER_ADVANCED, name: 'HideFileExt', on: 0, off: 1 },
    needs: 'explorer'
  },
  {
    id: 'hidden-files',
    category: 'Explorer',
    name: 'Versteckte Dateien anzeigen',
    description: 'Blendet Ordner wie AppData und ProgramData ein.',
    toggle: { path: EXPLORER_ADVANCED, name: 'Hidden', on: 1, off: 2 },
    needs: 'explorer'
  },
  {
    id: 'clipboard-history',
    category: 'Explorer',
    name: 'Zwischenablage-Verlauf',
    description: 'Merkt sich die letzten kopierten Inhalte. Aufrufbar mit Windows-Taste und V.',
    hint: 'Eine der nützlichsten Funktionen, die kaum jemand kennt.',
    open: 'ms-settings:clipboard',
    toggle: { path: 'HKCU:\\Software\\Microsoft\\Clipboard', name: 'EnableClipboardHistory', on: 1, off: 0 }
  },
  {
    id: 'dark-mode',
    category: 'Explorer',
    name: 'Dunkles Design für Apps',
    description: 'Schaltet Explorer, Einstellungen und viele Programme auf dunkel.',
    toggle: {
      path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
      name: 'AppsUseLightTheme', on: 0, off: 1
    },
    needs: 'explorer'
  },
  {
    id: 'transparency',
    category: 'Explorer',
    name: 'Transparenzeffekte',
    description: 'Die Milchglasoptik von Startmenü und Taskleiste.',
    hint: 'Abschalten bringt auf schwachen Rechnern spürbar flüssigere Menüs.',
    toggle: {
      path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
      name: 'EnableTransparency', on: 1, off: 0
    }
  },
  {
    id: 'god-mode',
    category: 'Explorer',
    name: 'God Mode',
    description: 'Ein Ordner, der alle rund 200 Systemsteuerungs-Einträge auf einer Seite auflistet.',
    hint: 'Kein Hack, sondern eine dokumentierte Ordner-Kennung. Legt eine Verknüpfung auf dem Desktop an.',
    action: 'godmode'
  },

  /* ----------------------------------------------------------- Datenschutz */
  {
    id: 'advertising-id',
    category: 'Datenschutz',
    name: 'Werbe-ID',
    description: 'Eine Kennung, mit der Apps geräteübergreifend Werbeprofile bilden.',
    open: 'ms-settings:privacy-general',
    toggle: {
      path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo',
      name: 'Enabled', on: 1, off: 0
    }
  },
  {
    id: 'activity-history',
    category: 'Datenschutz',
    name: 'Aktivitätsverlauf',
    description: 'Welche Apps und Dateien du benutzt hast, für die Zeitleiste und die Synchronisierung.',
    open: 'ms-settings:privacy-activityhistory'
  },
  {
    id: 'diagnostics',
    category: 'Datenschutz',
    name: 'Diagnosedaten',
    description: 'Umfang der Telemetrie, die an Microsoft geht.',
    open: 'ms-settings:privacy-feedback'
  },
  {
    id: 'app-permissions',
    category: 'Datenschutz',
    name: 'App-Berechtigungen',
    description: 'Welche Programme an Kamera, Mikrofon, Standort und Dateien dürfen.',
    open: 'ms-settings:privacy-microphone'
  },

  /* --------------------------------------------------------------- System */
  {
    id: 'storage-sense',
    category: 'System',
    name: 'Speicheroptimierung',
    description: 'Räumt temporäre Dateien und den Papierkorb automatisch auf.',
    hint: 'Sinnvoll auf kleinen SSDs. Prüfe die Aufbewahrungsfristen, bevor du es einschaltest.',
    open: 'ms-settings:storagesense'
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
    open: { type: 'shell', target: 'optionalfeatures.exe' }
  },
  {
    id: 'device-manager',
    category: 'System',
    name: 'Geräte-Manager',
    description: 'Treiberstatus, fehlende Geräte, Hardware-Konflikte.',
    open: { type: 'shell', target: 'devmgmt.msc' }
  },
  {
    id: 'system-info',
    category: 'System',
    name: 'Systeminformationen',
    description: 'Vollständige Hardware- und Treiberübersicht, inklusive BIOS-Version und Virtualisierungsstatus.',
    open: { type: 'shell', target: 'msinfo32.exe' }
  },
  {
    id: 'dxdiag',
    category: 'System',
    name: 'DirectX-Diagnose',
    description: 'Grafik-, Sound- und Eingabegeräte mit Treiberdaten. Der Standardbericht für Spiele-Support.',
    open: { type: 'shell', target: 'dxdiag.exe' }
  },

  /* -------------------------------------------------------------- Wartung */
  {
    id: 'reliability',
    category: 'Wartung',
    name: 'Zuverlässigkeitsverlauf',
    description: 'Zeitachse aller Abstürze, Bluescreens und fehlgeschlagenen Updates der letzten Wochen.',
    hint: 'Die mit Abstand beste Anlaufstelle, wenn der PC „seit letzter Woche komisch" ist. Kennt fast niemand.',
    open: { type: 'shell', target: 'perfmon.exe', args: ['/rel'] }
  },
  {
    id: 'event-viewer',
    category: 'Wartung',
    name: 'Ereignisanzeige',
    description: 'Das vollständige Systemprotokoll. Detaillierter als der Zuverlässigkeitsverlauf, aber auch unübersichtlicher.',
    open: { type: 'shell', target: 'eventvwr.msc' }
  },
  {
    id: 'disk-cleanup',
    category: 'Wartung',
    name: 'Datenträgerbereinigung',
    description: 'Entfernt Update-Reste, alte Windows-Installationen und temporäre Dateien.',
    hint: 'Über „Systemdateien bereinigen" wird meist zweistellig viel Speicher frei.',
    open: { type: 'shell', target: 'cleanmgr.exe' }
  },
  {
    id: 'resource-monitor',
    category: 'Wartung',
    name: 'Ressourcenmonitor',
    description: 'Zeigt, welcher Prozess gerade welche Datei liest und welche Netzwerkverbindung offen hat.',
    hint: 'Beantwortet die Frage „warum rattert meine Festplatte", die der Task-Manager offen lässt.',
    open: { type: 'shell', target: 'resmon.exe' }
  },
  {
    id: 'memory-diagnostic',
    category: 'Wartung',
    name: 'Speicherdiagnose',
    description: 'Prüft den Arbeitsspeicher auf Fehler. Läuft beim nächsten Neustart.',
    hint: 'Erste Maßnahme bei zufälligen Bluescreins ohne erkennbares Muster.',
    open: { type: 'shell', target: 'mdsched.exe' }
  },
  {
    id: 'windows-update',
    category: 'Wartung',
    name: 'Windows Update',
    description: 'Updates und der Verlauf bereits installierter Aktualisierungen.',
    open: 'ms-settings:windowsupdate'
  },
  {
    id: 'recovery',
    category: 'Wartung',
    name: 'Wiederherstellung',
    description: 'Systemwiederherstellungspunkte, Zurücksetzen und die erweiterten Startoptionen.',
    open: 'ms-settings:recovery'
  }
];

/* -------------------------------------------------------------- reading */

function stateEntries() {
  return CATALOGUE
    .map((entry) => ({ entry, spec: entry.toggle || entry.read }))
    .filter((x) => x.spec);
}

/** One PowerShell round trip for every readable value in the catalogue. */
async function readStates() {
  if (!IS_WIN) return {};
  const targets = stateEntries();
  if (!targets.length) return {};

  const lines = targets.map(({ entry, spec }) => {
    const path = spec.path.replace(/'/g, "''");
    const name = spec.name.replace(/'/g, "''");
    return `  [PSCustomObject]@{ id = '${entry.id}'; value = (Get-ItemProperty -LiteralPath '${path}' -Name '${name}' -ErrorAction SilentlyContinue).'${name}' }`;
  });

  const script = `
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
@(
${lines.join('\n')}
) | ConvertTo-Json -Compress
`;

  try {
    const out = await runPowerShell(script, 25000);
    const trimmed = (out || '').trim();
    if (!trimmed) return {};
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const map = {};
    for (const row of list) {
      if (row && row.id) map[row.id] = row.value === null || row.value === undefined ? null : Number(row.value);
    }
    return map;
  } catch (_) {
    return {};
  }
}

async function list() {
  const states = await readStates();

  const items = CATALOGUE.map((entry) => {
    const spec = entry.toggle || entry.read;
    const raw = spec ? states[entry.id] : undefined;
    let state = null;
    if (spec && raw !== undefined) {
      // An absent value means Windows is using its default, which is not the
      // same as "off" for every setting, so it is reported as unknown.
      state = raw === null ? null : (raw === spec.on);
    }
    return {
      id: entry.id,
      category: entry.category,
      name: entry.name,
      description: entry.description,
      hint: entry.hint || null,
      canToggle: !!entry.toggle && !entry.readOnly,
      canOpen: !!entry.open,
      action: entry.action || null,
      needs: entry.needs || null,
      readOnly: !!entry.readOnly,
      state
    };
  });

  const categories = [];
  for (const item of items) {
    if (!categories.includes(item.category)) categories.push(item.category);
  }

  return { supported: IS_WIN, items, categories };
}

/* -------------------------------------------------------------- writing */

function find(id) {
  const entry = CATALOGUE.find((e) => e.id === id);
  if (!entry) throw new Error(`Unbekannter Eintrag: ${id}`);
  return entry;
}

async function setToggle(id, enabled) {
  // Input and policy are checked before the platform, so a bad entry gives a
  // precise error everywhere and the HKCU rule is testable off Windows.
  const entry = find(id);
  if (!entry.toggle || entry.readOnly) throw new Error(`${entry.name} lässt sich hier nicht umschalten`);

  const spec = entry.toggle;
  if (!/^HKCU:/i.test(spec.path)) {
    // Everything under HKLM needs elevation and is deliberately read-only in
    // this catalogue.
    throw new Error('Nur Einstellungen des aktuellen Benutzers können geändert werden');
  }

  if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');

  const value = enabled ? spec.on : spec.off;
  const path = spec.path.replace(/'/g, "''");
  const name = spec.name.replace(/'/g, "''");

  await runPowerShell(`
$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath '${path}')) { New-Item -Path '${path}' -Force | Out-Null }
Set-ItemProperty -LiteralPath '${path}' -Name '${name}' -Value ${Number(value)} -Type DWord -Force
`, 20000);

  return { ok: true, id, enabled: !!enabled, needs: entry.needs || null };
}

async function open(id) {
  const entry = find(id);
  if (!entry.open) throw new Error(`${entry.name} hat keine eigene Seite`);
  if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');

  if (typeof entry.open === 'string') {
    await shell.openExternal(entry.open);
    return { ok: true, id };
  }

  // Built in steps rather than one nested template: a template literal inside
  // a PowerShell string is hard to read and impossible to extract for the
  // parser test that checks every generated script.
  const args = (entry.open.args || []).map((a) => `"${String(a).replace(/"/g, '')}"`).join(', ');
  const argumentList = args ? ` -ArgumentList ${args}` : '';
  const target = String(entry.open.target).replace(/"/g, '');

  await runPowerShell(`
$ErrorActionPreference = "Stop"
Start-Process -FilePath "${target}"${argumentList}
`, 15000);
  return { ok: true, id };
}

/** Explorer has to be restarted for a few of these to take effect. */
async function restartExplorer() {
  if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');
  // Windows relaunches Explorer by itself; starting it again only guards
  // against the rare case where it does not.
  await runPowerShell(`
$ErrorActionPreference = "SilentlyContinue"
Stop-Process -Name explorer -Force
Start-Sleep -Milliseconds 800
if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
`, 25000);
  return { ok: true };
}

async function runAction(id) {
  const entry = find(id);
  if (entry.action !== 'godmode') throw new Error(`Unbekannte Aktion für ${id}`);
  if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');

  // A folder whose name ends in this class id is rendered by Explorer as the
  // full list of control panel tasks. Documented behaviour, not a trick.
  await runPowerShell(`
$ErrorActionPreference = "Stop"
$desktop = [Environment]::GetFolderPath('Desktop')
$target = Join-Path $desktop 'Alle Einstellungen.{ED7BA470-8E54-465E-825C-99712043E01C}'
if (-not (Test-Path -LiteralPath $target)) { New-Item -Path $target -ItemType Directory | Out-Null }
`, 20000);
  return { ok: true, id, message: 'Ordner „Alle Einstellungen" liegt auf dem Desktop' };
}

module.exports = { list, setToggle, open, restartExplorer, runAction, CATALOGUE };
