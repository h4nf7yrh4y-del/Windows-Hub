import { el, $, sleep } from '../util.js';
import { pushAccent, resetAccent } from '../state.js';

/**
 * Fullscreen boot-style overlay shown while a profile launches.
 * Driven purely by the `profile:progress` events coming from main.
 */
export class LaunchOverlay {
  constructor(profile) {
    this.profile = profile;
    this.stepNodes = new Map();
    this.total = (profile.apps || []).filter((a) => a.enabled !== false).length;

    this.stepsHost = el('div', { class: 'lo-steps' });
    this.bar = el('i');
    this.sub = el('div', { class: 'lo-sub', text: 'Initialisiere Sequenz' });

    this.node = el('div', { id: 'launch-overlay' }, [
      el('div', { class: 'lo-sub', text: 'Profil wird gestartet' }),
      el('div', {
        class: 'lo-title glitch',
        dataset: { text: profile.name },
        text: profile.name,
        style: { color: profile.accent || 'var(--accent)' }
      }),
      el('div', { class: 'lo-progress' }, [this.bar]),
      this.stepsHost,
      this.sub,
      el('button', {
        class: 'btn subtle sm',
        text: 'Ausblenden',
        onClick: () => this.destroy()
      })
    ]);
  }

  open() {
    pushAccent(this.profile.accent);
    document.body.appendChild(this.node);
    const steps = (this.profile.apps || []).filter((a) => a.enabled !== false);
    steps.forEach((step, index) => {
      const node = el('div', { class: 'lo-step pending' }, [
        el('span', { class: 'lo-icon', text: '·' }),
        el('span', { text: step.name }),
        el('span', { class: 'lo-note', text: step.delayMs ? `+${(step.delayMs / 1000).toFixed(1)}s` : '' })
      ]);
      node.style.animationDelay = `${index * 45}ms`;
      this.stepNodes.set(index, node);
      this.stepsHost.appendChild(node);
    });
    return this;
  }

  _setStep(index, cls, icon, note) {
    const node = this.stepNodes.get(index);
    if (!node) return;
    node.className = `lo-step ${cls}`;
    node.querySelector('.lo-icon').textContent = icon;
    if (note !== undefined) node.querySelector('.lo-note').textContent = note;
  }

  handle(event) {
    const done = event.index != null ? event.index : 0;
    if (this.total) this.bar.style.width = `${Math.min(100, ((done + (event.phase === 'done' ? 1 : 0)) / this.total) * 100)}%`;

    switch (event.phase) {
      case 'wait':
        this._setStep(event.index, 'active', '~', `warte ${(event.waitMs / 1000).toFixed(1)}s`);
        this.sub.textContent = `Warte auf Zeitfenster für ${event.step.name}`;
        break;
      case 'launch':
        this._setStep(event.index, 'active', '>', 'startet');
        this.sub.textContent = `Starte ${event.step.name}`;
        break;
      case 'done':
        this._setStep(event.index, event.ok ? 'done' : 'failed', event.ok ? '✓' : '✕', event.ok ? 'ok' : event.error);
        break;
      case 'aborted':
        this.sub.textContent = `Abgebrochen: ${event.error}`;
        break;
      case 'finished':
        this.bar.style.width = '100%';
        this.sub.textContent = 'Sequenz abgeschlossen';
        break;
      default:
        break;
    }
  }

  async finish(delay = 900) {
    await sleep(delay);
    this.destroy();
  }

  destroy() {
    resetAccent();
    if (this.node.isConnected) {
      this.node.style.animation = 'fade-in 200ms reverse both';
      setTimeout(() => this.node.remove(), 200);
    }
  }
}

export function currentOverlay() {
  return $('#launch-overlay');
}
