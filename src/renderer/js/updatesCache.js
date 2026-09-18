/**
 * The last winget count anyone actually paid for.
 *
 * `updates.js`'s own scan can take the better part of a minute on a cold
 * cache -- accepted there because opening the Updates view is a deliberate
 * choice. It must not become a hidden cost of anything else, the hub's
 * attention card included: that card reads this and never triggers a scan
 * of its own, so it says "0" only when a scan genuinely found nothing, and
 * says nothing at all rather than guess when no one has checked yet.
 */

let cache = null; // { actionable } | null

export function rememberWinget(actionable) {
  cache = { actionable: Number(actionable) || 0 };
}

export function wingetCache() {
  return cache;
}
