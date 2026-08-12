#!/usr/bin/env node
/**
 * Re-pull a single workshop's submission deadline straight from OpenReview's
 * live invitation `duedate` and write it into the entry — so a maintainer can
 * fix a stale, extended, or mistyped deadline without hand-editing the time
 * (and without waiting for the weekly discovery cron).
 *
 * This is an explicit, maintainer-triggered override: it sets the deadline to
 * whatever OpenReview currently says (either direction), bypassing the weekly
 * sync's later-only and human-freeze guards, and stamps `deadline_notes` with
 * the standard sync marker so the value carries provenance again (and the weekly
 * sync will keep it current from here on).
 *
 * Usage:
 *   node scripts/resync_deadline.mjs --slug colm-2026-daih
 *   node scripts/resync_deadline.mjs --slug colm-2026-daih --dry-run
 */
import fs from 'node:fs';
import * as yaml from 'js-yaml';
import { recordDeadlineObservation, listWorkshopFiles, readWorkshopFile } from '../lib/workshops.mjs';
import {
  deadlineFromInvitation,
  parseGroupDeadline,
  parseGroupAbstractDeadline,
  meaningfulAbstractDeadline,
  syncNote,
} from './discover_openreview.mjs';
import { fetchGroupById } from './recheck_imminent.mjs';

// OpenReview wraps some content values as { value: … }; unwrap if so.
const val = (c, k) => {
  const x = c?.[k];
  return x && typeof x === 'object' && 'value' in x ? x.value : x;
};

const args = process.argv.slice(2);
const getArg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const slug = getArg('--slug');
const dryRun = args.includes('--dry-run');

if (!slug) {
  console.error('Usage: node scripts/resync_deadline.mjs --slug <workshop-slug> [--dry-run]');
  process.exit(1);
}

const fp = listWorkshopFiles().find((p) => readWorkshopFile(p).slug === slug);
if (!fp) {
  console.error(`No workshop file found for slug "${slug}".`);
  process.exit(1);
}

const { raw } = readWorkshopFile(fp);
if (!raw.openreview_venue_id) {
  console.error(`"${slug}" has no openreview_venue_id — there is no OpenReview source to re-sync from.`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
// Same value precedence as discovery, recheck and the weekly review: the group's
// free `date` line first, the submission invitation only as a fallback. Reading
// the invitation alone made this script FAIL on venues that publish their
// deadline solely on the date line (NeurIPS EconML has no /-/Submission
// invitation at all) — the very command the review issue tells you to run.
const g = await fetchGroupById(raw.openreview_venue_id);
if (!g) {
  console.error(`OpenReview returned no group for ${raw.openreview_venue_id} (renamed, or rate-limited). Nothing changed.`);
  process.exit(1);
}
const dateLine = val(g.content ?? {}, 'date');
const fromLine = parseGroupDeadline(dateLine);
const dl = fromLine || (await deadlineFromInvitation(g));
if (!dl) {
  console.error(`OpenReview published no deadline for ${raw.openreview_venue_id} (no date line and no submission invitation, or rate-limited). Nothing changed.`);
  process.exit(1);
}
// Two-stage venues carry their abstract registration on the same line. Only sync
// it when the line is the source we trusted, so a missing line never wipes a
// value we already hold.
const nextAbstract = fromLine
  ? meaningfulAbstractDeadline(parseGroupAbstractDeadline(dateLine)?.submission_deadline ?? null, dl.submission_deadline)
  : (raw.abstract_deadline ?? null);

const before = raw.submission_deadline ?? '(none)';
if (raw.submission_deadline === dl.submission_deadline && (raw.timezone || 'UTC') === 'UTC') {
  console.log(`${slug}: already in sync with OpenReview (${before} UTC) — nothing to do.`);
  process.exit(0);
}

recordDeadlineObservation(raw, dl.submission_deadline, today, dl.timezone);
raw.submission_deadline = dl.submission_deadline;
raw.timezone = dl.timezone; // always 'UTC' from msToDeadline
raw.deadline_notes = syncNote(dl.submission_deadline, today);
// Keep the abstract stage consistent with the deadline we just wrote, so an
// entry can never end up advertising an abstract gate AFTER its paper deadline.
if (nextAbstract) raw.abstract_deadline = nextAbstract;
else delete raw.abstract_deadline;

console.log(`${slug}: ${before} -> ${dl.submission_deadline} UTC  (re-synced from OpenReview)`);
if (dryRun) {
  console.log('(dry-run — no file written)');
  process.exit(0);
}
fs.writeFileSync(fp, yaml.dump(raw, { lineWidth: 200, quotingType: '"' }));
console.log(`Wrote ${fp}.`);
