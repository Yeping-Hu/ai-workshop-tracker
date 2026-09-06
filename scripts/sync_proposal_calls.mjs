#!/usr/bin/env node
/**
 * Daily: keep data/proposal_calls.yml — when organizers can apply to host a
 * workshop at each conference — in step with OpenReview.
 *
 * The file was hand-typed and rotted the way hand-typed data does: two commits
 * in its life, three closed calls and no open one on the homepage, while
 * `ICLR.cc/2027/Workshop_Proposals` already existed on OpenReview. The
 * conferences that run proposals through OpenReview register that venue under
 * the SAME prefix discovery already knows for their workshops (CONF_TEMPLATE),
 * with the trailing `Workshop` swapped for a proposal suffix —
 * `NeurIPS.cc/2026/Workshop_Proposals`, `IEEE.org/ICRA/2027/WT-Pre-Proposals` —
 * and publish its deadline exactly where a workshop's is: the group's `date`
 * line first ("Submission Deadline: Jun 07 2026 12:30PM UTC-0"), the
 * `/-/Submission` invitation's `duedate` as the fallback. So this job reuses
 * the readers and the gates of the workshop-deadline syncs and adds only what
 * is specific to a proposal cycle:
 *
 *   - Probe this year and next for every conference, by suffix vocabulary
 *     (PROPOSAL_SUFFIXES), until a row exists; a row that already carries
 *     `openreview_venue_id` is looked up directly. A conference with no
 *     proposal venue on OpenReview (ECCV, CoRL, COLM, IROS today) gets two
 *     404s a day and keeps whatever a person wrote.
 *   - No row until a deadline parses. The venue precedes the public call:
 *     ICLR 2027's group existed with an empty date line and no submission
 *     invitation while iclr.cc's call page was still a 404. An empty group is
 *     `no-deadline-yet`, not a cycle.
 *   - Hand-typed rows are adopted, never overwritten. A row with no
 *     `deadline_notes` is compared by instant: a later value on OpenReview is
 *     applied and stamped (ICRA 2027's row said 07:59 UTC; the invitation says
 *     11:59), an equal one is re-expressed in UTC and stamped, an earlier one
 *     only gains the venue id. `url` and `notes` are a person's and stay.
 *   - The same gates as every other deadline write: later-only, plausible
 *     (lib/dates.mjs), freeze on hand edit via the value stamp (syncedValue),
 *     and nothing is touched once a call has been closed longer than
 *     DEADLINE_LOOKBACK_MS — the reused-invitation hazard applies here too.
 *   - A failed lookup is recorded, retried once, then named; it never blanks
 *     or removes a row, and the job exits 0.
 *
 * Writes the file only when a row changed, through one serializer that owns
 * the header comment (yaml.dump drops it otherwise). Each change is appended to
 * $DEADLINE_CHANGELOG so the workflow folds it into the commit message, like
 * every other data job. Rules are pinned by scripts/proposal_calls_test.mjs;
 * the file itself is validated by scripts/validate.mjs.
 *
 * Usage:
 *   node scripts/sync_proposal_calls.mjs
 *   node scripts/sync_proposal_calls.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { REPO_ROOT, loadProposalCallRows } from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs, plausibleDeadline } from '../lib/dates.mjs';
import { unwrap, retryUnverified, writeUnverified } from '../lib/openreview.mjs';
import {
  CONF_TEMPLATE,
  parseGroupDeadline,
  deadlineFromInvitation,
  msToDeadline,
  websiteFromContent,
  syncNote,
  syncedValue,
  decideDeadlineUpdate,
  DEADLINE_LOOKBACK_MS,
} from './discover_openreview.mjs';
import { fetchGroupById } from './recheck_imminent.mjs';

const FILE = path.join(REPO_ROOT, 'data', 'proposal_calls.yml');

/**
 * How a conference names its proposal venue, in the order tried. Every
 * conference is probed with every suffix, so a conference that adopts one of
 * these needs no configuration; a conference that invents a new one needs the
 * suffix added here and nothing else (see skills/add-conference).
 */
export const PROPOSAL_SUFFIXES = ['Workshop_Proposals', 'WT-Pre-Proposals'];

// OpenReview wraps some content values as { value: … }; unwrap if so.
const val = (c, k) => unwrap(c?.[k]);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The venue ids a conference-year's proposal call could live under. */
export function candidateIds(conf, year) {
  const template = CONF_TEMPLATE[conf];
  if (!template) return [];
  const base = template.replace('{year}', String(year)).replace(/\/Workshop$/, '');
  return PROPOSAL_SUFFIXES.map((s) => `${base}/${s}`);
}

/** A call for year Y opens in Y−1 (ICLR 2027: autumn 2026) or in Y (NeurIPS
 *  2026: spring 2026), so this year's and next year's cycles are the live ones. */
export function proposalYears(nowMs = Date.now()) {
  const y = new Date(nowMs).getUTCFullYear();
  return [y, y + 1];
}

/**
 * Whether a cycle is worth a network call, decided from the stored row alone.
 * A frozen or long-closed row is never looked up: the answer could not be
 * applied anyway, and the daily budget is shared with four other jobs.
 */
export function lookupPlan(row, nowMs = Date.now()) {
  if (!row) return { fetch: true, reason: 'probe' };
  const stamped = syncedValue(row.deadline_notes);
  if (row.deadline_notes && stamped == null) return { fetch: false, reason: 'frozen' }; // a person's note
  if (stamped != null && stamped !== row.proposal_deadline) return { fetch: false, reason: 'frozen' }; // hand-edited value
  const storedMs = resolveDeadlineUtcMs(row.proposal_deadline, row.timezone || 'AoE');
  if (storedMs != null && storedMs < nowMs - DEADLINE_LOOKBACK_MS) return { fetch: false, reason: 'long-closed' };
  return { fetch: true, reason: row.openreview_venue_id ? 'direct' : 'probe' };
}

// A fixed key order so the file reads the same whoever last wrote a row.
const KEY_ORDER = ['conference', 'year', 'proposal_deadline', 'timezone', 'url', 'openreview_venue_id', 'deadline_notes', 'notes'];
function orderRow(r) {
  const out = {};
  for (const k of KEY_ORDER) if (r[k] != null && r[k] !== '') out[k] = r[k];
  for (const k of Object.keys(r)) if (!(k in out) && r[k] != null) out[k] = r[k];
  return out;
}

const skip = (reason) => ({ action: 'skip', reason, row: null, change: null });

/**
 * The whole decision for one conference-year, pure over what was (or was not)
 * fetched: `row` is the stored row or null, `groupId` the venue that answered
 * (null when none did), `fetched` the parsed deadline ({submission_deadline,
 * timezone: 'UTC'}) or null, `website` the group's website or null. Returns
 * {action: 'create'|'update'|'adopt'|'skip', reason, row, change}; `row` is the
 * complete replacement row, `change` the changelog line (null when the instant
 * did not move).
 */
export function decideProposalCall({ row, conf, year, groupId, fetched, website, nowMs = Date.now(), today = isoDay(nowMs) }) {
  const fetchedMs = fetched ? resolveDeadlineUtcMs(fetched.submission_deadline, fetched.timezone || 'UTC') : null;
  const fetchedYear = fetched ? Number(String(fetched.submission_deadline).slice(0, 4)) : null;
  const plausible = () => plausibleDeadline(fetchedMs, fetchedYear, year, nowMs);

  if (!row) {
    if (!groupId) return skip('no-venue');
    if (!fetched) return skip('no-deadline-yet');
    if (!plausible()) return skip('implausible');
    const next = orderRow({
      conference: conf,
      year,
      proposal_deadline: fetched.submission_deadline,
      timezone: 'UTC',
      url: website || `https://openreview.net/group?id=${groupId}`,
      openreview_venue_id: groupId,
      deadline_notes: syncNote(fetched.submission_deadline, today),
    });
    return { action: 'create', reason: 'new-call', row: next, change: `${conf} ${year} proposals: none -> ${fetched.submission_deadline} UTC (new call)` };
  }

  // The same pre-flight gates as lookupPlan, so the decision is complete on
  // its own and a test needs no network to exercise them.
  const plan = lookupPlan(row, nowMs);
  if (!plan.fetch) return skip(plan.reason);
  if (!groupId) return skip(row.openreview_venue_id ? 'lookup-failed' : 'no-venue');
  if (!fetched) return skip('no-deadline-yet');
  if (!plausible()) return skip('implausible');

  const storedMs = resolveDeadlineUtcMs(row.proposal_deadline, row.timezone || 'AoE');
  const adopting = syncedValue(row.deadline_notes) == null; // hand-typed row, first contact
  const decision = decideDeadlineUpdate(storedMs, fetchedMs, { allowEarlier: false });
  const label = `${conf} ${year} proposals`;
  if (decision.update) {
    const next = orderRow({
      ...row,
      proposal_deadline: fetched.submission_deadline,
      timezone: 'UTC',
      openreview_venue_id: groupId,
      deadline_notes: syncNote(fetched.submission_deadline, today),
    });
    return {
      action: adopting ? 'adopt' : 'update',
      reason: decision.reason,
      row: next,
      change: `${label}: ${row.proposal_deadline} ${row.timezone || 'AoE'} -> ${fetched.submission_deadline} UTC (${decision.reason}${adopting ? ', adopted' : ''})`,
    };
  }
  if (decision.reason === 'unchanged' && adopting) {
    // Same instant, written by hand: take it over as-is, in UTC so the stamp
    // says what the value is, so future moves flow in without a person.
    const utc = msToDeadline(storedMs).submission_deadline;
    const next = orderRow({ ...row, proposal_deadline: utc, timezone: 'UTC', openreview_venue_id: groupId, deadline_notes: syncNote(utc, today) });
    return { action: 'adopt', reason: 'unchanged', row: next, change: null };
  }
  if (decision.reason === 'earlier-blocked' && adopting && !row.openreview_venue_id) {
    // A person recorded a later date than OpenReview shows. Their value stands
    // (later-only, as everywhere); the venue id is still worth keeping so the
    // next look is direct.
    return { action: 'adopt', reason: 'earlier-blocked', row: orderRow({ ...row, openreview_venue_id: groupId }), change: null };
  }
  return skip(decision.reason);
}

const HEADER = `# Workshop PROPOSAL deadlines — when organizers can apply to host a workshop at
# each conference (not when authors submit papers). Shown on the homepage.
#
# Maintained by scripts/sync_proposal_calls.mjs (daily) for every conference
# whose proposal venue is on OpenReview: a row appears once its deadline is
# published and follows later moves. A row the bot manages carries
# \`openreview_venue_id\` and an \`OpenReview-synced …\` stamp in \`deadline_notes\`;
# edit the date or that note and the row is frozen (yours wins). \`notes\` is
# always yours. Conferences that publish their call elsewhere get a hand-written
# row: conference, year, proposal_deadline, timezone, url, notes — see
# CONTRIBUTING.md, "Workshop proposal calls".
`;

/** The file's text for these rows: header, then rows by conference and year. */
export function serializeProposalCalls(rows) {
  const sorted = [...rows]
    .map(orderRow)
    .sort((a, b) => String(a.conference).localeCompare(String(b.conference)) || Number(a.year) - Number(b.year));
  return HEADER + yaml.dump(sorted, { lineWidth: 200, quotingType: '"' });
}

/**
 * Find the proposal venue for one cycle: directly when the row names it,
 * otherwise by probing the suffix vocabulary. Every id tried (and the
 * invitation id the deadline fallback may record) is registered in `owners` so
 * a failed lookup can be retried against the right cycle later.
 */
export async function lookupProposalVenue(conf, year, row, owners) {
  const ids = row?.openreview_venue_id ? [row.openreview_venue_id] : candidateIds(conf, year);
  for (const id of ids) {
    owners.set(id, { conf, year });
    owners.set(`${id}/-/Submission`, { conf, year });
    const g = await fetchGroupById(id);
    if (g) {
      const submissionId = val(g.content ?? {}, 'submission_id');
      if (submissionId) owners.set(String(submissionId), { conf, year });
      return { id, group: g };
    }
  }
  return null;
}

async function main({ dryRun }) {
  const nowMs = Date.now();
  const today = isoDay(nowMs);
  const rows = loadProposalCallRows();
  const out = rows.map((r) => ({ ...r }));
  const keyOf = (r) => `${r.conference}-${r.year}`;
  const index = new Map(out.map((r, i) => [keyOf(r), i]));
  const owners = new Map();
  const changes = [];
  const tally = { create: 0, update: 0, adopt: 0, skip: 0 };
  const skipped = new Map(); // reason -> [cycle]
  const cycles = [];
  for (const conf of Object.keys(CONF_TEMPLATE)) for (const year of proposalYears(nowMs)) cycles.push({ conf, year });

  const checkOne = async ({ conf, year }) => {
    const key = `${conf}-${year}`;
    const row = index.has(key) ? out[index.get(key)] : null;
    const plan = lookupPlan(row, nowMs);
    let groupId = null;
    let fetched = null;
    let website = null;
    if (plan.fetch) {
      const found = await lookupProposalVenue(conf, year, row, owners);
      if (found) {
        groupId = found.id;
        const dateLine = val(found.group.content ?? {}, 'date');
        fetched = parseGroupDeadline(dateLine) || (await deadlineFromInvitation(found.group));
        website = websiteFromContent(found.group.content ?? {});
      }
    }
    const d = decideProposalCall({ row, conf, year, groupId, fetched, website, nowMs, today });
    tally[d.action]++;
    if (d.action === 'skip') {
      if (!skipped.has(d.reason)) skipped.set(d.reason, []);
      skipped.get(d.reason).push(key);
      if (d.reason === 'implausible' && fetched) {
        console.warn(`  ⚠ ${key}: OpenReview proposal deadline "${fetched.submission_deadline}" looks implausible — left unchanged`);
      }
      if (d.reason === 'earlier-blocked') {
        console.warn(`  ⚠ ${key}: OpenReview says ${fetched.submission_deadline} UTC, earlier than the stored ${row.proposal_deadline} ${row.timezone || 'AoE'} — left unchanged (later-only)`);
      }
      return true;
    }
    if (d.action === 'create') {
      index.set(key, out.length);
      out.push(d.row);
    } else {
      out[index.get(key)] = d.row;
    }
    console.log(`  ${d.action} ${key} (${d.reason})${d.change ? `: ${d.change.slice(key.length + ' proposals: '.length)}` : ''}`);
    if (d.change) changes.push(d.change);
    return true;
  };

  for (const c of cycles) await checkOne(c);

  // Second pass over whatever could not be reached, once the rate budget has
  // recovered — the same pass every other OpenReview job runs. Whatever
  // survives is named rather than counted.
  const ownerOf = (id) => owners.get(id) ?? owners.get(String(id).split('/-/')[0]);
  const missed = await retryUnverified(async (id) => {
    const o = ownerOf(id);
    return o ? checkOne(o) : false;
  });

  const touched = tally.create + tally.update + tally.adopt;
  if (touched && !dryRun) fs.writeFileSync(FILE, serializeProposalCalls(out));
  if (changes.length && process.env.DEADLINE_CHANGELOG && !dryRun) {
    fs.appendFileSync(process.env.DEADLINE_CHANGELOG, changes.map((c) => `- ${c}`).join('\n') + '\n');
  }
  console.log(
    `${dryRun ? '[dry-run] ' : ''}Proposal calls: ${cycles.length} cycle(s) checked — ` +
      `${tally.create} created, ${tally.update} updated, ${tally.adopt} adopted, ${tally.skip} skipped` +
      `${missed.length ? `, ${missed.length} UNVERIFIED` : ''}.`,
  );
  for (const [reason, keys] of skipped) console.log(`    skipped (${reason}): ${keys.join(', ')}`);
  for (const c of changes) console.log(`    ↳ ${c}`);
  writeUnverified(missed.map((m) => ({ ...m, conf: ownerOf(m.id)?.conf, year: ownerOf(m.id)?.year })));
}

// Only run the CLI when invoked directly, so the pure exports can be imported
// by the test without the module parsing argv and hitting the network.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  main({ dryRun }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
