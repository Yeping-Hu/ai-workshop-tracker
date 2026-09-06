#!/usr/bin/env node
/**
 * Pins what the homepage's conference cards say (lib/workshops.mjs):
 *
 *   conferenceCard    — which edition a card is about and what is known of it.
 *                       The year a reader can act on comes first: the year of
 *                       the open calls, else the soonest edition still to end,
 *                       else the latest tracked; dates only from that year's
 *                       own row in data/editions.yml.
 *   latestProposalCall — the newest call for workshop proposals of a conference.
 *
 * The case that motivated the rule: CoRL 2026 had open calls before its dates
 * were recorded, and a card that fell back to CoRL 2025's dates next to
 * "19 open calls" was wrong in the way that matters. Pure logic; no network,
 * no filesystem. Run: node scripts/conference_strip_test.mjs
 */
import { conferenceCard, latestProposalCall } from '../lib/workshops.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

const NOW = Date.UTC(2026, 8, 5, 12, 0); // 2026-09-05 12:00 UTC
const DAY = 86_400_000;

const corl25 = { conference: 'corl', year: 2025, start: '2025-09-27', end: '2025-09-30' };
const neurips25 = { conference: 'neurips', year: 2025, start: '2025-12-02', end: '2025-12-07' };
const neurips26 = { conference: 'neurips', year: 2026, start: '2026-12-06', end: '2026-12-13' };
const icml26 = { conference: 'icml', year: 2026, end: '2026-07-11' };
const cvpr26 = { conference: 'cvpr', year: 2026, start: '2026-09-01', end: '2026-09-05' }; // ends today
const iros26 = { conference: 'iros', year: 2026, end: 'not a date' };
const editions = [corl25, neurips25, neurips26, icml26, cvpr26, iros26];

const ws = (conference, year, status, deadlineUtcMs = NOW + 10 * DAY) => ({ conference, year, status, deadlineUtcMs });
const workshops = [
  ws('corl', 2026, 'upcoming'),
  ws('corl', 2026, 'upcoming'),
  ws('corl', 2025, 'past'),
  ws('neurips', 2026, 'upcoming'),
  ws('neurips', 2026, 'upcoming', null), // deadline TBA — announced, not an open call
  ws('neurips', 2025, 'past'),
  ws('icml', 2026, 'past'),
  ws('cvpr', 2026, 'past'),
  ws('iros', 2026, 'past'),
];
const card = (id) => conferenceCard(id, { workshops, editions, nowMs: NOW });

check('open calls name the year even with no edition row (CoRL 2026)', card('corl'), { year: 2026, openCalls: 2, edition: null, upcoming: true });
check('…never the previous year\'s dates', card('corl').edition?.year ?? null, null);
check('open calls with a row for that year (NeurIPS 2026)', card('neurips'), { year: 2026, openCalls: 1, edition: neurips26, upcoming: true });
check('a TBA deadline is announced, not open', card('neurips').openCalls, 1);
check('no open calls, latest edition over (ICML 2026)', card('icml'), { year: 2026, openCalls: 0, edition: icml26, upcoming: false });
check('an edition ending today is still on (CVPR)', card('cvpr'), { year: 2026, openCalls: 0, edition: cvpr26, upcoming: true });
check('an unparsable end is ignored (IROS)', card('iros'), { year: null, openCalls: 0, edition: null, upcoming: false });
check('nothing known at all', card('colm'), { year: null, openCalls: 0, edition: null, upcoming: false });
check('open calls in two years -> the later year', conferenceCard('x', { workshops: [ws('x', 2026, 'upcoming'), ws('x', 2027, 'upcoming')], editions: [], nowMs: NOW }).year, 2027);
check('the soonest future edition wins over a later one', conferenceCard('y', { workshops: [], editions: [{ conference: 'y', year: 2027, end: '2027-06-01' }, { conference: 'y', year: 2026, end: '2026-10-01' }], nowMs: NOW }).year, 2026);
check('missing inputs degrade to nothing known', conferenceCard('z', { nowMs: NOW }), { year: null, openCalls: 0, edition: null, upcoming: false });

const calls = [
  { conference: 'iclr', year: 2026, deadlineUtcMs: 1 },
  { conference: 'iclr', year: 2027, deadlineUtcMs: 5 },
  { conference: 'iclr', year: 2027, deadlineUtcMs: 9 },
  { conference: 'icml', year: 2026, deadlineUtcMs: 3 },
];
check('newest call: latest year, then latest deadline', latestProposalCall(calls, 'iclr'), { conference: 'iclr', year: 2027, deadlineUtcMs: 9 });
check('a conference with one call', latestProposalCall(calls, 'icml').year, 2026);
check('a conference with none', latestProposalCall(calls, 'eccv'), null);
check('no calls at all', latestProposalCall(undefined, 'iclr'), null);

console.log(failed ? `\n${failed} check(s) failed` : '\nConference card rules hold');
process.exit(failed ? 1 : 0);
