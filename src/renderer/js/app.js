import { el, $, svg, clear } from './util.js';
import { api } from './api.js';
import {
  state, on, bindMetrics, loadSettings, loadProfiles, loadAppInfo, loadStaticInfo
} from './state.js';
import { runBoot } from './boot.js';
import { createHubView } from './views/hub.js';
import { createSystemView } from './views/system.js';
import { createProcessesView } from './views/processes.js';
import { createLibraryView } from './views/library.js';
import { createFilesView } from './views/files.js';
import { createOverlaysView } from './views/overlays.js';
import { createSettingsView } from './views/settings.js';
import { notifyError } from './widgets/toast.js';

/* ------------------------------------------------------------------ views */

const VIEWS = [
  {
    id: 'hub',
    label: 'Hub',
    icon: ['M4 13h7V4H4v9zM13 20h7v-9h-7v9zM13 4v5h7V4h-7zM4 20h7v-5H4v5z'],
    factory: createHubView,
    keep: true
  },
  {
    id: 'system',
    label: 'System',
    icon: ['M3 12h4l3 8 4-16 3 8h4'],
    factory: createSystemView,
    keep: true
  },
  {
    id: 'processes',
    label: 'Tasks',
    icon: ['M4 6h16M4 12h16M4 18h10', 'M18 16l2 2 3-3'],
    factory: createProcessesView,
    keep: false
  },
  {
    id: 'files',
    label: 'Files',
    icon: ['M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z'],
    factory: createFilesView,
    keep: true
  },
  {
    id: 'overlays',
    label: 'Overlay',
    icon: ['M4 5h11v10H4z', 'M9 9h11v10H9z'],
    factory: createOverlaysView,
    keep: false
  },
  {
    id: 'library',
    label: 'Library',
    icon: ['M6 4h12v16H6z', 'M9 4v16'],
    factory: createLibraryView,
    keep: true
  },
  {
    id: 'settings',
    label: 'Setup',
    icon: [
      'M12 15a3 3 0 100-6 3 3 0 000 6z',
      'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 8.6a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 008.92 4.3 1.65 1.65 0 0010 2.79V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V10a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z'
    ],
    factory: createSettingsView,
    keep: false
  }
];

const mounted = new Map();
let currentId = null;

function showView(id) {
  const def = VIEWS.find((v) => v.id === id);
  if (!def) return;

  const main = $('#main');
  const previous = mounted.get(currentId);
  if (previous) {
    // Views opt into being kept alive; the rest are torn down so their polling
    // loops stop when they are not on screen.
    previous.dispatchEvent(new CustomEvent('view:unmount'));
    previous.remove();
    const previousDef = VIEWS.find((v) => v.id === currentId);
    if (!previousDef || !previousDef.keep) mounted.delete(currentId);
  }

  let node = def.keep ? mounted.get(id) : null;
  const isNew = !node;
  if (!node) {
    node = def.factory();
    mounted.set(id, node);
  }
  main.appendChild(node);
  // A kept view is re-attached rather than rebuilt, so it needs a signal to
  // restore anything its unmount handler tore down.
  if (!isNew) node.dispatchEvent(new CustomEvent('view:mount'));

  currentId = id;
  state.activeView = id;

  document.querySelectorAll('.rail-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === id);
  });
}

function buildRail() {
  const rail = $('#rail');
  clear(rail);
  VIEWS.forEach((def, index) => {
    if (index === VIEWS.length - 1) rail.appendChild(el('div', { class: 'rail-spacer' }));
    rail.appendChild(el('button', {
      class: 'rail-btn',
      dataset: { view: def.id },
      title: `${def.label} (Alt+${index + 1})`,
      onClick: () => showView(def.id)
    }, [svg(def.icon), el('span', { text: def.label })]));
  });
}

/* ------------------------------------------------------------- top bar UI */

function bindTopbar() {
  $('#btn-minimize').addEventListener('click', () => api.window.minimize().catch(() => {}));
  $('#btn-fullscreen').addEventListener('click', () => api.window.toggleFullscreen().catch(() => {}));
  $('#btn-close').addEventListener('click', async () => {
    if (state.settings && state.settings.confirmExit) {
      const { confirmDialog } = await import('./widgets/modal.js');
      const sure = await confirmDialog({
        title: 'Hub beenden',
        message: 'Der Hub wird geschlossen. Laufende Spiele und Programme bleiben offen.',
        confirmLabel: 'Beenden',
        danger: true
      });
      if (!sure) return;
    }
    api.window.close().catch(() => {});
  });

  const cpuValue = $('#mini-cpu');
  const cpuBar = $('#mini-cpu-meter').querySelector('i');
  const ramValue = $('#mini-ram');
  const ramBar = $('#mini-ram-meter').querySelector('i');
  const gpuValue = $('#mini-gpu');
  const gpuBar = $('#mini-gpu-meter').querySelector('i');
  const gpuWrap = $('#mini-gpu-wrap');

  on('metrics', (sample) => {
    const cpu = sample.cpu ? sample.cpu.total : 0;
    const ram = sample.mem ? sample.mem.percent : 0;
    cpuValue.textContent = `${cpu.toFixed(0)}%`;
    cpuBar.style.width = `${cpu}%`;
    ramValue.textContent = `${ram.toFixed(0)}%`;
    ramBar.style.width = `${ram}%`;

    const gpu = (sample.slow && sample.slow.gpu || [])[0];
    if (gpu && gpu.load != null) {
      gpuWrap.classList.remove('hidden');
      gpuValue.textContent = `${Math.round(gpu.load)}%`;
      gpuBar.style.width = `${gpu.load}%`;
    } else {
      gpuWrap.classList.add('hidden');
    }
  });
}

function startClock() {
  const time = $('#clock-time');
  const date = $('#clock-date');
  const tick = () => {
    const now = new Date();
    time.textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    date.textContent = now.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase();
  };
  tick();
  setInterval(tick, 1000);
}

function bindShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (event.altKey && !event.ctrlKey && !event.shiftKey) {
      const index = Number(event.key) - 1;
      if (index >= 0 && index < VIEWS.length) {
        event.preventDefault();
        showView(VIEWS[index].id);
      }
    }
    if (event.key === 'F5') {
      event.preventDefault();
      location.reload();
    }
    // Handled here rather than as a global shortcut, so F11 keeps working in
    // every other application on the system.
    if (event.key === 'F11') {
      event.preventDefault();
      api.window.toggleFullscreen().catch(() => {});
    }
  });

  // Block the browser context menu; this is an appliance, not a web page.
  document.addEventListener('contextmenu', (event) => event.preventDefault());

  // Block accidental zoom from a trackpad or Ctrl+wheel.
  document.addEventListener('wheel', (event) => {
    if (event.ctrlKey) event.preventDefault();
  }, { passive: false });
}

/* ------------------------------------------------------------------- init */

async function init() {
  window.addEventListener('error', (event) => {
    console.error(event.error || event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    notifyError(event.reason && event.reason.message ? event.reason.message : String(event.reason));
  });

  let settings = null;
  try {
    settings = await loadSettings();
  } catch (err) {
    console.error('settings failed', err);
  }

  await runBoot({
    enabled: !settings || settings.bootAnimation !== false,
    tasks: [
      () => loadAppInfo().catch(() => {}),
      () => loadProfiles().catch(() => {}),
      () => loadStaticInfo().catch(() => {})
    ]
  });

  const versionNode = $('#brand-version');
  if (versionNode && state.appInfo) versionNode.textContent = `v${state.appInfo.version}`;

  bindMetrics();
  bindTopbar();
  startClock();
  bindShortcuts();
  buildRail();
  showView('hub');
}

init().catch((err) => {
  console.error(err);
  document.body.innerHTML =
    `<div style="padding:40px;font-family:monospace;color:#ff3b5c">Hub konnte nicht starten: ${err.message}</div>`;
});
