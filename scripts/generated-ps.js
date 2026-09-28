'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The PowerShell the app assembles at runtime, pulled out of the sources.
 *
 * Shared between `psscripts-check.js`, which is structural and runs
 * everywhere, and `test/powershell.test.js`, which hands the same scripts to
 * PowerShell's own parser and therefore only runs where PowerShell exists.
 * One copy, because the two would otherwise drift and the cheap check would
 * stop covering what the expensive one covers.
 */

const ROOT = path.join(__dirname, '..');

// Every source that builds a script inline. A file missing from this list is
// a script nobody checks, which is the failure mode worth avoiding.
const SOURCES = [
  'src/main/files.js',
  'src/main/scanner.js',
  'src/main/winfeatures.js',
  'src/main/display.js',
  'src/main/windowlayout.js'
];

/**
 * Replaces the JavaScript interpolations with values of the right shape.
 *
 * The type is guessed from the text of the interpolation, because there is
 * nothing else to go on without executing the surrounding code. That guess is
 * why this exists at all: `$${entry.maximized ? ...}` was substituted as a
 * string and became `$'PLACEHOLDER'`, which no PowerShell parser accepts.
 */
function fillPlaceholders(block) {
  let out = block.replace(/\$\{preamble\(paths\)\}/g, '');
  // Interpolations nest, so the innermost are replaced first and the pass is
  // repeated until none are left.
  for (let pass = 0; pass < 8 && out.includes('${'); pass += 1) {
    out = out.replace(/\$\{[^{}]*\}/g, (match) => (
      // Anything naming a path, device or identifier stands in as a string;
      // everything else is treated as a number.
      /psLiteral|device|path|name|target|entry|spec|args/i.test(match)
        ? "'PLACEHOLDER'"
        : '50'
    ));
  }
  return out;
}

/** Every inline script, named by its file and position within it. */
function collect() {
  const found = [];
  for (const file of SOURCES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const blocks = [...source.matchAll(/runPowerShell\(\s*(?:String\.raw)?`([\s\S]*?)`/g)].map((m) => m[1]);
    blocks.forEach((block, index) => {
      found.push({
        name: `${path.basename(file)} #${index + 1}`,
        file,
        script: fillPlaceholders(block)
      });
    });
  }
  return found;
}

module.exports = { collect, fillPlaceholders, SOURCES };
