#!/usr/bin/env node
/**
 * Flags workshops whose deadline passed more than 60 days ago but that still
 * have no `workshop_date` or `proceedings_url`/`openreview_venue_id` —
 * i.e. entries that probably need a human to fill in what happened.
 * Writes a consolidated markdown report (used by the weekly Action to open
 * ONE issue). Always exits 0; an empty report means all is well.
 *
 * Usage: node scripts/stale_check.mjs [--report stale-report.md]
 */
import fs from 'node:fs';
import { loadWorkshops } from '../lib/workshops.mjs';
import { DAY_MS } from '../lib/dates.mjs';

const reportFlag = process.argv.indexOf('--report');
const reportPath = reportFlag !== -1 ? process.argv[reportFlag + 1] : null;

const now = Date.now();
const stale = loadWorkshops().filter(
  (w) =>
    // An edition recorded as not taking place has nothing to follow up: its
    // deadline will never gain a papers link, so it would be reported here
    // every week forever.
    w.status !== 'not_running' &&
    w.deadlineUtcMs != null &&
    now - w.deadlineUtcMs > 60 * DAY_MS &&
    !w.proceedings_url &&
    !w.openreview_venue_id,
);

let report = '';
if (stale.length) {
  const lines = [
    'The following workshop entries have a submission deadline that passed more than 60 days ago,',
    'but have no papers link (`openreview_venue_id` / `proceedings_url`).',
    'Please verify each one and fill in what happened (or correct the deadline):',
    '',
  ];
  for (const w of stale) {
    lines.push(`- [ ] \`${w.file}\` — **${w.name}** (${w.conference.toUpperCase()} ${w.year}) — needs a papers link`);
  }
  lines.push('', '_This issue is updated automatically by the weekly `stale-check` workflow._');
  report = lines.join('\n') + '\n';
}
if (reportPath) fs.writeFileSync(reportPath, report);
console.log(report || 'No stale workshops found.');
