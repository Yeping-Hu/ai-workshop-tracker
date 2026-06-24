#!/usr/bin/env node
/**
 * Verifies the daily imminent-deadline re-check's selection logic
 * (`isImminentBotManaged`) — the pure predicate that decides which entries the
 * job re-checks. The actual extension apply reuses the weekly bot's already
 * tested helpers (decideDeadlineUpdate / syncNote / syncedValue, covered by
 * deadline_sync_test.mjs), so this test focuses on the band + freeze gates that
 * are unique to this job. No network, no filesystem.
 *
 * Run: node scripts/recheck_imminent_test.mjs
 */
import { isImminentBotManaged } from './recheck_imminent.mjs';
import { syncNote, LEGACY_IMPORT_NOTE } from './discover_openreview.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

const DAY = 86_400_000;
// Fixed "now" on a minute boundary so whole-day offsets resolve exactly.
const NOW = Date.UTC(2026, 6, 15, 12, 0); // 2026-07-15 12:00 UTC
const pad = (n) => String(n).padStart(2, '0');
// A UTC deadline string `offsetDays` from NOW, e.g. +5 or -3.
const at = (offsetDays) => {
  const d = new Date(NOW + offsetDays * DAY);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

// A well-formed, in-band, bot-managed entry — used as the baseline that each
// case perturbs one field of.
const base = (offsetDays, over = {}) => {
  const dl = at(offsetDays);
  return {
    conference: 'eccv',
    year: 2026,
    openreview_venue_id: 'thecvf.com/ECCV/2026/Workshop/Example',
    submission_deadline: dl,
    timezone: 'UTC',
    deadline_notes: syncNote(dl, '2026-07-15'), // stamp matches stored value
    ...over,
  };
};

// --- band: forward and look-back, including the late-extension case ---------
check('imminent ahead (+5d) -> eligible', isImminentBotManaged(base(5), NOW), true);
check('just-passed (-3d) -> eligible (late-extension window)', isImminentBotManaged(base(-3), NOW), true);
check('+14d boundary -> eligible', isImminentBotManaged(base(14), NOW), true);
check('-7d boundary -> eligible', isImminentBotManaged(base(-7), NOW), true);
check('too far ahead (+15d) -> skipped', isImminentBotManaged(base(15), NOW), false);
check('passed too long ago (-8d) -> skipped', isImminentBotManaged(base(-8), NOW), false);

// --- freeze / scope gates (all in-band, only the disqualifier differs) ------
// Human edited the deadline after the bot stamped it: stored value no longer
// matches the stamp, so it must be frozen (left for deadline-review).
check('human-edited (stamp != stored) -> skipped', isImminentBotManaged(base(5, { deadline_notes: syncNote(at(2), '2026-07-15') }), NOW), false);
check('free-text human note -> skipped', isImminentBotManaged(base(5, { deadline_notes: 'from the workshop website' }), NOW), false);
check('legacy import marker (unadopted) -> skipped', isImminentBotManaged(base(5, { deadline_notes: LEGACY_IMPORT_NOTE }), NOW), false);
check('no deadline_notes -> skipped', isImminentBotManaged(base(5, { deadline_notes: undefined }), NOW), false);
check('no openreview_venue_id -> skipped', isImminentBotManaged(base(5, { openreview_venue_id: undefined }), NOW), false);
check('multi-track (has tracks) -> skipped', isImminentBotManaged(base(5, { tracks: [{ name: 'Full' }, { name: 'Short' }] }), NOW), false);
check('no submission_deadline -> skipped', isImminentBotManaged({ openreview_venue_id: 'x', deadline_notes: 'OpenReview-synced 2026-08-01 UTC' }, NOW), false);
check('null/garbage record -> skipped', [isImminentBotManaged(null, NOW), isImminentBotManaged({}, NOW)], [false, false]);

console.log(failed === 0 ? '\nImminent re-check selection logic OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
