'use strict';

const { globalShortcut } = require('electron');
const store = require('./store');

/**
 * Global hotkeys.
 *
 * A hub that starts with the PC is useless if you have to alt-tab and hunt for
 * its window while a game is running. These bindings work system-wide.
 *
 * Every binding must carry a modifier. Registering a bare letter globally
 * would swallow that key in every other application, which is a trap rather
 * than a feature, so the renderer refuses it and this module double-checks.
 */

const ACTIONS = {
  toggleHub: {
    label: 'Hub anzeigen oder ausblenden',
    default: 'Alt+Shift+H'
  },
  toggleOverlays: {
    label: 'Alle Overlays ein- oder ausblenden',
    default: ''
  }
};

const MODIFIER = /^(CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|AltGr|Shift|Super|Meta)$/i;

let handlers = {};
const registered = new Map(); // action -> accelerator

/** Rejects shapes Electron would accept but a user would regret. */
function validate(accelerator) {
  if (typeof accelerator !== 'string') return 'Ungültige Tastenkombination';
  const value = accelerator.trim();
  if (!value) return null; // empty means "unbound", which is allowed

  const parts = value.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return 'Die Kombination braucht mindestens eine Zusatztaste wie Strg, Alt oder Shift';

  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  if (!modifiers.length || !modifiers.every((m) => MODIFIER.test(m))) {
    return 'Die Zusatztasten sind ungültig';
  }
  if (MODIFIER.test(key)) return 'Es fehlt eine echte Taste am Ende';
  return null;
}

function getBindings() {
  const state = store.state;
  if (!state.hotkeys) {
    state.hotkeys = {};
    for (const [action, spec] of Object.entries(ACTIONS)) state.hotkeys[action] = spec.default;
    store.save();
  }
  // Fill in any action added after the config was first written.
  let changed = false;
  for (const [action, spec] of Object.entries(ACTIONS)) {
    if (!(action in state.hotkeys)) { state.hotkeys[action] = spec.default; changed = true; }
  }
  if (changed) store.save();
  return state.hotkeys;
}

function unregister(action) {
  const accelerator = registered.get(action);
  if (!accelerator) return;
  try { globalShortcut.unregister(accelerator); } catch (_) { /* already gone */ }
  registered.delete(action);
}

function bind(action, accelerator) {
  unregister(action);
  const value = (accelerator || '').trim();
  if (!value) return { ok: true, action, accelerator: '', active: false };

  const handler = handlers[action];
  if (!handler) return { ok: false, action, reason: `Keine Aktion für ${action}` };

  let success = false;
  try {
    success = globalShortcut.register(value, handler);
  } catch (err) {
    return { ok: false, action, accelerator: value, reason: err.message };
  }

  if (!success) {
    // Electron returns false when another application already owns the key.
    return {
      ok: false,
      action,
      accelerator: value,
      reason: `${value} ist bereits von einem anderen Programm belegt`
    };
  }

  registered.set(action, value);
  return { ok: true, action, accelerator: value, active: true };
}

/** Binds everything from the stored config. Failures are reported, not thrown. */
function applyAll() {
  const bindings = getBindings();
  const results = [];
  for (const action of Object.keys(ACTIONS)) {
    results.push(bind(action, bindings[action]));
  }
  return results;
}

function set(action, accelerator) {
  if (!ACTIONS[action]) throw new Error(`Unbekannte Aktion: ${action}`);
  const problem = validate(accelerator);
  if (problem) throw new Error(problem);

  const bindings = getBindings();
  const previous = bindings[action];
  const result = bind(action, accelerator);

  if (!result.ok) {
    // Put the working binding back so a rejected key never leaves a gap.
    bind(action, previous);
    throw new Error(result.reason);
  }

  bindings[action] = (accelerator || '').trim();
  store.save();
  return list();
}

function list() {
  const bindings = getBindings();
  return Object.entries(ACTIONS).map(([action, spec]) => ({
    action,
    label: spec.label,
    default: spec.default,
    accelerator: bindings[action] || '',
    active: registered.has(action)
  }));
}

function init(actionHandlers) {
  handlers = actionHandlers || {};
  return applyAll();
}

function dispose() {
  for (const action of Array.from(registered.keys())) unregister(action);
}

module.exports = { init, set, list, validate, dispose, applyAll, ACTIONS };
