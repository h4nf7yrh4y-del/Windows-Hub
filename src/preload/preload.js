'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between renderer and main.
 * Explicit method list, no generic `invoke(channel, ...)` escape hatch.
 */

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('hub', {
  app: {
    info: () => invoke('app:info')
  },
  window: {
    minimize: () => invoke('window:minimize'),
    toggleFullscreen: () => invoke('window:toggleFullscreen'),
    isFullscreen: () => invoke('window:isFullscreen'),
    close: () => invoke('window:close'),
    reveal: () => invoke('window:reveal')
  },
  screens: {
    list: () => invoke('screens:list'),
    setHubDisplay: (id) => invoke('window:setDisplay', id)
  },
  dashboard: {
    status: () => invoke('dashboard:status'),
    toggle: () => invoke('dashboard:toggle'),
    open: () => invoke('dashboard:open'),
    close: () => invoke('dashboard:close'),
    setDisplay: (id) => invoke('dashboard:setDisplay', id),
    setAutoOpen: (value) => invoke('dashboard:setAutoOpen', value),
    onChanged: (handler) => on('dashboard:changed', handler)
  },
  display: {
    list: () => invoke('display:list'),
    brightness: (target, value) => invoke('display:brightness', target, value),
    setMode: (device, mode) => invoke('display:setMode', device, mode),
    confirmMode: () => invoke('display:confirmMode'),
    setPrimary: (device) => invoke('display:setPrimary', device),
    projection: (mode) => invoke('display:projection', mode),
    openSettings: (page) => invoke('display:openSettings', page),
    onReverted: (handler) => on('display:reverted', handler)
  },
  sessions: {
    stats: () => invoke('sessions:stats'),
    clear: () => invoke('sessions:clear')
  },
  updates: {
    scan: () => invoke('updates:scan'),
    scanGames: () => invoke('updates:scanGames'),
    clients: () => invoke('updates:clients'),
    scanWinget: () => invoke('updates:scanWinget'),
    state: () => invoke('updates:state'),
    run: (id) => invoke('updates:run', id),
    cancel: () => invoke('updates:cancel'),
    open: (what, id) => invoke('updates:open', what, id),
    steamProgress: () => invoke('updates:steamProgress'),
    steamAll: () => invoke('updates:steamAll'),
    steamGame: (appId, mode) => invoke('updates:steamGame', appId, mode),
    epicAll: () => invoke('updates:epicAll'),
    epicGame: (uri) => invoke('updates:epicGame', uri),
    onProgress: (handler) => on('updates:progress', handler)
  },
  discord: {
    state: () => invoke('discord:state'),
    save: (entry) => invoke('discord:save', entry),
    remove: (id) => invoke('discord:remove', id),
    open: (id) => invoke('discord:open', id),
    parse: (text) => invoke('discord:parse', text)
  },
  audio: {
    list: (force) => invoke('audio:list', force),
    setDefault: (id) => invoke('audio:setDefault', id)
  },
  backup: {
    export: () => invoke('backup:export'),
    inspect: () => invoke('backup:inspect'),
    import: (text, mode) => invoke('backup:import', text, mode)
  },
  triggers: {
    list: () => invoke('triggers:list'),
    refresh: () => invoke('triggers:refresh'),
    onEvent: (handler) => on('triggers:event', handler)
  },
  storage: {
    overview: () => invoke('storage:overview'),
    measure: (dir) => invoke('storage:measure', dir),
    uninstall: (appId) => invoke('storage:uninstall', appId)
  },
  selfupdate: {
    state: () => invoke('selfupdate:state'),
    check: () => invoke('selfupdate:check'),
    download: () => invoke('selfupdate:download'),
    install: () => invoke('selfupdate:install'),
    onProgress: (handler) => on('selfupdate:progress', handler)
  },
  media: {
    read: () => invoke('media:read'),
    command: (name) => invoke('media:command', name)
  },
  network: {
    overview: () => invoke('network:overview')
  },
  tweaks: {
    status: () => invoke('tweaks:status'),
    powerPlans: () => invoke('tweaks:powerPlans'),
    revert: () => invoke('tweaks:revert')
  },
  features: {
    list: () => invoke('features:list'),
    set: (id, value) => invoke('features:set', id, value),
    open: (id) => invoke('features:open', id),
    action: (id) => invoke('features:action', id),
    restartExplorer: () => invoke('features:restartExplorer')
  },
  diagnostics: {
    build: () => invoke('diag:build'),
    save: () => invoke('diag:save'),
    export: () => invoke('diag:export'),
    openLogs: () => invoke('diag:openLogs'),
    logInfo: () => invoke('diag:logInfo'),
    logTail: (lines) => invoke('diag:logTail', lines),
    report: (entry) => invoke('diag:report', entry)
  },
  claude: {
    detect: (force) => invoke('claude:detect', force),
    pickFolder: () => invoke('claude:pickFolder'),
    open: (cwd, prompt) => invoke('claude:open', cwd, prompt),
    analyse: (reportPath, question) => invoke('claude:analyse', reportPath, question),
    openWindow: () => invoke('claude:openWindow'),
    options: () => invoke('claude:options'),
    state: () => invoke('claude:state'),
    start: (opts) => invoke('claude:start', opts),
    send: (text) => invoke('claude:send', text),
    stopSession: () => invoke('claude:stop'),
    history: (cwd) => invoke('claude:history', cwd),
    forget: (id) => invoke('claude:forget', id),
    interrupt: () => invoke('claude:interrupt'),
    windowAction: (action) => invoke('claude:window', action),
    onEvent: (handler) => on('claude:event', handler)
  },
  hotkeys: {
    list: () => invoke('hotkeys:list'),
    set: (action, accelerator) => invoke('hotkeys:set', action, accelerator)
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    openConfigFolder: () => invoke('settings:openConfigFolder')
  },
  profiles: {
    list: () => invoke('profiles:list'),
    save: (profile) => invoke('profiles:save', profile),
    remove: (id) => invoke('profiles:delete', id),
    reorder: (ids) => invoke('profiles:reorder', ids),
    launch: (id) => invoke('profiles:launch', id),
    stop: (id) => invoke('profiles:stop', id),
    stopPlan: (id) => invoke('profiles:stopPlan', id),
    onProgress: (handler) => on('profile:progress', handler)
  },
  schedule: {
    list: () => invoke('schedule:list'),
    save: (entry) => invoke('schedule:save', entry),
    remove: (id) => invoke('schedule:remove', id),
    runNow: (id) => invoke('schedule:runNow', id),
    onFired: (handler) => on('schedule:fired', handler)
  },
  library: {
    scan: (opts) => invoke('library:scan', opts),
    icon: (target) => invoke('library:icon', target),
    guessExecutable: (installDir) => invoke('library:guessExecutable', installDir),
    pickExecutable: () => invoke('library:pickExecutable'),
    pickImage: () => invoke('library:pickImage'),
    launch: (item) => invoke('launch:item', item)
  },
  metrics: {
    subscribe: () => invoke('metrics:subscribe'),
    unsubscribe: () => invoke('metrics:unsubscribe'),
    snapshot: () => invoke('metrics:snapshot'),
    static: () => invoke('metrics:static'),
    onSample: (handler) => on('metrics:sample', handler)
  },
  processes: {
    list: () => invoke('processes:list'),
    running: () => invoke('processes:running'),
    kill: (pid) => invoke('processes:kill', pid),
    killByName: (name) => invoke('processes:killByName', name),
    priority: (pid, priority) => invoke('processes:priority', pid, priority),
    priorityOptions: () => invoke('processes:priorityOptions')
  },
  power: {
    perform: (action) => invoke('power:perform', action),
    actions: () => invoke('power:actions')
  },
  shell: {
    openExternal: (url) => invoke('shell:openExternal', url),
    openPath: (target) => invoke('shell:openPath', target)
  },
  files: {
    drives: () => invoke('files:drives'),
    quickLocations: () => invoke('files:quickLocations'),
    list: (target) => invoke('files:list', target),
    search: (root, query, opts) => invoke('files:search', root, query, opts),
    createFolder: (parent, name) => invoke('files:createFolder', parent, name),
    rename: (target, name) => invoke('files:rename', target, name),
    trash: (targets) => invoke('files:trash', targets),
    transfer: (sources, destination, mode) => invoke('files:transfer', sources, destination, mode),
    open: (target) => invoke('files:open', target),
    reveal: (target) => invoke('files:reveal', target),
    info: (target) => invoke('files:info', target),
    folderSize: (target) => invoke('files:folderSize', target)
  },
  startup: {
    list: () => invoke('startup:list'),
    remove: (id) => invoke('startup:remove', id),
    reveal: (id) => invoke('startup:reveal', id)
  },
  overlays: {
    list: () => invoke('overlays:list'),
    set: (type, enabled) => invoke('overlays:set', type, enabled),
    update: (type, patch) => invoke('overlays:update', type, patch),
    closeAll: () => invoke('overlays:closeAll'),
    toggle: () => invoke('overlays:toggle'),
    onChanged: (handler) => on('overlays:changed', handler)
  },
  // Used only by overlay windows, about themselves.
  overlay: {
    close: () => invoke('overlay:close'),
    onScale: (handler) => on('overlay:scale', handler)
  }
});
