#!/usr/bin/env node
/**
 * Discovers ALL workshop venues for a conference-year from OpenReview and
 * creates a YAML entry for each one that we don't already track.
 *
 * Everything written is taken from official OpenReview records: title,
 * acronym (subtitle), website, and the real submission deadline — parsed
 * from the venue's human-written `date` line or, when that is blank, from
 * the submission invitation's machine-readable `duedate` (expired
 * invitations included; it's the value shown next to the Submission button
 * on openreview.net). Nothing is estimated. Every imported deadline is
 * stored in UTC: whatever offset the venue used (including AoE = UTC-12) is
 * converted to the equivalent UTC instant, so the dataset stays
 * timezone-consistent (the site converts to the viewer's local time at
 * display time regardless). When a workshop leaves its parent group empty
 * and splits submissions into sub-track children (e.g. MARINE/Full +
 * MARINE/Short), discovery descends one level and uses the earliest child
 * deadline plus an inherited website. Entries that still lack a deadline are
 * written with a comment template inviting contributors to add it — the
 * site's "know the deadline? Add it in one line" link lands there — and the
 * weekly backfill's rewrite removes the template the moment a real deadline
 * appears.
 *
 * Deadline sync (extensions): a deadline the bot imported is kept in step with
 * OpenReview on subsequent runs. Each write stamps the exact value into
 * `deadline_notes`; a later run re-syncs only when the stored value still equals
 * that stamp, so any human edit (to the value or the note) permanently freezes
 * the entry. Re-syncs are later-only by default (extensions; never earlier or to
 * null), require a plausible parse, and compare UTC instants. Pre-sync entries
 * (the legacy import marker) are adopted non-destructively — stamped once,
 * deadline untouched — and become eligible the next run. Every value change is
 * logged (stdout, and appended to $DEADLINE_CHANGELOG when set) so the workflow
 * can record each edit in the commit message rather than editing silently.
 *
 * Usage:
 *   node scripts/discover_openreview.mjs --conf icml --year 2026
 *   node scripts/discover_openreview.mjs --conf neurips --year 2025 --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { WORKSHOPS_DIR, listWorkshopFiles, readWorkshopFile } from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs } from '../lib/dates.mjs';

// Prepended to new entries that lack a deadline, so anyone landing in the
// GitHub editor via the site's "know the deadline? Add it" link sees exactly
// what to type. The weekly backfill rewrites the file (yaml.dump) when it
// finds the real deadline, which removes this hint exactly when it becomes
// obsolete.
const DEADLINE_HINT = `# --- Missing: submission deadline -----------------------------------------
# Know it? Add two lines anywhere below, for example:
#   submission_deadline: 2026-09-15 23:59    # or just a date: 2026-09-15
#   timezone: AoE                            # AoE / UTC / America/Los_Angeles
# Then click "Commit changes..." -> "Propose changes" to open a pull request.
# It is validated automatically and usually merged within a day.
# ---------------------------------------------------------------------------
`;

// --- Deadline-sync provenance ------------------------------------------------
// Every deadline the bot writes is stamped into `deadline_notes` with the exact
// value written. On later runs the bot only re-syncs a deadline whose stored
// value STILL equals that stamp — so any human edit to the value (even one that
// leaves the note untouched) breaks the match and permanently freezes the entry.
const SYNC_NOTE_PREFIX = 'OpenReview-synced';
// The pre-sync import marker used historically (≈700 entries). Treated as
// bot-managed-but-unstamped: adopted non-destructively on first encounter.
export const LEGACY_IMPORT_NOTE = 'imported from OpenReview — check the website for extensions';
// Later-only by default: the bot moves a deadline LATER (the extension case it
// exists for) but never earlier or to null, because a transient/garbled read is
// the dangerous failure mode. Flip to true to also follow earlier corrections
// (riskier; leans on validate.mjs's sanity checks as the net).
const ALLOW_EARLIER = false;
const TWO_YEARS_MS = 2 * 366 * 86_400_000;

/** The note the bot stamps when it sets or updates a deadline. Embeds the exact
 *  value written (UTC) so a later human value-edit is detectable, plus the sync
 *  date for human context. Stays well under the schema's 300-char limit. */
export function syncNote(deadlineValue, today) {
  return `${SYNC_NOTE_PREFIX} ${deadlineValue} UTC (as of ${today}) — extensions on OpenReview are applied automatically; verify on the website.`;
}

/** If `notes` is a bot sync-note, return the deadline value the bot last wrote;
 *  otherwise null (human-written note, legacy marker, SEED estimate, empty…). */
export function syncedValue(notes) {
  if (typeof notes !== 'string') return null;
  const m = notes.match(/^OpenReview-synced (\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?) UTC\b/);
  return m ? m[1] : null;
}

/**
 * Decide whether a freshly fetched deadline should replace the stored one.
 * Pure value judgment over UTC instants (ms): the caller owns the separate
 * "is this entry bot-managed / human-untouched" gate and the plausibility
 * check. Comparing instants (not raw strings) means equal-moment/format noise
 * never counts as a change. Returns { update, reason }.
 *   null fetched | null stored -> no update
 *   equal instant              -> no update ("unchanged")
 *   fetched later than stored  -> update ("later")
 *   fetched earlier            -> update only if allowEarlier, else no ("earlier-blocked")
 */
export function decideDeadlineUpdate(storedMs, fetchedMs, { allowEarlier = false } = {}) {
  if (fetchedMs == null) return { update: false, reason: 'no-fetched' };
  if (storedMs == null) return { update: false, reason: 'no-stored' };
  if (fetchedMs === storedMs) return { update: false, reason: 'unchanged' };
  if (fetchedMs > storedMs) return { update: true, reason: 'later' };
  return allowEarlier ? { update: true, reason: 'earlier' } : { update: false, reason: 'earlier-blocked' };
}

const UA = 'ai-workshop-tracker/1.0 (open-source workshop aggregator; github)';
const CONF_TEMPLATE = {
  icml: 'ICML.cc/{year}/Workshop',
  iclr: 'ICLR.cc/{year}/Workshop',
  neurips: 'NeurIPS.cc/{year}/Workshop',
  icra: 'IEEE.org/ICRA/{year}/Workshop',
  iros: 'IEEE.org/IROS/{year}/Workshop',
  cvpr: 'thecvf.com/CVPR/{year}/Workshop',
  corl: 'robot-learning.org/CoRL/{year}/Workshop',
  colm: 'colmweb.org/COLM/{year}/Workshop',
  eccv: 'thecvf.com/ECCV/{year}/Workshop',
};

const val = (c, k) => {
  const x = c?.[k];
  return x && typeof x === 'object' && 'value' in x ? x.value : x;
};

/** Map a venue title/subtitle to topic ids via keywords (fallback: other). */
const TOPIC_KEYWORDS = [
  [/math|reason/i, 'math-reasoning'],
  [/language model|\bllm|foundation model/i, 'llms'],
  [/\bnlp\b|natural language/i, 'nlp'],
  [/efficien|compress|quantiz|sparsi|small/i, 'efficiency'],
  [/system/i, 'systems'],
  [/agent/i, 'agents'],
  [/safe|align|trustworth|red.?team/i, 'safety-alignment'],
  [/interpret|explain|mechanis/i, 'interpretability'],
  [/health|medic|clinic|biomed/i, 'healthcare-bio'],
  [/genom|protein|molecul|drug/i, 'genomics'],
  [/scien/i, 'science-applications'],
  [/physic|astro|cosmo|quantum/i, 'physics'],
  [/climate|sustain|earth|weather/i, 'climate'],
  [/robot|embodied/i, 'robotics'],
  [/graph/i, 'graphs'],
  [/time.?series|temporal|forecast/i, 'time-series'],
  [/vision|video|image/i, 'vision'],
  [/speech|audio|music/i, 'speech-audio'],
  [/reinforcement|\brl\b/i, 'reinforcement-learning'],
  [/diffusion/i, 'diffusion'],
  [/generat/i, 'generative-models'],
  [/optimi/i, 'optimization'],
  [/theor/i, 'theory'],
  [/causal/i, 'causality'],
  [/privacy|secur/i, 'privacy'],
  [/federat/i, 'federated-learning'],
  [/fair|ethic|societ|responsib|govern/i, 'fairness'],
  [/benchmark|evaluat/i, 'evaluation-benchmarks'],
  [/dataset|data.?centric|data problem/i, 'datasets'],
  [/multi.?modal/i, 'multimodal'],
  [/tabular|table/i, 'tabular'],
  [/neuro|brain|cogniti/i, 'neuroscience'],
  [/educat|teach/i, 'education'],
];
function guessTopics(text) {
  const hits = [];
  for (const [re, id] of TOPIC_KEYWORDS) {
    if (re.test(text) && !hits.includes(id)) hits.push(id);
    if (hits.length === 3) break;
  }
  return hits.length ? hits : ['other'];
}

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

/**
 * Parse the deadline out of a group's `date` string, e.g.
 * "Submission Start: Mar 20 2026 12:00PM UTC-0, Submission Deadline: Apr 27 2026 12:00PM UTC-0"
 * Returns { submission_deadline, timezone } with the instant always normalized
 * to UTC (any offset, including AoE = UTC-12, is converted — the moment is
 * unchanged, only the representation), or null when absent/unparseable.
 */
export function parseGroupDeadline(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const m = dateStr.match(
    /Submission Deadline:\s*([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(AM|PM))?\s*UTC\s*([+-]\d+(?:\.5)?)?/,
  );
  if (!m) return null;
  const [, mon, d, y, hh, mm, ap, off] = m;
  const month = MONTHS[mon];
  if (!month) return null;
  let hour = hh != null ? Number(hh) % 12 : 23;
  if (hh != null && ap === 'PM') hour += 12;
  const minute = hh != null ? Number(mm) : 59;
  const offset = off != null ? Number(off) : 0;
  const pad = (n) => String(n).padStart(2, '0');
  // Normalize every offset (including AoE = UTC-12) to exact UTC, so all
  // stored deadlines share one timezone. The instant is unchanged.
  const utcMs = Date.UTC(Number(y), month - 1, Number(d), hour, minute) - offset * 3_600_000;
  const dt = new Date(utcMs);
  return {
    submission_deadline: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`,
    timezone: 'UTC',
  };
}

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workshop';

/** Convert an OpenReview epoch-ms duedate to our deadline shape, always as
 *  exact UTC so every stored deadline shares one timezone (the instant is the
 *  true value from OpenReview either way). */
export function msToDeadline(ms) {
  if (!Number.isFinite(ms)) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date(ms);
  return {
    submission_deadline: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    timezone: 'UTC',
  };
}

/** Fallback when the group's human-written `date` line is empty/unparseable:
 *  the submission *invitation* usually carries a machine-readable `duedate`
 *  (it's what renders next to the Submission button on openreview.net). */
export async function deadlineFromInvitation(g) {
  const invId = val(g.content ?? {}, 'submission_id') || `${g.id}/-/Submission`;
  const url = `https://api2.openreview.net/invitations?id=${encodeURIComponent(invId)}&expired=true`;
  // OpenReview rate-limits bulk callers (HTTP 429). A swallowed 429 looks
  // identical to "no deadline exists", which is how ECCV's WICV and ~20
  // siblings imported as "Deadline unknown" despite having a visible duedate.
  // Retry 429/5xx with backoff so throttling no longer masquerades as absence.
  const MAX = 5;
  for (let attempt = 0; attempt < MAX; attempt++) {
    try {
      await new Promise((r) => setTimeout(r, 350 + attempt * attempt * 1000)); // pace, then escalating backoff to clear rate-limit penalties
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX - 1) continue; // retry
        throw new Error(`rate-limited (HTTP ${res.status}) after ${MAX} attempts for ${invId}`);
      }
      if (!res.ok) return null; // genuine miss (e.g. 404 — no submission invitation)
      const { invitations = [] } = await res.json();
      return msToDeadline(invitations[0]?.duedate);
    } catch (err) {
      if (attempt < MAX - 1) continue;
      // Surface persistent throttling instead of hiding it as "no deadline".
      console.warn(`  ⚠ deadline lookup failed for ${invId}: ${err.message}`);
      return null;
    }
  }
  return null;
}

/** Fetch OpenReview groups under a prefix, retrying on 429/5xx (same
 *  rate-limit hardening as the deadline lookup). Returns [] on persistent
 *  failure rather than throwing, so a throttled sub-track probe degrades to
 *  "no sub-tracks" instead of crashing the whole import. */
export async function fetchGroups(prefix) {
  const url = `https://api2.openreview.net/groups?prefix=${encodeURIComponent(prefix)}&limit=1000`;
  const MAX = 5;
  for (let attempt = 0; attempt < MAX; attempt++) {
    try {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 0 : attempt * attempt * 1000));
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX - 1) continue;
        throw new Error(`HTTP ${res.status} after retries`);
      }
      if (!res.ok) return [];
      const { groups = [] } = await res.json();
      return groups;
    } catch (err) {
      if (attempt < MAX - 1) continue;
      console.warn(`  ⚠ group lookup failed for ${prefix}: ${err.message}`);
      return [];
    }
  }
  return [];
}

/** Some workshops split submissions into sub-track child groups (e.g.
 *  MARINE/Full + MARINE/Short, or Long/Short paper tracks) and leave the
 *  parent group empty — no date, no website, no submission_id. Descend one
 *  level: collect each child's invitation deadline and website. Returns the
 *  EARLIEST deadline across tracks (so "one track open, one TBA" surfaces the
 *  real soonest deadline, not "unknown") plus a website inherited from a
 *  child. Returns {deadline:null, website:null} when there are no such
 *  children, so callers fall through to the normal "Deadline unknown" path. */
export async function subTrackInfo(g, fetchGroups) {
  let children = [];
  try {
    children = (await fetchGroups(`${g.id}/`)).filter(
      (c) => c.id !== g.id && c.id.startsWith(`${g.id}/`) && val(c.content ?? {}, 'submission_id'),
    );
  } catch {
    return { deadline: null, website: null, tracks: [] };
  }
  if (!children.length) return { deadline: null, website: null, tracks: [] };
  let best = null, website = null;
  const tracks = [];
  for (const c of children) {
    if (!website) {
      const w = String(val(c.content ?? {}, 'website') || '').trim();
      if (/^https?:\/\//.test(w)) website = w.slice(0, 500);
    }
    const dl = parseGroupDeadline(val(c.content ?? {}, 'date')) || (await deadlineFromInvitation(c));
    // Track name: the segment after the parent (e.g. ".../MARINE/Full" -> "Full").
    const name = c.id.slice(g.id.length + 1).replace(/[_/]+/g, ' ').trim() || c.id.split('/').pop();
    tracks.push({ name, deadline: dl }); // dl may be null = TBA track
    if (dl && (!best || dl.submission_deadline < best.submission_deadline)) best = dl;
  }
  // Collapse: if every track shares one deadline (or there's only one), it's
  // not really multi-track — let the caller treat it as a plain workshop.
  const dated = tracks.filter((t) => t.deadline);
  const allSame =
    dated.length === tracks.length &&
    dated.every((t) => t.deadline.submission_deadline === dated[0].deadline.submission_deadline);
  const multiTrack = tracks.length > 1 && !allSame;
  return { deadline: best, website, tracks: multiTrack ? tracks : [] };
}

/** Convert subTrackInfo's track list into the stored `tracks` YAML shape:
 *  [{name, submission_deadline?, timezone?}]. TBA tracks keep just a name. */
function tracksToYaml(tracks) {
  return (tracks || []).map((t) =>
    t.deadline
      ? { name: t.name, submission_deadline: t.deadline.submission_deadline, timezone: t.deadline.timezone }
      : { name: t.name },
  );
}

async function main({ conf, year, dryRun }) {
  const prefix = CONF_TEMPLATE[conf].replace('{year}', String(year));
  const res = await fetch(
    `https://api2.openreview.net/groups?prefix=${encodeURIComponent(prefix + '/')}&limit=1000`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`OpenReview HTTP ${res.status}`);
  const { groups = [] } = await res.json();
  const topRe = new RegExp(`^${prefix.replaceAll('.', '\\.')}/[^/]+$`);
  const allVenues = groups.filter((g) => topRe.test(g.id));
  // Workshops often register separate archival / non-archival track venues —
  // one workshop, two ids. Skip the track twin when its base is present.
  const TRACK_SUFFIX = /[_-](non[_-]?archival(?:[_-]track)?|archival[_-]?track|proceedings[_-]?track|pre[_-]?reviewed|abstract[_-]?(?:paper[_-]?)?track|extended[_-]?abstract[_-]?track)$/i;
  const tailOf = (id) => id.split('/').pop().toLowerCase();
  const tails = new Set(allVenues.map((g) => tailOf(g.id)));
  const venues = allVenues.filter((g) => {
    const t = tailOf(g.id);
    const m = TRACK_SUFFIX.exec(t);
    if (!m) return true;
    const base = t.replace(TRACK_SUFFIX, '');
    return !(tails.has(base) || tails.has(`${base}_archival_track`) || tails.has(`${base}_proceedings_track`) || tails.has(`${base}_main_track`));
  });
  if (venues.length < allVenues.length)
    console.log(`  (skipped ${allVenues.length - venues.length} archival/non-archival track twin(s))`);

  const known = new Map(); // venue_id -> { path, raw }
  for (const f of listWorkshopFiles()) {
    const e = readWorkshopFile(f);
    if (e.raw?.openreview_venue_id) known.set(e.raw.openreview_venue_id, { path: f, raw: e.raw });
  }
  const today = new Date().toISOString().slice(0, 10);
  let created = 0, skipped = 0, backfilled = 0, updated = 0, adopted = 0;
  const changes = []; // human-readable "old -> new" lines for the commit log

  for (const g of venues) {
    if (known.has(g.id)) {
      const { path: fp, raw } = known.get(g.id);
      let changed = false;
      // OpenReview's current deadline: the group's `date` line is free (already
      // in hand), but the submission invitation's duedate costs a network call,
      // so it is fetched LAZILY — only when a branch actually needs the value.
      // Adopting a legacy entry and skipping a human-frozen one need no value at
      // all, so those paths make ZERO invitation calls. That is what keeps the
      // weekly run (overwhelmingly adoptions right now) inside OpenReview's rate
      // limit, instead of burning one wasted call per venue and getting throttled
      // partway through the conference list.
      let freshDl = parseGroupDeadline(val(g.content ?? {}, 'date'));
      let invTried = false;
      const ensureDl = async () => {
        if (!freshDl && !invTried) { invTried = true; freshDl = await deadlineFromInvitation(g); }
        return freshDl;
      };

      // (A) Backfill missing fields. Organizers sometimes publish the deadline
      // (or a website / sub-tracks) on OpenReview after we imported the venue.
      // The deadline is only ever *filled when absent* here — never overwritten.
      if (!raw.submission_deadline || !raw.website || !raw.tracks) {
        let dl = !raw.submission_deadline ? await ensureDl() : null;
        let subWebsite = null, subTracks = [];
        if (!dl || !raw.website || !raw.tracks) {
          const sub = await subTrackInfo(g, fetchGroups);
          if (!dl && sub.deadline) { dl = sub.deadline; freshDl = freshDl || sub.deadline; }
          subWebsite = sub.website;
          subTracks = tracksToYaml(sub.tracks);
        }
        if (!raw.submission_deadline && dl) {
          raw.submission_deadline = dl.submission_deadline;
          raw.timezone = dl.timezone;
          raw.deadline_notes = syncNote(dl.submission_deadline, today);
          changed = true;
          backfilled++;
        }
        if (!raw.website && subWebsite) { raw.website = subWebsite; changed = true; }
        if (!raw.tracks && subTracks.length) { raw.tracks = subTracks; changed = true; }
      }

      // (B) Keep an existing *bot-managed, human-untouched* deadline in sync with
      // OpenReview. A deadline counts as bot-managed only if its note still holds
      // the value the bot last wrote (syncedValue) or the pre-sync legacy marker.
      // The instant a human edits the value or note, that match breaks and the
      // entry freezes — the bot never touches it again. Updates are later-only by
      // default, require a plausible non-null parse, and compare UTC instants
      // (never raw strings), so a transient/garbled read can't clobber a good value.
      if (raw.submission_deadline) {
        const lastBot = syncedValue(raw.deadline_notes);
        const isLegacy = raw.deadline_notes === LEGACY_IMPORT_NOTE;
        if (lastBot == null && isLegacy) {
          // First encounter of a legacy-marked entry: adopt it non-destructively
          // — stamp the current value so future human edits become detectable.
          // The deadline itself is left exactly as-is on this pass; real syncing
          // begins next run, once there is a stamp to compare against. No
          // invitation fetch happens here — adoption never uses OpenReview's value.
          raw.deadline_notes = syncNote(raw.submission_deadline, today);
          changed = true;
          adopted++;
        } else if (lastBot != null && lastBot === raw.submission_deadline) {
          // Stamped and untouched since: safe to compare against OpenReview.
          const fetched = await ensureDl();
          const storedMs = resolveDeadlineUtcMs(raw.submission_deadline, raw.timezone || 'UTC');
          const fetchedMs = fetched ? resolveDeadlineUtcMs(fetched.submission_deadline, fetched.timezone || 'UTC') : null;
          const fetchedYear = fetched ? Number(String(fetched.submission_deadline).slice(0, 4)) : null;
          // Skip absurd values rather than failing validate for the whole run.
          const plausible =
            fetchedMs != null &&
            fetchedMs - Date.now() <= TWO_YEARS_MS &&
            fetchedYear != null && Math.abs(fetchedYear - raw.year) <= 1;
          const decision = plausible
            ? decideDeadlineUpdate(storedMs, fetchedMs, { allowEarlier: ALLOW_EARLIER })
            : { update: false, reason: 'implausible' };
          if (decision.update) {
            const from = raw.submission_deadline;
            raw.submission_deadline = fetched.submission_deadline;
            raw.timezone = fetched.timezone;
            raw.deadline_notes = syncNote(fetched.submission_deadline, today);
            changed = true;
            updated++;
            changes.push(`${conf} ${raw.year} · ${path.basename(fp)}: ${from} UTC -> ${fetched.submission_deadline} UTC (${decision.reason})`);
          } else if (!plausible && fetched) {
            console.warn(`  ⚠ ${path.basename(fp)}: OpenReview deadline "${fetched.submission_deadline}" looks implausible — left unchanged`);
          }
        }
        // else: a non-bot note, or the value no longer matches the stamp => a
        // human curated this deadline. Frozen: leave it alone, no network call.
      }

      if (changed && !dryRun) fs.writeFileSync(fp, yaml.dump(raw, { lineWidth: 200, quotingType: '"' }));
      skipped++;
      continue;
    }
    const c = g.content ?? {};
    const tail = g.id.split('/').pop();
    const title = String(val(c, 'title') || tail).trim().slice(0, 200);
    let acronym = String(val(c, 'subtitle') || tail).trim();
    if (acronym.length > 40 || acronym === title) acronym = tail.slice(0, 40);
    const websiteRaw = String(val(c, 'website') || '').trim();
    let website = /^https?:\/\//.test(websiteRaw) ? websiteRaw.slice(0, 500) : null;
    let deadline = parseGroupDeadline(val(c, 'date')) || (await deadlineFromInvitation(g));
    let tracks = [];
    // Empty parent with sub-track children (e.g. MARINE/Full + MARINE/Short):
    // inherit the earliest child deadline, a child website, and record the
    // per-track breakdown so the page can show each track honestly.
    if (!deadline || !website) {
      const sub = await subTrackInfo(g, fetchGroups);
      if (!deadline && sub.deadline) deadline = sub.deadline;
      if (!website && sub.website) website = sub.website;
      tracks = tracksToYaml(sub.tracks);
    }

    const record = { name: title, acronym, conference: conf, year };
    if (website) record.website = website;
    record.topics = guessTopics(`${title} ${acronym}`);
    if (deadline) {
      record.submission_deadline = deadline.submission_deadline;
      record.timezone = deadline.timezone;
      record.deadline_notes = syncNote(deadline.submission_deadline, today);
    }
    if (tracks.length) record.tracks = tracks;
    record.openreview_venue_id = g.id;
    record.submission_portal = 'openreview';
    record.notes = `Auto-imported from the OpenReview venue record on ${today} — please verify and enrich (topics are keyword-guessed).`;
    record.added = today;

    let base = `${conf}-${year}-${slugify(tail)}`;
    let file = `${base}.yml`;
    let i = 2;
    while (fs.existsSync(path.join(WORKSHOPS_DIR, file))) file = `${base}-${i++}.yml`;

    if (dryRun) {
      console.log(`[dry-run] would create ${file}  (${title.slice(0, 60)})`);
    } else {
      const body = yaml.dump(record, { lineWidth: 200, quotingType: '"' });
      fs.writeFileSync(path.join(WORKSHOPS_DIR, file), record.submission_deadline ? body : DEADLINE_HINT + body);
    }
    created++;
  }
  if (changes.length && process.env.DEADLINE_CHANGELOG) {
    fs.appendFileSync(process.env.DEADLINE_CHANGELOG, changes.map((c) => `- ${c}`).join('\n') + '\n');
  }
  console.log(
    `${conf} ${year}: ${venues.length} venues on OpenReview — ${created} created, ${skipped} already tracked` +
    `${backfilled ? `, ${backfilled} deadline(s) backfilled` : ''}` +
    `${updated ? `, ${updated} deadline(s) re-synced` : ''}` +
    `${adopted ? `, ${adopted} legacy note(s) adopted` : ''}.`,
  );
  for (const c of changes) console.log(`    ↳ ${c}`);
}

// Only run the CLI when invoked directly, so the exported helpers
// (parseGroupDeadline, msToDeadline, subTrackInfo…) can be imported in tests
// without the module parsing argv and exiting.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const getArg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const conf = getArg('--conf');
  const year = Number(getArg('--year'));
  const dryRun = args.includes('--dry-run');
  if (!CONF_TEMPLATE[conf] || !Number.isInteger(year)) {
    console.error(`Usage: node scripts/discover_openreview.mjs --conf <${Object.keys(CONF_TEMPLATE).join('|')}> --year <YYYY> [--dry-run]`);
    process.exit(1);
  }
  main({ conf, year, dryRun }).catch((e) => { console.error(e.message); process.exit(1); });
}
