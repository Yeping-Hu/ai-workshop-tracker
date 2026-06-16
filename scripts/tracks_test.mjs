#!/usr/bin/env node
/**
 * Regression tests for multi-track workshops (e.g. ECCV MARINE: Full + Short).
 * Pure logic over lib/workshops.mjs at controlled `now` timestamps — no
 * network, no build. Run: node scripts/tracks_test.mjs
 *
 * Encodes the agreed rules:
 *   - headline deadline = soonest track still in the future (rolls forward)
 *   - any future track            -> Open call
 *   - else any TBA track          -> Deadline unknown  (NOT Past)
 *   - else (all announced+passed) -> Past
 */
import { resolveWorkshop } from '../lib/workshops.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = got === expect;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${got}${ok ? '' : `  (expected ${expect})`}`);
}

// Helper: resolve a synthetic multi-track workshop at a given `now`.
function resolve(tracks, nowIso) {
  const raw = { conference: 'eccv', year: 2026, name: 'T', acronym: 'T', tracks };
  const w = resolveWorkshop({ slug: 't', file: 't.yml', raw }, Date.parse(nowIso), {}, {});
  // mimic loadWorkshops' label step (no papers in these synthetic cases)
  w.statusLabel =
    w.status === 'past' || w.status === 'deadline_passed' ? 'Past'
    : w.deadlineUtcMs == null ? 'Deadline unknown'
    : 'Open call';
  return w;
}

const FULL = { name: 'Full', submission_deadline: '2026-07-13 12:00', timezone: 'UTC' };
const SHORT_DATED = { name: 'Short', submission_deadline: '2026-07-20 12:00', timezone: 'UTC' };
const SHORT_TBA = { name: 'Short' };

// 1. Both future -> headline is the SOONER (Full), Open call.
let w = resolve([FULL, SHORT_DATED], '2026-06-16T00:00:00Z');
check('both future: label', w.statusLabel, 'Open call');
check('both future: headline = sooner (Jul 13)', w.deadlineWallClock, 'Jul 13, 2026, 12:00 UTC');

// 2. Full passed, Short still future -> headline ROLLS to Short, still Open call.
w = resolve([FULL, SHORT_DATED], '2026-07-15T00:00:00Z');
check('Full passed, Short future: label', w.statusLabel, 'Open call');
check('Full passed: headline rolled to Short (Jul 20)', w.deadlineWallClock, 'Jul 20, 2026, 12:00 UTC');

// 3. Full passed, Short TBA -> Deadline unknown (the key rule), NOT Past.
w = resolve([FULL, SHORT_TBA], '2026-07-15T00:00:00Z');
check('Full passed, Short TBA: label', w.statusLabel, 'Deadline unknown');
check('Full passed, Short TBA: not Past', w.status !== 'past', true);

// 4. Full future, Short TBA (MARINE today) -> Open call, headline = Full.
w = resolve([FULL, SHORT_TBA], '2026-06-16T00:00:00Z');
check('Full future, Short TBA: label', w.statusLabel, 'Open call');
check('Full future, Short TBA: headline = Full', w.deadlineWallClock, 'Jul 13, 2026, 12:00 UTC');

// 5. Both passed -> Past, headline = the later one.
w = resolve([FULL, SHORT_DATED], '2026-08-01T00:00:00Z');
check('both passed: label', w.statusLabel, 'Past');
check('both passed: headline = later (Jul 20)', w.deadlineWallClock, 'Jul 20, 2026, 12:00 UTC');

console.log(failed === 0 ? '\nAll track tests passed.' : `\n${failed} track test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
