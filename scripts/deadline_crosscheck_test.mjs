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
import { classifyDeadlineDiff, reviewCategory, isWithinReviewWindow, websiteDrift, normalizeWebsite, titleDrift, acronymDrift } from './deadline_crosscheck.mjs';
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

console.log(failed === 0 ? '\nDeadline cross-check logic OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
