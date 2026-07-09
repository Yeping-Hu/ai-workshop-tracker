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
import { classifyDeadlineDiff, reviewCategory, isWithinReviewWindow } from './deadline_crosscheck.mjs';
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

console.log(failed === 0 ? '\nDeadline cross-check logic OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
