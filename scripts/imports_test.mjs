#!/usr/bin/env node
/**
 * Guard against calling one of our own exported helpers without importing it.
 *
 * `discover_openreview.mjs` called recordDeadlineObservation() for a week without
 * importing it. JavaScript only complains when the line actually runs, and that
 * line runs only when a workshop's deadline appears on OpenReview for the first
 * time — so the file looked fine, CI stayed green, and the weekly crawl silently
 * finished 15 of 18 conference-years on 2026-08-11.
 *
 * A linter with no-undef would catch this; this is the cheap targeted version:
 * for every script, any call to a name that one of our modules exports must be
 * either imported or defined in that same file.
 *
 * Run: node scripts/imports_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const files = [
  ...fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => `lib/${f}`),
];

// Strip comments and strings so a name mentioned in prose isn't treated as a call.
const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Every name our own modules export.
const exported = new Map(); // name -> defining file
for (const f of files) {
  for (const m of read(f).matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) exported.set(m[1], f);
  for (const m of read(f).matchAll(/^export\s+const\s+([A-Za-z_$][\w$]*)\s*=/gm)) exported.set(m[1], f);
}

let failed = 0;
for (const f of files) {
  const src = read(f);
  const code = strip(src);
  // Names this file brings in or defines itself.
  const available = new Set();
  for (const m of src.matchAll(/import\s*(?:type\s*)?{([^}]*)}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) available.add(name);
    }
  }
  for (const m of code.matchAll(/(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) available.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) available.add(m[1]);

  for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (!exported.has(name)) continue;      // not one of ours; leave it to runtime
    if (exported.get(name) === f) continue; // defined here
    if (available.has(name)) continue;      // imported or locally defined
    console.log(`✗ ${f} calls ${name}() but never imports it (exported by ${exported.get(name)})`);
    failed++;
  }
}

console.log(
  failed
    ? `\n${failed} unimported call(s) — add the import, or the call will throw the first time that branch runs.`
    : `Checked ${files.length} module(s) against ${exported.size} exported helper(s) — every call is imported.`,
);
process.exit(failed ? 1 : 0);
