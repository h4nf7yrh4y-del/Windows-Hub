/**
 * A short memory of what just happened.
 *
 * Toasts answer "did that work" for whoever is looking at the screen at that
 * exact moment, and then they are gone. Minimize the hub for ten minutes --
 * or just look away while a trigger fires in the background -- and there is
 * nothing to come back to. This keeps the same events a little longer,
 * fed from the toast module itself so nothing elsewhere has to call two
 * functions where it used to call one.
 */

const MAX = 30;

/* ------------------------------------------------------------------- pure */
/*
 * Free of module state and of the DOM, so `test/activity.test.js` lifts it
 * out and runs it directly.
 */

/** What a trigger event becomes in the feed, or null for a kind this does not know. */
function describeTriggerEvent(event) {
  if (!event || !event.name) return null;
  const name = event.name;
  switch (event.kind) {
    case 'applied':
      return {
        kind: 'ok',
        message: event.action === 'full'
          ? `„${name}" erkannt – vollständig gestartet`
          : `„${name}" erkannt – Systemzustand übernommen`
      };
    case 'reverted':
      return { kind: 'info', message: `„${name}" beendet – Systemzustand zurückgegeben` };
    case 'blocked':
      return { kind: 'warn', message: `„${name}" erkannt, aber ein anderes Profil hält den Systemzustand` };
    case 'error':
      return { kind: 'error', message: `„${name}": Auslöser fehlgeschlagen – ${event.error || 'unbekannter Fehler'}` };
    default:
      return null;
  }
}

/* --------------------------------------------------------------- end pure */

const entries = [];
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn(entries.slice());
}

/** Records one event. `kind` is 'ok' | 'warn' | 'error' | 'info'. */
export function record(kind, message) {
  if (!message) return;
  entries.unshift({
    id: crypto.randomUUID(),
    kind: kind || 'info',
    message: String(message),
    at: Date.now()
  });
  if (entries.length > MAX) entries.length = MAX;
  emit();
}

export function recordTrigger(event) {
  const described = describeTriggerEvent(event);
  if (described) record(described.kind, described.message);
}

export function list() {
  return entries.slice();
}

export function clear() {
  entries.length = 0;
  emit();
}

/** Returns an unsubscribe function. */
export function onChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}
