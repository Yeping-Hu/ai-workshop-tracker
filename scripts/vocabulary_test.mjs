#!/usr/bin/env node
/**
 * One event, one name — across every surface that describes it.
 * Run: node scripts/vocabulary_test.mjs
 *
 * Why this exists: a workshop publishing its first deadline is one event, and
 * five different renderers describe it — the board row, the workshop page, the
 * saved list, the Markdown export, and the weekly digest. They drifted. The
 * digest said "Deadline just announced" next to a section headed "Newly
 * announced" (a different event entirely), and when the digest was fixed the
 * other four kept the retired wording, so the same event had two names
 * depending on where you read it.
 *
 * A grep is a blunt instrument, but bluntness is the point: the failure mode is
 * someone adding a sixth surface, or reverting one of the five, and nothing
 * noticing. Rendering each surface properly would need a browser for three of
 * them; this costs nothing and catches the drift that actually happened.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

/** Retired wording, and what replaced it. Add a row when a phrase is renamed. */
const RETIRED = [
  { was: 'Deadline just announced', now: 'First deadline posted' },
  { was: 'Newly announced', now: 'New this week' },
];

/**
 * Every surface that renders the shared vocabulary, and what it must contain.
 *
 * Two registers of the same vocabulary, deliberately. The site renders prose in
 * a sentence ("First deadline posted"); the digest renders a chip, which is
 * uppercase and clipped to fit ("FIRST DEADLINE"). That is a typographic
 * difference, not a second name for the event — what must never happen is one
 * surface calling it something else entirely, which is what this guards.
 */
const SURFACES = [
  ['site/src/components/WorkshopRow.astro', 'First deadline posted'],
  ['site/src/pages/saved.astro', 'First deadline posted'],
  ['site/src/lib/markdown.ts', 'First deadline posted'],
  ['site/src/pages/workshop/[slug].astro', 'First deadline posted'],
  ['alerts/render.mjs', 'FIRST DEADLINE'],
  ['alerts/render.mjs', 'New this week'],
];

const SCAN_DIRS = ['site/src', 'lib', 'alerts', 'docs'];
// docs/plans/ is an archive of the ORIGINAL design decisions, referenced from
// docs/ALERTS.md as exactly that. Renaming a heading there to match today's
// vocabulary would falsify the record of what was decided at the time, so it is
// deliberately out of scope for this guard.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', 'plans']);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (/\.(astro|ts|js|mjs|md)$/.test(e.name)) yield full;
  }
}

// --- no retired wording survives anywhere -------------------------------
for (const { was, now } of RETIRED) {
  const hits = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      if (fs.readFileSync(file, 'utf8').includes(was)) hits.push(path.relative(ROOT, file));
    }
  }
  check(`"${was}" is retired in favour of "${now}"`, hits, []);
}

// --- and every surface actually carries the current wording --------------
for (const [rel, phrase] of SURFACES) {
  const abs = path.join(ROOT, rel);
  const present = fs.existsSync(abs) && fs.readFileSync(abs, 'utf8').includes(phrase);
  check(`${rel} says "${phrase}"`, present, true);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nVocabulary is consistent across surfaces');
process.exit(failed ? 1 : 0);
