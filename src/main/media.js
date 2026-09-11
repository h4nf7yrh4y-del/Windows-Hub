'use strict';

const processes = require('./processes');
const logger = require('./logger');

const log = logger.scoped('media');
const IS_WIN = process.platform === 'win32';

/**
 * What is playing, and the three buttons worth having.
 *
 * Windows keeps a system-wide media session — the thing behind the volume
 * overlay and the media keys — and any well-behaved player registers with it.
 * Spotify does, so does the browser. A hub that starts Spotify as part of a
 * profile and then cannot say what is playing is missing something obvious.
 *
 * Reached through WinRT, which is why this only works in Windows PowerShell:
 * PowerShell 7 dropped WinRT support. The host runs powershell.exe on Windows,
 * so that is what it gets. Everything here degrades to "nothing playing" when
 * the call fails, because on a machine with no player running that is also the
 * correct answer and the two are not worth telling apart.
 */

// Waiting on a WinRT IAsyncOperation from PowerShell needs the generic AsTask
// overload picked out by reflection; there is no simpler way to do it.
const PREAMBLE = String.raw`
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and
  $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`+"`"+`1'
})[0]

function Await-Op($operation, $resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  [void]$task.Wait(8000)
  $task.Result
}

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$manager = Await-Op ($managerType::RequestAsync()) ($managerType)
$session = $manager.GetCurrentSession()
`;

const READ_SCRIPT = `${PREAMBLE}
if ($null -eq $session) {
  ConvertTo-Json -Compress -InputObject ([PSCustomObject]@{ available = $true; playing = $false })
} else {
  $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
  $props = Await-Op ($session.TryGetMediaPropertiesAsync()) ($propsType)
  $info = $session.GetPlaybackInfo()
  $timeline = $session.GetTimelineProperties()

  $out = [PSCustomObject]@{
    available = $true
    playing   = ($info.PlaybackStatus -eq 'Playing')
    status    = [string]$info.PlaybackStatus
    title     = [string]$props.Title
    artist    = [string]$props.Artist
    album     = [string]$props.AlbumTitle
    source    = [string]$session.SourceAppUserModelId
    positionMs = [int64]$timeline.Position.TotalMilliseconds
    durationMs = [int64]$timeline.EndTime.TotalMilliseconds
    canNext   = [bool]$info.Controls.IsNextEnabled
    canPrev   = [bool]$info.Controls.IsPreviousEnabled
    canPause  = [bool]$info.Controls.IsPauseEnabled
  }
  ConvertTo-Json -Compress -Depth 3 -InputObject $out
}
`;

const COMMANDS = {
  playpause: 'TryTogglePlayPauseAsync',
  next: 'TrySkipNextAsync',
  previous: 'TrySkipPreviousAsync',
  play: 'TryPlayAsync',
  pause: 'TryPauseAsync'
};

function commandScript(method) {
  return `${PREAMBLE}
if ($null -eq $session) { 'none' } else {
  [void](Await-Op ($session.${method}()) ([bool]))
  'ok'
}
`;
}

/* -------------------------------------------------------------------- read */

let lastGood = null;
let unsupportedUntil = 0;

// A machine without the media session API answers the same way every time, and
// asking every two seconds forever would occupy the shell for nothing.
const UNSUPPORTED_BACKOFF_MS = 5 * 60 * 1000;

function empty(note) {
  return { available: false, playing: false, note: note || null };
}

async function read() {
  if (!IS_WIN) return empty('Medienwiedergabe ist nur unter Windows verfügbar.');
  if (unsupportedUntil && Date.now() < unsupportedUntil) {
    return lastGood || empty('Keine Medienwiedergabe erkannt.');
  }

  try {
    // Background: this runs on a timer, so it must yield to anything the user
    // actually clicked.
    const out = await processes.runPowerShell(READ_SCRIPT, 15000, { background: true });
    const trimmed = (out || '').trim();
    if (!trimmed) throw new Error('Keine Antwort');

    const parsed = JSON.parse(trimmed);
    unsupportedUntil = 0;
    lastGood = {
      available: true,
      playing: !!parsed.playing,
      status: parsed.status || null,
      title: parsed.title || '',
      artist: parsed.artist || '',
      album: parsed.album || '',
      source: parsed.source || '',
      positionMs: Number(parsed.positionMs) || 0,
      durationMs: Number(parsed.durationMs) || 0,
      canNext: !!parsed.canNext,
      canPrev: !!parsed.canPrev,
      canPause: !!parsed.canPause,
      at: Date.now()
    };
    return lastGood;
  } catch (err) {
    // Windows before 1809, a PowerShell without WinRT, or simply no player.
    // None of those are worth a red error in the interface.
    unsupportedUntil = Date.now() + UNSUPPORTED_BACKOFF_MS;
    log.debug(`Medienwiedergabe nicht lesbar: ${err.message}`);
    return empty('Keine Medienwiedergabe erkannt.');
  }
}

async function command(name) {
  if (!IS_WIN) throw new Error('Nur unter Windows verfügbar');
  const method = COMMANDS[name];
  if (!method) throw new Error(`Unbekannter Befehl: ${name}`);

  const out = await processes.runPowerShell(commandScript(method), 15000);
  if ((out || '').trim() === 'none') throw new Error('Es läuft gerade keine Wiedergabe');

  // A control press should show its effect at once, not on the next poll.
  unsupportedUntil = 0;
  return read();
}

module.exports = { read, command, COMMANDS, READ_SCRIPT, commandScript };
