#!/usr/bin/env node
/**
 * Every usage event the site sends has one name, and the docs list it.
 * Run: node scripts/analytics_events_test.mjs
 *
 * Why this exists: GoatCounter custom events are the only usage signal the
 * site collects (docs/ARCHITECTURE.md, "Favorites without accounts"), and
 * they are how a feature earns its keep — or gets removed. An event with a
 * typo in its path, or one nobody wrote down, is a dashboard row that answers
 * no question. So: every `track(` / `awtTrack(` call site in site/src must use
 * a path from the list below, and ARCHITECTURE.md must name each path, so the
 * dashboard and the doc cannot drift apart. Adding an event means adding it
 * here and in the doc in the same commit.
 *
 * A grep, deliberately: the call sites are in client modules and inline page
 * scripts, and running them needs a browser (ui_test.mjs stubs
 * window.goatcounter to check the wiring). This catches the vocabulary drift
 * that a browser test would not notice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `: ${detail}` : ''}`);
}

/**
 * The vocabulary. `path` is GoatCounter's key; the second argument (title) is
 * a free detail such as a slug or a bucket and is not checked here.
 */
export const EVENTS = [
  'fav/star-workshop', // a workshop was starred (fires on add only)
  'fav/star-paper', // a paper was starred (add only)
  'insight/extension', // an extension-rate line was rendered (title: series|conference)
  'planner/rendered', // the saved-page agenda rendered with ≥1 star (title: bucket)
  'delight/aoe-open', // the "why 11:59 UTC" explainer was opened (title: slug)
  'delight/surprise', // "Surprise me" was clicked (title: slug)
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|ts|astro|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(path.join(ROOT, 'site/src'));
const found = new Map(); // path -> [file:line]
const CALL = /\b(?:awtTrack|track)\(\s*(['"`])([^'"`]+)\1/g;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  src.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(CALL)) {
      const where = `${path.relative(ROOT, f)}:${i + 1}`;
      if (!found.has(m[2])) found.set(m[2], []);
      found.get(m[2]).push(where);
    }
  });
}

check('at least one call site was found (the regex still matches the code)', found.size > 0, `${found.size} paths`);
for (const [p, sites] of found) {
  check(`call site uses a listed event: ${p}`, EVENTS.includes(p), sites.join(', '));
}

const doc = fs.readFileSync(path.join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
for (const p of EVENTS) {
  check(`docs/ARCHITECTURE.md names \`${p}\``, doc.includes(`\`${p}\``));
}

// The helper itself must stay a no-op without GoatCounter: it is loaded on
// every page, including forks and local previews where nothing listens.
const fav = fs.readFileSync(path.join(ROOT, 'site/src/scripts/favorites.js'), 'utf8');
check('track() guards on window.goatcounter?.count?.', /window\.goatcounter\?\.count\?\.\(/.test(fav));
check('track() is bridged to window.awtTrack for non-module page scripts', /window\.awtTrack = track/.test(fav));

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
