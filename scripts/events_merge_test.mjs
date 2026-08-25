#!/usr/bin/env node
/**
 * Tests for mergeEventsBySlug — one row per workshop, carrying the net change.
 * Run: node scripts/events_merge_test.mjs
 *
 * Why this exists: the event store records each hop of a deadline separately,
 * which is right — each was a real observation. But both consumers want one line
 * per workshop, and a workshop extended 7 days and then 1 more had an 8-day
 * extension, not two different ones. Three workshops were doing exactly that on
 * the live page.
 *
 * The rule runs in the digest AND on /changes/, so a disagreement here would put
 * a different number of rows in the email than on the page. That is the drift
 * this pins.
 */
import { mergeEventsBySlug } from '../lib/events.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}
const at = (d) => `2026-08-${String(d).padStart(2, '0')}T12:00:00.000Z`;
const ev = (slug, kind, days, o, n) => ({ slug, kind, days, old_utc: o, new_utc: n });
const one = (list) => mergeEventsBySlug(list)[0];

// --- the case that prompted this -----------------------------------------
check('two extensions become one net extension',
  (() => { const r = one([ev('a', 'extended', 7, at(1), at(8)), ev('a', 'extended', 1, at(8), at(9))]);
    return [r.kind, r.days, r.old_utc, r.new_utc]; })(),
  ['extended', 8, at(1), at(9)]);

check('three hops net out the same way',
  (() => { const r = one([ev('a', 'extended', 2, at(1), at(3)), ev('a', 'extended', 2, at(3), at(5)),
    ev('a', 'extended', 5, at(5), at(10))]); return [r.kind, r.days]; })(),
  ['extended', 9]);

// --- direction is the SIGN of the net, not of the last hop ---------------
check('out then further back nets to earlier',
  (() => { const r = one([ev('a', 'extended', 2, at(10), at(12)), ev('a', 'earlier', 9, at(12), at(3))]);
    return [r.kind, r.days]; })(),
  ['earlier', 7]);
check('back then further out nets to extended',
  (() => { const r = one([ev('a', 'earlier', 3, at(10), at(7)), ev('a', 'extended', 8, at(7), at(15))]);
    return [r.kind, r.days]; })(),
  ['extended', 5]);

// --- out and back is not a change ----------------------------------------
check('a deadline that returned to where it started is dropped',
  mergeEventsBySlug([ev('a', 'extended', 5, at(1), at(6)), ev('a', 'earlier', 5, at(6), at(1))]), []);

// --- a first deadline outranks any later movement ------------------------
check('first-deadline wins the kind, and takes the latest value',
  (() => { const r = one([ev('a', 'deadline_announced', null, null, at(5)), ev('a', 'extended', 3, at(5), at(8))]);
    return [r.kind, r.days, r.old_utc, r.new_utc]; })(),
  ['deadline_announced', null, null, at(8)]);

check('an announcement outranks a first deadline in the same week',
  (() => { const r = one([ev('a', 'announced', null, null, null), ev('a', 'deadline_announced', null, null, at(9))]);
    return [r.kind, r.new_utc]; })(),
  ['announced', at(9)]);

// --- single events pass through untouched --------------------------------
const solo = ev('a', 'extended', 4, at(1), at(5));
check('a lone event is returned as-is', one([solo]), solo);
check('an announcement with no dates survives',
  one([ev('a', 'announced', null, null, null)]), ev('a', 'announced', null, null, null));

// --- shape and ordering ---------------------------------------------------
check('one row per slug',
  mergeEventsBySlug([ev('a', 'extended', 1, at(1), at(2)), ev('b', 'extended', 1, at(1), at(2)),
    ev('a', 'extended', 1, at(2), at(3))]).length, 2);
check('first-appearance order is preserved',
  mergeEventsBySlug([ev('b', 'extended', 1, at(1), at(2)), ev('a', 'extended', 1, at(1), at(2))]).map((e) => e.slug),
  ['b', 'a']);
check('unparseable dates fall back to the most recent hop rather than guessing',
  (() => { const r = one([ev('a', 'extended', 2, null, at(4)), ev('a', 'extended', 3, at(4), at(7))]);
    return [r.kind, r.days, r.new_utc]; })(),
  ['extended', 3, at(7)]);

// --- degenerate input -----------------------------------------------------
check('empty in, empty out', mergeEventsBySlug([]), []);
check('non-array in, empty out', mergeEventsBySlug(null), []);
check('events with no slug are ignored', mergeEventsBySlug([{ kind: 'extended' }]), []);

console.log(failed ? `\n${failed} check(s) failed` : '\nEvent merging is sound');
process.exit(failed ? 1 : 0);
