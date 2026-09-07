#!/usr/bin/env node
/**
 * Tests for validateChangesFeed — the schema gate on data/changes.json.
 * Run: node scripts/changes_feed_test.mjs
 *
 * The load-bearing test is the last one. On 2026-08-25 a hand-authored
 * data/changes.json shipped and went live on a page whose footer says the data
 * is observed. scripts/fixtures/changes-fabricated.json is that file, recovered
 * byte-for-byte from the commit that shipped it (c3c793a), and this asserts the
 * validator rejects EVERY ONE of its five rows.
 *
 * That fixture is the reason the fixtures directory exists, and it is also an
 * illustration of the rule it enforces: fabricated data lives in scripts/ as a
 * thing to test against, and never under data/ as a thing to publish.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateChangesFeed, ANNOUNCED_LAG_DAYS } from './validate_changes_feed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

const SINCE = '2026-08-19';
const daysBefore = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const CORPUS = {
  slugs: new Set(['a-2026-one', 'a-2026-two', 'a-2026-old', 'a-2026-eve', 'a-2026-edge', 'a-2026-over']),
  addedBySlug: new Map([
    ['a-2026-old', '2026-01-01'],
    ['a-2026-one', '2026-08-20'],
    // Either side of the observation lag the validator allows an `announced` row.
    ['a-2026-eve', daysBefore(SINCE, 1)],
    ['a-2026-edge', daysBefore(SINCE, ANNOUNCED_LAG_DAYS)],
    ['a-2026-over', daysBefore(SINCE, ANNOUNCED_LAG_DAYS + 1)],
  ]),
};
const UNTIL = '2026-08-25';
const feed = (events, over = {}) => ({
  generated_at: '2026-08-26T06:30:00.000Z', since: SINCE, until: UNTIL, events, ...over,
});
const ok = (events, over) => validateChangesFeed(feed(events, over), CORPUS);
/** Errors and warnings together, for the rules that downgrade rather than refuse. */
const both = (events, over) => {
  const warnings = [];
  const errors = validateChangesFeed(feed(events, over), CORPUS, warnings);
  return { errors, warnings };
};
const announced = (slug, over = {}) => ({ slug, kind: 'announced', days: null, old_utc: null, new_utc: null, ...over });

// --- the states that must PASS ------------------------------------------
check('an explicitly empty feed passes', ok([]), []);
check('an empty feed needs no generated_at',
  validateChangesFeed({ generated_at: null, since: null, events: [] }, CORPUS), []);
check('a well-formed extension passes',
  ok([{ slug: 'a-2026-one', kind: 'extended', days: 10,
        old_utc: '2026-08-21T23:59:00.000Z', new_utc: '2026-08-31T23:59:00.000Z' }]), []);
check('a well-formed earlier-move passes',
  ok([{ slug: 'a-2026-one', kind: 'earlier', days: 2,
        old_utc: '2026-08-31T23:59:00.000Z', new_utc: '2026-08-29T23:59:00.000Z' }]), []);
check('a first deadline passes',
  ok([{ slug: 'a-2026-one', kind: 'deadline_announced', days: null,
        old_utc: null, new_utc: '2026-09-17T06:00:00.000Z' }]), []);
// The two real null/null rows in the production store have exactly this shape.
check('an announcement with no dates at all passes',
  ok([{ slug: 'a-2026-one', kind: 'announced', days: null, old_utc: null, new_utc: null }]), []);
// The pipeline observes a workshop the run after its file lands, so `added` runs
// a day or more ahead of the event. On 2026-09-07 four real rows were refused
// for exactly that one-day gap, and /changes/ kept the previous edition.
check('an announcement for a workshop added the day before the window passes',
  ok([{ slug: 'a-2026-eve', kind: 'announced', days: null, old_utc: null, new_utc: null }]), []);
check('an announcement added a full window before `since` still passes',
  ok([{ slug: 'a-2026-edge', kind: 'announced', days: null, old_utc: null, new_utc: null }]), []);

// --- rows that say when they were observed --------------------------------
// The pipeline stamps every row with the day of the run that saw it. That one
// fact makes two checks exact where `added` alone could only guess, and it is
// what keeps a real row from ever being refused for the pipeline running late.
check('a row observed inside the window passes',
  ok([{ slug: 'a-2026-one', kind: 'extended', days: 10, observed: '2026-08-20',
        old_utc: '2026-08-21T23:59:00.000Z', new_utc: '2026-08-31T23:59:00.000Z' }]), []);
check('a row observed on the window\'s last day passes', ok([announced('a-2026-one', { observed: UNTIL })]), []);
const moved = (observed) => ({ slug: 'a-2026-one', kind: 'extended', days: 10, observed,
  old_utc: '2026-08-21T23:59:00.000Z', new_utc: '2026-08-31T23:59:00.000Z' });
check('a row observed before the window opened fails', ok([moved('2026-08-18')]).length, 1);
check('a row observed after the window closed fails', ok([moved('2026-08-26')]).length, 1);
check('a malformed `observed` fails', ok([announced('a-2026-one', { observed: 'Monday' })]).length, 1);
check('an announcement observed the day its file landed passes', ok([announced('a-2026-one', { observed: '2026-08-20' })]), []);
check('an announcement observed before its file existed fails',
  ok([announced('a-2026-one', { observed: '2026-08-19' })]).length, 1);
// The guess (`added` long before `since`) is downgraded once the row says
// when it was seen: late news is a note in the log, not a red run that leaves
// /changes/ on the previous edition.
check('a stale-looking announcement WITH an observation is a warning, not an error',
  (({ errors, warnings }) => [errors.length, warnings.length])(both([announced('a-2026-old', { observed: '2026-08-20' })])), [0, 1]);
check('the same row WITHOUT an observation is still an error',
  (({ errors, warnings }) => [errors.length, warnings.length])(both([announced('a-2026-old')])), [1, 0]);

// --- the states that must FAIL ------------------------------------------
const one = (ev, over) => ok([ev], over).length;
check('extended with no from-date fails',
  one({ slug: 'a-2026-one', kind: 'extended', days: 5, old_utc: null, new_utc: '2026-08-31T23:59:00.000Z' }), 1);
check('extended with days 0 fails',
  one({ slug: 'a-2026-one', kind: 'extended', days: 0,
        old_utc: '2026-08-21T23:59:00.000Z', new_utc: '2026-08-31T23:59:00.000Z' }), 1);
check('extended whose new date is EARLIER fails',
  one({ slug: 'a-2026-one', kind: 'extended', days: 5,
        old_utc: '2026-08-31T23:59:00.000Z', new_utc: '2026-08-21T23:59:00.000Z' }), 1);
check('earlier whose new date is LATER fails',
  one({ slug: 'a-2026-one', kind: 'earlier', days: 2,
        old_utc: '2026-08-21T23:59:00.000Z', new_utc: '2026-08-31T23:59:00.000Z' }), 1);
check('a first deadline with a prior date fails',
  one({ slug: 'a-2026-one', kind: 'deadline_announced', days: null,
        old_utc: '2026-08-01T00:00:00.000Z', new_utc: '2026-09-17T06:00:00.000Z' }), 1);
check('an unknown slug fails',
  one({ slug: 'a-2026-ghost', kind: 'announced', days: null, old_utc: null, new_utc: null }), 1);
check('an unknown kind fails',
  one({ slug: 'a-2026-one', kind: 'rescheduled', days: null, old_utc: null, new_utc: null }), 1);
check('events with no generated_at fails',
  ok([{ slug: 'a-2026-one', kind: 'announced', days: null, old_utc: null, new_utc: null }],
     { generated_at: null }).length, 1);
check('an announcement for a workshop added long before the window fails',
  one({ slug: 'a-2026-old', kind: 'announced', days: null, old_utc: null, new_utc: null }), 1);
check('an announcement added more than a window before `since` fails',
  one({ slug: 'a-2026-over', kind: 'announced', days: null, old_utc: null, new_utc: null }), 1);
check('a non-array events field fails',
  validateChangesFeed({ generated_at: null, since: null, events: {} }, CORPUS).length, 1);
// `until` closes the window; optional (older feeds carry only `since`), but
// when present it is a day and not one before the opening.
check('a window with both ends passes', ok([], { until: '2026-08-25' }), []);
check('a feed without `until` still passes', ok([], { until: undefined }), []);
check('a malformed `until` fails', ok([], { until: '25 Aug' }).length, 1);
check('an `until` before `since` fails', ok([], { until: '2026-08-18' }).length, 1);

// --- THE ONE THAT MATTERS: the file that actually shipped ----------------
// Byte-exact, recovered from c3c793a. Five rows, every one rejected.
const fabricated = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts/fixtures/changes-fabricated.json'), 'utf8'),
);
const slugs = new Set();
const addedBySlug = new Map();
for (const f of fs.readdirSync(path.join(ROOT, 'data/workshops'))) {
  if (!f.endsWith('.yml')) continue;
  const slug = f.slice(0, -4);
  slugs.add(slug);
  const m = /^added:\s*'?(\d{4}-\d{2}-\d{2})'?/m.exec(
    fs.readFileSync(path.join(ROOT, 'data/workshops', f), 'utf8'),
  );
  if (m) addedBySlug.set(slug, m[1]);
}
const found = validateChangesFeed(fabricated, { slugs, addedBySlug });

check('the fabricated feed has the five rows it shipped with', fabricated.events.length, 5);
check('the fabricated feed says on no row when it was observed', fabricated.events.every((e) => e.observed == null), true);
const rowsFlagged = new Set(found.map((m) => /^event (\d+)/.exec(m)?.[1]).filter(Boolean));
check('EVERY row of the fabricated feed is rejected', [...rowsFlagged].sort(), ['1', '2', '3', '4', '5']);
check('it is rejected for more than one reason', found.length >= 8, true);

// The pipeline must actually write the field the checks above rely on.
const runSrc = fs.readFileSync(path.join(ROOT, 'scripts/alerts_run.mjs'), 'utf8');
check('alerts_run.mjs writes `observed` on every feed row', /observed: e\.observed \?\? null,/.test(runSrc), true);

console.log('\n  — what the validator says about the file that shipped —');
for (const m of found) console.log(`    ${m}`);

console.log(failed ? `\n${failed} check(s) failed` : '\nChanges-feed validation is sound');
process.exit(failed ? 1 : 0);
