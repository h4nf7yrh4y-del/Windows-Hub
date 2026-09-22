/**
 * Thin wrapper around the preload bridge.
 * Main returns {ok, data|error}; everything here either resolves with data or
 * throws, so call sites can use plain try/catch.
 */

const bridge = window.hub;

if (!bridge) {
  document.body.innerHTML =
    '<div style="padding:40px;font-family:monospace;color:#ff3b5c">Preload bridge missing. Hub cannot start.</div>';
  throw new Error('window.hub is not available');
}

function unwrap(result) {
  if (!result || typeof result !== 'object') throw new Error('Malformed IPC response');
  if (result.ok) return result.data;
  throw new Error(result.error || 'Unknown error');
}

const call = (fn) => async (...args) => unwrap(await fn(...args));

export const api = {
  app: {
    info: call(bridge.app.info)
  },
  window: {
    minimize: call(bridge.window.minimize),
    toggleFullscreen: call(bridge.window.toggleFullscreen),
    isFullscreen: call(bridge.window.isFullscreen),
    close: call(bridge.window.close),
    reveal: call(bridge.window.reveal)
  },
  screens: {
    list: call(bridge.screens.list),
    setHubDisplay: call(bridge.screens.setHubDisplay)
  },
  dashboard: {
    status: call(bridge.dashboard.status),
    toggle: call(bridge.dashboard.toggle),
    open: call(bridge.dashboard.open),
    close: call(bridge.dashboard.close),
    setDisplay: call(bridge.dashboard.setDisplay),
    setAutoOpen: call(bridge.dashboard.setAutoOpen),
    onChanged: bridge.dashboard.onChanged
  },
  display: {
    list: call(bridge.display.list),
    brightness: call(bridge.display.brightness),
    setMode: call(bridge.display.setMode),
    confirmMode: call(bridge.display.confirmMode),
    setPrimary: call(bridge.display.setPrimary),
    projection: call(bridge.display.projection),
    openSettings: call(bridge.display.openSettings),
    onReverted: bridge.display.onReverted
  },
  schedule: {
    list: call(bridge.schedule.list),
    save: call(bridge.schedule.save),
    remove: call(bridge.schedule.remove),
    runNow: call(bridge.schedule.runNow),
    onFired: bridge.schedule.onFired
  },
  sessions: {
    stats: call(bridge.sessions.stats),
    clear: call(bridge.sessions.clear)
  },
  updates: {
    scan: call(bridge.updates.scan),
    scanGames: call(bridge.updates.scanGames),
    clients: call(bridge.updates.clients),
    scanWinget: call(bridge.updates.scanWinget),
    state: call(bridge.updates.state),
    run: call(bridge.updates.run),
    cancel: call(bridge.updates.cancel),
    open: call(bridge.updates.open),
    steamProgress: call(bridge.updates.steamProgress),
    steamAll: call(bridge.updates.steamAll),
    steamGame: call(bridge.updates.steamGame),
    epicAll: call(bridge.updates.epicAll),
    epicGame: call(bridge.updates.epicGame),
    onProgress: bridge.updates.onProgress
  },
  discord: {
    state: call(bridge.discord.state),
    running: call(bridge.discord.running),
    save: call(bridge.discord.save),
    remove: call(bridge.discord.remove),
    open: call(bridge.discord.open),
    parse: call(bridge.discord.parse)
  },
  audio: {
    list: call(bridge.audio.list),
    setDefault: call(bridge.audio.setDefault)
  },
  backup: {
    export: call(bridge.backup.export),
    inspect: call(bridge.backup.inspect),
    import: call(bridge.backup.import)
  },
  trash: {
    list: call(bridge.trash.list),
    restore: call(bridge.trash.restore),
    drop: call(bridge.trash.drop),
    empty: call(bridge.trash.empty)
  },
  triggers: {
    list: call(bridge.triggers.list),
    refresh: call(bridge.triggers.refresh),
    onEvent: bridge.triggers.onEvent
  },
  storage: {
    overview: call(bridge.storage.overview),
    measure: call(bridge.storage.measure),
    uninstall: call(bridge.storage.uninstall)
  },
  coverart: {
    get: call(bridge.coverart.get)
  },
  layout: {
    windows: call(bridge.layout.windows),
    snapshot: call(bridge.layout.snapshot),
    apply: call(bridge.layout.apply)
  },
  selfupdate: {
    state: call(bridge.selfupdate.state),
    check: call(bridge.selfupdate.check),
    download: call(bridge.selfupdate.download),
    install: call(bridge.selfupdate.install),
    onProgress: bridge.selfupdate.onProgress
  },
  media: {
    read: call(bridge.media.read),
    command: call(bridge.media.command)
  },
  network: {
    overview: call(bridge.network.overview)
  },
  tweaks: {
    status: call(bridge.tweaks.status),
    powerPlans: call(bridge.tweaks.powerPlans),
    revert: call(bridge.tweaks.revert)
  },
  features: {
    list: call(bridge.features.list),
    set: call(bridge.features.set),
    open: call(bridge.features.open),
    action: call(bridge.features.action),
    restartExplorer: call(bridge.features.restartExplorer)
  },
  diagnostics: {
    build: call(bridge.diagnostics.build),
    save: call(bridge.diagnostics.save),
    export: call(bridge.diagnostics.export),
    openLogs: call(bridge.diagnostics.openLogs),
    logInfo: call(bridge.diagnostics.logInfo),
    logTail: call(bridge.diagnostics.logTail),
    // Fire and forget: reporting an error must never raise another one.
    report: (entry) => bridge.diagnostics.report(entry).catch(() => {})
  },
  claude: {
    detect: call(bridge.claude.detect),
    pickFolder: call(bridge.claude.pickFolder),
    open: call(bridge.claude.open),
    analyse: call(bridge.claude.analyse),
    openWindow: call(bridge.claude.openWindow),
    options: call(bridge.claude.options),
    state: call(bridge.claude.state),
    start: call(bridge.claude.start),
    send: call(bridge.claude.send),
    stopSession: call(bridge.claude.stopSession),
    history: call(bridge.claude.history),
    forget: call(bridge.claude.forget),
    interrupt: call(bridge.claude.interrupt),
    windowAction: call(bridge.claude.windowAction),
    onEvent: bridge.claude.onEvent
  },
  hotkeys: {
    list: call(bridge.hotkeys.list),
    set: call(bridge.hotkeys.set),
    profiles: call(bridge.hotkeys.profiles)
  },
  settings: {
    get: call(bridge.settings.get),
    set: call(bridge.settings.set),
    openConfigFolder: call(bridge.settings.openConfigFolder)
  },
  profiles: {
    list: call(bridge.profiles.list),
    save: call(bridge.profiles.save),
    remove: call(bridge.profiles.remove),
    reorder: call(bridge.profiles.reorder),
    launch: call(bridge.profiles.launch),
    stop: call(bridge.profiles.stop),
    stopPlan: call(bridge.profiles.stopPlan),
    onProgress: bridge.profiles.onProgress
  },
  library: {
    scan: call(bridge.library.scan),
    icon: call(bridge.library.icon),
    guessExecutable: call(bridge.library.guessExecutable),
    pickExecutable: call(bridge.library.pickExecutable),
    pickImage: call(bridge.library.pickImage),
    launch: call(bridge.library.launch)
  },
  metrics: {
    subscribe: call(bridge.metrics.subscribe),
    unsubscribe: call(bridge.metrics.unsubscribe),
    snapshot: call(bridge.metrics.snapshot),
    static: call(bridge.metrics.static),
    onSample: bridge.metrics.onSample
  },
  processes: {
    list: call(bridge.processes.list),
    running: call(bridge.processes.running),
    kill: call(bridge.processes.kill),
    killByName: call(bridge.processes.killByName),
    priority: call(bridge.processes.priority),
    priorityOptions: call(bridge.processes.priorityOptions)
  },
  power: {
    perform: call(bridge.power.perform),
    actions: call(bridge.power.actions)
  },
  shell: {
    openExternal: call(bridge.shell.openExternal),
    openPath: call(bridge.shell.openPath)
  },
  files: {
    drives: call(bridge.files.drives),
    quickLocations: call(bridge.files.quickLocations),
    list: call(bridge.files.list),
    search: call(bridge.files.search),
    createFolder: call(bridge.files.createFolder),
    rename: call(bridge.files.rename),
    trash: call(bridge.files.trash),
    transfer: call(bridge.files.transfer),
    open: call(bridge.files.open),
    reveal: call(bridge.files.reveal),
    info: call(bridge.files.info),
    folderSize: call(bridge.files.folderSize)
  },
  startup: {
    list: call(bridge.startup.list),
    remove: call(bridge.startup.remove),
    reveal: call(bridge.startup.reveal)
  },
  overlays: {
    list: call(bridge.overlays.list),
    set: call(bridge.overlays.set),
    update: call(bridge.overlays.update),
    closeAll: call(bridge.overlays.closeAll),
    toggle: call(bridge.overlays.toggle),
    onChanged: bridge.overlays.onChanged
  }
};
