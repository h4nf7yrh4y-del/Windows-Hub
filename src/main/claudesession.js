'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const logger = require('./logger');
const claudecode = require('./claudecode');

const log = logger.scoped('claude-session');

/**
 * A live Claude Code session driven over its streaming JSON protocol.
 *
 * `claude --print --input-format stream-json --output-format stream-json`
 * keeps a process alive that reads user messages as JSON lines on stdin and
 * writes events as JSON lines on stdout. That is a full programmatic
 * interface, which is why this needs no pseudo-terminal and therefore no
 * native module: the console in the hub is a real client of that protocol,
 * not a screen-scrape of a terminal.
 *
 * Events are normalised here rather than in the renderer, so the interface
 * deals with `delta`, `tool`, `result` and not with the raw shape of an
 * Anthropic streaming event.
 */

const PERMISSION_MODES = {
  // Wording checked against what the modes actually permit: plan mode does
  // run read-only commands such as a file search, so claiming that nothing is
  // executed would be false the first time a Bash card appears.
  plan: {
    label: 'Nur lesen',
    description: 'Claude darf Dateien und Verzeichnisse lesen, auch über suchende Befehle, und einen Plan vorschlagen. Es wird nichts verändert.',
    danger: false
  },
  acceptEdits: {
    label: 'Dateien ändern',
    description: 'Zusätzlich werden Dateiänderungen ohne Rückfrage übernommen. Befehle, die verändern, bleiben gesperrt.',
    danger: false
  },
  bypassPermissions: {
    label: 'Alles erlauben',
    description: 'Claude darf Dateien ändern und Befehle ausführen, ohne zu fragen. Nur in Ordnern verwenden, deren Inhalt du notfalls verlieren kannst.',
    danger: true
  }
};

const MODELS = [
  { value: '', label: 'Standard' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' }
];

let session = null;
let emit = () => {};

function setEmitter(fn) {
  emit = typeof fn === 'function' ? fn : () => {};
}

function state() {
  if (!session) return { running: false };
  return {
    running: true,
    sessionId: session.sessionId,
    cwd: session.cwd,
    model: session.model,
    permissionMode: session.permissionMode,
    version: session.version,
    tools: session.tools,
    busy: session.busy,
    turns: session.turns,
    costUsd: session.costUsd,
    startedAt: session.startedAt
  };
}

/* -------------------------------------------------------------- parsing */

function textOf(blocks) {
  return (blocks || [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Turns one protocol event into something the console can render directly. */
function handleEvent(event) {
  if (!event || typeof event !== 'object') return;

  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') {
        session.sessionId = event.session_id || null;
        session.model = event.model || session.model;
        session.cwd = event.cwd || session.cwd;
        session.version = event.claude_code_version || null;
        session.tools = Array.isArray(event.tools) ? event.tools : [];
        session.permissionMode = event.permissionMode || session.permissionMode;
        log.info(`Sitzung bereit · ${session.model} · ${session.tools.length} Werkzeuge · ${session.cwd}`);
        emit({ kind: 'session', ...state() });
      } else if (event.subtype === 'status' && event.status) {
        // Transient bookkeeping: useful as a live indicator, noise as a
        // message in the conversation.
        emit({ kind: 'status', text: String(event.status), transient: true });
      }
      return;

    case 'stream_event': {
      const inner = event.event || {};
      // Token-level text as it arrives, so the answer appears while it is
      // still being written rather than in one jump at the end.
      if (inner.type === 'content_block_delta' && inner.delta && inner.delta.type === 'text_delta') {
        emit({ kind: 'delta', text: inner.delta.text });
      } else if (inner.type === 'content_block_start' && inner.content_block && inner.content_block.type === 'thinking') {
        emit({ kind: 'thinking' });
      }
      return;
    }

    case 'assistant': {
      const blocks = (event.message && event.message.content) || [];
      const text = textOf(blocks);
      if (text) emit({ kind: 'message', role: 'assistant', text });
      for (const block of blocks) {
        if (block && block.type === 'tool_use') {
          emit({ kind: 'tool', id: block.id, name: block.name, input: block.input });
        }
      }
      return;
    }

    case 'user': {
      // Tool results come back as a user message from the protocol's view.
      const blocks = (event.message && event.message.content) || [];
      for (const block of blocks) {
        if (block && block.type === 'tool_result') {
          const content = typeof block.content === 'string'
            ? block.content
            : textOf(Array.isArray(block.content) ? block.content : []);
          emit({
            kind: 'tool-result',
            id: block.tool_use_id,
            isError: !!block.is_error,
            text: String(content || '').slice(0, 4000)
          });
        }
      }
      return;
    }

    case 'result': {
      session.busy = false;
      session.turns = Number(event.num_turns) || session.turns;
      if (Number.isFinite(event.total_cost_usd)) session.costUsd += event.total_cost_usd;
      emit({
        kind: 'result',
        ok: !event.is_error,
        subtype: event.subtype || null,
        text: typeof event.result === 'string' ? event.result : null,
        ms: Number(event.duration_ms) || null,
        costUsd: Number(event.total_cost_usd) || 0,
        totalCostUsd: session.costUsd,
        turns: session.turns,
        usage: event.usage || null
      });
      return;
    }

    case 'rate_limit_event': {
      // Only worth surfacing when it actually constrains the session.
      const info = event.rate_limit_info || {};
      if (info.status && info.status !== 'allowed') {
        emit({ kind: 'notice', text: `Nutzungsgrenze: ${info.status}` });
      }
      return;
    }

    default:
      // Everything else is protocol bookkeeping the console has no use for.
  }
}

/* ------------------------------------------------------------- lifecycle */

async function start(options = {}) {
  if (session) throw new Error('Es läuft bereits eine Sitzung. Beende sie zuerst.');

  const detection = await claudecode.detect();
  if (!detection.installed) {
    throw new Error('Claude Code wurde nicht gefunden. Prüfe die Installation.');
  }

  const cwd = typeof options.cwd === 'string' && options.cwd ? options.cwd : os.homedir();
  const permissionMode = PERMISSION_MODES[options.permissionMode] ? options.permissionMode : 'plan';
  const model = typeof options.model === 'string' ? options.model.trim() : '';

  const args = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', permissionMode,
    // Nothing here can answer an interactive approval prompt, so anything
    // that would ask is denied rather than left hanging. The permission mode
    // above is what actually decides what Claude may do.
    '--permission-prompts', 'none'
  ];
  if (model) args.push('--model', model);
  if (typeof options.resume === 'string' && options.resume) args.push('--resume', options.resume);
  for (const dir of (options.addDirs || []).filter((d) => typeof d === 'string' && d)) {
    args.push('--add-dir', dir);
  }

  log.info(`Sitzung wird gestartet · ${permissionMode}${model ? ` · ${model}` : ''} · ${cwd}`);

  const child = spawn(detection.command, args, {
    cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' }
  });

  session = {
    child,
    cwd,
    model: model || null,
    permissionMode,
    sessionId: null,
    version: null,
    tools: [],
    busy: false,
    turns: 0,
    costUsd: 0,
    startedAt: Date.now(),
    buffer: ''
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    // NDJSON arrives in arbitrary chunks; only complete lines are parsed.
    session.buffer += chunk;
    let index = session.buffer.indexOf('\n');
    while (index >= 0) {
      const line = session.buffer.slice(0, index).trim();
      session.buffer = session.buffer.slice(index + 1);
      if (line) {
        try {
          handleEvent(JSON.parse(line));
        } catch (err) {
          log.warn(`Unlesbare Zeile: ${line.slice(0, 160)}`);
        }
      }
      index = session.buffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (!text) return;
    log.warn(`stderr: ${text.slice(0, 400)}`);
    emit({ kind: 'stderr', text: text.slice(0, 800) });
  });

  child.on('error', (err) => {
    log.error('Prozessfehler:', err.message);
    emit({ kind: 'error', message: err.message });
    session = null;
    emit({ kind: 'exit', code: null });
  });

  child.on('close', (code) => {
    log.info(`Sitzung beendet (Code ${code})`);
    session = null;
    emit({ kind: 'exit', code });
  });

  return state();
}

function send(text) {
  if (!session) throw new Error('Keine laufende Sitzung');
  const message = String(text || '').trim();
  if (!message) throw new Error('Leere Nachricht');
  if (session.busy) throw new Error('Claude arbeitet noch an der vorherigen Nachricht');

  session.busy = true;
  const payload = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: message }] }
  });

  try {
    session.child.stdin.write(`${payload}\n`);
  } catch (err) {
    session.busy = false;
    throw new Error(`Nachricht konnte nicht gesendet werden: ${err.message}`);
  }

  emit({ kind: 'message', role: 'user', text: message });
  emit({ kind: 'busy', busy: true });
  return { ok: true };
}

/**
 * Ends the turn in progress. The protocol has no cancel message, so the
 * process is signalled; the console starts a fresh session afterwards.
 */
function interrupt() {
  if (!session) throw new Error('Keine laufende Sitzung');
  log.info('Sitzung wird unterbrochen');
  try { session.child.kill('SIGINT'); } catch (_) { /* already gone */ }
  return { ok: true };
}

function stop() {
  if (!session) return { ok: true, running: false };
  log.info('Sitzung wird beendet');
  const child = session.child;
  try { child.stdin.end(); } catch (_) { /* ignore */ }
  // Give it a moment to exit cleanly before insisting.
  const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* gone */ } }, 1500);
  child.once('close', () => clearTimeout(timer));
  return { ok: true, running: false };
}

function options() {
  return {
    permissionModes: Object.entries(PERMISSION_MODES).map(([value, spec]) => ({ value, ...spec })),
    models: MODELS,
    defaults: { permissionMode: 'plan', model: '', cwd: os.homedir() }
  };
}

module.exports = { start, send, stop, interrupt, state, options, setEmitter, PERMISSION_MODES };
