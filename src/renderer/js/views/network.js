import { el, clear, bytes, debounce } from '../util.js';
import { api } from '../api.js';

/**
 * Adapters, programs and open sockets.
 *
 * The system dashboard already shows how much is going through the busiest
 * adapter, which answers "is something downloading". This answers the next
 * question, which is the one people actually open a network view for: what is
 * downloading. The per-program roll-up comes first for that reason — two
 * hundred rows of sockets say nothing on their own.
 */

const POLL_MS = 5000;

function speed(value) {
  if (value === null || value === undefined) return '—';
  return `${bytes(value)}/s`;
}

const STATE_LABELS = {
  Listen: 'lauscht',
  Established: 'verbunden',
  TimeWait: 'wartet',
  CloseWait: 'schließt',
  SynSent: 'verbindet',
  Bound: 'gebunden'
};

export function createNetworkPanel() {
  let data = null;
  let filter = '';
  let timer = null;
  let busy = false;
  let showListening = false;

  const adapterHost = el('div', { class: 'net-adapters' });
  const programBody = el('tbody');
  const connectionBody = el('tbody');
  const statusLine = el('span', { class: 'label', text: 'Lade …' });

  const search = el('input', {
    class: 'input',
    placeholder: 'Programm, Adresse oder Port …',
    style: { maxWidth: '280px' },
    oninput: debounce((event) => { filter = event.target.value.trim().toLowerCase(); render(); }, 160)
  });

  const listenToggle = el('button', {
    class: 'btn subtle sm',
    text: 'Lauschende zeigen',
    onClick: (event) => {
      showListening = !showListening;
      event.currentTarget.textContent = showListening ? 'Lauschende ausblenden' : 'Lauschende zeigen';
      event.currentTarget.classList.toggle('primary', showListening);
      render();
    }
  });

  function renderAdapters() {
    clear(adapterHost);
    if (!data || !data.adapters.length) {
      adapterHost.appendChild(el('div', { class: 'empty', style: { padding: '20px' } }, [
        el('div', { class: 'empty-title', text: 'Keine Adapter gefunden' })
      ]));
      return;
    }

    for (const adapter of data.adapters) {
      const up = adapter.state === 'up';
      adapterHost.appendChild(el('div', { class: `net-adapter${up ? ' up' : ''}` }, [
        el('div', { class: 'row between gap-8' }, [
          el('div', { class: 'stack grow', style: { minWidth: '0' } }, [
            el('div', { class: 'net-adapter-name truncate', text: adapter.name }),
            el('div', { class: 'net-adapter-sub truncate', text: [
              adapter.ip4 || adapter.ip6 || 'ohne Adresse',
              adapter.type,
              adapter.speedMbit > 0 ? `${adapter.speedMbit} Mbit/s` : null,
              adapter.isDefault ? 'Standardroute' : null
            ].filter(Boolean).join(' · ') })
          ]),
          el('span', { class: up ? 'badge accent' : 'badge', text: up ? 'aktiv' : adapter.state })
        ]),
        el('div', { class: 'net-rates' }, [
          el('div', { class: 'net-rate' }, [el('b', { text: '↓' }), speed(adapter.rxSec)]),
          el('div', { class: 'net-rate' }, [el('b', { text: '↑' }), speed(adapter.txSec)]),
          el('div', { class: 'net-rate faint', text: `${bytes(adapter.rxTotal)} / ${bytes(adapter.txTotal)} gesamt` }),
          adapter.dropped ? el('div', { class: 'net-rate warn', text: `${adapter.dropped} verworfen` }) : null
        ])
      ]));
    }
  }

  function renderPrograms() {
    clear(programBody);
    const rows = (data ? data.programs : [])
      .filter((p) => !filter || p.process.toLowerCase().includes(filter))
      .filter((p) => showListening || p.established > 0);

    if (!rows.length) {
      programBody.appendChild(el('tr', {}, [
        el('td', { colspan: '4' }, [
          el('div', { class: 'empty', style: { padding: '26px' } }, [
            el('div', { class: 'empty-title', text: data ? 'Keine offenen Verbindungen' : 'Lade …' })
          ])
        ])
      ]));
      return;
    }

    for (const row of rows) {
      programBody.appendChild(el('tr', { dataset: { focusable: 'true' } }, [
        el('td', {}, [el('div', { class: 'proc-name' }, [el('span', { text: row.process })])]),
        el('td', { class: 'num', text: String(row.established) }),
        el('td', { class: 'num', text: String(row.peers) }),
        el('td', { class: 'num', text: String(row.listening) })
      ]));
    }
  }

  function renderConnections() {
    clear(connectionBody);
    const rows = (data ? data.connections : [])
      .filter((c) => showListening || !c.listening)
      .filter((c) => !filter
        || c.process.toLowerCase().includes(filter)
        || c.remote.toLowerCase().includes(filter)
        || String(c.remotePort).includes(filter)
        || String(c.localPort).includes(filter))
      .slice(0, 300);

    if (!rows.length) {
      connectionBody.appendChild(el('tr', {}, [
        el('td', { colspan: '4' }, [
          el('div', { class: 'empty', style: { padding: '26px' } }, [
            el('div', { class: 'empty-title', text: 'Nichts zu zeigen' }),
            el('div', { style: { fontSize: '12px' }, text: showListening
              ? 'Es sind keine Sockets offen.'
              : 'Nur lauschende Sockets vorhanden — über den Knopf oben einblenden.' })
          ])
        ])
      ]));
      return;
    }

    for (const row of rows) {
      connectionBody.appendChild(el('tr', { dataset: { focusable: 'true' } }, [
        el('td', {}, [el('div', { class: 'proc-name' }, [
          el('span', { text: row.process }),
          el('span', { class: 'proc-title', text: `PID ${row.pid}` })
        ])]),
        el('td', { class: 'mono truncate', text: row.listening ? `:${row.localPort}` : `${row.remote}:${row.remotePort}` }),
        el('td', { class: 'num mono', text: String(row.localPort) }),
        el('td', { class: 'num', text: STATE_LABELS[row.state] || row.state })
      ]));
    }
  }

  function render() {
    renderAdapters();
    renderPrograms();
    renderConnections();
    if (!data) return;
    const active = data.connections.filter((c) => !c.listening).length;
    statusLine.textContent = data.connections.length
      ? `${active} offene Verbindungen · ${data.connections.length - active} lauschende Sockets · ${data.programs.length} Programme`
      : 'Keine Verbindungsdaten verfügbar';
  }

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      data = await api.network.overview();
      render();
    } catch (err) {
      statusLine.textContent = err.message;
    } finally {
      busy = false;
    }
  }

  function head(columns) {
    return el('thead', {}, [el('tr', {}, columns.map(([label, align]) =>
      el('th', { style: { textAlign: align || 'left' }, text: label })))]);
  }

  const panel = el('div', { class: 'net-panel' }, [
    el('div', { class: 'proc-toolbar' }, [
      search,
      listenToggle,
      el('div', { class: 'grow' }),
      statusLine,
      el('button', { class: 'btn subtle sm', text: 'Aktualisieren', onClick: () => poll() })
    ]),

    adapterHost,

    el('div', { class: 'net-tables' }, [
      el('div', { class: 'stack gap-8', style: { minWidth: '0' } }, [
        el('span', { class: 'label', text: 'Nach Programm' }),
        el('div', { class: 'table-wrap' }, [
          el('table', { class: 'table' }, [
            head([['Programm'], ['Verbunden', 'right'], ['Gegenstellen', 'right'], ['Lauscht', 'right']]),
            programBody
          ])
        ])
      ]),
      el('div', { class: 'stack gap-8', style: { minWidth: '0' } }, [
        el('span', { class: 'label', text: 'Einzelne Verbindungen' }),
        el('div', { class: 'table-wrap' }, [
          el('table', { class: 'table' }, [
            head([['Programm'], ['Gegenstelle'], ['Lokal', 'right'], ['Zustand', 'right']]),
            connectionBody
          ])
        ])
      ])
    ])
  ]);

  render();
  poll();
  timer = setInterval(poll, POLL_MS);

  // Reading the connection table costs a system call per poll, so it stops the
  // moment the panel is no longer on screen.
  panel.addEventListener('panel:dispose', () => {
    if (timer) { clearInterval(timer); timer = null; }
  });

  return panel;
}
