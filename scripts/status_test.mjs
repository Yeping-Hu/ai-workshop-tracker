#!/usr/bin/env node
/**
 * Regression tests for computeStatus (lib/dates.mjs) and the way an inferred
 * event date interacts with the submission deadline.
 *
 * The bug this guards: a workshop with no explicit workshop_date inherits an
 * event date from its conference edition's end (or the conference's typical
 * month). When that inferred date has passed but the workshop's real submission
 * deadline is still in the future (e.g. a CVPR Codabench competition due after
 * the conference ends), the workshop was wrongly shown as "Past" — even though
 * you could still submit. The rule now: an open (future) deadline always means
 * Open call, and that wins over any inferred/estimated event date.
 *
 * Pure logic — no network, no build. Run: node scripts/status_test.mjs
 */
import { computeStatus } from '../lib/dates.mjs';
import { resolveWorkshop } from '../lib/workshops.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = got === expect;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${got}${ok ? '' : `  (expected ${expect})`}`);
}

const NOW = Date.parse('2026-06-24T00:00:00Z');
const ms = (iso) => Date.parse(iso);
const PAST_EVENT = ms('2026-06-07T00:00:00Z');   // CVPR 2026 ended
const FUTURE_EVENT = ms('2026-12-01T00:00:00Z');
const FUTURE_DL = ms('2026-06-30T00:01:00Z');    // still open
const PAST_DL = ms('2026-06-10T00:00:00Z');      // already closed

// --- the core invariant: open deadline beats a passed event date -----------
check('open deadline + passed (inferred) event -> upcoming',
  computeStatus({ deadlineUtcMs: FUTURE_DL, workshopDateUtcMs: PAST_EVENT, year: 2026 }, NOW), 'upcoming');
check('open deadline + no event date -> upcoming',
  computeStatus({ deadlineUtcMs: FUTURE_DL, workshopDateUtcMs: null, year: 2026 }, NOW), 'upcoming');
check('open deadline + future event -> upcoming',
  computeStatus({ deadlineUtcMs: FUTURE_DL, workshopDateUtcMs: FUTURE_EVENT, year: 2026 }, NOW), 'upcoming');

// --- everything else unchanged ---------------------------------------------
check('passed deadline + future event -> deadline_passed',
  computeStatus({ deadlineUtcMs: PAST_DL, workshopDateUtcMs: FUTURE_EVENT, year: 2026 }, NOW), 'deadline_passed');
check('passed deadline + passed event -> past',
  computeStatus({ deadlineUtcMs: PAST_DL, workshopDateUtcMs: PAST_EVENT, year: 2026 }, NOW), 'past');
check('no deadline + passed event -> past',
  computeStatus({ deadlineUtcMs: null, workshopDateUtcMs: PAST_EVENT, year: 2026 }, NOW), 'past');
check('no deadline + future event -> upcoming (TBA)',
  computeStatus({ deadlineUtcMs: null, workshopDateUtcMs: FUTURE_EVENT, year: 2026 }, NOW), 'upcoming');
check('no deadline + no event + prior year -> past',
  computeStatus({ deadlineUtcMs: null, workshopDateUtcMs: null, year: 2025 }, NOW), 'past');

// --- end-to-end: the exact cvpr-2026-fmv shape via resolveWorkshop ----------
// No workshop_date; the edition end (inherited) is in the past, but the OpenReview
// deadline is still open. Must resolve to Open call, not Past.
{
  const raw = {
    conference: 'cvpr', year: 2026, name: 'FMV', acronym: 'FMV',
    submission_deadline: '2026-06-30 00:01', timezone: 'UTC',
  };
  const editionEnds = { 'cvpr-2026': PAST_EVENT };
  const confMonths = { cvpr: 6 };
  const w = resolveWorkshop({ slug: 'cvpr-2026-fmv', file: 'x.yml', raw }, NOW, confMonths, editionEnds);
  check('cvpr-fmv shape (inherited past edition end + open deadline) -> upcoming', w.status, 'upcoming');
  // and after the deadline passes, it correctly becomes past (conference is over)
  const after = resolveWorkshop({ slug: 'cvpr-2026-fmv', file: 'x.yml', raw }, ms('2026-07-01T00:00:00Z'), confMonths, editionEnds);
  check('cvpr-fmv after deadline passes -> past', after.status, 'past');
}

console.log(failed === 0 ? '\nStatus logic OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
