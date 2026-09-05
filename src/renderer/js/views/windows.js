import { el, clear } from '../util.js';
import { createDisplaysPanel } from './displays.js';
import { createFeaturesPanel } from './features.js';

/**
 * Shell for the two Windows-facing panels. They share a rail entry because
 * neither fills a screen on its own and both answer the same question: what
 * can I change about this machine.
 */
export function createWindowsView() {
  const bodyHost = el('div', { class: 'tab-body' });
  const panels = new Map();
  let activeTab = 'displays';

  const tabBar = el('div', { class: 'tab-bar' }, [
    el('button', { class: 'tab active', dataset: { tab: 'displays' }, text: 'Bildschirme' }),
    el('button', { class: 'tab', dataset: { tab: 'features' }, text: 'Funktionen' })
  ]);

  function showTab(id) {
    activeTab = id;
    tabBar.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
    clear(bodyHost);
    if (!panels.has(id)) {
      panels.set(id, id === 'displays' ? createDisplaysPanel() : createFeaturesPanel());
    }
    bodyHost.appendChild(panels.get(id));
  }

  tabBar.addEventListener('click', (event) => {
    const button = event.target.closest('.tab');
    if (button && button.dataset.tab !== activeTab) showTab(button.dataset.tab);
  });

  const view = el('section', { class: 'view fixed-height', id: 'view-windows' }, [
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h2', { class: 'glitch', dataset: { text: 'Windows' }, text: 'Windows' }),
        el('div', { class: 'view-sub', text: 'Bildschirme und Systemfunktionen' })
      ])
    ]),
    tabBar,
    bodyHost
  ]);

  view.addEventListener('view:unmount', () => {
    for (const panel of panels.values()) panel.dispatchEvent(new CustomEvent('panel:dispose'));
    panels.clear();
    clear(bodyHost);
  });

  showTab('displays');
  return view;
}
