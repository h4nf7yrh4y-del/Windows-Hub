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
import { createWindowsView } from './views/windows.js';
import { createSettingsView } from './views/settings.js';
import { notifyError } from './widgets/toast.js';
import { countTo, createRailIndicator, enterView, bindParallax } from './motion.js';
import { initGamepad, setGamepadEnabled } from './gamepad.js';
import { createPalette } from './palette.js';

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
    id: 'windows',
    label: 'Windows',
    icon: ['M3 5h18v14H3z', 'M12 5v14M3 12h18'],
    factory: createWindowsView,
    keep: false
  },
  {
    id: 'claude',
    label: 'Claude',
    icon: ['M12 3l2.4 5.6L20 11l-5.6 2.4L12 19l-2.4-5.6L4 11l5.6-2.4z'],
    // Opens its own window instead of switching the view: the console is
    // something you keep beside other work, not a page in a launcher.
    opens: () => api.claude.openWindow()
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
let railIndicator = null;

function showView(id) {
  const def = VIEWS.find((v) => v.id === id);
  if (!def) return;

  // Entries that open a window are actions, not destinations; the current
  // view stays where it is.
  if (typeof def.opens === 'function') {
    def.opens().catch((err) => notifyError(err.message));
    return;
  }

  // Direction comes from the rail order, so a view slides in from the side
  // it actually sits on rather than always rising from below.
  const fromIndex = VIEWS.findIndex((v) => v.id === currentId);
  const toIndex = VIEWS.findIndex((v) => v.id === id);
  const direction = fromIndex >= 0 && toIndex < fromIndex ? 'up' : 'down';

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

  enterView(node, direction);

  currentId = id;
  state.activeView = id;

  let activeButton = null;
  document.querySelectorAll('.rail-btn').forEach((btn) => {
    const isActive = btn.dataset.view === id;
    btn.classList.toggle('active', isActive);
    if (isActive) activeButton = btn;
  });
  if (railIndicator) railIndicator.move(activeButton);
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

/**
 * The second-screen button.
 *
 * Only shown once a second monitor exists: on a single-screen machine the
 * dashboard would open on top of the hub, which is not a feature.
 */
async function bindDashboardButton() {
  const button = $('#btn-dashboard');
  if (!button) return;

  const paint = (status) => {
    const useful = status && !status.onlyOneDisplay;
    button.classList.toggle('hidden', !useful);
    button.classList.toggle('active', !!(status && status.open));
    button.title = status && status.open
      ? `Dashboard auf „${status.displayLabel}" schließen`
      : `Dashboard auf „${status && status.displayLabel}" öffnen`;
  };

  try {
    paint(await api.dashboard.status());
  } catch (_) { /* leave it hidden */ }

  api.dashboard.onChanged((status) => paint(status));
  button.addEventListener('click', async () => {
    try {
      await api.dashboard.toggle();
      paint(await api.dashboard.status());
    } catch (err) { notifyError(err.message); }
  });
}

function bindTopbar() {
  const paletteButton = $('#btn-palette');
  if (paletteButton) paletteButton.addEventListener('click', () => openPalette());

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

  const asPercent = (v) => `${Math.round(v)}%`;

  on('metrics', (sample) => {
    const cpu = sample.cpu ? sample.cpu.total : 0;
    const ram = sample.mem ? sample.mem.percent : 0;
    countTo(cpuValue, cpu, { format: asPercent });
    cpuBar.style.width = `${cpu}%`;
    countTo(ramValue, ram, { format: asPercent });
    ramBar.style.width = `${ram}%`;

    // The background reacts to what the machine is doing. It costs nothing —
    // the numbers are already here — and it means the hub looks busy when the
    // machine is, which is the whole point of having it on a second screen.
    const gpuLoad = (sample.slow && sample.slow.gpu || [])[0];
    const load = Math.max(cpu, ram * 0.6, gpuLoad && gpuLoad.load != null ? gpuLoad.load : 0);
    document.documentElement.style.setProperty('--load', (load / 100).toFixed(3));

    const gpu = gpuLoad;
    if (gpu && gpu.load != null) {
      gpuWrap.classList.remove('hidden');
      countTo(gpuValue, gpu.load, { format: asPercent });
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

let openPalette = () => {};

function bindShortcuts() {
  document.addEventListener('keydown', (event) => {
    // Ctrl+K is the one binding people try without being told.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'k' || event.key === 'K')) {
      event.preventDefault();
      openPalette();
      return;
    }
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
  // Renderer failures are forwarded to the log file; otherwise they exist
  // only in a devtools console nobody has open on the user's machine.
  window.addEventListener('error', (event) => {
    const error = event.error || {};
    console.error(error.message || event.message);
    api.diagnostics.report({
      level: 'error',
      message: error.message || String(event.message),
      stack: error.stack || `${event.filename}:${event.lineno}:${event.colno}`
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason || {};
    const message = reason.message ? reason.message : String(event.reason);
    notifyError(message);
    api.diagnostics.report({ level: 'error', message, stack: reason.stack || null });
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

  openPalette = createPalette({ showView });

  bindMetrics();
  bindTopbar();
  initGamepad({
    onToggleOverlays: () => api.overlays.toggle().catch((err) => notifyError(err.message))
  });
  setGamepadEnabled(!settings || settings.gamepad !== false);
  startClock();
  bindShortcuts();
  buildRail();
  railIndicator = createRailIndicator($('#rail'));
  bindParallax($('#fx-layer'));
  showView('hub');

  // A window resize moves the rail buttons; the indicator has to follow.
  window.addEventListener('resize', () => {
    const active = document.querySelector('.rail-btn.active');
    if (railIndicator) railIndicator.move(active, { instant: true });
  });
}

init().catch((err) => {
  console.error(err);
  document.body.innerHTML =
    `<div style="padding:40px;font-family:monospace;color:#ff3b5c">Hub konnte nicht starten: ${err.message}</div>`;
});
