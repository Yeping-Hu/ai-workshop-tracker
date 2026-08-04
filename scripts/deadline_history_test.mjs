#!/usr/bin/env node
/**
 * Tests for deadline provenance: the append-only observation log
 * (recordDeadlineObservation) and the UI derivation (deriveDeadlineChange).
 *
 * Run: node scripts/deadline_history_test.mjs
 */
import { deriveDeadlineChange, recordDeadlineObservation } from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs } from '../lib/dates.mjs';

let failed = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  \u2713 ${label}`);
  else {
    console.log(`  \u2717 ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
};

const NOW = Date.parse('2026-08-04T12:00:00Z');
// Mirror what resolveWorkshop injects: each entry is parsed in the zone it was
// recorded in, falling back to the entry's current zone when absent.
const parse = (v, tz) => resolveDeadlineUtcMs(v, tz || 'UTC');
const fmt = (v) => String(v);
const derive = (hist) => deriveDeadlineChange(hist, NOW, parse, fmt);

console.log('— deriveDeadlineChange —');

check('no history yields null', derive(undefined) === null);
check('empty history yields null', derive([]) === null);

const extended = derive([
  { value: '2026-08-05 00:00', recorded: '2026-07-28' },
  { value: '2026-08-12 00:00', recorded: '2026-08-02' },
]);
check('later value reads as extended', extended?.kind === 'extended', JSON.stringify(extended));
check('extension delta in whole days', extended?.days === 7, String(extended?.days));
check('daysAgo counted from recorded', extended?.daysAgo === 2, String(extended?.daysAgo));

const earlier = derive([
  { value: '2026-08-16 00:00', recorded: '2026-07-20' },
  { value: '2026-08-10 00:00', recorded: '2026-08-01' },
]);
check('earlier value reads as earlier', earlier?.kind === 'earlier', JSON.stringify(earlier));
check('earlier delta is positive magnitude', earlier?.days === 6, String(earlier?.days));

const announced = derive([{ value: '2026-08-10 11:59', recorded: '2026-08-03' }]);
check('single entry reads as announced', announced?.kind === 'announced');

const fromNull = derive([
  { value: null, recorded: '2026-06-30' },
  { value: '2026-08-10 11:59', recorded: '2026-08-03' },
]);
check('null -> date reads as announced', fromNull?.kind === 'announced');

check(
  'date -> null is not reported',
  derive([
    { value: '2026-08-10 11:59', recorded: '2026-07-01' },
    { value: null, recorded: '2026-08-03' },
  ]) === null,
);

check(
  'stale change falls outside the 14-day window',
  derive([
    { value: '2026-08-05 00:00', recorded: '2026-06-01' },
    { value: '2026-08-12 00:00', recorded: '2026-07-01' },
  ]) === null,
);

check(
  'sub-hour delta suppressed as sync noise',
  derive([
    { value: '2026-08-12 00:00', recorded: '2026-08-01' },
    { value: '2026-08-12 00:30', recorded: '2026-08-02' },
  ]) === null,
  'a timezone re-read must not render as a change',
);

check(
  'only the latest transition is described',
  derive([
    { value: '2026-08-01 00:00', recorded: '2026-07-10' },
    { value: '2026-08-05 00:00', recorded: '2026-07-28' },
    { value: '2026-08-12 00:00', recorded: '2026-08-02' },
  ])?.days === 7,
);

check('future recorded date is ignored', derive([
  { value: '2026-08-05 00:00', recorded: '2026-07-28' },
  { value: '2026-08-12 00:00', recorded: '2026-09-01' },
]) === null);

console.log('— recordDeadlineObservation —');

const a = { submission_deadline: '2026-08-05 00:00', deadline_notes: 'OpenReview-synced 2026-08-05 00:00 UTC (as of 2026-07-28) — verify.' };
check('first change appends two entries', recordDeadlineObservation(a, '2026-08-12 00:00', '2026-08-04') === true);
check('outgoing value seeded from the (as of) stamp', a.deadline_history?.[0]?.recorded === '2026-07-28', JSON.stringify(a.deadline_history));
check('new value recorded today', a.deadline_history?.[1]?.recorded === '2026-08-04');
check('log is chronological', a.deadline_history?.[0]?.value === '2026-08-05 00:00');

check('re-observing the same value is a no-op', recordDeadlineObservation(a, '2026-08-12 00:00', '2026-08-05') === false);
check('no-op left the log untouched', a.deadline_history.length === 2);

const b = { submission_deadline: '2026-08-05 00:00', added: '2026-06-14' };
recordDeadlineObservation(b, '2026-08-12 00:00', '2026-08-04');
check('falls back to `added` with no sync stamp', b.deadline_history?.[0]?.recorded === '2026-06-14');

const c = {};
recordDeadlineObservation(c, '2026-09-01 23:59', '2026-08-04');
check('entry with no prior deadline logs one entry', c.deadline_history?.length === 1);
check('that entry derives as announced', deriveDeadlineChange(c.deadline_history, NOW, parse, fmt)?.kind === 'announced');

console.log('— per-entry timezone —');

// A recorded value only fixes an instant together with its zone.
{
  const e = { submission_deadline: '2026-08-05 00:00', timezone: 'AoE', added: '2026-07-01' };
  recordDeadlineObservation(e, '2026-08-05 00:00', '2026-08-04', 'UTC');
  check('zone change alone is a real move, not a no-op', e.deadline_history?.length === 2, JSON.stringify(e.deadline_history));
  check('outgoing entry keeps the zone it was stored in', e.deadline_history?.[0]?.timezone === 'AoE');
  check('incoming entry records the new zone', e.deadline_history?.[1]?.timezone === 'UTC');
  // AoE is UTC-12, so the same wall clock in UTC is 12h EARLIER.
  const d = deriveDeadlineChange(e.deadline_history, NOW, parse, fmt);
  check('cross-zone delta measured between instants', d?.kind === 'earlier', JSON.stringify(d));
}

// Identical value AND zone is still a no-op.
{
  const e = { submission_deadline: '2026-08-05 00:00', timezone: 'UTC', added: '2026-07-01' };
  recordDeadlineObservation(e, '2026-08-12 00:00', '2026-08-02', 'UTC');
  check('same value and zone is a no-op', recordDeadlineObservation(e, '2026-08-12 00:00', '2026-08-04', 'UTC') === false);
}

// A null value carries no zone.
{
  const e = {};
  recordDeadlineObservation(e, null, '2026-08-04', 'UTC');
  check('null value stores no timezone', e.deadline_history?.[0] && !('timezone' in e.deadline_history[0]), JSON.stringify(e.deadline_history));
}

// Entries written before the field existed still resolve, via the fallback zone.
{
  const legacy = [
    { value: '2026-08-05 00:00', recorded: '2026-07-28' },
    { value: '2026-08-12 00:00', recorded: '2026-08-02' },
  ];
  const d = deriveDeadlineChange(legacy, NOW, parse, fmt);
  check('legacy entries without a zone still derive', d?.kind === 'extended' && d?.days === 7, JSON.stringify(d));
}

console.log(failed === 0 ? '\nAll deadline-history checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
