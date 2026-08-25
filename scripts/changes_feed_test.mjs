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
import { validateChangesFeed } from './validate_changes_feed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

const CORPUS = {
  slugs: new Set(['a-2026-one', 'a-2026-two', 'a-2026-old']),
  addedBySlug: new Map([['a-2026-old', '2026-01-01'], ['a-2026-one', '2026-08-20']]),
};
const feed = (events, over = {}) => ({
  generated_at: '2026-08-26T06:30:00.000Z', since: '2026-08-19', events, ...over,
});
const ok = (events, over) => validateChangesFeed(feed(events, over), CORPUS);

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
check('a non-array events field fails',
  validateChangesFeed({ generated_at: null, since: null, events: {} }, CORPUS).length, 1);

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
const rowsFlagged = new Set(found.map((m) => /^event (\d+)/.exec(m)?.[1]).filter(Boolean));
check('EVERY row of the fabricated feed is rejected', [...rowsFlagged].sort(), ['1', '2', '3', '4', '5']);
check('it is rejected for more than one reason', found.length >= 8, true);

console.log('\n  — what the validator says about the file that shipped —');
for (const m of found) console.log(`    ${m}`);

console.log(failed ? `\n${failed} check(s) failed` : '\nChanges-feed validation is sound');
process.exit(failed ? 1 : 0);
