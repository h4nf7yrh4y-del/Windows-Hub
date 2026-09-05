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
  }
});
