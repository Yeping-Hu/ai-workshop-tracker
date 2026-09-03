#!/usr/bin/env node
/**
 * Tests for the shared date parsers in lib/dates.mjs, and the one importer
 * regex that feeds them.
 *
 * The bug these pin: `Date.UTC` rolls an impossible date forward without a
 * word, so "2026-02-30" used to match the deadline shape, display as "Feb 30"
 * and resolve to March 2nd — the board counted down to a day it did not print.
 * The issue-form path had the right guard (assembleDeadline); the parsers every
 * other path goes through did not. And an offset written as hours:minutes
 * ("UTC+5:30") matched only its hour, storing a deadline thirty minutes late.
 *
 * Pure logic — no network, no build. Run: node scripts/dates_test.mjs
 */
import {
  isRealDate,
  parseDeadlineString,
  parseDateUtcMs,
  resolveDeadlineUtcMs,
  formatDeadlineWallClock,
  formatDateYmd,
  assembleDeadline,
} from '../lib/dates.mjs';
import { parseGroupDeadline } from './discover_openreview.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

/* ------------------------------------------------ impossible dates are null */
check('isRealDate: Feb 29 in a leap year', isRealDate(2028, 2, 29), true);
check('isRealDate: Feb 29 in a common year', isRealDate(2026, 2, 29), false);
check('isRealDate: Feb 30', isRealDate(2026, 2, 30), false);
check('isRealDate: Apr 31', isRealDate(2026, 4, 31), false);
check('isRealDate: month 13', isRealDate(2026, 13, 1), false);
check('isRealDate: day 0', isRealDate(2026, 1, 0), false);

check('parseDeadlineString: a real date parses', parseDeadlineString('2026-08-22 23:59')?.day, 22);
check('parseDeadlineString: Feb 30 is rejected, not rolled to March', parseDeadlineString('2026-02-30'), null);
check('parseDeadlineString: Apr 31 with a time is rejected', parseDeadlineString('2026-04-31 12:00'), null);
check('parseDeadlineString: 24:00 is rejected', parseDeadlineString('2026-04-30 24:00'), null);
check('resolveDeadlineUtcMs: an impossible date resolves to nothing', resolveDeadlineUtcMs('2026-02-30', 'UTC'), null);
check('formatDeadlineWallClock: an impossible date renders nothing (never "Feb 30")', formatDeadlineWallClock('2026-02-30', 'UTC'), null);

check('parseDateUtcMs: a real date', parseDateUtcMs('2026-12-06'), Date.UTC(2026, 11, 6));
check('parseDateUtcMs: Feb 30 is rejected', parseDateUtcMs('2026-02-30'), null);
check('formatDateYmd: falls back to the raw string for an impossible date', formatDateYmd('2026-02-30'), '2026-02-30');
check('assembleDeadline: still refuses Feb 30 (same guard, one definition)',
  (() => { try { assembleDeadline({ year: 2026, month: 2, day: 30 }); return 'accepted'; } catch { return 'rejected'; } })(),
  'rejected');

/* ------------------------------------------------------- display formatting */
check('formatDeadlineWallClock: AoE label', formatDeadlineWallClock('2026-08-22', 'AoE'), 'Aug 22, 2026, 23:59 AoE (UTC−12)');
check('formatDeadlineWallClock: UTC with a time', formatDeadlineWallClock('2026-08-22 09:05', 'UTC'), 'Aug 22, 2026, 09:05 UTC');

/* ---------------------------------------------- importer offsets, all forms */
const dl = (s) => parseGroupDeadline(`Submission Deadline: ${s}`)?.submission_deadline ?? null;
check('offset UTC-0', dl('Apr 27 2026 11:59PM UTC-0'), '2026-04-27 23:59');
check('offset UTC-12 (AoE)', dl('Apr 27 2026 11:59PM UTC-12'), '2026-04-28 11:59');
check('offset UTC+9', dl('Apr 27 2026 09:00AM UTC+9'), '2026-04-27 00:00');
check('offset UTC+5.5 (decimal hours)', dl('Apr 27 2026 11:59PM UTC+5.5'), '2026-04-27 18:29');
check('offset UTC+5:30 (hours:minutes) — the minutes are not dropped', dl('Apr 27 2026 11:59PM UTC+5:30'), '2026-04-27 18:29');
check('offset UTC-3:30 (negative hours:minutes)', dl('Apr 27 2026 11:59PM UTC-3:30'), '2026-04-28 03:29');
check('offset UTC+05:30 (zero-padded)', dl('Apr 27 2026 11:59PM UTC+05:30'), '2026-04-27 18:29');
check('date-only line means 23:59', dl('Apr 27 2026 UTC-0'), '2026-04-27 23:59');

console.log(failed === 0 ? '\nDate parsing OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
