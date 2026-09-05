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
    close: call(bridge.window.close)
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
    onProgress: bridge.profiles.onProgress
  },
  library: {
    scan: call(bridge.library.scan),
    icon: call(bridge.library.icon),
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
    kill: call(bridge.processes.kill),
    killByName: call(bridge.processes.killByName),
    priority: call(bridge.processes.priority)
  },
  power: {
    perform: call(bridge.power.perform),
    actions: call(bridge.power.actions)
  },
  shell: {
    openExternal: call(bridge.shell.openExternal),
    openPath: call(bridge.shell.openPath)
  }
};
