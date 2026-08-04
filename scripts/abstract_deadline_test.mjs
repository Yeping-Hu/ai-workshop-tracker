#!/usr/bin/env node
/**
 * Regression tests for two-stage venue handling (~3% of OpenReview workshops
 * gate the paper deadline behind an earlier MANDATORY abstract registration).
 * Pure logic, no network. Run: node scripts/abstract_deadline_test.mjs
 *
 * The invariant these lock down: the HEADLINE deadline is always the paper
 * deadline ("Submission Deadline:"), and the abstract date is a separate,
 * secondary field. Reading the `<venue>/-/Submission` invitation alone yields
 * the ABSTRACT date on such venues, which is why the review tool used to report
 * a phantom "OpenReview moved this earlier" for every one of them — and why
 * "accepting" that would have replaced a paper deadline with an abstract date.
 */
import { parseGroupDeadline, parseGroupAbstractDeadline } from './discover_openreview.mjs';
import { resolveWorkshop, sortByDeadline } from '../lib/workshops.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = got === expect;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

// Real date lines observed on OpenReview.
const EBMV = 'Submission Start: Jul 01 2026 11:59PM UTC-0, Abstract Registration: Jul 15 2026 11:59PM UTC-0, Submission Deadline: Jul 20 2026 11:59PM UTC-0';
const ASCI = 'Abstract Registration: Aug 20 2026 12:00AM UTC-0, Submission Deadline: Aug 29 2026 12:00AM UTC-0';
const SINGLE = 'Submission Start: Jun 25 2026 10:59AM UTC-0, Submission Deadline: Aug 04 2026 11:59AM UTC-0';

// The headline must be the PAPER deadline, never the abstract one.
check('EBMV headline = paper', parseGroupDeadline(EBMV)?.submission_deadline, '2026-07-20 23:59');
check('EBMV abstract', parseGroupAbstractDeadline(EBMV)?.submission_deadline, '2026-07-15 23:59');
check('ASCI headline = paper', parseGroupDeadline(ASCI)?.submission_deadline, '2026-08-29 00:00');
check('ASCI abstract', parseGroupAbstractDeadline(ASCI)?.submission_deadline, '2026-08-20 00:00');

// Single-stage venues must expose no abstract date at all.
check('single-stage headline', parseGroupDeadline(SINGLE)?.submission_deadline, '2026-08-04 11:59');
check('single-stage abstract -> null', parseGroupAbstractDeadline(SINGLE), null);
check('non-string -> null', parseGroupAbstractDeadline(null), null);
check('garbage -> null', parseGroupAbstractDeadline('Abstract Registration: soon'), null);

// Offsets are normalized to UTC for the abstract date exactly as for the paper
// deadline, so both are comparable instants (AoE = UTC-12).
check('abstract offset normalized (AoE)',
  parseGroupAbstractDeadline('Abstract Registration: Aug 20 2026 11:59PM UTC-12, Submission Deadline: Aug 29 2026 11:59PM UTC-12')?.submission_deadline,
  '2026-08-21 11:59');

// Display contract: the headline/countdown follow the paper deadline, and the
// abstract stage is reported separately with its own passed/not-passed state.
{
  const raw = {
    name: 'Two-stage workshop', conference: 'neurips', year: 2026, topics: ['other'],
    submission_deadline: '2026-08-29 00:00', timezone: 'UTC', abstract_deadline: '2026-08-20 00:00',
  };
  const before = resolveWorkshop({ slug: 's', file: 'f', raw }, Date.UTC(2026, 7, 10)); // Aug 10
  check('headline date is the paper deadline', before.deadlineUtcMs, Date.UTC(2026, 7, 29, 0, 0));
  check('abstract still open before it passes', before.abstractDeadlinePassed, false);
  check('abstract is rendered', typeof before.abstractDeadlineWallClock === 'string', true);
  // B2: while the abstract stage is open the COUNTDOWN targets it (that is the
  // date you must act on) and is flagged so the UI can label it "abstract".
  check('countdown targets the abstract while open', before.nextStageUtcMs, Date.UTC(2026, 7, 20, 0, 0));
  check('countdown flagged as abstract stage', before.nextStageIsAbstract, true);

  const between = resolveWorkshop({ slug: 's', file: 'f', raw }, Date.UTC(2026, 7, 25)); // Aug 25
  check('abstract marked passed after its date', between.abstractDeadlinePassed, true);
  // The anti-confusion properties: the HEADLINE date never moves, the abstract
  // date stays visible (now marked closed), and the countdown only switches to
  // the paper deadline with the label removed — so nothing reads as an extension.
  check('headline unchanged after abstract passes', between.deadlineUtcMs, before.deadlineUtcMs);
  check('abstract date still rendered after passing', typeof between.abstractDeadlineWallClock === 'string', true);
  check('countdown switches to the paper deadline', between.nextStageUtcMs, between.deadlineUtcMs);
  check('countdown no longer flagged abstract', between.nextStageIsAbstract, false);
  check('status still upcoming (paper open)', between.status, 'upcoming');
}

// Ordering: a two-stage workshop sorts by the stage its countdown shows, so the
// list can never display a 2-day countdown below a 5-day one.
{
  const mk = (name, deadline, abstract) => ({ slug: name, file: name, raw: {
    name, conference: 'neurips', year: 2026, topics: ['other'],
    submission_deadline: deadline, timezone: 'UTC', ...(abstract ? { abstract_deadline: abstract } : {}),
  } });
  const now = Date.UTC(2026, 7, 10); // Aug 10
  const twoStage = resolveWorkshop(mk('two-stage', '2026-08-29 00:00', '2026-08-14 00:00'), now);
  const single = resolveWorkshop(mk('single', '2026-08-20 00:00', null), now);
  const order = sortByDeadline([single, twoStage]).map((w) => w.name);
  check('abstract-imminent workshop sorts first', order.join(','), 'two-stage,single');
}

// A single-stage entry exposes no abstract fields.
{
  const w = resolveWorkshop({ slug: 's', file: 'f', raw: {
    name: 'Plain', conference: 'iros', year: 2026, topics: ['other'],
    submission_deadline: '2026-08-04 11:59', timezone: 'UTC',
  } }, Date.UTC(2026, 7, 1));
  check('no abstract -> null wallclock', w.abstractDeadlineWallClock, null);
  check('no abstract -> null passed', w.abstractDeadlinePassed, null);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll two-stage deadline checks passed.');
process.exit(failed ? 1 : 0);
