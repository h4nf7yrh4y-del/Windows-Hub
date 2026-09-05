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
    close: () => invoke('window:close')
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
    onProgress: (handler) => on('profile:progress', handler)
  },
  library: {
    scan: (opts) => invoke('library:scan', opts),
    icon: (target) => invoke('library:icon', target),
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
    kill: (pid) => invoke('processes:kill', pid),
    killByName: (name) => invoke('processes:killByName', name),
    priority: (pid, priority) => invoke('processes:priority', pid, priority)
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
    closeAll: () => invoke('overlays:closeAll')
  },
  // Used only by overlay windows, about themselves.
  overlay: {
    close: () => invoke('overlay:close'),
    onScale: (handler) => on('overlay:scale', handler)
  }
});
