import { el, svg } from '../util.js';

const CLOSE_ICON = 'M6 6l12 12M18 6L6 18';

/**
 * Opens a modal. `render(close)` returns the body node; `actions(close)`
 * returns footer buttons. Escape and backdrop clicks close it.
 */
export function openModal({ title, render, actions, width, onClose }) {
  const backdrop = el('div', { class: 'modal-backdrop' });

  const close = (result) => {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (typeof onClose === 'function') onClose(result);
  };

  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(null);
    }
  }

  const body = el('div', { class: 'modal-body' });
  const content = typeof render === 'function' ? render(close) : render;
  if (content) body.appendChild(content);

  const modal = el('div', { class: 'modal', style: width ? { width } : {} }, [
    el('div', { class: 'modal-head' }, [
      el('h3', { text: title || '' }),
      el('button', { class: 'icon-btn', title: 'Schließen', onClick: () => close(null) }, [svg(CLOSE_ICON, { width: 16, height: 16 })])
    ]),
    body
  ]);

  const footerNodes = typeof actions === 'function' ? actions(close) : actions;
  if (footerNodes) modal.appendChild(el('div', { class: 'modal-foot' }, footerNodes));

  backdrop.appendChild(modal);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close(null);
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);

  const focusTarget = modal.querySelector('input, select, textarea, button.primary');
  if (focusTarget) focusTarget.focus();

  return { close, modal, body };
}

/** Yes/no dialog. Resolves true only when the user confirms. */
export function confirmDialog({ title, message, confirmLabel = 'Bestätigen', danger = false, width = '460px' }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

    openModal({
      title,
      width,
      // Blank lines become paragraphs. A confirmation that has to explain
      // several things — what will be closed, what cannot be — is unreadable
      // as one block, and textContent would swallow the line breaks anyway.
      render: () => el('div', { class: 'stack gap-8' }, String(message).split(/\n{2,}/).map((part, index) =>
        el('div', {
          text: part,
          style: { fontSize: index === 0 ? '13.5px' : '12.5px', lineHeight: '1.6', color: index === 0 ? '' : 'var(--text-dim)' }
        })
      )),
      actions: (close) => [
        el('button', { class: 'btn subtle', text: 'Abbrechen', onClick: () => { finish(false); close(); } }),
        el('button', {
          class: `btn ${danger ? 'danger' : 'primary'}`,
          text: confirmLabel,
          onClick: () => { finish(true); close(); }
        })
      ],
      onClose: () => finish(false)
    });
  });
}
