import { el, clear, svg } from './util.js';
import { api } from './api.js';
import { toast, notifyError, notifyOk } from './widgets/toast.js';

/**
 * The Claude Code console window.
 *
 * A client of the streaming JSON protocol, not a terminal emulator: text
 * arrives token by token, tool calls appear as their own cards while they run
 * and fill in when their result comes back, and the running cost is always
 * on screen because this spends the user's own quota.
 */

const ICON_MIN = 'M5 12h14';
const ICON_MAX = ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'];
const ICON_CLOSE = 'M6 6l12 12M18 6L6 18';
const ICON_FOLDER = ['M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z'];

const root = document.getElementById('claude-root');

let options = null;
let session = { running: false };
let streamNode = null;      // assistant bubble currently being written into
let caret = null;
const toolCards = new Map(); // tool_use id -> element
let busyCard = null;

/* ---------------------------------------------------------------- header */

const metaCwd = el('span', { class: 'no-drag', text: '—' });
const metaModel = el('b', { text: '—' });
const metaMode = el('b', { text: '—' });
const metaCost = el('b', { text: '$0.00' });
const metaTurns = el('b', { text: '0' });
const metaStatus = el('span', { class: 'cc-status', text: '' });

const header = el('div', { class: 'cc-head' }, [
  el('div', { class: 'cc-brand no-drag' }, [
    el('span', { class: 'mark', text: '//' }),
    el('span', { class: 'glitch', dataset: { text: 'CLAUDE CODE' }, text: 'CLAUDE CODE' })
  ]),
  el('div', { class: 'cc-meta' }, [
    metaStatus,
    el('span', { title: 'Arbeitsverzeichnis' }, [metaCwd]),
    el('span', {}, ['Modell ', metaModel]),
    el('span', {}, ['Modus ', metaMode]),
    el('span', {}, ['Runden ', metaTurns]),
    el('span', { title: 'Kosten dieser Sitzung' }, ['Kosten ', metaCost])
  ]),
  el('div', { class: 'cc-controls' }, [
    el('button', { class: 'icon-btn', title: 'Minimieren', onClick: () => api.claude.windowAction('minimize').catch(() => {}) },
      [svg(ICON_MIN, { width: 15, height: 15 })]),
    el('button', { class: 'icon-btn', title: 'Maximieren', onClick: () => api.claude.windowAction('maximize').catch(() => {}) },
      [svg(ICON_MAX, { width: 15, height: 15 })]),
    el('button', { class: 'icon-btn danger', title: 'Schließen', onClick: () => api.claude.windowAction('close').catch(() => {}) },
      [svg(ICON_CLOSE, { width: 15, height: 15 })])
  ])
]);

/* ----------------------------------------------------------------- setup */

const cwdInput = el('input', { class: 'input', placeholder: 'Arbeitsverzeichnis', readonly: true });
const modelSelect = el('select', { class: 'select' });
const modeSelect = el('select', { class: 'select' });
const modeNote = el('div', { class: 'cc-mode-note', text: '' });

const resumeSelect = el('select', { class: 'select' }, [
  el('option', { value: '', text: 'Neue Sitzung' })
]);

/**
 * Claude Code keeps the transcripts and can resume any of them by id. What it
 * cannot do is say which of them came from this window; that list is kept here,
 * so the ids turn into something recognisable — folder, time, last answer.
 */
async function refreshResumeList() {
  const previous = resumeSelect.value;
  const cwd = cwdInput.value;
  let sessions = [];
  try {
    ({ sessions } = await api.claude.history(cwd));
  } catch (_) { /* an empty list is a fine answer */ }

  clear(resumeSelect);
  resumeSelect.appendChild(el('option', { value: '', text: 'Neue Sitzung' }));
  for (const entry of sessions) {
    const when = new Date(entry.updatedAt || entry.startedAt)
      .toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const label = entry.summary ? `${when} · ${entry.summary.slice(0, 46)}` : `${when} · ${entry.turns || 0} Runden`;
    resumeSelect.appendChild(el('option', { value: entry.id, text: label, title: entry.id }));
  }
  resumeSelect.value = sessions.some((e) => e.id === previous) ? previous : '';
  resumeSelect.disabled = sessions.length === 0;
}

const startButton = el('button', { class: 'btn primary', text: 'Sitzung starten' });
const stopButton = el('button', { class: 'btn danger hidden', text: 'Sitzung beenden' });

const setup = el('div', { class: 'cc-setup' }, [
  el('div', { class: 'cc-setup-grid' }, [
    el('div', { class: 'field' }, [
      el('label', { text: 'Ordner' }),
      el('div', { class: 'row gap-8' }, [
        cwdInput,
        el('button', {
          class: 'btn subtle sm',
          title: 'Ordner wählen',
          onClick: async () => {
            try {
              const dir = await api.claude.pickFolder();
              if (dir) { cwdInput.value = dir; refreshResumeList(); }
            } catch (err) { notifyError(err.message); }
          }
        }, [svg(ICON_FOLDER, { width: 13, height: 13 })])
      ])
    ]),
    el('div', { class: 'field' }, [el('label', { text: 'Modell' }), modelSelect]),
    el('div', { class: 'field' }, [el('label', { text: 'Berechtigungen' }), modeSelect]),
    el('div', { class: 'field' }, [el('label', { text: 'Fortsetzen' }), resumeSelect])
  ]),
  modeNote,
  el('div', { class: 'row gap-8', style: { marginTop: '14px' } }, [startButton, stopButton])
]);

/* --------------------------------------------------------------- stream */

const stream = el('div', { class: 'cc-stream' });

function atBottom() {
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
}

function scroll(force = false) {
  if (force || atBottom()) stream.scrollTop = stream.scrollHeight;
}

function showEmpty() {
  clear(stream);
  stream.appendChild(el('div', { class: 'cc-empty' }, [
    el('div', { class: 'cc-empty-title', text: 'Keine Sitzung' }),
    el('div', { text: 'Wähle einen Ordner und starte eine Sitzung. Claude arbeitet dann in diesem Ordner, '
      + 'mit genau den Rechten, die du oben einstellst.' })
  ]));
}

function addSystem(text, isError = false) {
  const wasBottom = atBottom();
  stream.appendChild(el('div', { class: `cc-msg system${isError ? ' error' : ''}`, text }));
  scroll(wasBottom);
}

function addMessage(role, text) {
  const wasBottom = atBottom();
  const node = el('div', { class: `cc-msg ${role}`, text });
  stream.appendChild(node);
  scroll(wasBottom || role === 'user');
  return node;
}

/** Opens or extends the assistant bubble that streaming text flows into. */
function appendDelta(text) {
  const wasBottom = atBottom();
  if (!streamNode) {
    streamNode = el('div', { class: 'cc-msg assistant' });
    caret = el('span', { class: 'cc-caret' });
    streamNode.appendChild(document.createTextNode(''));
    streamNode.appendChild(caret);
    stream.appendChild(streamNode);
  }
  streamNode.firstChild.textContent += text;
  scroll(wasBottom);
}

function closeStream() {
  if (caret) caret.remove();
  caret = null;
  streamNode = null;
}

function summarise(name, input) {
  if (!input || typeof input !== 'object') return '';
  const first = input.file_path || input.path || input.command || input.pattern || input.url || input.prompt;
  if (typeof first === 'string') return first.length > 120 ? `${first.slice(0, 120)}…` : first;
  const keys = Object.keys(input);
  return keys.length ? `${keys.length} Parameter` : '';
}

function addTool(id, name, input) {
  const wasBottom = atBottom();
  const body = el('div', { class: 'cc-tool-body hidden' }, [
    el('span', { class: 'cc-tool-label', text: 'Eingabe' }),
    el('span', { text: JSON.stringify(input, null, 2) || '—' })
  ]);

  const card = el('div', { class: 'cc-tool' }, [
    el('div', {
      class: 'cc-tool-head',
      onClick: () => body.classList.toggle('hidden')
    }, [
      el('span', { class: 'cc-tool-state' }),
      el('span', { class: 'cc-tool-name', text: name || 'Werkzeug' }),
      el('span', { class: 'cc-tool-summary', text: summarise(name, input) })
    ]),
    body
  ]);

  if (id) toolCards.set(id, { card, body });
  stream.appendChild(card);
  scroll(wasBottom);
}

function completeTool(id, text, isError) {
  const entry = toolCards.get(id);
  if (!entry) return;
  entry.card.classList.add(isError ? 'failed' : 'done');
  entry.body.append(
    el('span', { class: 'cc-tool-label', text: isError ? 'Fehler' : 'Ergebnis' }),
    el('span', { text: text || '—' })
  );
  if (isError) entry.body.classList.remove('hidden');
  toolCards.delete(id);
}

let statusTimer = null;

/** Shows a passing status in the header; it clears itself. */
function showStatus(text) {
  metaStatus.textContent = String(text || '').toLowerCase();
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { metaStatus.textContent = ''; }, 4000);
}

function setBusy(busy) {
  if (busy && !busyCard) {
    busyCard = el('div', { class: 'cc-busy' }, [
      el('span', { class: 'cc-dots' }, [el('i'), el('i'), el('i')]),
      el('span', { text: 'Claude arbeitet' })
    ]);
    stream.appendChild(busyCard);
    scroll();
  } else if (!busy && busyCard) {
    busyCard.remove();
    busyCard = null;
  }
  input.disabled = !session.running || busy;
  sendButton.setAttribute('aria-disabled', String(!session.running || busy));
  interruptButton.classList.toggle('hidden', !busy);
}

/* ------------------------------------------------------------------ input */

const input = el('textarea', {
  class: 'cc-input',
  placeholder: 'Nachricht an Claude … (Enter sendet, Umschalt+Enter für eine neue Zeile)',
  rows: '1',
  disabled: true
});

const sendButton = el('button', { class: 'btn primary', text: 'Senden', 'aria-disabled': 'true' });
const interruptButton = el('button', { class: 'btn danger hidden', text: 'Abbrechen' });

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(180, input.scrollHeight)}px`;
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});

async function submit() {
  const text = input.value.trim();
  if (!text || !session.running) return;
  try {
    await api.claude.send(text);
    input.value = '';
    input.style.height = 'auto';
  } catch (err) {
    notifyError(err.message);
  }
}

sendButton.addEventListener('click', submit);
interruptButton.addEventListener('click', async () => {
  try { await api.claude.interrupt(); } catch (err) { notifyError(err.message); }
});

const inputBar = el('div', { class: 'cc-input-bar' }, [input, sendButton, interruptButton]);

/* ------------------------------------------------------------- lifecycle */

function applyModeNote() {
  const mode = (options.permissionModes || []).find((m) => m.value === modeSelect.value);
  modeNote.textContent = mode ? mode.description : '';
  modeNote.classList.toggle('danger', !!(mode && mode.danger));
}

function renderSessionState() {
  const running = !!session.running;
  startButton.classList.toggle('hidden', running);
  stopButton.classList.toggle('hidden', !running);
  cwdInput.disabled = running;
  modelSelect.disabled = running;
  modeSelect.disabled = running;
  // While a session runs the settings are fixed anyway, so the panel folds
  // away and gives the conversation the room instead.
  setup.classList.toggle('collapsed', running);
  input.disabled = !running || !!session.busy;
  sendButton.setAttribute('aria-disabled', String(!running || !!session.busy));

  metaCwd.textContent = session.cwd ? session.cwd.split(/[\\/]/).slice(-2).join('/') : '—';
  metaCwd.title = session.cwd || '';
  metaModel.textContent = session.model || 'Standard';
  const mode = (options && options.permissionModes || []).find((m) => m.value === session.permissionMode);
  metaMode.textContent = mode ? mode.label : (session.permissionMode || '—');
  metaTurns.textContent = String(session.turns || 0);
  metaCost.textContent = `$${(session.costUsd || 0).toFixed(2)}`;
}

startButton.addEventListener('click', async () => {
  startButton.setAttribute('aria-disabled', 'true');
  try {
    clear(stream);
    const resume = resumeSelect.value || null;
    session = await api.claude.start({
      cwd: cwdInput.value,
      model: modelSelect.value,
      permissionMode: modeSelect.value,
      resume
    });
    renderSessionState();
    addSystem(resume
      ? 'Frühere Sitzung wird fortgesetzt · der bisherige Verlauf steht Claude zur Verfügung, wird hier aber nicht noch einmal angezeigt'
      : 'Sitzung wird gestartet …');
    input.focus();
  } catch (err) {
    notifyError(err.message);
    showEmpty();
  } finally {
    startButton.removeAttribute('aria-disabled');
  }
});

stopButton.addEventListener('click', async () => {
  try {
    await api.claude.stopSession();
    notifyOk('Sitzung beendet');
  } catch (err) { notifyError(err.message); }
});

/* -------------------------------------------------------------- events */

api.claude.onEvent((event) => {
  if (!event || typeof event !== 'object') return;

  switch (event.kind) {
    case 'session':
      session = { ...session, ...event };
      renderSessionState();
      addSystem(`Bereit · ${event.model || 'Standard'} · ${(event.tools || []).length} Werkzeuge`);
      break;

    case 'delta':
      setBusy(true);
      appendDelta(event.text);
      break;

    case 'message':
      if (event.role === 'user') {
        closeStream();
        addMessage('user', event.text);
      } else if (!streamNode) {
        // Arrives without deltas when streaming was not used for this block.
        addMessage('assistant', event.text);
      } else {
        closeStream();
      }
      break;

    case 'tool':
      closeStream();
      addTool(event.id, event.name, event.input);
      break;

    case 'tool-result':
      completeTool(event.id, event.text, event.isError);
      break;

    case 'busy':
      setBusy(event.busy);
      break;

    case 'result':
      closeStream();
      setBusy(false);
      session.turns = event.turns;
      session.costUsd = event.totalCostUsd;
      renderSessionState();
      if (!event.ok) addSystem(`Abgebrochen: ${event.subtype || 'Fehler'}`, true);
      break;

    case 'status':
      showStatus(event.text);
      break;

    case 'notice':
      addSystem(event.text);
      break;

    case 'stderr':
      addSystem(event.text, true);
      break;

    case 'error':
      closeStream();
      setBusy(false);
      addSystem(event.message, true);
      break;

    case 'exit':
      closeStream();
      setBusy(false);
      session = { running: false };
      renderSessionState();
      addSystem('Sitzung beendet');
      // The session that just ended is the one most likely to be picked up
      // again, so the list has to know about it before it is needed.
      refreshResumeList();
      break;

    default:
      break;
  }
});

/* ----------------------------------------------------------------- init */

async function init() {
  root.append(header, setup, stream, inputBar);
  showEmpty();

  try {
    options = await api.claude.options();
  } catch (err) {
    addSystem(err.message, true);
    return;
  }

  for (const model of options.models) {
    modelSelect.appendChild(el('option', { value: model.value, text: model.label }));
  }
  for (const mode of options.permissionModes) {
    modeSelect.appendChild(el('option', { value: mode.value, text: mode.label }));
  }
  modeSelect.value = options.defaults.permissionMode;
  cwdInput.value = options.defaults.cwd;
  await refreshResumeList();
  applyModeNote();
  modeSelect.addEventListener('change', applyModeNote);

  try {
    const current = await api.claude.state();
    if (current.running) {
      session = current;
      clear(stream);
      addSystem('Bestehende Sitzung übernommen');
    }
  } catch (_) { /* nothing running */ }

  renderSessionState();

  const detection = await api.claude.detect().catch(() => null);
  if (detection && !detection.installed) {
    addSystem(detection.hint || 'Claude Code wurde nicht gefunden.', true);
    startButton.setAttribute('aria-disabled', 'true');
  }
}

init().catch((err) => {
  root.innerHTML = `<div style="padding:40px;font-family:monospace;color:#ff3b5c">${err.message}</div>`;
});
