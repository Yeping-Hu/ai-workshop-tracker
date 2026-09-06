#!/usr/bin/env node
/**
 * Keep every renderer of a workshop row showing what the board shows.
 *
 * The board renders rows server-side from WorkshopRow.astro. Two surfaces
 * render the same row in the browser through one shared renderer
 * (site/src/scripts/ws-row.js): the saved list, from /api/workshops.json, and
 * the homepage's search results, from each document's Pagefind metadata (the
 * `pfFields` contract in workshop/[slug].astro, mapped by `viewFromMeta` in
 * index.astro). Drift is what this guards: the saved list once silently lacked
 * location, topic chips and the deadline-change note, and the results carried
 * no countdown at all.
 *
 * Structural, not pixel-level: for every `w.<field>` the board reads, the
 * shared renderer must reference the API's spelling of it, the results'
 * contract must publish it, and the results' mapping must read it. It cannot
 * prove the output matches (that needs a browser), but it catches the common
 * case — a field added to the board and forgotten elsewhere.
 *
 * Run: node scripts/row_parity_test.mjs
 */
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const board = read('site/src/components/WorkshopRow.astro');
const renderer = read('site/src/scripts/ws-row.js') + read('site/src/pages/saved.astro');
const slugPage = read('site/src/pages/workshop/[slug].astro');
const index = read('site/src/pages/index.astro');

// camelCase on the resolved object -> snake_case in the published API.
const EQUIV = {
  deadlineWallClock: 'deadline_wall_clock',
  deadlineIso: 'deadline_utc',
  deadlineUtcMs: 'deadline_utc',
  deadlineChange: 'deadline_change',
  abstractDeadlineWallClock: 'abstract_deadline_wall_clock',
  abstractDeadlineIso: 'abstract_deadline_utc',
  abstractDeadlinePassed: 'abstract_deadline',
  nextStageUtcMs: 'next_stage_utc',
  nextStageIsAbstract: 'next_stage_is_abstract',
  locationLabel: 'location_label',
  locationDistinguishes: 'location_distinguishes',
  statusLabel: 'status_label',
};

// The results' metadata spells a few of them its own way: the name is
// Pagefind's own `title`; the wall clock is `deadline` (the count line's
// original name); the internal status is `state` because `status` carries the
// label; the location is published only when it distinguishes, so its presence
// is the flag; and "abstract closed?" is derived from which stage is next.
const META_EQUIV = {
  ...EQUIV,
  name: 'title',
  deadlineWallClock: 'deadline',
  status: 'state',
  statusLabel: 'status',
  locationDistinguishes: 'location_label',
  abstractDeadlinePassed: 'next_stage_is_abstract',
};

// Fields the board shows that the saved list deliberately does not. Keep this
// short and justified — every entry is a place the two pages disagree.
const EXEMPT_SAVED = new Set([
  'slug',   // used for the link on both, spelled differently
  'status', // the renderer uses it to pick .row-passed rather than to print a pill
  // The saved list deliberately drops the status pill. It would say a third time
  // what the row already says twice: the countdown column reads "passed" or
  // "TBA", and a concluded row is greyed by .row-passed. The board keeps the
  // pill because it is scanned against hundreds of other rows.
  'statusLabel',
]);
// The results show everything the board shows; only the URL is spelled differently.
const EXEMPT_RESULTS = new Set(['slug']);

const snake = (f) => f.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase();
const used = (src) => new Set([...src.matchAll(/w\.([a-zA-Z_]+)/g)].map((m) => m[1]));
const boardFields = used(board);
const rendererFields = used(renderer);
const contract = (slugPage.match(/const pfFields[\s\S]*?\n\];/) || [''])[0];

let failed = 0;
for (const f of [...boardFields].sort()) {
  if (!EXEMPT_SAVED.has(f)) {
    const name = EQUIV[f] ?? snake(f);
    if (!rendererFields.has(f) && !rendererFields.has(name)) {
      console.log(`✗ the board shows w.${f} but the shared renderer references no equivalent (expected ${name})`);
      failed++;
    }
  }
  if (!EXEMPT_RESULTS.has(f)) {
    const name = META_EQUIV[f] ?? snake(f);
    // `title` is Pagefind's automatic metadata (the page's <h1>), never declared.
    const published = name === 'title' || contract.includes(`'${name}'`);
    const mapped = name === 'title' ? /meta\??\.title\b/.test(index) : new RegExp(`meta\\.${name}\\b`).test(index);
    if (!published) {
      console.log(`✗ the board shows w.${f} but workshop/[slug].astro publishes no '${name}' in pfFields`);
      failed++;
    }
    if (!mapped) {
      console.log(`✗ the board shows w.${f} but index.astro's viewFromMeta never reads meta.${name}`);
      failed++;
    }
  }
}

console.log(
  failed
    ? `\n${failed} gap(s) between the board and the other renderers — add the field to ws-row.js, publish it in pfFields and read it in viewFromMeta (and in /api/workshops.json if the saved list needs it), or exempt it here with a reason.`
    : `Checked ${boardFields.size} board field(s): the shared renderer, the results' contract and its mapping cover all of them.`,
);
process.exit(failed ? 1 : 0);
