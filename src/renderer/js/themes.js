/**
 * Named colour sets.
 *
 * The two accent colours were always adjustable, but picking a pair that works
 * together from a colour wheel is a job, not a setting. These are pairs that
 * have been checked against the interface: enough contrast on the dark
 * background, and a second colour that reads as a counterpart rather than as a
 * second first colour.
 *
 * `effects` is part of a theme deliberately. A scan-line CRT look and a clean
 * monochrome one are not the same thing with different hues.
 */

export const THEMES = [
  {
    id: 'cyberpunk',
    label: 'Cyberpunk',
    hint: 'Cyan und Magenta, Scanlines an',
    accent: '#00f0ff',
    accent2: '#ff2e88',
    effects: { scanlines: true, grid: true }
  },
  {
    id: 'synthwave',
    label: 'Synthwave',
    hint: 'Violett über Magenta',
    accent: '#b967ff',
    accent2: '#ff3d9a',
    effects: { scanlines: true, grid: true }
  },
  {
    id: 'matrix',
    label: 'Matrix',
    hint: 'Grün auf Schwarz',
    accent: '#26e08a',
    accent2: '#7cff6b',
    effects: { scanlines: true, grid: false }
  },
  {
    id: 'ember',
    label: 'Ember',
    hint: 'Orange und Bernstein, warm',
    accent: '#ff6b35',
    accent2: '#ffb400',
    effects: { scanlines: false, grid: true }
  },
  {
    id: 'ice',
    label: 'Ice',
    hint: 'Kühles Blau, ruhig',
    accent: '#4d9fff',
    accent2: '#8ad7ff',
    effects: { scanlines: false, grid: true }
  },
  {
    id: 'mono',
    label: 'Mono',
    hint: 'Ohne Farbe, ohne Effekte',
    accent: '#c8d4e0',
    accent2: '#8fa3b8',
    effects: { scanlines: false, grid: false }
  }
];

export function findTheme(id) {
  return THEMES.find((theme) => theme.id === id) || null;
}

/**
 * The theme a set of settings corresponds to, or null for a hand-picked pair.
 *
 * Matching on the colours rather than storing the name means an older
 * configuration lands on the right preset, and a user who nudges one colour is
 * correctly shown as being on none of them.
 */
export function matchTheme(settings) {
  if (!settings) return null;
  return THEMES.find((theme) =>
    theme.accent.toLowerCase() === String(settings.accent || '').toLowerCase()
    && theme.accent2.toLowerCase() === String(settings.accent2 || '').toLowerCase()) || null;
}

/** The settings patch a theme stands for. */
export function themePatch(theme) {
  return {
    accent: theme.accent,
    accent2: theme.accent2,
    scanlines: theme.effects.scanlines,
    grid: theme.effects.grid
  };
}
