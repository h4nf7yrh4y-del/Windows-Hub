'use strict';

const { collect } = require('./generated-ps');

/**
 * The part of the PowerShell check that needs no PowerShell.
 *
 * `test/powershell.test.js` hands every generated script to PowerShell's own
 * parser, which is the real check -- and it skips itself entirely when no
 * PowerShell is installed. On a Linux workstation that is always, so a newly
 * written script can be committed with nothing having looked at it, and the
 * build is the first thing to run it. That happened: `$${entry.maximized}`
 * became `$'PLACEHOLDER'` and failed on both runners, after passing a local
 * `npm test` that had quietly checked nothing.
 *
 * These two faults need no parser to spot and are never valid PowerShell, so
 * they run everywhere, on every lint.
 */

const FAULTS = [
  {
    // `$` directly against a quote. PowerShell has `$(` for a subexpression
    // and `$name` for a variable; `$'` and `$"` are neither, and the way to
    // write one by accident is to weld a `$` onto an interpolation.
    pattern: /\$['"]/,
    what: 'ein $ direkt vor einem Anführungszeichen',
    why: 'Sieht nach $${...} im Quelltext aus: baue den Wert als "$true"/"$false" statt ein $ an eine Einsetzung zu kleben.'
  },
  {
    // The filler resolves nesting in several passes; anything left over is a
    // template it could not read, and no generated script here uses the
    // `${name}` form that PowerShell itself understands.
    pattern: /\$\{/,
    what: 'eine nicht aufgelöste JavaScript-Einsetzung',
    why: 'Die Einsetzung ist zu tief verschachtelt oder unvollständig geschrieben.'
  }
];

/** What is wrong with one already-filled script, if anything. */
function faultsIn(script) {
  const text = String(script || '');
  if (!text.trim()) return [{ what: 'das erzeugte Skript ist leer', why: '', line: 1 }];

  const found = [];
  for (const fault of FAULTS) {
    const match = fault.pattern.exec(text);
    if (!match) continue;
    found.push({
      what: fault.what,
      why: fault.why,
      line: text.slice(0, match.index).split('\n').length
    });
  }
  return found;
}

function main() {
  const scripts = collect();
  const problems = [];

  for (const entry of scripts) {
    for (const fault of faultsIn(entry.script)) {
      problems.push(`${entry.name} (${entry.file}), Zeile ${fault.line}: ${fault.what}`
        + (fault.why ? `\n    ${fault.why}` : ''));
    }
  }

  if (problems.length) {
    console.error('Erzeugte PowerShell-Skripte:');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(`\n${problems.length} Problem(e) in ${scripts.length} Skripten.`);
    process.exit(1);
  }

  console.log(`PowerShell-Skripte OK: ${scripts.length} Skripte, ${FAULTS.length} Prüfungen.`);
}

// Importable for its own test; only checks the tree when run as the lint step.
if (require.main === module) main();

module.exports = { faultsIn, FAULTS };
