#!/usr/bin/env node
/**
 * Every dependency a lockfile records must resolve to a record in that same
 * lockfile — for the root and for site/.
 *
 * Why: `npm audit fix` run on macOS rewrote site/package-lock.json without the
 * two @emnapi packages that only the wasm32 optional builds depend on, while
 * leaving those builds' dependency lists pointing at them. `npm ci` on a Mac
 * never looks at that subtree and passed; `npm ci` on every Linux runner
 * refused the lockfile ("Missing: @emnapi/core from lock file"), and both site
 * builds went red on a commit the local checks had blessed. This is the same
 * walk npm does on Linux, in a form that runs anywhere.
 *
 * Run: node scripts/lockfile_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

/** Node resolution over lockfile paths: walk up the node_modules chain. */
function resolves(packages, from, dep) {
  let dir = from;
  for (;;) {
    if (packages[`${dir ? `${dir}/` : ''}node_modules/${dep}`]) return true;
    const i = dir.lastIndexOf('/node_modules/');
    if (i < 0) return dir === '' ? false : !!packages[`node_modules/${dep}`];
    dir = dir.slice(0, i);
  }
}

for (const rel of ['package-lock.json', 'site/package-lock.json']) {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const packages = lock.packages ?? {};
  const dangling = [];
  for (const [from, entry] of Object.entries(packages)) {
    const deps = { ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) };
    for (const dep of Object.keys(deps)) {
      if (!resolves(packages, from, dep)) dangling.push(`${from || '(root)'} -> ${dep}@${deps[dep]}`);
    }
  }
  check(`${rel}: every recorded dependency resolves (${Object.keys(packages).length} records)`,
    dangling.length === 0, dangling.slice(0, 5).join('; '));
}

console.log(failed === 0 ? '\nLockfiles are self-consistent.' : `\n${failed} lockfile(s) have dangling references — regenerate on Linux, or restore the dropped records.`);
process.exit(failed === 0 ? 0 : 1);
