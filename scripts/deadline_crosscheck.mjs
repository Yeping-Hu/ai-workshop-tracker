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
 * `--report <file>` writes a markdown summary for the weekly `deadline-review`
 * workflow to keep ONE self-maintaining issue up to date (empty report => the
 * workflow closes the issue). Network-tolerant: a venue whose duedate can't be
 * fetched (404 / 429 / down) is skipped, never failing the run.
 *
 * Usage:
 *   node scripts/deadline_crosscheck.mjs --recent                      # upcoming + recently-passed only
 *   node scripts/deadline_crosscheck.mjs --recent --report review.md   # + write the issue body
 *   node scripts/deadline_crosscheck.mjs --slug colm-2026-daih         # one workshop
 *   node scripts/deadline_crosscheck.mjs --strict                      # exit 1 if anything to review
 */
import fs from 'node:fs';
import { listWorkshopFiles, readWorkshopFile } from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs } from '../lib/dates.mjs';
import {
  deadlineFromInvitation,
  parseGroupDeadline,
  msToDeadline,
  websiteFromContent,
  syncedValue,
  LEGACY_IMPORT_NOTE,
} from './discover_openreview.mjs';
import { fetchGroupById } from './recheck_imminent.mjs';

// OpenReview wraps some content values as { value: … }; unwrap if so.
const val = (c, k) => {
  const x = c?.[k];
  return x && typeof x === 'object' && 'value' in x ? x.value : x;
};

const HOUR = 3_600_000;
const DAY = 86_400_000;
// Real UTC offsets are whole hours plus a handful of :30/:45 zones; AoE is -12h.
const OFFSET_STEPS_MIN = [60, 30, 15]; // whole, half, quarter hour
const NEAR_MS = 90_000;                // 90s tolerance for "lands on" an offset
const MAX_OFFSET_H = 14;               // largest real-world tz magnitude
// Gentle spacing between venue fetches. Each entry now costs a group lookup
// (for the authoritative `date` line) plus, only when that line has no
// deadline, an invitation lookup — so pacing is a little wider than when this
// job read invitations alone, to stay inside OpenReview's rate budget across
// ~200 entries. A throttled entry is warned about and skipped, never fatal.
const PACE_MS = 600;
const REVIEW_PAST_GRACE_MS = 14 * DAY; // keep reviewing a deadline until ~2 weeks past it

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const MAX = 5;
    let ok = false;
    for (let attempt = 0; attempt < MAX; attempt++) {
      try {
        await new Promise((r) => setTimeout(r, 250 + attempt * attempt * 1000));
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
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
  const MAX = 5;
  for (let attempt = 0; attempt < MAX; attempt++) {
    try {
      await new Promise((r) => setTimeout(r, 250 + attempt * attempt * 1000)); // pace, then escalating backoff
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
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
export function reviewCategory({ notes, storedValue, storedMs, fetchedMs }) {
  if (storedMs == null || fetchedMs == null) return null;
  const diff = classifyDeadlineDiff(storedMs, fetchedMs);
  if (diff.kind === 'match') return null;
  if (notes === LEGACY_IMPORT_NOTE) return null;          // in transition: discovery adopts, then syncs
  const botManaged = syncedValue(notes) === storedValue;  // stamp still equals the stored value
  if (botManaged) {
    // Later moves are auto-applied by the weekly sync — not a review item.
    // Only an earlier move is declined (later-only) and needs a human eye.
    return fetchedMs < storedMs ? { kind: 'bot-earlier', diff } : null;
  }
  // Not legacy and not a matching bot stamp => a human curated this deadline.
  return { kind: 'human-conflict', diff };
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

/** Compare two URLs ignoring differences that aren't worth a human's attention:
 *  scheme, a leading "www.", a trailing slash, and case. */
export function normalizeWebsite(url) {
  if (!url) return null;
  const n = String(url).trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
  return n || null;
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
export function titleDrift(storedName, openreviewTitle, conference = '', acked = null) {
  const a = normalizeVenueText(storedName, conference);
  const b = normalizeVenueText(openreviewTitle, conference);
  if (!a || !b || a === b) return null;
  // Already reviewed and declined? Stay quiet only while OpenReview still says
  // the same thing. The acknowledgement records the VALUE that was rejected, not
  // a blanket "ignore this entry", so a later, different rename is reported again.
  if (acked && normalizeVenueText(acked, conference) === b) return null;
  return { stored: storedName, openreview: openreviewTitle };
}

/** A changed acronym. OpenReview's `subtitle` is only sometimes an acronym — it
 *  is often a full descriptive phrase ("CVPR 2024 Workshop Prompting in Vision"),
 *  and comparing against those produced a 4.9% false-positive rate. So this only
 *  compares when the subtitle is acronym-shaped, which cuts it to zero across the
 *  dataset while still catching a real rename (MPLR-FM -> PriLOM). */
export function acronymDrift(storedAcronym, openreviewSubtitle, acked = null) {
  const sub = String(openreviewSubtitle ?? '').trim();
  if (!storedAcronym || !sub || /\s/.test(sub) || sub.length > 15) return null;
  const norm = (x) => String(x ?? '').split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '');
  const a = norm(storedAcronym);
  const b = norm(sub);
  if (!a || !b || a === b) return null;
  if (acked && norm(acked) === b) return null; // reviewed and declined, and unchanged since
  return { stored: storedAcronym, openreview: sub };
}

/** A website worth reviewing: both sides have one and they genuinely differ.
 *  Reported, never applied — the importer fills a blank `website` and then leaves
 *  it alone, which protects a hand-picked URL but also means one that goes stale
 *  stays stale (IROS BEMHAT's stored site had been unpublished and redirected to
 *  a Google sign-in page). A human decides; ours is sometimes the better link. */
export function websiteDrift(stored, openreview, acked = null) {
  const a = normalizeWebsite(stored);
  const b = normalizeWebsite(openreview);
  if (!a || !b || a === b) return null;
  if (acked && normalizeWebsite(acked) === b) return null; // reviewed and declined, and unchanged since
  return { stored, openreview };
}

function buildReport(items, drift = [], renames = []) {
  if (!items.length && !drift.length && !renames.length) return '';
  const human = items.filter((i) => i.kind === 'human-conflict');
  const earlier = items.filter((i) => i.kind === 'bot-earlier');
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
  out.push('_This issue is updated automatically by the weekly `deadline-review` workflow._');
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
    .filter(({ raw }) => raw?.openreview_venue_id);
  let entries = allEntries.filter(({ raw }) => raw?.submission_deadline);
  if (slug) entries = entries.filter((e) => e.slug === slug);
  // --recent scopes by *deadline relevance*, not conference year: a workshop
  // whose deadline is comfortably past (even if its year is the current one) is
  // not a review item, so it's neither fetched nor listed. Fixes the review
  // issue filling up with long-closed deadlines (e.g. CVPR/ICML deadlines that
  // passed months ago) and spares the weekly job a lookup per stale entry.
  else if (recent) {
    entries = entries.filter(({ raw }) =>
      isWithinReviewWindow(resolveDeadlineUtcMs(raw.submission_deadline, raw.timezone || 'UTC'), nowMs));
  }
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
  console.log(
    `Prefetched ${duedates.size} submission duedate(s) for ${needInvitation.length} venue(s) ` +
      `in ${Math.ceil(needInvitation.length / 40)} batched request(s).\n`,
  );

  const items = [];
  const drift = [];
  const renames = [];
  let checked = 0, skipped = 0;
  for (const { slug: s, file, raw } of toCheck) {
    let dl = null;
    let hitNetwork = false;
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
        hitNetwork = true;
      }
      group = g;
      if (g) {
        dl = parseGroupDeadline(val(g.content ?? {}, 'date'));
        if (!dl) {
          const due = duedates.get(invitationIdOf(g));
          if (due) {
            dl = msToDeadline(due);
          } else if (!complete) {
            // A batch was throttled, so absence here is inconclusive — ask
            // directly rather than reporting this venue as unfetchable.
            dl = await deadlineFromInvitation(g);
            hitNetwork = true;
          }
          // else: batches all succeeded and this venue has no submission
          // invitation (or no duedate) — nothing to compare, no request needed.
        }
      }
    } catch {
      dl = null; // network / rate-limit / no invitation: skip, never fail
    }
    // Only pace when this entry actually hit the network; venues answered from
    // the prefetched listing cost nothing and need no delay.
    if (hitNetwork) await sleep(PACE_MS);
    if (!dl) { skipped++; continue; }
    checked++;
    const storedMs = resolveDeadlineUtcMs(raw.submission_deadline, raw.timezone || 'UTC');
    const fetchedMs = resolveDeadlineUtcMs(dl.submission_deadline, 'UTC');
    const cat = reviewCategory({
      notes: raw.deadline_notes,
      storedValue: raw.submission_deadline,
      storedMs,
      fetchedMs,
    });
    if (!cat) continue;
    const item = {
      kind: cat.kind, slug: s, file,
      name: raw.name, conf: String(raw.conference || '').toUpperCase(), year: raw.year,
      stored: raw.submission_deadline, fetched: dl.submission_deadline, label: cat.diff.label,
    };
    items.push(item);
    const tag = cat.kind === 'human-conflict' ? '⚠ CONFLICT  ' : '•  EARLIER   ';
    console.log(`${tag} ${s}: stored ${item.stored} vs OpenReview ${item.fetched} UTC — ${item.label}`);
  }

  // Identity pass: no network at all, every group is already cached above.
  for (const { raw, slug: s2, file: f2 } of identityEntries) {
    const g = groupById.get(raw.openreview_venue_id);
    if (!g) continue;
    const c = g.content ?? {};
    const meta = { slug: s2, file: f2, name: raw.name, conf: String(raw.conference || '').toUpperCase(), year: raw.year };
    const ack = raw.review_ack ?? {};
    const wd = websiteDrift(raw.website, websiteFromContent(c), ack.website);
    if (wd) { drift.push({ ...meta, ...wd }); console.log(`•  WEBSITE   ${s2}: ours ${wd.stored} vs OpenReview ${wd.openreview}`); }
    const td = titleDrift(raw.name, val(c, 'title'), raw.conference, ack.name);
    if (td) { renames.push({ ...meta, field: 'name', ...td }); console.log(`•  NAME      ${s2}: ours "${td.stored}" vs OpenReview "${td.openreview}"`); }
    const ad = acronymDrift(raw.acronym, val(c, 'subtitle'), ack.acronym);
    if (ad) { renames.push({ ...meta, field: 'acronym', ...ad }); console.log(`•  ACRONYM   ${s2}: ours "${ad.stored}" vs OpenReview "${ad.openreview}"`); }
  }

  const report = buildReport(items, drift, renames);
  if (reportPath) {
    fs.writeFileSync(reportPath, report);
    const parts = [];
    if (items.length) parts.push(`${items.length} deadline item(s)`);
    if (drift.length) parts.push(`${drift.length} website item(s)`);
    if (renames.length) parts.push(`${renames.length} rename item(s)`);
    console.log(`\nWrote ${parts.length ? parts.join(' + ') : 'empty report'} to ${reportPath}.`);
  }
  console.log(`\nDone. ${checked} checked, ${items.length} to review, ${skipped} unfetchable${drift.length ? `, ${drift.length} website change(s)` : ''}.`);
  if (strict && items.length > 0) process.exit(1);
}

// Only run the CLI when invoked directly, so the pure helpers can be imported in
// tests without the module hitting the network.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
