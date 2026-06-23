#!/usr/bin/env node
/**
 * Tests for applyWorkshopEdit (scripts/issue_edit_to_yaml.mjs) — the pure
 * transform that applies an "Edit a workshop" form to an existing record.
 */
import { applyWorkshopEdit } from './issue_edit_to_yaml.mjs';
import { resolveDeadlineUtcMs } from '../lib/dates.mjs';
import { syncNote } from './discover_openreview.mjs';

let failed = 0;
const check = (name, cond) => { if (!cond) { failed++; console.log(`FAIL: ${name}`); } };
const throws = (name, fn, rx) => {
  try { fn(); failed++; console.log(`FAIL: ${name} (did not throw)`); }
  catch (e) { if (rx && !rx.test(e.message)) { failed++; console.log(`FAIL: ${name} (wrong message: ${e.message})`); } }
};

const base = () => ({
  name: 'My Workshop', conference: 'icml', year: 2026,
  website: 'https://old.example.com', topics: ['ml'],
  submission_deadline: '2026-05-01 12:00', timezone: 'UTC',
  deadline_notes: syncNote('2026-05-01 12:00', '2026-04-01'), // bot stamp (machine note)
  added: '2026-03-01',
});

// 1) Non-UTC deadline converts to a UTC instant (round-trip), tz becomes UTC,
//    identity + unrelated fields preserved, stale machine note replaced by provenance.
{
  const { record, changes } = applyWorkshopEdit(base(), { deadline: '2026-05-10 23:59', timezone: 'America/Los_Angeles' });
  check('tz: timezone normalized to UTC', record.timezone === 'UTC');
  check('tz: value changed', record.submission_deadline !== '2026-05-10 23:59');
  check('tz: round-trips to the same instant',
    resolveDeadlineUtcMs(record.submission_deadline, 'UTC') === resolveDeadlineUtcMs('2026-05-10 23:59', 'America/Los_Angeles'));
  check('tz: provenance breadcrumb recorded', /submitted as 2026-05-10 23:59 America\/Los_Angeles/.test(record.deadline_notes));
  check('tz: stale bot stamp replaced (not appended)', !/OpenReview-synced/.test(record.deadline_notes));
  check('tz: identity preserved', record.name === 'My Workshop' && record.conference === 'icml' && record.year === 2026);
  check('tz: unrelated field preserved', record.added === '2026-03-01' && JSON.stringify(record.topics) === JSON.stringify(['ml']));
  check('tz: changes lists the deadline', changes.includes('submission_deadline'));
}

// 2) Deadline without a timezone is rejected.
throws('deadline without timezone throws', () => applyWorkshopEdit(base(), { deadline: '2026-05-10 23:59' }), /timezone/i);

// 3) Unknown timezone is rejected.
throws('unknown timezone throws', () => applyWorkshopEdit(base(), { deadline: '2026-05-10 23:59', timezone: 'Mars/Phobos' }), /timezone/i);

// 4) UTC deadline: value kept as-is, stale machine note dropped (no provenance).
{
  const { record } = applyWorkshopEdit(base(), { deadline: '2026-05-12 09:00', timezone: 'UTC' });
  check('utc: value kept verbatim', record.submission_deadline === '2026-05-12 09:00');
  check('utc: timezone UTC', record.timezone === 'UTC');
  check('utc: stale machine note dropped', record.deadline_notes === undefined);
}

// 5) UTC deadline preserves a human-written note (not a machine stamp).
{
  const rec = { ...base(), deadline_notes: 'abstracts due one week earlier' };
  const { record } = applyWorkshopEdit(rec, { deadline: '2026-05-12 09:00', timezone: 'UTC' });
  check('utc: human note preserved', record.deadline_notes === 'abstracts due one week earlier');
}

// 6) Non-UTC deadline appends provenance to a human note (preserves it).
{
  const rec = { ...base(), deadline_notes: 'abstracts due one week earlier' };
  const { record } = applyWorkshopEdit(rec, { deadline: '2026-05-10 23:59', timezone: 'America/Los_Angeles' });
  check('append: human note kept', /abstracts due one week earlier/.test(record.deadline_notes));
  check('append: provenance added', /submitted as .*America\/Los_Angeles/.test(record.deadline_notes));
}

// 7) Explicit deadline note + tz => note plus a parenthetical provenance.
{
  const { record } = applyWorkshopEdit(base(), { deadline: '2026-05-10 23:59', timezone: 'America/Los_Angeles', deadlineNotes: 'round 2' });
  check('explicit note: used with provenance suffix', /^round 2 \(submitted as 2026-05-10 23:59 America\/Los_Angeles\)$/.test(record.deadline_notes));
}

// 8) Website update only.
{
  const { record, changes } = applyWorkshopEdit(base(), { website: 'https://new.example.com' });
  check('website: updated', record.website === 'https://new.example.com');
  check('website: only website changed', JSON.stringify(changes) === JSON.stringify(['website']));
  check('website: deadline untouched', record.submission_deadline === '2026-05-01 12:00');
}

// 9) Invalid website rejected.
throws('invalid website throws', () => applyWorkshopEdit(base(), { website: 'new.example.com' }), /http/i);

// 10) Notes-only edit (deadline unchanged).
{
  const { record, changes } = applyWorkshopEdit(base(), { deadlineNotes: 'now also accepting demos' });
  check('notes: deadline_notes updated', record.deadline_notes === 'now also accepting demos');
  check('notes: deadline value untouched', record.submission_deadline === '2026-05-01 12:00' && record.timezone === 'UTC');
  check('notes: only deadline_notes changed', JSON.stringify(changes) === JSON.stringify(['deadline_notes']));
}

// 11) "Anything else" maps to notes.
{
  const { record, changes } = applyWorkshopEdit(base(), { anything: 'merged with the co-located workshop' });
  check('anything: notes set', record.notes === 'merged with the co-located workshop');
  check('anything: changes lists notes', changes.includes('notes'));
}

// 12) All blank / unchanged => throws (nothing to do).
throws('no fields throws', () => applyWorkshopEdit(base(), {}), /No changes/i);
throws('unchanged website throws', () => applyWorkshopEdit(base(), { website: 'https://old.example.com' }), /No changes/i);

console.log(failed === 0 ? '\nEdit-form transform OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
