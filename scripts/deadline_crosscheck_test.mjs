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
import { classifyDeadlineDiff } from './deadline_crosscheck.mjs';

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

console.log(failed === 0 ? '\nDeadline cross-check logic OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
