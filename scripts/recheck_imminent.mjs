#!/usr/bin/env node
/**
 * Daily, lightweight companion to the weekly OpenReview discovery bot.
 *
 * The weekly `discover` job enumerates every conference venue group (new
 * venues, backfills, broad sync) — that's the heavy crawl, and it's the right
 * cadence for *discovery*. But a deadline *extension* is time-sensitive: it is
 * announced right around the original date, and a stale (earlier) deadline left
 * on the board for up to a week is exactly the failure this site exists to
 * prevent. So this job runs DAILY and does the minimum needed to catch
 * extensions fast: it re-checks only the workshops whose deadline is *imminent*
 * and applies any later move, with the same safety gates as the weekly sync.
 *
 * What "imminent" means — a band AROUND today, computed fresh every run from the
 * data (there is no list to maintain; it self-updates):
 *
 *     deadline ∈ [ now − 7 days , now + 14 days ]
 *
 * The +14-day half catches upcoming deadlines; the −7-day half is the important
 * part: a workshop whose deadline passed a day or two ago is still in the band,
 * so when an organizer extends *after* the original date (common), this job sees
 * the new later duedate and applies it within ~24h instead of waiting for the
 * next weekly run. Once an entry is extended its deadline is in the future
 * again, so it stays on the +14-day side and keeps being re-checked; a passed
 * deadline with no change simply drops out of the band after a week.
 *
 * What it skips (each handled elsewhere, so nothing falls through):
 *   - Human-edited deadlines — frozen by the same value-stamp check the weekly
 *     bot uses (`syncedValue(deadline_notes) === submission_deadline`); a
 *     hand-edited deadline never matches, so it is never auto-touched. It can
 *     only surface in the daily `deadline-review` issue for you to decide.
 *   - Legacy / not-yet-adopted entries — adoption is the weekly job's role; this
 *     job only re-syncs entries that already carry a bot stamp.
 *   - Multi-track venues (`tracks`) — their headline is derived across child
 *     deadlines; the weekly job handles that descent. Out of scope here.
 *   - Entries with no `openreview_venue_id` — nothing to look up.
 *
 * Cost: one direct OpenReview lookup per in-band entry (no enumeration), so a
 * typical day is a handful of calls (often zero off-season). Same later-only +
 * plausibility gates as the weekly sync, so a transient/garbled read can't
 * clobber a good value. Writes files only; the workflow validates, commits
 * (as github-actions[bot]), and pushes — each change recorded in the commit
 * message via $DEADLINE_CHANGELOG, exactly like the weekly run.
 *
 * Usage:
 *   node scripts/recheck_imminent.mjs
 *   node scripts/recheck_imminent.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { listWorkshopFiles, readWorkshopFile, recordDeadlineObservation } from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs } from '../lib/dates.mjs';
import { openreviewFetch, recordUnverified, retryUnverified, writeUnverified } from '../lib/openreview.mjs';
import {
  syncNote,
  syncedValue,
  decideDeadlineUpdate,
  deadlineFromInvitation,
  parseGroupDeadline,
  parseGroupAbstractDeadline,
  meaningfulAbstractDeadline,
} from './discover_openreview.mjs';

const UA = 'ai-workshop-tracker/1.0 (open-source workshop aggregator; github)';
const DAY = 86_400_000;
// The band around "now". Forward catches imminent deadlines; the look-back
// catches the late-extension case (deadline passed, organizer extends a day or
// two later). A week of look-back is generous: post-deadline extensions almost
// always land within a few days of the original date.
const LOOKBACK_MS = 7 * DAY;
const LOOKAHEAD_MS = 14 * DAY;
// Same plausibility guard as the weekly sync: reject absurd reads rather than
// clobber a good value or fail validation for the whole run.
const TWO_YEARS_MS = 2 * 366 * DAY;
// Later-only by default, identical to the weekly sync: extensions flow in,
// earlier moves are left for the daily cross-check / deadline-review issue.
const ALLOW_EARLIER = false;

// OpenReview wraps some content values as { value: … }; unwrap if so.
const val = (c, k) => {
  const x = c?.[k];
  return x && typeof x === 'object' && 'value' in x ? x.value : x;
};

/**
 * Fetch a single OpenReview group by its exact id. Returns the group object (so
 * callers get its `date` line and `submission_id` for free), or null.
 *
 * Null has two very different meanings and the caller cannot tell them apart, so
 * this records the difference instead: a 4xx is a genuine miss (the venue is gone
 * or renamed), while a throttled or failed lookup goes to `recordUnverified` for
 * the run's retry pass. Returning a bare null for both is how a rate limit used
 * to look exactly like a venue with nothing to say — for as long as the entry
 * existed, since nothing ever came back to it.
 *
 * Paced by lib/openreview.mjs against OpenReview's advertised budget rather than
 * a fixed pre-sleep: five scripts call this on daily crons against one per-IP
 * ceiling, and a limiter that only some of them use is no limiter at all.
 */
export async function fetchGroupById(id) {
  const url = `https://api2.openreview.net/groups?id=${encodeURIComponent(id)}&limit=1`;
  const MAX = 3;
  for (let attempt = 0; attempt < MAX; attempt++) {
    try {
      if (attempt) await new Promise((r) => setTimeout(r, attempt * attempt * 1000));
      const res = await openreviewFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX - 1) continue;
        throw new Error(`HTTP ${res.status} after retries`);
      }
      if (!res.ok) return null; // genuine miss (e.g. 404 — venue gone or renamed)
      const { groups = [] } = await res.json();
      return groups[0] || null;
    } catch (err) {
      if (attempt < MAX - 1) continue;
      recordUnverified(id, `group lookup: ${err.message}`);
      console.warn(`  ⚠ group lookup failed for ${id}: ${err.message}`);
      return null;
    }
  }
  return null;
}

/**
 * Eligibility predicate for the daily job — pure over the stored record + a
 * "now" instant, so it is unit-tested with no network. Eligible iff ALL hold:
 *   - carries an `openreview_venue_id` (we can look it up),
 *   - is single-deadline (no `tracks`; the weekly job owns multi-track),
 *   - has a `submission_deadline`,
 *   - is bot-managed & human-untouched — its `deadline_notes` still stamps the
 *     exact value stored (so any hand-edit, or a legacy/unstamped note, fails),
 *   - its stored deadline sits inside the band [now − 7d, now + 14d].
 */
export function isImminentBotManaged(raw, nowMs) {
  if (!raw || !raw.openreview_venue_id) return false;
  if (Array.isArray(raw.tracks) && raw.tracks.length) return false;
  if (!raw.submission_deadline) return false;
  if (syncedValue(raw.deadline_notes) !== raw.submission_deadline) return false;
  const ms = resolveDeadlineUtcMs(raw.submission_deadline, raw.timezone || 'UTC');
  if (ms == null) return false;
  return ms >= nowMs - LOOKBACK_MS && ms <= nowMs + LOOKAHEAD_MS;
}

async function main({ dryRun }) {
  const nowMs = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // 1. Compute the in-band, bot-managed subset straight from the files. No
  //    maintained list — this recomputes every run, so entries enter and leave
  //    the window on their own as time passes and new venues are imported.
  const candidates = [];
  for (const f of listWorkshopFiles()) {
    const { raw } = readWorkshopFile(f);
    if (isImminentBotManaged(raw, nowMs)) candidates.push({ path: f, raw });
  }
  console.log(`Imminent bot-managed deadlines in band [-7d, +14d]: ${candidates.length}`);

  // 2. Re-check each against OpenReview by its stored venue id (one direct
  //    lookup apiece — no enumeration) and apply later-only, plausible moves.
  //    Factored out of the loop so the retry pass below re-runs the WHOLE check,
  //    not just the fetch: a group recovered on the second attempt has to be able
  //    to apply its extension, or the retry only quiets the warning.
  let checked = 0;
  let updated = 0;
  const changes = [];
  const checkOne = async ({ path: fp, raw }) => {
    const g = await fetchGroupById(raw.openreview_venue_id);
    if (!g) return false; // recorded as unverified when it was a failed lookup
    // Same value precedence as the weekly sync: the group's free `date` line
    // first, then the submission invitation's machine-readable duedate.
    const fetched = parseGroupDeadline(val(g.content ?? {}, 'date')) || (await deadlineFromInvitation(g));
    // Two-stage venues also publish a mandatory abstract-registration date on
    // the same line. It is informational (never the headline), so it is synced
    // whenever it moves — independently of whether the paper deadline moved.
    // Only trust the date line to set OR clear this: if the line is absent we have
    // no opinion, and must not wipe a value we already hold.
    const dateLine = val(g.content ?? {}, 'date');
    const lineHasDeadline = parseGroupDeadline(dateLine) != null;
    const nextAbstract = lineHasDeadline
      ? meaningfulAbstractDeadline(
          parseGroupAbstractDeadline(dateLine)?.submission_deadline ?? null,
          (fetched ?? {}).submission_deadline ?? raw.submission_deadline,
        )
      : (raw.abstract_deadline ?? null);
    const abstractChanged = (nextAbstract ?? null) !== (raw.abstract_deadline ?? null);
    const storedMs = resolveDeadlineUtcMs(raw.submission_deadline, raw.timezone || 'UTC');
    const fetchedMs = fetched ? resolveDeadlineUtcMs(fetched.submission_deadline, fetched.timezone || 'UTC') : null;
    const fetchedYear = fetched ? Number(String(fetched.submission_deadline).slice(0, 4)) : null;
    const plausible =
      fetchedMs != null &&
      fetchedMs - Date.now() <= TWO_YEARS_MS &&
      fetchedYear != null && Math.abs(fetchedYear - raw.year) <= 1;
    const decision = plausible
      ? decideDeadlineUpdate(storedMs, fetchedMs, { allowEarlier: ALLOW_EARLIER })
      : { update: false, reason: 'implausible' };
    if (decision.update || abstractChanged) {
      const from = raw.submission_deadline;
      if (decision.update) {
        // Log the observation before overwriting, so the outgoing value is still
        // readable for seeding. This is the busiest deadline-write path in the
        // repo — most extensions land here, not in the weekly sync.
        recordDeadlineObservation(raw, fetched.submission_deadline, today, fetched.timezone);
        raw.submission_deadline = fetched.submission_deadline;
        raw.timezone = fetched.timezone;
        raw.deadline_notes = syncNote(fetched.submission_deadline, today);
      }
      if (abstractChanged) {
        if (nextAbstract) raw.abstract_deadline = nextAbstract;
        else delete raw.abstract_deadline;
      }
      if (!dryRun) fs.writeFileSync(fp, yaml.dump(raw, { lineWidth: 200, quotingType: '"' }));
      updated++;
      if (decision.update) {
        changes.push(`${raw.conference} ${raw.year} · ${path.basename(fp)}: ${from} UTC -> ${fetched.submission_deadline} UTC (${decision.reason})`);
      }
      if (abstractChanged) {
        changes.push(`${raw.conference} ${raw.year} · ${path.basename(fp)}: abstract registration -> ${nextAbstract} UTC`);
      }
    } else if (!plausible && fetched) {
      console.warn(`  ⚠ ${path.basename(fp)}: OpenReview deadline "${fetched.submission_deadline}" looks implausible — left unchanged`);
    }
    return true;
  };

  for (const c of candidates) {
    checked++;
    await checkOne(c);
  }

  // 3. Second pass over whatever could not be reached. By now the rate budget has
  //    recovered, so a lookup that was throttled mid-run usually settles here —
  //    the same reasoning as discovery's second pass, which until now was the only
  //    job in the repo that had one. Whatever survives is NAMED: a run that
  //    silently checked 147 of 184 entries reads exactly like one that checked all
  //    of them.
  const byVenue = new Map(candidates.map((c) => [c.raw.openreview_venue_id, c]));
  // A failure can be recorded against either the venue group or its submission
  // invitation (`<venue>/-/Submission`), depending on which lookup died. Both
  // name the same entry, so resolve back to the venue before retrying.
  const ownerOf = (id) => byVenue.get(id) ?? byVenue.get(String(id).split('/-/')[0]);
  const missed = await retryUnverified(async (id) => {
    const c = ownerOf(id);
    return c ? checkOne(c) : false;
  });

  // Record each change so the workflow can fold it into the commit message,
  // exactly like the weekly discovery run (no silent edits).
  if (changes.length && process.env.DEADLINE_CHANGELOG) {
    fs.appendFileSync(process.env.DEADLINE_CHANGELOG, changes.map((c) => `- ${c}`).join('\n') + '\n');
  }
  console.log(
    `Re-checked ${checked} imminent deadline(s) — ${updated} extension(s) applied` +
      `${missed.length ? `, ${missed.length} UNVERIFIED` : ''}.`,
  );
  for (const c of changes) console.log(`    ↳ ${c}`);
  writeUnverified(
    missed.map((m) => ({ ...m, conf: ownerOf(m.id)?.raw.conference, year: ownerOf(m.id)?.raw.year })),
  );
}

// Only run the CLI when invoked directly, so the exported predicate
// (isImminentBotManaged) and fetchGroupById can be imported in tests without
// the module parsing argv and hitting the network.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  main({ dryRun }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
