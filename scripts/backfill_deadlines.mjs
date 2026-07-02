#!/usr/bin/env node
/**
 * Daily, lightweight companion to `recheck_imminent.mjs` — the *other* half of
 * the daily deadline upkeep.
 *
 *   - `recheck_imminent.mjs` re-checks workshops that ALREADY have a deadline
 *     (the imminent band around today) and applies OpenReview *extensions* fast.
 *   - THIS job does the opposite case: workshops that have an OpenReview venue
 *     but NO `submission_deadline` yet, and *backfills* the deadline the moment
 *     OpenReview publishes it — instead of the blank sitting on the board for up
 *     to a week until the next weekly `discover` crawl fills it.
 *
 * The two never overlap: a blank entry can't be in the imminent re-check's set
 * (that predicate requires a stored deadline), and a filled entry can't be in
 * this one. Between them, an entry is looked at daily whether or not it already
 * has a deadline — with full venue *discovery* (finding brand-new venue groups),
 * multi-track descent, and legacy adoption still the weekly job's job.
 *
 * Eligible iff ALL hold (see `isBlankBackfillable`, a pure predicate so it is
 * unit-tested with no network):
 *   - carries an `openreview_venue_id` (there is something to look up),
 *   - is single-deadline (no `tracks`; the weekly job owns multi-track headline
 *     derivation),
 *   - has NO `submission_deadline` (only truly-blank entries — we never touch a
 *     value that already exists; that is the imminent job's / weekly job's remit).
 *
 * For each blank entry we do ONE group lookup by its stored venue id (no
 * enumeration) and read the deadline with the same precedence the weekly sync
 * and the imminent re-check use: the group's free-text `date` line first, then
 * the submission invitation's machine-readable duedate. A value is only written
 * if it passes the same plausibility guard as those jobs (≤ 2 years out, year
 * within ±1 of the record's year) — a garbled/transient read can't fill a blank
 * with nonsense that would then fail validation. When filled, the deadline is
 * stamped bot-managed (`syncNote`), so any *later* extension is thereafter picked
 * up automatically by `recheck_imminent.mjs`. Fill-only, never overwrite — the
 * same convention the weekly `discover` backfill uses for `!submission_deadline`.
 *
 * What it CANNOT do (by design, so nothing is silently wrong): a venue whose
 * deadline lives only on its own website — with no OpenReview `date` line and no
 * submission invitation — returns nothing here (and nothing in the weekly job
 * either); it simply stays blank for manual entry. Likewise a venue using a
 * non-default submission invitation is left to the weekly job, which carries the
 * full group object; this daily pass intentionally does the cheap, common case.
 *
 * Cost: one group lookup (plus at most one invitation lookup) per blank entry —
 * a handful of calls on a typical day, often zero. Writes files only; the
 * workflow validates, commits (as github-actions[bot]), pushes, and dispatches a
 * deploy, recording each fill in the commit message via $DEADLINE_CHANGELOG,
 * exactly like the imminent re-check and the weekly run.
 *
 * Usage:
 *   node scripts/backfill_deadlines.mjs
 *   node scripts/backfill_deadlines.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { listWorkshopFiles, readWorkshopFile } from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs } from '../lib/dates.mjs';
import {
  syncNote,
  deadlineFromInvitation,
  parseGroupDeadline,
} from './discover_openreview.mjs';
// Single-group lookup by exact id, with the shared 429/5xx backoff. It already
// lives in the imminent re-check (its natural home); reuse it rather than
// duplicate the hardening. Importing is side-effect-free — that module only runs
// its CLI under the `import.meta.url` guard.
import { fetchGroupById } from './recheck_imminent.mjs';

const DAY = 86_400_000;
// Same plausibility guard as the imminent re-check / weekly sync: reject absurd
// reads rather than fill a blank with a value that would fail validation or
// mislead. A fetched deadline must be at most two years out and land in a year
// within ±1 of the record's own year.
const TWO_YEARS_MS = 2 * 366 * DAY;

// OpenReview wraps some content values as { value: … }; unwrap if so.
const val = (c, k) => {
  const x = c?.[k];
  return x && typeof x === 'object' && 'value' in x ? x.value : x;
};

/**
 * Eligibility predicate — pure over the stored record, so it is unit-tested with
 * no network. Eligible iff it has an OpenReview venue id, is single-deadline
 * (no `tracks`), and has no `submission_deadline` yet.
 */
export function isBlankBackfillable(raw) {
  if (!raw || !raw.openreview_venue_id) return false;
  if (Array.isArray(raw.tracks) && raw.tracks.length) return false;
  if (raw.submission_deadline) return false; // only truly-blank entries
  return true;
}

async function main({ dryRun }) {
  const today = new Date().toISOString().slice(0, 10);

  // 1. Compute the blank, OpenReview-linked, single-deadline subset straight
  //    from the files — recomputed every run, no maintained list. Entries leave
  //    this set on their own the moment a deadline is filled (here or weekly).
  const candidates = [];
  for (const f of listWorkshopFiles()) {
    const { raw } = readWorkshopFile(f);
    if (isBlankBackfillable(raw)) candidates.push({ path: f, raw });
  }
  console.log(`Blank OpenReview-linked deadlines to backfill: ${candidates.length}`);

  // 2. Look each up by its stored venue id (one group lookup apiece — no
  //    enumeration) and fill only when OpenReview now publishes a plausible one.
  let checked = 0;
  let filled = 0;
  const changes = [];
  for (const { path: fp, raw } of candidates) {
    checked++;
    const g = await fetchGroupById(raw.openreview_venue_id);
    if (!g) continue; // transient/missing — the weekly run is the backstop
    // Same value precedence as the imminent re-check: the group's free `date`
    // line first, then the submission invitation's machine-readable duedate.
    const fetched = parseGroupDeadline(val(g.content ?? {}, 'date')) || (await deadlineFromInvitation(g));
    if (!fetched) continue; // no deadline published yet (e.g. website-only) — leave blank

    const fetchedMs = resolveDeadlineUtcMs(fetched.submission_deadline, fetched.timezone || 'UTC');
    const fetchedYear = Number(String(fetched.submission_deadline).slice(0, 4));
    const plausible =
      fetchedMs != null &&
      fetchedMs - Date.now() <= TWO_YEARS_MS &&
      Number.isFinite(fetchedYear) &&
      Math.abs(fetchedYear - raw.year) <= 1;
    if (!plausible) {
      console.warn(`  ⚠ ${path.basename(fp)}: OpenReview deadline "${fetched.submission_deadline}" looks implausible — left blank`);
      continue;
    }

    raw.submission_deadline = fetched.submission_deadline;
    raw.timezone = fetched.timezone;
    // Stamp bot-managed so future *extensions* are thereafter caught by the
    // daily imminent re-check — the fill hands the entry off to that job.
    raw.deadline_notes = syncNote(fetched.submission_deadline, today);
    if (!dryRun) fs.writeFileSync(fp, yaml.dump(raw, { lineWidth: 200, quotingType: '"' }));
    filled++;
    changes.push(`${raw.conference} ${raw.year} · ${path.basename(fp)}: (blank) -> ${fetched.submission_deadline} UTC`);
  }

  // Record each fill so the workflow can fold it into the commit message —
  // no silent edits, same convention as the imminent re-check / weekly run.
  if (changes.length && process.env.DEADLINE_CHANGELOG) {
    fs.appendFileSync(process.env.DEADLINE_CHANGELOG, changes.map((c) => `- ${c}`).join('\n') + '\n');
  }
  console.log(`Checked ${checked} blank deadline(s) — ${filled} backfilled from OpenReview.`);
  for (const c of changes) console.log(`    ↳ ${c}`);
}

// Only run the CLI when invoked directly, so the exported predicate
// (isBlankBackfillable) can be imported in tests without the module parsing
// argv and hitting the network.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  main({ dryRun }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
