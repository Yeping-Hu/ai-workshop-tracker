#!/usr/bin/env node
/**
 * Pins the rules of the daily editions sync (scripts/sync_editions.mjs) and
 * the edition helpers the pages read (lib/editions.mjs): how the two trackers'
 * files are read, how their zones become this site's, which tracker wins a
 * field, the create / fill / follow / freeze decision, the file shapes, the
 * acceptance-rate table parser, and which edition a hub headlines. Fixtures
 * are the live records the job was designed against on 2026-09-10. No
 * network, no filesystem.
 *
 * Run: node scripts/editions_sync_test.mjs
 */
import * as yaml from 'js-yaml';
import {
  normaliseZone,
  storedDeadline,
  parseDateRange,
  readCcfddl,
  readAiDeadlines,
  mergeRecords,
  decideEdition,
  syncYears,
  serializeEditions,
  serializeAcceptanceRates,
  parseAcceptanceReadme,
  sourceId,
  ACCEPTANCE_SOURCE,
  relevantReview,
  missingNextCycles,
  staleAcceptanceRates,
  buildEditionsReport,
  reviewKey,
} from './sync_editions.mjs';
import { resolveEdition, featuredEdition, previousEdition, hasMainConference, acceptanceHistory, latestAcceptanceRate, formatRate, editionOrder, typicalTiming } from '../lib/editions.mjs';
import { utcMsToWallClock, zonedToUtcMs } from '../lib/dates.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}
const NOW = Date.UTC(2026, 8, 10, 12, 0); // 2026-09-10 12:00 UTC
const DAY = 86_400_000;
const TODAY = '2026-09-10';

console.log('— zones and deadlines as the trackers write them —');
check('AoE is kept', normaliseZone('AoE'), { zone: 'AoE' });
check('UTC-12 is AoE', normaliseZone('UTC-12'), { zone: 'AoE' });
check('UTC+0 is UTC', normaliseZone('UTC+0'), { zone: 'UTC' });
check('UTC-8 is an offset', normaliseZone('UTC-8'), { offset: -480 });
check('PST is an offset', normaliseZone('PST'), { offset: -480 });
check('UTC+5:30 is an offset', normaliseZone('UTC+5:30'), { offset: 330 });
check('CST is ambiguous and refused', normaliseZone('CST'), null);
check('an IANA name is kept', normaliseZone('America/Los_Angeles'), { zone: 'America/Los_Angeles' });
check('AoE wall clock is stored as is, seconds dropped', storedDeadline('2026-09-25 23:59:59', 'AoE'), { value: '2026-09-25 23:59', timezone: 'AoE', ms: zonedToUtcMs({ year: 2026, month: 9, day: 25, hour: 23, minute: 59 }, 'AoE') });
check('UTC+0 becomes UTC', storedDeadline('2026-05-07 11:59:00', 'UTC+0').value + ' ' + storedDeadline('2026-05-07 11:59:00', 'UTC+0').timezone, '2026-05-07 11:59 UTC');
check('UTC-8 becomes the UTC instant', [storedDeadline('2026-03-05 14:00:00', 'UTC-8').value, storedDeadline('2026-03-05 14:00:00', 'UTC-8').timezone], ['2026-03-05 22:00', 'UTC']);
check('UTC-7 crosses midnight into UTC', storedDeadline('2026-09-15 23:59:59', 'UTC-7').value, '2026-09-16 06:59');
check('PST converts too', storedDeadline('2026-09-15 23:59:59', 'PST').value, '2026-09-16 07:59');
check('a date-only deadline is end of day', storedDeadline('2026-06-06', 'AoE').value, '2026-06-06 23:59');
check('TBD is no deadline', storedDeadline('TBD', 'AoE'), null);
check('an impossible date is no deadline', storedDeadline('2026-02-30 23:59:59', 'AoE'), null);
check('a missing zone means AoE', storedDeadline('2026-06-06 23:59:59', undefined).timezone, 'AoE');
check('utcMsToWallClock inverts zonedToUtcMs (AoE)', utcMsToWallClock(zonedToUtcMs({ year: 2026, month: 9, day: 25, hour: 23, minute: 59 }, 'AoE'), 'AoE'), '2026-09-25 23:59');
check('utcMsToWallClock inverts zonedToUtcMs (IANA, DST)', utcMsToWallClock(zonedToUtcMs({ year: 2026, month: 7, day: 1, hour: 9, minute: 30 }, 'America/New_York'), 'America/New_York'), '2026-07-01 09:30');

console.log('— ccfddl free-text dates —');
check('"July 6-12, 2026"', parseDateRange('July 6-12, 2026'), { start: '2026-07-06', end: '2026-07-12' });
check('"May 01-05, 2026"', parseDateRange('May 01-05, 2026'), { start: '2026-05-01', end: '2026-05-05' });
check('"September 27 - October 1, 2026"', parseDateRange('September 27 - October 1, 2026'), { start: '2026-09-27', end: '2026-10-01' });
check('"December 9-December 15, 2024"', parseDateRange('December 9-December 15, 2024'), { start: '2024-12-09', end: '2024-12-15' });
check('"December 6, 2026" (one day)', parseDateRange('December 6, 2026'), { start: '2026-12-06', end: '2026-12-06' });
check('"Jun 1-5, 2026"', parseDateRange('Jun 1-5, 2026'), { start: '2026-06-01', end: '2026-06-05' });
check('"September 8 - 13, 2026"', parseDateRange('September 8 - 13, 2026'), { start: '2026-09-08', end: '2026-09-13' });
check('a range over New Year started the year before', parseDateRange('December 30 - January 2, 2027'), { start: '2026-12-30', end: '2027-01-02' });
check('TBD is no range', parseDateRange('TBD'), null);

console.log('— reading ccfddl —');
const CCFDDL_ICLR = `
- title: ICLR
  sub: AI
  confs:
    - year: 2026
      id: iclr26
      link: https://iclr.cc/Conferences/2026
      timeline:
        - abstract_deadline: '2025-09-19 23:59:59'
          deadline: '2025-09-24 23:59:59'
      timezone: AoE
      date: May 01-05, 2026
      place: Brazil
    - year: 2027
      id: iclr27
      link: https://iclr.cc/Conferences/2027
      timeline:
        - abstract_deadline: '2026-09-18 23:59:59'
          deadline: '2026-09-25 23:59:59'
      timezone: AoE
      date: April 26-30, 2027
      place: San Francisco, CA, USA
    - year: 2028
      id: iclr28
      link: https://iclr.cc/Conferences/2028
      timeline:
        - deadline: TBD
      timezone: AoE
      date: TBD
      place: TBD
`;
const iclr = readCcfddl(CCFDDL_ICLR, 'iclr');
check('one record per edition', iclr.map((r) => r.year), [2026, 2027, 2028]);
check('ICLR 2027 as stored', iclr[1], { conference: 'iclr', year: 2027, source: 'ccfddl', timezone: 'AoE', paper_deadline: '2026-09-25 23:59', abstract_deadline: '2026-09-18 23:59', start: '2027-04-26', end: '2027-04-30', place: 'San Francisco, CA, USA', url: 'https://iclr.cc/Conferences/2027' });
check('a TBD edition has no deadline, dates or place', iclr[2], { conference: 'iclr', year: 2028, source: 'ccfddl', url: 'https://iclr.cc/Conferences/2028' });
const CCFDDL_NIPS = `
- title: NeurIPS
  confs:
    - year: 2026
      id: nips26
      link: https://neurips.cc/Conferences/2026
      timeline:
        - abstract_deadline: '2026-05-05 11:59:00'
          deadline: '2026-05-07 11:59:00'
      timezone: UTC+0
      date: December 6, 2026
      place: Sydney, Australia
    - year: 2025
      id: nips25
      link: https://neurips.cc/Conferences/2025
      timeline:
        - deadline: '2025-03-01 23:59:59'
          comment: first round
        - abstract_deadline: '2025-05-11 23:59:59'
          deadline: '2025-05-15 23:59:59'
      timezone: AoE
      date: December 2-7, 2025
      place: San Diego Convention Center, USA
`;
const nips = readCcfddl(CCFDDL_NIPS, 'neurips');
check('UTC+0 rows are stored in UTC', [nips[0].paper_deadline, nips[0].abstract_deadline, nips[0].timezone], ['2026-05-07 11:59', '2026-05-05 11:59', 'UTC']);
check('a one-day date string gives start = end', [nips[0].start, nips[0].end], ['2026-12-06', '2026-12-06']);
check('the round with the latest deadline is the headline', [nips[1].paper_deadline, nips[1].abstract_deadline], ['2025-05-15 23:59', '2025-05-11 23:59']);
check('the tracker file name can differ from our id', [sourceId('neurips', 'ccfddl'), sourceId('neurips', 'ai-deadlines'), sourceId('icml', 'ccfddl')], ['nips', 'neurips', 'icml']);

console.log('— reading ai-deadlines —');
const AIDL_ICLR = `
- title: ICLR
  year: 2027
  id: iclr27
  link: https://iclr.cc/Conferences/2027
  deadlines:
    - type: abstract
      label: Abstract Submission
      date: '2026-09-18 23:59:59'
      timezone: AoE
    - type: submission
      label: Paper Submission
      date: '2026-09-25 23:59:59'
      timezone: AoE
    - type: review_release
      label: Reviews Released
      date: '2026-11-05 23:59:59'
      timezone: AoE
    - type: notification
      label: Final Decisions
      date: '2026-12-16 23:59:59'
      timezone: AoE
  city: San Francisco
  country: United States
  venue: Moscone Center
  date: April 26-30, 2027
  start: '2027-04-26'
  end: '2027-04-30'
`;
const a1 = readAiDeadlines(AIDL_ICLR, 'iclr')[0];
check('typed deadlines, notification day, city and country', a1, { conference: 'iclr', year: 2027, source: 'ai-deadlines', timezone: 'AoE', paper_deadline: '2026-09-25 23:59', abstract_deadline: '2026-09-18 23:59', notification: '2026-12-16', start: '2027-04-26', end: '2027-04-30', place: 'San Francisco, United States', url: 'https://iclr.cc/Conferences/2027' });
const AIDL_ECCV = `
- title: ECCV
  year: 2026
  link: https://eccv.ecva.net/Conferences/2026
  city: Malmö
  country: Sweden
  date: September 8-12, 2026
  start: '2026-09-08'
  end: '2026-09-12'
  deadlines:
    - { type: submission, label: Tutorial Proposal Submission, date: '2026-02-15 23:59:59', timezone: AoE }
    - { type: registration, label: Paper Registration, date: '2026-02-26 22:00:00', timezone: UTC }
    - { type: submission, label: Workshop Proposal Submission, date: '2026-02-27 23:59:59', timezone: AoE }
    - { type: paper, label: Paper Submission, date: '2026-03-05 22:00:00', timezone: UTC }
    - { type: notification, label: Tutorial/Workshop Decisions, date: '2026-04-12 20:00:00', timezone: UTC }
    - { type: notification, label: Final Decisions, date: '2026-06-17 23:59:59', timezone: UTC }
    - { type: submission, label: AI Art Submission, date: '2026-06-14 23:59:59', timezone: AoE }
`;
const a2 = readAiDeadlines(AIDL_ECCV, 'eccv')[0];
check('the paper track is picked over tutorial, workshop and art submissions', [a2.paper_deadline, a2.timezone], ['2026-03-05 22:00', 'UTC']);
check('paper registration is the abstract stage', a2.abstract_deadline, '2026-02-26 22:00');
check('the authors\' decision date, not the workshop one', a2.notification, '2026-06-17');
const AIDL_CORL = `
- title: CoRL
  year: 2025
  link: https://www.corl.org/
  deadline: '2025-04-30 23:59:59'
  timezone: AoE
  date: September 27-30, 2025
  city: Seoul
  country: South Korea
`;
check('an older flat row still reads', readAiDeadlines(AIDL_CORL, 'corl')[0], { conference: 'corl', year: 2025, source: 'ai-deadlines', timezone: 'AoE', paper_deadline: '2025-04-30 23:59', start: '2025-09-27', end: '2025-09-30', place: 'Seoul, South Korea', url: 'https://www.corl.org/' });
const AIDL_ICRA = `
- title: ICRA
  year: 2027
  link: https://2027.ieee-icra.org/
  deadlines:
    - { type: submission, label: Paper Submission, date: '2026-09-15 23:59:59', timezone: PST }
    - { type: notification, label: Notification of Acceptance, date: '2027-01-31 23:59:59', timezone: PST }
  city: Seoul
  country: South Korea
  date: May 24 - 28, 2027
`;
const a3 = readAiDeadlines(AIDL_ICRA, 'icra')[0];
check('PST is converted to the UTC instant; the notification keeps its day', [a3.paper_deadline, a3.timezone, a3.notification], ['2026-09-16 07:59', 'UTC', '2027-01-31']);
check('dates fall back to the text when start/end are absent', [a3.start, a3.end], ['2027-05-24', '2027-05-28']);
check('a row with no deadline has no zone', 'timezone' in readAiDeadlines(`- {title: X, year: 2027, city: Rome, country: Italy, deadlines: []}`, 'x')[0], false);

console.log('— merging the trackers —');
const merged = mergeRecords([
  ...readCcfddl(CCFDDL_ICLR, 'iclr'),
  ...readAiDeadlines(AIDL_ICLR, 'iclr'),
  { conference: 'cvpr', year: 2027, source: 'ccfddl', timezone: 'AoE', paper_deadline: '2026-11-16 23:59', abstract_deadline: '2026-11-10 23:59', start: '2027-06-20', end: '2027-06-24', place: 'Seattle, WA, United States', url: 'https://cvpr.thecvf.com/Conferences/2027' },
  { conference: 'cvpr', year: 2027, source: 'ai-deadlines', start: '2027-06-19', end: '2027-06-26', place: 'Seattle, USA', url: 'https://cvpr.thecvf.com/' },
  { conference: 'corl', year: 2026, source: 'ccfddl', timezone: 'AoE', paper_deadline: '2026-05-28 23:59', start: '2026-11-10', end: '2026-11-12', place: 'Austin, Texas, USA' },
  { conference: 'corl', year: 2026, source: 'ai-deadlines', timezone: 'UTC', paper_deadline: '2026-05-29 11:59', abstract_deadline: '2026-05-26 11:59', notification: '2026-08-20' },
  { conference: 'icml', year: 2026, source: 'ccfddl', timezone: 'UTC', paper_deadline: '2026-01-29 11:59' },
  { conference: 'icml', year: 2026, source: 'ai-deadlines', timezone: 'AoE', paper_deadline: '2026-01-31 23:59' },
]);
const iclr27 = merged.get('iclr-2027');
check('deadlines from ccfddl, notification from ai-deadlines', [iclr27.paper_deadline, iclr27.timezone, iclr27.notification], ['2026-09-25 23:59', 'AoE', '2026-12-16']);
check('place from ai-deadlines, site from ccfddl', [iclr27.place, iclr27.url], ['San Francisco, United States', 'https://iclr.cc/Conferences/2027']);
check('provenance is recorded per field', iclr27.provenance, { timezone: 'ccfddl', paper_deadline: 'ccfddl', abstract_deadline: 'ccfddl', start: 'ai-deadlines', end: 'ai-deadlines', place: 'ai-deadlines', url: 'ccfddl', notification: 'ai-deadlines' });
check('both trackers are named', iclr27.from, ['ccfddl', 'ai-deadlines']);
const cvpr27 = merged.get('cvpr-2027');
check('dates travel as a pair from ai-deadlines', [cvpr27.start, cvpr27.end], ['2027-06-19', '2027-06-26']);
check('a tracker without deadlines does not blank them', cvpr27.paper_deadline, '2026-11-16 23:59');
const corl26 = merged.get('corl-2026');
check('an abstract deadline from the other tracker is expressed in the unit\'s zone', [corl26.abstract_deadline, corl26.timezone], ['2026-05-25 23:59', 'AoE']);
check('same instant in different zones is no disagreement', corl26.warnings, []);
check('a real disagreement is named and ccfddl still wins', [merged.get('icml-2026').warnings.length, merged.get('icml-2026').paper_deadline], [1, '2026-01-29 11:59']);

console.log('— the decision —');
const rec27 = merged.get('iclr-2027');
const created = decideEdition({ row: null, rec: rec27, conf: 'iclr', year: 2027, nowMs: NOW, today: TODAY });
check('next year with dates: a row is created', created.action, 'create');
check('the new row carries every field and a stamp per field', created.row, {
  conference: 'iclr', year: 2027, start: '2027-04-26', end: '2027-04-30', url: 'https://iclr.cc/Conferences/2027', place: 'San Francisco, United States',
  abstract_deadline: '2026-09-18 23:59', paper_deadline: '2026-09-25 23:59', timezone: 'AoE', notification: '2026-12-16',
  synced: { from: 'ccfddl, ai-deadlines', as_of: TODAY, start: '2027-04-26', end: '2027-04-30', url: 'https://iclr.cc/Conferences/2027', place: 'San Francisco, United States', abstract_deadline: '2026-09-18 23:59', paper_deadline: '2026-09-25 23:59', timezone: 'AoE', notification: '2026-12-16' },
});
check('the changelog names the row and each deadline', created.changes.length, 3);
check('a past year gets no new row', decideEdition({ row: null, rec: { ...rec27, year: 2024 }, conf: 'iclr', year: 2024, nowMs: NOW }).reason, 'past-year');
check('no end date, no row yet', decideEdition({ row: null, rec: { ...rec27, start: undefined, end: undefined }, conf: 'iclr', year: 2027, nowMs: NOW }).reason, 'no-dates-yet');
check('no tracker, nothing to do', decideEdition({ row: { conference: 'iclr', year: 2027 }, rec: null, conf: 'iclr', year: 2027, nowMs: NOW }).reason, 'no-source');

const hand = { conference: 'iclr', year: 2026, start: '2026-04-23', end: '2026-04-27', source: 'https://iclr.cc/Conferences/2026/CallForWorkshops', workshop_list_url: 'https://blog.iclr.cc/2026/01/13/iclr2026-workshops/' };
const filled = decideEdition({ row: hand, rec: merged.get('iclr-2026'), conf: 'iclr', year: 2026, nowMs: NOW, today: TODAY });
check('a hand-typed row is filled, never overwritten', [filled.action, filled.row.start, filled.row.end, filled.row.source, filled.row.workshop_list_url], ['update', '2026-04-23', '2026-04-27', hand.source, hand.workshop_list_url]);
check('… gaining the deadlines, place and site', [filled.row.paper_deadline, filled.row.abstract_deadline, filled.row.timezone, filled.row.place, filled.row.url], ['2025-09-24 23:59', '2025-09-19 23:59', 'AoE', 'Brazil', 'https://iclr.cc/Conferences/2026']);
check('… and the person\'s dates that differ from the tracker are reported as kept', filled.frozen, ['start', 'end']);
check('… only the bot\'s fields are stamped', Object.keys(filled.row.synced), ['from', 'as_of', 'url', 'place', 'abstract_deadline', 'paper_deadline', 'timezone']);

const bot = created.row;
const later = { ...rec27, paper_deadline: '2026-09-28 23:59', provenance: { ...rec27.provenance } };
const moved = decideEdition({ row: bot, rec: later, conf: 'iclr', year: 2027, nowMs: NOW, today: '2026-09-12' });
check('a later upstream deadline is applied to a bot row', [moved.action, moved.row.paper_deadline, moved.row.synced.paper_deadline, moved.row.synced.as_of], ['update', '2026-09-28 23:59', '2026-09-28 23:59', '2026-09-12']);
check('… as one changelog line', moved.changes, ['iclr 2027 paper_deadline: 2026-09-25 23:59 AoE -> 2026-09-28 23:59 AoE (later, ccfddl)']);
const earlier = { ...rec27, paper_deadline: '2026-09-20 23:59' };
const blocked = decideEdition({ row: bot, rec: earlier, conf: 'iclr', year: 2027, nowMs: NOW });
check('an earlier upstream deadline is not applied', [blocked.action, blocked.reason, blocked.warnings.length], ['skip', 'unchanged', 1]);
check('… and is handed to a person with both instants', [blocked.review[0].kind, blocked.review[0].stored, blocked.review[0].tracker, blocked.review[0].storedMs > blocked.review[0].trackerMs], ['earlier-blocked', '2026-09-25 23:59 AoE', '2026-09-20 23:59 AoE', true]);
const edited = { ...bot, paper_deadline: '2026-09-26 23:59' };
const frozenD = decideEdition({ row: edited, rec: later, conf: 'iclr', year: 2027, nowMs: NOW });
check('a deadline a person edited is frozen', [frozenD.action, frozenD.reason, frozenD.frozen], ['skip', 'frozen', ['paper_deadline']]);
check('… and reported as diverging from the tracker', frozenD.review.map((r) => [r.kind, r.field, r.stored, r.tracker]), [['frozen-diverged', 'paper_deadline', '2026-09-26 23:59 AoE', '2026-09-28 23:59 AoE']]);
const rezoned = { ...bot, timezone: 'UTC' };
check('a changed timezone freezes both deadlines', decideEdition({ row: rezoned, rec: later, conf: 'iclr', year: 2027, nowMs: NOW }).frozen, ['abstract_deadline', 'paper_deadline']);
const corrected = { ...rec27, place: 'San Francisco, CA, United States' };
const followed = decideEdition({ row: bot, rec: corrected, conf: 'iclr', year: 2027, nowMs: NOW });
check('a corrected place on a bot row follows the tracker', [followed.action, followed.row.place], ['update', 'San Francisco, CA, United States']);
const handPlace = { ...bot, place: 'SF' };
check('a place a person typed stays', [decideEdition({ row: handPlace, rec: corrected, conf: 'iclr', year: 2027, nowMs: NOW }).reason, decideEdition({ row: handPlace, rec: corrected, conf: 'iclr', year: 2027, nowMs: NOW }).frozen], ['frozen', ['place']]);
check('an unchanged row is a no-op', decideEdition({ row: bot, rec: rec27, conf: 'iclr', year: 2027, nowMs: NOW }).reason, 'unchanged');
const implausible = { ...rec27, paper_deadline: '2029-09-25 23:59', abstract_deadline: undefined };
const imp = decideEdition({ row: null, rec: implausible, conf: 'iclr', year: 2027, nowMs: NOW, today: TODAY });
check('an implausible deadline is skipped and named, the rest still lands', ['paper_deadline' in imp.row, imp.row.place, imp.warnings.length], [false, 'San Francisco, United States', 1]);
check('… and reported', imp.review.map((r) => r.kind), ['implausible']);
check('a deadline without dates is reported so a person can add the row', decideEdition({ row: null, rec: { ...rec27, start: undefined, end: undefined }, conf: 'iclr', year: 2027, nowMs: NOW }).review.map((r) => [r.kind, r.tracker]), [['no-dates-yet', '2026-09-25 23:59 AoE']]);
check('a disagreement between trackers is a review item with both instants', merged.get('icml-2026').conflicts.map((c) => [c.kind, c.chosenSource, c.otherSource, c.chosenMs < c.otherMs]), [['disagreement', 'ccfddl', 'ai-deadlines', true]]);
const handZone = { conference: 'icra', year: 2027, end: '2027-05-28', timezone: 'America/Los_Angeles' };
const inZone = decideEdition({ row: handZone, rec: { conference: 'icra', year: 2027, timezone: 'UTC', paper_deadline: '2026-09-16 07:59', from: ['ai-deadlines'], provenance: { paper_deadline: 'ai-deadlines', timezone: 'ai-deadlines' }, warnings: [] }, conf: 'icra', year: 2027, nowMs: NOW });
// 07:59 UTC on Sep 16 is 00:59 PDT (the tracker had written "PST" for a September date).
check('a deadline filled into a row with a hand zone is written in that zone', [inZone.row.paper_deadline, inZone.row.timezone], ['2026-09-16 00:59', 'America/Los_Angeles']);
check('the run looks at two years back through next year', syncYears(NOW), [2024, 2025, 2026, 2027]);

console.log('— the files —');
const text = serializeEditions([created.row, hand, { conference: 'cvpr', year: 2026, start: '2026-06-03', end: '2026-06-07' }]);
check('the header names the sync and the freeze rule', text.startsWith('# Conference editions') && text.includes('sync_editions.mjs') && text.includes('frozen'), true);
check('rows are grouped by year with a blank line between', text.replace(/^#.*\n/gm, '').trim().split('\n\n').length, 2);
check('dates are quoted, keys in the file\'s order', /- conference: cvpr\n  year: 2026\n  start: ['"]2026-06-03['"]\n  end: ['"]2026-06-07['"]\n/.test(text), true);
const back = yaml.load(text);
check('the file round-trips', [back.length, back[2].synced.paper_deadline, back[0].workshop_list_url], [3, '2026-09-25 23:59', hand.workshop_list_url]);
check('within a year, rows follow the calendar', back.slice(0, 2).map((r) => r.conference), ['iclr', 'cvpr']);

console.log('— the acceptance-rate table —');
const README = `
| Conference        | Long Paper           | Short Paper  |
| ------------- | :------------- | :----- |
|ACL'21 Findings | 14.6% (339/2327) | 11.5% (118/1023) |
|CVPR'25 | 22.1% (2872/13008)  | - |
|ICML'14 | 15.0% (Cycle I), 22.0% (Cycle II) | - |
|ICML'16 | 24.0% (322/?) | - |
|NeurIPS'22| 25.6% (?/10411) (? orals, ? spotlights and ? posters) | - |
|NeurIPS'25| 24.5% (5290/21575) (77 orals, 688 spotlights and 4525 posters) | - |
|NIPS'17 | 20.9% (678/3240) (40 orals, 112 spotlights and 526 posters) | - |
|ICLR'25| 31.75% (3706/11672) (- orals, - spotlights and 3638 posters) | - |
|ICLR'24| 30.81% (2250/7304) (85 orals, 366 spotlights and 1799 posters) | - |
|ICLR'23| 99.0% (1574/4956) | - |
|KDD'23 | 22.1% (313/1416) | - |
`;
const confs = [{ id: 'neurips', name: 'NeurIPS' }, { id: 'icml', name: 'ICML' }, { id: 'iclr', name: 'ICLR' }, { id: 'cvpr', name: 'CVPR' }];
const parsed = parseAcceptanceReadme(README, confs);
check('one row per tracked conference-year with counts', parsed.rows.map((r) => `${r.conference}-${r.year}`), ['cvpr-2025', 'icml-2016', 'neurips-2022', 'neurips-2025', 'neurips-2017', 'iclr-2025', 'iclr-2024']);
check('NeurIPS 2025 in full', parsed.rows.find((r) => r.conference === 'neurips' && r.year === 2025), { conference: 'neurips', year: 2025, rate: 24.5, accepted: 5290, submitted: 21575, detail: '77 orals, 688 spotlights and 4525 posters', source: ACCEPTANCE_SOURCE });
check('a "?" count is left out, the rate kept', parsed.rows.find((r) => r.year === 2022), { conference: 'neurips', year: 2022, rate: 25.6, submitted: 10411, source: ACCEPTANCE_SOURCE });
check('a detail with placeholders is left out', 'detail' in parsed.rows.find((r) => r.conference === 'iclr' && r.year === 2025), false);
check('the NIPS alias maps to neurips', parsed.rows.find((r) => r.year === 2017).conference, 'neurips');
check('a rate that contradicts its counts is skipped and named', parsed.skipped, [{ conference: 'iclr', year: 2023, message: '99% does not match 1574/4956' }]);
const ratesText = serializeAcceptanceRates(parsed.rows);
check('the rates file round-trips, sorted by conference and year', yaml.load(ratesText).map((r) => `${r.conference}-${r.year}`), ['cvpr-2025', 'iclr-2024', 'iclr-2025', 'icml-2016', 'neurips-2017', 'neurips-2022', 'neurips-2025']);

console.log('— what the pages read —');
const eds = [
  resolveEdition({ conference: 'iclr', year: 2026, start: '2026-04-23', end: '2026-04-27', paper_deadline: '2025-09-24 23:59', timezone: 'AoE', place: 'Rio de Janeiro, Brazil' }, NOW),
  resolveEdition(created.row, NOW),
  resolveEdition({ conference: 'neurips', year: 2026, start: '2026-12-06', end: '2026-12-13', paper_deadline: '2026-05-07 11:59', timezone: 'UTC', place: 'Sydney, Australia' }, NOW),
  resolveEdition({ conference: 'icml', year: 2026, end: '2026-07-11', paper_deadline: '2026-01-29 11:59', timezone: 'UTC' }, NOW),
  resolveEdition({ conference: 'icml', year: 2025, start: '2025-07-13', end: '2025-07-19' }, NOW),
  resolveEdition({ conference: 'eccv', year: 2026, start: '2026-09-08', end: '2026-09-13', paper_deadline: '2026-03-05 22:00', timezone: 'UTC', place: 'Malmö, Sweden' }, NOW),
  resolveEdition({ conference: 'eccv', year: 2024, start: '2024-09-29', end: '2024-10-04', paper_deadline: '2024-03-07 21:00', timezone: 'UTC' }, NOW),
];
check('a resolved edition carries wall clocks, ISO instants and openness', [eds[1].paperDeadlineWallClock, eds[1].paperDeadlineIso, eds[1].paperOpen, eds[1].abstractOpen, eds[1].dateSpan, eds[1].notificationLabel], ['Sep 25, 2026, 23:59 AoE (UTC−12)', '2026-09-26T11:59:00.000Z', true, true, 'Apr 26–30, 2027', 'Dec 16, 2026']);
check('a closed call is not open; a finished conference is over', [eds[0].paperOpen, eds[0].over, eds[2].over, eds[2].ahead], [false, true, false, true]);
check('a bare date row says nothing about the main conference', [hasMainConference(eds[4]), hasMainConference(eds[3])], [false, true]);
check('the hub headlines the open call', featuredEdition(eds, 'iclr', NOW).year, 2027);
check('… else the edition still ahead', featuredEdition(eds, 'neurips', NOW).year, 2026);
check('… else the most recent one', featuredEdition(eds, 'icml', NOW).year, 2026);
check('… a conference running this week is still current', featuredEdition(eds, 'eccv', NOW).year, 2026);
check('… and nothing for a conference without main-conference facts', featuredEdition(eds, 'corl', NOW), null);
check('the previous edition skips years without a deadline (biennial ECCV)', previousEdition(eds, 'eccv', 2026).year, 2024);
const rates = parsed.rows;
check('history is newest first', acceptanceHistory(rates, 'neurips').map((r) => r.year), [2025, 2022, 2017]);
check('the latest rate', latestAcceptanceRate(rates, 'iclr').year, 2025);
check('rates print with the precision the source gave', [formatRate(24.5), formatRate(30.81), formatRate(22)], ['24.5%', '30.81%', '22.0%']);

console.log('— the cross-conference deadlines page —');
const tba27 = resolveEdition({ conference: 'neurips', year: 2027, start: '2027-12-05', end: '2027-12-11', place: 'Somewhere' }, NOW);
const cvprEd27 = resolveEdition({ conference: 'cvpr', year: 2027, start: '2027-06-19', end: '2027-06-26', paper_deadline: '2026-11-16 23:59', timezone: 'AoE' }, NOW);
const ordered = [eds[3], eds[0], tba27, eds[2], cvprEd27, eds[1], eds[5]].sort(editionOrder);
check('open calls first (soonest), then unannounced, then closed-but-ahead, then held', ordered.map((e) => `${e.conference}-${e.year}`), ['iclr-2027', 'cvpr-2027', 'neurips-2027', 'eccv-2026', 'neurips-2026', 'icml-2026', 'iclr-2026']);
check('typical timing from the past calls (one month, by the latest day)', typicalTiming(eds, 'iclr'), { deadline: 'late September', conference: 'April' });
const spread = [
  resolveEdition({ conference: 'x', year: 2025, end: '2025-07-19', paper_deadline: '2025-01-30 23:59', timezone: 'AoE' }, NOW),
  resolveEdition({ conference: 'x', year: 2026, end: '2026-07-11', paper_deadline: '2026-02-04 23:59', timezone: 'AoE' }, NOW),
];
check('… or a spread of months', typicalTiming(spread, 'x'), { deadline: 'January to February', conference: 'July' });
check('… mid-month reads as a compound', typicalTiming([resolveEdition({ conference: 'y', year: 2026, end: '2026-06-05', paper_deadline: '2025-09-15 23:59', timezone: 'AoE' }, NOW)], 'y', 6).deadline, 'mid-September');
check('… the configured month when no edition has dates', typicalTiming([resolveEdition({ conference: 'z', year: 2026, paper_deadline: '2025-11-13 23:59', timezone: 'AoE' }, NOW)], 'z', 6).conference, 'June');
check('… and nothing without a past call', typicalTiming(eds, 'corl'), null);

console.log('— the review report —');
const rev = [
  { kind: 'earlier-blocked', conf: 'iclr', year: 2027, field: 'paper_deadline', stored: 'a', storedMs: NOW + 10 * DAY, tracker: 'b', trackerMs: NOW + 5 * DAY, source: 'ccfddl' },
  { kind: 'earlier-blocked', conf: 'iclr', year: 2026, field: 'paper_deadline', stored: 'a', storedMs: NOW - 300 * DAY, tracker: 'b', trackerMs: NOW - 305 * DAY, source: 'ccfddl' },
  { kind: 'disagreement', conf: 'icml', year: 2026, field: 'paper_deadline', chosen: 'a', chosenMs: NOW - 200 * DAY, other: 'b', otherMs: NOW - 198 * DAY, chosenSource: 'ccfddl', otherSource: 'ai-deadlines' },
  { kind: 'frozen-diverged', conf: 'eccv', year: 2026, field: 'end', stored: '2026-09-13', tracker: '2026-09-12', source: 'ai-deadlines' },
  { kind: 'frozen-diverged', conf: 'iclr', year: 2026, field: 'end', stored: 'x', tracker: 'y', source: 'ai-deadlines' },
  { kind: 'no-dates-yet', conf: 'cvpr', year: 2027, tracker: 'c', trackerMs: NOW + 60 * DAY, source: 'ccfddl' },
];
const kept = relevantReview(rev, eds, NOW);
check('only items that still matter survive: a future deadline, a running edition, a row still to create', kept.map(reviewKey), ['earlier-blocked:iclr-2027:paper_deadline', 'frozen-diverged:eccv-2026:end', 'no-dates-yet:cvpr-2027']);
const cycleEds = (deadline, year, prevYear = null) => [
  ...(prevYear ? [resolveEdition({ conference: 'c', year: prevYear, end: `${prevYear}-07-15`, paper_deadline: `${prevYear}-01-30 23:59`, timezone: 'AoE' }, NOW)] : []),
  resolveEdition({ conference: 'c', year, end: `${year}-07-15`, paper_deadline: deadline, timezone: 'AoE' }, NOW),
];
const NOV = Date.UTC(2026, 10, 15, 12, 0);
check('a yearly call due in late January is asked for from mid-November', missingNextCycles(cycleEds('2026-01-29 23:59', 2026, 2025), NOV).map((it) => [it.kind, it.year, it.lastYear, it.hasRow]), [['next-cycle-missing', 2027, 2026, false]]);
check('… not in September', missingNextCycles(cycleEds('2026-01-29 23:59', 2026, 2025), NOW), []);
check('… not once the next edition has a deadline', missingNextCycles([...cycleEds('2026-01-29 23:59', 2026), resolveEdition({ conference: 'c', year: 2027, end: '2027-07-15', paper_deadline: '2027-01-28 23:59', timezone: 'AoE' }, NOV)], NOV), []);
check('… a dates-only next row still asks for the deadline', missingNextCycles([...cycleEds('2026-01-29 23:59', 2026), resolveEdition({ conference: 'c', year: 2027, end: '2027-07-15' }, NOV)], NOV)[0].hasRow, true);
check('… a biennial conference keeps its own cadence', missingNextCycles([resolveEdition({ conference: 'e', year: 2024, end: '2024-10-04', paper_deadline: '2024-03-07 21:00', timezone: 'UTC' }, NOV), resolveEdition({ conference: 'e', year: 2026, end: '2026-09-13', paper_deadline: '2026-03-05 22:00', timezone: 'UTC' }, NOV)], Date.UTC(2026, 11, 20)), []);
check('… and is dropped after the grace period', missingNextCycles(cycleEds('2025-01-30 23:59', 2025), Date.UTC(2026, 9, 1)), []);
const rateRows = [{ conference: 'c', year: 2024, rate: 20, source: 's' }];
const rateEds = [
  resolveEdition({ conference: 'c', year: 2024, end: '2024-07-15' }, NOW),
  resolveEdition({ conference: 'c', year: 2025, end: '2025-07-19' }, NOW),
  resolveEdition({ conference: 'c', year: 2026, end: '2026-07-11' }, NOW),
  resolveEdition({ conference: 'd', year: 2025, end: '2025-06-01' }, NOW),
];
check('a finished edition without a rate is asked for after 120 days; a recent one is not; a conference with no rates at all is not', staleAcceptanceRates(rateEds, rateRows, [], NOW), [{ kind: 'rate-missing', conf: 'c', years: [2025] }]);
check('a recent contradictory source row is reported, an old one is not', staleAcceptanceRates(rateEds, rateRows, [{ conference: 'c', year: 2025, message: 'bad' }, { conference: 'c', year: 2014, message: 'old' }], NOW).map((it) => it.kind), ['rate-missing', 'rate-contradiction']);
const body = buildEditionsReport([...kept, ...missingNextCycles(cycleEds('2026-01-29 23:59', 2026, 2025), NOV), ...staleAcceptanceRates(rateEds, rateRows, [], NOW)], { names: new Map([['iclr', 'ICLR'], ['c', 'Conf']]) });
check('the report has one section per kind and names the conference', ['### A tracker says a deadline moved earlier', '**ICLR 2027**', '### The next call should have appeared by now', '**Conf 2027**', '### Acceptance rates not yet in the source table'].every((t) => body.includes(t)), true);
check('… and carries every key for the workflow', /<!-- editions-review-keys: earlier-blocked:iclr-2027:paper_deadline, frozen-diverged:eccv-2026:end, no-dates-yet:cvpr-2027, next-cycle-missing:c-2027, rate-missing:c-2025 -->/.test(body), true);
check('nothing to review is an empty report', buildEditionsReport([]), '');

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
