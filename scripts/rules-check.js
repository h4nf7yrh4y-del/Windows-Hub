#!/usr/bin/env node
'use strict';

/**
 * The rules from CLAUDE.md that a machine can check.
 *
 * Every rule in here was written down after it broke a build, and then broken
 * again afterwards -- twice within the same day, in one case hours after the
 * rule was added. A rule in a file is a note to whoever remembers to read it.
 * A rule in the lint step is one nobody can forget.
 *
 * Only patterns that are worth failing a build over belong here. Each one
 * carries the reason it exists, because a checker that says "line 42 violates
 * rule 3" teaches nobody anything, and the next person will work around it
 * rather than fix the cause.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Whether a line is commented out.
 *
 * Deliberately crude: it only has to tell a real line of code from the
 * comments in this repository, which explain the very patterns being looked
 * for and would otherwise report themselves.
 */
function isComment(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * One spelling for every path a rule sees: relative to the repository, forward
 * slashes, no leading separator -- `src/main/updates.js`.
 *
 * The first version let each rule match the raw path, which on the tree meant
 * an absolute one and in the tests a relative one. The predicates looked for a
 * separator before `src`, so against a relative path none of them matched, no
 * rule applied to any file, and the checker reported all ninety-four files
 * clean. A checker whose failure mode is silent approval is worse than none.
 */
function normalize(file) {
  return String(file).split(path.sep).join('/').replace(/^\.\//, '').replace(/^\//, '');
}

const RULES = [
  {
    id: 'platform-assertion',
    files: (p) => /^test\/[^/]+\.test\.js$/.test(p),
    // `.*` rather than `[^)]*`: the call being asserted on has its own
    // parentheses, and stopping at the first one missed every real case.
    pattern: /assert\.rejects\(.*,\s*\/[^/\n]*Windows[^/\n]*\//,
    message: 'Zusicherung „scheitert an der Plattform" in einem Logiktest',
    why: 'Unter Linux ist sie wahr, unter Windows sinnlos: dort gibt es keine Sperre, '
      + 'an der etwas scheitert, also tut der Aufruf, was er soll — einmal hat das den '
      + 'CI-Rechner aktualisiert, einmal fünf Minuten Testlauf gekostet. Prüfe stattdessen '
      + 'die Zurückweisung einer ungültigen Eingabe; die gilt überall gleich.'
  },
  {
    id: 'check-inside-call',
    files: (p) => p.startsWith('src/'),
    // shell.openExternal(pruefe(x)) and friends: a call as the sole argument
    // of a method on an object.
    pattern: /\b(?:shell|clipboard)\.\w+\(\s*[a-zA-Z_$][\w$]*\(/,
    message: 'Prüfung steht im Aufruf statt davor',
    why: 'JavaScript wertet erst den Methodenzugriff aus und dann das Argument, die '
      + 'Prüfung läuft also nach dem Zugriff. In der Anwendung fällt das nie auf, im Test '
      + 'ohne Electron sofort. Erst in eine Variable, dann übergeben.'
  },
  {
    id: 'clock-as-id',
    files: (p) => p.startsWith('src/'),
    pattern: /\bid:\s*[^,\n]*Date\.now\(\)/,
    message: 'Kennung aus der Uhr',
    why: 'Zwei Einträge in derselben Millisekunde teilen sich eine Kennung, und der '
      + 'zweite überschreibt den ersten stillschweigend. `crypto.randomUUID()` benutzen.'
  },
  {
    id: 'exact-count',
    files: (p) => p.startsWith('test/ui/'),
    /*
     * Deliberately narrow.
     *
     * The first version flagged every exact count and hit eleven perfectly good
     * assertions: one active theme card, zero rows after a filter, seven
     * weekdays. Those are invariants, not counts that drift. Whether a
     * collection grows when a feature is added is a semantic question and a
     * regular expression cannot answer it -- so this only names the two
     * collections that have actually broken, and stays quiet about the rest.
     * A checker that is wrong eleven times out of eleven teaches people to
     * ignore it.
     */
    pattern: /t\.eq\(await t\.count\(['"`][^'"`]*(?:rail-btn|upd-section|rail-item)[^'"`]*['"`]\),\s*\d+/,
    message: 'Zusicherung auf eine feste Anzahl in einer wachsenden Liste',
    why: 'Die Seitenleiste und die Abschnitte des Update-Centers wachsen mit jedem '
      + 'Feature. Beide Zusicherungen sind genau daran schon gebrochen, und zwar aus dem '
      + 'einzigen Grund, der kein Fehler ist. `t.atLeast` benutzen und zusätzlich prüfen, '
      + 'was namentlich da sein muss.'
  },
  {
    id: 'sleep-in-test',
    files: (p) => p.startsWith('test/'),
    pattern: /\bawait t\.wait\(\s*\d{4,}\s*\)/,
    message: 'Feste Pause von einer Sekunde oder mehr',
    why: 'Nie auf eine Stoppuhr warten, immer auf ein Ereignis. Auf einem ausgelasteten '
      + 'Rechner ist eine feste Pause eine Münze. `waitFor`, `waitIn` oder `waitForWindow` '
      + 'benutzen.'
  },
  {
    id: 'own-powershell',
    files: (p) => p.startsWith('src/main/') && p !== 'src/main/pshost.js',
    pattern: /execFile\w*\(\s*['"`][^'"`]*powershell/i,
    message: 'PowerShell wird direkt gestartet',
    why: 'Alle Aufrufe gehen über `processes.runPowerShell` an den langlebigen Host. '
      + 'Der Prozessstart ist der teure Teil, und der Host bezahlt ihn einmal.'
  }
];

/* -------------------------------------------------------------------- scan */

/**
 * The rules that apply to one file, against its text.
 *
 * Split out so the checker can be tested. A checker that has only ever been
 * run against a clean tree has never been shown to catch anything -- it would
 * pass just as happily with every pattern misspelled.
 */
/*
 * The one file that is allowed to contain every pattern, because that is what
 * it is for: it feeds each rule the exact line that broke a build and checks
 * that the rule catches it.
 *
 * Named exactly, not matched by a marker comment. An opt-out anyone can write
 * into a file stops being an exemption and becomes the way around the rules.
 */
const SELF_TEST = 'test/rules.test.js';

function scanText(file, text) {
  const key = normalize(file);
  if (key === SELF_TEST) return [];
  const applicable = RULES.filter((rule) => rule.files(key));
  if (!applicable.length) return [];

  const hits = [];
  text.split('\n').forEach((line, index) => {
    if (isComment(line)) return;
    for (const rule of applicable) {
      if (rule.pattern.test(line)) {
        hits.push({ rule, file: key, line: index + 1, text: line.trim() });
      }
    }
  });
  return hits;
}

module.exports = { RULES, scanText, isComment, normalize };

// Loaded by the tests as a module; only the direct run scans the tree.
if (require.main !== module) return;

/* --------------------------------------------------------------------- run */

const files = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'test'))
];

const findings = [];

for (const file of files) {
  findings.push(...scanText(path.relative(ROOT, file), fs.readFileSync(file, 'utf8'))
    .map((hit) => ({ ...hit, file: path.relative(ROOT, file) })));
}

if (!findings.length) {
  console.log(`Regeln OK: ${files.length} Datei(en), ${RULES.length} Regeln.`);
  process.exit(0);
}

// Grouped by rule rather than by file, so the reason is printed once and the
// places that need changing are listed under it.
const byRule = new Map();
for (const finding of findings) {
  if (!byRule.has(finding.rule.id)) byRule.set(finding.rule.id, { rule: finding.rule, hits: [] });
  byRule.get(finding.rule.id).hits.push(finding);
}

for (const { rule, hits } of byRule.values()) {
  console.error(`\n${rule.message}`);
  console.error(`  ${rule.why}`);
  for (const hit of hits) {
    console.error(`    ${hit.file}:${hit.line}`);
    console.error(`      ${hit.text.slice(0, 110)}`);
  }
}

console.error(`\n${findings.length} Verstoß/Verstöße gegen ${byRule.size} Regel(n).`);
process.exit(1);
