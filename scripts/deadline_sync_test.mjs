#!/usr/bin/env node
/**
 * Verifies the deadline-sync logic added to the OpenReview discovery bot:
 *   - decideDeadlineUpdate: later-only by default; unchanged/null are no-ops;
 *     earlier updates only when explicitly allowed. Compares UTC instants, so
 *     the same moment in two wall-clock forms is "unchanged", not a change.
 *   - syncNote / syncedValue: the bot stamps the exact value it wrote into
 *     `deadline_notes` and reads it back, so a human edit to the value (even one
 *     that leaves the note alone) is detectable and freezes the entry. Legacy,
 *     SEED-estimate, human, and empty notes are NOT recognized as bot stamps.
 * Pure logic over the exported helpers; no network, no filesystem.
 *
 * Run: node scripts/deadline_sync_test.mjs
 */
import { decideDeadlineUpdate, syncNote, syncedValue } from './discover_openreview.mjs';
import { resolveDeadlineUtcMs } from '../lib/dates.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

const ms = (v) => resolveDeadlineUtcMs(v, 'UTC');
const APR = '2026-04-27 12:00';
const MAY = '2026-05-10 12:00'; // later than APR
const MAR = '2026-03-01 12:00'; // earlier than APR

// --- decideDeadlineUpdate ---------------------------------------------------
check('unchanged -> no update', decideDeadlineUpdate(ms(APR), ms(APR)), { update: false, reason: 'unchanged' });
check('later -> update', decideDeadlineUpdate(ms(APR), ms(MAY)), { update: true, reason: 'later' });
check('earlier -> blocked (later-only default)', decideDeadlineUpdate(ms(APR), ms(MAR)), { update: false, reason: 'earlier-blocked' });
check('earlier + allowEarlier -> update', decideDeadlineUpdate(ms(APR), ms(MAR), { allowEarlier: true }), { update: true, reason: 'earlier' });
check('null fetched -> no update', decideDeadlineUpdate(ms(APR), null), { update: false, reason: 'no-fetched' });
check('null stored -> no update', decideDeadlineUpdate(null, ms(MAY)), { update: false, reason: 'no-stored' });
// The same instant in two representations must compare equal (date-only resolves
// to 23:59), so formatting noise never registers as a change.
check('equal instant, date-only vs 23:59', decideDeadlineUpdate(ms('2026-04-27'), ms('2026-04-27 23:59')), { update: false, reason: 'unchanged' });

// --- syncNote / syncedValue round-trip --------------------------------------
check('stamp round-trips (timed)', syncedValue(syncNote(APR, '2026-06-18')), APR);
check('stamp round-trips (date-only)', syncedValue(syncNote('2026-09-15', '2026-06-18')), '2026-09-15');
check('legacy import marker is NOT a stamp', syncedValue('imported from OpenReview — check the website for extensions'), null);
check('SEED estimate note is NOT a stamp', syncedValue('SEED estimate of the historical deadline — verify'), null);
check('human note is NOT a stamp', syncedValue('from the workshop website'), null);
check('empty / non-string -> null', [syncedValue(''), syncedValue(null), syncedValue(undefined)], [null, null, null]);

// --- "freeze on human touch" at the value level -----------------------------
// Bot stamped V0; a human later edits the deadline to V1 without touching the
// note. The stamp still reads V0, so stored (V1) !== stamp (V0): NOT bot-managed
// => the caller freezes it. Assert the exact mismatch the gate relies on.
{
  const V0 = APR, V1 = MAY;
  const stampForV0 = syncedValue(syncNote(V0, '2026-06-18'));
  check('human-edited value no longer matches stamp (=> frozen)', stampForV0 === V1, false);
  check('untouched value still matches stamp (=> managed)', syncedValue(syncNote(V1, '2026-06-18')) === V1, true);
}

console.log(failed === 0 ? '\nDeadline-sync logic OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
