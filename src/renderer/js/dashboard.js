import { el, clear, bytes, pct } from './util.js';
import { api } from './api.js';
import { Graph } from './widgets/graph.js';
import { Ring } from './widgets/ring.js';
import { countTo } from './motion.js';
import { createMediaBar } from './widgets/media.js';

/**
 * The second screen.
 *
 * Written to be read, not operated: there is no navigation, nothing to click,
 * and nothing that can take focus away from whatever is running on the other
 * monitor. Everything is sized for a glance from across the desk, which is why
 * the numbers are large and there are few of them.
 */

const root = document.getElementById('dash-root');

function bytesPerSec(value) {
  if (value === null || value === undefined) return '—';
  return `${bytes(value)}/s`;
}

/* ------------------------------------------------------------------ clock */

const clockTime = el('div', { class: 'dash-clock-time', text: '--:--' });
const clockDate = el('div', { class: 'dash-clock-date', text: '' });
const clockSeconds = el('div', { class: 'dash-clock-sec', text: '' });

function tickClock() {
  const now = new Date();
  clockTime.textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  clockSeconds.textContent = String(now.getSeconds()).padStart(2, '0');
  clockDate.textContent = now.toLocaleDateString('de-DE', {
    weekday: 'long', day: '2-digit', month: 'long'
  });
}

/* ------------------------------------------------------------------ gauges */

const cpuRing = new Ring({ caption: 'CPU' });
const ramRing = new Ring({ caption: 'RAM' });
const gpuRing = new Ring({ caption: 'GPU' });

const cpuCanvas = el('canvas', { class: 'graph-canvas' });
const netCanvas = el('canvas', { class: 'graph-canvas' });
let cpuGraph = null;
let netGraph = null;

const cpuDetail = el('div', { class: 'dash-detail' });
const ramDetail = el('div', { class: 'dash-detail' });
const gpuDetail = el('div', { class: 'dash-detail' });
const netDetail = el('div', { class: 'dash-detail' });

/* ------------------------------------------------------------------- lists */

const diskHost = el('div', { class: 'dash-disks' });
const profileHost = el('div', { class: 'dash-profiles' });
const processHost = el('tbody');

/* ----------------------------------------------------------------- render */

function renderMetrics(sample) {
  const cpu = sample.cpu ? sample.cpu.total : 0;
  const mem = sample.mem || { percent: 0, used: 0, total: 0 };
  const slow = sample.slow || {};

  cpuRing.set(cpu);
  ramRing.set(mem.percent);

  if (cpuGraph) cpuGraph.push(cpu);

  clear(cpuDetail);
  const cores = (sample.cpu && sample.cpu.cores) || [];
  cpuDetail.append(
    el('span', { text: `${cores.length} Kerne` }),
    slow.cpuTemp != null ? el('span', { text: `${Math.round(slow.cpuTemp)} °C` }) : null,
    el('span', { text: `Höchster Kern ${pct(Math.max(0, ...cores), 0)}` })
  );

  clear(ramDetail);
  ramDetail.append(
    el('span', { text: `${bytes(mem.used)} von ${bytes(mem.total)}` }),
    el('span', { text: `${bytes(mem.free)} frei` })
  );

  const gpu = (slow.gpu || [])[0];
  clear(gpuDetail);
  if (gpu && gpu.load != null) {
    gpuRing.set(gpu.load);
    gpuDetail.append(
      el('span', { class: 'truncate', text: gpu.model || 'Grafik' }),
      gpu.memUsed != null && gpu.memTotal
        ? el('span', { text: `${Math.round(gpu.memUsed)} von ${Math.round(gpu.memTotal)} MB` })
        : null,
      gpu.temp != null ? el('span', { text: `${Math.round(gpu.temp)} °C` }) : null
    );
  } else {
    gpuRing.set(0, '—');
    gpuDetail.append(el('span', { text: slow.gpuNote || 'Keine Werte verfügbar' }));
  }

  const net = slow.net;
  clear(netDetail);
  if (net) {
    if (netGraph) netGraph.push(net.rxSec, net.txSec);
    netDetail.append(
      el('span', {}, [el('b', { text: '↓' }), ` ${bytesPerSec(net.rxSec)}`]),
      el('span', {}, [el('b', { text: '↑' }), ` ${bytesPerSec(net.txSec)}`]),
      el('span', { class: 'truncate', text: net.iface || '' })
    );
  } else {
    netDetail.append(el('span', { text: 'Kein Netzwerk erkannt' }));
  }

  renderDisks(slow.disks || []);
}

function renderDisks(disks) {
  clear(diskHost);
  const shown = disks.filter((d) => d.size > 0).slice(0, 6);
  if (!shown.length) {
    diskHost.appendChild(el('div', { class: 'dash-empty', text: 'Keine Datenträger' }));
    return;
  }
  for (const disk of shown) {
    const used = Math.max(0, Math.min(100, disk.percent || 0));
    diskHost.appendChild(el('div', { class: 'dash-disk' }, [
      el('div', { class: 'row between' }, [
        el('span', { class: 'dash-disk-name truncate', text: disk.mount || disk.fs }),
        el('span', { class: 'dash-disk-pct', text: pct(used, 0) })
      ]),
      el('div', { class: 'dash-bar' }, [
        el('i', { class: used >= 90 ? 'danger' : used >= 75 ? 'warn' : '', style: { width: `${used}%` } })
      ]),
      el('div', { class: 'dash-disk-sub', text: `${bytes(disk.available)} frei von ${bytes(disk.size)}` })
    ]));
  }
}

/* ------------------------------------------------- profiles and processes */

let profiles = [];
let running = new Set();

function normalise(name) {
  return String(name || '').trim().replace(/\.(exe|com|bat|cmd)$/i, '').toLowerCase();
}

function renderProfiles() {
  clear(profileHost);
  if (!profiles.length) {
    profileHost.appendChild(el('div', { class: 'dash-empty', text: 'Keine Profile angelegt' }));
    return;
  }

  for (const profile of profiles.slice(0, 6)) {
    const apps = (profile.apps || []).filter((a) => a && a.enabled !== false);
    const named = apps
      .map((a) => normalise(a.processName || a.resolvedProcess))
      .filter(Boolean);
    const live = named.filter((n) => running.has(n));
    const state = !named.length ? 'unknown' : live.length === named.length ? 'running'
      : live.length ? 'partial' : 'idle';

    profileHost.appendChild(el('div', { class: `dash-profile ${state}` }, [
      el('div', { class: 'row between gap-8' }, [
        el('span', { class: 'dash-profile-name truncate', text: profile.name }),
        el('span', { class: 'dash-profile-state', text: {
          running: 'läuft', partial: 'teilweise', idle: 'gestoppt', unknown: 'unbekannt'
        }[state] })
      ]),
      el('div', { class: 'dash-profile-apps' }, apps.slice(0, 8).map((app) => {
        const name = normalise(app.processName || app.resolvedProcess);
        return el('span', {
          class: `dash-chip${name ? (running.has(name) ? ' live' : '') : ' untracked'}`,
          text: app.name
        });
      }))
    ]));
  }
}

function renderProcesses(rows) {
  clear(processHost);
  for (const row of rows.slice(0, 12)) {
    processHost.appendChild(el('tr', {}, [
      el('td', { class: 'truncate', text: row.name }),
      el('td', { class: 'num', text: pct(row.cpu, 1) }),
      el('td', { class: 'num', text: bytes(row.memory) })
    ]));
  }
  if (!rows.length) {
    processHost.appendChild(el('tr', {}, [el('td', { colspan: '3', text: 'Keine Daten' })]));
  }
}

/* -------------------------------------------------------------------- shell */

function panel(title, children, extraClass = '') {
  return el('section', { class: `dash-panel ${extraClass}` }, [
    el('div', { class: 'dash-panel-title', text: title }),
    ...children
  ]);
}

const mediaBar = createMediaBar({ compact: true });

function build() {
  clear(root);
  root.append(
    el('header', { class: 'dash-head' }, [
      el('div', { class: 'dash-brand' }, [
        el('span', { class: 'dash-brand-mark', text: 'HUB' }),
        el('span', { class: 'dash-brand-sub', text: 'Zweiter Bildschirm' })
      ]),
      el('div', { class: 'dash-clock' }, [
        el('div', { class: 'row', style: { alignItems: 'baseline', gap: '6px' } }, [clockTime, clockSeconds]),
        clockDate
      ])
    ]),

    el('div', { class: 'dash-grid' }, [
      panel('Auslastung', [
        el('div', { class: 'dash-rings' }, [cpuRing.node, ramRing.node, gpuRing.node]),
        el('div', { class: 'dash-details' }, [cpuDetail, ramDetail, gpuDetail]),
        el('div', { class: 'dash-graph' }, [cpuCanvas])
      ], 'span-2'),

      panel('Netzwerk', [
        el('div', { class: 'dash-graph tall' }, [netCanvas]),
        netDetail
      ]),

      panel('Datenträger', [diskHost]),

      panel('Profile', [mediaBar.node, profileHost]),

      panel('Aktivste Prozesse', [
        el('div', { class: 'table-wrap' }, [
          el('table', { class: 'table dash-table' }, [
            el('thead', {}, [el('tr', {}, [
              el('th', { text: 'Prozess' }),
              el('th', { style: { textAlign: 'right' }, text: 'CPU' }),
              el('th', { style: { textAlign: 'right' }, text: 'Speicher' })
            ])]),
            processHost
          ])
        ])
      ])
    ])
  );

  cpuGraph = new Graph(cpuCanvas, { capacity: 120, max: 100 });
  netGraph = new Graph(netCanvas, { capacity: 120, autoScale: true, color2: 'var(--accent-2)' });
}

/* --------------------------------------------------------------------- run */

let processTimer = null;
let statusTimer = null;

/**
 * Profiles first, live state second.
 *
 * The profile list comes from a file and is instant; finding out which
 * programs are running needs a system query that can take a minute on a busy
 * machine. Waiting for both before drawing anything left the second screen
 * blank for exactly as long as the slow half took — which is the same mistake
 * the file manager's sidebar made.
 */
async function refreshProfiles() {
  try {
    const data = await api.profiles.list();
    profiles = data.profiles || [];
    renderProfiles();
  } catch (_) { /* keep what we have */ }

  try {
    const data = await api.processes.running();
    running = new Set((data.names || []).map(normalise));
    renderProfiles();
  } catch (_) { /* the profiles stay on screen without their live state */ }
}

async function refreshProcesses() {
  try {
    const data = await api.processes.list();
    const rows = (data.processes || []).slice().sort((a, b) => b.cpu - a.cpu);
    renderProcesses(rows);
  } catch (_) { /* leave the last list on screen */ }
}

async function init() {
  build();
  tickClock();
  setInterval(tickClock, 1000);

  // The board is a metrics consumer in its own right, so the collector must
  // keep running even when the hub window is hidden behind a game.
  await api.metrics.subscribe().catch(() => {});
  api.metrics.onSample((sample) => renderMetrics(sample));

  const snapshot = await api.metrics.snapshot().catch(() => null);
  if (snapshot) renderMetrics(snapshot);

  // Neither of these blocks the board from appearing: both need system
  // queries, and an empty screen while they run is the worst of both.
  refreshProfiles();
  refreshProcesses();

  // Slower than the hub's own table: nobody reads a second screen at 3 s.
  processTimer = setInterval(refreshProcesses, 6000);
  statusTimer = setInterval(refreshProfiles, 8000);

  window.addEventListener('beforeunload', () => {
    if (processTimer) clearInterval(processTimer);
    if (statusTimer) clearInterval(statusTimer);
    api.metrics.unsubscribe().catch(() => {});
  });

  // Nothing here is meant to be operated, but a way out without the keyboard
  // shortcut is still worth having.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' || event.key === 'F11') api.dashboard.close().catch(() => {});
  });
}

init().catch((err) => {
  root.innerHTML = `<div style="padding:40px;font-family:monospace;color:#ff3b5c">${err.message}</div>`;
});
