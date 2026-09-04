#!/usr/bin/env node
/**
 * Cross-checks OpenReview-backed deadlines against the live submission
 * invitation `duedate` and surfaces the ones a human should look at — the cases
 * the weekly auto-sync deliberately will NOT fix on its own:
 *
 *   1. human-conflict — a deadline a human curated (its note is no longer the
 *      bot's stamp) that now disagrees with OpenReview. The bot freezes such
 *      entries, so without this they diverge silently. Maintainer decides which
 *      to trust.
 *   2. bot-earlier   — a bot-managed deadline where OpenReview moved EARLIER.
 *      The sync is later-only (an earlier move is the dangerous direction, e.g.
 *      a transient bad read), so it's declined and never applied automatically.
 *      Maintainer confirms whether it's a real correction.
 *
 * Bot-managed later moves are applied automatically by the sync (not flagged),
 * and legacy "imported from OpenReview…" entries are skipped (discovery adopts
 * then syncs them) — so neither is fetched here, keeping call volume down.
 *
 * `--report <file>` writes a markdown summary for the daily `deadline-review`
 * workflow to keep ONE self-maintaining issue up to date (empty report => the
 * workflow closes the issue). Network-tolerant: a venue whose duedate can't be
 * fetched (404 / 429 / down) never fails the run — but it is retried once after
 * the rate budget recovers and then NAMED, in the log and in the issue. It used
 * to be counted instead, and a run reporting "147 checked, 37 unfetchable" read
 * exactly like one that had checked all 184.
 *
 * Usage:
 *   node scripts/deadline_crosscheck.mjs --recent                      # upcoming + recently-passed only
 *   node scripts/deadline_crosscheck.mjs --recent --report review.md   # + write the issue body
 *   node scripts/deadline_crosscheck.mjs --slug colm-2026-daih         # one workshop
 *   node scripts/deadline_crosscheck.mjs --strict                      # exit 1 if anything to review
 */
import fs from 'node:fs';
import { listWorkshopFiles, readWorkshopFile, loadConferences, stripVenueFromName, normalizeAcronym, isNotRunning } from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs } from '../lib/dates.mjs';
import { isAcronymShaped } from '../lib/identity.mjs';
import {
  deadlineFromInvitation,
  parseGroupDeadline,
  msToDeadline,
  websiteFromContent,
  normalizeWebsite,
  syncedValue,
  LEGACY_IMPORT_NOTE,
} from './discover_openreview.mjs';
import { fetchGroupById } from './recheck_imminent.mjs';
import { CONF_TEMPLATE, DEADLINE_LOOKBACK_MS } from './discover_openreview.mjs';
import { unwrap, openreviewFetch, recordUnverified, writeUnverified, getUnverified, clearUnverified } from '../lib/openreview.mjs';

// OpenReview wraps some content values as { value: … }; unwrap if so.
const val = (c, k) => unwrap(c?.[k]);

const HOUR = 3_600_000;
const DAY = 86_400_000;
// Real UTC offsets are whole hours plus a handful of :30/:45 zones; AoE is -12h.
const OFFSET_STEPS_MIN = [60, 30, 15]; // whole, half, quarter hour
const NEAR_MS = 90_000;                // 90s tolerance for "lands on" an offset
const MAX_OFFSET_H = 14;               // largest real-world tz magnitude
// Pacing is lib/openreview.mjs's job: it spends the budget OpenReview advertises
// on every response instead of guessing at a flat delay. A fixed sleep on top of
// that only slows a run that has room, and guessing is what let 24 listing
// requests go out inside 6 seconds against a ceiling of 20 per 60.
const REVIEW_PAST_GRACE_MS = 14 * DAY; // keep reviewing a deadline until ~2 weeks past it
/**
 * How far past a deadline is still worth FETCHING, which is wider than how far
 * is worth reviewing.
 *
 * Since the syncs stopped auto-extending a long-closed deadline, a declined move
 * is a thing a human needs to see: OpenReview says the workshop is open until X
 * while the site shows it closed. That decline happens at whatever distance the
 * organiser reused the invitation — 30 or 60 days out, not 14 — so the entry has
 * to be looked at long after it leaves the review window.
 *
 * The two windows stay separate on purpose. Widening REVIEW_PAST_GRACE_MS itself
 * would drag every other category back in with it, and the issue would refill
 * with the months-old human-conflicts that window was added to keep out. So
 * entries between the two windows are fetched but only ever evaluated for the
 * one category that can still matter, and that category is itself gated on
 * OpenReview's value still being in the future.
 */
const FETCH_PAST_GRACE_MS = 90 * DAY;


const UA = 'ai-workshop-tracker/1.0 (open-source workshop aggregator; github)';

/** Submission-invitation duedates for many venues in a handful of requests.
 *  The listing above answers any venue whose free `date` line carries a
 *  "Submission Deadline:", but most venues leave that line empty (136 of 187
 *  entries on 2026-08-04), and those need their invitation — which is where the
 *  per-entry requests, and the throttling, actually came from. OpenReview
 *  accepts a comma-separated `ids=` list, so they go out ~40 at a time.
 *  Returns { duedates, complete }: when `complete` is true every chunk was
 *  answered, so an id missing from the map genuinely has no submission
 *  invitation (or no duedate) and needs no follow-up request. */
async function fetchSubmissionDuedates(invitationIds) {
  const duedates = new Map();
  const CHUNK = 40; // ~2.5 KB of URL per request at this size
  let complete = true;
  for (let i = 0; i < invitationIds.length; i += CHUNK) {
    const chunk = invitationIds.slice(i, i + CHUNK);
    const url = `https://api2.openreview.net/invitations?ids=${encodeURIComponent(chunk.join(','))}&expired=true`;
    const MAX = 3;
    let ok = false;
    for (let attempt = 0; attempt < MAX; attempt++) {
      try {
        if (attempt) await new Promise((r) => setTimeout(r, attempt * attempt * 1000));
        const res = await openreviewFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (res.status === 429 || res.status >= 500) {
          if (attempt < MAX - 1) continue;
          throw new Error(`rate-limited (HTTP ${res.status}) after ${MAX} attempts`);
        }
        if (!res.ok) break; // genuine miss for this batch; fall through as incomplete
        const body = await res.json();
        for (const inv of body.invitations ?? []) {
          if (inv?.id && inv?.duedate) duedates.set(inv.id, inv.duedate);
        }
        ok = true;
        break;
      } catch (err) {
        if (attempt < MAX - 1) continue;
        for (const id of chunk) recordUnverified(id, `duedate batch: ${err.message}`);
        console.warn(`  ⚠ duedate batch failed (${chunk.length} venue(s)): ${err.message}`);
      }
    }
    if (!ok) complete = false;
  }
  return { duedates, complete };
}
/** The conference-year listing a venue belongs to: everything up to its last
 *  path segment, e.g. "NeurIPS.cc/2026/Workshop/ASCI" -> "NeurIPS.cc/2026/Workshop/". */
export function venuePrefix(venueId) {
  const id = String(venueId || '');
  const i = id.lastIndexOf('/');
  return i > 0 ? id.slice(0, i + 1) : null;
}

/** Every venue group under one conference-year prefix, in a SINGLE request.
 *  OpenReview returns each venue WITH its `content` (including the free `date`
 *  line this job needs), and only the venues themselves — not their Authors /
 *  Reviewers / Submission children — so ~100 venues come back per call and the
 *  1000 limit is never approached. `count` is checked anyway: if the server ever
 *  does truncate, the caller falls back to single lookups for what is missing
 *  rather than silently treating those venues as unfetchable. */
async function fetchVenueGroupsByPrefix(prefix) {
  const url = `https://api2.openreview.net/groups?prefix=${encodeURIComponent(prefix)}&limit=1000`;
  const MAX = 3;
  for (let attempt = 0; attempt < MAX; attempt++) {
    try {
      if (attempt) await new Promise((r) => setTimeout(r, attempt * attempt * 1000)); // escalating backoff
      const res = await openreviewFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX - 1) continue;
        throw new Error(`rate-limited (HTTP ${res.status}) after ${MAX} attempts`);
      }
      if (!res.ok) return null;
      const body = await res.json();
      const groups = body.groups ?? [];
      if (typeof body.count === 'number' && body.count > groups.length) {
        console.warn(`  ⚠ ${prefix}: listing returned ${groups.length} of ${body.count} — remainder falls back to single lookups`);
      }
      return groups;
    } catch (err) {
      if (attempt < MAX - 1) continue;
      // A dead listing takes a whole conference-year's venues with it, which is
      // how a fifth of the review scope used to vanish from one 429.
      recordUnverified(prefix, `venue listing: ${err.message}`);
      console.warn(`  ⚠ venue listing failed for ${prefix}: ${err.message}`);
      return null;
    }
  }
  return null;
}

/**
 * Classify the gap between a stored deadline and OpenReview's duedate (both UTC
 * ms). Pure + exported for tests. Returns { kind, diffMs, label }.
 *   kind ∈ { 'match', 'tz-suspect', 'changed', 'unknown' }
 */
export function classifyDeadlineDiff(storedMs, fetchedMs) {
  if (storedMs == null || fetchedMs == null) return { kind: 'unknown', diffMs: null, label: 'missing value' };
  const diff = fetchedMs - storedMs; // +ve => OpenReview is later than stored
  const abs = Math.abs(diff);
  if (abs <= NEAR_MS) return { kind: 'match', diffMs: diff, label: 'matches OpenReview' };
  // A near-multiple of 24h is a day-level shift (extension), not a tz slip.
  const dayRem = Math.abs(abs - Math.round(abs / DAY) * DAY);
  const isDayish = abs >= DAY - NEAR_MS && dayRem <= NEAR_MS;
  if (!isDayish) {
    for (const stepMin of OFFSET_STEPS_MIN) {
      const step = stepMin * 60_000;
      const k = Math.round(abs / step);
      if (k >= 1 && Math.abs(abs - k * step) <= NEAR_MS && k * step <= MAX_OFFSET_H * HOUR) {
        const h = (k * stepMin) / 60;
        const dir = diff > 0 ? 'stored is EARLIER than OpenReview' : 'stored is LATER than OpenReview';
        return { kind: 'tz-suspect', diffMs: diff, label: `off by ~${h}h (${dir})` };
      }
    }
  }
  return { kind: 'changed', diffMs: diff, label: `differs by ${(diff / DAY).toFixed(2)}d (likely a real change)` };
}

/**
 * Decide whether a divergence needs human review, using the same provenance
 * rule the bot uses. Pure + exported for tests. Returns null (no review) or
 * { kind: 'human-conflict' | 'bot-earlier', diff }.
 */
export function reviewCategory({ notes, storedValue, storedMs, fetchedMs, nowMs = Date.now() }) {
  if (storedMs == null || fetchedMs == null) return null;
  const diff = classifyDeadlineDiff(storedMs, fetchedMs);
  if (diff.kind === 'match') return null;
  if (notes === LEGACY_IMPORT_NOTE) return null;          // in transition: discovery adopts, then syncs
  const botManaged = syncedValue(notes) === storedValue;  // stamp still equals the stored value
  if (botManaged) {
    // An earlier move is declined by the later-only rule and needs a human eye.
    if (fetchedMs < storedMs) return { kind: 'bot-earlier', diff };
    // A later move onto a deadline that closed over a week ago is declined too,
    // and that decline used to be invisible: this branch returned null on the
    // assumption that every later move gets auto-applied, which stopped being
    // true when the look-back was added.
    //
    // Reported only while OpenReview's value is still in the FUTURE, because
    // that is the whole harm — we show a workshop as closed while OpenReview
    // says it is open, and a reader could still be submitting to it. Once the
    // fetched date is past too, nobody can act either way and it is noise.
    if (nowMs - storedMs > DEADLINE_LOOKBACK_MS && fetchedMs > nowMs) {
      return { kind: 'bot-long-closed', diff };
    }
    return null;
  }
  // Not legacy and not a matching bot stamp => a human curated this deadline.
  return { kind: 'human-conflict', diff };
}

/**
 * Does this venue still need its own invitation lookup, given the batched
 * prefetch?
 *
 * The batch answers for the ids it was ASKED about: for one of those, absence
 * from the map really does mean "no submission invitation, or no duedate", and
 * costs no request. For anything else absence proves nothing — and the entries
 * that reach the per-entry fallback are exactly the ones the prefix listing
 * could not answer, so their invitation ids were never in the batch at all.
 * Treating those two cases alike is how a throttled conference-year listing
 * turned into ~37 entries a week silently filed as "nothing to compare": the
 * fallback fetched the group, found no `date` line, missed in a map that had
 * never been asked, and skipped. Pure + exported for tests.
 */
export function needsDirectLookup(invId, duedates, complete, requested) {
  if (duedates.has(invId)) return false;
  return !complete || !requested.has(invId);
}

/**
 * Is a deadline still worth a human's review — i.e. upcoming, or only recently
 * passed (within `graceMs`)? Once a deadline is comfortably behind us, a
 * disagreement with OpenReview is unactionable noise — nobody re-syncs a
 * workshop whose submission window closed months ago — so it's dropped from the
 * review scope (neither fetched nor listed). Pure + exported for tests.
 */
export function isWithinReviewWindow(deadlineMs, nowMs, graceMs = REVIEW_PAST_GRACE_MS) {
  return deadlineMs != null && deadlineMs >= nowMs - graceMs;
}


/** Text of a venue name/title, reduced to what actually identifies it: case,
 *  punctuation, the conference token and the year are all dropped, because we
 *  render those separately and they differ by convention rather than substance
 *  ("2nd AI for Math Workshop" vs "2nd AI for Math Workshop @ ICML 2025"). */
export function normalizeVenueText(text, conference = '') {
  let n = String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  n = n.replace(/\b(neurips|nips|iclr|icml|eccv|cvpr|iccv|iros|icra|corl|colm)\b/g, ' ');
  if (conference) n = n.replace(new RegExp(`\\b${String(conference).toLowerCase()}\\b`, 'g'), ' ');
  // Also drop short year fragments ("at NeurIPS'24" -> "24") and the connectors
  // that survive them, so a title differing only by a venue suffix reads as equal.
  n = n.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\b\d{2}\b/g, ' ');
  n = n.replace(/\b(at|the|of|on|for|and|in|a|an)\b/g, ' ');
  return n.replace(/\s+/g, ' ').trim();
}

/** A renamed workshop. Measured across the whole dataset this fires on 0.3% of
 *  entries, so it is quiet enough to be worth a human's attention every week —
 *  MPLR-FM was retitled to "Privacy in the Era of Large Opaque Models" and only
 *  came to light because its website moved at the same time. */
export function titleDrift(storedName, openreviewTitle, conference = '', acked = null, venue = null) {
  // Both sides through the importer's rules before diffing. upstreamIdentity()
  // already cleans OpenReview's; a STORED value written before those rules
  // existed ("ICLR 2025 Workshop on X") is not a rename either.
  const a = normalizeVenueText(venue ? stripVenueFromName(storedName, venue) : storedName, conference);
  const b = normalizeVenueText(openreviewTitle, conference);
  if (!a || !b || a === b) return null;
  // Already reviewed and declined? Stay quiet only while OpenReview still says
  // the same thing. The acknowledgement records the VALUE that was rejected, not
  // a blanket "ignore this entry", so a later, different rename is reported again.
  // The acknowledgement records what OpenReview said when the call was made,
  // raw. Normalise it the same way, or cleaning the upstream side silently
  // invalidates every ack ever recorded.
  if (acked && normalizeVenueText(venue ? stripVenueFromName(acked, venue) : acked, conference) === b) return null;
  return { stored: storedName, openreview: openreviewTitle };
}

/** A changed acronym. OpenReview's `subtitle` is only sometimes an acronym — it
 *  is often a full descriptive phrase ("CVPR 2024 Workshop Prompting in Vision"),
 *  and comparing against those produced a 4.9% false-positive rate. So this only
 *  compares when the subtitle is acronym-shaped, which cuts it to zero across the
 *  dataset while still catching a real rename (MPLR-FM -> PriLOM). */
export function acronymDrift(storedAcronym, openreviewSubtitle, acked = null, venue = null) {
  const sub = String(openreviewSubtitle ?? '').trim();
  // The shape test lives in lib/identity.mjs, which the digest renderer and the
  // /changes/ page also call. One definition: two copies drift, and then the
  // reviewer and the renderer disagree about what counts as an acronym.
  if (!storedAcronym || !isAcronymShaped(sub)) return null;
  // Same rules on the stored side: "CVPR 2025 Workshop PVUW" and "PVUW" are one
  // acronym written two ways, not a rename — that shape alone accounted for ~150
  // rows. Case is folded, because upstream flattens it ("ICARE" for "iCARE") and
  // ours is the better value of the two.
  const pre = (x) => (venue ? normalizeAcronym(x, venue) : x);
  const norm = (x) => String(pre(x) ?? '').split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '');
  const a = norm(storedAcronym);
  const b = norm(sub);
  if (!a || !b || a === b) return null;
  if (acked && norm(acked) === b) return null; // reviewed and declined, and unchanged since
  return { stored: storedAcronym, openreview: sub };
}

/**
 * What the importer would store for this venue today — the same
 * stripVenueFromName()/cleanAcronym() pass that discover_openreview.mjs and
 * issue_to_yaml.mjs run before anything reaches YAML.
 *
 * The review has to compare and suggest THIS, never OpenReview's raw strings.
 * Upstream titles routinely lead with the conference and year, and the
 * `subtitle` is frequently just the venue — so a maintainer accepting a
 * suggestion verbatim would paste back exactly what the import path exists to
 * strip, and acronym_identity_test.mjs would then fail on the next push. The
 * automation would be fighting itself.
 */
export function upstreamIdentity(content, { conference, year }, conferences = loadConferences()) {
  const cm = conferences.find((x) => x.id === conference) ?? {};
  const venue = { confName: cm.name ?? conference, confFullName: cm.full_name, year };
  const title = String(val(content, 'title') ?? '').trim();
  return {
    name: title ? stripVenueFromName(title, venue) : '',
    acronym: normalizeAcronym(val(content, 'subtitle') ?? '', { ...venue, conf: conference }),
  };
}

/** A website worth reviewing: both sides have one and they genuinely differ.
 *  Reported, never applied — the importer fills a blank `website` and then leaves
 *  it alone, which protects a hand-picked URL but also means one that goes stale
 *  stays stale (IROS BEMHAT's stored site had been unpublished and redirected to
 *  a Google sign-in page). A human decides; ours is sometimes the better link. */
/**
 * After adopting a value from a conference's OFFICIAL list, what (if anything)
 * must be recorded as declined so this report stays quiet?
 *
 * Taking the official list's value implicitly declines OpenReview's, and this
 * cross-check has no way to know that — it would open a fresh rename/website row
 * the next morning for a decision that was just made deliberately. Expressed
 * here, in terms of the very drift rules that would fire, so the ack written by
 * scripts/apply_official_list.mjs is precisely the one that silences them; a
 * second implementation of "does this count as drift" would eventually disagree
 * with the report it exists to quiet.
 *
 * @returns the upstream value to record in `review_ack[field]`, or null.
 */
export function declinedUpstreamValue(record, field, upstream) {
  if (!record?.openreview_venue_id || !upstream) return null;
  const drift =
    field === 'name'
      ? titleDrift(record.name, upstream, record.conference, record.review_ack?.name)
      : websiteDrift(record.website, upstream, record.review_ack?.website);
  return drift ? upstream : null;
}

export function websiteDrift(stored, openreview, acked = null) {
  const a = normalizeWebsite(stored);
  const b = normalizeWebsite(openreview);
  if (!a || !b || a === b) return null;
  if (acked && normalizeWebsite(acked) === b) return null; // reviewed and declined, and unchanged since
  return { stored, openreview };
}

/**
 * A stored deadline that was extended after it had already closed.
 *
 * Both syncs now decline such a move, but four were applied before that rule
 * existed and are still on the board — and they cannot surface as a normal
 * review item, because the stored value and OpenReview AGREE. They agree on the
 * wrong thing: OpenReview's `Submission` invitation gets reused once submissions
 * close (camera-ready, revisions, a competition track), its `duedate` jumps
 * forward, and the bot followed it.
 *
 * Read from `deadline_history`, which records what was written and when, so this
 * needs no network and reports only moves that actually happened. The tell is
 * the outgoing value's age at the moment it was replaced, not the size of the
 * jump: a workshop really does extend by three weeks, but not three weeks after
 * it closed. Pure + exported for tests.
 */
export function lateResurrection(raw, lookbackMs = DEADLINE_LOOKBACK_MS) {
  const hist = Array.isArray(raw?.deadline_history) ? raw.deadline_history : [];
  if (hist.length < 2) return null;
  // Only bot-managed entries: once a human curates the value it is their call,
  // and the freeze means no sync will touch it again anyway.
  if (syncedValue(raw.deadline_notes) !== raw.submission_deadline) return null;
  // Only the move that produced the value we are SHOWING. Walking further back
  // would re-report a bad move that has since been undone — LifeGenIP carries
  // exactly that in its history, and it is correct today.
  const cur = hist[hist.length - 1];
  const prev = hist[hist.length - 2];
  if (cur.value !== raw.submission_deadline) return null;
  const prevMs = resolveDeadlineUtcMs(prev.value, prev.timezone || 'UTC');
  const curMs = resolveDeadlineUtcMs(cur.value, cur.timezone || 'UTC');
  const appliedMs = Date.parse(`${cur.recorded}T00:00:00Z`);
  if (prevMs == null || curMs == null || !Number.isFinite(appliedMs)) return null;
  if (curMs <= prevMs) return null; // an earlier move is the review's other category
  const closedForMs = appliedMs - prevMs;
  if (closedForMs <= lookbackMs) return null;
  return { from: prev.value, to: cur.value, on: cur.recorded, closedForDays: Math.round(closedForMs / 86_400_000) };
}

// The TLDs a workshop's own OpenReview namespace is registered under. `.org`,
// `.cc` and `.com` are the three present in the corpus (conferences included:
// `IEEE.org`, `NeurIPS.cc`, `thecvf.com`); `.ai` and `.io` are the other two
// domains ML workshops routinely own. Ordered by how often they turn up, since
// each one costs the caller a live group fetch.
const OWN_NS_TLDS = ['org', 'cc', 'com', 'ai', 'io'];
const OWN_NS_TLD_RE = new RegExp(`\\.(?:${OWN_NS_TLDS.join('|')})$`, 'i');

/**
 * Where a venue may have moved to.
 *
 * OpenReview registers a workshop either under its conference
 * (`NeurIPS.cc/2026/Workshop/ML4PS`) or in the workshop's own namespace
 * (`ML4PS/2026/Workshop`), and organisers move between the two mid-season —
 * ML4PS was imported from the NeurIPS listing on 2026-08-23 and had left it by
 * the 28th, leaving a link on the site that OpenReview answers with an empty
 * page. The own namespace is written either bare (`ML4PS`) or, far more often,
 * as the domain the organisers own (`UniReps.org`, `robot-learning.org`,
 * `colmweb.org`) — mirroring the conferences' own `NeurIPS.cc` / `IEEE.org` —
 * so both forms are proposed in each direction. Those two conventions are the
 * only places worth looking, so this proposes ids rather than searching; the
 * caller offers one only when the group actually exists AND its title still
 * matches ours, which makes the suggestion a checked fact rather than a guess.
 * Pure + exported for tests.
 */
export function siblingVenueCandidates(venueId, { acronym, year } = {}) {
  const id = String(venueId || '');
  if (!id) return [];
  const parts = id.split('/');
  const yr = String(year || parts.find((p) => /^(19|20)\d{2}$/.test(p)) || '');
  if (!yr) return [];
  const out = new Set();
  // Conference namespace -> the workshop's own, keyed on the id's own tail and
  // on the stored acronym (they differ often enough to be worth both).
  const tails = [parts[parts.length - 1], acronym]
    .map((t) => String(t ?? '').trim().split('@')[0].trim())
    .filter((t) => t && /^[\w.-]+$/.test(t));
  const ownNamespace = /^[\w.-]+\/(19|20)\d{2}\/Workshop$/.test(id);
  for (const t of tails) {
    // Bare first, then the domain forms. A group that owns its namespace
    // usually registers it as its own domain, exactly as the conferences do:
    // across the corpus every own-namespace but ML4PS is a host —
    // `robot-learning.org`, `colmweb.org`, `UniReps.org` — so proposing only
    // the bare tail misses the common case and reports "no replacement found"
    // for a workshop that simply moved (UniReps 2026, 2026-09-04).
    if (!ownNamespace) {
      out.add(`${t}/${yr}/Workshop`);
      for (const tld of OWN_NS_TLDS) out.add(`${t}.${tld}/${yr}/Workshop`);
    }
  }
  // ...and back the other way, for a venue that moved INTO a conference. The
  // conference namespace keys on the bare acronym, so a domain-style namespace
  // has to shed its TLD to form the leaf (`UniReps.org` -> `UniReps`).
  if (ownNamespace) {
    const leaves = [parts[0], parts[0].replace(OWN_NS_TLD_RE, '')].filter(Boolean);
    for (const [, tmpl] of Object.entries(CONF_TEMPLATE)) {
      for (const leaf of leaves) out.add(`${tmpl.replace('{year}', yr)}/${leaf}`);
    }
  }
  out.delete(id);
  return [...out];
}

/**
 * Confirm where a dead venue moved to, or return null.
 *
 * Only ever returns an id whose group EXISTS and whose title still reduces to
 * ours under the same normalisation the rename check uses — so a maintainer can
 * paste it in without re-verifying, and a same-acronym workshop from a different
 * series is never proposed.
 */
async function findMovedVenue(raw) {
  const candidates = siblingVenueCandidates(raw.openreview_venue_id, { acronym: raw.acronym, year: raw.year });
  const ours = normalizeVenueText(raw.name, raw.conference);
  for (const id of candidates) {
    const g = await fetchGroupById(id);
    if (!g) continue;
    const title = val(g.content ?? {}, 'title');
    if (title && normalizeVenueText(title, raw.conference) === ours) return id;
  }
  return null;
}

export function buildReport(items, drift = [], renames = [], unchecked = [], dead = [], resurrected = []) {
  // `unchecked` deliberately does NOT keep the report alive: it is a statement
  // about the run, not a review item, and letting it do so would stop the issue
  // from ever auto-closing on a throttled day.
  if (!items.length && !drift.length && !renames.length && !dead.length && !resurrected.length) return '';
  const human = items.filter((i) => i.kind === 'human-conflict');
  const earlier = items.filter((i) => i.kind === 'bot-earlier');
  const stillOpen = items.filter((i) => i.kind === 'bot-long-closed');
  const line = (i) =>
    `- [ ] \`${i.file}\` — **${i.name}** (${i.conf} ${i.year}) — stored \`${i.stored} UTC\`, OpenReview \`${i.fetched} UTC\` — ${i.label}. ` +
    `Accept OpenReview: \`node scripts/resync_deadline.mjs --slug ${i.slug}\``;
  const out = [
    'These entries disagree with OpenReview and the bot will **not** change them on its own — they need your call.',
    'To accept OpenReview\'s deadline, run the **Re-sync deadline from OpenReview** workflow with the slug (or the command shown). To keep the stored value, just leave it.',
    '',
  ];
  if (human.length) {
    out.push('### Human-edited, now disagrees with OpenReview', '_You edited these, so auto-sync is frozen. Decide which to trust._', '');
    for (const i of human) out.push(line(i));
    out.push('');
  }
  if (stillOpen.length) {
    out.push(
      '### OpenReview says these are still open — we show them as closed',
      '_The deadline had been closed for over a week when OpenReview moved it later, so neither sync applied it: that pattern is usually a reused `Submission` invitation (camera-ready, revisions, a competition track) rather than a real extension. But if it IS a real extension, the site is telling people a workshop is shut when they could still submit — so you decide. Only listed while OpenReview\'s date is still in the future._',
      '',
    );
    for (const i of stillOpen) out.push(line(i));
    out.push('');
  }
  if (earlier.length) {
    out.push('### OpenReview moved these *earlier*', '_The bot only moves deadlines later automatically (an earlier move can be a transient bad read). Confirm whether it\'s a real correction._', '');
    for (const i of earlier) out.push(line(i));
    out.push('');
  }
  if (drift.length) {
    out.push(
      '### Website changed on OpenReview',
      '_The importer only fills a **blank** `website` and never revisits it, so a URL that moves is not picked up. Check which is right — ours is sometimes the better link, but a stored URL can also go dead._',
      '',
    );
    for (const d of drift) {
      out.push(
        `- [ ] \`${d.file}\` — **${d.name}** (${d.conf} ${d.year})\n` +
        `      - ours: ${d.stored}\n` +
        `      - OpenReview: ${d.openreview}`,
      );
    }
    out.push('');
  }
  if (renames.length) {
    out.push(
      '### Renamed on OpenReview',
      '_The importer records a name and acronym once and never revisits them, so a workshop that renames itself keeps the old label here indefinitely. Update the entry if the new one is right — the slug and URL should stay as they are so existing links keep working._',
      '',
    );
    for (const r of renames) {
      out.push(
        `- [ ] \`${r.file}\` — ${r.field} (${r.conf} ${r.year})\n` +
        `      - ours: ${r.stored}\n` +
        `      - OpenReview: ${r.openreview}`,
      );
    }
    out.push('');
  }
  if (resurrected.length) {
    out.push(
      '### Extended after it had already closed',
      "_These were moved later by the bot when the deadline had been closed for over a week. Neither sync will do that any more, but the value is already stored — and it will never appear above, because OpenReview still agrees with it. OpenReview's `Submission` invitation is often reused after submissions close (camera-ready, revisions, a competition track), which moves its `duedate` forward. Check the workshop's own page: if ours is wrong, edit the entry — a hand-set deadline also freezes it against re-sync._",
      '',
    );
    for (const r of resurrected) {
      out.push(
        `- [ ] \`${r.file}\` — **${r.name}** (${r.conf} ${r.year}) — now \`${r.to} UTC\`, ` +
        `moved up from \`${r.from}\` on ${r.on}, ${r.closedForDays} days after it closed`,
      );
    }
    out.push('');
  }
  if (dead.length) {
    out.push(
      '### OpenReview venue no longer exists',
      '_The stored `openreview_venue_id` returns nothing. Organisers move a workshop between the conference namespace (`NeurIPS.cc/2026/Workshop/ML4PS`) and their own (`ML4PS/2026/Workshop`) mid-season, and the id we imported stops resolving. The site still links it, and the link checker cannot catch this — OpenReview answers `200` for a group that does not exist. Update the id in the entry._',
      '',
    );
    for (const d of dead) {
      out.push(
        `- [ ] \`${d.file}\` — **${d.name}** (${d.conf} ${d.year})\n` +
        `      - ours: \`${d.venueId}\` (gone)\n` +
        (d.moved
          ? `      - found at: \`${d.moved}\` — same title, verified live`
          : '      - no replacement found under the sibling naming convention; check the workshop website'),
      );
    }
    out.push('');
  }
  if (unchecked.length) {
    out.push(
      '### Could not be checked this run',
      '_A lookup for these did not complete, twice — OpenReview was throttling or down, so we do not know whether their deadlines still agree. They are listed rather than counted because a run reporting "147 checked, 37 unfetchable" reads exactly like one that checked all 184. Nothing is known to be wrong with the data, and the next run normally settles them. Venues that simply publish no deadline are not listed here._',
      '',
    );
    for (const u of unchecked) {
      out.push(`- \`${u.file}\` — **${u.name}** (${u.conf} ${u.year}) — \`${u.venueId}\` — ${u.reason}`);
    }
    out.push('');
  }
  out.push('_This issue is updated automatically by the daily `deadline-review` workflow._');
  return out.join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const recent = args.includes('--recent');
  const strict = args.includes('--strict');
  const slug = args.includes('--slug') ? args[args.indexOf('--slug') + 1] : null;
  const reportPath = args.includes('--report') ? args[args.indexOf('--report') + 1] : null;
  const nowMs = Date.now();

  // Identity checks (name/acronym/website) apply to every OpenReview-linked entry,
  // including ones with no deadline yet — a workshop can be renamed long before it
  // announces a date. The deadline review keeps its own, narrower scope below.
  const allEntries = listWorkshopFiles()
    .map(readWorkshopFile)
    .filter(({ raw }) => raw?.openreview_venue_id)
    // An edition a human recorded as not taking place is out of scope for every
    // section below. LOAD-BEARING: its OpenReview group stays live and open (a
    // rejected proposal's Submission invitation ticks down like any other), so
    // without this filter, marking an entry would move it off the board and
    // straight into this issue every single day, forever — worse than before.
    .filter(({ raw }) => !isNotRunning(raw));
  let entries = allEntries.filter(({ raw }) => raw?.submission_deadline);
  if (slug) entries = entries.filter((e) => e.slug === slug);
  // --recent scopes by *deadline relevance*, not conference year: a workshop
  // whose deadline is comfortably past (even if its year is the current one) is
  // not a review item, so it's neither fetched nor listed. Fixes the review
  // issue filling up with long-closed deadlines (e.g. CVPR/ICML deadlines that
  // passed months ago) and spares the weekly job a lookup per stale entry.
  else if (recent) {
    entries = entries.filter(({ raw }) =>
      isWithinReviewWindow(resolveDeadlineUtcMs(raw.submission_deadline, raw.timezone || 'UTC'), nowMs, FETCH_PAST_GRACE_MS));
  }
  // Inside the narrow window an entry is reviewed for everything; between the two
  // windows only `bot-long-closed` applies, since that is the one fact that can
  // still matter about a workshop this old.
  const fullReview = new Set(
    entries
      .filter(({ raw }) => isWithinReviewWindow(resolveDeadlineUtcMs(raw.submission_deadline, raw.timezone || 'UTC'), nowMs))
      .map((e) => e.slug),
  );
  // Legacy entries are in transition (discovery adopts then syncs them) and are
  // never review items — skip them so they cost no network call.
  const toCheck = entries.filter((e) => slug || e.raw.deadline_notes !== LEGACY_IMPORT_NOTE);

  console.log(`Cross-checking ${toCheck.length} deadline(s) against live OpenReview duedates (skipping ${entries.length - toCheck.length} legacy)…\n`);

  // Prefetch every venue in ONE listing request per conference-year, instead of
  // a group lookup per workshop. That turned ~190 requests into ~10: with the
  // per-workshop lookups, OpenReview throttled a slice of the run every week
  // (9 of 187 entries on 2026-08-04, 4 of 187 the run before), and a throttled
  // entry is skipped — which silently withheld real disagreements from review
  // for a week at a time. That is how the NeurReps Findings track went unseen
  // while its two sibling tracks were reported.
  // Deadline review is scoped to the window above, but a rename or a moved site
  // matters whenever it happens, so identity checks run over EVERY entry with a
  // venue. Listings are per conference-year, so covering the whole dataset costs
  // ~24 requests rather than one per entry.
  const conferenceList = loadConferences();
  const confMetaById = new Map(conferenceList.map((x) => [x.id, x]));
  const identityEntries = slug ? allEntries.filter((e) => e.slug === slug) : allEntries;
  const prefixes = [
    ...new Set(identityEntries.map((e) => venuePrefix(e.raw.openreview_venue_id)).filter(Boolean)),
  ];
  const groupById = new Map();
  for (const p of prefixes) {
    const gs = await fetchVenueGroupsByPrefix(p);
    for (const g of gs ?? []) groupById.set(g.id, g);
  }
  console.log(`Prefetched ${groupById.size} venue group(s) in ${prefixes.length} listing request(s).`);

  // Then the venues the listing can't answer: those whose `date` line carries no
  // "Submission Deadline:". Their invitation ids go out in batches of 40 rather
  // than one request each.
  const invitationIdOf = (g) => val(g.content ?? {}, 'submission_id') || `${g.id}/-/Submission`;
  const needInvitation = [
    ...new Set(
      toCheck
        .map((e) => groupById.get(e.raw.openreview_venue_id))
        .filter((g) => g && !parseGroupDeadline(val(g.content ?? {}, 'date')))
        .map(invitationIdOf),
    ),
  ];
  const { duedates, complete } = await fetchSubmissionDuedates(needInvitation);
  // What the batch actually asked about — the authority for reading a miss as
  // "this venue has no submission invitation".
  const requested = new Set(needInvitation);
  console.log(
    `Prefetched ${duedates.size} submission duedate(s) for ${needInvitation.length} venue(s) ` +
      `in ${Math.ceil(needInvitation.length / 40)} batched request(s).\n`,
  );

  const items = [];
  const drift = [];
  const renames = [];
  let checked = 0;
  const unchecked = [];
  for (const { slug: s, file, raw } of toCheck) {
    let dl = null;
    let group = null; // hoisted: the website check below needs it after the try
    try {
      // Same value precedence as every write path (discovery, recheck,
      // backfill): the group's free `date` line first, the submission
      // invitation's duedate only as a fallback. Reading the invitation alone
      // silently disagreed with what the syncs actually store on two-stage
      // venues, whose date line carries both
      //   "Abstract Registration: <early>, Submission Deadline: <later>"
      // while the invitation's duedate is the ABSTRACT date. That reported a
      // phantom "OpenReview moved this earlier" for every such workshop (ASCI,
      // AutoMLR, VERICODEGEN, EBMV) even though the stored paper deadline was
      // correct and in sync — pure review noise, and dangerous noise, since
      // "accept OpenReview" would have replaced a paper deadline with an
      // abstract-registration date.
      let g = groupById.get(raw.openreview_venue_id);
      if (!g) {
        // Not in the listing: a renamed/moved venue, or the listing itself was
        // throttled. One targeted lookup keeps this entry reviewable.
        g = await fetchGroupById(raw.openreview_venue_id);
      }
      group = g;
      if (g) {
        dl = parseGroupDeadline(val(g.content ?? {}, 'date'));
        if (!dl) {
          const invId = invitationIdOf(g);
          const due = duedates.get(invId);
          if (due) {
            dl = msToDeadline(due);
          } else if (needsDirectLookup(invId, duedates, complete, requested)) {
            // Either a batch was throttled, or this id was never in one because
            // its listing failed. Both make absence inconclusive — ask directly
            // rather than filing the venue as having nothing to compare.
            dl = await deadlineFromInvitation(g);
          }
          // else: this id WAS asked about and came back empty — the venue really
          // has no submission invitation (or no duedate). No request needed.
        }
      }
    } catch {
      dl = null; // network / rate-limit / no invitation: skip, never fail
    }
    if (!dl) {
      unchecked.push({
        slug: s, file, name: raw.name,
        conf: String(raw.conference || '').toUpperCase(), year: raw.year,
        venueId: raw.openreview_venue_id,
        reason: group ? 'submission invitation could not be read' : 'venue group could not be fetched',
      });
      continue;
    }
    checked++;
    const storedMs = resolveDeadlineUtcMs(raw.submission_deadline, raw.timezone || 'UTC');
    const fetchedMs = resolveDeadlineUtcMs(dl.submission_deadline, 'UTC');
    // A deadline reviewed and declined stays quiet while OpenReview still says the
    // same thing; a later, different value is reported again — same contract as the
    // identity acknowledgements. Compared as an instant, so 'YYYY-MM-DD HH:mm'
    // formatting differences never matter.
    const ackedDeadline = raw.review_ack?.submission_deadline;
    if (ackedDeadline && resolveDeadlineUtcMs(ackedDeadline, 'UTC') === fetchedMs) continue;

    const cat = reviewCategory({
      notes: raw.deadline_notes,
      storedValue: raw.submission_deadline,
      storedMs,
      fetchedMs,
      nowMs,
    });
    if (!cat) continue;
    if (!fullReview.has(s) && cat.kind !== 'bot-long-closed') continue;
    const item = {
      kind: cat.kind, slug: s, file,
      name: raw.name, conf: String(raw.conference || '').toUpperCase(), year: raw.year,
      stored: raw.submission_deadline, fetched: dl.submission_deadline, label: cat.diff.label,
    };
    items.push(item);
    const tag = { 'human-conflict': '⚠ CONFLICT  ', 'bot-earlier': '•  EARLIER   ' }[cat.kind] ?? '⚠ STILL OPEN';
    console.log(`${tag} ${s}: stored ${item.stored} vs OpenReview ${item.fetched} UTC — ${item.label}`);
  }

  // Second pass over whatever could not be reached. The rate budget has had the
  // whole main loop to recover, so a lookup throttled early usually settles here.
  // Discovery has had this since its first 429s; the review never did, which is
  // why a dead conference-year listing quietly cost a fifth of the scope.
  if (unchecked.length) {
    console.log(`\nSecond pass over ${unchecked.length} entry/entries that could not be read…`);
    // Only failures recorded from HERE decide what stays unchecked, so an entry
    // that failed in the main loop and settled on the retry is not still counted
    // against the run.
    clearUnverified();
    const stillUnchecked = [];
    for (const u of unchecked) {
      const entry = toCheck.find((e) => e.slug === u.slug);
      let dl = null;
      try {
        const g = await fetchGroupById(u.venueId);
        if (g) {
          dl = parseGroupDeadline(val(g.content ?? {}, 'date')) || (await deadlineFromInvitation(g));
        }
      } catch {
        dl = null;
      }
      if (!dl || !entry) { stillUnchecked.push(u); continue; }
      checked++;
      const raw = entry.raw;
      const storedMs = resolveDeadlineUtcMs(raw.submission_deadline, raw.timezone || 'UTC');
      const fetchedMs = resolveDeadlineUtcMs(dl.submission_deadline, 'UTC');
      const ackedDeadline = raw.review_ack?.submission_deadline;
      if (ackedDeadline && resolveDeadlineUtcMs(ackedDeadline, 'UTC') === fetchedMs) continue;
      const cat = reviewCategory({
        notes: raw.deadline_notes,
        storedValue: raw.submission_deadline,
        storedMs,
        fetchedMs,
        nowMs,
      });
      if (!cat) continue;
      if (!fullReview.has(u.slug) && cat.kind !== 'bot-long-closed') continue;
      const item = {
        kind: cat.kind, slug: u.slug, file: u.file,
        name: raw.name, conf: u.conf, year: u.year,
        stored: raw.submission_deadline, fetched: dl.submission_deadline, label: cat.diff.label,
      };
      items.push(item);
      const tag = { 'human-conflict': '⚠ CONFLICT  ', 'bot-earlier': '•  EARLIER   ' }[cat.kind] ?? '⚠ STILL OPEN';
      console.log(`${tag} ${u.slug}: stored ${item.stored} vs OpenReview ${item.fetched} UTC — ${item.label} (second pass)`);
    }
    // "Could not be verified" and "has nothing to say" are different facts, and
    // collapsing them is the same mistake that started this: a venue whose
    // lookups all COMPLETED and simply published no submission invitation is not
    // a blind spot, and listing it daily would train the reader to skip the
    // section — which is exactly how 37 silently-dropped entries stayed invisible
    // behind a number. Keep only entries where a lookup genuinely did not finish.
    const failed = new Set(getUnverified().flatMap((e) => [e.id, String(e.id).split('/-/')[0]]));
    const dropped = stillUnchecked.filter((u) => !failed.has(u.venueId));
    for (const u of dropped) {
      console.log(`    · ${u.slug}: OpenReview publishes no submission deadline for ${u.venueId} — nothing to compare`);
    }
    unchecked.length = 0;
    unchecked.push(...stillUnchecked.filter((u) => failed.has(u.venueId)));
  }

  // Identity pass. Normally no network at all — every group is cached above —
  // but a venue MISSING from the listing is not something to pass over in
  // silence. It is either a listing we failed to fetch or a venue that has
  // genuinely gone, and only a direct lookup tells them apart. Skipping both
  // alike is how ML4PS 2026 kept a dead `openreview_venue_id`: it was imported
  // from the NeurIPS listing on 2026-08-23, the organisers moved it to their own
  // namespace days later, and the site went on linking a group page OpenReview
  // answers with HTTP 200 and no content — so the monthly link check cannot see
  // it either, and nothing else ever re-reads a stored venue id.
  const deadVenues = [];
  const resurrected = [];
  for (const { raw, slug: s2, file: f2 } of identityEntries) {
    // Costs nothing and needs no group: it reads what we already wrote down.
    const lr = lateResurrection(raw);
    if (lr && resolveDeadlineUtcMs(raw.review_ack?.submission_deadline ?? null, 'UTC')
             !== resolveDeadlineUtcMs(raw.submission_deadline, raw.timezone || 'UTC')) {
      resurrected.push({
        slug: s2, file: f2, name: raw.name,
        conf: String(raw.conference || '').toUpperCase(), year: raw.year, ...lr,
      });
      console.log(`•  REOPENED  ${s2}: ${lr.from} -> ${lr.to} applied ${lr.closedForDays}d after it closed`);
    }
    let g = groupById.get(raw.openreview_venue_id);
    if (!g) {
      // Tell a lookup that never completed apart from one that found nothing by
      // whether THIS call added to the unverified list — not by clearing the
      // list, which would wipe every earlier failure in the run.
      const unverifiedBefore = getUnverified().length;
      g = await fetchGroupById(raw.openreview_venue_id);
      if (!g) {
        // A completed lookup that found nothing is a permanent fault; a lookup
        // that never completed is the transient case handled above.
        if (getUnverified().length > unverifiedBefore) continue;
        const meta = { slug: s2, file: f2, name: raw.name, conf: String(raw.conference || '').toUpperCase(), year: raw.year };
        const moved = await findMovedVenue(raw);
        deadVenues.push({ ...meta, venueId: raw.openreview_venue_id, moved });
        console.log(`•  GONE      ${s2}: ${raw.openreview_venue_id} no longer exists on OpenReview${moved ? ` — found at ${moved}` : ''}`);
        continue;
      }
    }
    const c = g.content ?? {};
    const meta = { slug: s2, file: f2, name: raw.name, conf: String(raw.conference || '').toUpperCase(), year: raw.year };
    const ack = raw.review_ack ?? {};
    const wd = websiteDrift(raw.website, websiteFromContent(c), ack.website);
    if (wd) { drift.push({ ...meta, ...wd }); console.log(`•  WEBSITE   ${s2}: ours ${wd.stored} vs OpenReview ${wd.openreview}`); }
    // The list is passed in: the default argument re-read and re-parsed
    // conferences.yml once per entry, ~940 times a run.
    const up = upstreamIdentity(c, raw, conferenceList);
    const cm = confMetaById.get(raw.conference) ?? {};
    const venueCtx = { confName: cm.name ?? raw.conference, confFullName: cm.full_name, year: raw.year, conf: raw.conference };
    const td = titleDrift(raw.name, up.name, raw.conference, ack.name, venueCtx);
    if (td) { renames.push({ ...meta, field: 'name', ...td }); console.log(`•  NAME      ${s2}: ours "${td.stored}" vs OpenReview "${td.openreview}"`); }
    const ad = acronymDrift(raw.acronym, up.acronym, ack.acronym, venueCtx);
    if (ad) { renames.push({ ...meta, field: 'acronym', ...ad }); console.log(`•  ACRONYM   ${s2}: ours "${ad.stored}" vs OpenReview "${ad.openreview}"`); }
  }

  const report = buildReport(items, drift, renames, unchecked, deadVenues, resurrected);
  if (reportPath) {
    fs.writeFileSync(reportPath, report);
    const parts = [];
    if (items.length) parts.push(`${items.length} deadline item(s)`);
    if (drift.length) parts.push(`${drift.length} website item(s)`);
    if (renames.length) parts.push(`${renames.length} rename item(s)`);
    if (deadVenues.length) parts.push(`${deadVenues.length} dead venue id(s)`);
    if (resurrected.length) parts.push(`${resurrected.length} reopened deadline(s)`);
    if (unchecked.length) parts.push(`${unchecked.length} unchecked note(s)`);
    console.log(`\nWrote ${parts.length ? parts.join(' + ') : 'empty report'} to ${reportPath}.`);
  }
  console.log(
    `\nDone. ${checked} checked, ${items.length} to review, ${unchecked.length} unchecked` +
      `${drift.length ? `, ${drift.length} website change(s)` : ''}` +
      `${deadVenues.length ? `, ${deadVenues.length} DEAD venue id(s)` : ''}` +
      `${resurrected.length ? `, ${resurrected.length} reopened after closing` : ''}.`,
  );
  writeUnverified(
    unchecked.map((u) => ({ id: `${u.slug} (${u.venueId})`, reason: u.reason, conf: u.conf, year: u.year })),
  );
  if (strict && items.length > 0) process.exit(1);
}

// Only run the CLI when invoked directly, so the pure helpers can be imported in
// tests without the module hitting the network.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
