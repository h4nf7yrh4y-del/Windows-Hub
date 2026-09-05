#!/usr/bin/env node
'use strict';

/**
 * Parses every source file so a typo cannot ship silently.
 * Renderer files are ES modules; Node only parses those as modules if the
 * extension says so, hence the temporary .mjs copy.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAIN_DIRS = ['src/main', 'src/preload'];
const MODULE_DIRS = ['src/renderer/js'];

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

function check(file, asModule) {
  let target = file;
  let tmp = null;
  if (asModule) {
    tmp = path.join(os.tmpdir(), `hub-check-${process.pid}-${path.basename(file)}.mjs`);
    fs.copyFileSync(file, tmp);
    target = tmp;
  }
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    return null;
  } catch (err) {
    return (err.stderr ? err.stderr.toString() : err.message).trim();
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ } }
  }
}

let failures = 0;
let checked = 0;

for (const dir of MAIN_DIRS) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const file of walk(full)) {
    checked += 1;
    const error = check(file, false);
    if (error) { failures += 1; console.error(`FAIL ${path.relative(ROOT, file)}\n${error}\n`); }
  }
}

for (const dir of MODULE_DIRS) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const file of walk(full)) {
    checked += 1;
    const error = check(file, true);
    if (error) { failures += 1; console.error(`FAIL ${path.relative(ROOT, file)}\n${error}\n`); }
  }
}

if (failures) {
  console.error(`${failures} of ${checked} file(s) failed to parse.`);
  process.exit(1);
}
console.log(`Syntax OK: ${checked} file(s).`);
