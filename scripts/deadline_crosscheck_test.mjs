#!/usr/bin/env node
/**
 * Verifies classifyDeadlineDiff in deadline_crosscheck.mjs: a stored deadline is
 * compared against OpenReview's duedate (UTC ms) and labelled match / tz-suspect
 * / changed. The key property: a near-whole-hour gap (<=14h) that is NOT ~a day
 * is treated as a likely timezone slip, while a ~day gap is a real extension.
 * Pure logic; no network.
 *
 * Run: node scripts/deadline_crosscheck_test.mjs
 */
import { classifyDeadlineDiff, reviewCategory, isWithinReviewWindow, websiteDrift, normalizeWebsite, titleDrift, acronymDrift, needsDirectLookup, buildReport, siblingVenueCandidates, lateResurrection } from './deadline_crosscheck.mjs';
import { syncNote, LEGACY_IMPORT_NOTE } from './discover_openreview.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

const H = 3_600_000;
const D = 86_400_000;
const T = Date.UTC(2026, 5, 24, 12, 30); // arbitrary reference instant

const kind = (a, b) => classifyDeadlineDiff(a, b).kind;

// Exact / near-exact match.
check('identical -> match', kind(T, T), 'match');
check('within 30s -> match', kind(T, T + 30_000), 'match');

// Whole-hour offsets = timezone-slip signature (the PDT/AoE failure mode).
check('7h later -> tz-suspect (PDT)', kind(T, T + 7 * H), 'tz-suspect');
check('8h earlier -> tz-suspect', kind(T, T - 8 * H), 'tz-suspect');
check('12h -> tz-suspect (AoE-ish)', kind(T, T + 12 * H), 'tz-suspect');

// Half/quarter-hour zones still flagged.
check('30m -> tz-suspect (half-hour zone)', kind(T, T + 30 * 60_000), 'tz-suspect');
check('45m -> tz-suspect (quarter-hour zone)', kind(T, T + 45 * 60_000), 'tz-suspect');

// A whole day apart = real extension, NOT a tz slip (this is the DAIH case:
// stored Jun 23 12:30 vs OpenReview Jun 24 12:30 -> exactly 24h).
check('24h -> changed (extension, not tz)', kind(T, T + 24 * H), 'changed');
check('3 days -> changed', kind(T, T + 3 * D), 'changed');

// Beyond any real tz magnitude -> treated as a real change.
check('31h -> changed (too big for a tz offset)', kind(T, T + 31 * H), 'changed');

// Missing values.
check('null stored -> unknown', kind(null, T), 'unknown');
check('null fetched -> unknown', kind(T, null), 'unknown');

// Spot-check a label carries the offset magnitude and direction.
const lbl = classifyDeadlineDiff(T, T + 7 * H).label;
check('7h label mentions ~7h and direction', /~7h/.test(lbl) && /EARLIER/.test(lbl), true);

// --- reviewCategory: which divergences need a human, by provenance -----------
const V = '2026-05-10 12:00';
const Vms = Date.UTC(2026, 4, 10, 12, 0);
const stamp = syncNote(V, '2026-06-01'); // bot's stamp for value V
const rc = (o) => { const r = reviewCategory(o); return r ? r.kind : null; };

// Legacy entries are in transition — never a review item, regardless of diff.
check('legacy note -> no review', rc({ notes: LEGACY_IMPORT_NOTE, storedValue: V, storedMs: Vms, fetchedMs: Vms + 24 * H }), null);
// Bot-managed (stamp matches value): later move auto-syncs (skip), earlier is flagged.
check('bot-managed + later -> no review (auto-syncs)', rc({ notes: stamp, storedValue: V, storedMs: Vms, fetchedMs: Vms + 24 * H }), null);
check('bot-managed + earlier -> bot-earlier', rc({ notes: stamp, storedValue: V, storedMs: Vms, fetchedMs: Vms - 7 * H }), 'bot-earlier');
check('bot-managed + match -> no review', rc({ notes: stamp, storedValue: V, storedMs: Vms, fetchedMs: Vms + 30_000 }), null);
// Human-curated note (not a bot stamp): any real divergence is a conflict.
check('human note + later -> human-conflict', rc({ notes: 'from the workshop website', storedValue: V, storedMs: Vms, fetchedMs: Vms + 24 * H }), 'human-conflict');
check('human note + match -> no review', rc({ notes: 'from the workshop website', storedValue: V, storedMs: Vms, fetchedMs: Vms }), null);
// Stamp present but value no longer matches (human changed the deadline, left the old note) -> conflict.
check('stamp value != stored (human edited value) -> human-conflict', rc({ notes: syncNote('2026-04-27 12:00', '2026-06-01'), storedValue: V, storedMs: Vms, fetchedMs: Vms - 7 * H }), 'human-conflict');
// Missing fetched value -> no review.
check('null fetched -> no review', rc({ notes: stamp, storedValue: V, storedMs: Vms, fetchedMs: null }), null);

// --- isWithinReviewWindow: deadline-relevance scope (the review-noise fix) ----
// A deadline still upcoming or only recently passed is worth reviewing; one
// comfortably behind us (> grace) is dropped from scope entirely. Reference
// instant mirrors issue #16's context (2026-07-08).
const NOW = Date.UTC(2026, 6, 8, 0, 0);
const win = (ms) => isWithinReviewWindow(ms, NOW, 14 * D);
check('future deadline -> in window', win(NOW + 20 * D), true);
check('5 days past -> in window (within grace)', win(NOW - 5 * D), true);
check('exactly at grace edge -> in window', win(NOW - 14 * D), true);
check('just past grace edge -> out of window', win(NOW - 14 * D - 60_000), false);
check('20 days past -> out of window', win(NOW - 20 * D), false);
check('4 months past -> out of window (the CVPR/ICML noise)', win(NOW - 120 * D), false);
check('null deadline -> out of window', win(null), false);
check('default grace applies -> in window', isWithinReviewWindow(NOW + D, NOW), true);

console.log('— website drift —');

// Differences that don't warrant a human's attention.
check('scheme alone is not drift', websiteDrift('http://a.org', 'https://a.org'), null);
check('www alone is not drift', websiteDrift('https://www.a.org', 'https://a.org'), null);
check('trailing slash is not drift', websiteDrift('https://a.org/', 'https://a.org'), null);
check('case is not drift', websiteDrift('https://A.org/X', 'https://a.org/X'.toLowerCase()), null);

// Real moves.
check('different host is drift', websiteDrift('https://a.org', 'https://b.org') !== null, true);
check('different path is drift', websiteDrift('https://a.org/one', 'https://a.org/two') !== null, true);
check('drift keeps the original strings', JSON.stringify(websiteDrift('https://a.org/', 'https://b.org')),
  JSON.stringify({ stored: 'https://a.org/', openreview: 'https://b.org' }));

// One side missing is not actionable here: filling a blank is the importer's job,
// and OpenReview having no website says nothing about ours.
check('no stored website -> nothing', websiteDrift(null, 'https://b.org'), null);
check('no OpenReview website -> nothing', websiteDrift('https://a.org', null), null);
check('neither -> nothing', websiteDrift(null, null), null);
check('normalize strips scheme/www/slash', normalizeWebsite('HTTPS://WWW.Example.org/a/'), 'example.org/a');

console.log('— name / acronym drift —');

// Decoration differs by convention and must stay quiet, or the weekly report
// fills with entries nobody needs to act on.
check('venue suffix is not a rename', titleDrift('The 5th Workshop on Mathematical Reasoning and AI',
  'The 5th Workshop on Mathematical Reasoning and AI at NeurIPS 2025', 'neurips'), null);
check("short year suffix is not a rename", titleDrift('The 4th Workshop on Mathematical Reasoning and AI',
  "The 4th Workshop on Mathematical Reasoning and AI at NeurIPS'24", 'neurips'), null);
check('conference prefix is not a rename', titleDrift('Workshop on Machine Learning for Genomics Explorations',
  'ICLR 2025 Workshop on Machine Learning for Genomics Explorations', 'iclr'), null);
check('punctuation/case is not a rename', titleDrift('AI for Math Workshop', 'AI-for-Math workshop!', 'icml'), null);

// Substance must be reported.
check('a real retitle is reported', titleDrift(
  'NeurIPS 2026 Workshop on Memorization, Privacy, and Legal Risk in Foundation Models',
  'Privacy in the Era of Large Opaque Models: Theoretical, Legal, and Practical Perspectives', 'neurips') !== null, true);
check('an added scope is reported', titleDrift('Queer in AI workshop at NeurIPS 2026',
  'Queer in AI and {Dis}Ability in AI Workshop at NeurIPS 2026', 'neurips') !== null, true);
check('a typo on our side is reported', titleDrift('3th Workshop on Human-inspired Computer Vision',
  '3rd Workshop on Human-inspired Computer Vision', 'eccv') !== null, true);
check('missing either side -> nothing', titleDrift('', 'Something', 'eccv'), null);

// OpenReview's subtitle is only sometimes an acronym; comparing against the
// descriptive ones produced a 4.9% false-positive rate across the dataset.
check('descriptive subtitle is ignored', acronymDrift('PV', 'CVPR 2024 Workshop Prompting in Vision'), null);
check('long subtitle is ignored', acronymDrift('X', 'AbcdefghijklmnopqrstuvW'), null);
check('venue-tagged acronym is not drift', acronymDrift('AI4Math', 'AI4Math@ICML25'), null);
check('separator/case is not drift', acronymDrift('Dexterous_Manipulation', 'dexterous-manipulation'), null);
check('a real acronym change is reported', acronymDrift('MPLR-FM', 'PriLOM') !== null, true);
check('no acronym stored -> nothing', acronymDrift(null, 'PriLOM'), null);

console.log('— acknowledgements (review once, stay quiet, re-flag on a NEW change) —');

// A declined rename stays quiet while OpenReview still says the same thing…
check('acked title stays quiet', titleDrift('Ours: Full Title With Subtitle',
  'Ours: Full Title', 'iros', 'Ours: Full Title'), null);
// …but a LATER, different rename is reported again.
check('a different later title re-flags', titleDrift('Ours: Full Title With Subtitle',
  'Something Else Entirely', 'iros', 'Ours: Full Title') !== null, true);
// Cosmetic churn in the acked value does not un-suppress it.
check('acked title, cosmetic churn stays quiet', titleDrift('Ours: Full Title With Subtitle',
  'ours:  full   title!', 'iros', 'Ours: Full Title'), null);

check('acked website stays quiet',
  websiteDrift('https://ours.example/', 'https://theirs.example/x', 'https://theirs.example/x'), null);
check('a different later website re-flags',
  websiteDrift('https://ours.example/', 'https://third.example/', 'https://theirs.example/x') !== null, true);
check('acked website ignores trailing slash',
  websiteDrift('https://ours.example/', 'https://theirs.example/x', 'https://theirs.example/x/'), null);

check('acked acronym stays quiet', acronymDrift('OURS', 'THEIRS', 'THEIRS'), null);
check('a different later acronym re-flags', acronymDrift('OURS', 'NEWONE', 'THEIRS') !== null, true);

// The production path passes a venue context (since #31, both sides are
// normalised at comparison time). Acks record the RAW upstream value, so the
// ack must be normalised too — without that, cleaning the upstream side
// silently invalidates every ack ever recorded.
{
  const venue = { confName: 'CVPR', confFullName: 'IEEE/CVF Conference on Computer Vision and Pattern Recognition', year: 2026, conf: 'cvpr' };
  const ours = 'AI for Creative Visual Content - Extended Abstract Track';
  const ackedRaw = 'CVPR 2026 Workshop, AI for Creative VisualContent - Extended Abstract Track';
  const upstreamNow = 'AI for Creative VisualContent - Extended Abstract Track'; // as upstreamIdentity() cleans it
  check('acked title stays quiet through the venue context',
    titleDrift(ours, upstreamNow, 'cvpr', ackedRaw, venue), null);
  check('a genuinely new upstream title resurfaces despite the ack',
    titleDrift(ours, 'Something Upstream Renamed It To', 'cvpr', ackedRaw, venue) !== null, true);

  const av = { confName: 'NeurIPS', confFullName: 'Conference on Neural Information Processing Systems', year: 2026, conf: 'neurips' };
  check('acked acronym stays quiet through the venue context',
    acronymDrift('MLxOR', 'MLxOR', 'NeurIPS 2026 MLxOR', av), null);
  check('a genuinely new upstream acronym resurfaces despite the ack',
    acronymDrift('MLxOR', 'MLOR', 'NeurIPS 2026 MLxOR', av) !== null, true);
}

// An acknowledgement never hides a value we DO match, and never invents drift.
check('ack is irrelevant when we already agree', titleDrift('Same Title', 'Same Title', 'iros', 'Whatever'), null);

// A declined DEADLINE behaves the same way: quiet while unchanged, reported again
// if OpenReview moves it somewhere new. (Suppression lives in the run loop, which
// compares instants, so these assert the contract the loop relies on.)
{
  const acked = '2026-08-07 20:59';
  const asMs = (v) => Date.parse(v.replace(' ', 'T') + 'Z');
  check('acked deadline matches an equal instant', asMs(acked) === asMs('2026-08-07 20:59'), true);
  check('a different later deadline does not match', asMs(acked) === asMs('2026-08-05 10:00'), false);
}

// --- needsDirectLookup -------------------------------------------------------
// The batch answers only for the ids it was asked about. Reading a miss on an id
// nobody requested as "this venue has no submission invitation" is what silently
// dropped a fifth of the review scope every week whenever a conference-year
// listing was throttled: the fallback fetched the group, found an empty `date`
// line, missed in a map that had never been asked, and skipped the entry.
{
  const INV = 'IEEE.org/IROS/2026/Workshop/X/-/Submission';
  const withValue = new Map([[INV, 1788177600000]]);
  const empty = new Map();
  const asked = new Set([INV]);
  const notAsked = new Set();

  check('a duedate we already have needs no lookup',
    needsDirectLookup(INV, withValue, true, asked), false);
  check('asked for, absent, all batches complete -> genuinely no invitation',
    needsDirectLookup(INV, empty, true, asked), false);
  check('NEVER asked for -> must look up, absence proves nothing',
    needsDirectLookup(INV, empty, true, notAsked), true);
  check('a throttled batch makes even an asked-for id inconclusive',
    needsDirectLookup(INV, empty, false, asked), true);
  check('never asked AND batches incomplete -> must look up',
    needsDirectLookup(INV, empty, false, notAsked), true);
  // The map wins over everything: a value in hand is never re-fetched.
  check('a held value beats an incomplete batch',
    needsDirectLookup(INV, withValue, false, notAsked), false);
}

// --- the unchecked section ---------------------------------------------------
// Entries OpenReview could not answer for are NAMED, not counted — but they must
// not keep the issue alive on their own, or a throttled day would stop it ever
// auto-closing.
{
  const unchecked = [{
    file: 'data/workshops/x-2026-y.yml', name: 'Some Workshop', conf: 'IROS', year: 2026,
    venueId: 'IEEE.org/IROS/2026/Workshop/Y', reason: 'venue group could not be fetched',
  }];
  const item = [{
    kind: 'human-conflict', slug: 'x-2026-y', file: 'data/workshops/x-2026-y.yml',
    name: 'Some Workshop', conf: 'IROS', year: 2026,
    stored: '2026-08-24 11:59', fetched: '2026-08-31 12:00', label: 'differs by 7.00d',
  }];

  check('unchecked entries alone do NOT keep the report alive',
    buildReport([], [], [], unchecked), '');
  const withBoth = buildReport(item, [], [], unchecked);
  check('a real item renders the unchecked section too',
    withBoth.includes('### Could not be checked this run'), true);
  check('the unchecked entry is named, not counted',
    withBoth.includes('IEEE.org/IROS/2026/Workshop/Y'), true);
  check('a clean run renders no unchecked section',
    buildReport(item, [], [], []).includes('Could not be checked'), false);
}

// --- siblingVenueCandidates --------------------------------------------------
// A workshop lives either under its conference or in its own namespace, and
// organisers move between the two mid-season. Both directions must be proposed,
// and the id we already hold must never be proposed back to us.
{
  const conf = siblingVenueCandidates('NeurIPS.cc/2026/Workshop/ML4PS', { acronym: 'ML4PS', year: 2026 });
  check('conference namespace -> the workshop\'s own', conf, ['ML4PS/2026/Workshop']);

  const own = siblingVenueCandidates('ML4PS/2026/Workshop', { acronym: 'ML4PS', year: 2026 });
  check('own namespace -> every conference namespace', own.includes('NeurIPS.cc/2026/Workshop/ML4PS'), true);
  check('...and never proposes the dead id back', own.includes('ML4PS/2026/Workshop'), false);

  // The id tail and the stored acronym disagree often enough to try both.
  const both = siblingVenueCandidates('NeurIPS.cc/2026/Workshop/Long_Tail', { acronym: 'LTW', year: 2026 });
  check('both the id tail and the acronym are tried',
    both.includes('Long_Tail/2026/Workshop') && both.includes('LTW/2026/Workshop'), true);

  // The year comes from the id when the record does not carry one.
  check('the year is read off the id when absent',
    siblingVenueCandidates('NeurIPS.cc/2025/Workshop/ML4PS', {}), ['ML4PS/2025/Workshop']);
  check('no year anywhere -> no guessing', siblingVenueCandidates('some/opaque/id', {}), []);
  check('no id -> nothing', siblingVenueCandidates('', { year: 2026 }), []);
  // An acronym that would not form a legal id is not turned into one.
  check('a spaced acronym is not made into an id',
    siblingVenueCandidates('NeurIPS.cc/2026/Workshop/X', { acronym: 'Not An Acronym', year: 2026 }),
    ['X/2026/Workshop']);
}

// --- the dead-venue section --------------------------------------------------
{
  const dead = [{
    slug: 'neurips-2026-ml4ps', file: 'data/workshops/neurips-2026-ml4ps.yml',
    name: 'ML4PS', conf: 'NEURIPS', year: 2026,
    venueId: 'NeurIPS.cc/2026/Workshop/ML4PS', moved: 'ML4PS/2026/Workshop',
  }];
  // Unlike an unchecked note, a dead id IS a review item: it is a permanent fault
  // that only a human can fix, and the site is linking it meanwhile.
  const r = buildReport([], [], [], [], dead);
  check('a dead venue id alone keeps the report alive', r !== '', true);
  check('the dead id is named', r.includes('NeurIPS.cc/2026/Workshop/ML4PS'), true);
  check('the verified replacement is offered', r.includes('ML4PS/2026/Workshop'), true);
  const noMove = buildReport([], [], [], [], [{ ...dead[0], moved: null }]);
  check('with no replacement found, it says so rather than guessing',
    noMove.includes('no replacement found'), true);
}

// --- lateResurrection --------------------------------------------------------
// OpenReview's Submission invitation gets reused after submissions close, so its
// duedate jumps weeks forward and the bot used to follow it. The tell is how old
// the OUTGOING deadline was when it was replaced, not how big the jump is — a
// workshop really does extend by three weeks, just not three weeks after closing.
{
  const bot = (v) => syncNote(v, '2026-08-18');
  const entry = (hist, deadline) => ({
    submission_deadline: deadline, timezone: 'UTC',
    deadline_notes: bot(deadline), deadline_history: hist,
  });

  const reopened = entry([
    { value: '2026-08-01 11:59', recorded: '2026-06-23', timezone: 'UTC' },
    { value: '2026-08-31 11:59', recorded: '2026-08-18', timezone: 'UTC' },
  ], '2026-08-31 11:59');
  const r = lateResurrection(reopened);
  check('a deadline extended 17d after closing is flagged', r && r.closedForDays, 17);
  check('...naming both values', r && [r.from, r.to], ['2026-08-01 11:59', '2026-08-31 11:59']);

  // The ordinary late extension the whole system exists to catch.
  check('an extension 2 days after closing is normal, not flagged',
    lateResurrection(entry([
      { value: '2026-08-01 11:59', recorded: '2026-06-23', timezone: 'UTC' },
      { value: '2026-08-20 11:59', recorded: '2026-08-03', timezone: 'UTC' },
    ], '2026-08-20 11:59')), null);

  // A big jump made while the deadline was still OPEN is just an extension.
  check('a 30d jump announced before the deadline is not flagged',
    lateResurrection(entry([
      { value: '2026-08-01 11:59', recorded: '2026-06-23', timezone: 'UTC' },
      { value: '2026-08-31 11:59', recorded: '2026-07-25', timezone: 'UTC' },
    ], '2026-08-31 11:59')), null);

  // Already undone: LifeGenIP's real shape. The bad move is still in the
  // history, but a later move replaced it, so there is nothing to report.
  check('a bad move that was later reverted is not re-reported',
    lateResurrection(entry([
      { value: '2026-07-21 12:00', recorded: '2026-07-16', timezone: 'UTC' },
      { value: '2026-08-14 12:00', recorded: '2026-08-14', timezone: 'UTC' },
      { value: '2026-08-16 12:00', recorded: '2026-08-15', timezone: 'UTC' },
      { value: '2026-07-21 12:00', recorded: '2026-08-20', timezone: 'UTC' },
    ], '2026-07-21 12:00')), null);

  // Human-curated: their call, and frozen against re-sync anyway.
  check('a human-edited deadline is not flagged',
    lateResurrection({ ...reopened, deadline_notes: 'submitted as 2026-08-30 23:59 AoE' }), null);
  check('no history -> nothing to say', lateResurrection(entry([], '2026-08-31 11:59')), null);
  // An earlier move is the review's other category, not this one.
  check('a move EARLIER is not a resurrection',
    lateResurrection(entry([
      { value: '2026-08-31 11:59', recorded: '2026-06-23', timezone: 'UTC' },
      { value: '2026-08-01 11:59', recorded: '2026-08-18', timezone: 'UTC' },
    ], '2026-08-01 11:59')), null);

  const rep = buildReport([], [], [], [], [], [{
    slug: 'x', file: 'data/workshops/x.yml', name: 'X', conf: 'ECCV', year: 2026,
    from: '2026-08-01 11:59', to: '2026-08-31 11:59', on: '2026-08-18', closedForDays: 17,
  }]);
  check('a reopened deadline alone keeps the report alive', rep !== '', true);
  check('...and says how long it had been closed', rep.includes('17 days after it closed'), true);
}

console.log(failed === 0 ? '\nDeadline cross-check logic OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
