/**
 * Translation between browser keyboard events and Electron accelerators.
 *
 * Physical `code` values are used rather than `key`, so a binding survives a
 * layout switch and does not depend on whether Shift was held when it was
 * recorded.
 */

const NAMED_KEYS = {
  Space: 'Space',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec'
};

function keyFromCode(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED_KEYS[code] || null;
}

/**
 * Returns an accelerator, or null while the event is not yet a usable
 * binding: a modifier on its own, an unmapped key, or a key with no modifier
 * at all. A bare key is rejected because registering it globally would
 * swallow it in every other application.
 */
export function toAccelerator(event) {
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');

  const key = keyFromCode(event.code);
  if (!key) return null;
  if (!modifiers.length) return null;

  return [...modifiers, key].join('+');
}

const DISPLAY = {
  Ctrl: 'Strg',
  Control: 'Strg',
  CommandOrControl: 'Strg',
  Shift: 'Umschalt',
  Alt: 'Alt',
  Super: 'Win',
  Return: 'Enter',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→'
};

/** German-facing rendering of an accelerator for the settings screen. */
export function formatAccelerator(accelerator) {
  if (!accelerator) return '';
  return accelerator
    .split('+')
    .map((part) => DISPLAY[part] || part)
    .join(' + ');
}
