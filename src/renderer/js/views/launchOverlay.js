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
        el('span', { class: 'lo-note', text: [
          step.delayMs ? `+${(step.delayMs / 1000).toFixed(1)}s` : '',
          step.waitFor === 'process' ? 'wartet' : '',
          step.waitFor === 'window' ? 'wartet auf Fenster' : ''
        ].filter(Boolean).join(' · ') })
      ]);
      node.style.animationDelay = `${index * 45}ms`;
      this.stepNodes.set(index, node);
      this.stepsHost.appendChild(node);
    });
    return this;
  }

  /**
   * One extra row above the programs for everything the profile does to the
   * machine. It only appears when a profile actually asks for something, so a
   * plain profile keeps the same overlay it always had.
   */
  _prep(cls, icon, text, note) {
    if (!this.prepNode) {
      this.prepNode = el('div', { class: 'lo-step pending' }, [
        el('span', { class: 'lo-icon', text: '·' }),
        el('span', { text: 'Systemzustand' }),
        el('span', { class: 'lo-note', text: '' })
      ]);
      this.stepsHost.insertBefore(this.prepNode, this.stepsHost.firstChild);
    }
    this.prepNode.className = `lo-step ${cls}`;
    this.prepNode.querySelector('.lo-icon').textContent = icon;
    this.prepNode.children[1].textContent = text;
    if (note !== undefined) this.prepNode.querySelector('.lo-note').textContent = note;
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
    // A step counts as done once it has been launched, so the phases that come
    // after that for the same index must not walk the bar back to where it was.
    const past = ['done', 'awaiting', 'ready'].includes(event.phase) ? 1 : 0;
    if (this.total) this.bar.style.width = `${Math.min(100, ((done + past) / this.total) * 100)}%`;

    switch (event.phase) {
      case 'tweak':
        if (event.step === 'close') {
          this._prep('active', '>', 'Hintergrundprogramme beenden', `${(event.names || []).length} Namen`);
        } else if (event.step === 'power') {
          this._prep('active', '>', 'Energieplan umstellen', '');
        }
        this.sub.textContent = 'Bereite das System vor';
        break;
      case 'tweaks': {
        const report = event.report || { applied: [], failed: [] };
        const failed = report.failed || [];
        this._prep(
          failed.length ? 'failed' : 'done',
          failed.length ? '✕' : '✓',
          'Systemzustand',
          failed.length ? failed[0] : (report.applied || []).join(' · ')
        );
        break;
      }
      case 'priority':
        this.sub.textContent = `Priorität ${event.priority} für ${event.name} gesetzt`;
        break;
      case 'desktop':
        if (event.step === 'hold') {
          this._prep('active', '>', 'Desktop merken', '');
          this.sub.textContent = 'Merke, wo die Fenster liegen';
        } else {
          this._prep('done', '✓', 'Systemzustand',
            event.count ? `${event.count} Fenster gemerkt` : (event.error || event.reason || ''));
        }
        break;
      case 'wait':
        this._setStep(event.index, 'active', '~', `warte ${(event.waitMs / 1000).toFixed(1)}s`);
        this.sub.textContent = `Warte auf Zeitfenster für ${event.step.name}`;
        break;
      // Waiting for the program itself, which is the one step whose length
      // nobody chose: the note says what is being waited for, not a countdown,
      // because a countdown would be the guess this replaces.
      case 'awaiting':
        this._setStep(event.index, 'active', '~',
          event.kind === 'window' ? 'warte auf Fenster' : 'warte auf Prozess');
        this.sub.textContent = event.kind === 'window'
          ? `Warte auf das Fenster von ${event.step.name}`
          : `Warte darauf, dass ${event.step.name} läuft`;
        break;
      case 'ready':
        if (!event.waited) {
          // Not an error: the entry simply has nothing the hub could watch for,
          // and saying so beats a tick that claims a wait that never happened.
          this._setStep(event.index, 'done', '✓', event.reason || 'ohne Warten');
        } else if (event.ok) {
          this._setStep(event.index, 'done', '✓', `da nach ${(event.ms / 1000).toFixed(1)}s`);
        } else {
          this._setStep(event.index, 'done', '✓', event.reason || 'nicht erkannt');
          this.sub.textContent = `${event.step.name} war nicht rechtzeitig da, es geht weiter`;
        }
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
