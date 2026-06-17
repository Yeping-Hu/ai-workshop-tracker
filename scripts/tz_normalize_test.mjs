#!/usr/bin/env node
/**
 * Verifies the OpenReview importer normalizes every extracted deadline to UTC,
 * so the stored dataset stays timezone-consistent (the site converts to the
 * viewer's local time at display). Whatever offset a venue uses — AoE
 * (UTC−12), UTC+9, anything — must come out as the equivalent UTC instant,
 * never relabeled. Pure logic over the exported helpers; no network.
 *
 * Run: node scripts/tz_normalize_test.mjs
 */
import { parseGroupDeadline, msToDeadline } from './discover_openreview.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

// parseGroupDeadline: an AoE (UTC−12) offset must convert to UTC, same instant.
// "...11:59PM UTC-12" on Jul 15 = 2026-07-16 11:59 UTC.
check(
  'parseGroupDeadline: AoE (UTC-12) offset -> UTC',
  parseGroupDeadline('Submission Deadline: Jul 15 2026 11:59PM UTC-12'),
  { submission_deadline: '2026-07-16 11:59', timezone: 'UTC' },
);

// A positive offset converts too.
check(
  'parseGroupDeadline: UTC+9 -> UTC',
  parseGroupDeadline('Submission Deadline: Jul 15 2026 09:00AM UTC+9'),
  { submission_deadline: '2026-07-15 00:00', timezone: 'UTC' },
);

// A plain UTC offset passes through unchanged.
check(
  'parseGroupDeadline: UTC-0 stays UTC',
  parseGroupDeadline('Submission Deadline: Apr 27 2026 12:00PM UTC-0'),
  { submission_deadline: '2026-04-27 12:00', timezone: 'UTC' },
);

// msToDeadline: epoch in -> always UTC out, including at the instant that is
// exactly 23:59 AoE (the former AoE special-case, now removed).
// 2026-07-16 11:59 UTC == 2026-07-15 23:59 AoE.
check(
  'msToDeadline: AoE-23:59 instant -> UTC (no relabel)',
  msToDeadline(Date.parse('2026-07-16T11:59:00Z')),
  { submission_deadline: '2026-07-16 11:59', timezone: 'UTC' },
);

// msToDeadline: an arbitrary instant -> UTC.
check(
  'msToDeadline: arbitrary instant -> UTC',
  msToDeadline(Date.parse('2026-05-09T17:30:00Z')),
  { submission_deadline: '2026-05-09 17:30', timezone: 'UTC' },
);

console.log(failed === 0 ? '\nImporter normalizes all timezones to UTC.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
