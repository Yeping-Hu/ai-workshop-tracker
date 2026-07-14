#!/usr/bin/env node
/**
 * Regression tests for mergeTracks — the per-track merge policy used by the
 * multi-track sync (scripts/sync_tracks.mjs). Pure logic, no network, no build.
 * Run: node scripts/sync_tracks_test.mjs
 *
 * Encodes the agreed policy (same human-safe, later-only rules the
 * single-deadline sync uses, applied per track matched by name):
 *   - blank track            -> filled
 *   - dated, later on OR       -> updated (extension)   [later-only by default]
 *   - dated, earlier on OR      -> kept (earlier-blocked)
 *   - dated, equal instant       -> kept (unchanged)
 *   - new OR track                -> added
 *   - stored track OR omits        -> kept (never dropped)
 *   - OR track still TBA            -> ignored (nothing to fill)
 */
import { mergeTracks } from './discover_openreview.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = got === expect;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}
const dl = (name, d) => (d ? { name, submission_deadline: d, timezone: 'UTC' } : { name });
const find = (tracks, name) => tracks.find((t) => t.name === name) || {};

// 1. Fill a blank track; leave an equal one untouched.
{
  const { tracks, changes } = mergeTracks([dl('Full', '2026-07-15 10:00'), dl('Short')], [dl('Full', '2026-07-15 10:00'), dl('Short', '2026-08-01 04:00')]);
  check('fill blank: Short filled', find(tracks, 'Short').submission_deadline, '2026-08-01 04:00');
  check('fill blank: Full unchanged', find(tracks, 'Full').submission_deadline, '2026-07-15 10:00');
  check('fill blank: one change', changes.length, 1);
}

// 2. Later move on an existing dated track (the extension case).
{
  const { tracks, changes } = mergeTracks([dl('Full', '2026-07-13 12:00')], [dl('Full', '2026-07-15 10:00')]);
  check('later move: updated', find(tracks, 'Full').submission_deadline, '2026-07-15 10:00');
  check('later move: one change', changes.length, 1);
}

// 3. Earlier move is blocked by default.
{
  const { tracks, changes } = mergeTracks([dl('Full', '2026-07-20 12:00')], [dl('Full', '2026-07-15 10:00')]);
  check('earlier blocked: kept', find(tracks, 'Full').submission_deadline, '2026-07-20 12:00');
  check('earlier blocked: no change', changes.length, 0);
}

// 4. Earlier move applied when allowEarlier.
{
  const { tracks, changes } = mergeTracks([dl('Full', '2026-07-20 12:00')], [dl('Full', '2026-07-15 10:00')], { allowEarlier: true });
  check('allowEarlier: updated', find(tracks, 'Full').submission_deadline, '2026-07-15 10:00');
  check('allowEarlier: one change', changes.length, 1);
}

// 5. Equal instant -> no change.
{
  const { changes } = mergeTracks([dl('Full', '2026-07-15 10:00')], [dl('Full', '2026-07-15 10:00')]);
  check('equal: no change', changes.length, 0);
}

// 6. A new OpenReview track is added; a stored track OpenReview omits is kept.
{
  const { tracks, changes } = mergeTracks([dl('Full', '2026-07-15 10:00'), dl('Short', '2026-08-01 04:00')], [dl('Full', '2026-07-15 10:00'), dl('Poster', '2026-08-10 23:59')]);
  check('new track: Poster added', find(tracks, 'Poster').submission_deadline, '2026-08-10 23:59');
  check('omitted track: Short kept', find(tracks, 'Short').submission_deadline, '2026-08-01 04:00');
  check('add+keep: one change (add only)', changes.length, 1);
  check('add+keep: three tracks total', tracks.length, 3);
}

// 7. An OpenReview track still TBA is ignored (won't blank an existing value, won't add).
{
  const { tracks, changes } = mergeTracks([dl('Full', '2026-07-15 10:00')], [dl('Full', '2026-07-15 10:00'), dl('Short')]);
  check('OR TBA: ignored (no add)', tracks.length, 1);
  check('OR TBA: no change', changes.length, 0);
}

// 8. The full MARINE scenario: Full extended + Short filled in one merge.
{
  const { tracks, changes } = mergeTracks([dl('Full', '2026-07-13 12:00'), dl('Short')], [dl('Full', '2026-07-15 10:00'), dl('Short', '2026-08-01 04:00')]);
  check('MARINE: Full extended', find(tracks, 'Full').submission_deadline, '2026-07-15 10:00');
  check('MARINE: Short filled', find(tracks, 'Short').submission_deadline, '2026-08-01 04:00');
  check('MARINE: two changes', changes.length, 2);
}

// 9. Order is preserved (stored order first, new tracks appended).
{
  const { tracks } = mergeTracks([dl('Full', '2026-07-15 10:00'), dl('Short', '2026-08-01 04:00')], [dl('Poster', '2026-08-10 23:59')]);
  check('order: names in order', tracks.map((t) => t.name).join(','), 'Full,Short,Poster');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll mergeTracks checks passed.');
process.exit(failed ? 1 : 0);
