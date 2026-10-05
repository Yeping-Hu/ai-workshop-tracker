#!/usr/bin/env node
/**
 * The browser suite's live examples are chosen from the corpus, not named in
 * the test (scripts/ui_examples.mjs). Pinned here on fixed rows and a fixed
 * clock, because the whole point is behaviour that changes with the date.
 *
 * Run: node scripts/ui_examples_test.mjs
 */
import { openCalls, pickBrowseConference, pickSortQuery } from './ui_examples.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

const NOW = Date.parse('2026-10-05T00:00:00Z');
let n = 0;
const row = (conference, deadline, extra = {}) => ({
  slug: `${conference}-${++n}`,
  conference,
  name: 'A Workshop',
  status: Date.parse(deadline) > NOW ? 'upcoming' : 'past',
  deadline_utc: deadline,
  topics: [],
  ...extra,
});

// The shape that turned Build check red: IROS's last call closed, CoRL's open.
const corpus = [
  row('iros', '2026-09-26T11:59:00Z'),
  row('iros', '2026-09-20T11:59:00Z'),
  row('corl', '2026-10-07T23:59:00Z', { name: 'Robot Learning' }),
  row('corl', '2026-10-19T23:59:00Z', { name: 'Robotic Manipulation' }),
  row('corl', '2026-10-17T04:59:00Z', { name: 'Humanoids', topics: ['robotics'] }),
  row('neurips', '2026-10-31T09:00:00Z', { name: 'AIMO Interpretability Challenge' }),
  ...Array.from({ length: 12 }, () => row('icra', '2026-02-01T00:00:00Z', { name: 'Robot Perception' })),
];

check('a closed conference is never picked for the browse checks', pickBrowseConference(corpus, NOW)?.conference, 'corl');
check('...and the pick says how many open calls it has', pickBrowseConference(corpus, NOW)?.open, 3);
check('one open call is not enough to compare neighbours', pickBrowseConference(corpus.filter((w) => w.conference !== 'corl'), NOW), null);
check('nothing open anywhere picks nothing', pickBrowseConference(corpus, Date.parse('2027-06-01T00:00:00Z')), null);
check('ties go to the lower id, so a run is reproducible',
  pickBrowseConference([row('neurips', '2026-12-01T00:00:00Z'), row('neurips', '2026-12-02T00:00:00Z'),
    row('corl', '2026-12-01T00:00:00Z'), row('corl', '2026-12-02T00:00:00Z')], NOW)?.conference, 'corl');
check('a stale "upcoming" status past its deadline is not open',
  openCalls([{ ...row('iros', '2026-09-26T11:59:00Z'), status: 'upcoming' }], NOW).length, 0);

const CANDIDATES = ['robot', 'interpretab', 'learning'];
check('the first candidate that works is kept', pickSortQuery(corpus, NOW, CANDIDATES), { q: 'robot', open: 3 });
check('topics count as a match', pickSortQuery(corpus.filter((w) => !/Robot Learn|Robotic/.test(w.name)), NOW, ['robot'], { min: 1 })?.open, 1);
check('a word with one open call is skipped for the next', pickSortQuery(corpus, NOW, ['interpretab', 'robot'])?.q, 'robot');
check('a word with too few closed matches is skipped', pickSortQuery(corpus, NOW, ['robot'], { minClosed: 50 }), null);
check('a word with more open calls than fit beside closed ones is skipped', pickSortQuery(corpus, NOW, ['robot'], { max: 2 }), null);
check('once the open calls close, no candidate is picked', pickSortQuery(corpus, Date.parse('2027-06-01T00:00:00Z'), CANDIDATES), null);
check('a word inside another word does not match', pickSortQuery(corpus, NOW, ['obot'], { min: 1 }), null);

console.log(failed ? `\n${failed} check(s) failed` : '\nLive UI examples are chosen from the corpus');
process.exit(failed ? 1 : 0);
