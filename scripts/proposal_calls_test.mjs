#!/usr/bin/env node
/**
 * Pins the rules of the daily proposal-call sync (scripts/sync_proposal_calls.mjs):
 * which venue ids are probed, when a row is looked up at all, and the whole
 * create / adopt / update / skip decision — with the fixtures taken from the
 * live OpenReview records the job was designed against on 2026-09-05. No
 * network, no filesystem.
 *
 * Run: node scripts/proposal_calls_test.mjs
 */
import * as yaml from 'js-yaml';
import {
  PROPOSAL_SUFFIXES,
  candidateIds,
  proposalYears,
  lookupPlan,
  decideProposalCall,
  serializeProposalCalls,
} from './sync_proposal_calls.mjs';
import { parseGroupDeadline, msToDeadline, syncNote, syncedValue } from './discover_openreview.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

const NOW = Date.UTC(2026, 8, 5, 12, 0); // 2026-09-05 12:00 UTC
const TODAY = '2026-09-05';
const DAY = 86_400_000;

// --- the live date lines, verbatim ------------------------------------------
const NEURIPS_LINE =
  'Submission Start: Apr 21 2026 12:00AM UTC-0, Abstract Registration: Jun 07 2026 12:30PM UTC-0, Submission Deadline: Jun 07 2026 12:30PM UTC-0';
const ICML_LINE = 'Submission Start: Jan 21 2026 12:00AM UTC-0, Submission Deadline: Feb 14 2026 11:59PM UTC-0';
const ICLR26_LINE = 'Submission Start: Sep 07 2025 11:59PM UTC-0, Submission Deadline: Oct 11 2025 11:59AM UTC-0';
const CVPR26_LINE = 'Submission Start: Oct 22 2025 11:59AM UTC-0, Submission Deadline: Nov 04 2025 11:59AM UTC-0';
// ICRA 2027 has an empty date line; its /-/Submission invitation carries this.
const ICRA27_DUEDATE_MS = Date.UTC(2026, 8, 2, 11, 59);

check('the group date line reads like a workshop\'s (NeurIPS)', parseGroupDeadline(NEURIPS_LINE), { submission_deadline: '2026-06-07 12:30', timezone: 'UTC' });
check('ICML', parseGroupDeadline(ICML_LINE), { submission_deadline: '2026-02-14 23:59', timezone: 'UTC' });
check('ICLR 2026', parseGroupDeadline(ICLR26_LINE), { submission_deadline: '2025-10-11 11:59', timezone: 'UTC' });
check('CVPR 2026', parseGroupDeadline(CVPR26_LINE), { submission_deadline: '2025-11-04 11:59', timezone: 'UTC' });
check('an empty date line parses to nothing', parseGroupDeadline(''), null);

// --- where to look -----------------------------------------------------------
check('suffix vocabulary', PROPOSAL_SUFFIXES, ['Workshop_Proposals', 'WT-Pre-Proposals']);
check('candidate ids come from the workshop prefix', candidateIds('neurips', 2027), ['NeurIPS.cc/2027/Workshop_Proposals', 'NeurIPS.cc/2027/WT-Pre-Proposals']);
check('ICRA\'s real venue is the second candidate', candidateIds('icra', 2027)[1], 'IEEE.org/ICRA/2027/WT-Pre-Proposals');
check('CVPR', candidateIds('cvpr', 2026)[0], 'thecvf.com/CVPR/2026/Workshop_Proposals');
check('an unknown conference has no candidates', candidateIds('nope', 2026), []);
check('this year and next are the live cycles', proposalYears(NOW), [2026, 2027]);

// --- whether to look at all --------------------------------------------------
const icml26 = { conference: 'icml', year: 2026, proposal_deadline: '2026-02-13', timezone: 'AoE', url: 'https://icml.cc/Conferences/2026/CallForWorkshops', notes: 'Notification Mar 20, 2026' };
const icra27 = { conference: 'icra', year: 2027, proposal_deadline: '2026-09-02 07:59', timezone: 'UTC', url: 'https://openreview.net/group?id=IEEE.org/ICRA/2027/WT-Pre-Proposals', notes: 'Call for workshop & tutorial pre-proposals, submitted via OpenReview.' };
const stampedOpen = { conference: 'iclr', year: 2027, proposal_deadline: '2026-10-10 11:59', timezone: 'UTC', url: 'https://iclr.cc/Conferences/2027/CallForWorkshops', openreview_venue_id: 'ICLR.cc/2027/Workshop_Proposals', deadline_notes: syncNote('2026-10-10 11:59', '2026-09-01') };

check('no row -> probe', lookupPlan(null, NOW), { fetch: true, reason: 'probe' });
check('hand-typed row inside the look-back -> probe', lookupPlan(icra27, NOW), { fetch: true, reason: 'probe' });
check('closed longer than the look-back -> not looked up', lookupPlan(icml26, NOW), { fetch: false, reason: 'long-closed' });
check('bot-managed row with a venue id -> direct', lookupPlan(stampedOpen, NOW), { fetch: true, reason: 'direct' });
check('stamp no longer matching the value -> frozen', lookupPlan({ ...stampedOpen, proposal_deadline: '2026-10-12 11:59' }, NOW), { fetch: false, reason: 'frozen' });
check('a person\'s deadline note -> frozen', lookupPlan({ ...icra27, deadline_notes: 'confirmed by the chairs' }, NOW), { fetch: false, reason: 'frozen' });

// --- creating a cycle ----------------------------------------------------------
{
  const d = decideProposalCall({ row: null, conf: 'iclr', year: 2026, groupId: 'ICLR.cc/2026/Workshop_Proposals', fetched: parseGroupDeadline(ICLR26_LINE), website: 'https://iclr.cc/Conferences/2026/CallForWorkshops', nowMs: NOW, today: TODAY });
  check('a published deadline creates the row', [d.action, d.reason], ['create', 'new-call']);
  check('…as UTC, linked to the call page, stamped, with no notes', d.row, {
    conference: 'iclr', year: 2026, proposal_deadline: '2025-10-11 11:59', timezone: 'UTC',
    url: 'https://iclr.cc/Conferences/2026/CallForWorkshops', openreview_venue_id: 'ICLR.cc/2026/Workshop_Proposals',
    deadline_notes: syncNote('2025-10-11 11:59', TODAY),
  });
  check('…and the stamp reads back as the value', syncedValue(d.row.deadline_notes), '2025-10-11 11:59');
  check('…with a changelog line', d.change, 'iclr 2026 proposals: none -> 2025-10-11 11:59 UTC (new call)');
}
{
  const d = decideProposalCall({ row: null, conf: 'neurips', year: 2026, groupId: 'NeurIPS.cc/2026/Workshop_Proposals', fetched: parseGroupDeadline(NEURIPS_LINE), website: null, nowMs: NOW, today: TODAY });
  check('no website on the group -> the OpenReview group is the link', d.row.url, 'https://openreview.net/group?id=NeurIPS.cc/2026/Workshop_Proposals');
}
check('a venue with no deadline yet (ICLR 2027 before its call opened) is not a cycle', decideProposalCall({ row: null, conf: 'iclr', year: 2027, groupId: 'ICLR.cc/2027/Workshop_Proposals', fetched: null, website: 'https://iclr.cc/', nowMs: NOW }), { action: 'skip', reason: 'no-deadline-yet', row: null, change: null });
check('no venue at all (ECCV) -> nothing', decideProposalCall({ row: null, conf: 'eccv', year: 2026, groupId: null, fetched: null, website: null, nowMs: NOW }).reason, 'no-venue');
check('an implausible year is refused', decideProposalCall({ row: null, conf: 'cvpr', year: 2026, groupId: 'thecvf.com/CVPR/2026/Workshop_Proposals', fetched: { submission_deadline: '2030-01-01 00:00', timezone: 'UTC' }, website: null, nowMs: NOW }).reason, 'implausible');

// --- adopting the hand-typed rows -----------------------------------------------
{
  const d = decideProposalCall({ row: icra27, conf: 'icra', year: 2027, groupId: 'IEEE.org/ICRA/2027/WT-Pre-Proposals', fetched: msToDeadline(ICRA27_DUEDATE_MS), website: 'https://2027.ieee-icra.org/', nowMs: NOW, today: TODAY });
  check('ICRA 2027: a later instant on OpenReview is adopted', [d.action, d.reason], ['adopt', 'later']);
  check('…value moves to the invitation duedate, in UTC', [d.row.proposal_deadline, d.row.timezone], ['2026-09-02 11:59', 'UTC']);
  check('…the venue id is recorded and the row stamped', [d.row.openreview_venue_id, syncedValue(d.row.deadline_notes)], ['IEEE.org/ICRA/2027/WT-Pre-Proposals', '2026-09-02 11:59']);
  check('…url and notes are the person\'s and untouched', [d.row.url, d.row.notes], [icra27.url, icra27.notes]);
  check('…keys are in the file\'s order', Object.keys(d.row), ['conference', 'year', 'proposal_deadline', 'timezone', 'url', 'openreview_venue_id', 'deadline_notes', 'notes']);
  check('…changelog names both values', d.change, 'icra 2027 proposals: 2026-09-02 07:59 UTC -> 2026-09-02 11:59 UTC (later, adopted)');
}
{
  // Same instant written by hand as AoE: taken over in UTC, stamped, no changelog.
  const row = { conference: 'colm', year: 2026, proposal_deadline: '2026-09-10', timezone: 'AoE', url: 'https://colmweb.org/cfw' };
  const d = decideProposalCall({ row, conf: 'colm', year: 2026, groupId: 'colmweb.org/COLM/2026/Workshop_Proposals', fetched: { submission_deadline: '2026-09-11 11:59', timezone: 'UTC' }, website: null, nowMs: NOW, today: TODAY });
  check('same instant, hand-typed -> adopted as UTC', [d.action, d.reason, d.row.proposal_deadline, d.row.timezone, d.change], ['adopt', 'unchanged', '2026-09-11 11:59', 'UTC', null]);
  check('…and stamped', syncedValue(d.row.deadline_notes), '2026-09-11 11:59');
}
{
  // A person recorded a LATER date than OpenReview: theirs stands, only the id is kept.
  const row = { conference: 'corl', year: 2026, proposal_deadline: '2026-09-20 11:59', timezone: 'UTC', url: 'https://corl.org/cfw' };
  const d = decideProposalCall({ row, conf: 'corl', year: 2026, groupId: 'robot-learning.org/CoRL/2026/Workshop_Proposals', fetched: { submission_deadline: '2026-09-12 11:59', timezone: 'UTC' }, website: null, nowMs: NOW, today: TODAY });
  check('earlier on OpenReview, hand-typed -> id only', [d.action, d.reason, d.row.proposal_deadline, d.row.openreview_venue_id, d.row.deadline_notes ?? null, d.change], ['adopt', 'earlier-blocked', '2026-09-20 11:59', 'robot-learning.org/CoRL/2026/Workshop_Proposals', null, null]);
}
check('closed longer than the look-back is never touched (ICML 2026)', decideProposalCall({ row: icml26, conf: 'icml', year: 2026, groupId: 'ICML.cc/2026/Workshop_Proposals', fetched: parseGroupDeadline(ICML_LINE), website: null, nowMs: NOW }).reason, 'long-closed');

// --- bot-managed rows: later-only ---------------------------------------------------
check('a later duedate is applied', decideProposalCall({ row: stampedOpen, conf: 'iclr', year: 2027, groupId: stampedOpen.openreview_venue_id, fetched: { submission_deadline: '2026-10-17 11:59', timezone: 'UTC' }, website: null, nowMs: NOW, today: TODAY }).row.proposal_deadline, '2026-10-17 11:59');
check('…as an update, not an adoption', decideProposalCall({ row: stampedOpen, conf: 'iclr', year: 2027, groupId: stampedOpen.openreview_venue_id, fetched: { submission_deadline: '2026-10-17 11:59', timezone: 'UTC' }, website: null, nowMs: NOW, today: TODAY }).action, 'update');
check('an earlier duedate is declined', decideProposalCall({ row: stampedOpen, conf: 'iclr', year: 2027, groupId: stampedOpen.openreview_venue_id, fetched: { submission_deadline: '2026-10-03 11:59', timezone: 'UTC' }, website: null, nowMs: NOW }), { action: 'skip', reason: 'earlier-blocked', row: null, change: null });
check('the same duedate is a no-op', decideProposalCall({ row: stampedOpen, conf: 'iclr', year: 2027, groupId: stampedOpen.openreview_venue_id, fetched: { submission_deadline: '2026-10-10 11:59', timezone: 'UTC' }, website: null, nowMs: NOW }).reason, 'unchanged');
check('a hand-edited value is frozen', decideProposalCall({ row: { ...stampedOpen, proposal_deadline: '2026-10-12 11:59' }, conf: 'iclr', year: 2027, groupId: stampedOpen.openreview_venue_id, fetched: { submission_deadline: '2026-10-17 11:59', timezone: 'UTC' }, website: null, nowMs: NOW }).reason, 'frozen');
check('a failed lookup leaves the row alone', decideProposalCall({ row: stampedOpen, conf: 'iclr', year: 2027, groupId: null, fetched: null, website: null, nowMs: NOW }), { action: 'skip', reason: 'lookup-failed', row: null, change: null });
check('a venue that lost its deadline is not followed to null', decideProposalCall({ row: stampedOpen, conf: 'iclr', year: 2027, groupId: stampedOpen.openreview_venue_id, fetched: null, website: null, nowMs: NOW }).reason, 'no-deadline-yet');
check('long-closed applies to bot-managed rows too', decideProposalCall({ row: { ...stampedOpen, proposal_deadline: '2026-08-01 11:59', deadline_notes: syncNote('2026-08-01 11:59', '2026-07-01') }, conf: 'iclr', year: 2027, groupId: stampedOpen.openreview_venue_id, fetched: { submission_deadline: '2026-09-30 11:59', timezone: 'UTC' }, website: null, nowMs: NOW }).reason, 'long-closed');
check('…but a call closed a few days ago can still be extended', decideProposalCall({ row: { ...stampedOpen, proposal_deadline: msToDeadline(NOW - 3 * DAY).submission_deadline, deadline_notes: syncNote(msToDeadline(NOW - 3 * DAY).submission_deadline, '2026-08-01') }, conf: 'iclr', year: 2027, groupId: stampedOpen.openreview_venue_id, fetched: msToDeadline(NOW + 4 * DAY), website: null, nowMs: NOW, today: TODAY }).action, 'update');

// --- the file --------------------------------------------------------------------
{
  const text = serializeProposalCalls([stampedOpen, icra27, icml26]);
  check('the header survives serialization', text.startsWith('# Workshop PROPOSAL deadlines'), true);
  const back = yaml.load(text);
  // localeCompare: "iclr" sorts before "icml" before "icra".
  check('rows come back sorted by conference then year', back.map((r) => `${r.conference}-${r.year}`), ['iclr-2027', 'icml-2026', 'icra-2027']);
  check('a date-only deadline round-trips as a string, not a Date', typeof back[1].proposal_deadline, 'string');
  check('values round-trip', [back[1].proposal_deadline, back[2].proposal_deadline, back[0].deadline_notes], ['2026-02-13', '2026-09-02 07:59', stampedOpen.deadline_notes]);
  check('key order is fixed', Object.keys(back[0]), ['conference', 'year', 'proposal_deadline', 'timezone', 'url', 'openreview_venue_id', 'deadline_notes']);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nProposal-call sync rules hold');
process.exit(failed ? 1 : 0);
