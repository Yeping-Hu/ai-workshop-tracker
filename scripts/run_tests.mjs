#!/usr/bin/env node
/**
 * Run every standalone suite in one command: `npm test`.
 *
 * Each scripts/*_test.mjs is a plain node program that exits non-zero on
 * failure, and CI runs them as named steps (validate.yml, alerts-ci.yml) so the
 * Actions UI says which one went red — that stays as it is. This runner is for
 * the terminal, where there was previously no way to run the data suite short
 * of a shell loop. It prints one line per file, the failing file's own output
 * verbatim, and exits non-zero if any suite did.
 *
 * The four suites that need a built site, a server or the live site are
 * skipped here by name; pr-build-check.yml and smoke.yml own those.
 *
 * Usage:
 *   npm test                       every standalone suite
 *   node scripts/run_tests.mjs dates alerts_diff    only suites whose name contains an argument
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEEDS_A_SERVER = new Set(['ui_test.mjs', 'alerts_ui_test.mjs', 'shipped_ui_test.mjs', 'smoke_test.mjs']);
const only = process.argv.slice(2);

const files = fs
  .readdirSync(path.join(ROOT, 'scripts'))
  .filter((f) => f.endsWith('_test.mjs') && !NEEDS_A_SERVER.has(f))
  .filter((f) => !only.length || only.some((o) => f.includes(o)))
  .sort();

let failed = 0;
const t0 = Date.now();
for (const f of files) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join('scripts', f)], { cwd: ROOT, encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${f.padEnd(40)} ${String(Date.now() - started).padStart(5)} ms`);
  if (!ok) {
    process.stdout.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
  }
}
console.log(`\n${files.length - failed}/${files.length} suites passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failed) console.log('Browser and live suites are not run here — see pr-build-check.yml and smoke.yml.');
process.exit(failed ? 1 : 0);
