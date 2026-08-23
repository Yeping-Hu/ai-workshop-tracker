#!/usr/bin/env node
/**
 * Keep the saved list rendering the same row as the board.
 *
 * The board renders rows server-side from `WorkshopRow.astro`; the saved list
 * renders them in the browser from `/api/workshops.json`, because which
 * workshops are saved is only known client-side. Two renderers for one row means
 * they drift: the saved list silently lacked location, topic chips and the
 * deadline-change note, and printed the raw stored deadline instead of the
 * formatted one.
 *
 * This is the cheap structural check — for every field the board displays, the
 * saved renderer must reference an equivalent. It cannot prove the output
 * matches (that needs a browser), but it catches the common case: someone adds a
 * field to the board and forgets the other renderer.
 *
 * Run: node scripts/row_parity_test.mjs
 */
import fs from 'node:fs';

const board = fs.readFileSync(new URL('../site/src/components/WorkshopRow.astro', import.meta.url), 'utf8');
const saved = fs.readFileSync(new URL('../site/src/pages/saved.astro', import.meta.url), 'utf8');

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

// Fields the board shows that the saved list deliberately does not. Keep this
// short and justified — every entry is a place the two pages disagree.
const EXEMPT = new Set([
  'slug',   // used for the link on both, spelled differently
  'status', // both render it, via status_label on the saved side
]);

const used = (src) => new Set([...src.matchAll(/w\.([a-zA-Z_]+)/g)].map((m) => m[1]));
const boardFields = used(board);
const savedFields = used(saved);

let failed = 0;
for (const f of [...boardFields].sort()) {
  if (EXEMPT.has(f)) continue;
  const snake = EQUIV[f] ?? f.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase();
  if (savedFields.has(f) || savedFields.has(snake)) continue;
  console.log(`✗ the board shows w.${f} but the saved list renders no equivalent (expected ${snake})`);
  failed++;
}

console.log(
  failed
    ? `\n${failed} field(s) on the board and not in the saved list — add them to saved.astro, publish them in /api/workshops.json if needed, or exempt them here with a reason.`
    : `Checked ${boardFields.size} board field(s): the saved list covers all of them.`,
);
process.exit(failed ? 1 : 0);
