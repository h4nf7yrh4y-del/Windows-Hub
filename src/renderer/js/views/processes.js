import { el, clear, bytes, pct, debounce } from '../util.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { confirmDialog } from '../widgets/modal.js';
import { notifyError, notifyOk } from '../widgets/toast.js';
import { createStartupPanel } from './startup.js';

/**
 * Built-in task manager.
 *
 * Polling only runs while this view is mounted, because each poll is a
 * PowerShell round trip. The table is rebuilt wholesale per poll; at a few
 * hundred rows that is far cheaper than diffing, and it keeps sorting simple.
 */

const COLUMNS = [
  { key: 'name',          label: 'Prozess',   sortable: true,  align: 'left' },
  { key: 'pid',           label: 'PID',       sortable: true,  align: 'right' },
  { key: 'cpu',           label: 'CPU',       sortable: true,  align: 'right' },
  { key: 'memory',        label: 'Speicher',  sortable: true,  align: 'right' },
  { key: 'memoryPercent', label: 'RAM %',     sortable: true,  align: 'right' },
  { key: 'threads',       label: 'Threads',   sortable: true,  align: 'right' },
  { key: 'actions',       label: '',          sortable: false, align: 'right' }
];

const PROTECTED = new Set([
  'system', 'system idle process', 'registry', 'smss', 'csrss', 'wininit',
  'winlogon', 'services', 'lsass', 'memory compression', 'idle'
]);

export function createProcessesView() {
  let sortKey = 'cpu';
  let sortDir = 'desc';
  let filter = '';
  let rows = [];
  let selectedPid = null;
  let timer = null;
  let busy = false;
  let intervalMs = (state.settings && state.settings.processIntervalMs) || 3000;

  const tbody = el('tbody');
  const thead = el('thead');
  const summary = el('div', { class: 'proc-summary' });
  const statusLine = el('span', { class: 'label', text: 'Bereit' });

  const search = el('input', {
    class: 'input',
    placeholder: 'Prozess suchen …',
    oninput: debounce((event) => { filter = event.target.value.trim().toLowerCase(); renderRows(); }, 160)
  });

  const intervalSelect = el('select', { class: 'select', style: { width: 'auto' } }, [
    el('option', { value: '1000', text: '1 s' }),
    el('option', { value: '2000', text: '2 s' }),
    el('option', { value: '3000', text: '3 s' }),
    el('option', { value: '5000', text: '5 s' }),
    el('option', { value: '10000', text: '10 s' })
  ]);
  intervalSelect.value = String(intervalMs);
  intervalSelect.addEventListener('change', () => {
    intervalMs = Number(intervalSelect.value) || 3000;
    if (activeTab === 'processes') restart();
  });

  function renderHead() {
    clear(thead);
    const tr = el('tr');
    for (const col of COLUMNS) {
      const th = el('th', {
        style: { textAlign: col.align },
        text: col.label,
        onClick: col.sortable ? () => {
          if (sortKey === col.key) sortDir = sortDir === 'desc' ? 'asc' : 'desc';
          else { sortKey = col.key; sortDir = col.key === 'name' ? 'asc' : 'desc'; }
          renderHead();
          renderRows();
        } : null
      });
      if (col.sortable && sortKey === col.key) {
        th.dataset.sorted = sortDir;
        th.dataset.arrow = sortDir === 'desc' ? '▼' : '▲';
      }
      tr.appendChild(th);
    }
    thead.appendChild(tr);
  }

  async function killProcess(row) {
    if (PROTECTED.has(row.name.toLowerCase())) {
      notifyError(`${row.name} ist ein Systemprozess und wird nicht beendet.`);
      return;
    }
    const sure = await confirmDialog({
      title: 'Prozess beenden',
      message: `„${row.name}" (PID ${row.pid}) wird zusammen mit seinen Unterprozessen hart beendet. Nicht gespeicherte Daten gehen verloren.`,
      confirmLabel: 'Beenden',
      danger: true
    });
    if (!sure) return;
    try {
      await api.processes.kill(row.pid);
      notifyOk(`${row.name} beendet`);
      poll();
    } catch (err) {
      notifyError(err.message);
    }
  }

  function renderRows() {
    const filtered = filter
      ? rows.filter((r) => r.name.toLowerCase().includes(filter) || String(r.pid).includes(filter) || (r.title || '').toLowerCase().includes(filter))
      : rows.slice();

    const dir = sortDir === 'desc' ? -1 : 1;
    filtered.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return ((av || 0) - (bv || 0)) * dir;
    });

    clear(tbody);
    const frag = document.createDocumentFragment();

    for (const row of filtered.slice(0, 400)) {
      const isProtected = PROTECTED.has(row.name.toLowerCase());
      const tr = el('tr', {
        class: row.pid === selectedPid ? 'selected' : '',
        onClick: () => { selectedPid = row.pid; renderRows(); }
      }, [
        el('td', {}, [
          el('div', { class: 'proc-name' }, [
            el('span', { text: row.name }),
            row.title ? el('span', { class: 'proc-title truncate', style: { maxWidth: '260px' }, text: row.title }) : null
          ])
        ]),
        el('td', { class: 'num', text: String(row.pid) }),
        el('td', { class: 'num heat', style: { '--heat': String(Math.min(1, row.cpu / 45)) }, text: pct(row.cpu, 1) }),
        el('td', { class: 'num', text: bytes(row.memory) }),
        el('td', { class: 'num', text: pct(row.memoryPercent, 1) }),
        el('td', { class: 'num', text: String(row.threads || 0) }),
        el('td', { class: 'num col-actions' }, [
          el('button', {
            class: 'btn danger sm proc-action',
            text: 'Beenden',
            'aria-disabled': isProtected ? 'true' : null,
            title: isProtected ? 'Systemprozess – geschützt' : `PID ${row.pid} beenden`,
            onClick: (event) => { event.stopPropagation(); killProcess(row); }
          })
        ])
      ]);
      frag.appendChild(tr);
    }

    tbody.appendChild(frag);

    const totalCpu = rows.reduce((sum, r) => sum + (r.cpu || 0), 0);
    const totalMem = rows.reduce((sum, r) => sum + (r.memory || 0), 0);
    clear(summary);
    summary.append(
      el('span', {}, [document.createTextNode('Prozesse '), el('b', { text: String(rows.length) })]),
      el('span', {}, [document.createTextNode('Angezeigt '), el('b', { text: String(Math.min(filtered.length, 400)) })]),
      el('span', {}, [document.createTextNode('CPU '), el('b', { text: pct(totalCpu, 1) })]),
      el('span', {}, [document.createTextNode('Speicher '), el('b', { text: bytes(totalMem) })])
    );
  }

  async function poll() {
    if (busy) return;
    busy = true;
    statusLine.textContent = 'Abfrage …';
    try {
      const data = await api.processes.list();
      rows = data.processes || [];
      renderRows();
      statusLine.textContent = `Aktualisiert ${new Date(data.ts).toLocaleTimeString('de-DE')}`;
    } catch (err) {
      statusLine.textContent = `Fehler: ${err.message}`;
    } finally {
      busy = false;
    }
  }

  function restart() {
    if (timer) clearInterval(timer);
    timer = setInterval(poll, intervalMs);
  }

  /* ------------------------------------------------------------------ tabs */

  // Processes and autostart entries are two views of the same question:
  // what is running, and what will run next time. Windows groups them in one
  // window too.
  const procBody = el('div', { class: 'tab-body' }, [
    el('div', { class: 'proc-toolbar' }, [search, summary]),
    el('div', { class: 'table-wrap grow' }, [
      el('table', { class: 'table' }, [thead, tbody])
    ])
  ]);

  const bodyHost = el('div', { class: 'tab-body' });
  const procActions = el('div', { class: 'view-actions' }, [
    el('span', { class: 'label', text: 'Intervall' }),
    intervalSelect,
    el('button', { class: 'btn subtle', text: 'Jetzt aktualisieren', onClick: () => poll() })
  ]);

  let startupPanel = null;
  let activeTab = 'processes';

  const tabBar = el('div', { class: 'tab-bar' }, [
    el('button', { class: 'tab active', dataset: { tab: 'processes' }, text: 'Prozesse' }),
    el('button', { class: 'tab', dataset: { tab: 'startup' }, text: 'Autostart' })
  ]);

  function showTab(id) {
    activeTab = id;
    tabBar.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
    clear(bodyHost);

    if (id === 'processes') {
      procActions.classList.remove('hidden');
      bodyHost.appendChild(procBody);
      // Polling costs a PowerShell round trip, so it only runs on this tab.
      poll();
      restart();
    } else {
      procActions.classList.add('hidden');
      if (timer) { clearInterval(timer); timer = null; }
      if (!startupPanel) startupPanel = createStartupPanel();
      bodyHost.appendChild(startupPanel);
    }
  }

  tabBar.addEventListener('click', (event) => {
    const button = event.target.closest('.tab');
    if (button && button.dataset.tab !== activeTab) showTab(button.dataset.tab);
  });

  const view = el('section', { class: 'view fixed-height', id: 'view-processes' }, [
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h2', { class: 'glitch', dataset: { text: 'Task Manager' }, text: 'Task Manager' }),
        el('div', { class: 'view-sub' }, [statusLine])
      ]),
      procActions
    ]),
    tabBar,
    bodyHost
  ]);

  renderHead();
  showTab('processes');

  view.addEventListener('view:unmount', () => {
    if (timer) clearInterval(timer);
    timer = null;
  });

  return view;
}
